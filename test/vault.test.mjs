import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 保管库走环境变量指定的目录，避免碰到真实数据
const dir = await mkdtemp(join(tmpdir(), 'doubao-vault-test-'))
process.env.DOUBAO_WORK_VAULT = dir
const { saveAccount, loadAccount, listAccounts, removeAccount } = await import('../lib/vault.mjs')

const account = (uid, name) => ({
  uid,
  name,
  profile: 'pasted',
  clientInfo: { deviceId: '1', webId: '2', teaUuid: '3' },
  clientVersion: '2.35.15',
  bot: '999',
  cookies: [
    { name: 'sessionid', value: `session-${uid}`, domain: 'doubao.com', path: '/', expires: 0, secure: true, httpOnly: false },
    { name: 'ttwid', value: 'tt', domain: 'doubao.com', path: '/', expires: 0, secure: true, httpOnly: false },
  ],
})

test('多账号各自独立保存与读回', async () => {
  await saveAccount(account('111', '主号'))
  await saveAccount(account('222', '小号'))

  const a = await loadAccount('111')
  const b = await loadAccount('222')
  assert.equal(a.name, '主号')
  assert.equal(b.name, '小号')
  // 关键：两个账号的 cookie 不会串
  assert.equal(a.cookies.find((c) => c.name === 'sessionid').value, 'session-111')
  assert.equal(b.cookies.find((c) => c.name === 'sessionid').value, 'session-222')
})

test('账号列表列出全部已保存账号', async () => {
  const list = await listAccounts()
  const uids = list.map((row) => row.uid).sort()
  assert.deepEqual(uids, ['111', '222'])
  assert.equal(list.find((r) => r.uid === '111').cookieCount, 2)
})

test('覆盖同名账号不会产生重复条目', async () => {
  await saveAccount({ ...account('111', '主号改名'), cookies: account('111', 'x').cookies })
  const list = await listAccounts()
  assert.equal(list.filter((r) => r.uid === '111').length, 1)
  assert.equal((await loadAccount('111')).name, '主号改名')
})

test('删除一个账号不影响另一个', async () => {
  assert.equal(await removeAccount('222'), true)
  const list = await listAccounts()
  assert.deepEqual(list.map((r) => r.uid), ['111'])
  // 剩下的账号仍可解出
  assert.equal((await loadAccount('111')).uid, '111')
  assert.equal(await removeAccount('222'), false)
})

test('凭据在磁盘上不是明文', async () => {
  const { readFile } = await import('node:fs/promises')
  const file = join(dir, '111.bin')
  const raw = await readFile(file)
  // 不应该能直接搜到 cookie 明文
  assert.equal(raw.includes(Buffer.from('session-111')), false)
})

test('清理', async () => {
  await rm(dir, { recursive: true, force: true })
})
