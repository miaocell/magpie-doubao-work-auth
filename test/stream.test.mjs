import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readDoubao } from '../lib/stream.mjs'

/** 造一个 SSE Response */
function sse(events) {
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

async function collect(response) {
  const out = []
  for await (const delta of readDoubao(response, undefined)) out.push(delta)
  return out
}

test('STREAM_CHUNK 增量拼接与思考块分流', async () => {
  const response = sse([
    { event: 'SSE_ACK', data: { ack_client_meta: { local_conversation_id: 'local_' + 'a'.repeat(32), conversation_id: '9' } } },
    { event: 'STREAM_CHUNK', data: {
      message_id: 'm1',
      patch_op: [{ patch_object: 1, patch_type: 2, patch_value: { content_block: [
        { block_id: 'b0', block_type: 10040, parent_id: '', content: { text_block: { text: '先想想' } } },
      ] } }],
    } },
    { event: 'CHUNK_DELTA', data: { text: '……' } },
    { event: 'STREAM_CHUNK', data: {
      message_id: 'm1',
      patch_op: [{ patch_object: 1, patch_type: 2, patch_value: { content_block: [
        { block_id: 'b1', block_type: 10000, parent_id: '', content: { text_block: { text: '答案是' } } },
      ] } }],
    } },
    { event: 'CHUNK_DELTA', data: { text: ' 42' } },
    { event: 'SSE_REPLY_END', data: { end_type: 3 } },
  ])
  const deltas = await collect(response)
  const reasoning = deltas.map((d) => d.reasoning_content ?? '').join('')
  const content = deltas.map((d) => d.content ?? '').join('')
  assert.equal(reasoning, '先想想……')
  assert.equal(content, '答案是 42')
})

test('STREAM_MSG_NOTIFY 也走同一条路径', async () => {
  const response = sse([
    { event: 'STREAM_MSG_NOTIFY', data: {
      meta: { message_id: 'm2' },
      content: { content_block: [{ block_id: 'b', block_type: 10000, parent_id: '', content: { text_block: { text: '整块' } } }] },
    } },
    { event: 'SSE_REPLY_END', data: { end_type: 3 } },
  ])
  assert.equal((await collect(response)).map((d) => d.content ?? '').join(''), '整块')
})

test('流里报错时抛出对应状态码', async () => {
  const response = sse([
    { event: 'STREAM_ERROR', data: { error_code: 710012001, error_msg: '登录已过期，请重新登录' } },
  ])
  await assert.rejects(collect(response), (error) => error.status === 401 && error.signIn === 'expired')
})

test('提前结束的流算失败，不返回半截回答', async () => {
  const response = sse([
    { event: 'STREAM_CHUNK', data: {
      message_id: 'm',
      patch_op: [{ patch_object: 1, patch_type: 2, patch_value: { content_block: [
        { block_id: 'b', block_type: 10000, parent_id: '', content: { text_block: { text: '半截' } } },
      ] } }],
    } },
  ])
  await assert.rejects(collect(response), /提前结束/)
})

test('没有正文的流算失败', async () => {
  const response = sse([{ event: 'SSE_REPLY_END', data: { end_type: 3 } }])
  await assert.rejects(collect(response), /没有回复正文/)
})

test('父块是思考块时子块也算思考', async () => {
  const response = sse([
    { event: 'STREAM_CHUNK', data: {
      message_id: 'm',
      patch_op: [{ patch_object: 1, patch_type: 2, patch_value: { content_block: [
        { block_id: 'p', block_type: 10040, parent_id: '', content: { text_block: { text: '' } } },
        { block_id: 'c', block_type: 10000, parent_id: 'p', content: { text_block: { text: '子块思考' } } },
      ] } }],
    } },
    { event: 'SSE_REPLY_END', data: { end_type: 3 } },
  ])
  const deltas = await collect(response)
  assert.equal(deltas.map((d) => d.reasoning_content ?? '').join(''), '子块思考')
})

test('非事件流响应按 JSON 错误处理', async () => {
  const response = Response.json({ code: 710022004, msg: '需要验证' })
  await assert.rejects(collect(response), (error) => error.status === 403 && error.code === 'captcha_required')
})
