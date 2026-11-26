import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sseResponse } from '../lib/chat.mjs'

/**
 * 流式输出的两条路径。
 *
 * 带工具的请求有两种输出形态（见 protocol.mjs 的工具传输协议）：
 *  - 要调工具 → 只输出一个 JSON
 *  - 不调工具 → 直接输出正文
 *
 * 前者必须整段收完才能解析 tool_calls；后者应该边收边发，否则用户要干等整段生成完
 * （issue #9「首字 15-25 秒」、#14「看不到工作过程」都是这个原因）。
 */

/** 造一个够真实的 prepared：decodeReply 要看 tools / toolChoice */
const META = { id: "chatcmpl-test", created: 1, model: "doubao-test" }
const PREPARED = {
  tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  prompt: 'p',
  structured: false,
  toolChoice: 'auto',
  parallel: true,
}

/** 把 sseResponse 的输出读完，记下每个数据块到达的顺序 */
async function drain(response) {
  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const events = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const p of parts) {
      const line = p.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') { events.push('[DONE]'); continue }
      try { events.push(JSON.parse(payload)) } catch { /* 忽略 */ }
    }
  }
  return events
}

/** 造一个可控的 delta 源：每 next() 一次产出一块 */
async function* deltas(pieces) {
  for (const p of pieces) yield p
}

test('短回复也应该逐块转发（issue #17）', async () => {
  // 之前攒 200 字符串才判定，短回复永远攒不够 → 一直等到整段生成完才吐字，
  // 实测那段时间 6-12 秒。现在只看首字符决定形态，短回复立刻走流式。
  const prepared = PREPARED
  const source = deltas([
    { content: '1、' },
    { content: '2、3、4、5' },
  ])
  const stream = sseResponse(source, META, prepared, new AbortController())
  const events = await drain(stream)

  const contents = events.filter((e) => e?.choices?.[0]?.delta?.content).map((e) => e.choices[0].delta.content)
  assert.deepEqual(contents, ['1、', '2、3、4、5'], '短回复也要分块转发，不能攒到最后')
  assert.ok(events.some((e) => e?.choices?.[0]?.finish_reason === 'stop'), '结尾要有 stop')
  assert.equal(events.at(-1), '[DONE]')
})

test('首块就是工具 JSON 时直接走缓冲', async () => {
  const prepared = PREPARED
  const json = '{"content":"","tool_calls":[{"name":"read_file","arguments":{"path":"a"}}]}'
  const stream = sseResponse(deltas([{ content: json }]), META, prepared, new AbortController())
  const events = await drain(stream)
  assert.ok(events.some((e) => e?.choices?.[0]?.delta?.tool_calls), '应产出 tool_calls')
  assert.ok(events.some((e) => e?.choices?.[0]?.finish_reason === 'tool_calls'))
})

test('超过判断窗口的回复会分多次转发', async () => {
  // 每块 100 字符，累计超过 200 的窗口后开始流式转发
  const prepared = PREPARED
  const chunk = 'x'.repeat(100)
  const source = deltas([
    { content: chunk }, { content: chunk }, { content: chunk },
    { content: chunk }, { content: chunk },
  ])
  const stream = sseResponse(source, META, prepared, new AbortController())
  const events = await drain(stream)
  const contents = events.filter((e) => e?.choices?.[0]?.delta?.content).map((e) => e.choices[0].delta.content)
  assert.ok(contents.length > 1, `应分多次转发，实际 ${contents.length} 次`)
  assert.equal(contents.join(''), chunk.repeat(5), '内容不能丢')
})

test('工具调用走缓冲：收到 JSON 后产出 tool_calls 和 finish_reason=tool_calls', async () => {
  const prepared = PREPARED
  const json = '{"content":"","tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}'
  const stream = sseResponse(deltas([{ content: json }]), META, prepared, new AbortController())
  const events = await drain(stream)

  const withCalls = events.find((e) => e?.choices?.[0]?.delta?.tool_calls)
  assert.ok(withCalls, '应产出 tool_calls')
  assert.equal(withCalls.choices[0].delta.tool_calls[0].function.name, 'read_file')
  // finish_reason 在随后的空 delta 里（OpenAI 协议就是这样）
  const finisher = events.find((e) => e?.choices?.[0]?.finish_reason === 'tool_calls')
  assert.ok(finisher, '结尾要有一块标 finish_reason=tool_calls')
  assert.equal(events.at(-1), '[DONE]')
})

test('形状判断只看开头：正文中间出现大括号仍按流式处理', async () => {
  const prepared = PREPARED
  const source = deltas([
    { content: '这是一段说明。' },
    { content: '例如 {"a":1} 这样的结构。' },
  ])
  const stream = sseResponse(source, META, prepared, new AbortController())
  const events = await drain(stream)
  const contents = events.filter((e) => e?.choices?.[0]?.delta?.content).map((e) => e.choices[0].delta.content)
  // 两段都在判断窗口内，会合并成一条发出；关键是内容完整、且没有被误判成工具调用
  assert.equal(contents.join(''), '这是一段说明。例如 {"a":1} 这样的结构。')
  assert.ok(!events.some((e) => e?.choices?.[0]?.delta?.tool_calls), '不该产出 tool_calls')
  assert.ok(events.some((e) => e?.choices?.[0]?.finish_reason === 'stop'), '应以 stop 结束')
})

test('空块不产出内容，但流能正常结束', async () => {
  const prepared = PREPARED
  const stream = sseResponse(deltas([{ content: '' }, { content: '有内容' }, {}]), META, prepared, new AbortController())
  const events = await drain(stream)
  const contents = events.filter((e) => e?.choices?.[0]?.delta?.content).map((e) => e.choices[0].delta.content)
  assert.deepEqual(contents, ['有内容'])
  assert.equal(events.at(-1), '[DONE]')
})

test('客户端取消时主动放掉上游迭代器', async () => {
  let released = 0
  async function* infinite() {
    try {
      for (let i = 0; i < 1000; i++) yield { content: `块${i}` }
    } finally { released++ }
  }
  const prepared = PREPARED
  const abort = new AbortController()
  const response = sseResponse(infinite(), META, prepared, abort)
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(released, 1, '取消后上游迭代器的 finally 应执行')
  assert.equal(abort.signal.aborted, true, '应同时中止上游请求')
})
