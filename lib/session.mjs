/**
 * 豆包工作桌面会话。
 *
 * 关键事实：这套接口是给客户端自己用的，请求要靠四个东西才被认成「桌面端」——
 * 登录 Cookie、桌面端的查询参数（aid=1044603、channel、web_platform 等）、
 * 设备标识（device_id / web_id / tea_uuid），以及启动接口下发的 bot_id。
 * 少任何一个，服务端要么判 login invalid，要么报 common invalid param。
 */
import { ProviderError, upstreamError } from './errors.mjs'
import { parseModels, parseSsrModels, fallbackModels } from './models.mjs'
import { importDesktop } from './desktop.mjs'
import { loadAccount } from './vault.mjs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const BASE = 'https://www.doubao.com'

/** 桌面端固定参数。
 *
 * aid 必须用 497858（网页/客户端共用的对话应用），不是 1044603——
 * 后者是另一条产品线，用它请求会拿不到工作版模型菜单。
 * web_platform 用 browser：实测网页版工作页就是这套参数，服务端照样
 * 下发了完整的 office 模型菜单。
 */
export const DESKTOP_PARAMS = {
  aid: '497858',
  real_aid: '497858',
  device_platform: 'web',
  doubao_device_platform: 'web',
  version_code: '20800',
  language: 'zh',
  samantha_web: '1',
  'use-olympus-account': '1',
  pkg_type: 'release_version',
  web_platform: 'browser',
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

// 风控冷却时长。豆包的验证是按账号投的，用户不打开网页去验证就一直是拦着的，
// 所以这里宁可等久一点，也不要在冷却期内反复试探。
const CHALLENGE_COOLDOWN = 5 * 60_000

/** 没有客户端时用的 bot_id 兜底值（豆包工作桌面端的默认助手） */
export const FALLBACK_BOT = '7338286299411103781'

/** 豆包工作客户端的默认数据目录 */
/**
 * 客户端 User Data 目录的候选位置。
 *
 * 豆包工作不同版本/不同渠道装的目录名不一样，实测见过 `Doubao` 和 `DoubaoWork`
 * 两种，还有可能装在 Roaming 下。只认死一个名字会让用户被迫手填路径，
 * 所以这里列出所有见过的位置，逐个试。
 */
export function userDataDirCandidates() {
  const home = homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return [
      join(local, 'Doubao', 'User Data'),
      join(local, 'DoubaoWork', 'User Data'),
      join(roaming, 'Doubao', 'User Data'),
      join(roaming, 'DoubaoWork', 'User Data'),
    ]
  }
  if (process.platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support')
    return [join(support, 'Doubao'), join(support, 'DoubaoWork')]
  }
  const config = process.env.XDG_CONFIG_HOME || join(home, '.config')
  return [join(config, 'Doubao'), join(config, 'DoubaoWork')]
}

/** 极简 cookie jar：豆包只在 doubao.com 下用，按域名后缀匹配即可 */
class Jar {
  constructor(cookies = []) { this.cookies = new Map() }
  static from(cookies) {
    const jar = new Jar()
    for (const cookie of cookies) {
      const key = `${cookie.domain}|${cookie.path || '/'}|${cookie.name}`
      jar.cookies.set(key, { ...cookie })
    }
    return jar
  }
  headerFor(url) {
    const host = new URL(url).hostname
    const now = Math.floor(Date.now() / 1000)
    const parts = []
    for (const cookie of this.cookies.values()) {
      const domain = cookie.domain.replace(/^\./, '')
      if (host !== domain && !host.endsWith(`.${domain}`)) continue
      if (cookie.expires && cookie.expires < now) continue
      parts.push(`${cookie.name}=${cookie.value}`)
    }
    return parts.join('; ')
  }
  absorb(url, setCookies) {
    const host = new URL(url).hostname
    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(';')
      const index = pair.indexOf('=')
      if (index < 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (!name) continue
      const cookie = { name, value, domain: host, path: '/', expires: 0, secure: true }
      for (const attr of attrs) {
        const [k, v = ''] = attr.split('=')
        const key = k.trim().toLowerCase()
        if (key === 'domain') cookie.domain = v.trim().replace(/^\./, '')
        else if (key === 'path') cookie.path = v.trim() || '/'
        else if (key === 'max-age') cookie.expires = Math.floor(Date.now() / 1000) + Number(v)
        else if (key === 'expires') { const t = Date.parse(v); if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000) }
        else if (key === 'secure') cookie.secure = true
      }
      this.cookies.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, cookie)
    }
  }
}

