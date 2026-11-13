/**
 * Cookie 解析与导入。
 *
 * 两条路：
 *  1. 直接粘贴 Cookie 字符串（最省事，多账号就多粘几次）
 *  2. 插件开一个临时浏览器窗口，你登录后通过调试端口读取（见 cdp.mjs）
 *
 * 不走「读本机浏览器 Cookies 数据库」那条：浏览器运行时用独占锁占住那个文件，
 * copyFile / 流式读 / esentutl / robocopy 备份模式全部 EBUSY，VSS 快照要管理员
 * 权限。硬撑着做只会给用户一个永远失败的选项。
 */

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

/** 从 Cookie 里推断设备标识：豆包接受 s_v_web_id / web_id 等作为指纹来源 */
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
