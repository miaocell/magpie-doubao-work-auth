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

export async function chat(session, input, init = {}) {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== BASE || request.method !== 'POST') {
    return errorResponse(new ProviderError('插件只接受发往豆包网关的 POST 请求。', 400, 'unsupported_endpoint'))
  }

  const abort = new AbortController()
  const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(180_000)])
  let lease

  try {
    let body
    try { body = await request.json() }
    catch (cause) { throw new ProviderError(`请求不是合法 JSON：${cause.message}`, 400, 'invalid_json', { cause }) }

    const prepared = prepareRequest(body)
    await session.ready(signal)
    const catalog = await session.models(signal)
    const selected = selectModel(catalog, prepared.request)
    const upstream = upstreamBody(session, prepared, selected)

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
      return Response.json({
        id: meta.id,
        object: 'chat.completion',
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      })
    }

    return sseResponse(source, meta, prepared, abort)
  } catch (error) {
    abort.abort()
    try { await lease?.finish(error) }
    catch (cleanupError) { return errorResponse(cleanupError) }
    return errorResponse(error)
  }
}

function sseResponse(source, meta, prepared, abort) {
  const encoder = new TextEncoder()
  let canceled = false
  const iterator = source[Symbol.asyncIterator]()

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
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, delta, message.tool_calls ? 'tool_calls' : 'stop'))}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }

        const next = await iterator.next()
        if (canceled) return
        if (next.done) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, {}, 'stop'))}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
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

function chunk(meta, delta, finish = null) {
  return { ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] }
}
