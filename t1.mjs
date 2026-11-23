import { DesktopSession } from './lib/session.mjs'
import { loadAccount } from './lib/vault.mjs'
import { prepareRequest, upstreamBody } from './lib/protocol.mjs'
import { selectModel } from './lib/models.mjs'

const s0 = await loadAccount('3770665251384825')
const s = new DesktopSession(
  { uid: s0.uid, profile: s0.profile, bot: s0.bot, clientInfo: s0.clientInfo },
  {
    importer: async () => ({
      profile: s0.profile,
      cookies: s0.cookies,
      clientInfo: s0.clientInfo,
      clientVersion: s0.clientVersion,
    }),
  },
)
await s.ready()
const catalog = await s.models()
const selected = selectModel(catalog, { model: 'doubao-deepseek-v4-1-flash' })

const req = { model: 'doubao-deepseek-v4-1-flash', messages: [{ role: 'user', content: '回一个字：好' }] }
const prepared = prepareRequest(req)
const upstream = upstreamBody(s, prepared, selected, [])
try {
  const r = await s.request('/chat/completion', upstream, undefined, {}, { Accept: 'text/event-stream' })
  const text = await r.text()
  if (text.includes('710022004')) console.log('飞书号状态: ⚠ 仍在风控')
  else if (text.includes('event_type') || text.includes('STREAM')) console.log('飞书号状态: ✓ 已恢复')
  else console.log('?', text.slice(0, 100).replace(/\n/g, ' '))
} catch (e) {
  console.log('抛错:', e.upstreamCode || e.message.slice(0, 60))
}
