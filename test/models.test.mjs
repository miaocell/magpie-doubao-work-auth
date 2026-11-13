import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseModels, fallbackModels, selectModel, magpieModels, readRate, _internal } from '../lib/models.mjs'

/** 造一份和网页 SSR 同形的 modeSelectData */
function menu(models, { modeId = '3', agentMode = 1, defMode = 'office' } = {}) {
  return {
    data: {
      modeSelectData: {
        menuConfV2: {
          mode_list: {
            item_list: [
              {
                mode_id: '1',
                agent_mode: 2,
                default_conversation_mode: 'chat',
                model_list: { item_list: [
                  { item_id: 0, model_item_key: '0', name: '快速', conversation_mode_list: ['chat'] },
                ] },
              },
              {
                mode_id: modeId,
                agent_mode: agentMode,
                default_conversation_mode: defMode,
                model_list: { item_list: models },
              },
            ],
          },
        },
      },
    },
  }
}

const model = (key, name, extra = {}) => ({
  item_id: extra.itemId ?? 10001,
  model_item_key: key,
  name,
  agent_mode: extra.agentMode ?? 1,
  conversation_mode_list: extra.modes ?? ['office', 'creation'],
  model_extra_params: { total_window_size: String(extra.context ?? 300000), memory_profile: '300k_230' },
  reasoning_effort_config: {
    default_level: extra.defaultLevel ?? 5,
    option_list: (extra.levels ?? [3, 4, 5]).map((level) => ({ level, name: String(level) })),
  },
  ...(extra.needUpgrade ? { subscribe_config: { need_upgrade: true } } : {}),
})

test('解析 office 模式的多模型菜单', () => {
  const catalog = parseModels(menu([
    model('9', '自动', { levels: [3, 8, 5], defaultLevel: 8, context: 256000 }),
    model('person-deepseek-v4-1-flash-261017', 'DeepSeek V4.1 Flash'),
    model('person-kimi-k3-1-pro-261111', 'Kimi K3.1 Pro'),
    model('person-glm-5-3-261111', 'GLM 5.3', { levels: [3, 5, 7] }),
    model('5', '豆包 2.1 Pro', { needUpgrade: true }),
  ]))
  assert.ok(catalog)
  assert.equal(catalog.size, 4, '需升级的应被跳过')
  assert.ok(catalog.has('doubao-auto'))
  assert.ok(catalog.has('doubao-deepseek-v4-1-flash'))
  assert.ok(catalog.has('doubao-kimi-k3-1-pro'))
  assert.ok(catalog.has('doubao-glm-5-3'))
  assert.ok(!catalog.has('doubao-pro'), 'need_upgrade 的模型不应出现')

  const glm = catalog.get('doubao-glm-5-3')
  assert.equal(glm.key, 'person-glm-5-3-261111')
  assert.deepEqual(glm.levels, { low: 3, high: 5, max: 7 })
  assert.equal(glm.context, 300000)
  assert.equal(glm.modeId, '3')
  assert.equal(glm.agentMode, 1)
})

test('没有 office 模式时返回 null，交给基线兜底', () => {
  const payload = menu([model('0', '快速', { modes: ['chat'] })], { defMode: 'chat' })
  assert.equal(parseModels(payload), null)
})

test('格式完全不对时也不抛错', () => {
  assert.equal(parseModels({ data: { entry_list: [] } }), null)
  assert.equal(parseModels({}), null)
  assert.equal(parseModels(null), null)
})

test('只保留含 office 的模型', () => {
  const catalog = parseModels(menu([
    model('person-a', 'A', { modes: ['chat'] }),
    model('person-b', 'B', { modes: ['office'] }),
  ]))
  assert.equal(catalog.size, 1)
  assert.ok(catalog.has('doubao-b'))
})

