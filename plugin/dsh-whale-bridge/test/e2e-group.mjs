/**
 * 群聊模式 + 状态播报 E2E（流式按到达时间打印，验证「收到任务先回话 / 长任务中途回话」）。
 * 用法：node test/e2e-group.mjs [chatText]
 */
const WHALE = process.env.WHALE || 'http://127.0.0.1:8787'
const text = process.argv[2]
  || '鲸鲸，用 dsh 数一下 D:\\dsh_work\\whale-dsh-bridge\\lib 目录下有几个 .js 文件，只回复数字。'

const started = Date.now()
const res = await fetch(WHALE + '/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    text,
    mode: 'group',
    atMe: true,
    senderName: '测试者',
    sessionId: 'groupdiag-' + Date.now().toString(36),
  }),
})
console.log('HTTP', res.status, 'content-type', res.headers.get('content-type'))
if (!res.body) {
  console.log('NO BODY')
  process.exit(1)
}
const reader = res.body.getReader()
const decoder = new TextDecoder()
let buf = ''
const events = []
let done = false
while (!done) {
  const chunk = await reader.read()
  if (chunk.done) break
  buf += decoder.decode(chunk.value, { stream: true })
  let idx
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    const line = block.split('\n').find((l) => l.startsWith('data:'))
    if (!line) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') continue
    try {
      const evt = JSON.parse(data)
      events.push({ ...evt, t: Date.now() - started })
    } catch {
      /* ignore */
    }
  }
}
const elapsed = Date.now() - started
const meta = events.find((e) => e.type === 'meta')
const doneEvent = events.find((e) => e.type === 'done')
const deltaEvents = events.filter((e) => e.type === 'delta')
const reply = String(doneEvent?.text || deltaEvents.map((e) => e.text).join(''))
console.log('elapsed', elapsed, 'ms | meta', JSON.stringify(meta))
console.log('delta events:', deltaEvents.length)
// 打印前几条 delta 的到达时间/内容，方便看「状态播报」
for (const ev of deltaEvents.slice(0, 6)) console.log(`  +${ev.t}ms  ${JSON.stringify(ev.text).slice(0, 120)}`)
if (deltaEvents.length > 6) console.log(`  ...（共 ${deltaEvents.length} 条）`)
console.log('ERROR?', doneEvent?.error || false)
console.log('REPLY:', reply.slice(0, 800))
if (!reply.trim()) {
  console.log('FAILED: empty reply')
  process.exit(1)
}
console.log('GROUP-E2E-PASS')