export class DesktopSession {
  constructor(binding, { fetcher = fetch, importer } = {}) {
    this.binding = binding
    this.fetcher = fetcher
    this.importer = importer
    this.readyAt = 0
    // 串行化：同一账号同一时刻只跑一个对话请求。
    // 并发打上游既容易触发风控，也会让会话清理错乱。
    this.queue = Promise.resolve()
    this.inFlight = 0
    // 被豆包要求人工验证后，一段时间内不再打上游。
    // 风控是按账号+出口 IP 记的，验证没过之前每多打一次都可能让解除时间推后。
    this.challengeUntil = 0
  }

  /** 风控冷却中？返回剩余毫秒，0 表示可以请求 */
  challengeLeft() {
    return Math.max(0, this.challengeUntil - Date.now())
  }

  /** 记一次风控拦截，进入冷却 */
  noteChallenge(ms = CHALLENGE_COOLDOWN) {
    this.challengeUntil = Math.max(this.challengeUntil, Date.now() + ms)
    this.lastProbeAt = 0
  }

  /**
   * 冷却期内用只读接口探测服务端是否已放行，放行则提前清除冷却（Issue: 过验证后仍要等满 5 分钟）。
   * 约束：距上次探测至少 30 秒，避免变成每次请求都打上游、反而推后风控解除。
   * 探测用 /alice/user/launch（纯查询、不建会话、不消耗额度）。
   * @returns {Promise<boolean>} true 表示已放行，冷却已清除
   */
  async probeChallenge(signal) {
    if (!this.challengeUntil || Date.now() - (this.lastProbeAt ?? 0) < 30_000) return false
    this.lastProbeAt = Date.now()
    try {
      // 直接走底层 request，不经过 chat，只读 GET
      await this.json('/alice/user/launch', {}, signal)
      // 没抛 captcha，说明服务端已放行
      this.challengeUntil = 0
      return true
    } catch (error) {
      if (error?.code === 'captcha_required' || error?.status === 403) {
        // 还没放行，把冷却至少再续 30 秒，避免每次都探
        this.challengeUntil = Math.max(this.challengeUntil, Date.now() + 30_000)
      }
      // 其他错误（网络抖动）不影响冷却判断
      return false
    }
  }

