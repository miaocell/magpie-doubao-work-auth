import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 临时会话的建立与清理。
 *
 * 这块之前一个测试都没有，但它管的是「用完就删」——出问题的后果是
 * 用户在豆包客户端侧边栏看到一堆垃圾会话，或者会话泄漏占额度。
 */

const dir = await mkdtemp(join(tmpdir(), 'lease-test-'))
process.env.DOUBAO_WORK_CACHE = dir
const { ConversationLease } = await import('../lib/lease.mjs')

/** 造一个只回固定应答的 session */
function fakeSession({ ackId = '123456', deleteResult = true, brokenDelete = false, onDelete } = {}) {
  const calls = []
  return {
    uid: 'u1',
    profile: 'p',
    bot: '999',
    calls,
    session: null,
    async request(path, body) {
      calls.push({ path, body })
      if (path.includes('batch_del_user_conv')) {
        onDelete?.()
        if (brokenDelete) {
          // 模拟豆包没给确认结果
          return Response.json({ status_code: 0, downlink_body: {} })
        }
        const id = body?.uplink_body?.batch_delete_user_conversation_uplink_body?.conversation_id?.[0]
        return Response.json({
          status_code: 0,
          downlink_body: { batch_delete_user_conversation_downlink_body: { result: { [id]: deleteResult } } },
        })
      }
      if (path.includes('recent_conv')) {
        return Response.json({
          status_code: 0,
          downlink_body: {
            pull_recent_conv_chain_downlink_body: { user_id: 'u1', cells: [], has_more: false },
          },
        })
      }
      return Response.json({ status_code: 0, downlink_body: {} })
    },
  }
}

function makeBody(localId) {
  return { client_meta: { local_conversation_id: localId } }
}

test('begin 会把清理记录写到磁盘', async () => {
  const session = fakeSession()
  const localId = `local_${'a'.repeat(32)}`
  const lease = new ConversationLease(session, makeBody(localId))
  await lease.begin()
  const files = await readdir(lease.dir)
  assert.ok(files.includes(`${localId}.json`), '应有对应的清理记录文件')
  await lease.finish()
})

test('observe 从 SSE_ACK 记下会话 id', async () => {
  const session = fakeSession({ ackId: '555' })
  const localId = `local_${'b'.repeat(32)}`
  const lease = new ConversationLease(session, makeBody(localId))
  await lease.begin()
  await lease.observe('SSE_ACK', { ack_client_meta: { local_conversation_id: localId, conversation_id: '555' } })
  assert.equal(lease.record.conversationId, '555')
  await lease.finish()
})

test('会话 id 与本次请求不匹配时报错，避免误删别人的对话', async () => {
  const session = fakeSession()
  const localId = `local_${'c'.repeat(32)}`
  const lease = new ConversationLease(session, makeBody(localId))
  await lease.begin()
  await assert.rejects(
    () => lease.observe('SSE_ACK', { ack_client_meta: { local_conversation_id: 'local_别人', conversation_id: '1' } }),
    (e) => e.code === 'conversation_ownership_error',
  )
  await lease.finish()
})

test('finish 会删掉会话和清理记录', async () => {
  let deleted = false
  const session = fakeSession({ onDelete: () => { deleted = true } })
  const localId = `local_${'d'.repeat(32)}`
  const lease = new ConversationLease(session, makeBody(localId))
  await lease.begin()
  await lease.observe('SSE_ACK', { ack_client_meta: { local_conversation_id: localId, conversation_id: '777' } })
  await lease.finish()
  assert.equal(deleted, true, '应该发出删除请求')
  const files = await readdir(lease.dir)
  assert.ok(!files.includes(`${localId}.json`), '清理记录文件应被删除')
})

test('清理失败时保留重试标记，不把已拿到的回复变成错误', async () => {
  // removeOwned 在豆包没确认删除结果时会抛。finish 吞掉这个错误（用户只关心内容），
  // 但要把 retry 标记写回记录，下次 begin 时补清理。
  const session = fakeSession({ brokenDelete: true })
  const localId = `local_${'e'.repeat(32)}`
  const lease = new ConversationLease(session, makeBody(localId))
  await lease.begin()
  await lease.observe('SSE_ACK', { ack_client_meta: { local_conversation_id: localId, conversation_id: '888' } })
  // 传了 originalError（上游本身有错）时不该再抛清理错误，避免掩盖真实原因
  await lease.finish(new Error('上游失败'))
  assert.equal(lease.record.retry, true, '应留下重试标记')
})

test('清理', async () => {
  await rm(dir, { recursive: true, force: true })
})
