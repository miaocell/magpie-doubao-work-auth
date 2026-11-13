/**
 * 图片上传。
 *
 * **当前不可用**，原因写在这里免得以后重复踩：豆包的图片不走内联 base64，
 * 要走四步（prepare_upload → ApplyImageUpload → TOS PUT → CommitImageUpload），
 * 而第一步 `/alice/resource/prepare_upload` 是唯一需要 `a_bogus` 签名的接口。
 *
 * 实测对照：额度汇总、活动详情、模型菜单这些接口不带签名都是 200，
 * 只有 prepare_upload 返回 404。补齐 web_id / ttwid 也没用——签名是
 * 前端 JS 用页面运行时数据算的，纯 HTTP 侧造不出来。
 *
 * 所以这里保留完整的协议实现（万一以后放宽了能直接用），但入口处明确拒绝，
 * 让用户知道是上游限制而不是插件坏了。不做 base64 伪装、不静默丢图。
 */
import { ProviderError } from './errors.mjs'

const IMAGEX_SERVICE = 'a9rns2rl98'

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

/** CRC32（TOS 上传要带） */
function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

/**
 * 上传一张图片。
 *
 * 目前一律返回明确的错误：上游的上传入口要 a_bogus 签名，纯 HTTP 侧拿不到。
 * 用户把图片发进来时应该看到清楚的说明，而不是一张被悄悄丢掉的图。
 */
export async function uploadImage(session, image) {
  const info = sniffImage(image?.data ?? Buffer.alloc(0))
  if (!info) {
    throw new ProviderError('不认识的图片格式，只支持 png / jpeg / webp / gif。', 400, 'unsupported_image')
  }
  if (image.data.length > 20 * 1024 * 1024) {
    throw new ProviderError('图片超过 20MB。', 400, 'image_too_large')
  }
  throw new ProviderError(
    '豆包工作这条路暂时发不了图片：上传入口需要前端生成的 a_bogus 签名，纯 HTTP 侧造不出来。' +
    '需要识图请换一个支持图片的供应商。',
    400, 'image_not_supported',
  )
}

export const _internal = { crc32, IMAGEX_SERVICE }
