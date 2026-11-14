/**
 * 豆包工作的模式与模型菜单。
 *
 * 菜单来自网页版首屏 SSR 的 `actionBarBriefList.modeSelectData`，内容是
 * mode_list → 每个 mode 的 model_list。我们要 `default_conversation_mode === 'office'`
 * 的那个（当前 mode_id=3、agent_mode=1），它才装着工作版的多模型。
 *
 * 字段含义（都是实测出来的）：
 *   model_item_key   真正发给上游的键，形如 person-kimi-k3-1-pro-261111
 *   name             展示名
 *   agent_mode       1 = 工作任务（会走 office 通道）
 *   item_id          请求里 option.need_deep_think 用
 *   model_extra_params.total_window_size  上下文窗口
 *   reasoning_effort_config.option_list   推理档位，可能是 3/4/5/6/7 或 3/8/5
 *   subscribe_config.need_upgrade          当前账号没订，跳过
 *   conversation_mode_list                 必须含 office
 *
 * 那份 SSR 数据由服务端 loader 取，网页里没有对应的前端接口（实测
 * `/alice/slot/action_bar_v3/brief_list` 只返回 entry_list 技能条，
 * `/alice/bot/...` 404）。所以这里内置一份基线，登录后仍会尝试在线刷新；
 * 在线拿不到就用基线，不会因为刷新失败而没有模型。
 */
import { ProviderError } from './errors.mjs'

/**
 * 从 tag_list 里取倍率。
 *
 * 豆包把倍率当标签返回：type 2 是纯倍率（"1.44x"），type 6 是「限时优惠 0.01x」
 * 这种带前缀的，两者都要认。type 6 且没有数字的（如「小额免费」）表示不计费。
 * @returns {{ rate?: number, free?: boolean, text: string }}
 */
export function readRate(tags) {
  const list = Array.isArray(tags) ? tags : []
  for (const tag of list) {
    const text = String(tag?.text ?? '').trim()
    if (!text) continue
    const match = text.match(/(\d+(?:\.\d+)?)\s*[xX×]$/)
    if (match) {
      const rate = Number(match[1])
      if (Number.isFinite(rate)) return { rate, free: rate === 0, text }
    }
    if (/免费/.test(text)) return { free: true, text }
  }
  return { text: '' }
}

/** magpie 的 cost 结构。
 *
 * cost 的语义是「每百万 token 的价格」，豆包给的是相对订阅的扣费倍率，两者量纲
 * 不同，不能直接填 input/output——填了就是编造价格。所以一律填 0，倍率单独放在
 * 模型的 rate 字段里，界面会把它渲染成徽章。
 * 注意 cache 是嵌套对象，社区插件都这么写。
 */
function costOf() {
  return { input: 0, output: 0, cache: { read: 0, write: 0 } }
}

/** 上游档位 → magpie 的推理档位名。8 是「自动」那一档 */
export const EFFORT_NAMES = { 3: 'low', 4: 'medium', 5: 'high', 6: 'xhigh', 7: 'max', 8: 'auto' }

const ID_PREFIX = 'doubao-'

/**
 * 基线菜单：2026-11 实测自真实账号的 office 模式。
 * need_upgrade 的条目保留在基线里但解析时跳过，账号升级后自动可用。
 */
