import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareRequest, upstreamBody, decodeReply } from '../lib/protocol.mjs'
import { normalizeQuota } from '../lib/quota.mjs'

test('普通对话：历史与系统指令编进提示词', () => {
  const prepared = prepareRequest({
    model: 'auto',
    messages: [
      { role: 'system', content: '你是一个严谨的助手。' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
      { role: 'user', content: '继续' },
    ],
  })
  assert.equal(prepared.request.model, 'auto')
  assert.equal(prepared.tools, undefined)
  assert.ok(prepared.prompt.includes('你是一个严谨的助手。'))
  assert.ok(prepared.prompt.includes('"role":"user"'))
})

test('多段 content 数组被拼成文本', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: '前' }, { type: 'text', text: '后' }] }],
  })
  assert.ok(prepared.prompt.includes('前后'))
})

test('带工具时提示词里带上协议与工具定义', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: '读文件' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  })
  assert.ok(prepared.tools)
  assert.ok(prepared.prompt.includes('工具传输协议'))
  assert.ok(prepared.prompt.includes('read_file'))
})

test('tool_choice=none 时不带工具', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'x' } }],
    tool_choice: 'none',
  })
  assert.equal(prepared.tools, undefined)
})

test('上游请求体带齐桌面端需要的字段', () => {
  const session = { bot: '123456' }
  const prepared = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  const selected = {
    itemId: 11, key: 'deepseek-v4-1-flash', modeId: 'mode_office', agentMode: 7,
    extraParams: { provider_id: 'deepseek' }, level: 5,
  }
  const body = upstreamBody(session, prepared, selected)
  assert.equal(body.client_meta.bot_id, '123456')
  assert.match(body.client_meta.local_conversation_id, /^local_[a-f0-9]{32}$/)
  assert.equal(body.option.model_config.model_item_key, 'deepseek-v4-1-flash')
  assert.equal(body.option.aggregate_params.provider_id, 'deepseek')
  assert.equal(body.option.conversation_init_ext.reasoning_effort, '5')
  assert.equal(body.messages[0].content_block[0].content.text_block.text, prepared.prompt)
})

test('解析工具回复', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
  })
  const message = decodeReply('{"content":"","tool_calls":[{"name":"read_file","arguments":{"path":"a"}}]}', prepared)
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].function.name, 'read_file')
  assert.equal(JSON.parse(message.tool_calls[0].function.arguments).path, 'a')
})

test('不需要工具时直接返回正文', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 't' } }],
    tool_choice: 'auto',
  })
  const message = decodeReply('就是一段普通回答', prepared)
  assert.equal(message.content, '就是一段普通回答')
  assert.equal(message.tool_calls, undefined)
})

test('工具回复被截断时不作废整轮：能救回的调用照常交出', () => {
  // 模型中途停下，外层 JSON 没闭合（issue #4）。前面完整的调用仍然可用
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [
      { type: 'function', function: { name: 'shell', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'submit', parameters: { type: 'object' } } },
    ],
    tool_choice: 'auto',
  })
  const message = decodeReply('{"content":"ok","tool_calls":[{"name":"shell","arguments":{"command":"ls"}},{"name":"submit","arguments":{"r":"没写完', prepared)
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].function.name, 'shell')
  assert.equal(message.content, 'ok')
})

test('工具回复截断且救不回调用时，当普通回复返回而不是 502', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'submit', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  })
  const message = decodeReply('{"content":"我要提交报告","tool_calls":[{"name":"submit","arguments":{"report":"第一段很长…综合判断抓', prepared)
  // 半截 JSON 不要原样丢给客户端，只还内容
  assert.equal(message.content, '我要提交报告')
  assert.equal(message.tool_calls, undefined)
})

test('required 下截断仍报错，因为客户端要的是确定的调用', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 'submit', parameters: { type: 'object' } } }],
    tool_choice: 'required',
  })
  assert.throws(
    () => decodeReply('{"content":"","tool_calls":[{"name":"submit","arguments":{"r":"没写完', prepared),
    (error) => error.code === 'invalid_tool_response',
  )
})

test('tool_choice=required 但没返回调用时报错', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 't' } }],
    tool_choice: 'required',
  })
  assert.throws(() => decodeReply('普通回答', prepared), /工具调用/)
})

