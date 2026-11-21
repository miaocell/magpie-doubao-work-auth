/**
 * 上游拒绝时的请求体诊断（Issue #8）。
 *
 * 豆包对超大请求会秒拒 400 common invalid param，但 magpie 侧只能看到统计数字，
 * 看不到发给豆包的实际请求体。这里在 400 时把请求体落盘，便于定位是哪个字段出问题。
 *
 * 脱敏原则：只保留结构、字段名和长度；正文（text_block.text）压成「长度 + 前 120 字」，
 * Cookie / token 不进请求体，所以不会落盘。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function cacheRoot() {
  if (process.env.DOUBAO_WORK_CACHE) return process.env.DOUBAO_WORK_CACHE
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'magpie-doubao-work-auth')
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'magpie-doubao-work-auth')
}

/** 文本压成摘要：保留长度，正文只留前 120 字符 */
export function redactText(text) {
  if (typeof text !== 'string') return text
  if (text.length <= 200) return text
  return `[${text.length} chars] ${text.slice(0, 120)}…`
}

/** 把请求体里的正文替换成摘要，其余结构原样保留 */
export function redactBody(body) {
  if (!body || typeof body !== 'object') return body
  const out = structuredClone(body)
  for (const message of Array.isArray(out.messages) ? out.messages : []) {
    for (const block of Array.isArray(message.content_block) ? message.content_block : []) {
      const text = block?.content?.text_block?.text
      if (typeof text === 'string') block.content.text_block.text = redactText(text)
      const text2 = block?.content?.attachment_block
      if (text2 && typeof text2 === 'object') {
        for (const a of Array.isArray(text2.attachments) ? text2.attachments : []) {
          if (typeof a?.url === 'string' && a.url.length > 200) a.url = `[${a.url.length} chars]`
        }
      }
    }
  }
  return out
}

/** 统计请求体各部分体积，定位是哪个字段撑大的 */
export function bodyStats(body) {
  const blocks = body?.messages?.[0]?.content_block || []
  let textChars = 0
  let attachmentChars = 0
  for (const block of blocks) {
    if (block?.content?.text_block?.text) textChars += String(block.content.text_block.text).length
    if (block?.content?.attachment_block) attachmentChars += JSON.stringify(block.content.attachment_block).length
  }
  return {
    totalChars: JSON.stringify(body).length,
    promptChars: textChars,
    attachmentChars,
    toolCount: body?.option?.tools?.length ?? 0,
  }
}

/** 写诊断文件；失败不该影响主流程 */
export async function saveDiagnostic(error, body, prepared, session) {
  try {
    const dir = join(cacheRoot(), 'diagnostics')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const record = {
      at: new Date().toISOString(),
      status: error?.status ?? 0,
      code: error?.code ?? '',
      upstreamCode: error?.upstreamCode ?? undefined,
      message: String(error?.message ?? '').slice(0, 500),
      model: prepared?.request?.model,
      promptTruncated: prepared?.promptTruncated ?? false,
      promptChars: prepared?.prompt?.length ?? 0,
      stats: bodyStats(body),
      body: redactBody(body),
      account: session?.uid ? String(session.uid) : undefined,
    }
    const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.json`)
    await writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 })
    return file
  } catch { return undefined }
}

/** 保留最近 20 份诊断，避免占满磁盘 */
export async function pruneDiagnostics(keep = 20) {
  try {
    const dir = join(cacheRoot(), 'diagnostics')
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
    for (const name of names.slice(0, Math.max(0, names.length - keep))) {
      await (await import('node:fs/promises')).unlink(join(dir, name)).catch(() => {})
    }
  } catch { /* 目录不存在 */ }
}

export const _internal = { cacheRoot }
