import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactText, redactBody, bodyStats } from '../lib/diag.mjs'

test('长文本压成长度 + 摘要，短文本原样', () => {
  assert.equal(redactText('短文本'), '短文本')
  const long = 'X'.repeat(5000)
  const out = redactText(long)
  assert.ok(out.startsWith('[5000 chars]'))
  assert.ok(out.length < 200)
})

test('请求体脱敏：正文摘要，结构字段保留', () => {
  const body = {
    client_meta: { bot_id: '123' },
    messages: [{ content_block: [{ content: { text_block: { text: 'A'.repeat(9000) } } }] }],
    option: { model_config: { model_item_key: 'deepseek-v4-1-flash' } },
  }
  const out = redactBody(body)
  assert.equal(out.client_meta.bot_id, '123')
  assert.equal(out.option.model_config.model_item_key, 'deepseek-v4-1-flash')
  assert.ok(out.messages[0].content_block[0].content.text_block.text.startsWith('[9000 chars]'))
  // 原对象没被改
  assert.equal(body.messages[0].content_block[0].content.text_block.text.length, 9000)
})

test('体积统计定位大字段', () => {
  const body = {
    messages: [{ content_block: [
      { content: { text_block: { text: 'X'.repeat(3000) } } },
      { content: { attachment_block: { attachments: [{ url: 'Y'.repeat(1000) }] } } },
    ] }],
    option: { tools: [{}, {}] },
  }
  const s = bodyStats(body)
  assert.equal(s.promptChars, 3000)
  assert.equal(s.attachmentChars > 1000, true)
  assert.equal(s.toolCount, 2)
})
