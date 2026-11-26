/**
 * OpenAI Responses API → chat completions 的请求/响应转换。
 *
 * magpie 的 Codex 通道用 wire_api = "responses"，请求体长这样：
 *   { model, input: "字符串" | [{ role, content: [{type:"input_text", text}] }], instructions, tools, max_output_tokens }
 * 而我们的上游（豆包工作）只吃 chat completions 那套 { messages, ... }。
 *
 * 所以进门前把它折成 chat 形状，出门前再把结果折回 Responses 的 items 结构。
 * 只做协议形状转换，不碰任何内容语义——工具调用仍然是文本约定，跟 chat 通道一致。
 */
import { randomUUID } from 'node:crypto'

/** Responses 的 content 数组 → 一段纯文本 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      // input_text / output_text / text 都是纯文本，其余类型（图片等）明确跳过
      if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') return part.text ?? ''
      return ''
    })
    .join('')
}

/**
 * 把 Responses 请求折成 chat completions 请求。
 *
 * - input 是字符串 → 一条 user 消息
 * - input 是数组 → 逐项按 role 映射；function_call / function_call_output 这两类
 *   item 折成 assistant.tool_calls 和 tool 消息，保持工具链语义
 * - instructions → system 消息，排在最前
 */
export function responsesToChat(body) {
  const messages = []
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions })
  }

  const input = body.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue
      const type = item.type ?? (item.role ? 'message' : undefined)

      if (type === 'function_call') {
        // 上一次模型发起的工具调用：并进最近一条 assistant 消息
        const call = {
          id: item.call_id || item.id || `call_${randomUUID().replaceAll('-', '')}`,
          type: 'function',
          function: { name: item.name ?? '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) },
        }
        const last = messages[messages.length - 1]
        if (last?.role === 'assistant') {
          last.tool_calls = [...(last.tool_calls ?? []), call]
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] })
        }
        continue
      }

      if (type === 'function_call_output') {
        // 工具执行结果：chat 协议里是 role: tool + tool_call_id
        messages.push({ role: 'tool', tool_call_id: item.call_id ?? item.id ?? '', content: contentText(item.output) })
        continue
      }

      const role = item.role === 'developer' ? 'system' : (item.role || 'user')
      messages.push({ role, content: contentText(item.content) })
    }
  }

  const chat = { ...body, messages }
  delete chat.input
  delete chat.instructions
  if (body.max_output_tokens !== undefined && chat.max_tokens === undefined) {
    chat.max_tokens = body.max_output_tokens
    delete chat.max_output_tokens
  }
  // Responses 的 tools 是扁平结构 { type:"function", name, parameters }，
  // chat 是嵌套的 { type:"function", function:{ name, parameters } }，这里折一层
  if (Array.isArray(body.tools)) {
    chat.tools = body.tools
      .filter((tool) => tool && (tool.type === 'function' || tool.name))
      .map((tool) => (tool.function ? tool : { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
  }
  return chat
}

/** chat 的 message → Responses 的 output items */
function messageToOutput(message, model) {
  const items = []
  const text = typeof message?.content === 'string' ? message.content : ''
  if (text) {
    items.push({
      type: 'message',
      id: `msg_${randomUUID().replaceAll('-', '')}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }
  for (const call of message?.tool_calls ?? []) {
    items.push({
      type: 'function_call',
      id: `fc_${randomUUID().replaceAll('-', '')}`,
      call_id: call.id,
      name: call.function?.name ?? '',
      arguments: call.function?.arguments ?? '{}',
      status: 'completed',
    })
  }
  return items
}

/** 非流式：OpenAI chat completion → Responses 对象 */
export function chatToResponses(completion, model) {
  const message = completion?.choices?.[0]?.message ?? {}
  const usage = completion?.usage ?? {}
  return {
    id: `resp_${randomUUID().replaceAll('-', '')}`,
    object: 'response',
    created_at: completion?.created ?? Math.floor(Date.now() / 1000),
    status: 'completed',
    model: completion?.model ?? model,
    output: messageToOutput(message, model),
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  }
}

/** 流式：把 chat 的 delta 转成 Responses 的 SSE 事件序列 */
export function responsesEventStream(meta, deltas, usageOf, prepared, decode) {
  const encoder = new TextEncoder()
  const responseId = `resp_${randomUUID().replaceAll('-', '')}`
  const itemId = `msg_${randomUUID().replaceAll('-', '')}`
  const send = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  // 客户端断开（用户取消、超时）时要主动放掉上游迭代器，
  // 否则上游会继续跑到结束，白白生成和计费。chat.mjs 那边有 cancel，这里之前漏了。
  let canceled = false
  const iterator = deltas[Symbol.asyncIterator]()
  // 带工具的请求必须收完整段才能解析 tool_calls（和 /chat/completions 那条一致）。
  // 之前这里直接把原始增量当正文发出去，工具调用的 JSON 会原样出现在正文里。
  const buffered = Boolean(prepared?.tools || prepared?.structured)

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(send('response.created', {
        type: 'response.created',
        response: { id: responseId, object: 'response', created_at: meta.created, status: 'in_progress', model: meta.model, output: [] },
      }))

      let text = ''
      const raw = []
      try {
        while (true) {
          if (canceled) return
          const next = await iterator.next()
          if (next.done) break
          const piece = next.value.content ?? ''
          if (!piece) continue
          raw.push(piece)
          if (buffered) {
            // 工具模式：先攒着，结束时统一解析
            continue
          }
          text += piece
          controller.enqueue(send('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: piece,
          }))
        }
      } catch (error) {
        controller.enqueue(send('response.failed', {
          type: 'response.failed',
          response: {
            id: responseId, object: 'response', status: 'failed', model: meta.model, output: [],
            error: { code: error?.code ?? 'upstream_error', message: error?.message ?? '豆包返回错误' },
          },
        }))
        controller.close()
        return
      }

      // 工具模式：整段收完后解析，工具调用按 function_call 事件发出
      let toolCalls = []
      if (buffered) {
        try {
          const message = decode(raw.join(''), prepared)
          toolCalls = message.tool_calls ?? []
          text = message.content ?? ''
        } catch (error) {
          controller.enqueue(send('response.failed', {
            type: 'response.failed',
            response: {
              id: responseId, object: 'response', status: 'failed', model: meta.model, output: [],
              error: { code: error?.code ?? 'invalid_tool_response', message: error?.message ?? '豆包返回的工具调用无法解析' },
            },
          }))
          controller.close()
          return
        }
      }

      if (!toolCalls.length) {
        controller.enqueue(send('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
        }))
        controller.enqueue(send('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }))
        if (buffered && text) {
          controller.enqueue(send('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: text,
          }))
        }
      }

      controller.enqueue(send('response.output_text.done', {
        type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text,
      }))
      // 工具调用按 Responses 协议的 function_call 条目发出
      const output = []
      if (toolCalls.length) {
        for (const [index, call] of toolCalls.entries()) {
          const callId = call.id || `call_${randomUUID().replaceAll('-', '')}`
          const item = {
            type: 'function_call',
            id: `fc_${randomUUID().replaceAll('-', '')}`,
            call_id: callId,
            name: call.function?.name,
            arguments: call.function?.arguments ?? '{}',
            status: 'completed',
          }
          controller.enqueue(send('response.output_item.added', {
            type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', arguments: '' },
          }))
          controller.enqueue(send('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments,
          }))
          controller.enqueue(send('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments,
          }))
          controller.enqueue(send('response.output_item.done', {
            type: 'response.output_item.done', output_index: index, item,
          }))
          output.push(item)
        }
        if (text) {
          const msg = { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
          controller.enqueue(send('response.content_part.done', {
            type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0,
            part: { type: 'output_text', text, annotations: [] },
          }))
          controller.enqueue(send('response.output_item.done', { type: 'response.output_item.done', output_index: toolCalls.length, item: msg }))
          output.push(msg)
        }
      } else {
        controller.enqueue(send('response.content_part.done', {
          type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0,
          part: { type: 'output_text', text, annotations: [] },
        }))
        const msg = { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
        controller.enqueue(send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: msg }))
        output.push(msg)
      }
      controller.enqueue(send('response.completed', {
        type: 'response.completed',
        response: {
          id: responseId, object: 'response', created_at: meta.created, status: 'completed', model: meta.model,
          output,
          usage: usageOf(text),
        },
      }))
      controller.close()
    },
    async cancel() {
      canceled = true
      try { await iterator.return?.() } catch { /* 已经结束 */ }
    },
  })
}
