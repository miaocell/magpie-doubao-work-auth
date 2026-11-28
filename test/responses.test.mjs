/**
 * Responses API 兼容层。
 *
 * Codex 走 wire_api = "responses" 时发的是 input 而不是 messages，
 * magpie 会原样把请求转到插件。这些测试锁定「折成 chat 形状」这一步，
 * 以及回程「折成 response 对象」的形状。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { responsesToChat, chatToResponses, responsesEventStream } from '../lib/responses.mjs'
import { estimateTokens } from '../lib/chat.mjs'

test('input 是字符串时折成一条 user 消息', () => {
  const chat = responsesToChat({ model: 'm', input: '你好' })
  assert.deepEqual(chat.messages, [{ role: 'user', content: '你好' }])
})

test('instructions 排在最前，当作 system', () => {
  const chat = responsesToChat({ model: 'm', instructions: '你是助手', input: '你好' })
  assert.equal(chat.messages[0].role, 'system')
  assert.equal(chat.messages[0].content, '你是助手')
  assert.equal(chat.messages[1].content, '你好')
})

test('content 数组折成纯文本，图片类型的段跳过', () => {
  const chat = responsesToChat({
    model: 'm',
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '看图' },
        { type: 'input_image', image_url: 'https://x/y.png' },
      ],
    }],
  })
  assert.equal(chat.messages[0].content, '看图')
})

test('function_call 并进 assistant.tool_calls', () => {
  const chat = responsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列目录' }] },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
    ],
  })
  const assistant = chat.messages.find((m) => m.role === 'assistant')
  assert.equal(assistant.tool_calls[0].id, 'call_1')
  assert.equal(assistant.tool_calls[0].function.name, 'shell')
  const tool = chat.messages.find((m) => m.role === 'tool')
  assert.equal(tool.tool_call_id, 'call_1')
  assert.equal(tool.content, 'a.txt')
})

test('扁平的 tools 折成 chat 的嵌套结构', () => {
  const chat = responsesToChat({
    model: 'm',
    input: 'hi',
    tools: [{ type: 'function', name: 'shell', description: 'd', parameters: { type: 'object' } }],
  })
  assert.equal(chat.tools[0].function.name, 'shell')
  assert.equal(chat.tools[0].function.description, 'd')
})

test('max_output_tokens 换成 max_tokens，input/instructions 不留残余', () => {
  const chat = responsesToChat({ model: 'm', input: 'hi', instructions: 'x', max_output_tokens: 4096 })
  assert.equal(chat.max_tokens, 4096)
  assert.equal('max_output_tokens' in chat, false)
  assert.equal('input' in chat, false)
  assert.equal('instructions' in chat, false)
})

test('chat 结果折回 response 对象，usage 用 input/output_tokens', () => {
  const completion = {
    id: 'chatcmpl-1',
    created: 1700000000,
    model: 'glm-5-3',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  }
  const resp = chatToResponses(completion, 'glm-5-3')
  assert.equal(resp.object, 'response')
  assert.equal(resp.status, 'completed')
  assert.equal(resp.output[0].type, 'message')
  assert.equal(resp.output[0].content[0].text, '你好')
  assert.equal(resp.usage.input_tokens, 12)
  assert.equal(resp.usage.output_tokens, 3)
})

test('工具调用折回 function_call item', () => {
  const completion = {
    id: 'c', created: 1, model: 'm',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }] },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
  const resp = chatToResponses(completion, 'm')
  const call = resp.output.find((x) => x.type === 'function_call')
  assert.equal(call.call_id, 'call_1')
  assert.equal(call.name, 'shell')
  assert.equal(call.arguments, '{"command":"ls"}')
})

test('token 估算：中文按字，英文按四字符', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('中文字符'), 4)
  // 8 个字符的英文约 2 个 token
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.ok(estimateTokens('中文 and english mixed') > 0)
})

test('客户端断开时主动放掉上游迭代器', async () => {
  // 之前没有 cancel 处理器：客户端取消后上游还会继续跑到结束，白生成也白计费。
  let released = 0
  async function* source() {
    try {
      for (let i = 0; i < 100; i++) yield { content: `块${i}` }
    } finally {
      released++
    }
  }
  const stream = responsesEventStream({ created: 1, model: 'm' }, source(), () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }))
  const reader = stream.getReader()
  await reader.read() // 先读一个事件，确认流已经启动
  await reader.cancel()
  // cancel 后给微任务一点时间跑 finally
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(released, 1, '上游迭代器的 finally 应该被执行（说明被提前释放）')
})

test('responses 流式路径也要解析工具调用，不能把 JSON 当正文发出去', async () => {
  // 之前 responsesEventStream 直接把上游增量当 output_text 发，
  // 带工具的请求会把 {"content":"","tool_calls":[...]} 原样流给 Codex。
  const { decodeReply } = await import('../lib/protocol.mjs')
  const prepared = {
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    prompt: 'p', structured: false, toolChoice: 'auto', parallel: true,
  }
  async function* deltas() {
    yield { content: '{"content":"","tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}' }
  }
  const res = responsesEventStream(
    { created: 1, model: 'm' },
    deltas(),
    () => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
    prepared,
    decodeReply,
  )
  // responsesEventStream 返回裸 ReadableStream
  const reader = res.getReader()
  const dec = new TextDecoder()
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
  }
  assert.ok(text.includes('function_call'), '应产出 function_call 事件')
  assert.ok(text.includes('read_file'), '工具名要出现')
  assert.ok(!text.includes('output_text.delta'), '不该把 JSON 当正文发出去')
})
