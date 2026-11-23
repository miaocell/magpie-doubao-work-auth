import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareRequest } from '../lib/protocol.mjs'

const LIMIT = 100 * 1024
const bytes = (s) => Buffer.byteLength(s, 'utf8')

function bigInput(systemKB) {
  return {
    model: 'm',
    messages: [
      { role: 'system', content: '你是助手。'.repeat(systemKB * 1000 / '你是助手。'.length) },
      { role: 'user', content: '你好' },
    ],
  }
}

test('小请求原样保留，不触发压缩', () => {
  const p = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(p.promptTruncated, false)
  assert.ok(bytes(p.prompt) < LIMIT)
})

test('257KB 系统提示词被压缩到上限内，且保留最后一条用户消息', () => {
  const p = prepareRequest(bigInput(257))
  assert.ok(bytes(p.prompt) <= LIMIT, `prompt ${bytes(p.prompt)} 字节应 <= ${LIMIT}`)
  assert.equal(p.promptTruncated, true)
  assert.ok(p.prompt.includes('"role":"user"'))
  assert.ok(p.prompt.includes('你是助手'))
})

test('大 payload + 大工具定义：压缩后工具名仍在，原始 tools 不变', () => {
  const tools = Array.from({ length: 60 }, (_, i) => ({
    type: 'function',
    function: {
      name: `tool_${i}`,
      description: '工具描述'.repeat(300),
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    },
  }))
  const p = prepareRequest({
    model: 'm',
    messages: [{ role: 'system', content: '指令'.repeat(100000) }, { role: 'user', content: '继续' }],
    tools,
    tool_choice: 'auto',
  })
  assert.ok(bytes(p.prompt) <= LIMIT)
  assert.equal(p.promptTruncated, true)
  assert.equal(p.tools.length, 60) // 原始定义不动，回复解析照常校验
  assert.ok(p.prompt.includes('tool_0'))
})

test('纯中文大 payload 按字节数压缩（1 字符 3 字节）', () => {
  // 4 万中文字符 ≈ 12 万字节，超过 100KB 上限；若按字符数判断会漏判
  const p = prepareRequest({
    model: 'm',
    messages: [
      { role: 'system', content: '中'.repeat(40_000) },
      { role: 'user', content: '继续' },
    ],
  })
  assert.ok(bytes(p.prompt) <= LIMIT)
  assert.equal(p.promptTruncated, true)
})

test('超长历史只保留最近若干条', () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `第${i}轮`.repeat(1000) }))
  const p = prepareRequest({ model: 'm', messages })
  assert.ok(bytes(p.prompt) <= LIMIT)
  assert.ok(p.prompt.includes('第199轮'))
  assert.ok(!p.prompt.includes('第0轮'))
})
