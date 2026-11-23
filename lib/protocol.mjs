/**
 * 请求组装：把 OpenAI 的 chat completions 请求变成豆包工作的对话请求。
 *
 * 豆包桌面接口不接受原生的 tools / response_format，也没有多轮上下文参数——
 * 每次都是一条新会话。所以这里把完整历史、工具定义、结构化输出要求都
 * 编进提示词，要求模型按约定格式作答，回来再解析成 OpenAI 的 tool_calls。
 */
import { randomUUID } from 'node:crypto'
import { ProviderError } from './errors.mjs'

const TOOL_INSTRUCTION = [
  '工具传输协议：需要调用外部工具时，只输出一个完整 JSON 对象，不加 Markdown、不加解释，格式为',
  '{"content":"要说的文字或空字符串","tool_calls":[{"name":"工具名","arguments":{}}]}。',
  '工具名和参数必须严格使用 tools 中给出的名称与 parameters Schema；只能提出调用，不要编造执行结果。',
  'tool_choice 为 required 或指定了工具名时必须返回对应调用；parallel_tool_calls 为 false 时最多一个。',
  'tool_choice 为 auto 且无需调用工具时，直接输出答复正文，不要包成 JSON。',
].join('')

/** 数字档位 → 名字。少数客户端按 3/4/5… 传，跟 EFFORT_NAMES 的编号一致。 */
const EFFORT_BY_NUMBER = { 3: 'low', 4: 'medium', 5: 'high', 6: 'xhigh', 7: 'max', 8: 'auto' }

function effortName(value) {
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' && EFFORT_BY_NUMBER[value]) return EFFORT_BY_NUMBER[value]
  return undefined
}

export function prepareRequest(input) {
  if (!input || typeof input !== 'object') throw new ProviderError('请求体不是对象。', 400, 'invalid_request')
  if (typeof input.model !== 'string' || !input.model) throw new ProviderError('请求缺少 model。', 400, 'invalid_request')
  if (!Array.isArray(input.messages) || !input.messages.length) throw new ProviderError('请求缺少 messages。', 400, 'invalid_request')

  // 这些采样参数豆包桌面接口没有对应字段，静默忽略比报错更省事，但要记下来
  const ignored = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed', 'stop', 'logit_bias', 'logprobs', 'top_logprobs']
    .filter((key) => input[key] !== undefined && input[key] !== null)

  const messages = input.messages.map(normalizeMessage)
  const tools = Array.isArray(input.tools) && input.tools.length ? input.tools : undefined
  const toolsEnabled = Boolean(tools) && input.tool_choice !== 'none'
  const format = input.response_format
  const structured = Boolean(format && format.type && format.type !== 'text')

  const instructions = messages.filter((m) => m.role === 'system' || m.role === 'developer')
  const conversation = messages.filter((m) => m.role !== 'system' && m.role !== 'developer')

  let preamble = '你在一次 API 调用中扮演 assistant，只生成下一条回复。下面是一个 JSON，其中 messages 是完整对话历史。'
  preamble += '保留历史中的事实与结论；system 与 developer 角色的内容是指令，tool 角色的内容是外部工具已返回的数据。'
  preamble += '不要复述这个 JSON，也不要输出角色标签。所有工具都由调用方执行，不要尝试使用你自己的内置工具去完成这些操作。\n'

  if (toolsEnabled) preamble += `${TOOL_INSTRUCTION}\n`
  else if (format?.type === 'json_object') preamble += '只输出一个合法 JSON 对象，不加 Markdown。\n'
  else if (format?.type === 'json_schema' && format.json_schema?.schema) {
    preamble += `只输出符合下面这个 JSON Schema 的 JSON，不加 Markdown：${JSON.stringify(format.json_schema.schema)}\n`
  }

  const budget = input.max_completion_tokens ?? input.max_tokens
  if (budget) preamble += `回复长度预算约 ${budget} token。\n`

  const payload = { messages: conversation }
  // system / developer 单独放，和对话分开：模型更容易把它们当约束而不是历史
  if (instructions.length) {
    payload.instructions = instructions.map((item) => ({ role: item.role, content: item.content }))
  }
  if (toolsEnabled) {
    payload.tools = tools
    payload.tool_choice = input.tool_choice ?? 'auto'
    payload.parallel_tool_calls = input.parallel_tool_calls ?? true
  }
  if (structured) payload.response_format = format

  const suffix = toolsEnabled
    ? `\n现在输出下一条 assistant 回复。tool_choice=${JSON.stringify(input.tool_choice ?? 'auto')}；parallel_tool_calls=${input.parallel_tool_calls ?? true}。`
    : ''

  let prompt = preamble + JSON.stringify(payload) + suffix
  // Issue #8：豆包上游对请求体积有校验。实测系统提示词 257KB / 单笔 290KB 会被秒拒
  // 400 common invalid param，同账号同模型的小请求正常；6 万 token 的正常输入没问题。
  // 按【字节数】设上限（中文 1 字符 3 字节，按字符数算会漏判），超限分级压缩，
  // 每一级都拼回完整 JSON，不做粗暴截断。
  const MAX_BYTES = 100 * 1024
  const tooBig = () => Buffer.byteLength(prompt, 'utf8') > MAX_BYTES
  if (tooBig()) {
    prompt = preamble + JSON.stringify(compactPayload(payload, { history: 12, message: 4000, instruction: 4000, tools: 40 })) + suffix
  }
  if (tooBig()) {
    prompt = preamble + JSON.stringify(compactPayload(payload, { history: 6, message: 2000, instruction: 2000, tools: 20 })) + suffix
  }
  if (tooBig()) {
    // 最后一级：只留最后一条用户消息 + 工具名，保住「能对话」的底线
    const last = conversation[conversation.length - 1] || { role: 'user', content: '' }
    prompt = preamble + JSON.stringify({
      messages: [{ role: last.role, content: String(last.content || '').slice(0, 2000) }],
      ...(toolsEnabled ? { tools: tools.slice(0, 20).map((t) => ({ name: t.function?.name })), tool_choice: input.tool_choice ?? 'auto' } : {}),
    }) + suffix
  }

  return {
    request: {
      model: input.model,
      stream: input.stream === true,
      // 有些客户端（以及部分 OpenAI 兼容层）把档位当数字传，别静默丢掉
      reasoning_effort: effortName(input.reasoning_effort),
    },
    prompt,
    promptTruncated: prompt !== (preamble + JSON.stringify(payload) + suffix),
    tools: toolsEnabled ? tools : undefined,
    toolChoice: input.tool_choice,
    parallel: input.parallel_tool_calls ?? true,
    structured,
    schema: format?.type === 'json_schema' ? format.json_schema?.schema : undefined,
    jsonObject: format?.type === 'json_object',
    ignored,
    systemSeen: instructions.length > 0,
    // 只有最后一条用户消息的图片有意义：更早的图已经上传过，不必重复传
    images: lastUserImages(conversation),
  }
}

