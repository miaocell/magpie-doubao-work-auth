import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareRequest } from '../lib/protocol.mjs'

/**
 * 压缩门槛是兜底，不是常规路径。
 *
 * 实测（30 天体验账号）：400KB / 600KB / 800KB / 1MB / 1.3MB 全部正常出流，
 * 400KB 文本中间埋标记也能被准确答出。而 issue 反馈 257KB / 290KB 会被拒。
 * 两种结果差距很大、原因未定，所以门槛取「足够大、只兜明显异常」，避免主动
 * 砍掉用户本可正常使用的内容。
 */
const LIMIT = 1_500 * 1024
const bytes = (s) => Buffer.byteLength(s, 'utf8')

/** 造一个指定 KB 的系统提示词 */
function bigInput(systemKB) {
  return {
    model: 'm',
    messages: [
      { role: 'system', content: '你是助手。'.repeat(Math.ceil((systemKB * 1024) / 15)) },
      { role: 'user', content: '你好' },
    ],
  }
}

test('小请求原样保留，不触发压缩', () => {
  const p = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(p.promptTruncated, false)
  assert.ok(bytes(p.prompt) < LIMIT)
})

test('正常大请求（300KB）不做压缩——实测上游吃得下', () => {
  // 这条是重点：之前阈值 100KB，300KB 会被压掉三分之二，用户以为模型看全了。
  const p = prepareRequest(bigInput(300))
  assert.equal(p.promptTruncated, false, '300KB 不该压缩')
  assert.ok(bytes(p.prompt) > 300 * 1024)
})

test('1MB 以内不压缩', () => {
  const p = prepareRequest(bigInput(1000))
  assert.equal(p.promptTruncated, false, '1MB 不该压缩')
})

test('超过门槛才压缩到上限内，且保留最后一条用户消息', () => {
  const p = prepareRequest(bigInput(2000))
  assert.ok(bytes(p.prompt) <= LIMIT, `prompt ${bytes(p.prompt)} 字节应 <= ${LIMIT}`)
  assert.equal(p.promptTruncated, true)
  assert.ok(p.prompt.includes('"role":"user"'))
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
    messages: [{ role: 'system', content: '指令'.repeat(300000) }, { role: 'user', content: '继续' }],
    tools,
    tool_choice: 'auto',
  })
  assert.ok(bytes(p.prompt) <= LIMIT)
  assert.equal(p.promptTruncated, true)
  assert.equal(p.tools.length, 60) // 原始定义不动，回复解析照常校验
  assert.ok(p.prompt.includes('tool_0'))
})

test('纯中文大 payload 按字节数判断（1 字符 3 字节）', () => {
  // 60 万中文字符 ≈ 1.8MB，按字节判会触发；若按字符数判只有 60 万，会漏判
  const p = prepareRequest({
    model: 'm',
    messages: [
      { role: 'system', content: '中'.repeat(600_000) },
      { role: 'user', content: '继续' },
    ],
  })
  assert.ok(bytes(p.prompt) <= LIMIT)
  assert.equal(p.promptTruncated, true)
})

test('超长历史触发压缩时保留最近的轮次', () => {
  const messages = Array.from({ length: 400 }, (_, i) => ({ role: 'user', content: `第${i}轮`.repeat(2000) }))
  const p = prepareRequest({ model: 'm', messages })
  assert.ok(bytes(p.prompt) <= LIMIT)
  assert.ok(p.prompt.includes('第399轮'))
  assert.ok(!p.prompt.includes('第0轮'))
})
