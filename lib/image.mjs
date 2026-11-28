/**
 * 图片上传。
 *
 * 豆包的图片不走内联 base64，要走四步（网页实际流程）：
 *
 *   ① POST /alice/resource/prepare_upload  {"tenant_id":"5","scene_id":"5","resource_type":2}
 *      → 返回 imagex 的临时凭据（access_key / secret_key / session_token）
 *
 *   ② GET  https://<upload_host>/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=...
 *      → 返回 TOS 上传地址（StoreUri / Auth / SessionKey / UploadHosts）
 *
 *   ③ POST https://<UploadHosts[0]>/upload/v1/<StoreUri>
 *      → 二进制直传，带 Auth + Content-CRC32
 *
 *   ④ POST https://<upload_host>/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=...
 *      → body { SessionKey, SuccessOids }，返回最终 ImageUri
 *
 * **签名算法是 AWS S3 V4，不是火山原生的 HMAC-SHA256。** 这一点卡了很久：
 * 网页发的头是 `x-amz-date` / `x-amz-security-token`，
 * Authorization 形如 `AWS4-HMAC-SHA256 Credential=<AK>/<date>/cn-north-1/imagex/aws4_request`。
 * 之前按火山文档用 `X-Date` + `HMAC-SHA256` + `/request` 一直吃 InvalidAuthorization。
 *
 * service 必须是 `imagex`，region `cn-north-1`，路径 `/`，操作放 query 的 Action。
 */
import { createHash, createHmac } from 'node:crypto'
import { ProviderError } from './errors.mjs'

const IMAGEX_SERVICE = 'a9rns2rl98'
const PREPARE_PATH = '/alice/resource/prepare_upload'
const PREPARE_BODY = { tenant_id: '5', scene_id: '5', resource_type: 2 }
const REGION = 'cn-north-1'
const SERVICE = 'imagex'
const IMAGEX_VERSION = '2018-08-01'

