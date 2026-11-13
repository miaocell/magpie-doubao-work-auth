/**
 * 把 OpenAI 的 image_url 取成字节。
 *
 * 支持三种：
 *  - data:image/png;base64,...  内联 base64（最常见）
 *  - https://...                远程图片，直接下载
 *  - file:///... 或裸路径        本地文件
 */
import { ProviderError } from './errors.mjs'
import { basename } from 'node:path'

const MAX_BYTES = 20 * 1024 * 1024

export async function loadImage(url, signal) {
  const text = String(url || '')
  if (!text) throw new ProviderError('图片地址为空。', 400, 'invalid_image')

  // data URL
  const dataMatch = text.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (dataMatch) {
    const mime = dataMatch[1] || 'image/png'
    if (!/^image\//.test(mime)) throw new ProviderError(`不支持的内容类型 ${mime}。`, 400, 'unsupported_image')
    let data
    if (dataMatch[2]) {
      data = Buffer.from(dataMatch[3], 'base64')
    } else {
      data = Buffer.from(decodeURIComponent(dataMatch[3]), 'utf8')
    }
    if (data.length > MAX_BYTES) throw new ProviderError('图片超过 20MB。', 400, 'image_too_large')
    return { data, name: `image.${mime.split('/')[1] || 'png'}` }
  }

  // 远程
  if (/^https?:\/\//i.test(text)) {
    const response = await fetch(text, { signal: signal ?? AbortSignal.timeout(60_000) })
    if (!response.ok) throw new ProviderError(`下载图片失败（${response.status}）。`, 400, 'image_download_failed')
    const length = Number(response.headers.get('content-length') || 0)
    if (length > MAX_BYTES) throw new ProviderError('图片超过 20MB。', 400, 'image_too_large')
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length > MAX_BYTES) throw new ProviderError('图片超过 20MB。', 400, 'image_too_large')
    const name = basename(new URL(text).pathname) || 'image.png'
    return { data, name }
  }

  // 本地文件
  const { readFile } = await import('node:fs/promises')
  const path = text.startsWith('file://') ? new URL(text).pathname : text
  try {
    const data = await readFile(path)
    if (data.length > MAX_BYTES) throw new ProviderError('图片超过 20MB。', 400, 'image_too_large')
    return { data, name: basename(path) || 'image.png' }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError(`读取本地图片失败：${error.message}`, 400, 'image_read_failed')
  }
}
