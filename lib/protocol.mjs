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

  return {
    request: {
      model: input.model,
      stream: input.stream === true,
      reasoning_effort: typeof input.reasoning_effort === 'string' ? input.reasoning_effort : undefined,
    },
    prompt: preamble + JSON.stringify(payload) + suffix,
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
  const trimmed = text.trim()
  const looksJson = trimmed.startsWith('{')
  if (!looksJson) {
    if (prepared.toolChoice === 'required' || typeof prepared.toolChoice === 'object') {
      throw new ProviderError('豆包没有按要求返回工具调用。', 502, 'invalid_tool_response')
    }
    return validateStructured({ role: 'assistant', content: text || null }, prepared)
  }

  let reply
  try { reply = JSON.parse(trimmed) }
  catch (cause) { throw new ProviderError(`豆包的工具回复不是合法 JSON：${cause.message}`, 502, 'invalid_tool_response', { cause }) }

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