test('基线菜单可用，且与账号截图里的模型一致', () => {
  const catalog = fallbackModels()
  const names = [...catalog.values()].map((m) => m.name)
  for (const expected of ['自动', '豆包 2.1 Lite', 'DeepSeek V4.1 Flash', 'Kimi K3.1 Pro', 'Kimi K3', 'GLM 5.3', 'GLM 5.3 Flash', 'DeepSeek V4 Pro']) {
    assert.ok(names.includes(expected), `基线里应有 ${expected}`)
  }
  assert.ok(!names.includes('豆包 2.1 Pro'), 'need_upgrade 的模型不进基线')
  const deepseek = catalog.get('doubao-deepseek-v4-1-flash')
  assert.equal(deepseek.key, 'person-deepseek-v4-1-flash-261017')
  assert.equal(deepseek.extraParams.memory_profile, '300k_230')
})

test('selectModel 校验模型和推理强度', () => {
  const catalog = fallbackModels()
  assert.equal(selectModel(catalog, { model: 'doubao-auto' }).effort, 'auto')
  assert.equal(selectModel(catalog, { model: 'doubao-glm-5-3', reasoning_effort: 'max' }).level, 7)
  assert.throws(() => selectModel(catalog, { model: 'nope' }), (e) => e.status === 404)
  assert.throws(
    () => selectModel(catalog, { model: 'doubao-glm-5-3', reasoning_effort: 'xhigh' }),
    (e) => e.status === 400,
  )
})

test('magpieModels 输出符合 magpie 的 Model 形状', () => {
  const models = magpieModels(fallbackModels())
  const m = models['doubao-kimi-k3']
  assert.equal(m.providerID, 'doubao')
  assert.equal(m.api.npm, '@ai-sdk/openai-compatible')
  assert.equal(m.capabilities.toolcall, true)
  assert.equal(m.capabilities.reasoning, true)
  assert.equal(m.limit.context, 300000)
  assert.deepEqual(Object.keys(m.variants), ['low', 'medium', 'high', 'xhigh', 'max'])
})

test('没有语义的数字键用别名，而不是 doubao-9', () => {
  assert.equal(_internal.slugify('自动', '9'), 'auto')
  assert.equal(_internal.slugify('专家', '3'), 'expert')
  assert.equal(_internal.slugify('快速', '0'), 'fast')
})

test('倍率从 tag_list 解析：纯倍率与限时优惠', () => {
  assert.deepEqual(readRate([{ text: '1.44x', type: 2 }]), { rate: 1.44, free: false, text: '1.44x' })
  assert.equal(readRate([{ text: '限时优惠 0.01x', type: 6 }]).rate, 0.01)
  assert.equal(readRate([{ text: '0.80x', type: 2 }]).rate, 0.8)
})

test('免费标签识别为不计费，而不是 0 倍率', () => {
  const rate = readRate([{ text: '小额免费', type: 6 }])
  assert.equal(rate.free, true)
  assert.equal(rate.rate, undefined)
})

test('没有标签或标签无倍率时留空', () => {
  assert.deepEqual(readRate([]), { text: '' })
  assert.deepEqual(readRate(undefined), { text: '' })
  assert.deepEqual(readRate([{ text: '新上线', type: 1 }]), { text: '' })
})

test('基线模型的倍率与截图一致', () => {
  const catalog = fallbackModels()
  const expected = {
    'doubao-kimi-k3-1-pro-highspeed': 1.44,
    'doubao-kimi-k3': 1.48,
    'doubao-glm-5-3': 0.8,
    'doubao-glm-5-3-flash': 0.08,
    'doubao-deepseek-v4-pro-ga': 0.46,
    'doubao-kimi-k3-1-pro': 0.95,
    'doubao-deepseek-v4-1-flash': 0.01,
  }
  for (const [id, rate] of Object.entries(expected)) {
    assert.equal(catalog.get(id).rate, rate, `${id} 的倍率应是 ${rate}`)
  }
  assert.equal(catalog.get('doubao-auto').free, true, '自动应标为免费')
})

test('倍率显示在模型名里，cost 不编造价格', () => {
  const models = magpieModels(fallbackModels())
  assert.equal(models['doubao-glm-5-3'].name, 'GLM 5.3 · 0.80x')
  assert.equal(models['doubao-auto'].name, '自动 · 小额免费')
  // 豆包按订阅额度扣费，没有每百万 token 的单价可填
  assert.deepEqual(models['doubao-glm-5-3'].cost, { input: 0, output: 0, cache_read: 0, cache_write: 0 })
})
