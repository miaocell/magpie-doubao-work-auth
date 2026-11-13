import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareRequest, upstreamBody, decodeReply } from '../lib/protocol.mjs'
import { normalizeQuota } from '../lib/quota.mjs'

test('普通对话：历史与系统指令编进提示词', () => {
  const prepared = prepareRequest({
    model: 'doubao-auto',
    messages: [
      { role: 'system', content: '你是一个严谨的助手。' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
      { role: 'user', content: '继续' },
    ],
  })
  assert.equal(prepared.request.model, 'doubao-auto')
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

test('签到状态做成额度窗口：未签时提示去客户端', () => {
  const quota = normalizeQuota({}, {}, 'u', { found: true, claimed: false, points: 200, streak: 2 })
  const signin = quota.windows.find((w) => w.name.startsWith('每日签到'))
  assert.ok(signin, '额度卡片应含签到窗口')
  assert.match(signin.name, /今日未签/)
  assert.match(signin.name, /可领 200 额度/)
  assert.equal(signin.usedNote, '需在豆包电脑版领取')
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
