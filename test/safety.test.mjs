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

test('checkin 只读：不发领取请求', async () => {
  const calls = []
  const session = {
    ready: async () => {},
    json: async (path) => {
      calls.push(path)
      return { tasks: [{ campaign_code: 'daily_signin', campaign_group_code: 'g', daily_checkin: { checked_in_today: false, reward: { reward_amount: 200 }, continuous_days: 3 } }] }
    },
    request: async (path) => {
      calls.push(`WRITE:${path}`)
      throw new Error('不该发出写请求')
    },
  }
  const result = await checkin(session)
  assert.equal(result.outcome, 'ineligible')
  assert.equal(result.credit, 200)
  assert.equal(result.streak, 3)
  assert.deepEqual(calls, ['/alice/ug/campaign/v3/detail/'], '只应读详情，不应发领取请求')
})

test('checkin 已签时返回 done', async () => {
  const session = {
    ready: async () => {},
    json: async () => ({ tasks: [{ campaign_code: 'daily_signin', daily_checkin: { checked_in_today: true, reward: { reward_amount: 200 }, continuous_days: 7 } }] }),
    request: async () => { throw new Error('不该发请求') },
  }
  const result = await checkin(session)
  assert.equal(result.outcome, 'done')
  assert.match(result.message, /连续 7 天/)
})

test('checkin 没有活动时返回 inactive', async () => {
  const session = {
    ready: async () => {},
    json: async () => ({ tasks: [] }),
    request: async () => { throw new Error('不该发请求') },
  }
  const result = await checkin(session)
  assert.equal(result.outcome, 'inactive')
})