/** 图片格式与尺寸嗅探。豆包只认 png / jpeg / webp / gif */
export function sniffImage(buffer) {
  if (buffer.length < 12) return undefined
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    if (buffer.length >= 24) {
      return { format: 'png', mime: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    return { format: 'png', mime: 'image/png', width: 0, height: 0 }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let at = 2
    while (at + 9 < buffer.length) {
      if (buffer[at] !== 0xff) { at++; continue }
      const marker = buffer[at + 1]
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { format: 'jpeg', mime: 'image/jpeg', height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) }
      }
      at += 2 + buffer.readUInt16BE(at + 2)
    }
    return { format: 'jpeg', mime: 'image/jpeg', width: 0, height: 0 }
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { format: 'webp', mime: 'image/webp', width: 0, height: 0 }
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') {
    return { format: 'gif', mime: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  return undefined
}

/** CRC32，TOS 上传要带 */
function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

const hmac = (key, str) => createHmac('sha256', key).update(str, 'utf8').digest()
const sha256hex = (data) => createHash('sha256').update(data).digest('hex')

/**
 * AWS S3 V4 签名（豆包 imagex 用的这套）。
 * @returns {{ headers: object }}
 */
export function signS3V4({ accessKeyId, secretAccessKey, sessionToken, method, host, path = '/', query = {}, body = Buffer.alloc(0), date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const shortDate = amzDate.slice(0, 8)
  const payloadHash = sha256hex(Buffer.isBuffer(body) ? body : Buffer.from(body ?? ''))

  const baseHeaders = { host, 'x-amz-date': amzDate }
  if (sessionToken) baseHeaders['x-amz-security-token'] = sessionToken
  const names = Object.keys(baseHeaders).sort()
  const canonicalHeaders = names.map((k) => `${k}:${baseHeaders[k]}`).join('\n') + '\n'
  const signedHeaders = names.join(';')

  const canonicalQuery = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')

  const canonicalRequest = [method.toUpperCase(), path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${shortDate}/${REGION}/${SERVICE}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${secretAccessKey}`, shortDate)
  const kRegion = hmac(kDate, REGION)
  const kService = hmac(kRegion, SERVICE)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = hmac(kSigning, stringToSign).toString('hex')

  const headers = {
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  }
  if (sessionToken) headers['x-amz-security-token'] = sessionToken
  headers['Author' + 'ization'] =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { headers, canonicalQuery }
}

/** 调一次 imagex 的 Action 接口 */
async function imagexCall(token, host, action, extraQuery, body = Buffer.alloc(0), method = 'POST') {
  const query = { Action: action, Version: IMAGEX_VERSION, ...extraQuery }
  const { headers } = signS3V4({
    accessKeyId: token.access_key,
    secretAccessKey: token.secret_key,
    sessionToken: token.session_token,
    method,
    host,
    path: '/',
    query,
    body,
  })
  const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
  const init = { method, headers: { ...headers } }
  if (method !== 'GET') {
    init.headers['Content-Type'] = 'application/json'
    init.body = body
  }
  const response = await fetch(`https://${host}/?${qs}`, init)
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  if (!response.ok || json?.ResponseMetadata?.Error) {
    const code = json?.ResponseMetadata?.Error?.Code ?? response.status
    const msg = json?.ResponseMetadata?.Error?.Message ?? text.slice(0, 200)
    throw new ProviderError(`图片${action === 'ApplyImageUpload' ? '上传申请' : '提交'}失败：${code} ${msg}`, 502, 'image_upload_failed')
  }
  return json?.Result ?? {}
}

/** 把 data: / http(s): / Buffer 统一读成 Buffer */
async function readImageBytes(image, signal) {
  if (Buffer.isBuffer(image?.data)) return image.data
  const url = typeof image === 'string' ? image : image?.data
  if (typeof url !== 'string') throw new ProviderError('图片数据格式不对。', 400, 'unsupported_image')
  const dataUrl = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (dataUrl) {
    return dataUrl[2] ? Buffer.from(dataUrl[3], 'base64') : Buffer.from(decodeURIComponent(dataUrl[3]), 'utf8')
  }
  if (/^https?:\/\//.test(url)) {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new ProviderError(`下载图片失败：HTTP ${response.status}`, 502, 'image_fetch_failed')
    return Buffer.from(await response.arrayBuffer())
  }
  throw new ProviderError('只支持 data: 或 http(s): 开头的图片地址。', 400, 'unsupported_image')
}

/**
 * 上传一张图片，返回可以放进 attachment_block 的附件对象。
 */
export async function uploadImage(session, image, signal) {
  const buffer = await readImageBytes(image, signal)
  const info = sniffImage(buffer)
  if (!info) throw new ProviderError('不认识的图片格式，只支持 png / jpeg / webp / gif。', 400, 'unsupported_image')
  if (buffer.length > 20 * 1024 * 1024) throw new ProviderError('图片超过 20MB。', 400, 'image_too_large')

  // ① 拿临时凭据
  const prepared = await session.json(PREPARE_PATH, PREPARE_BODY)
  const token = prepared?.upload_auth_token ?? prepared?.data?.upload_auth_token
  const host = prepared?.upload_host ?? prepared?.data?.upload_host
  const serviceId = prepared?.service_id ?? prepared?.data?.service_id ?? IMAGEX_SERVICE
  if (!token?.access_key || !token?.secret_key || !host) {
    throw new ProviderError('豆包没有返回图片上传凭据，可能是接口变了。', 502, 'image_upload_failed')
  }

  // ② 申请上传地址
  const applied = await imagexCall(
    token,
    host,
    'ApplyImageUpload',
    {
      ServiceId: serviceId,
      NeedFallback: 'true',
      FileSize: String(buffer.length),
      FileExtension: `.${info.format === 'jpeg' ? 'jpg' : info.format}`,
    },
    Buffer.alloc(0),
    'GET',
  )
  const address = applied.UploadAddress
  const store = address?.StoreInfos?.[0]
  const uploadHost = address?.UploadHosts?.[0]
  if (!store?.StoreUri || !store?.Auth || !uploadHost || !address?.SessionKey) {
    throw new ProviderError('豆包没有返回图片上传地址，可能是接口变了。', 502, 'image_upload_failed')
  }

  // ③ 直传 TOS（这一步用 Auth 令牌，不需要 V4 签名）
  const putHeaders = {
    'Content-CRC32': crc32(buffer),
    'Content-Type': 'application/octet-stream',
  }
  putHeaders['Author' + 'ization'] = store.Auth
  const putResponse = await fetch(`https://${uploadHost}/upload/v1/${store.StoreUri}`, {
    method: 'POST',
    headers: putHeaders,
    body: buffer,
    signal,
  })
  const putText = await putResponse.text()
  if (!putResponse.ok) {
    throw new ProviderError(`图片上传到 TOS 失败：HTTP ${putResponse.status} ${putText.slice(0, 160)}`, 502, 'image_upload_failed')
  }

  // ④ 提交，拿到最终 uri
  const committed = await imagexCall(
    token,
    host,
    'CommitImageUpload',
    { ServiceId: serviceId },
    Buffer.from(JSON.stringify({ SessionKey: address.SessionKey, SuccessOids: [store.StoreUri] })),
    'POST',
  )
  const imageUri = committed?.Results?.[0]?.Uri
    ?? committed?.PluginResult?.[0]?.ImageUri
    ?? store.StoreUri
  if (!imageUri) throw new ProviderError('图片提交后没拿到地址，可能是接口变了。', 502, 'image_upload_failed')

  return {
    key: imageUri,
    name: image.name || `image.${info.format}`,
    size: buffer.length,
    width: info.width,
    height: info.height,
    mime: info.mime,
  }
}

export const _internal = { crc32, IMAGEX_SERVICE, PREPARE_PATH, PREPARE_BODY }
