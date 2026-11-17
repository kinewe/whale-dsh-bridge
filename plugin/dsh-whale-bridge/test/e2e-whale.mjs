/**
 * 鲸鱼娘网页聊天 E2E（不使用微信）：
 *   鲸鱼娘 server(/api/chat SSE) → provider=custom → 桥接代理 /v1/chat/completions
 *   → dsh_task → DSH agent 真干活 → 回填 → 鲸鱼娘回复。
 *
 * 前置：桥接宿主在 8790（或 BRIDGE 环境变量），mock 上游在 8791，
 *       鲸鱼娘 server 已在 8787 启动（node server.js --no-browser）。
 */
const BRIDGE = process.env.BRIDGE || 'http://127.0.0.1:8790'
const MOCK = process.env.MOCK || 'http://127.0.0.1:8791'
const WHALE = process.env.WHALE || 'http://127.0.0.1:8787'

async function json(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text), text }
  } catch {
    return { status: res.status, json: undefined, text }
  }
}

// 0) 让鲸鱼娘可用：已接入 + 上游暂时指向 mock（真实使用时指向鲸鱼娘原来的模型服务商）
const state = await json(BRIDGE + '/api/state')
console.log('BRIDGE state:', JSON.stringify({
  whale: state.json?.status?.whale,
  settings: state.json?.settings,
}, null, 2).slice(0, 1200))

const put = await json(BRIDGE + '/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ upstream: { baseUrl: MOCK, apiKey: 'mock-key', model: 'mock-chat' } }),
})
if (!put.json?.ok) {
  console.error('设置 mock 上游失败：', put.text.slice(0, 500))
  process.exit(1)
}

const health = await json(WHALE + '/healthz')
if (!health.json?.ok) {
  console.error('鲸鱼娘 server 未启动：', health.status, health.text.slice(0, 200))
  process.exit(1)
}
console.log('WHALE health ok')

// 1) 发一条会触发 DSH 干活的私聊
const payload = {
  text: '鲸鲸，让 DSH 看看工作区里有哪些文件，然后告诉我前几个是什么。',
  sessionId: 'e2e-' + Date.now().toString(36),
  senderName: '测试者',
  mode: 'private',
}
const res = await fetch(WHALE + '/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
const sse = await res.text()
const events = sse.split(/\r?\n\r?\n/)
  .map((b) => b.trim())
  .filter((b) => b.startsWith('data:'))
  .map((b) => b.slice(5).trim())
  .filter(Boolean)
  .map((b) => {
    try { return JSON.parse(b) } catch { return undefined }
  })
  .filter(Boolean)
const meta = events.find((e) => e.type === 'meta')
const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('')
const done = events.find((e) => e.type === 'done')
console.log('META:', JSON.stringify(meta))
console.log('DELTAS len:', deltas.length)
console.log('REPLY:', (done?.text || deltas).slice(0, 1200))
if (!done || !String(done.text || '').trim()) {
  console.error('FAILED: 鲸鱼娘没有给出回复')
  process.exit(1)
}
if (done.error) console.log('WARN: done.error =', done.error)
if (!String(done.text).includes('DSH')) {
  console.error('FAILED: 回复里没有 DSH 任务结果（桥接没有生效？）')
  process.exit(1)
}
console.log('WHALE-E2E-PASS')
