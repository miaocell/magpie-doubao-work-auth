/**
 * 通过浏览器远程调试端口读豆包 Cookie。
 *
 * 为什么要走这条路：浏览器运行时会用独占锁占住 Cookies 数据库，任何文件级
 * 复制（copyFile / 流式读 / esentutl / robocopy 备份模式）都会 EBUSY。VSS
 * 快照能做，但要管理员权限。而浏览器自己开着调试端口时，可以直接问它要
 * Cookie——不用碰文件，也没有锁的问题。
 *
 * 只需浏览器带 --remote-debugging-port 启动。插件不主动改用户的浏览器配置，
 * 只在端口已经可用时使用。
 */
const DEFAULT_PORTS = [9222, 9223, 9224, 9225]

/** 试探哪些端口在跑调试服务 */
export async function findDebugPorts(ports = DEFAULT_PORTS) {
  const found = []
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_200),
      })
      if (!response.ok) continue
      const info = await response.json()
      if (info?.webSocketDebuggerUrl) found.push({ port, info })
    } catch { /* 这个端口没开 */ }
  }
  return found
}

/** 极简 CDP 会话：只用到 Network.getCookies 这一条 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    let nextId = 1

    const timer = setTimeout(() => {
      try { socket.close() } catch { /* ignore */ }
      reject(new Error('连浏览器调试端口超时。'))
    }, 8_000)

    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send(method, params) {
          const id = nextId++
          return new Promise((resolveCall, rejectCall) => {
            pending.set(id, { resolve: resolveCall, reject: rejectCall })
            socket.send(JSON.stringify({ id, method, params }))
            setTimeout(() => {
              if (!pending.has(id)) return
              pending.delete(id)
              rejectCall(new Error(`${method} 超时。`))
            }, 10_000)
          })
        },
        close() { try { socket.close() } catch { /* ignore */ } },
      })
    })

    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      const slot = message.id ? pending.get(message.id) : undefined
      if (!slot) return
      pending.delete(message.id)
      if (message.error) slot.reject(new Error(message.error.message || 'CDP 调用失败。'))
      else slot.resolve(message.result)
    })

    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('连不上浏览器调试端口。'))
    })
  })
}

/** 用调试端口读一个站点的 Cookie */
export async function readViaDebugPort(debugUrl, domain = 'doubao.com', httpBase) {
  // Network.getCookies 是页面级命令，必须先挂到一个 page target 上
  let pageUrl = debugUrl
  if (httpBase) {
    try {
      const list = await fetch(`${httpBase}/json/list`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.json())
      const page = Array.isArray(list) ? list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : undefined
      if (page) pageUrl = page.webSocketDebuggerUrl
    } catch { /* 用浏览器级连接兜底 */ }
  }

  const session = await connect(pageUrl)
  try {
    const result = await session.send('Network.getCookies', { urls: [`https://${domain}/`, `https://www.${domain}/`] })
    const list = Array.isArray(result?.cookies) ? result.cookies : []
    if (!list.length) throw new Error(`浏览器里没有 ${domain} 的 Cookie，请先在该浏览器登录豆包。`)
    const cookies = list.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: String(cookie.domain || domain).replace(/^\./, ''),
      path: cookie.path || '/',
      expires: Math.floor(Number(cookie.expires) || 0),
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
    }))
    if (!cookies.some((c) => (c.name === 'sessionid' || c.name === 'sessionid_ss') && c.value)) {
      throw new Error(`这个浏览器里没有登录豆包（找不到 sessionid）。`)
    }
    return cookies
  } finally {
    session.close()
  }
}

/** 一步到位：找端口 → 读 Cookie。给了 port 就只试那一个 */
export async function cookiesFromDebugPort(domain = 'doubao.com', port) {
  const targets = await findDebugPorts(port ? [port] : DEFAULT_PORTS)
  if (!targets.length) {
    throw new Error(
      '没找到开着调试端口的浏览器。可以先用「用浏览器登录豆包」这个方式——插件会自动开一个窗口。',
    )
  }
  const errors = []
  for (const target of targets) {
    try {
      const cookies = await readViaDebugPort(
        target.info.webSocketDebuggerUrl,
        domain,
        `http://127.0.0.1:${target.port}`,
      )
      return { cookies, port: target.port, browser: target.info.Browser || '' }
    } catch (error) {
      errors.push(`端口 ${target.port}: ${String(error.message || error).slice(0, 100)}`)
    }
  }
  throw new Error(errors.join('；') || '调试端口读不到豆包 Cookie。')
}

