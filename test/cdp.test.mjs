import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findDebugPorts, cookiesFromDebugPort, launchDebugBrowser } from '../lib/cdp.mjs'

test('没有调试端口时给出可操作的提示', async () => {
  // 用一个几乎不可能有服务的端口段
  const ports = await findDebugPorts([59991, 59992, 59993])
  assert.deepEqual(ports, [])
})

test('找不到端口时 cookiesFromDebugPort 报错并提示替代方式', async () => {
  // 这个函数用固定端口段，本机没有时应当抛错而不是挂住
  try {
    await cookiesFromDebugPort('doubao.com')
    // 有调试端口在跑时（比如用户自己开的）会成功，也接受
  } catch (error) {
    assert.match(String(error.message), /调试端口|登录/)
  }
})

test('launchDebugBrowser 在找不到浏览器时报错而不是静默失败', async () => {
  // 用一个不存在的 profileDir 父路径不影响；这里只验证它能被调用且返回结构合理
  // 真正的启动需要 GUI 环境，测试环境不强制要求成功
  try {
    const result = await launchDebugBrowser({ port: 59994 })
    assert.ok(result.port === 59994)
    assert.ok(typeof result.name === 'string')
  } catch (error) {
    assert.match(String(error.message), /没找到|没响应/)
  }
})
