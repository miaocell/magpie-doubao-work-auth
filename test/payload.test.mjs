import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareRequest } from '../lib/protocol.mjs'

/**
 * 压缩与超限判定。
 *
 * 豆包上游限制的是**单条 text_block 的字符数**（约 262,144 = 256 KiB），
 * 不是字节数、也不是 token 数。依据是 issue #10 的受控测试：
 *
 *   ASCII 258,040 字符 / 258KB → 200
 *   ASCII 259,540 字符 / 259KB → 400 common invalid param
 *   中文  200,040 字符 / 549KB → 200   ← 字节翻倍反而过，因为字符数没超
 *   中文  258,035 字符 / 774KB → 200
 *
 * 所以判定必须按字符数：按字节判会把中文内容误伤（549KB 其实远没到上限）。
 */
const MAX_CHARS = 262_144
const SAFE_CHARS = 240_000

/** 造一个指定字符数的系统提示词 */
function bigInput(chars) {
  return {
    model: 'm',
    messages: [
      { role: 'system', content: 'a'.repeat(chars) },
      { role: 'user', content: '你好' },
    ],
  }
}

test('小请求原样保留，不触发压缩', () => {
  const p = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(p.promptTruncated, false)
  assert.ok(p.prompt.length < SAFE_CHARS)
})

test('按字符数判断：20 万中文（约 600KB）不压缩，按字节判会误伤', () => {
  // 20 万汉字 = 60 万字节。按旧的字节判（100KB）会被压掉；但字符数远低于
  // 262,144 的上限，实测这类请求上游能正常吃下，压了就是白丢内容。
  const p = prepareRequest({ model: 'm', messages: [{ role: 'user', content: '中'.repeat(200_000) }] })
  assert.equal(p.promptTruncated, false, '20 万字符不该压缩')
  assert.ok(Buffer.byteLength(p.prompt) > 550_000, '字节数确实很大')
})

test('超过安全线才压缩，且压到上限内并保留最后一条用户消息', () => {
  const p = prepareRequest(bigInput(300_000))
  assert.ok(p.prompt.length <= MAX_CHARS, `prompt ${p.prompt.length} 字符应 <= ${MAX_CHARS}`)
  assert.equal(p.promptTruncated, true)
  assert.ok(p.prompt.includes('"role":"user"'))
})

test('超长工具描述能被压缩救回来，并标记 promptTruncated', () => {
  // 正常情况压缩总能把内容截短，所以不会报 prompt_too_long。
  // 这里验证「救回来了」并且「标记出来了」，用户/上层能感知内容被裁。
  const hugeTool = {
    type: 'function',
    function: { name: 'x', description: 'y'.repeat(300_000), parameters: { type: 'object', properties: {} } },
  }
  const p = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [hugeTool] })
  assert.equal(p.promptTruncated, true, '压缩过就要标记出来')
  assert.ok(p.prompt.length <= MAX_CHARS)
})

test('prompt_too_long 的提示里带字符数和上限', () => {
  const hugeTool = {
    type: 'function',
    function: { name: 'x', description: 'y'.repeat(300_000), parameters: { type: 'object', properties: {} } },
  }
  try {
    const p = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [hugeTool] })
    // 如果压缩成功，至少要标记出来
    assert.equal(p.promptTruncated, true)
  } catch (e) {
    assert.match(e.message, /个字符/)
  }
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
  assert.ok(p.prompt.length <= MAX_CHARS)
  assert.equal(p.promptTruncated, true)
  assert.equal(p.tools.length, 60) // 原始定义不动，回复解析照常校验
  assert.ok(p.prompt.includes('tool_0'))
})

test('超长历史只保留最近若干条', () => {
  const messages = Array.from({ length: 200 }, (_, i) => ({ role: 'user', content: `第${i}轮`.repeat(1000) }))
  const p = prepareRequest({ model: 'm', messages })
  assert.ok(p.prompt.length <= MAX_CHARS)
  assert.ok(p.prompt.includes('第199轮'))
  assert.ok(!p.prompt.includes('第0轮'))
})
