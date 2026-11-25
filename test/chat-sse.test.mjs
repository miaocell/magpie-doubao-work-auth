import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeToolJson } from '../lib/chat.mjs'

/**
 * 「这段输出是工具调用的 JSON，还是普通正文」的判断。
 *
 * 这个判断决定了流式行为：认定是正文就边收边转发（用户能早点看到字），
 * 认定是 JSON 就整段缓冲（工具调用必须完整才能解析）。
 * issue #9 / #14 的「首字十几秒」「看不到工作过程」都源于之前一律缓冲。
 */

test('以 { 开头判为工具 JSON', () => {
  assert.equal(looksLikeToolJson('{"content":"","tool_calls":[]}'), true)
  assert.equal(looksLikeToolJson('  {"content":"x"}'), true) // 前导空白
  assert.equal(looksLikeToolJson('\n\n{"tool_calls":[]}'), true)
})

test('``` 围栏判为工具 JSON', () => {
  assert.equal(looksLikeToolJson('```json\n{"tool_calls":[]}\n```'), true)
  assert.equal(looksLikeToolJson('```\n{}'), true)
})

test('普通正文判为非 JSON', () => {
  assert.equal(looksLikeToolJson('DNS 是域名系统，负责把域名解析成 IP。'), false)
  assert.equal(looksLikeToolJson('你好'), false)
  assert.equal(looksLikeToolJson('TCP 和 UDP 的区别有三点：'), false)
})

test('空串和只有空白判为非 JSON（还没收到东西）', () => {
  assert.equal(looksLikeToolJson(''), false)
  assert.equal(looksLikeToolJson('   '), false)
  assert.equal(looksLikeToolJson(undefined), false)
})

test('带解释前缀再跟 JSON：偏保守判为 JSON', () => {
  // 模型偶尔不守指令，先说一句再输出 JSON。这种要按工具调用处理，
  // 否则边收边发会把半截 JSON 当正文吐给用户。
  assert.equal(looksLikeToolJson('好的，我来调用{"tool_calls":[{"name":"x"}]}'), true)
  assert.equal(looksLikeToolJson('我来执行一下 {"name":"read_file"}'), true)
})

test('正文中间恰好有大括号，不应误判成工具调用', () => {
  // 这条是边界：正文里出现 { 很常见，不能一律当 JSON。
  // 前面有完整句子（句号结尾）且不在 200 字符内出现「调用/执行」时按正文处理。
  assert.equal(looksLikeToolJson('这是 JSON 的例子：{"a":1}。请参考。'), false)
})

test('大括号出现在很靠后的位置不算（只看开头一小段）', () => {
  const long = '这是一段很长的正文，'.repeat(20) + '{"a":1}'
  assert.equal(looksLikeToolJson(long), false)
})
