import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopSession } from '../lib/session.mjs'

// 签到账本写到临时目录，别碰真实数据
const dir = await mkdtemp(join(tmpdir(), 'doubao-checkin-test-'))
process.env.DOUBAO_WORK_LEDGER = dir
const { checkin } = await import('../lib/checkin.mjs')

test('exclusive 串行执行，不会并发', async () => {
  const session = new DesktopSession({})
  let running = 0
  let peak = 0
  const order = []

  const tasks = [1, 2, 3].map((n) => session.exclusive(async () => {
    running++
    peak = Math.max(peak, running)
    order.push(`start-${n}`)
    await new Promise((r) => setTimeout(r, 30))
    order.push(`end-${n}`)
    running--
    return n
  }))

  const results = await Promise.all(tasks)
  assert.deepEqual(results, [1, 2, 3])
  assert.equal(peak, 1, '同一时刻只应有一个任务在跑')
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3'])
})

test('exclusive 里抛错不会堵死队列', async () => {
  const session = new DesktopSession({})
  const failed = session.exclusive(async () => { throw new Error('boom') })
  const next = session.exclusive(async () => 'ok')
  await assert.rejects(failed, /boom/)
  assert.equal(await next, 'ok')
})

/** 造一个只读会话：所有写请求都会记下来 */
function fakeSession(state, { claimResult, ledger } = {}) {
  if (ledger) process.env.DOUBAO_WORK_LEDGER = ledger
  const writes = []
  return {
    writes,
    ready: async () => {},
    uid: `uid-${Math.random().toString(36).slice(2)}`,
    profile: 'test',
    json: async (path) => {
      if (path.includes('/detail/')) return { data: { tasks: [state] } }
      return {}
    },
    request: async (path, body) => {
      writes.push({ path, body })
      if (claimResult instanceof Error) throw claimResult
      return new Response(JSON.stringify(claimResult ?? { code: 0, data: {} }), { headers: { 'content-type': 'application/json' } })
    },
  }
}

const task = (overrides = {}) => ({
  campaign_code: 'daily_signin',
  campaign_group_code: 'pc_incentive_task_mvp_v3',
  reward_mode: 2,
  task_status: 1,
  daily_checkin: { checked_in_today: false, reward: { reward_amount: 200 }, continuous_days: 3, ...overrides },
})

test('已签到时只读，不发领取请求', async () => {
  const session = fakeSession(task({ checked_in_today: true }))
  const result = await checkin(session)
  assert.equal(result.outcome, 'done')
  assert.match(result.message, /连续 3 天/)
  assert.deepEqual(session.writes, [], '已签到时不应发任何写请求')
})

test('没有签到活动时只读', async () => {
  const session = fakeSession({ campaign_code: 'other', task_kind: 'chat_activity' })
  const result = await checkin(session)
  assert.equal(result.outcome, 'inactive')
  assert.deepEqual(session.writes, [])
})

test('未签时提交一次领取，用正确的字段名', async () => {
  const session = fakeSession(task(), { claimResult: { code: 0, data: { checked_in: true } } })
  await checkin(session)
  assert.equal(session.writes.length, 1)
  assert.equal(session.writes[0].path, '/alice/ug/campaign/item/reward/claim/')
  assert.deepEqual(session.writes[0].body, {
    task_id: '',
    campaign_group_code: 'pc_incentive_task_mvp_v3',
    campaign_item_code: 'daily_signin',
  })
})

test('同一天第二次调用不会重复提交', async () => {
  const session = fakeSession(task(), { claimResult: { code: 0, data: {} } })
  const first = await checkin(session)
  const writesAfterFirst = session.writes.length
  const second = await checkin(session)
  assert.equal(session.writes.length, writesAfterFirst, '第二次不应再发领取请求')
  assert.ok(['failed', 'claimed', 'done'].includes(second.outcome))
})

test('遇到风控验证码返回 captcha 且不再提交', async () => {
  const error = new Error('需要验证')
  error.status = 429
  const session = fakeSession(task(), { claimResult: error })
  const result = await checkin(session)
  assert.equal(result.outcome, 'captcha')
  assert.match(result.message, /人工验证/)
})

test('清理临时账本', async () => {
  await rm(dir, { recursive: true, force: true })
})
