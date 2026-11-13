import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { _internal as modelsInternal } from '../lib/models.mjs'
import { _internal as desktopInternal } from '../lib/desktop.mjs'
import { _internal as protocolInternal } from '../lib/protocol.mjs'

test('模型 id 稳定且可读', () => {
  assert.equal(modelsInternal.slugify('自动', '9'), 'auto')
  assert.equal(modelsInternal.slugify('豆包 2.1 Pro', '5'), 'pro')
  assert.equal(modelsInternal.slugify('DeepSeek V4.1 Flash', 'person-deepseek-v4-1-flash-261017'), 'deepseek-v4-1-flash')
  assert.equal(modelsInternal.slugify('GLM 5.3', 'person-glm-5-3-261111'), 'glm-5-3')
  // 同一个键永远同一个 id
  assert.equal(modelsInternal.slugify('A B', 'x-1'), modelsInternal.slugify('A B', 'x-1'))
})

test('profile 解析遵循 Local State 的 last_used', () => {
  assert.equal(desktopInternal.resolveProfile({ profile: { last_used: 'Profile 3' } }, 'auto'), 'Profile 3')
  assert.equal(desktopInternal.resolveProfile({}, 'auto'), 'Default')
  assert.equal(desktopInternal.resolveProfile({ profile: { last_used: 'Profile 3' } }, 'Default'), 'Default')
  assert.throws(() => desktopInternal.resolveProfile({}, '../../etc'), /auto、Default/)
})

test('没有 app-bound 前缀时拒绝解密并给出可行建议', () => {
  const v20 = Buffer.concat([Buffer.from('v20', 'ascii'), Buffer.alloc(40)])
  assert.throws(() => desktopInternal.decryptValue(Buffer.alloc(32), v20, 'doubao.com'), /app-bound/)
})

test('v10 密文按 AES-GCM 解出并剥掉 host 前缀', async () => {
  const { createCipheriv } = await import('node:crypto')
  const key = Buffer.alloc(32, 7)
  const nonce = Buffer.alloc(12, 3)
  const host = 'doubao.com'
  const plain = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from('secret-value', 'utf8')])
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  const encrypted = Buffer.concat([Buffer.from('v10', 'ascii'), nonce, body])
  assert.equal(desktopInternal.decryptValue(key, encrypted, host), 'secret-value')
})

test('没有加密前缀的值按明文返回', () => {
  assert.equal(desktopInternal.decryptValue(Buffer.alloc(32), Buffer.from('plain', 'utf8'), 'doubao.com'), 'plain')
})

test('消息归一化保留工具调用与结果', () => {
  const message = protocolInternal.normalizeMessage({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
  })
  assert.equal(message.role, 'assistant')
  assert.equal(message.tool_calls[0].function.name, 'f')
  const tool = protocolInternal.normalizeMessage({ role: 'tool', content: 'ok', tool_call_id: 'c1' })
  assert.equal(tool.tool_call_id, 'c1')
})
