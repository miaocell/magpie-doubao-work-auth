import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseColumns } from '../lib/sqlite.mjs'

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
