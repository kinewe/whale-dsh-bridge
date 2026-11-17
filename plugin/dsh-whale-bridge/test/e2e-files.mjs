/**
 * 文件通道真实 E2E（真实 DeepSeek 上游 + 真实 DSH 执行；会花少量额度、耗时数分钟）
 *   node test/e2e-files.mjs
 *
 * 覆盖：
 *   A. 桥接 /api/upload 上传文件 → 落在 <工作区>\.whale-bridge\inbox
 *   B. 入站：鲸鱼娘聊天带 [Shared attachment] file: <path> → 模型 → dsh_task → DSH 读文件 → 回复内容
 *   C. 出站：让 DSH 在 outbox 生成文件 → 桥接自动登记 → 回复末尾出现 /files/<token>/... 下载链接 → 下载内容正确
 *   D. 聊天页注入脚本可从鲸鱼娘站点访问（HTML 含标记，JS 200）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const BRIDGE = process.env.BRIDGE || 'http://127.0.0.1:8789'
const WHALE = process.env.WHALE || 'http://127.0.0.1:8787'
const WORKSPACE = process.env.WORKSPACE || 'C:\\Dev_dsh'
const tag = crypto.randomBytes(4).toString('hex')
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function jget(url) {
  const res = await fetch(url)
  const text = await res.text()
  try { return { status: res.status, json: JSON.parse(text), text } } catch { return { status: res.status, text } }
}

async function uploadFile(name, content) {
  const res = await fetch(BRIDGE + '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, data: Buffer.from(content, 'utf8').toString('base64') }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = {} }
  return { status: res.status, json }
}

async function whaleChat(text, sessionId) {
  const started = Date.now()
  const res = await fetch(WHALE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, sessionId: sessionId || 'files-e2e-' + tag, senderName: '主人', mode: 'private' }),
  })
  const raw = await res.text()
  const events = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const body = line.slice(5).trim()
      if (!body) continue
      try { events.push(JSON.parse(body)) } catch { /* ignore */ }
    }
  }
  const meta = events.find((e) => e && e.type === 'meta')
  const deltas = events.filter((e) => e && e.type === 'delta').map((e) => e.text).join('')
  const done = events.find((e) => e && e.type === 'done')
  return { status: res.status, durationMs: Date.now() - started, meta, done, reply: String(done?.text || deltas || '') }
}

console.log('=== 文件通道 E2E ===', { BRIDGE, WHALE, WORKSPACE, tag })

// ---------- 0. 基础状态 ----------
const health = await jget(BRIDGE + '/api/health')
record('桥接 health 0.2.0', health.status === 200 && health.json?.version === '0.2.0', JSON.stringify(health.json))
const filesState = await jget(BRIDGE + '/api/files')
record('桥接 /api/files 开启', filesState.status === 200 && filesState.json?.enabled === true, filesState.json?.workspace)

// ---------- D. 聊天页注入 ----------
const pageRes = await fetch(WHALE + '/')
const pageText = await pageRes.text()
record('聊天页已注入文件通道脚本标记', pageRes.status === 200 && pageText.includes('whale-dsh-bridge-files:begin') && pageText.includes('/static/web-file-channel.js'))
const script = await fetch(BRIDGE + '/static/web-file-channel.js')
const scriptText = await script.text()
record('文件通道脚本可访问', script.status === 200 && scriptText.includes('__whaleFileChannelLoaded'), 'bytes=' + Buffer.byteLength(scriptText))

// ---------- A. 上传 ----------
const marker = 'WHALE-FILE-IN-' + tag.toUpperCase()
const uploaded = await uploadFile('e2e-in-' + tag + '.txt', `这是入站测试文件。\n标记：${marker}\n第二行内容。\n`)
const uploadOk = uploaded.status === 200 && uploaded.json?.ok && uploaded.json?.file?.path
record('上传文件落到 inbox', Boolean(uploadOk), uploaded.json?.file?.path || JSON.stringify(uploaded.json))
if (!uploadOk) {
  console.error('上传失败，终止')
  process.exit(1)
}
const inboxPath = uploaded.json.file.path
record('上传文件真实存在', fs.existsSync(inboxPath) && fs.readFileSync(inboxPath, 'utf8').includes(marker), inboxPath)
record('上传文件路径在 inbox 内', path.resolve(inboxPath).toLowerCase().startsWith(path.resolve(WORKSPACE, '.whale-bridge', 'inbox').toLowerCase()))

