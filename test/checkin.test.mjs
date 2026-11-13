import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCheckin, beijingDay, CAMPAIGN_SCENE, SIGNIN_TASK, campaignGroup, checkin, _internal } from '../lib/checkin.mjs'
import { parseCookieHeader, cookiesFromHeader, clientInfoFromCookies } from '../lib/cookie-import.mjs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 签到账本放临时目录，探测循环别写真实数据
process.env.DOUBAO_WORK_LEDGER = await mkdtemp(join(tmpdir(), 'doubao-checkin-edge-'))

/** 造一份和 v3/detail 同形的详情 */
function detail(tasks) {
  return { data: { campaign_code: CAMPAIGN_SCENE, milestones: [], progress: { total_amount: 1500 }, tasks } }
}

const signin = (overrides = {}) => ({
  campaign_code: SIGNIN_TASK,
  campaign_group_code: CAMPAIGN_SCENE,
  reward_mode: 2,
  task_kind: 'daily_signin',
  task_status: 1,
  title: '每日签到',
  daily_checkin: {
    checked_in_today: false,
    continuous_days: 2,
    last_checkin_date: '2026-11-12',
    reward: { reward_amount: 200, reward_type: 'quota_grant' },
    total_days: 2,
    ...overrides,
  },
})

test('从 launch 读账号实际投放的活动组', () => {
  assert.equal(_internal.campaignGroup({ ug_campaign_info: { campaign_group_code: 'pc_incentive_task_mvp_v3' } }), 'pc_incentive_task_mvp_v3')
  // 没投放的账号返回空字符串
  assert.equal(_internal.campaignGroup({ ug_campaign_info: { campaign_group_code: '' } }), '')
  assert.equal(_internal.campaignGroup({}), '')
  assert.equal(_internal.campaignGroup(undefined), '')
})

test('campaign not found 判定为未投放，不是故障', async () => {
  const err = new Error('campaign not found')
  const session = {
    ready: async () => {},
    uid: 'u1', profile: 'p',
    launch: { ug_campaign_info: { campaign_group_code: 'g1' } },
    json: async (path) => {
      if (path.includes('/detail/')) throw err
      return {}
    },
    request: async () => { throw new Error('不该发写请求') },
  }
  const result = await checkin(session)
  assert.equal(result.outcome, 'inactive')
  assert.match(result.message, /没有投放签到活动/)
})

test('签到活动组与任务名是实测值', () => {
  assert.equal(CAMPAIGN_SCENE, 'pc_incentive_task_mvp_v3')
  assert.equal(SIGNIN_TASK, 'daily_signin')
})

test('领取接口是 item/reward/claim，不是 landing/checkin', () => {
  assert.equal(_internal.CLAIM_PATH, '/alice/ug/campaign/item/reward/claim/')
  assert.equal(_internal.DETAIL_PATH, '/alice/ug/campaign/v3/detail/')
})

test('读到未签到状态与奖励', () => {
  const state = readCheckin(detail([signin()]))
  assert.equal(state.found, true)
  assert.equal(state.claimed, false)
  assert.equal(state.points, 200)
  assert.equal(state.streak, 2)
  assert.equal(state.group, CAMPAIGN_SCENE)
})

test('reward_mode=2 的任务用 campaign_item_code 组装领取体', () => {
  const state = readCheckin(detail([signin()]))
  assert.equal(state.claimable, true)
  assert.deepEqual(state.body, {
    task_id: '',
    campaign_group_code: CAMPAIGN_SCENE,
    campaign_item_code: SIGNIN_TASK,
  })
})

test('非 direct 任务用 task_id 组装领取体', () => {
  const task = {
    campaign_code: 'some_task',
    campaign_group_code: CAMPAIGN_SCENE,
    reward_mode: 1,
    task_status: 2,
    task_id: 'tid-123',
    daily_checkin: { checked_in_today: false },
  }
  const state = readCheckin(detail([task]))
  assert.deepEqual(state.body, { task_id: 'tid-123' })
})

test('任务不满足条件时没有领取体', () => {
  const state = readCheckin(detail([signin({ checked_in_today: false })].map((t) => ({ ...t, task_status: 3 }))))
  assert.equal(state.claimable, false)
  assert.equal(state.body, undefined)
})

test('读到已签到状态', () => {
  const state = readCheckin(detail([signin({ checked_in_today: true })]))
  assert.equal(state.claimed, true)
})

test('没有签到任务时 found=false，不瞎猜', () => {
  const state = readCheckin(detail([{ campaign_code: 'other', task_kind: 'chat_activity' }]))
  assert.equal(state.found, false)
})

test('详情结构异常时不崩', () => {
  assert.equal(readCheckin({}).found, false)
  assert.equal(readCheckin(null).found, false)
  assert.equal(readCheckin({ data: { tasks: null } }).found, false)
})

test('奖励字段缺失时不编造数值', () => {
  const state = readCheckin(detail([{ campaign_code: SIGNIN_TASK, daily_checkin: { checked_in_today: false } }]))
  assert.equal(state.points, undefined)
  assert.equal(state.streak, undefined)
})

test('北京时间分日按 Asia/Shanghai 算', () => {
  // 2026-11-13 00:30 UTC 是北京时间 08:30，同一天
  assert.equal(beijingDay(new Date('2026-11-13T00:30:00Z')), '2026-11-13')
  // 2026-11-12 16:30 UTC 是北京时间 13 日 00:30，应算 13 日
  assert.equal(beijingDay(new Date('2026-11-12T16:30:00Z')), '2026-11-13')
  // 2026-11-12 15:30 UTC 是北京时间 12 日 23:30
  assert.equal(beijingDay(new Date('2026-11-12T15:30:00Z')), '2026-11-12')
})

test('Cookie 头解析', () => {
  const parsed = parseCookieHeader('Cookie: sessionid=abc; ttwid=xyz; empty=')
  assert.equal(parsed.sessionid, 'abc')
  assert.equal(parsed.ttwid, 'xyz')
  assert.equal(parsed.empty, '')
})

test('没有 sessionid 的 Cookie 被拒绝', () => {
  assert.throws(() => cookiesFromHeader('ttwid=only'), /sessionid/)
})

test('sessionid_ss 也可以', () => {
  const cookies = cookiesFromHeader('sessionid_ss=zzz')
  assert.equal(cookies[0].name, 'sessionid_ss')
  assert.equal(cookies[0].domain, 'doubao.com')
})

test('设备标识能从 Cookie 里取到就取，取不到留空', () => {
  const withIds = clientInfoFromCookies([
    { name: 'device_id', value: '123456' },
    { name: 'web_id', value: '654321' },
    { name: 'tea_uuid', value: '111222' },
    { name: 's_v_web_id', value: 'verify_abc' },
  ])
  assert.equal(withIds.deviceId, '123456')
  assert.equal(withIds.webId, '654321')
  assert.equal(withIds.teaUuid, '111222')
  assert.equal(withIds.fingerprint, 'verify_abc')

  const empty = clientInfoFromCookies([{ name: 'sessionid', value: 'x' }])
  assert.equal(empty.deviceId, '')
})