test('返回未声明的工具时报错', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    tools: [{ type: 'function', function: { name: 't' } }],
  })
  assert.throws(() => decodeReply('{"content":"","tool_calls":[{"name":"evil","arguments":{}}]}', prepared), /未声明的工具/)
})

test('json_object 校验', () => {
  const prepared = prepareRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    response_format: { type: 'json_object' },
  })
  assert.deepEqual(decodeReply('{"a":1}', prepared).content, '{"a":1}')
  assert.throws(() => decodeReply('不是json', prepared), /合法 JSON/)
  assert.throws(() => decodeReply('[1,2]', prepared), /JSON 对象/)
})

test('额度：多额度池与到期字段', () => {
  const overview = { current_subscription: { display: { short_name: 'Pro' }, end_time: 1799999999 } }
  const summary = {
    window_limit_section: {
      usage_exhausted: false,
      window_limit_groups: [{
        feature_group_name: '豆包工作',
        window_limits: [{ used_percent: 42, used_amount: 420, total_amount: 1000, end_time: 1800000000 }],
      }],
    },
    incentive_quota_section: {
      usage_exhausted: true,
      window_limit_groups: [{
        feature_group_name: '新人赠送',
        window_limits: [{ used_percent: 100, used_amount: 50, total_amount: 50, end_time: 1801000000 }],
      }],
    },
  }
  const quota = normalizeQuota(overview, summary, '小明')
  assert.equal(quota.plan, 'Pro')
  assert.equal(quota.windows.length, 2)
  const [sub, gift] = quota.windows
  assert.equal(sub.amount, 420)
  assert.equal(sub.limit, 1000)
  assert.equal(sub.unit, '积分')
  assert.ok(sub.resetsAt)
  assert.equal(gift.aside, true, '另一池还有余量时，耗尽的池应标记 aside')
  assert.ok(gift.runsOutAt)
  assert.equal(gift.runsOut, 0)
})

test('额度接口什么都没给时不编造数值', () => {
  const quota = normalizeQuota({}, {}, 'u')
  assert.deepEqual(quota.windows, [])
  assert.equal(quota.plan, '豆包工作')
})

test('30 天赠送订阅要在套餐名上标出来', () => {
  // 以前完全不读 is_membership_gift，有赠送的用户看着像没订阅。
  const overview = {
    is_membership_gift: true,
    current_subscription: { display: { short_name: '免费体验' }, end_time: 1797219471986 },
  }
  assert.equal(normalizeQuota(overview, {}, 'u').plan, '免费体验（赠送）')
  const plain = { is_membership_gift: false, current_subscription: { display: { short_name: '免费体验' } } }
  assert.equal(normalizeQuota(plain, {}, 'u').plan, '免费体验')
})

test('有总量时显示「已用 / 上限」，不被 used_percent 抢走', () => {
  // 赠送套餐恒返回 used_percent: 0 且同时给 total/used，旧代码只看百分比，
  // 界面上只剩「近 7 天 0」，看不到 500 的上限。
  const summary = {
    window_limit_section: {
      window_limit_groups: [{
        feature_group_name: '个人订阅',
        window_limits: [{ total_amount: '500', used_amount: '0', used_percent: 0, end_time: 0 }],
      }],
    },
  }
  const [w] = normalizeQuota({}, summary, 'u').windows
  assert.equal(w.amount, 0)
  assert.equal(w.limit, 500)
  assert.match(w.display, /0 \/ 500/)
})

test('活动赠送卡做成额度窗口', () => {
  // 免费体验账号的额度常常只存在于 marketing/card/list 里，不读就显示「暂无额度」。
  const cards = {
    data: {
      cards: [{
        card_key: 'quota_reset_card',
        source_display_text: '活动赠送',
        expire_time: new Date(Date.now() + 86400_000).toISOString(),
        track_params: { card_balance: 1, valid_days: 30 },
        usable_on_current_device: true,
      }],
    },
  }
  const [w] = normalizeQuota({}, {}, 'u', null, cards).windows
  assert.match(w.name, /活动赠送/)
  assert.equal(w.amount, 1)
  assert.match(w.display, /剩 1 次/)
  assert.ok(w.runsOutAt)
})

