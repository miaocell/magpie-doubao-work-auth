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
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  // v10 且是老版 Chromium 时没有 host 前缀，靠首字节是否为可打印字符兜一下
  if (plain.length > 32) {
    const digest = createHash('sha256').update(host).digest()
    if (plain.subarray(0, 32).equals(digest)) plain = plain.subarray(32)
  }
  return plain.toString('utf8')
}

/** 当前应该读哪个 Profile */
function resolveProfile(state, wanted) {
  if (wanted && wanted !== 'auto') {
    if (!/^(Default|Profile \d+)$/.test(wanted)) throw new Error('配置名称必须为 auto、Default 或 Profile 加数字。')
    return wanted
  }
  const last = state?.profile?.last_used
  if (typeof last === 'string' && /^(Default|Profile \d+)$/.test(last)) return last
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
      } catch (error) { if (error.code !== 'ENOENT') throw error }
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
    if (!value && row.encrypted?.length) value = decryptValue(key, Buffer.from(row.encrypted), domain.replace(/^\./, ''))
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