export const FALLBACK_MENU = {
  modeId: '3',
  agentMode: 1,
  models: [
    { key: '9', name: '自动', itemId: 9, agentMode: 1, window: 256000, defaultMode: '3', levels: [3, 8, 5], defaultLevel: 8, needUpgrade: false, tag: '小额免费' },
    { key: 'seed-lite-7b', name: '豆包 2.1 Lite', itemId: 10001, agentMode: 1, window: 256000, defaultMode: '3', levels: [3, 4, 5], defaultLevel: 5, needUpgrade: false, tag: '限时优惠 0.01x' },
    { key: '5', name: '豆包 2.1 Pro', itemId: 5, agentMode: 1, window: 256000, defaultMode: '3', levels: [3, 4, 5], defaultLevel: 5, needUpgrade: true, tag: '0.65x' },
    { key: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '限时优惠 0.01x' },
    { key: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '0.95x' },
    { key: 'person-kimi-k3-1-pro-highspeed-261111', name: 'Kimi K3.1 Pro 高速', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '1.44x' },
    { key: 'person-kimi-k3-261111', name: 'Kimi K3', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '1.48x' },
    { key: 'person-glm-5-3-261111', name: 'GLM 5.3', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 5, 7], defaultLevel: 5, needUpgrade: false, tag: '0.80x' },
    { key: 'person-glm-5-3-flash-261111', name: 'GLM 5.3 Flash', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 5, 7], defaultLevel: 5, needUpgrade: false, tag: '0.08x' },
    { key: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', itemId: 10001, agentMode: 1, window: 300000, defaultMode: '3', levels: [3, 4, 5, 6, 7], defaultLevel: 5, needUpgrade: false, tag: '0.46x' },
  ],
}

function slugify(name, key) {
  // 纯数字键（9 / 5 / 0 / 3）没有语义，优先用别名，别名缺失才用名字派生
  if (/^\d+$/.test(String(key))) {
    const ALIAS = { 0: 'fast', 3: 'expert', 5: 'pro', 9: 'auto' }
    if (ALIAS[Number(key)]) return ALIAS[Number(key)]
    const fromName = String(name)
      .replace(/[^a-zA-Z0-9.]+/g, '-')
      .toLowerCase()
      .replace(/^-+|-+$/g, '')
    return /[a-z]/.test(fromName) ? fromName : `mode-${key}`
  }
  const fromKey = String(key)
    .replace(/^person-/, '')
    .replace(/-(261017|261111|260813|261010|\d{6})$/, '')
  const base = /^[a-z0-9-]+$/i.test(fromKey) ? fromKey : String(name)
  return base.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
}

/** 把一条模型配置变成内部结构 */
function toEntry(item, modeId, modeAgentMode) {
  // 在线结构是 subscribe_config.need_upgrade，基线是扁平 needUpgrade
  if (item.subscribe_config?.need_upgrade || item.needUpgrade) return undefined
  const key = String(item.model_item_key ?? item.key ?? '')
  if (!key) return undefined
  const modesList = Array.isArray(item.conversation_mode_list)
    ? item.conversation_mode_list
    : (Array.isArray(item.modes) ? item.modes : [])
  if (modesList.length && !modesList.includes('office')) return undefined

  const name = String(item.name ?? key)
  const id = ID_PREFIX + slugify(name, key)
  const levels = {}
  // 在线结构是 option_list，基线是 levels 数组
  const rawLevels = Array.isArray(item.reasoning_effort_config?.option_list)
    ? item.reasoning_effort_config.option_list.map((o) => o.level)
    : (item.levels ?? [])
  for (const level of rawLevels) {
    const effort = EFFORT_NAMES[level]
    if (effort && !(effort in levels)) levels[effort] = level
  }
  const rawDefault = item.reasoning_effort_config?.default_level ?? item.defaultLevel
  const defaultEffort = EFFORT_NAMES[rawDefault]
  const window = Number(item.model_extra_params?.total_window_size ?? item.window ?? 0)
  const extra = item.model_extra_params ?? {}
  // 基线没写 extra_params 时，按在线结构补出最小可用的那份
  if (!extra.total_window_size && window) extra.total_window_size = String(window)
  if (!extra.memory_profile) extra.memory_profile = window >= 300000 ? '300k_230' : '256k'

  const tag = item.tag_list?.[0]?.text ?? item.tag ?? ''
  const rate = readRate(item.tag_list ?? (tag ? [{ text: tag }] : []))

  return [id, {
    id, name, key,
    itemId: Number(item.item_id ?? item.itemId ?? 0),
    modeId: String(modeId ?? ''),
    agentMode: Number(item.agent_mode ?? item.agentMode ?? modeAgentMode ?? 1),
    extraParams: extra,
    levels,
    defaultEffort: defaultEffort && levels[defaultEffort] ? defaultEffort : Object.keys(levels)[0],
    context: Number.isSafeInteger(window) && window > 0 ? window : 0,
    tag,
    // 倍率与免费标记：豆包按订阅额度扣费，这个倍率决定同一积分能跑多少量
    rate: rate.rate,
    free: rate.free === true,
    rateText: rate.text,
  }]
}

