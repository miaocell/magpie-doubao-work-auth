import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DesktopSession } from '../lib/session.mjs'
import { checkin } from '../lib/checkin.mjs'

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

/** 造一个会记录所有写请求的会话 */
function fakeSession(tasks) {
  const writes = []
  return {
    writes,
    ready: async () => {},
    uid: 'uid-readonly',
    profile: 'test',
    launch: { ug_campaign_info: { campaign_group_code: 'pc_incentive_task_mvp_v3' } },
    json: async (path) => {
      if (path.includes('/detail/')) return { data: { tasks } }
      return {}
    },
    request: async (path) => {
      writes.push(path)
      throw new Error('只读实现不该发写请求')
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

test('签到全程只读，不发任何写请求', async () => {
  const session = fakeSession([task()])
  const result = await checkin(session)
  assert.ok(['ineligible', 'inactive', 'done'].includes(result.outcome))
  assert.deepEqual(session.writes, [], '签到不应发出写请求')
})

test('已签到时只读', async () => {
  const session = fakeSession([task({ checked_in_today: true })])
  const result = await checkin(session)
  assert.equal(result.outcome, 'done')
  assert.match(result.message, /连续 3 天/)
  assert.deepEqual(session.writes, [])
})

test('没有签到活动时只读', async () => {
  const session = fakeSession([{ campaign_code: 'other', task_kind: 'chat_activity' }])
  const result = await checkin(session)
  assert.equal(result.outcome, 'inactive')
  assert.deepEqual(session.writes, [])
})

test('多次调用都不发写请求', async () => {
  const session = fakeSession([task()])
  await checkin(session)
  await checkin(session)
  await checkin(session)
  assert.deepEqual(session.writes, [], '重复调用也不该产生写请求')
})
