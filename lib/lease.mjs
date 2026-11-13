/**
 * 临时会话的建立与清理。
 *
 * 豆包工作每问一次就产生一个会话，客户端侧边栏会一直留着。插件发出的是
 * 临时会话（conversation_type=3），请求结束就删掉，靠 local_conversation_id
 * 在历史列表里认领自己的那条，避免误删用户自己的对话。
 *
 * 清理记录落盘，进程被杀后下次请求前会补做，不会留下孤儿会话。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProviderError } from './errors.mjs'

const active = new Set()
const LOCAL_ID = /^local_[a-f0-9]{32}$/

function cacheRoot() {
  if (process.env.DOUBAO_WORK_CACHE) return process.env.DOUBAO_WORK_CACHE
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'magpie-doubao-work-auth')
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'magpie-doubao-work-auth')
}

/** 豆包的 IM 接口：cmd + sequence_id + uplink_body */
async function im(session, path, cmd, key, body) {
  const response = await session.request(
    path,
    { cmd, sequence_id: randomUUID(), channel: 2, version: '1', uplink_body: { [key]: body } },
    AbortSignal.timeout(30_000),
    {},
    { 'Content-Type': 'application/json; encoding=utf-8' },
  )
  const data = await response.json()
  if (data.status_code !== 0) {
    throw new ProviderError(`豆包会话接口失败：${data.status_desc || '未知错误'}（${data.status_code}）`, 502, 'conversation_api_error')
  }
  if (!data.downlink_body) throw new ProviderError('豆包会话接口缺少响应数据。', 502, 'invalid_conversation_response')
  return data.downlink_body
}

async function findOwned(session, record) {
  let cursor = '0'
  const seen = new Set()
  for (let page = 0; page < 100; page++) {
    const data = await im(session, '/im/chain/recent_conv', 3200, 'pull_recent_conv_chain_uplink_body', {
      api_version: 1,
      conv_version: Number(cursor),
      direction: cursor === '0' ? 3 : 1,
      limit: 50,
      message_count_per_conv: 0,
      option: { not_need_message: true, need_complete_conversation: true, need_coco_conversation: true, need_coco_bot: true },
    })
    const chain = data.pull_recent_conv_chain_downlink_body
    if (String(chain?.user_id ?? '') !== String(session.uid)) {
      throw new ProviderError('临时会话清理的账号校验失败。', 401, 'account_changed')
    }
    if (!Array.isArray(chain?.cells) || typeof chain.has_more !== 'boolean') {
      throw new ProviderError('豆包历史列表格式发生变化。', 502, 'invalid_conversation_response')
    }
    for (const cell of chain.cells) {
      const conversation = cell.conversation
      if (conversation?.conv_extra?.local_conversation_id !== record.localId) continue
      if (String(conversation.bot_id) !== String(record.bot) || !/^[1-9]\d*$/.test(String(conversation.conversation_id))) {
        throw new ProviderError('临时会话归属校验失败。', 502, 'conversation_ownership_error')
      }
      return String(conversation.conversation_id)
    }
    if (!chain.has_more) return undefined
    cursor = String(chain.next_conv_version)
    if (!/^[1-9]\d*$/.test(cursor) || seen.has(cursor)) {
      throw new ProviderError('豆包历史列表分页游标无效。', 502, 'invalid_conversation_response')
    }
    seen.add(cursor)
  }
  return undefined
}

async function removeOwned(session, record) {
  const id = record.conversationId || await findOwned(session, record)
  if (!id) return false
  const data = await im(session, '/im/conversation/batch_del_user_conv', 4171, 'batch_delete_user_conversation_uplink_body', {
    conversation_id: [id], delete_all: false, conversation_type: 3,
  })
  const result = data.batch_delete_user_conversation_downlink_body?.result
  if (!result || typeof result[id] !== 'boolean') {
    throw new ProviderError('豆包未确认临时会话的删除结果。', 502, 'conversation_cleanup_failed')
  }
  return true
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}

export class ConversationLease {
  constructor(session, body) {
    if (!session.uid || !session.profile) throw new Error('临时会话必须绑定已验证的账号。')
    this.session = session
    this.dir = join(cacheRoot(), 'conversations', createHash('sha256').update(`${session.profile}:${session.uid}`).digest('hex'))
    this.record = {
      localId: body.client_meta.local_conversation_id,
      bot: session.bot,
      startedAt: Date.now(),
      pid: process.pid,
    }
    if (!LOCAL_ID.test(this.record.localId)) throw new Error('临时会话标识格式异常。')
    this.file = join(this.dir, `${this.record.localId}.json`)
    this.started = false
  }

  async persist() {
    const temp = `${this.file}.${randomUUID()}.part`
    await writeFile(temp, JSON.stringify(this.record), { mode: 0o600, flag: 'wx' })
    await rename(temp, this.file)
  }

  async begin() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.dir)) {
      if (!/^local_[a-f0-9]{32}\.json$/.test(name)) continue
      const file = join(this.dir, name)
      if (active.has(file)) continue
      let raw
      try { raw = await readFile(file, 'utf8') }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      let record
      try { record = JSON.parse(raw) } catch { continue }
      if (record?.bot !== this.record.bot) continue
      // 5 分钟内的活进程记录当作并发请求，跳过
      if (Date.now() - record.startedAt < 300_000 && processAlive(record.pid)) continue
      try {
        await removeOwned(this.session, record)
        await unlink(file)
      } catch { /* 下次再补 */ }
    }
    active.add(this.file)
    try { await this.persist(); this.started = true }
    catch (error) { active.delete(this.file); throw error }
  }

  async observe(event, data) {
    if (event !== 'SSE_ACK') return
    const meta = data.ack_client_meta
    if (meta?.local_conversation_id !== this.record.localId) {
      throw new ProviderError('豆包确认的临时会话与本次请求不匹配。', 502, 'conversation_ownership_error')
    }
    const id = String(meta.conversation_id ?? '')
    if (!/^[1-9]\d*$/.test(id)) return
    if (this.record.conversationId && this.record.conversationId !== id) {
      throw new ProviderError('豆包返回了多个临时会话标识。', 502, 'conversation_ownership_error')
    }
    if (!this.record.conversationId) {
      this.record.conversationId = id
      await this.persist()
    }
  }

  async finish(originalError) {
    if (!this.started) return
    this.cleanup ??= (async () => {
      try {
        await removeOwned(this.session, this.record)
        await unlink(this.file)
      } catch (cause) {
        this.record.retry = true
        try { await this.persist() } catch { /* 目录不可写时只能放弃 */ }
        // 清理失败不该把已经拿到的回复变成错误，用户侧只关心内容
        if (!originalError) throw new ProviderError(`临时会话清理失败：${cause.message}`, 502, 'conversation_cleanup_failed', { cause })
      } finally {
        active.delete(this.file)
      }
    })()
    return this.cleanup
  }
}
