/**
 * 从豆包工作桌面客户端的 Chromium 配置里读出登录 Cookie。
 *
 * Windows 上 Chromium 用两层：`Local State` 的 os_crypt.encrypted_key 由
 * DPAPI 保护，解出 32 字节 AES-256-GCM 主密钥；每条 Cookie 的
 * encrypted_value 是 `v10`/`v11` + 12 字节 nonce + 密文 + 16 字节 tag，
 * 明文前面还有一段 32 字节的 SHA-256(host) 前缀，得切掉。
 *
 * 新版 Chromium 改用 app-bound（`v20`）加密，密钥由系统服务按可执行文件
 * 绑定，普通进程解不开。遇到这种情况直接报清楚，不要去猜。
 */
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unprotect } from './dpapi.mjs'
import { readCookies } from './sqlite.mjs'

const DPAPI_PREFIX = Buffer.from('DPAPI', 'ascii')

/** Local State 里的主密钥 */
async function masterKey(userDataDir) {
  let state
  try {
    state = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8'))
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      throw new Error(
        `在 ${userDataDir} 找不到豆包工作的配置文件。` +
        '请确认已经安装并登录豆包工作客户端；如果装在别的位置，登录时把数据目录填成它自己的 User Data 路径。',
      )
    }
    throw new Error(`读取 ${join(userDataDir, 'Local State')} 失败：${cause.message}`)
  }
  const encoded = state?.os_crypt?.encrypted_key
  if (!encoded) throw new Error('Local State 里没有 os_crypt.encrypted_key。')
  const raw = Buffer.from(encoded, 'base64')
  if (!raw.subarray(0, 5).equals(DPAPI_PREFIX)) throw new Error('encrypted_key 不是 DPAPI 格式。')
  const key = await unprotect(raw.subarray(5))
  if (key.length !== 32) throw new Error(`主密钥长度异常：${key.length} 字节。`)
  return { key, state }
}

