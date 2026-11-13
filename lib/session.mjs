/**
 * 豆包工作桌面会话。
 *
 * 关键事实：这套接口是给客户端自己用的，请求要靠四个东西才被认成「桌面端」——
 * 登录 Cookie、桌面端的查询参数（aid=1044603、channel、web_platform 等）、
 * 设备标识（device_id / web_id / tea_uuid），以及启动接口下发的 bot_id。
 * 少任何一个，服务端要么判 login invalid，要么报 common invalid param。
 */
import { ProviderError, upstreamError } from './errors.mjs'
import { parseModels, fallbackModels } from './models.mjs'
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

/** 没有客户端时用的 bot_id 兜底值（豆包工作桌面端的默认助手） */
export const FALLBACK_BOT = '7338286299411103781'

/** 豆包工作客户端的默认数据目录 */
export function defaultUserDataDir() {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'DoubaoWork', 'User Data')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'DoubaoWork')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'DoubaoWork')
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
    return importDesktop(this.binding.userDataDir || defaultUserDataDir(), this.binding.profile || 'auto')
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
        fp: `verify_${client.deviceId}`,
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

    // 先试在线刷新。真正带多模型的那份数据由网页 SSR loader 取，
    // 前端没有可直接调的接口，所以这里基本会落空——落空就用基线。
    // 失败后 10 分钟内不再重试，避免每次都白打一个请求。
    if (!force && this.modelsFailedAt && Date.now() - this.modelsFailedAt < 600_000 && this.catalog) {
      return this.catalog
    }
    let catalog
    try {
      const payload = await this.json('/alice/slot/action_bar_v3/brief_list', {
        language_code: 'zh',
        bot_id: this.bot,
      }, signal)
      catalog = parseModels(payload)
    } catch (error) {
      if (error?.signIn) throw error
      this.modelsFailedAt = Date.now()
    }
    if (!catalog) {
      catalog = fallbackModels()
      this.catalogSource = 'baseline'
    } else {
      this.catalogSource = 'live'
    }
    this.catalog = catalog
    this.catalogAt = Date.now()
    return catalog
  }
}