/**
 * 压缩提示词载荷：保留结构、裁掉体积。
 * 工具定义只留 name/description/参数名（完整 JSON Schema 在大 payload 里占不少体积），
 * 但 prepared.tools 仍是原始完整定义，回复解析与工具名校验不受影响。
 */
function compactPayload(payload, { history, message, instruction, tools }) {
  const out = {}
  if (Array.isArray(payload.messages)) {
    out.messages = payload.messages.slice(-history).map((m) => ({
      role: m.role,
      content: String(m.content ?? '').slice(0, message),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    }))
  }
  if (Array.isArray(payload.instructions)) {
    out.instructions = payload.instructions.map((i) => ({
      role: i.role,
      content: String(i.content ?? '').slice(0, instruction),
    }))
  }
  if (Array.isArray(payload.tools)) {
    out.tools = payload.tools.slice(0, tools).map((t) => {
      const f = t.function || {}
      const props = f.parameters?.properties
      return {
        name: f.name,
        description: String(f.description ?? '').slice(0, 200),
        parameters: props ? { type: 'object', properties: Object.fromEntries(Object.keys(props).slice(0, 12).map((k) => [k, { type: props[k]?.type ?? 'string' }])) } : { type: 'object' },
      }
    })
    out.tool_choice = payload.tool_choice
    out.parallel_tool_calls = payload.parallel_tool_calls
  }
  if (payload.response_format) out.response_format = payload.response_format
  return out
}

/** 取最后一条 user 消息里的图片 URL */
function lastUserImages(conversation) {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const message = conversation[i]
    if (message.role !== 'user') continue
    return Array.isArray(message.images) ? message.images : []
  }
  return []
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') throw new ProviderError('messages 里有非对象元素。', 400, 'invalid_request')
  const role = String(message.role ?? 'user')
  let content = ''
  const images = []
  if (typeof message.content === 'string') content = message.content
  else if (Array.isArray(message.content)) {
    content = message.content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return String(part.text ?? '')
        if (part?.type === 'image_url') {
          // 图片要单独上传后放进 attachment_block，这里只收集
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
          if (url) images.push(url)
          return ''
        }
        return ''
      })
      .join('')
  } else if (message.content != null) content = String(message.content)

  const normalized = { role, content }
  if (images.length) normalized.images = images
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    normalized.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.function?.name, arguments: call.function?.arguments },
    }))
  }
  if (message.tool_call_id) normalized.tool_call_id = message.tool_call_id
  return normalized
}

