/**
 * chat completions 端点。
 *
 * 一个请求就是一个新的豆包临时会话：begin 建记录，SSE_ACK 记下 conversation_id，
 * 结束时（成功、报错、被取消都算）调删除接口并核对结果。这样调用方用 Agent
 * 跑一天下来，豆包客户端的侧边栏不会被塞满几百条「未知对话」。
 */
import { randomUUID } from 'node:crypto'
import { prepareRequest, upstreamBody, decodeReply } from './protocol.mjs'
import { readDoubao } from './stream.mjs'
import { selectModel } from './models.mjs'
import { ProviderError, errorResponse } from './errors.mjs'
import { BASE } from './session.mjs'
import { ConversationLease } from './lease.mjs'
import { uploadImage } from './image.mjs'
import { loadImage } from './image-source.mjs'
import { responsesToChat, chatToResponses, responsesEventStream } from './responses.mjs'
import { saveDiagnostic, pruneDiagnostics } from './diag.mjs'

export async function chat(session, input, init = {}) {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== BASE || request.method !== 'POST') {
    return errorResponse(new ProviderError('插件只接受发往豆包网关的 POST 请求。', 400, 'unsupported_endpoint'))
  }
  // magpie 会把 Responses API 的请求原样转过来（Codex 的 wire_api = "responses"）。
  // 我们的上游是 chat completions 形状，所以这里换个解析器，后续流程完全一样。
  const isResponses = url.pathname.replace(/\/+$/, '').endsWith('/responses')

  const abort = new AbortController()
  const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(180_000)])
  let lease
  let upstream
  let prepared

  try {
    let body
    try { body = await request.json() }
    catch (cause) { throw new ProviderError(`请求不是合法 JSON：${cause.message}`, 400, 'invalid_json', { cause }) }

    // Codex 走 Responses 协议时传的是 input 而不是 messages，先折成 chat 形状
    if (isResponses) body = responsesToChat(body)

    prepared = prepareRequest(body)
    await session.ready(signal)

    // 刚被要求过人工验证就直接返回，不再打上游。
    // 验证没过之前每多打一次都可能让解除时间推后，客户端重试时尤其明显。
    let left = session.challengeLeft?.() ?? 0
    if (left > 0) {
      // 用户可能已在网页过掉验证，但服务端的放行状态本地不知道。
      // 用只读接口探测一次（至少间隔 30s），放行就提前清除冷却，避免"验证过了还要等满 5 分钟"。
      if (session.probeChallenge) await session.probeChallenge(signal)
      left = session.challengeLeft?.() ?? 0
    }
    if (left > 0) {
      const minutes = Math.ceil(left / 60_000)
      throw new ProviderError(
        `豆包风控冷却中，本地已暂停请求（约 ${minutes} 分钟后自动恢复；此前必须先完成验证）。请打开 https://www.doubao.com/chat/ 手动发一句话过掉验证；验证通过后插件会自动探测并提前恢复。`,
        403, 'captcha_required', { refused: 'captcha pending' },
      )
    }

    const catalog = await session.models(signal)
    const selected = selectModel(catalog, prepared.request)

    // 有图片就先上传，拿到 attachment 再拼进消息
    let attachments = []
    if (prepared.images?.length) {
      attachments = await Promise.all(prepared.images.map(async (url) => {
        const image = await loadImage(url)
        return uploadImage(session, image, signal)
      }))
    }

    upstream = upstreamBody(session, prepared, selected, attachments)

    // 串行：同一账号同一时刻只跑一个对话会话。
    // 并发打上游既容易触发风控，也会让会话清理互相干扰。
    // 锁只覆盖「建会话 + 拿到响应头」，读流时不占锁，否则一个长回复会把队列堵死。
    lease = new ConversationLease(session, upstream)
    const response = await session.exclusive(async () => {
      await lease.begin()
      return session.request('/chat/completion', upstream, signal, {}, { Accept: 'text/event-stream' })
    })

    async function* tracked() {
      let failure
      try {
        yield* readDoubao(response, signal, (event, data) => lease.observe(event, data))
      } catch (error) {
        failure = error
        // 被风控拦一次就进入冷却，后面的请求别再往上撞
        if (error?.code === 'captcha_required') session.noteChallenge?.()
        throw error
      } finally {
        await lease.finish(failure)
      }
    }

    const source = tracked()
    const meta = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: prepared.request.model }

    if (!prepared.request.stream) {
      let content = ''
      let reasoning = ''
      for await (const delta of source) {
        content += delta.content ?? ''
        reasoning += delta.reasoning_content ?? ''
      }
      const message = decodeReply(content, prepared)
      if (reasoning) message.reasoning_content = reasoning
      const promptTokens = estimateTokens(prepared.prompt)
      const outputTokens = estimateTokens(content + reasoning)
      const completion = {
        id: meta.id,
        object: 'chat.completion',
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: outputTokens,
          total_tokens: promptTokens + outputTokens,
        },
      }
      if (isResponses) return Response.json(chatToResponses(completion, meta.model))
      return Response.json(completion)
    }

    if (isResponses) {
      const finalUsage = (text) => {
        const completionTokens = estimateTokens(text)
        return { input_tokens: estimateTokens(prepared.prompt), output_tokens: completionTokens, total_tokens: estimateTokens(prepared.prompt) + completionTokens }
      }
      return new Response(responsesEventStream(meta, source, finalUsage), {
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
      })
    }

    return sseResponse(source, meta, prepared, abort)
  } catch (error) {
    abort.abort()
    // Issue #8：上游 400 invalid_param 时把请求体（脱敏）落盘，便于定位被拒的参数。
    // 只记上游明确拒绝的情况，本地校验错误不记。
    if (error?.status === 400 && upstream && prepared) {
      const file = await saveDiagnostic(error, upstream, prepared, session)
      if (file) await pruneDiagnostics()
    }
    try { await lease?.finish(error) }
    catch (cleanupError) { return errorResponse(cleanupError) }
    return errorResponse(error)
  }
}