/** 各平台浏览器的可执行文件候选 */
export function browserCandidates() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || ''
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files'
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    return [
      { name: 'Edge', path: `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { name: 'Edge', path: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { name: 'Chrome', path: `${pf}\\Google\\Chrome\\Application\\chrome.exe` },
      { name: 'Chrome', path: `${pf86}\\Google\\Chrome\\Application\\chrome.exe` },
      { name: 'Chrome', path: `${local}\\Google\\Chrome\\Application\\chrome.exe` },
    ]
  }
  if (process.platform === 'darwin') {
    return [
      { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    ]
  }
  return [
    { name: 'Chrome', path: '/usr/bin/google-chrome' },
    { name: 'Chromium', path: '/usr/bin/chromium' },
    { name: 'Edge', path: '/usr/bin/microsoft-edge' },
  ]
}

/**
 * 挑一个空闲端口。
 *
 * 为什么不用 port=0 让浏览器自己分配：Windows 上的 Chrome / Edge 不把
 * 「DevTools listening on ...」打到 stderr，读不到实际端口。
 * 所以自己先占一个空闲端口探出来再释放，交给浏览器用。
 */
async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * 开一个带调试端口的浏览器窗口，让用户在里面登录豆包。
 *
 * 几个刻意的选择：
 *  - **随机端口**：固定 9222 会和用户机器上其他工具撞车，而且那是一个任何人都能
 *    连上来读 Cookie 的入口。每次现挑一个空闲端口，用完随窗口一起消失。
 *  - **临时目录**：每次登录用一个全新的临时 profile，登录完就删。不持久保存
 *    浏览器登录态——Cookie 已经存进保管库了，留着这个目录只是多一份风险。
 *  - **只监听本机**：加 --remote-debugging-address=127.0.0.1，不暴露到局域网。
 *  - **用完即关**：登录成功或失败都会杀掉这个浏览器进程，不留后台窗口。
 *
 * @returns {{ name: string, port: number, pid?: number, close: () => Promise<void> }}
 */
export async function launchDebugBrowser({ port, profileDir, url = 'https://www.doubao.com/chat/' } = {}) {
  const { existsSync, mkdirSync, rmSync } = await import('node:fs')
  const { spawn } = await import('node:child_process')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomBytes } = await import('node:crypto')

  const browser = browserCandidates().find((candidate) => {
    try { return existsSync(candidate.path) } catch { return false }
  })
  if (!browser) throw new Error('没找到 Chrome 或 Edge，请先装一个，或改用「粘贴豆包 Cookie」。')

  const actual = port ?? await freePort()
  // 每次一个独立临时目录，带随机后缀，避免和上一次的残留撞上
  const dir = profileDir || join(tmpdir(), `doubao-login-${randomBytes(6).toString('hex')}`)
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* 已存在 */ }

  const child = spawn(browser.path, [
    `--remote-debugging-port=${actual}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    url,
  ], { detached: false, stdio: 'ignore' })

  /** 关掉浏览器并清掉临时目录 */
  const close = async () => {
    try { child.kill() } catch { /* 已退出 */ }
    await new Promise((resolve) => setTimeout(resolve, 600))
    try { child.kill('SIGKILL') } catch { /* 已退出 */ }
    for (let i = 0; i < 8; i++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        // Windows 上进程刚退时文件可能还被占着，等一会儿再删
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
    }
  }

  // 等调试端点真正可用
  for (let i = 0; i < 40; i++) {
    const targets = await findDebugPorts([actual])
    if (targets.length) return { name: browser.name, port: actual, pid: child.pid, close }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  await close()
  throw new Error(`${browser.name} 已启动但调试端口 ${actual} 没响应。`)
}