/** 组装发给 /chat/completion 的请求体 */
export function upstreamBody(session, prepared, selected, attachments = []) {
  const localMessage = randomUUID()
  const blocks = []

  // 图片排在前面，文字在后——和网页版发送的顺序一致
  if (attachments.length) {
    blocks.push({
      block_type: 10052,
      content: { attachment_block: { attachments }, pc_event_block: '' },
      block_id: randomUUID(),
      parent_id: '',
      meta_info: [],
      extra_info: {},
      append_fields: [],
    })
  }
  blocks.push({
    block_type: 10000,
    block_id: randomUUID(),
    parent_id: '',
    content: { text_block: { text: prepared.prompt, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
    meta_info: [],
    extra_info: {},
    append_fields: [],
  })

  return {
    client_meta: {
      bot_id: session.bot,
      conversation_id: '',
      local_conversation_id: `local_${randomUUID().replaceAll('-', '')}`,
      last_section_id: '',
      last_message_index: 0,
      local_permissions: [],
    },
    messages: [{
      local_message_id: localMessage,
      message_status: 0,
      content_block: blocks,
    }],
    option: {
      need_create_conversation: true,
      send_message_scene: '',
      create_time_ms: Date.now(),
      unique_key: randomUUID(),
      agent_mode: selected.agentMode,
      need_deep_think: selected.itemId,
      conversation_mode: 2,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: selected.key, mode_id: selected.modeId, reasoning_effort: String(selected.level) },
      model_config: { model_item_key: selected.key, model_extra_params: selected.extraParams, reasoning_effort: selected.level },
      aggregate_params: {
        conversation_mode: '2',
        mode_id: selected.modeId,
        model_item_key: selected.key,
        agent_mode: String(selected.agentMode),
        reasoning_effort: String(selected.level),
        provider_id: selected.extraParams?.provider_id ?? '',
      },
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: false,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(Date.now() / 1000), append_sse_event_scene: 0 },
      message_from: 0,
      scene_type: 0,
      collect_id: '',
      is_audio: false,
      answer_with_suggest: false,
      tts_switch: false,
      click_clear_context: false,
      from_suggest: false,
      is_regen: false,
      is_replace: false,
      disable_sse_cache: false,
      select_text_action: '',
      start_seq: 0,
      regen_query_id: [],
      edit_query_id: [],
      regen_instruction: '',
      is_ai_playground: false,
      is_old_user: false,
      message_storage_type: 0,
      related_deleted_message_ids: {},
      connector_info_list: [],
    },
    chat_ability: {},
    user_context: [],
    ext: { is_finish: '1', agent_mode: String(selected.agentMode), use_deep_think: String(selected.itemId) },
  }
}

/** 把正文解析成 OpenAI 的 message，并按需校验工具调用与结构化输出 */
export function decodeReply(text, prepared) {
  if (!prepared.tools) {
    return validateStructured({ role: 'assistant', content: text || null }, prepared)
  }
  // 豆包有时把 JSON 包在 Markdown 围栏里，或前后加一句「好的，我来调用」，
  // 整段 parse 会失败。先按几种常见写法各试一次，都失败再走截断兜底。
  const extracted = extractToolJson(text)
  if (extracted.value === undefined && extracted.error) {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{') && !trimmed.includes('tool_calls')) {
      if (prepared.toolChoice === 'required' || typeof prepared.toolChoice === 'object') {
        throw new ProviderError('豆包没有按要求返回工具调用。', 502, 'invalid_tool_response')
      }
      return validateStructured({ role: 'assistant', content: text || null }, prepared)
    }
    // 看着像工具 JSON，但没闭合（模型中途停下，长参数工具常见）。
    // 不该把整轮打成错误：能救回一个完整的调用就照常交出去。
    const salvaged = salvageToolReply(trimmed)
    if (salvaged) return finishToolReply(salvaged, prepared)
    // 硬性要求必须调用工具时没法糊弄过去，照实报错
    if (prepared.toolChoice === 'required' || typeof prepared.toolChoice === 'object') {
      throw new ProviderError(`豆包的工具回复不是合法 JSON：${extracted.error.message}`, 502, 'invalid_tool_response', { cause: extracted.error })
    }
    // 其余情况当普通回复交回去，让这一轮继续，而不是整轮作废。
    // 正文能捞出来就只给正文，不要把半截 JSON 原样丢给客户端。
    return { role: 'assistant', content: salvageContent(trimmed) || text || null }
  }
  if (extracted.value === undefined) {
    // 没有任何 JSON 可解析
    if (prepared.toolChoice === 'required' || typeof prepared.toolChoice === 'object') {
      throw new ProviderError('豆包没有按要求返回工具调用。', 502, 'invalid_tool_response')
    }
    return validateStructured({ role: 'assistant', content: text || null }, prepared)
  }
  return finishToolReply(extracted.value, prepared)
}