function sseResponse(source, meta, prepared, abort) {
  const encoder = new TextEncoder()
  let canceled = false
  const iterator = source[Symbol.asyncIterator]()
  const promptTokens = estimateTokens(prepared.prompt)
  // usage 只在最后一个块里给一次，和 OpenAI 的 stream_options.include_usage 行为一致
  let output = ''
  const finalUsage = () => {
    const completionTokens = estimateTokens(output)
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
  }

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        // 工具调用和结构化输出需要完整正文才能解析，所以先缓冲再一次性发出
        const buffered = prepared.tools || prepared.structured
        if (buffered) {
          let content = ''
          let reasoning = ''
          let done = false
          while (!done) {
            const next = await iterator.next()
            if (next.done) { done = true; break }
            content += next.value.content ?? ''
            reasoning += next.value.reasoning_content ?? ''
          }
          if (canceled) return
          if (reasoning) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, { reasoning_content: reasoning }))}\n\n`))
          }
          const message = decodeReply(content, prepared)
          const delta = { role: 'assistant' }
          if (message.content) delta.content = message.content
          if (message.tool_calls) delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...call }))
          output = content + reasoning
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, delta, message.tool_calls ? 'tool_calls' : 'stop', finalUsage()))}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }

        const next = await iterator.next()
        if (canceled) return
        if (next.done) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, {}, 'stop', finalUsage()))}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        if (next.value.content) output += next.value.content
        if (next.value.reasoning_content) output += next.value.reasoning_content
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, next.value))}\n\n`))
      } catch (error) {
        abort.abort()
        if (canceled) return
        if (error instanceof ProviderError) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: error.message, type: error.code, code: error.code } })}\n\n`))
          controller.close()
        } else controller.error(error)
      }
    },
    async cancel() {
      canceled = true
      abort.abort()
      try { await iterator.return?.() } catch (error) {
        if (!['AbortError', 'TimeoutError'].includes(error?.name)) throw error
      }
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
}

function chunk(meta, delta, finish = null, usage) {
  const out = { ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] }
  if (usage) out.usage = usage
  return out
}

/**
 * 估算 token 用量。
 *
 * 豆包的事件流不带 usage 字段（整条流只有 SSE_HEARTBEAT / STREAM_* / SSE_REPLY_END），
 * 但 OpenAI 协议里 usage 是必填的，Codex 这类客户端靠它判断上下文占用了多少。
 * 缺了它客户端会一直显示 0，甚至据此误判「上下文没满」而不做压缩。
 *
 * 这里按字符估算：中日韩字符约 1 token/字，其余按 4 字符/token。只用于让客户端
 * 拿到一个合理的量级，不用于计费，所以取整就够。
 */
export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xffef)) cjk += 1
  }
  return Math.ceil(cjk + (text.length - cjk) / 4)
}
