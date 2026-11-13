/**
 * Cookie 导入。
 *
 * 三条路，都不强制装客户端：
 *  1. 直接粘贴 Cookie 字符串（最省事，多账号就多粘几次，账号之间互不影响）
 *  2. 从本机浏览器自动读（Chrome / Edge / WebView2 的 Cookies 库，DPAPI 解密）
 *  3. 从豆包工作客户端读（装了才有，退出登录后也能用保管库里的副本）
 */
import { readCookies } from './sqlite.mjs'
import { unprotect } from './dpapi.mjs'
import { createHash, createDecipheriv } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 把 "a=1; b=2" 或 "Cookie: a=1; b=2" 解析成对象 */
export function parseCookieHeader(text) {
  const out = {}
  const body = String(text || '').replace(/^\s*cookie\s*:\s*/i, '')
  for (const part of body.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!name) continue
    out[name] = value
  }
  return out
}

/** 粘贴的 Cookie → 插件内部格式。缺关键项直接报清楚。 */
export function cookiesFromHeader(text, { domain = 'doubao.com' } = {}) {
  const parsed = parseCookieHeader(text)
  if (!parsed.sessionid && !parsed.sessionid_ss) {
    throw new Error('Cookie 里没有 sessionid 或 sessionid_ss。请在豆包网页登录后，从开发者工具复制完整 Cookie。')
  }
  return Object.entries(parsed).map(([name, value]) => ({
    name, value, domain, path: '/', expires: 0, secure: true, httpOnly: false,
  }))
}

/** 从 Cookie 或环境里推断设备标识：豆包接受 s_v_web_id / web_id 等作为指纹来源 */
export function clientInfoFromCookies(cookies) {
  const map = Object.fromEntries(cookies.map((c) => [c.name, c.value]))
  const pick = (...names) => {
    for (const name of names) {
      const value = map[name]
      if (value && /^[1-9]\d*$/.test(value)) return value
    }
    return ''
  }
  const deviceId = pick('device_id', 'deviceid', 's_v_web_id_number')
  const webId = pick('web_id', 'webid')
  const teaUuid = pick('tea_uuid', 'user_unique_id', 'uuid')
  // 这三个都可以缺：缺了就用 Cookie 里能拿到的指纹字段兜底
  return {
    deviceId: deviceId || '',
    webId: webId || deviceId || '',
    teaUuid: teaUuid || deviceId || '',
    fingerprint: map.s_v_web_id || map.fp || '',
    raw: {
      web_id: map.web_id,
      device_id: map.device_id,
      tea_uuid: map.tea_uuid,
      s_v_web_id: map.s_v_web_id,
    },
  }
}

/** 浏览器里所有装了豆包 Cookie 的库。
 *
 * 注意：浏览器运行时会独占 Cookies 文件（EBUSY），所以这里只用 stat 判断
 * 文件是否存在——用 readFile 试探会把「存在但被锁」误判成「不存在」。
 */
export async function browserCookieSources() {
  const { homedir } = await import('node:os')
  const { stat } = await import('node:fs/promises')
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const roots = [
    join(local, 'Microsoft', 'Edge', 'User Data'),
    join(local, 'Google', 'Chrome', 'User Data'),
    join(local, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    join(local, '360ChromeX', 'Chrome', 'User Data'),
  ]
  const sources = []
  for (const root of roots) {
    let profiles
    try { profiles = await readdir(root) }
    catch { continue }
    for (const profile of profiles) {
      if (profile !== 'Default' && !/^Profile \d+$/.test(profile)) continue
      for (const candidate of [join(root, profile, 'Network', 'Cookies'), join(root, profile, 'Cookies')]) {
        try {
          await stat(candidate)
          sources.push({ root, profile, file: candidate })
          break
        } catch { /* 没有这个文件 */ }
      }
    }
  }
  return sources
}

/** 解一个浏览器配置里的 doubao.com Cookie */
export async function readBrowserCookies(source) {
  const state = JSON.parse(await readFile(join(source.root, 'Local State'), 'utf8'))
  const encoded = state?.os_crypt?.encrypted_key
  if (!encoded) throw new Error('浏览器 Local State 里没有 os_crypt.encrypted_key。')
  const raw = Buffer.from(encoded, 'base64')
  const prefix = raw.subarray(0, 5).toString('ascii')
  if (prefix !== 'DPAPI') throw new Error('浏览器主密钥不是 DPAPI 格式。')
  const key = await unprotect(raw.subarray(5))

  const temp = await mkdtemp(join(tmpdir(), 'doubao-browser-'))
  let rows
  try {
    const snapshot = join(temp, 'Cookies')
    try {
      await copyFile(source.file, snapshot)
    } catch (error) {
      if (error.code === 'EBUSY' || error.code === 'EPERM') {
        throw new Error(
          `浏览器正在运行，独占锁住了 ${source.file}。请完全退出该浏览器后重试，` +
          '或改用「粘贴豆包 Cookie」——从浏览器开发者工具复制，不需要退出浏览器。',
        )
      }
      throw error
    }
    rows = (await readCookies(snapshot)).rows
  } finally {
    await rm(temp, { recursive: true, force: true })
  }

  const out = []
  for (const row of rows) {
    const host = String(row.host || '')
    if (host !== 'doubao.com' && !host.endsWith('.doubao.com')) continue
    let value = row.value || ''
    if (!value && row.encrypted?.length) {
      try { value = decrypt(key, row.encrypted, host.replace(/^\./, '')) }
      catch { continue }
    }
    if (!value) continue
    out.push({
      name: row.name, value, domain: host.replace(/^\./, ''), path: row.path || '/',
      expires: row.expires || 0, secure: Boolean(row.secure), httpOnly: Boolean(row.httpOnly),
    })
  }
  if (!out.some((c) => (c.name === 'sessionid' || c.name === 'sessionid_ss') && c.value)) {
    throw new Error('这个浏览器配置里没有登录豆包。')
  }
  return out
}

function decrypt(key, encrypted, host) {
  const prefix = encrypted.subarray(0, 3).toString('ascii')
  if (prefix === 'v20') throw new Error('Cookie 使用 app-bound 加密，插件解不开。')
  if (prefix !== 'v10' && prefix !== 'v11') return encrypted.toString('utf8')
  const nonce = encrypted.subarray(3, 15)
  const payload = encrypted.subarray(15)
  if (payload.length < 17) return ''
  const tag = payload.subarray(payload.length - 16)
  const body = payload.subarray(0, payload.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  let plain = Buffer.concat([decipher.update(body), decipher.final()])
  if (plain.length > 32) {
    const digest = createHash('sha256').update(host).digest()
    if (plain.subarray(0, 32).equals(digest)) plain = plain.subarray(32)
  }
  return plain.toString('utf8')
}

export const _internal = { decrypt }