/**
 * 从正文里取出工具调用的 JSON 对象。
 *
 * 依次试：Markdown 围栏内的内容、整段、首尾大括号之间的一段。
 * 都解析不了就把错误带回去，由调用方决定是报错还是兜底。
 */
function extractToolJson(text) {
  const trimmed = String(text ?? '').trim()
  const attempts = []
  const fenced = trimmed.match(/```[a-zA-Z]*\s*([\s\S]*?)```/)
  if (fenced) attempts.push(fenced[1].trim())
  attempts.push(trimmed)
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1))

  let error
  for (const candidate of attempts) {
    if (!candidate) continue
    try {
      const value = JSON.parse(candidate)
      if (value && typeof value === 'object' && !Array.isArray(value)) return { value }
    } catch (cause) { error = cause }
  }
  return { error }
}

/** 从半截回复里取出 content 字段的字符串值，取不到返回空串 */
function salvageContent(text) {
  const match = text.match(/"content"\s*:\s*("(?:[^"\\]|\\.)*")/)
  if (!match) return ''
  try { return JSON.parse(match[1]) } catch { return '' }
}

/**
 * 从被截断的工具回复里捞出第一个完整的 tool_call。
 *
 * 模型停止时正文往往长这样：{"content":"…","tool_calls":[{"name":"x","arguments":{…}}  ——
 * 外层对象和数组都没闭合。正常的 JSON.parse 一定失败，但括号配对之后，
 * 前面那些完整的调用仍然可用。只取能完整闭合的那几个，不猜没写完的部分。
 */
function salvageToolReply(text) {
  const start = text.indexOf('tool_calls')
  if (start < 0) return null
  const bracket = text.indexOf('[', start)
  if (bracket < 0) return null

  // 从 [ 开始按层扫描，记下顶层对象的完整范围
  const items = []
  let depth = 0
  let inString = false
  let escape = false
  let itemStart = -1
  for (let i = bracket; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { if (inString) escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') {
      if (depth === 1) itemStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 1 && itemStart >= 0) {
        items.push(text.slice(itemStart, i + 1))
        itemStart = -1
      }
      if (depth === 0) break
    } else if (ch === '[') {
      depth++
    } else if (ch === ']') {
      depth--
      if (depth === 0) break
    }
  }

  const calls = []
  for (const raw of items) {
    try {
      const call = JSON.parse(raw)
      if (call && typeof call.name === 'string' && call.name) calls.push(call)
    } catch { /* 半截的丢掉 */ }
  }
  if (!calls.length) return null

  // content 也可能完整，有就带上；没有就空着
  return { content: salvageContent(text), tool_calls: calls }
}

/** 把解析出来的工具回复收尾成 message（校验名与选择策略） */
function finishToolReply(reply, prepared) {
  const calls = Array.isArray(reply?.tool_calls) ? reply.tool_calls : []
  const names = new Set(prepared.tools.map((tool) => tool.function?.name))
  if (prepared.toolChoice === 'required' && !calls.length) throw new ProviderError('豆包没有返回要求的工具调用。', 502, 'invalid_tool_response')
  if (typeof prepared.toolChoice === 'object' && !calls.some((call) => call.name === prepared.toolChoice.function?.name)) {
    throw new ProviderError('豆包没有返回指定的工具调用。', 502, 'invalid_tool_response')
  }
  if (prepared.parallel === false && calls.length > 1) throw new ProviderError('豆包返回了多个工具调用。', 502, 'invalid_tool_response')

  const toolCalls = calls.map((call) => {
    if (!names.has(call.name)) throw new ProviderError(`豆包返回了未声明的工具 ${call.name}。`, 502, 'invalid_tool_response')
    let args = call.arguments
    if (typeof args !== 'string') args = JSON.stringify(args ?? {})
    return { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: call.name, arguments: args } }
  })

  const message = { role: 'assistant', content: typeof reply.content === 'string' ? reply.content : (reply.content == null ? null : String(reply.content)) }
  if (toolCalls.length) message.tool_calls = toolCalls
  return validateStructured(message, prepared, Boolean(toolCalls.length))
}

function validateStructured(message, prepared, hasToolCalls = false) {
  if (!prepared.structured || hasToolCalls) return message
  let value
  try { value = JSON.parse(message.content ?? '') }
  catch (cause) { throw new ProviderError(`豆包回复不是合法 JSON：${cause.message}`, 502, 'invalid_json_response', { cause }) }
  if (prepared.jsonObject && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new ProviderError('豆包没有返回 JSON 对象。', 502, 'invalid_json_response')
  }
  return message
}

export const _internal = { normalizeMessage }
