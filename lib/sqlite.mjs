/**
 * 读取 Chromium Cookies 库（SQLite）。
 *
 * 插件安装时不跑构建脚本，原生模块装不了，所以这里用一个最小只读解析器
 * 直接读 B-tree 叶子页——读一张 Cookies 表不需要完整引擎。
 *
 * 两个容易踩的偏移：
 *  - 第 1 页开头有 100 字节的数据库头，btree 头在 100 之后；但 cell 指针的
 *    值是相对「页起点」的，不是相对 btree 头。
 *  - 记录头里的 varint 序列给出各列类型，整数按类型宽度自解码，文本按长度切。
 */
import { readFile } from 'node:fs/promises'

const HEADER_SIZE = 100
const LEAF_TABLE = 0x0d
const INT_SIZE = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6, 6: 8 }

/** 读出一张表的所有行，行是按 SQLite 声明顺序排列的列值数组 */
export async function readCookies(file) {
  const db = await readFile(file)
  const pageSize = db.readUInt16BE(16) || 65536

  // 先在 sqlite_master（第 1 页的叶子）里找 Cookies 表的根页与建表语句
  let rootPage = 0
  let createSql = ''
  for (const cell of leafCells(db, pageSize, 1)) {
    const row = parseRecord(db, cell)
    if (!Array.isArray(row) || row.length < 5) continue
    // 表名不区分大小写：不同 Chromium 版本有 Cookies / cookies 两种写法
    if (String(row[0]).toLowerCase() === 'table' && String(row[1]).toLowerCase() === 'cookies') {
      rootPage = Number(row[3])
      createSql = String(row[4] ?? '')
      break
    }
  }
  if (!rootPage) throw new Error('Cookies 库里找不到 Cookies 表。')

  // 列的顺序随 Chromium 版本变过（新版首列是 creation_utc），必须从建表语句读
  const columns = parseColumns(createSql)
  if (!columns.includes('host_key')) throw new Error(`Cookies 表结构异常：${createSql.slice(0, 200)}`)

  const rows = []
  const queue = [rootPage]
  const seen = new Set()
  while (queue.length) {
    const page = queue.shift()
    if (seen.has(page)) continue
    seen.add(page)
    const pageStart = (page - 1) * pageSize
    if (pageStart >= db.length) continue
    const type = db[pageStart]
    if (type === 0x05) {
      // 内部页：每格开头是子页号
      const headerAt = pageStart + (page === 1 ? HEADER_SIZE : 0)
      const count = db.readUInt16BE(headerAt + 3)
      for (let i = 0; i <= count; i++) {
        const at = headerAt + 12 + i * 2
        if (at + 2 > db.length) break
        queue.push(db.readUInt16BE(at))
      }
      continue
    }
    for (const cell of leafCells(db, pageSize, page)) {
      const values = parseRecord(db, cell)
      if (!Array.isArray(values)) continue
      const record = {}
      columns.forEach((name, index) => { record[name] = values[index] })
      if (!record.host_key) continue
      rows.push({
        host: String(record.host_key),
        name: String(record.name ?? ''),
        value: record.value ?? '',
        encrypted: Buffer.isBuffer(record.encrypted_value) ? record.encrypted_value : Buffer.alloc(0),
        path: String(record.path ?? '/'),
        expires: Number(record.expires_utc) || 0,
        secure: Number(record.is_secure) === 1,
        httpOnly: Number(record.is_httponly) === 1,
      })
    }
  }
  return { pageSize, rows, columns }
}

/** 从 CREATE TABLE 语句里按出现顺序取列名 */
export function parseColumns(sql) {
  const open = sql.indexOf('(')
  const close = sql.lastIndexOf(')')
  if (open < 0 || close < open) return []
  const body = sql.slice(open + 1, close)
  const names = []
  let depth = 0
  let current = ''
  const parts = []
  for (const char of body) {
    if (char === '(') depth++
    if (char === ')') depth--
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)
  for (const part of parts) {
    const trimmed = part.trim()
    // 跳过表级约束
    if (/^(primary|unique|check|foreign|constraint)\b/i.test(trimmed)) continue
    // 列名可能用 "x" / [x] / `x` 包裹
    const match = trimmed.match(/^(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/)
    if (match) names.push((match[1] || match[2] || match[3] || match[4]).toLowerCase())
  }
  return names
}

function* leafCells(db, pageSize, page) {
  const pageStart = (page - 1) * pageSize
  const headerAt = pageStart + (page === 1 ? HEADER_SIZE : 0)
  if (db[headerAt] !== LEAF_TABLE) return
  const count = db.readUInt16BE(headerAt + 3)
  const pageEnd = Math.min(pageStart + pageSize, db.length)
  for (let i = 0; i < count; i++) {
    const pointerAt = headerAt + 8 + i * 2
    if (pointerAt + 2 > db.length) break
    const at = pageStart + db.readUInt16BE(pointerAt)
    if (at + 2 > db.length) break
    const length = readVarint(db, at)
    const rowid = readVarint(db, at + length.length)
    const body = at + length.length + rowid.length
    const local = pageEnd - body
    let payload
    if (length.value <= local) {
      payload = db.subarray(body, body + length.value)
    } else {
      // 溢出页：本页留一段，剩下的在溢出链里
      const parts = [db.subarray(body, body + local)]
      let next = db.readUInt32BE(body + local - 4)
      let guard = 0
      while (next && guard++ < 64) {
        const overflowAt = (next - 1) * pageSize
        if (overflowAt + pageSize > db.length) break
        parts.push(db.subarray(overflowAt + 4, overflowAt + pageSize))
        next = db.readUInt32BE(overflowAt)
      }
      payload = Buffer.concat(parts).subarray(0, length.value)
    }
    yield payload
  }
}

function readVarint(db, at) {
  let value = 0
  for (let i = 0; i < 9; i++) {
    const byte = db[at + i]
    if (byte === undefined) throw new Error('SQLite varint 越界。')
    if (i === 8) return { value: value * 256 + byte, length: 9 }
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) return { value, length: i + 1 }
  }
  throw new Error('SQLite varint 格式异常。')
}

function parseRecord(db, payload) {
  if (!payload?.length) return null
  const headerSize = readVarint(payload, 0)
  const types = []
  let at = headerSize.length
  while (at < headerSize.value) {
    const type = readVarint(payload, at)
    types.push(type.value)
    at += type.length
  }
  const values = []
  let cursor = headerSize.value
  for (const type of types) {
    if (type === 0) { values.push(null); continue }
    if (type >= 1 && type <= 6) { values.push(readInteger(payload, cursor, type)); cursor += INT_SIZE[type]; continue }
    if (type === 7) { values.push(payload.readDoubleBE(cursor)); cursor += 8; continue }
    if (type === 8) { values.push(0); continue }
    if (type === 9) { values.push(1); continue }
    if (type < 12) throw new Error(`SQLite 列类型 ${type} 不受支持。`)
    const length = (type - 12) >> 1
    const bytes = payload.subarray(cursor, cursor + length)
    cursor += length
    values.push(type % 2 === 0 ? bytes : bytes.toString('utf8'))
  }
  return values
}

function readInteger(buffer, at, type) {
  switch (type) {
    case 1: return buffer.readInt8(at)
    case 2: return buffer.readInt16BE(at)
    case 3: return (buffer.readUInt8(at) << 16) | buffer.readUInt16BE(at + 1)
    case 4: return buffer.readInt32BE(at)
    case 5: return buffer.readUIntBE(at, 6)
    default: return Number(buffer.readBigInt64BE(at))
  }
}