  /** 排队执行一个对话请求，保证同账号串行 */
  async exclusive(task) {
    const run = this.queue.then(async () => {
      this.inFlight++
      try { return await task() }
      finally { this.inFlight-- }
    })
    // 无论成败都要放行下一个，否则一次失败会把队列永久堵死
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  async ready(signal) {
    signal?.throwIfAborted()
    if (Date.now() - this.readyAt < 60_000) return
    this.pending ??= this.initialize().finally(() => { this.pending = undefined })
    await this.pending
    signal?.throwIfAborted()
  }

  async load() {
    if (this.importer) return this.importer(this.binding)
    // 优先用保管库：客户端退出登录、切号、甚至卸载之后，已导入的账号照常可用。
    // 只有在没有 uid（首次导入）或保管库里没有这个账号时，才回去读客户端。
    if (this.binding.uid) {
      try {
        const saved = await loadAccount(this.binding.uid)
        return {
          profile: saved.profile || 'vault',
          cookies: saved.cookies,
          clientInfo: saved.clientInfo,
          clientVersion: saved.clientVersion,
        }
      } catch (error) {
        if (!this.binding.allowDesktopFallback) throw new ProviderError(
          `保管库里没有账号 ${this.binding.uid} 的凭据：${error.message}`, 401, 'credential_missing', { signIn: 'expired' },
        )
      }
    }
    // 用户手填了目录就只用那一个；否则把常见位置都试一遍，
    // 免得因为装了别的目录名就要求用户自己去翻路径。
    if (this.binding.userDataDir) {
      return importDesktop(this.binding.userDataDir, this.binding.profile || 'auto')
    }
    const failures = []
    for (const dir of userDataDirCandidates()) {
      try {
        return await importDesktop(dir, this.binding.profile || 'auto')
      } catch (error) {
        failures.push(`${dir}: ${error.message}`)
      }
    }
    throw new Error(
      '没找到豆包工作客户端的登录数据。已经试过这些位置：\n' +
      failures.map((line) => `  ${line}`).join('\n') +
      '\n\n两个办法：\n' +
      '  1. 先打开豆包工作客户端登录一次，插件只读它的本地配置，客户端不登录就没有可读的东西。\n' +
      '  2. 如果装了但路径不在这几个里，自己找一下：在资源管理器地址栏输入 %LOCALAPPDATA% 回车，' +
      '找名字带 Doubao 的文件夹，进去看有没有 User Data，有的话把那个完整路径填到「数据目录」。',
    )
  }

  async initialize() {
    const local = await this.load()
    this.jar = Jar.from(local.cookies)
    this.profile = local.profile
    this.clientVersion = local.clientVersion
    this.clientInfo = local.clientInfo

    const identity = await this.json('/passport/account/info/v2/', undefined, undefined, {
      account_sdk_source: 'web', sdk_version: '2.2.5',
    })
    const uid = String(identity.user_id_str ?? identity.user_id ?? '')
    if (!uid || uid === '0' || identity.is_visitor_account) {
      throw new ProviderError('豆包工作的登录态已失效，请在客户端重新登录后重试。', 401, 'session_expired', { signIn: 'expired' })
    }
    if (this.binding.uid && this.binding.uid !== uid) {
      throw new ProviderError('豆包工作客户端已切换账号，请重新导入；绑定账号不会被静默替换。', 401, 'account_changed', { signIn: 'expired' })
    }
    const launch = await this.json('/alice/user/launch', {})
    const bot = String(launch.assistant_bot_id ?? '')
    // 用粘贴的 Cookie 登录时拿不到 bot_id，用约定的桌面端兜底值；
    // 装了客户端的话这里会是真值，两者都能被服务端接受。
    this.bot = /^[1-9]\d*$/.test(bot) ? bot : (this.binding.bot || FALLBACK_BOT)

    this.uid = uid
    this.launch = launch
    this.country = launch.country || ''
    this.name = identity.screen_name || identity.name || this.profile

    // 设备标识：粘贴 Cookie 时 clientInfo 字段是空的，而这些参数上游会校验。
    // launch 里带着服务端认可的值（在 config 下，不在顶层），用它补齐——比伪造稳定得多。
    //
    // web_id 和 device_id 用同一个值是对的：实测网页发出的 /chat/completion 里
    // device_id、web_id、tea_uuid 三项就是同一个数字。别的实现里有把两者分开的，
    // 那是客户端登录态的差异，不代表网页会话该分开。
    const launchWebId = String(launch.config?.web_id ?? launch.web_id ?? '')
    const launchTtwid = String(launch.config?.ttwid ?? launch.ttwid ?? '')
    if (/^[1-9]\d*$/.test(launchWebId)) {
      this.clientInfo ??= {}
      if (!this.clientInfo.webId) this.clientInfo.webId = launchWebId
      if (!this.clientInfo.deviceId) this.clientInfo.deviceId = launchWebId
      if (!this.clientInfo.teaUuid) this.clientInfo.teaUuid = launchWebId
    }
    if (launchTtwid) {
      this.clientInfo ??= {}
      this.clientInfo.ttwid = launchTtwid
    }

    this.readyAt = Date.now()
  }

  buildUrl(path, params = {}) {
    const url = new URL(path, BASE)
    if (url.origin !== BASE) throw new Error('请求主机不匹配。')
    const client = this.clientInfo
    url.search = new URLSearchParams({
      ...DESKTOP_PARAMS,
      ...(this.paramsOverride ?? {}),
      ...(this.clientVersion ? { pc_version: this.clientVersion, doubao_pc_version: this.clientVersion } : {}),
      ...(client ? {
        web_id: client.webId, device_id: client.deviceId, tea_uuid: client.teaUuid,
        // fp 用 Cookie 里真实的 s_v_web_id，拿不到就不发。
        // 之前这里拼的是 `verify_${deviceId}`，那是个假指纹——服务端给的指纹
        // 有自己的结构（verify_<id>_<随机串>），拼一个假的反而更像脚本。
        ...(client.fingerprint ? { fp: client.fingerprint } : {}),
        // ttwid 由 launch 下发，和 Cookie 里那份一致；不带它会少一个服务端认的身份。
        ...(client.ttwid ? { ttwid: client.ttwid } : {}),
        tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone,
      } : {}),
      ...(this.country ? { region: this.country, sys_region: this.country } : {}),
      ...params,
    }).toString()
    return url
  }

  async request(path, body, signal, params = {}, extraHeaders = {}) {
    const url = this.buildUrl(path, params)
    const timeout = AbortSignal.timeout(180_000)
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await this.fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: {
        'Content-Type': 'application/json',
        'Agw-Js-Conv': 'str',
        Origin: BASE,
        Referer: `${BASE}/`,
        'User-Agent': UA,
        Cookie: this.jar.headerFor(url.href),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const setCookies = response.headers.getSetCookie?.() ?? []
    if (setCookies.length) this.jar.absorb(url.href, setCookies)
    if (!response.ok) {
      const type = response.headers.get('content-type') || ''
      const payload = type.includes('json') ? await response.json().catch(() => ({})) : { message: (await response.text()).slice(0, 300) }
      const error = upstreamError(payload, response.status)
      // 签到那侧要按豆包自己的业务码分支，把原始码带出去
      error.upstreamCode = payload?.error?.code ?? payload?.error_code ?? payload?.code
      if (error.signIn) this.readyAt = 0
      throw error
    }
    return response
  }

  async json(path, body, signal, params) {
    const response = await this.request(path, body, signal, params)
    const text = await response.text()
    let result
    try { result = JSON.parse(text) }
    catch { throw new ProviderError(`豆包返回的不是 JSON：${text.slice(0, 200)}`, 502, 'invalid_response') }
    if ((result.code !== undefined && result.code !== 0) || (result.message === 'error')) {
      const payload = result.data?.error_code !== undefined ? result.data : result
      const error = upstreamError(payload)
      error.upstreamCode = payload?.error_code ?? payload?.code
      throw error
    }
    if (!result.data) throw new ProviderError('豆包响应缺少 data 字段。', 502, 'invalid_response')
    return result.data
  }

  /** 模型菜单（按账号缓存 60 秒；在线拿不到就用内置基线） */
  async models(signal, force = false) {
    await this.ready(signal)
    if (!force && this.catalog && Date.now() - this.catalogAt < 60_000) return this.catalog

    // 先试在线接口。真正带多模型的那份数据由网页 SSR loader 取，
    // 这个接口通常只返回 entry_list；落空后再取 /chat 的 HTML 解析 SSR。
    // 两者都失败才用基线。失败后 10 分钟内不再重试，避免每次都白打请求。
    if (!force && this.modelsFailedAt && Date.now() - this.modelsFailedAt < 600_000 && this.catalog) {
      return this.catalog
    }
    let catalog
    let source = 'live'
    try {
      const payload = await this.json('/alice/slot/action_bar_v3/brief_list', {
        language_code: 'zh',
        bot_id: this.bot,
      }, signal)
      catalog = parseModels(payload)
    } catch (error) {
      if (error?.signIn) throw error
    }
    let ssr
    try {
      const response = await this.request('/chat', undefined, signal, {}, { Accept: 'text/html' })
      ssr = parseSsrModels(await response.text())
      if (ssr) source = 'ssr'
    } catch (error) {
      if (error?.signIn) throw error
    }
    // SSR 那份按账号类型给：订阅账号能拿到 Qwen 那几档，飞书账号只有自动和 2.1 Lite
    // （飞书没有 office 的 model_list）。直接替换会让飞书账号的模型从 9 个掉到 2 个，
    // 所以和基线取并集，只增不减，谁的账号都不会变少。
    const baseline = fallbackModels()
    catalog = mergeCatalogs(catalog, ssr, baseline)
    if (catalog.size <= baseline.size) {
      // SSR 没带来新模型（飞书号、免费号都这样），对外仍算基线
      if (!catalog.size) this.modelsFailedAt = Date.now()
      source = ssr ? 'live' : 'baseline'
    }
    // 记下 SSR 给了几档，账号类型不同差得很多（实测订阅号 13 条、飞书号 3 条）。
    // 只用于诊断，不参与选模型。
    this.ssrSize = ssr?.size ?? 0
    this.catalogSource = source
    this.catalog = catalog
    this.catalogAt = Date.now()
    return catalog
  }
}

/** 按顺序合并几份模型表，先出现的优先，只增不减；全空返回 null */
function mergeCatalogs(...catalogs) {
  const merged = new Map()
  for (const one of catalogs) {
    if (!one) continue
    for (const [key, entry] of one) if (!merged.has(key)) merged.set(key, entry)
  }
  return merged.size ? merged : null
}