/** 从在线响应解析；格式不符返回 null，不抛错，交给基线兜底 */
export function parseModels(payload) {
  const data = payload?.data ?? payload
  const conf = data?.modeSelectData?.menuConfV2 ?? data?.menuConfV2
  const modes = conf?.mode_list?.item_list
  if (!Array.isArray(modes) || !modes.length) return null

  const workMode = modes.find((m) => m.default_conversation_mode === 'office' && m.model_list?.item_list?.length)
  if (!workMode) return null

  const catalog = new Map()
  for (const item of workMode.model_list.item_list) {
    const entry = toEntry(item, workMode.mode_id, workMode.agent_mode)
    if (entry && !catalog.has(entry[0])) catalog.set(entry[0], entry[1])
  }
  return catalog.size ? catalog : null
}

/** 基线菜单 */
export function fallbackModels() {
  const catalog = new Map()
  for (const item of FALLBACK_MENU.models) {
    const entry = toEntry(item, FALLBACK_MENU.modeId, FALLBACK_MENU.agentMode)
    if (entry && !catalog.has(entry[0])) catalog.set(entry[0], entry[1])
  }
  return catalog
}

export function selectModel(catalog, request) {
  const model = catalog.get(request.model)
  if (!model) {
    throw new ProviderError(`当前账号没有模型 ${request.model}，请重新获取模型列表。`, 404, 'unknown_model')
  }
  const effort = request.reasoning_effort ?? model.defaultEffort
  if (effort && !(effort in model.levels)) {
    throw new ProviderError(
      `模型 ${model.name} 不支持推理强度 ${effort}（可选：${Object.keys(model.levels).join(' / ')}）。`,
      400, 'invalid_reasoning_effort',
    )
  }
  return { ...model, effort, level: model.levels[effort] }
}

/** 供应商声明。models 故意不写，交给 config 钩子补齐占位模型。 */
export function buildProvider(providerId = 'doubao') {
  return {
    name: '豆包工作',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://www.doubao.com/v1',
  }
}

/** 未登录时的占位模型：让供应商那一行可见，登录后由 provider.models 覆盖 */
export function buildModels() {
  return {
    'doubao-auto': {
      name: '自动',
      context: 256_000,
      limit: { context: 256_000, output: 0 },
      tool_call: true,
      reasoning: true,
    },
  }
}

/** 转成 magpie 的 Model 形状 */
export function magpieModels(catalog, providerId = 'doubao') {
  return Object.fromEntries([...catalog].map(([id, model]) => {
    const context = model.context || 256_000
    const entry = {
      id,
      providerID: providerId,
      // 名字只放模型本名，倍率交给 magpie 用 rate 字段渲染成徽章
      name: model.name,
      api: { id, url: 'https://www.doubao.com/v1', npm: '@ai-sdk/openai-compatible' },
      status: 'active',
      headers: {},
      options: {},
      // 豆包按订阅额度扣费，没有每百万 token 的单价，所以 cost 一律填 0。
      // 注意 cache 是嵌套对象，community 插件都是这么写的。
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      // 上下文：limit.context 是 OpenCode v1 的字段，社区插件都用这个
      limit: { context, output: 0 },
      capabilities: {
        temperature: false,
        reasoning: Object.keys(model.levels).length > 0,
        attachment: false,
        toolcall: true,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: '',
      variants: Object.fromEntries(Object.keys(model.levels).map((effort) => [effort, { reasoningEffort: effort }])),
    }
    // magpie 自己的字段：一次请求消耗的倍数，界面会渲染成「0.01x」那种徽章。
    // 免费档用 0 表示不计费。
    if (model.free) entry.rate = 0
    else if (Number.isFinite(model.rate)) entry.rate = model.rate
    return [id, entry]
  }))
}

export const _internal = { slugify, toEntry }
