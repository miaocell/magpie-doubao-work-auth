/**
 * 豆包工作（Doubao Work）的 magpie 供应商插件。
 *
 * 目标不是包一层客户端去替人点按钮，而是把豆包工作的订阅额度变成 magpie
 * 网关上的一组正常模型：登录一次，Claude Code / Codex / OpenCode / 任何走
 * OpenAI 兼容接口的 Agent 都能用，消耗的是这个账号的积分。
 *
 * 登录有三种方式，都不强制装客户端：
 *  - 粘贴 Cookie（最省事，多账号就多粘几次）
 *  - 从本机浏览器自动读（Chrome / Edge / WebView2）
 *  - 从豆包工作客户端读（装了才有）
 *
 * 导入后凭据存进插件自己的保管库（DPAPI 加密），此后与客户端完全解耦：
 * 客户端退出登录、切号、卸载都不影响已经导入的账号。
 *
 * 导出只有这一个函数——入口模块导出的每个函数都会被当成插件调用。
 */
import { buildProvider, buildModels, magpieModels } from './lib/models.mjs'
import { DesktopSession, FALLBACK_BOT } from './lib/session.mjs'
import { importDesktop } from './lib/desktop.mjs'
import { cookiesFromHeader, clientInfoFromCookies } from './lib/cookie-import.mjs'
import { cookiesFromDebugPort, launchDebugBrowser } from './lib/cdp.mjs'
import { saveAccount, loadAccount, listAccounts, removeAccount } from './lib/vault.mjs'
import { chat } from './lib/chat.mjs'
import { checkin as runCheckin, readCheckin, CAMPAIGN_SCENE } from './lib/checkin.mjs'
import { normalizeQuota } from './lib/quota.mjs'
import { ProviderError } from './lib/errors.mjs'
import { icon } from './lib/icon.mjs'

export const PROVIDER = 'doubao'

/** 校验一个凭据能不能用，顺便拿到 uid / 名字 / bot */
async function verify(session) {
  await session.ready()
  return {
    uid: session.uid,
    name: session.name,
    bot: session.bot,
    clientInfo: session.clientInfo,
    clientVersion: session.clientVersion,
  }
}

