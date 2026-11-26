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
      // 把 prepared 和 decodeReply 传进去：带工具的请求要收完整段才能解析 tool_calls，
      // 之前这里直接把原始增量当正文发，工具调用的 JSON 会原样出现在正文里。
      return new Response(responsesEventStream(meta, source, finalUsage, prepared, decodeReply), {
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

/**
 * 判断已收到的开头是不是工具调用的 JSON。
 *
 * 指令要求（见 protocol.mjs 的工具传输协议）：要调工具时只输出一个 JSON，
 * 不需要调时直接输出正文。所以看开头就能判断，不用等整段。
 *
 * 认三种写法：
 *  - 直接以 { 开头
 *  - ```json 围栏
 *  - 前后带一句解释再跟 { 的情况（decodeReply 里也兼容这种）
 *
 * 认错了的后果是可控的：把 JSON 当正文流式发出去，用户看到一坨原文、这次工具调用丢了，
 * 但不会崩、也不会误执行。相比之下反过来（把正文当 JSON 缓冲）只是慢，不会丢内容，
 * 所以这里的判断偏向「宁可多缓冲」——只有明确像正文时才流式。
 */
export function looksLikeToolJson(text) {
  const head = String(text ?? '').trimStart()
  if (!head) return false
  if (head.startsWith('{')) return true
  if (head.startsWith('```')) return true
  // 开头是一小段话、后面才出 JSON 的情况。这里要保守：正文里出现大括号很常见
  // （举例说明、代码片段、数学公式），误判成工具调用会让整段回复被缓冲。
  // 只有前面明确是「要执行动作」的说法才认。
  const brace = head.indexOf('{')
  if (brace > 0 && brace < 200) {
    const before = head.slice(0, brace)
    // 以冒号/逗号/括号结尾的，基本是在举例
    if (/[：:，,、（(]\s*$/.test(before)) return false
    // 句号结尾说明上一句已经说完了，后面的大括号是独立内容
    if (/[。！？.!?]\s*$/.test(before)) return false
    // 剩下的：明确带调用/执行一类的动词才算
    return /tool|调用|执行|读取|运行/.test(before)
  }
  return false
}

/**
 * 攒到的开头够不够判断形态。
 *
 * 只等「能下结论」所需的最少量：
 *  - 空 → 继续等
 *  - 以 { 或 ``` 开头 → 能判断（是工具 JSON）
 *  - 已经明确是正文（首字符不是 { 也不是 `）→ 能判断
 *  - 极短且只有空白/半截围栏 → 再等一块
 *
 * 关键是不能用固定字数当门槛：短回复永远攒不够，就会退化成全缓冲。
 */
export function decided(text) {
  const head = String(text ?? '').trimStart()
  if (!head) return false
  if (head.startsWith('{')) return true
  if (head.startsWith('`')) {
    // 半截围栏（只有一个反引号）再等等，三个就确定是代码块
    return head.startsWith('```')
  }
  return true // 首字符不是 { 也不是 `，就是正文
}

export function sseResponse(source, meta, prepared, abort) {
  const encoder = new TextEncoder()
  let canceled = false
  const iterator = source[Symbol.asyncIterator]()
  const promptTokens = estimateTokens(prepared.prompt)
  // usage 只在最后一个块里给一次，和 OpenAI 的 stream_options.include_usage 行为一致
  let output = ''
  const startedAt = Date.now()
  let upstreamFirstAt = 0
  const finalUsage = () => {
    const completionTokens = estimateTokens(output)
    return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
  }

  const emit = (controller, delta, finish = null, usage) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(meta, delta, finish, usage))}\n\n`))
  const closeWithDone = (controller, finish = 'stop') => {
    emit(controller, {}, finish, finalUsage())
    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
    controller.close()
  }

  // 带工具的请求有两种输出形态（见 protocol.mjs 的工具传输协议）：
  //   1. 要调用工具 → 只输出一个 JSON：{"content":"...","tool_calls":[...]}
  //   2. 不需要调用 → 直接输出正文，不包 JSON
  //
  // 以前一律整段缓冲，于是纯文本回复也要等全部生成完才吐字——issue #9 的「首字
  // 十几秒」和 #14 的「看不到工作过程」都是这个原因。现在先收一小段判断形态：
  // 像工具 JSON 就继续缓冲（必须完整才能解析），确认是纯文本就逐块转发。
  //
  // 关键：pull() 每次只推进一步。之前在一个 pull 里 while 把整条流读完再吐，
  // 等于没流式——数据照样攒到最后。所以这里用 mode/pending 记住进度。
  const buffered = Boolean(prepared.tools || prepared.structured)
  let mode = buffered ? '' : 'text' // '' 未判定 | 'text' 流式 | 'tool' 缓冲
  let pendingText = ''
  let pendingReasoning = ''
  let done = false

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        if (canceled) return

        // 还没判定形态：只等第一个非空块，看首字符决定，不再攒固定字数。
        //
        // 之前攒 200 字符再判定，短回复（"改这一行""是/否"）永远攒不够，
        // 于是一直等到整段生成完才吐字——实测那段时间是 6-12 秒，等于没流式。
        // 判断「像不像工具 JSON」其实只看开头就够：`{` 或 ``` 围栏。
        // 「先说一句再输出 JSON」的少数情况交给 tool 分支的分级兜底处理。
        //
        // reasoning 不参与判定，也不等它——它不可能是工具 JSON，先发出去。
        if (mode === '') {
          // 只等到「能判断」为止：收到第一个非空块后，如果它像 JSON 就转 tool，
          // 不像就立刻转 text。首块过短（比如只有 "{"）时再等一块，但不设总字数上限。
          let guard = 0
          while (!done && !decided(pendingText) && guard++ < 8) {
            const next = await iterator.next()
            if (next.done) { done = true; break }
            if (!upstreamFirstAt) upstreamFirstAt = Date.now() - startedAt
            pendingReasoning += next.value.reasoning_content ?? ''
            pendingText += next.value.content ?? ''
          }
          // 只有 reasoning、没有正文时也算能判定：reasoning 不可能是工具 JSON，
          // 先把它发出去，正文等后续块再判。
          if (!pendingText && pendingReasoning) {
            mode = 'text'
          } else {
            // 结构化输出必须完整 JSON，强制走缓冲
            mode = (prepared.structured || looksLikeToolJson(pendingText)) ? 'tool' : 'text'
          }
          if (mode === 'text') {
            // 判断窗口里攒下的立刻发出去（通常只有一块）
            if (pendingReasoning) {
              output += pendingReasoning
              emit(controller, { reasoning_content: pendingReasoning })
              pendingReasoning = ''
            }
            if (pendingText) {
              output += pendingText
              emit(controller, { role: 'assistant', content: pendingText })
              pendingText = ''
            }
            if (done) return closeWithDone(controller)
            return
          }
          // 落到 tool 分支继续往下走
        }

        if (mode === 'text') {
          // 注意：空块不能直接 return——pull 只有在 enqueue 之后才会被再次调用，
          // 遇到空块就 return 会让整个流卡死（issue #17 后续测试暴露的问题）。
          // 这里用循环跳过空块，直到拿到有内容的块或流结束。
          let guard = 0
          while (guard++ < 100) {
            const next = await iterator.next()
            if (next.done) return closeWithDone(controller)
            const piece = next.value
            if (piece.reasoning_content) {
              output += piece.reasoning_content
              emit(controller, { reasoning_content: piece.reasoning_content })
              return
            }
            if (piece.content) {
              output += piece.content
              emit(controller, { content: piece.content })
              return
            }
            // 空块：继续要下一块
          }
          return
        }

        // mode === 'tool'：必须收完整段才能解析 tool_calls
        let text = pendingText
        let reasoning = pendingReasoning
        while (!done) {
          const next = await iterator.next()
          if (next.done) { done = true; break }
          if (!upstreamFirstAt) upstreamFirstAt = Date.now() - startedAt
          text += next.value.content ?? ''
          reasoning += next.value.reasoning_content ?? ''
        }
        if (canceled) return
        const total = Date.now() - startedAt
        if (total > 5000) {
          console.warn(
            `[doubao] 工具调用整段耗时 ${total}ms（上游首块 ${upstreamFirstAt}ms，回复 ${text.length} 字）。` +
            '工具调用必须收完才能解析，这段等待无法避免。',
          )
        }
        if (reasoning) emit(controller, { reasoning_content: reasoning })
        const message = decodeReply(text, prepared)
        const delta = { role: 'assistant' }
        if (message.content) delta.content = message.content
        if (message.tool_calls) delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...call }))
        output = text + reasoning
        // 先把带内容的 delta 发出去，再发结束标记。
        // 漏了这一步的话 tool_calls 永远不会到达客户端，只剩一个空的 finish 事件。
        if (delta.content || delta.tool_calls) emit(controller, delta)
        closeWithDone(controller, message.tool_calls ? 'tool_calls' : 'stop')
        return
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