// ---------- B. 入站 E2E ----------
console.log('\n[入站] 让鲸鱼娘通过 DSH 读取刚上传的文件（真实模型，可能 1–2 分钟）…')
const inbound = await whaleChat(
  `鲸鲸，我刚才给你上传了一个文件，麻烦让 DSH 读一下这个文件，告诉我里面写了什么（要包含里面的标记字符串）。\n\n[Shared attachment] file: ${inboxPath}`,
  'files-e2e-in-' + tag,
)
console.log('  meta:', JSON.stringify(inbound.meta), 'dur=', inbound.durationMs + 'ms', 'replyLen=', inbound.reply.length)
console.log('  reply:', inbound.reply.slice(0, 500).replace(/\n/g, ' | '))
record('入站：鲸鱼娘有回复', Boolean(inbound.reply.trim()))
record('入站：回复包含文件内标记（DSH 真的读了文件）', inbound.reply.includes(marker), marker)

// ---------- C. 出站 E2E ----------
const outMarker = 'WHALE-FILE-OUT-' + tag.toUpperCase()
const outName = 'e2e-out-' + tag + '.txt'
console.log('\n[出站] 让 DSH 在 outbox 生成文件并交给用户（真实模型，可能 1–2 分钟）…')
const outbound = await whaleChat(
  `鲸鲸，让 DSH 在工作区的 .whale-bridge\\outbox 目录里生成一个文件 ${outName}，内容就写 ${outMarker} 这一行；然后把这个文件交给我（我要能下载）。`,
  'files-e2e-out-' + tag,
)
console.log('  meta:', JSON.stringify(outbound.meta), 'dur=', outbound.durationMs + 'ms', 'replyLen=', outbound.reply.length)
console.log('  reply:', outbound.reply.slice(0, 700).replace(/\n/g, ' | '))
record('出站：鲸鱼娘有回复', Boolean(outbound.reply.trim()))
const linkMatch = outbound.reply.match(/http:\/\/127\.0\.0\.1:\d+\/files\/[a-f0-9]+\/[^\s）)]+/)
record('出站：回复里带下载链接', Boolean(linkMatch), linkMatch ? linkMatch[0] : '未找到')
if (linkMatch) {
  const dl = await fetch(linkMatch[0])
  const dlText = await dl.text()
  record('出站：下载链接可访问且内容正确', dl.status === 200 && dlText.includes(outMarker), 'status=' + dl.status + ' len=' + dlText.length)
  const disposition = dl.headers.get('content-disposition') || ''
  record('出站：Content-Disposition 附件头', /attachment/i.test(disposition), disposition)
  record('出站：下载文件名保留聊天里展示的原名', disposition.includes(outName) || disposition.includes(encodeURIComponent(outName)), disposition)
} else {
  record('出站：下载链接可访问且内容正确', false, '无链接')
  record('出站：Content-Disposition 附件头', false, '无链接')
  record('出站：下载文件名保留聊天里展示的原名', false, '无链接')
}

// outbox 实际文件
const outboxPath = path.join(WORKSPACE, '.whale-bridge', 'outbox', outName)
record('出站：outbox 里确有产物文件', fs.existsSync(outboxPath), outboxPath)

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok)
console.log('\n=== 结果：' + (results.length - failed.length) + '/' + results.length + ' PASS ===')
if (failed.length) {
  for (const f of failed) console.log('  FAIL:', f.name, '—', f.detail)
  process.exit(1)
}
console.log('WHALE-FILES-E2E-PASS')
