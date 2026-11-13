import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findDebugPorts, cookiesFromDebugPort, browserCandidates } from '../lib/cdp.mjs'

test('没有调试端口时返回空数组', async () => {
  const ports = await findDebugPorts([59991, 59992, 59993])
  assert.deepEqual(ports, [])
})

test('找不到端口时 cookiesFromDebugPort 报错并提示替代方式', async () => {
  try {
    await cookiesFromDebugPort('doubao.com', 59995)
    assert.fail('不该成功')
  } catch (error) {
    assert.match(String(error.message), /调试端口|登录/)
  }
})

test('浏览器候选列表里每个条目都有 name 和 path', () => {
  const list = browserCandidates()
  assert.ok(list.length > 0)
  for (const item of list) {
    assert.equal(typeof item.name, 'string')
    assert.equal(typeof item.path, 'string')
    assert.ok(item.path.length > 0)
  }
})

test('cookiesFromDebugPort 支持指定端口（不扫全段）', async () => {
  // 指定一个必定没开的端口，应该快速失败而不是遍历默认端口段
  const started = Date.now()
  await assert.rejects(cookiesFromDebugPort('doubao.com', 59996), /调试端口/)
  assert.ok(Date.now() - started < 5_000, '指定端口时应只试那一个')
})