export default async function DoubaoPodPlugin(input = {}) {
  const log = (level, message) => {
    try { input?.client?.app?.log?.({ body: { service: 'doubao-work', level, message } }) } catch { /* 忽略 */ }
  }

  /** 账号 → 会话。按 uid 缓存，一个进程内复用 Cookie。 */
  const sessions = new Map()

  function bindingOf(auth) {
    if (auth?.type !== 'api' || typeof auth.key !== 'string') {
      throw Object.assign(new ProviderError('请先登录豆包工作账号。', 401, 'sign_in_required'), { signIn: 'expired' })
    }
    let binding
    try { binding = JSON.parse(auth.key) }
    catch { throw new ProviderError('保存的账号信息已损坏，请重新登录。', 401, 'invalid_binding', { signIn: 'expired' }) }
    if (!binding?.uid) throw new ProviderError('保存的账号缺少 uid，请重新登录。', 401, 'invalid_binding', { signIn: 'expired' })
    return binding
  }

  function sessionFor(auth) {
    const binding = bindingOf(auth)
    let session = sessions.get(binding.uid)
    if (!session) {
      // 没记 userDataDir 时不塞默认值，让 load() 自己去候选路径里找
      session = new DesktopSession({ ...binding })
      sessions.set(binding.uid, session)
    }
    return session
  }

  /** 保存账号并登记会话 */
  async function adopt(session, extra = {}) {
    const info = await verify(session)
    await saveAccount({
      uid: info.uid,
      name: info.name,
      bot: info.bot,
      clientInfo: info.clientInfo,
      clientVersion: info.clientVersion,
      cookies: session.jar ? [...session.jar.cookies.values()] : (session.cookieSnapshot || []),
      ...extra,
    })
    sessions.set(info.uid, session)
    return info
  }

  return {
    // ------------------------------------------------------------ 供应商与模型
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= buildProvider()
      cfg.provider[PROVIDER].models ??= buildModels()
    },

    // ---------------------------------------------------------------- 登录
    auth: {
      provider: PROVIDER,
      icon,
      maxConcurrency: 1,

      // 浏览器登录和从客户端读取依赖 lib/cdp.mjs、lib/desktop.mjs 里的
      // 浏览器 / 客户端路径，那些只覆盖 Windows 和 macOS。Linux 上留着这两个选项
      // 只会让人点进去失败，所以按平台过滤，只留粘贴 Cookie。
      methods: [
        // ① 粘贴 Cookie —— 不依赖任何客户端，多平台都能用
        {
          type: 'api',
          label: '粘贴豆包 Cookie',
          placeholder: 'sessionid=...; sessionid_ss=...',
          prompts: [{
            type: 'password',
            key: 'cookie',
            message: '豆包 Cookie（浏览器登录 doubao.com 后从开发者工具复制）',
            placeholder: 'sessionid=...; ttwid=...',
            validate: (value) => (value && /sessionid(_ss)?=/.test(value))
              ? undefined
              : 'Cookie 里必须有 sessionid 或 sessionid_ss。',
          }],

          async authorize(inputs, { signal } = {}) {
            let cookies
            try {
              cookies = cookiesFromHeader(inputs?.cookie ?? '')
            } catch (cause) {
              return { type: 'failed', error: String(cause.message).slice(0, 500) }
            }
            const clientInfo = clientInfoFromCookies(cookies)
            const session = new DesktopSession({
              profile: 'pasted',
              cookieSnapshot: cookies,
              clientInfo,
              bot: '',
            }, {
              importer: async () => ({ profile: 'pasted', cookies, clientInfo, clientVersion: '' }),
            })
            try {
              await session.ready(signal)
            } catch (cause) {
              return { type: 'failed', error: `Cookie 校验失败：${String(cause.message || cause).slice(0, 460)}` }
            }
            await adopt(session, { profile: 'pasted' })
            const binding = { version: 1, uid: session.uid, source: 'cookie', bot: session.bot }
            return {
              type: 'success',
              key: JSON.stringify(binding),
              accountId: String(session.uid),
              metadata: {
                email: session.name,
                uid: session.uid,
                source: 'cookie',
              },
            }
          },
        },

        // ① 开浏览器登录 —— 全自动：开窗口 → 你登录 → 直接抓 Cookie
        {
          type: 'api',
          keyless: true,
          label: '用浏览器登录豆包（自动抓取）',
          placeholder: '插件开一个窗口，你登录后自动完成',

          async authorize(_inputs, { signal } = {}) {
            let launched
            try {
              launched = await launchDebugBrowser()
            } catch (cause) {
              return { type: 'failed', error: String(cause.message || cause).slice(0, 480) }
            }

            // 等用户在窗口里登录：反复问调试端口，直到拿到 sessionid。
            // 无论成败都要关掉浏览器并清临时目录。
            //
            // 关于 abort（issue #19）：magpie 在请求超时 / 客户端重连 / 界面刷新时
            // 会 abort 这次 authorize，以前会立刻走 finally 关掉浏览器，
            // 表现就是「刚发验证码窗口就没了」。现在收到 abort 后不立刻关，
            // 先继续等一小会儿——用户很可能正卡在验证码那一步，直接掐掉体验很差。
            // 真正要收尾的时候（超时 / 取消 / 成功）还是照常关。
            let cookies
            let aborted = false
            try {
              const deadline = Date.now() + 5 * 60_000
              let abortGraceUntil = 0
              while (Date.now() < deadline) {
                if (signal?.aborted && !aborted) {
                  aborted = true
                  abortGraceUntil = Date.now() + 90_000 // 收到取消后再宽限 90 秒
                }
                if (aborted && Date.now() > abortGraceUntil) break

                try {
                  const found = await cookiesFromDebugPort('doubao.com', launched.port)
                  if (found.cookies?.length) { cookies = found.cookies; break }
                } catch { /* 还没登录，继续等 */ }
                await new Promise((resolve) => setTimeout(resolve, 2_000))
              }
            } finally {
              await launched.close()
            }

            if (!cookies?.length) {
              return {
                type: 'failed',
                error: aborted
                  ? `登录窗口已关闭。\n\n如果是不小心关掉的，重试一次就好；也可以改用「粘贴豆包 Cookie」，不用开浏览器更稳。`
                  : `等了 5 分钟没看到登录成功（${launched.name} 窗口已关闭）。\n\n如果刚才在输验证码，重试一次、中间别切走窗口；也可以改用「粘贴豆包 Cookie」。`,
              }
            }

            const clientInfo = clientInfoFromCookies(cookies)
            const session = new DesktopSession(
              { profile: 'browser-login', cookieSnapshot: cookies, clientInfo, bot: '' },
              { importer: async () => ({ profile: 'browser-login', cookies, clientInfo, clientVersion: '' }) },
            )
            try {
              await session.ready(signal)
            } catch (cause) {
              return { type: 'failed', error: `读到的 Cookie 校验失败：${String(cause.message || cause).slice(0, 420)}` }
            }
            await adopt(session, { profile: 'browser-login' })
            return {
              type: 'success',
              key: JSON.stringify({ version: 1, uid: session.uid, source: 'browser-login', bot: session.bot }),
              accountId: String(session.uid),
              metadata: {
                email: `${session.name} · ${launched.name} 登录`,
                uid: session.uid,
                source: 'browser-login',
              },
            }
          },
        },

        // ② 从豆包工作客户端读 —— 装了客户端才有的选项
        {
          type: 'api',
          keyless: true,
          label: '从豆包工作客户端读取（需已安装）',
          placeholder: '本机已登录的豆包工作账号',
          prompts: [{
            type: 'text',
            key: 'userDataDir',
            message: '豆包工作数据目录（留空会自动查找）',
            placeholder: '留空即可，插件会自动找',
            required: false,
          }, {
            type: 'text',
            key: 'profile',
            message: '桌面配置名称（auto 表示当前配置）',
            placeholder: 'auto',
            required: false,
            validate: (value) => (!value || /^(auto|Default|Profile \d+)$/.test(value))
              ? undefined
              : '请输入 auto、Default 或 Profile 加数字。',
          }],

          async authorize(inputs, { signal } = {}) {
            // 留空就别硬塞默认值，交给 load() 去逐个候选路径试
            const userDataDir = (inputs?.userDataDir || '').trim()
            const profile = (inputs?.profile || '').trim() || 'auto'
            const session = new DesktopSession({ profile, ...(userDataDir ? { userDataDir } : {}) })
            try {
              await session.ready(signal)
            } catch (cause) {
              return { type: 'failed', error: `${String(cause.message || cause).slice(0, 480)}` }
            }
            await adopt(session, { profile: session.profile, userDataDir })
            return {
              type: 'success',
              key: JSON.stringify({ version: 1, uid: session.uid, source: 'desktop', profile: session.profile, userDataDir, bot: session.bot }),
              accountId: String(session.uid),
              metadata: {
                email: `${session.name} · ${session.profile}`,
                uid: session.uid,
                profile: session.profile,
                source: 'desktop',
              },
            }
          },
        },
      // Linux 上浏览器 / 客户端导入走不通（lib/cdp.mjs、lib/desktop.mjs 只覆盖
      // Windows 和 macOS），只留粘贴 Cookie，免得点进去才失败。
      ].filter((method) => process.platform !== 'linux' || !method.keyless),

      async loader(getAuth) {
        return {
          baseURL: 'https://www.doubao.com/v1',
          apiKey: 'doubao-work-local-session',
          async fetch(input_, init) {
            return chat(sessionFor(await getAuth()), input_, init)
          },
        }
      },

      // ------------------------------------------------------------ 额度
      async usage(getAuth) {
        const session = sessionFor(await getAuth())
        try {
          await session.ready()
        } catch (error) {
          return { error: String(error?.message || error).slice(0, 300), windows: [], ...(error?.signIn ? { signIn: error.signIn } : {}) }
        }

        // 两个接口分别取：任一瞬时失败不该让整块额度变成「暂时无法获取」
        const settle = async (path, body) => {
          for (let attempt = 0; attempt < 2; attempt++) {
            try { return await session.json(path, body) }
            catch (error) {
              if (error?.signIn) throw error
              if (attempt === 1) return undefined
              await new Promise((resolve) => setTimeout(resolve, 400))
            }
          }
          return undefined
        }

        try {
          const summary = await settle('/alice/commerce/sale/subscription/quota/summary/', { product_line: 'membership' })
          if (!summary) {
            return { error: '额度汇总暂时取不到，稍后会自动重试', windows: [] }
          }
          // overview 只提供套餐名，拿不到就用 summary 里的订阅信息兜底
          const overview = await settle('/alice/commerce/sale/subscription/overview/', { product_line: 'membership' })
          // 活动赠送卡不在 overview 里，得单独问一次（官方额度页自己也调这个只读接口）。
          // 免费体验账号唯一有额度的地方往往就是这里，不读的话界面只能显示「暂无额度」。
          const cards = await settle('/alice/commerce/marketing/card/list/', {
            status_in: [1, 2, 3, 4],
            with_limit_status: true,
          })
          // 签到状态一并带上：额度卡片上直接能看到今天签没签。
          // 缓存 10 分钟——签到的变化周期是按天的，没必要每次刷额度都去打一次上游。
          let checkin = session.checkinCache
          if (!checkin || Date.now() - (session.checkinAt ?? 0) > 600_000) {
            try {
              checkin = readCheckin(await session.json('/alice/ug/campaign/v3/detail/', { campaign_group_code: CAMPAIGN_SCENE }))
              session.checkinCache = checkin
              session.checkinAt = Date.now()
            } catch { /* 签到状态取不到不影响额度 */ }
          }
          return normalizeQuota(overview ?? {}, summary, session.name, checkin, cards)
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error
          return { error: error.message, windows: [], ...(error.signIn ? { signIn: error.signIn } : {}) }
        }
      },

      // ------------------------------------------------------------ 每日签到
      async checkin(getAuth) {
        return runCheckin(sessionFor(await getAuth()))
      },
    },

    // ------------------------------------------------------- 每个账号的模型
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models
        try {
          const catalog = await sessionFor(auth).models(undefined, true)
          return magpieModels(catalog, PROVIDER)
        } catch (error) {
          log('warn', `获取豆包工作模型失败：${error?.message}`)
          if (error?.signIn) throw error
          return provider.models
        }
      },
    },
  }
}

export const _internal = { PROVIDER, FALLBACK_BOT, listAccounts, loadAccount, removeAccount }