test('签到状态做成额度窗口：未签时提示去客户端', () => {
  const quota = normalizeQuota({}, {}, 'u', { found: true, claimed: false, points: 200, streak: 2 })
  const signin = quota.windows.find((w) => w.name.startsWith('每日签到'))
  assert.ok(signin, '额度卡片应含签到窗口')
  assert.match(signin.name, /今日未签/)
  assert.match(signin.name, /可领 200 额度/)
  assert.equal(signin.usedNote, '需去豆包电脑版领')
  assert.equal(signin.streak, 2)
  assert.equal(signin.credit, 200)
})

test('已签到时显示连续天数', () => {
  const quota = normalizeQuota({}, {}, 'u', { found: true, claimed: true, points: 200, streak: 7 })
  const signin = quota.windows.find((w) => w.name.startsWith('每日签到'))
  assert.match(signin.name, /今日已签/)
  assert.match(signin.name, /连续 7 天/)
  assert.equal(signin.usedNote, '已领取')
})

test('没有签到活动时不显示签到窗口', () => {
  assert.deepEqual(normalizeQuota({}, {}, 'u', { found: false }).windows, [])
  assert.deepEqual(normalizeQuota({}, {}, 'u', undefined).windows, [])
})

test('签到字段缺失时窗口仍可用，不出现 undefined', () => {
  const quota = normalizeQuota({}, {}, 'u', { found: true, claimed: false })
  const signin = quota.windows[0]
  assert.equal(signin.name, '每日签到（今日未签）')
  assert.equal(signin.credit, undefined)
  assert.equal(signin.streak, undefined)
})

test('推理档位传数字时归一化成名字，不静默丢弃', () => {
  // 少数客户端按 3/4/5… 传档位，直接丢掉会让用户以为档位设置没生效
  const numeric = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 3 })
  assert.equal(numeric.request.reasoning_effort, 'low')

  const high = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 5 })
  assert.equal(high.request.reasoning_effort, 'high')

  // 名字照常透传
  const named = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'max' })
  assert.equal(named.request.reasoning_effort, 'max')

  // 认不出的值当作没给，交给模型的默认档位
  const unknown = prepareRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 99 })
  assert.equal(unknown.request.reasoning_effort, undefined)
})

test('赠送额度用满但 usage_exhausted 仍为 false 时，也要标 aside（issue #20）', () => {
  // 实测有的账号活动赠送额度已经 1600/1600（已用 100%），
  // 但服务端返回 usage_exhausted: false。只看标志会让 magpie 拿满格的
  // 赠送池当总体进度，界面显示「几乎用尽」，而订阅额度其实还剩八成。
  const summary = {
    window_limit_section: {
      usage_exhausted: false,
      window_limit_groups: [{
        feature_group_name: '订阅额度',
        window_limits: [{ used_amount: 293, total_amount: 2142, used_percent: 13 }],
      }],
    },
    incentive_quota_section: {
      usage_exhausted: false, // 服务端没置 true
      window_limit_groups: [{
        feature_group_name: '活动赠送额度',
        window_limits: [{ used_amount: 1600, total_amount: 1600, used_percent: 100 }],
      }],
    },
  }
  const quota = normalizeQuota({}, summary, 'u')
  const gift = quota.windows.find((w) => w.name.includes('活动赠送'))
  const sub = quota.windows.find((w) => w.name.includes('订阅额度'))
  assert.equal(gift.aside, true, '用满的赠送池应标 aside，不参与总体判断')
  assert.equal(sub.aside, false, '还有余量的订阅池不该标 aside')
})

test('两个池都满时不标 aside（账号确实没额度了）', () => {
  const summary = {
    window_limit_section: {
      usage_exhausted: true,
      window_limit_groups: [{ feature_group_name: '订阅额度', window_limits: [{ used_amount: 100, total_amount: 100, used_percent: 100 }] }],
    },
    incentive_quota_section: {
      usage_exhausted: true,
      window_limit_groups: [{ feature_group_name: '活动赠送额度', window_limits: [{ used_amount: 50, total_amount: 50, used_percent: 100 }] }],
    },
  }
  const quota = normalizeQuota({}, summary, 'u')
  for (const w of quota.windows) assert.equal(w.aside, false, `${w.name} 不该标 aside`)
})
