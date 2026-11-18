import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSsrModels } from '../lib/models.mjs'

const model = (key, name, extra = {}) => ({
  item_id: 10001,
  model_item_key: key,
  name,
  agent_mode: 1,
  conversation_mode_list: ['office', 'creation'],
  model_extra_params: { total_window_size: '300000', memory_profile: '300k_230' },
  tag_list: [{ type: 6, text: '新上线 0.47x' }],
  reasoning_effort_config: {
    default_level: 5,
    option_list: [3, 5, 6].map((level) => ({ level, name: String(level) })),
  },
  ...extra,
})

const officeMenu = (models, extraMode = {}) => ({
  menuConfV2: {
    mode_list: {
      item_list: [
        { mode_id: '1', agent_mode: 2, default_conversation_mode: 'chat', model_list: { item_list: [] } },
        { mode_id: '3', agent_mode: 1, default_conversation_mode: 'office', model_list: { item_list: models }, ...extraMode },
      ],
    },
  },
})

const html = (data) => `<html><script>window.__SSR__ = ${JSON.stringify({ modeSelectData: data })};</script></html>`

test('从 SSR 页面解析 office 模型菜单', () => {
  const catalog = parseSsrModels(html(officeMenu([model('person-qwen4-max', 'Qwen 4 Max')])))

  assert.ok(catalog)
  const entry = catalog.get('doubao-qwen4-max')
  assert.ok(entry)
  assert.equal(entry.name, 'Qwen 4 Max')
  assert.equal(entry.key, 'person-qwen4-max')
  assert.equal(entry.context, 300000)
  assert.equal(entry.rate, 0.47)
  assert.deepEqual(Object.keys(entry.levels), ['low', 'high', 'xhigh'])
  assert.equal(entry.defaultEffort, 'high')
})

test('字符串里的花括号不会截断 JSON', () => {
  const catalog = parseSsrModels(html(officeMenu([
    model('person-weird-1', 'Weird {Model} } Name'),
  ])))
  assert.ok(catalog)
  assert.equal(catalog.get('doubao-weird-1').name, 'Weird {Model} } Name')
})

test('跳过 need_upgrade 的条目', () => {
  const catalog = parseSsrModels(html(officeMenu([
    model('person-paid-1', 'Paid Model', { subscribe_config: { need_upgrade: true } }),
    model('person-free-1', 'Free Model'),
  ])))
  assert.ok(catalog)
  assert.equal(catalog.has('doubao-paid-1'), false)
  assert.ok(catalog.has('doubao-free-1'))
})

test('页面里有多处 modeSelectData 时继续找可用的那一处', () => {
  const good = JSON.stringify({ modeSelectData: officeMenu([model('person-qwen4-max', 'Qwen 4 Max')]) })
  const page = `<script>window.a = {"modeSelectData":{"nope":1}};</script><script>window.b = ${good};</script>`
  const catalog = parseSsrModels(page)
  assert.ok(catalog)
  assert.ok(catalog.has('doubao-qwen4-max'))
})

test('没有 office 模式时返回 null', () => {
  const page = html({ menuConfV2: { mode_list: { item_list: [
    { mode_id: '1', default_conversation_mode: 'chat', model_list: { item_list: [model('person-chat', 'Chat')] } },
  ] } } })
  assert.equal(parseSsrModels(page), null)
})

test('缺失或损坏的页面返回 null', () => {
  assert.equal(parseSsrModels(''), null)
  assert.equal(parseSsrModels('<html></html>'), null)
  assert.equal(parseSsrModels('<script>{"modeSelectData":{</script>'), null)
  assert.equal(parseSsrModels('<script>{"modeSelectData":"not an object"}</script>'), null)
})
