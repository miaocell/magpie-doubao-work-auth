import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCheckin, CAMPAIGN_SCENE, SIGNIN_TASK, campaignGroup, checkin, _internal } from '../lib/checkin.mjs'
import { parseCookieHeader, cookiesFromHeader, clientInfoFromCookies } from '../lib/cookie-import.mjs'

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

test('签到活动组与任务名是实测值', () => {
  assert.equal(CAMPAIGN_SCENE, 'pc_incentive_task_mvp_v3')
  assert.equal(SIGNIN_TASK, 'daily_signin')
})

test('只读钩子不再导出领取接口', () => {
  assert.equal(_internal.DETAIL_PATH, '/alice/ug/campaign/v3/detail/')
  assert.equal('CLAIM_PATH' in _internal, false, '只读实现不该有领取接口常量')
})

test('从 launch 读账号实际投放的活动组', () => {
  assert.equal(campaignGroup({ ug_campaign_info: { campaign_group_code: 'pc_incentive_task_mvp_v3' } }), 'pc_incentive_task_mvp_v3')
  // 没投放的账号返回空字符串
  assert.equal(campaignGroup({ ug_campaign_info: { campaign_group_code: '' } }), '')
  assert.equal(campaignGroup({}), '')
  assert.equal(campaignGroup(undefined), '')
})

test('读到未签到状态与奖励', () => {
  const state = readCheckin(detail([signin()]))
  assert.equal(state.found, true)
  assert.equal(state.claimed, false)
  assert.equal(state.points, 200)
  assert.equal(state.streak, 2)
  assert.equal(state.group, CAMPAIGN_SCENE)
})

test('task_status 1 判定为不可领', () => {
  const state = readCheckin(detail([signin({ })].map((t) => ({ ...t, task_status: 1 }))))
  assert.equal(state.claimable, false)
  assert.equal(state.status, 1)
})

test('task_status 2 才可领', () => {
  const state = readCheckin(detail([signin()].map((t) => ({ ...t, task_status: 2 }))))
  assert.equal(state.claimable, true)
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

/** 造一个会记录写请求的会话 */
function fakeSession({ launch = { ug_campaign_info: { campaign_group_code: CAMPAIGN_SCENE } }, detailPayload, detailError } = {}) {
  const writes = []
  return {
    writes,
    ready: async () => {},
    uid: 'u1',
    profile: 'p',
    launch,
    json: async (path) => {
      if (path.includes('/detail/')) {
        if (detailError) throw detailError
        return detailPayload ?? { data: { tasks: [signin()] } }
      }
      if (path.includes('/launch')) return launch
      return {}
    },
    request: async (path) => {
      writes.push(path)
      throw new Error('只读实现不该发写请求')
    },
  }
}

test('没投放活动时返回 inactive 且不发写请求', async () => {
  const session = fakeSession({ launch: { ug_campaign_info: { campaign_group_code: '' } } })
  const result = await checkin(session)
  assert.equal(result.outcome, 'inactive')
  assert.match(result.message, /没有投放签到活动/)
  assert.deepEqual(session.writes, [])
})

test('campaign not found 判定为未投放，不是故障', async () => {
  const session = fakeSession({ detailError: new Error('campaign not found') })
  const result = await checkin(session)
  assert.equal(result.outcome, 'inactive')
  assert.deepEqual(session.writes, [])
})

test('不可领时说明原因，不发写请求', async () => {
  const session = fakeSession()
  const result = await checkin(session)
  assert.equal(result.outcome, 'ineligible')
  assert.match(result.message, /没被投放/)
  assert.equal(result.credit, 200)
  assert.deepEqual(session.writes, [], '只读实现不应提交领取')
})

test('已签到时返回 done', async () => {
  const session = fakeSession({ detailPayload: { data: { tasks: [signin({ checked_in_today: true })] } } })
  const result = await checkin(session)
  assert.equal(result.outcome, 'done')
  assert.match(result.message, /连续 2 天/)
  assert.deepEqual(session.writes, [])
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
