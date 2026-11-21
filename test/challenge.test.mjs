import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DesktopSession } from '../lib/session.mjs'

function fakeSession() {
  const s = new DesktopSession({ uid: 'x' })
  s.json = async () => ({})
  return s
}

test('noteChallenge 设置 5 分钟冷却并重置探测时间点', () => {
  const s = fakeSession()
  s.lastProbeAt = 12345
  s.noteChallenge()
  assert.ok(s.challengeLeft() > 290_000)
  assert.equal(s.lastProbeAt, 0)
})

test('探测成功（上游放行）提前清除冷却', async () => {
  const s = fakeSession()
  s.noteChallenge()
  assert.ok(s.challengeLeft() > 0)
  const ok = await s.probeChallenge()
  assert.equal(ok, true)
  assert.equal(s.challengeLeft(), 0)
})

test('探测仍被 captcha 拦时保留冷却并续期', async () => {
  const s = fakeSession()
  s.noteChallenge()
  s.json = async () => { throw Object.assign(new Error('验证'), { code: 'captcha_required', status: 403 }) }
  const ok = await s.probeChallenge()
  assert.equal(ok, false)
  assert.ok(s.challengeLeft() > 0)
})

test('30 秒内不重复探测，避免推后风控解除', async () => {
  const s = fakeSession()
  s.noteChallenge()
  s.json = async () => { throw Object.assign(new Error('验证'), { code: 'captcha_required', status: 403 }) }
  let calls = 0
  const orig = s.json
  s.json = async () => { calls++; return orig() }
  await s.probeChallenge() // 第一次探，仍被拦
  assert.equal(calls, 1)
  await s.probeChallenge() // 距上次不到 30s，不重探
  assert.equal(calls, 1)
})

test('非 captcha 的网络错误不动冷却', async () => {
  const s = fakeSession()
  s.noteChallenge()
  const before = s.challengeLeft()
  s.json = async () => { throw new Error('network') }
  const ok = await s.probeChallenge()
  assert.equal(ok, false)
  assert.ok(s.challengeLeft() <= before) // 没有被续期
})
