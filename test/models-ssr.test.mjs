import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSsrModels, fallbackModels } from '../lib/models.mjs'

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
  const entry = catalog.get('qwen4-max')
  assert.ok(entry)
  assert.equal(entry.name, 'Qwen 4 Max')
  assert.equal(entry.key, 'person-qwen4-max')
  assert.equal(entry.context, 300000)
  assert.equal(entry.rate, 0.47)
})

test('字符串里的花括号不会截断 JSON', () => {
  const catalog = parseSsrModels(html(officeMenu([model('person-weird-1', 'Weird {Model} } Name')])))
  assert.ok(catalog)
  assert.equal(catalog.get('weird-1').name, 'Weird {Model} } Name')
})

test('跳过 need_upgrade 的条目', () => {
  const catalog = parseSsrModels(html(officeMenu([
    model('person-paid-1', 'Paid Model', { subscribe_config: { need_upgrade: true } }),
    model('person-free-1', 'Free Model'),
  ])))
  assert.ok(catalog)
  assert.equal(catalog.has('paid-1'), false)
  assert.ok(catalog.has('free-1'))
})

test('页面里有多处 modeSelectData 时继续找可用的那一处', () => {
  const good = JSON.stringify({ modeSelectData: officeMenu([model('person-qwen4-max', 'Qwen 4 Max')]) })
  const page = `<script>window.a = {"modeSelectData":{"nope":1}};</script><script>window.b = ${good};</script>`
  const catalog = parseSsrModels(page)
  assert.ok(catalog)
  assert.ok(catalog.has('qwen4-max'))
})

test('没有 office 模式时返回 null', () => {
  const page = html({
    menuConfV2: {
      mode_list: {
        item_list: [
          { mode_id: '1', default_conversation_mode: 'chat', model_list: { item_list: [model('person-chat', 'Chat')] } },
        ],
      },
    },
  })
  assert.equal(parseSsrModels(page), null)
})

test('缺失或损坏的页面返回 null', () => {
  assert.equal(parseSsrModels(''), null)
  assert.equal(parseSsrModels('<html></html>'), null)
  assert.equal(parseSsrModels('<script>{"modeSelectData":{</script>'), null)
  assert.equal(parseSsrModels('<script>{"modeSelectData":"not an object"}</script>'), null)
})

test('飞书账号的 SSR 只有两三档，比基线少——调用方必须取并集', () => {
  // 真实情况：飞书账号没有 office 的 model_list，SSR 里只有自动和 2.1 Lite。
  // 直接拿它替换会让飞书账号的模型从 9 个掉到 2 个。
  const catalog = parseSsrModels(html(officeMenu([
    model('9', '自动'),
    model('seed-lite-7b', '豆包 2.1 Lite'),
  ])))
  assert.ok(catalog)
  assert.ok(catalog.size < fallbackModels().size)

  const merged = new Map(fallbackModels())
  for (const [k, v] of catalog) if (!merged.has(k)) merged.set(k, v)
  assert.equal(merged.size, fallbackModels().size, '并集不能少于基线')
})
