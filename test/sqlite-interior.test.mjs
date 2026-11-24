import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseColumns, readCookies } from '../lib/sqlite.mjs'

const here = dirname(fileURLToPath(import.meta.url))
/** 真实 SQLite 文件：根页是内部页（0x05），20 页、300 行 */
const INTERIOR_FIXTURE = join(here, 'fixtures', 'cookies-interior-page.db')
const EXPECTED_ROWS = 300

test('真实 fixture 的根页确实是内部页（前提校验）', async () => {
  // 这个 fixture 由 python sqlite3 生成：cookies 表根页 = 2，类型 0x05（内部表页）。
  // 注意文件头 offset 28 是页 1 的 btree header 字段，不是根页号，
  // 根页号要从 sqlite_master 里查，这里直接按已知值校验。
  const db = await readFile(INTERIOR_FIXTURE)
  const pageSize = db.readUInt16BE(16)
  assert.equal(db[(2 - 1) * pageSize], 0x05, '页 2 应是内部表页（0x05）')
})

test('根页是内部页时能遍历到所有叶子页的行', async () => {
  // issue #16：内部页的 cell 指针槽存的是「页内偏移」而不是子页号，
  // 旧代码直接当子页号用，读到的都是垃圾页号 → 0 行 → 上层报「没有登录会话」。
  const { rows } = await readCookies(INTERIOR_FIXTURE)
  assert.equal(rows.length, EXPECTED_ROWS, `应读到 ${EXPECTED_ROWS} 条，实际 ${rows.length}`)
  assert.ok(rows.every((r) => r.host === '.doubao.com'))
  assert.ok(rows.some((r) => r.name === 'c0'))
  assert.ok(rows.some((r) => r.name === `c${EXPECTED_ROWS - 1}`), '最后一页的行也要读到')
})

test('从建表语句取列名，跳过表级约束', () => {
  const sql = 'CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, ' +
    'top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, ' +
    'encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, ' +
    'is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, ' +
    'PRIMARY KEY (host_key, top_frame_site_key, name, path), UNIQUE (host_key, name))'
  const columns = parseColumns(sql)
  assert.deepEqual(columns, [
    'creation_utc', 'host_key', 'top_frame_site_key', 'name', 'value',
    'encrypted_value', 'path', 'expires_utc', 'is_secure', 'is_httponly',
  ])
})

test('带引号的列名也能取到', () => {
  assert.deepEqual(parseColumns('CREATE TABLE cookies ("host_key" TEXT, [name] TEXT)'), ['host_key', 'name'])
})

test('老版本布局（host_key 在首位）同样支持', () => {
  const columns = parseColumns('CREATE TABLE Cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER)')
  assert.equal(columns[0], 'host_key')
})
