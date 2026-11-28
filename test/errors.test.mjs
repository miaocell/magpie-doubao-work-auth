/**
 * 上游错误码映射。
 *
 * 这里的映射决定 magpie 怎么处理失败：401 会把账号标成要重登，429 会换账号，
 * 403/400 只当成这一次失败。映射错了会把偶发问题升级成账号失效，所以逐个锁住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { upstreamError, ProviderError, errorResponse } from '../lib/errors.mjs'

test('登录失效映射成 401，并要求 magpie 标记账号', () => {
  const expired = upstreamError({ error_code: 710012001, error_msg: 'login invalid' })
  assert.equal(expired.status, 401)
  assert.equal(expired.code, 'sign_in_expired')
  assert.equal(expired.signIn, 'expired')
})

test('风控验证映射成 403，但不标记账号', () => {
  const captcha = upstreamError({ error_code: 710022004, error_msg: 'rate limited' })
  assert.equal(captcha.status, 403)
  assert.equal(captcha.code, 'captcha_required')
  // 验证码是临时的，标记账号会让它被永久停用
  assert.equal(captcha.signIn, undefined)
  // 上游只说 rate limited，得补一句能照做的提示，否则用户以为是限流
  assert.match(captcha.message, /doubao\.com\/chat/)
})

test('参数类错误映射成 400，两个相近的码都要覆盖', () => {
  assert.equal(upstreamError({ error_code: 710010202, error_msg: 'common invalid param' }).code, 'invalid_param')
  assert.equal(upstreamError({ error_code: 710020202, error_msg: 'common invalid param' }).code, 'invalid_param')
  const error = upstreamError({ error_code: 710010202, error_msg: 'common invalid param' })
  assert.equal(error.status, 400)
  // 原始消息要保留，不能只剩提示
  assert.match(error.message, /common invalid param/)
})

test('限流映射成 429', () => {
  assert.equal(upstreamError({ error_code: 710012004 }).status, 429)
})

test('未知错误落到 fallback 状态，不当成账号问题', () => {
  const unknown = upstreamError({ error_code: 999999, message: '啥' }, 502)
  assert.equal(unknown.status, 502)
  assert.equal(unknown.code, 'upstream_error')
  assert.equal(unknown.signIn, undefined)
})

test('errorResponse 保留 type 与 code，登录类额外带响应头', () => {
  const plain = errorResponse(new ProviderError('出错了', 400, 'invalid_param'))
  assert.equal(plain.status, 400)
  assert.equal(plain.headers.get('X-Magpie-Sign-In'), null)

  const expired = errorResponse(new ProviderError('要重登', 401, 'sign_in_expired', { signIn: 'expired' }))
  assert.equal(expired.headers.get('X-Magpie-Sign-In'), 'expired')
})

test('风控验证带 X-Magpie-Refused，让 magpie 不要换账号重试', async () => {
  // magpie 默认把 403 当作「换个账号可能就好」，会连打多次。
  // 风控不是换账号能解决的，重试只会把风控状态堆得更高，所以必须标成拒绝。
  const error = upstreamError({ error_code: 710022004, error_msg: 'rate limited' })
  assert.equal(error.code, 'captcha_required')
  assert.ok(error.refused, '风控错误应带 refused 标记')

  const response = errorResponse(error)
  const header = response.headers.get('X-Magpie-Refused')
  assert.ok(header, '响应里要有 X-Magpie-Refused 头')
  // 头只能是 ASCII，中文说明得编码过
  assert.match(header, /^[\x21-\x7e]+$/)
  assert.match(decodeURIComponent(header), /doubao\.com\/chat/)
})

test('普通错误不带 refused，仍允许 magpie 换账号', () => {
  // 真的只是限流（没有 decision）时才允许重试/换账号
  const error = upstreamError({ error_code: 710012004 }, 429)
  assert.equal(error.refused, undefined)
  assert.equal(errorResponse(error).headers.get('X-Magpie-Refused'), null)
})

test('风控走 429（710012004 + decision）也要 refused，不能当普通限流重试', async () => {
  // Issue #22：豆包有两条风控出口，710022004 走 403、710012004 走 429。
  // 429 这条以前当普通限流，magpie 按 1s/2s/4s… 退避重试到 8 次，
  // 每次都真实打到上游，账号永远解不开。
  const decision = JSON.stringify({ subtype: 'semantic_reasoning' })
  const error = upstreamError({
    error_code: 710012004,
    error_msg: 'rate limited',
    extra: { decision },
  })

  assert.equal(error.status, 429, '状态码保持 429，不改上游语义')
  assert.equal(error.code, 'captcha_required', '但按风控处理')
  assert.ok(error.refused, '风控 429 必须带 refused')

  const response = errorResponse(error)
  assert.equal(response.status, 429)
  const header = response.headers.get('X-Magpie-Refused')
  assert.ok(header, '响应里要有 X-Magpie-Refused 头')
  assert.match(header, /^[\x21-\x7e]+$/)
})

test('风控 429 的文案按 subtype 分开，不是一律「去网页验证」', () => {
  // subtype 说是限流时，就不该让人跑去网页点验证——点了也没用
  const rate = upstreamError({
    error_code: 710012004,
    error_msg: 'rate limited',
    extra: { decision: JSON.stringify({ subtype: 'rate_limit' }) },
  })
  assert.match(rate.message, /停几分钟/)
  assert.ok(rate.refused, '就算 subtype 是限流，带 decision 也说明是风控，仍不重试')

  // subtype 说是设备/会话异常时，提示要指向重新登录
  const device = upstreamError({
    error_code: 710012004,
    error_msg: 'rate limited',
    extra: { decision: JSON.stringify({ subtype: 'device_check' }) },
  })
  assert.match(device.message, /重新登录/)
})
