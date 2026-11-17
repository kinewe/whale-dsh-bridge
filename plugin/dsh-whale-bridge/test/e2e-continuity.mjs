/**
 * 会话连续性 E2E（聊天链路，两次群聊消息）：
 *  第 1 条：让 DSH 读取一个「只存在于文件里」的暗号并记住（新建会话），回复里不能说暗号
 *  第 2 条：问这个暗号 —— 鲸鱼娘自己的聊天历史里没有它，模型必须用 session_id 续接 DSH 会话才能答对
 * 用法：node test/e2e-continuity.mjs
 */
import fs from 'node:fs'

const WHALE = process.env.WHALE || 'http://127.0.0.1:8787'
import path from 'node:path'
const WORKSPACE = process.env.WHALE_TEST_WORKSPACE || 'C:\\Dev_dsh'
const CODE_FILE = path.join(WORKSPACE, '.bridge-continuity-code.txt')
const code = 'K7Q2X9'
fs.writeFileSync(CODE_FILE, code + '\n', 'utf8')

const sessionId = 'continuity-' + Date.now().toString(36)

async function chat(text) {
  const started = Date.now()
  const res = await fetch(WHALE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, mode: 'group', atMe: true, senderName: '测试者', sessionId }),
  })
  const body = await res.text()
  const events = body.split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data:'))
    .map((b) => b.slice(5).trim())
    .filter(Boolean)
    .map((b) => { try { return JSON.parse(b) } catch { return undefined } })
    .filter(Boolean)
  const done = events.find((e) => e.type === 'done')
  const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('')
  return { elapsed: Date.now() - started, reply: String(done?.text || deltas || body.slice(0, 300)) }
}

try {
  const a = await chat(`鲸鲸，用 dsh 做一件事：读取 ${CODE_FILE} 里的内容，把它当作暗号记住（不要写文件、也不要在回复里告诉我暗号是什么），然后只回复「记好了」。`)
  console.log('TURN1 elapsed', a.elapsed, 'ms')
  console.log('TURN1 reply:', a.reply.slice(0, 300))

  const b = await chat('刚才让 DSH 记住的暗号是什么？现在可以告诉我了，只回复暗号本身。')
  console.log('TURN2 elapsed', b.elapsed, 'ms')
  console.log('TURN2 reply:', b.reply.slice(0, 300))

  const ok = new RegExp(code, 'i').test(b.reply)
  console.log(ok ? 'CONTINUITY-PASS' : 'CONTINUITY-FAIL（模型没有续接会话或 DSH 没记住）')
  process.exitCode = ok ? 0 : 1
} finally {
  try { fs.unlinkSync(CODE_FILE) } catch { /* ignore */ }
}