function decryptValue(key, encrypted, host) {
  if (!encrypted?.length) return ''
  const prefix = encrypted.subarray(0, 3).toString('ascii')
  if (prefix === 'v20') {
    throw new Error(
      '该配置的 Cookie 使用 app-bound 加密（v20），插件进程解不开。' +
      '请在豆包工作里退出登录再重新登录（会换回 v10），或改用扫码导入。',
    )
  }
  if (prefix !== 'v10' && prefix !== 'v11') {
    // 没有前缀说明是明文（老版本或 Linux 布局）
    return encrypted.toString('utf8')
  }
  const nonce = encrypted.subarray(3, 15)
  const payload = encrypted.subarray(15)
  if (payload.length < 17) return ''
  const tag = payload.subarray(payload.length - 16)
  const body = payload.subarray(0, payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  let plain = Buffer.concat([decipher.update(body), decipher.final()])
  // v10 的密文前面会带 32 字节 host 摘要。Chromium 用的是**数据库里原样的
  // host_key**（`.doubao.com` 带点），不是去掉点的那个。
  // 之前只试一种，摘要对不上时静默保留前缀，值就成了「32 字节二进制 + 明文」，
  // 表面上没报错，后面才表现为 Cookie 头非法，极难排查。这里两种都试。
  if (plain.length > 32) {
    const candidates = [host, host.replace(/^\./, ''), `.${host.replace(/^\./, '')}`]
    for (const candidate of candidates) {
      const digest = createHash('sha256').update(candidate).digest()
      if (plain.subarray(0, 32).equals(digest)) {
        plain = plain.subarray(32)
        break
      }
    }
  }
  return plain.toString('utf8')
}

/**
 * 找出该读哪个 profile 目录。
 *
 * 豆包工作客户端用的是标准 Chromium 多 profile 布局：登录态在
 * `User Data\Default` 或 `User Data\Profile N` 下面，具体是哪个由
 * `Local State` 的 `profile.last_used` 决定。用户在客户端里切过账号，
 * 就会多出一个 `Profile 2` 之类的目录。
 *
 * 注意 `User Data\aha\users\<hash>\` 那套目录**不是** Chromium profile，
 * 里面只有 cache 和客户端自己的数据，没有 Cookies 文件。早期版本按那个
 * 路径去找，必然落空。
 *
 * 所以：
 *  - 用户手填的 profile 名一律接受
 *  - auto 时以 `last_used` 为准（客户端自己记的当前账号），最后回落 Default
 */
function resolveProfile(state, wanted) {
  if (wanted && wanted !== 'auto') return wanted
  const last = state?.profile?.last_used
  if (typeof last === 'string' && last) return last
  return 'Default'
}

/**
 * 读一个配置的登录态。
 * @returns {{profile: string, cookies: Array, clientInfo: object, clientVersion: string}}
 */
export async function importDesktop(userDataDir, wantedProfile = 'auto') {
  const { key, state } = await masterKey(userDataDir)
  const profile = resolveProfile(state, wantedProfile)
  const profileDir = join(userDataDir, profile)

  // 客户端运行时锁着 Cookies，先复制一份再读。
  // Chromium 新版把 Cookies 放在 Network/ 子目录，老布局在 profile 根下，两处都试。
  const temp = await mkdtemp(join(tmpdir(), 'doubao-work-cookies-'))
  let rows
  try {
    const snapshot = join(temp, 'Cookies')
    let source
    for (const candidate of [join(profileDir, 'Network', 'Cookies'), join(profileDir, 'Cookies')]) {
      try {
        await copyFile(candidate, snapshot)
        source = candidate
        break
      } catch (error) {
        if (error.code === 'ENOENT') continue
        // EBUSY / EACCES：客户端正在运行，把 Cookies 锁住了。
        // 这是最常见的失败原因（issue #12「重新登录后读不到新账号」就是它）：
        // 用户刚在客户端里登录完，客户端还开着，文件拷不出来。
        // 退一步用直接读（SQLite 支持并发只读），再不行给出能照做的提示。
        if (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES') {
          try {
            const raw = await readFile(candidate)
            await writeFile(snapshot, raw)
            source = candidate
            break
          } catch {
            throw new Error(
              `读不到当前登录的账号：豆包工作正开着，它把 Cookies 文件锁住了。\n\n` +
              `这不是插件的问题——客户端激活的那个 profile，文件被系统独占，任何程序都读不到。\n\n` +
              `两个办法：\n` +
              `  1. 把豆包工作完全退出（任务栏右键 → 退出，或任务管理器结束进程），再试一次；\n` +
              `  2. 或者改用「粘贴豆包 Cookie」：浏览器里登录 doubao.com，从开发者工具复制 Cookie。\n\n` +
              `注意别选错账号：客户端里登录过多个账号时，旧 profile 的文件还能读，` +
              `但那是过期的那份，所以这里不会退而求其次去读旧的。`,
            )
          }
        }
        throw error
      }
    }
    if (!source) throw new Error(`配置 ${profile} 里没有 Cookies 文件，请确认豆包工作已登录。`)
    for (const suffix of ['-wal', '-shm']) {
      try { await copyFile(`${source}${suffix}`, `${snapshot}${suffix}`) } catch { /* 没有就算了 */ }
    }
    rows = (await readCookies(snapshot)).rows
  } finally {
    await rm(temp, { recursive: true, force: true })
  }

  const cookies = []
  for (const row of rows) {
    const domain = String(row.host || '')
    if (domain !== 'doubao.com' && !domain.endsWith('.doubao.com') && !domain.endsWith('bytedance.com')) continue
    let value = row.value || ''
    if (!value && row.encrypted?.length) {
      // Chromium 的 v10 前缀摘要用的是**数据库里原样的 host_key**（`.doubao.com` 带点）。
      // 之前这里去掉前导点再算，摘要对不上，前缀剥不掉，值会变成
      // 「32 字节二进制 + 明文」的垃圾串——而且**不报错**，后面才表现为
      // Cookie 头非法 / 校验失败，很难查。所以先按原样算，失败再试去点的。
      try {
        value = decryptValue(key, Buffer.from(row.encrypted), domain)
      } catch { /* 下面再试另一种 */ }
      if (!value) {
        try { value = decryptValue(key, Buffer.from(row.encrypted), domain.replace(/^\./, '')) }
        catch { /* 两种都不行就跳过这条 */ }
      }
    }
    if (!value) continue
    cookies.push({
      name: row.name,
      value,
      domain: domain.replace(/^\./, ''),
      path: row.path || '/',
      expires: row.expires || 0,
      secure: Boolean(row.secure),
      httpOnly: Boolean(row.httpOnly),
    })
  }
  if (!cookies.some((cookie) => (cookie.name === 'sessionid' || cookie.name === 'sessionid_ss') && cookie.value)) {
    throw new Error('该配置没有豆包登录会话，请先在豆包工作客户端登录。')
  }

  const clientInfo = await readClientIdentity(profileDir, state)
  return { profile, cookies, clientInfo, clientVersion: String(state?.doubao_version || state?.app_version || '') }
}

/**
 * 设备标识。
 *
 * 豆包要求三个数字 id 与客户端一致：device_id 在 Local State 的 aha.device，
 * web_id / user_unique_id 在对话页的 localStorage（__tea_cache_tokens_1044603）。
 * 这里直接扫 leveldb 目录里的 .log/.ldb 找那段 JSON，不引第三方解析库。
 */
async function readClientIdentity(profileDir, state) {
  const deviceId = String(state?.aha?.device?.device_id ?? '')
  const tokens = await findTeaCache(join(profileDir, 'Local Storage', 'leveldb'))
  const clientInfo = {
    deviceId,
    webId: tokens?.web_id != null ? String(tokens.web_id) : '',
    teaUuid: tokens?.user_unique_id != null ? String(tokens.user_unique_id) : '',
  }
  for (const [name, value] of Object.entries(clientInfo)) {
    if (!/^[1-9]\d*$/.test(value)) {
      throw new Error(`客户端标识 ${name} 缺失或无效（${value || '空'}）。请在豆包工作里打开一次对话页再重试。`)
    }
  }
  return clientInfo
}

async function findTeaCache(dir) {
  const { readdir } = await import('node:fs/promises')
  let names
  try { names = await readdir(dir) }
  catch { return undefined }
  let best
  for (const name of names) {
    if (!/\.(log|ldb)$/.test(name)) continue
    let raw
    try { raw = await readFile(join(dir, name)) }
    catch { continue }
    // leveldb 记录里 key/value 都带前缀，直接按 JSON 特征抓最后一个匹配
    const text = raw.toString('latin1')
    const pattern = /__tea_cache_tokens_1044603[\s\S]{0,80}?(\{"[^]*?\})(?=[^\x20-\x7e]|$)/g
    let match
    while ((match = pattern.exec(text))) {
      try {
        const parsed = JSON.parse(match[1])
        if (parsed && (parsed.web_id != null || parsed.user_unique_id != null)) best = parsed
      } catch { /* 落半截的记录跳过 */ }
    }
  }
  return best
}

/** 供测试：用给定密钥解一条 Cookie */
export const _internal = { decryptValue, resolveProfile, findTeaCache }
