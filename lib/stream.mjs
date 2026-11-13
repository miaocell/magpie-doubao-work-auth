/**
 * 豆包工作的服务端事件流。
 *
 * 它给的不是 OpenAI 的 SSE，而是一套带补丁语义的事件：
 *  - FULL_MSG_NOTIFY / STREAM_MSG_NOTIFY：整块消息
 *  - STREAM_CHUNK：带 patch_op 的增量补丁
 *  - CHUNK_DELTA：只给文字的最短增量，靠上一块的上下文
 *  - SSE_ACK / SSE_REPLY_END：会话确认与结束
 *
 * 文本以 block 为单位（block_type 10000 正文 / 10040 思考），
 * 所以必须维护 block 表做增量拼接，不能简单地把文本串起来。
 */
import { ProviderError, upstreamError } from './errors.mjs'

/** 只解析 data: 行的事件流 */
async function* events(response) {
  if (!response.body) throw new ProviderError('豆包返回了空事件流。', 502, 'empty_stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const event = parseEvent(raw)
        if (event) yield event
      }
    }
    buffer += decoder.decode()
    const tail = parseEvent(buffer)
    if (tail) yield tail
  } finally {
    try { await reader.cancel() } catch { /* 已结束 */ }
    try { reader.releaseLock() } catch { /* 已释放 */ }
  }
}

function parseEvent(raw) {
  if (!raw.trim()) return undefined
  let name = 'message'
  const data = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  return { event: name, data: data.join('\n') }
}

/**
 * 把豆包事件流翻译成 { content } / { reasoning_content } 增量。
 *
 * 只连发一个块、且服务端已经在流里报错时，这里抛出对应状态码，
 * 让网关能按 401 / 429 做故障切换而不是当成空回复。
 */
export async function* readDoubao(response, signal, observe = async () => {}) {
  const type = response.headers.get('content-type') || ''
  if (!type.includes('text/event-stream')) {
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { message: text.slice(0, 300) } }
    throw upstreamError(payload)
  }

  const blocks = new Map()
  let finished = false
  let produced = false

  function* apply(messageId, updates, operation = 2) {
    for (const block of updates || []) {
      if (!block?.block_id) throw new ProviderError('豆包内容块缺少标识。', 502, 'invalid_stream')
      const key = `${messageId}:${block.block_id}`
      const prior = blocks.get(key)
      const type = block.patch_type ?? operation
      if (type === 3 || block.is_deleted) {
        if (prior?.text) throw new ProviderError('豆包撤回了已发送的内容。', 502, 'replaced_stream')
        blocks.delete(key)
        continue
      }
      if (type !== 1 && type !== 2) throw new ProviderError(`未知的内容块操作 ${type}。`, 502, 'invalid_stream')

      const current = { ...prior, ...block, text: prior?.text ?? '' }
      blocks.set(key, current)
      const text = block.content?.text_block?.text
      if (text === undefined) continue
      if (typeof text !== 'string') throw new ProviderError('豆包文本字段类型发生变化。', 502, 'invalid_stream')

      const next = type === 1 ? current.text + text : text
      if (!next.startsWith(current.text)) throw new ProviderError('豆包改写了已发送的内容。', 502, 'replaced_stream')
      const delta = next.slice(current.text.length)
      current.text = next
      if (!delta) continue

      // 沿 parent 链判断这块属于正文还是思考
      let reasoning = current.block_type === 10040
      let parent = current
      const seen = new Set()
      while (parent.parent_id) {
        if (seen.has(parent.parent_id)) throw new ProviderError('豆包内容块父级成环。', 502, 'invalid_stream')
        seen.add(parent.parent_id)
        parent = blocks.get(`${messageId}:${parent.parent_id}`)
        if (!parent) break
        reasoning ||= parent.block_type === 10040
      }
      produced = true
      yield reasoning ? { reasoning_content: delta } : { content: delta }
    }
  }

  let lastChunk
  for await (const event of events(response)) {
    signal?.throwIfAborted()
    if (event.event === 'gateway-error') throw upstreamError(safeJson(event.data))
    const data = safeJson(event.data)
    await observe(event.event, data)

    if (event.event === 'STREAM_ERROR' || data.error_code || data.error_details?.has_error) {
      throw upstreamError({ ...data, message: data.error_msg || data.error_details?.error_message })
    }
    if (event.event === 'SSE_REPLY_END' && data.end_type === 3) { finished = true; break }
    if (event.event === 'FULL_MSG_NOTIFY' && data.message?.user_type === 2) {
      yield* apply(data.message.message_id, data.message.content_block)
    }
    if (event.event === 'STREAM_MSG_NOTIFY') {
      yield* apply(data.meta.message_id, data.content.content_block)
    }
    if (event.event === 'STREAM_CHUNK') {
      for (const patch of data.patch_op || []) {
        if (patch.patch_object !== 1) continue
        yield* apply(data.message_id, patch.patch_value.content_block, patch.patch_type)
        const blocks_ = patch.patch_value.content_block
        if (blocks_?.length === 1) lastChunk = { message: data.message_id, block: blocks_[0] }
      }
    }
    if (event.event === 'CHUNK_DELTA') {
      if (!lastChunk?.block?.content?.text_block) throw new ProviderError('豆包增量缺少文本块上下文。', 502, 'invalid_stream')
      yield* apply(lastChunk.message, [{ ...lastChunk.block, patch_type: 1, content: { text_block: data } }], 1)
    }
  }

  if (!finished) throw new ProviderError('豆包事件流提前结束。', 502, 'incomplete_stream')
  if (!produced) throw new ProviderError('豆包事件流没有回复正文。', 502, 'empty_stream')
}

function safeJson(text) {
  if (!text) return {}
  try { return JSON.parse(text) } catch { return { message: text.slice(0, 300) } }
}
