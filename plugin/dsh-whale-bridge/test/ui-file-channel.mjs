/**
 * 文件通道 UI 自检（本地无头 Chrome + CDP；不调用模型、不花额度）：
 *   node test/ui-file-channel.mjs
 *
 * 验证注入到鲸鱼娘聊天页的 web-file-channel.js 真的生效：
 *   1) 脚本加载、📎 按钮存在；
 *   2) 模拟选择文件 → 真实上传到桥接 → 附件 chip 出现；
 *   3) 发给 /api/chat 的文本会自动追加 [Shared attachment] file: 路径（用只读钩子验证，不真发消息）；
 *   4) 回复里的下载链接被渲染成可点击 <a class="wb-file-link">；
 *   5) 历史消息里的附件标记显示成「📎 附件：名字」；
 *   6) 截图留档。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CDP_PORT = Number(process.env.CDP_PORT || 9333)
const PAGE_URL = 'http://127.0.0.1:8787/'
const BRIDGE = 'http://127.0.0.1:8789'
const USER_DATA = 'C:\\Dev_dsh\\scratch\\chrome-ui-test'
const SHOT = 'C:\\Dev_dsh\\scratch\\ui-file-channel.png'
const tag = crypto.randomBytes(3).toString('hex')

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 15000, interval = 300) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
      last = v
    } catch (err) {
      last = String(err && err.message ? err.message : err)
    }
    await sleep(interval)
  }
  throw new Error('waitFor timeout: ' + last)
}

async function httpJson(url, options) {
  const res = await fetch(url, options)
  const text = await res.text()
  try { return { status: res.status, json: JSON.parse(text) } } catch { return { status: res.status, text } }
}

// ---------- 启动无头 Chrome ----------
if (!fs.existsSync(CHROME)) {
  console.error('Chrome 不存在：' + CHROME)
  process.exit(2)
}
fs.rmSync(USER_DATA, { recursive: true, force: true })
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + USER_DATA,
  '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore', windowsHide: true })
console.log('chrome pid=', chrome.pid)

let target
try {
  await waitFor(async () => {
    const v = await httpJson('http://127.0.0.1:' + CDP_PORT + '/json/version')
    return v.status === 200 ? v.json : false
  }, 20000)
  const created = await httpJson('http://127.0.0.1:' + CDP_PORT + '/json/new?url=' + encodeURIComponent(PAGE_URL), { method: 'PUT' })
  if (created.status !== 200) throw new Error('创建 tab 失败: ' + JSON.stringify(created))
  target = created.json
  record('创建无头标签页', true, target.id || '')
} catch (err) {
  record('无头 Chrome 打开鲸鱼娘页面', false, String(err && err.message ? err.message : err))
  try { chrome.kill() } catch { /* ignore */ }
  process.exit(1)
}

// ---------- CDP 连接 ----------
const ws = new WebSocket(target.webSocketDebuggerUrl)
let msgId = 0
const waiting = new Map()
ws.addEventListener('message', (event) => {
  let msg
  try { msg = JSON.parse(event.data) } catch { return }
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id)
    waiting.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', (e) => reject(new Error('CDP WS error')), { once: true })
})
async function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evalJS(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result ? r.result.value : undefined
}
await send('Runtime.enable')
await send('Page.enable')
record('CDP 已连接', true)

// 新建的 tab 初始是 about:blank，显式导航到鲸鱼娘页面
await send('Page.navigate', { url: PAGE_URL })
try {
  await waitFor(async () => (await evalJS("document.readyState === 'complete' && location.href")), 25000)
  const href = await evalJS('location.href')
  record('无头 Chrome 打开鲸鱼娘页面', String(href).indexOf('127.0.0.1:8787') >= 0, href)
} catch (err) {
  record('无头 Chrome 打开鲸鱼娘页面', false, String(err.message))
}

// ---------- 1. 脚本加载 / 按钮 ----------
try {
  await waitFor(async () => (await evalJS('Boolean(window.__whaleFileChannelLoaded)')), 20000)
  record('文件通道脚本已加载', true)
} catch (err) {
  record('文件通道脚本已加载', false, String(err.message))
}
const pageCheck = await evalJS(`(() => ({
  hook: Boolean(window.__whaleFileChannel),
  bridge: window.__whaleFileChannel && window.__whaleFileChannel.bridge,
  btn: Boolean(document.querySelector('.composer .wb-file-btn')),
  btnTitle: (document.querySelector('.composer .wb-file-btn') || {}).title || '',
  fileInput: Boolean(document.querySelector('.composer input[type=file]')),
  fetchWrapped: Boolean(window.__wbFetchWrapped),
  addMessageGlobal: typeof addMessage === 'function',
}))()`)
// 注入是 500ms 轮询的，等按钮出现再判定
let btnReady = false
try {
  btnReady = Boolean(await waitFor(async () => (await evalJS("Boolean(document.querySelector('.composer .wb-file-btn'))")), 15000))
} catch (err) {
  btnReady = false
}
record('📎 按钮已注入输入框', btnReady, pageCheck.btnTitle)
record('文件选择框存在', Boolean(await evalJS("Boolean(document.querySelector('.composer input[type=file]'))")))
record('fetch 已包装（附件自动随消息发送）', pageCheck.fetchWrapped)
record('桥接地址来自脚本自身 origin', pageCheck.bridge === 'http://127.0.0.1:8789', pageCheck.bridge)

// ---------- 2. 模拟上传 ----------
const uiMarker = 'UI-E2E-' + tag.toUpperCase()
const uploadResult = await evalJS(`(async () => {
  const dt = new DataTransfer();
  dt.items.add(new File([${JSON.stringify('UI 上传测试内容 ' + uiMarker)}], 'ui-e2e-${tag}.txt', { type: 'text/plain' }));
  const input = document.querySelector('.composer input[type=file]');
  if (!input) return { ok: false, error: 'no input' };
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
})()`)
record('模拟选择文件并触发上传', Boolean(uploadResult && uploadResult.ok), JSON.stringify(uploadResult))
let pendingState = null
try {
  pendingState = await waitFor(async () => {
    const p = await evalJS('window.__whaleFileChannel.getPending()')
    if (p && p.length && p[0].path && !p[0].uploading) return p
    return false
  }, 30000)
  record('上传完成：附件进入待发送列表', true, JSON.stringify(pendingState))
} catch (err) {
  record('上传完成：附件进入待发送列表', false, String(err.message))
}
const chip = await evalJS(`(() => {
  const chips = [...document.querySelectorAll('.wb-chip')].map((el) => el.textContent);
  const list = document.querySelector('.wb-attach-list');
  return { chips, shown: Boolean(list && list.classList.contains('show')) };
})()`)
record('聊天页显示附件 chip', chip.shown && chip.chips.length === 1, JSON.stringify(chip.chips))
if (pendingState && pendingState[0]) {
  const uploadedPath = pendingState[0].path
  record('上传文件确实落地（inbox）', fs.existsSync(uploadedPath) && fs.readFileSync(uploadedPath, 'utf8').includes(uiMarker), uploadedPath)
}

// ---------- 3. 附件自动注入聊天请求（只读钩子验证） ----------
const decorated = await evalJS(`window.__whaleFileChannel.buildOutgoingText('鲸鲸，帮我看看这个文件')`)
record(
  '发给模型的消息会自动带上 [Shared attachment] 路径',
  Boolean(decorated && decorated.text.includes('[Shared attachment] file: ') && decorated.text.includes('ui-e2e-' + tag)),
  (decorated && decorated.markers ? decorated.markers : '').slice(0, 120),
)

// ---------- 4. 下载链接渲染成可点击 ----------
const filesRes = await httpJson(BRIDGE + '/api/files')
const registered = filesRes.json?.registered || []
const sample = registered[registered.length - 1]
if (sample && sample.url) {
  await evalJS(`addMessage({ role: 'bot', text: ${JSON.stringify('📎 文件下载：\n· 示例文件\n  ' + sample.url)} })`)
  await sleep(500)
  const linkInfo = await evalJS(`(() => {
    const a = document.querySelector('a.wb-file-link');
    return a ? { href: a.href, onclick: a.getAttribute('target'), count: document.querySelectorAll('a.wb-file-link').length } : null;
  })()`)
  record('回复里的下载链接被渲染成可点击链接', Boolean(linkInfo && linkInfo.href === sample.url), JSON.stringify(linkInfo))
} else {
  record('回复里的下载链接被渲染成可点击链接', false, '还没有已登记文件（先跑 test/e2e-files.mjs）')
}

// ---------- 5. 历史消息附件标记清理 ----------
await evalJS(`addMessage({ role: 'user', name: '你', text: ${JSON.stringify('看看这个文件\n\n[Shared attachment] file: C:\\\\Dev_dsh\\\\.whale-bridge\\\\inbox\\\\demo-附件.txt')} })`)
await sleep(600)
const cleaned = await evalJS(`(() => {
  const texts = [...document.querySelectorAll('.msg.user .bubble-text')].map((el) => el.textContent);
  const last = texts[texts.length - 1] || '';
  return { last, ok: last.includes('📎 附件：') && !last.includes('[Shared attachment]') };
})()`)
record('历史消息里附件标记显示成「📎 附件：名字」', Boolean(cleaned.ok), cleaned.last)

// ---------- 6. 截图 ----------
try {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  record('页面截图留档', fs.existsSync(SHOT), SHOT)
} catch (err) {
  record('页面截图留档', false, String(err && err.message ? err.message : err))
}

// ---------- 汇总 ----------
ws.close()
try { chrome.kill() } catch { /* ignore */ }
try {
  const { execFileSync } = await import('node:child_process')
  execFileSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
} catch { /* ignore */ }
// 等 Chrome 真正退出并重试清理临时 profile（Windows 上文件句柄释放可能晚于进程退出）
let profileCleaned = false
for (let i = 0; i < 20; i += 1) {
  await sleep(400)
  try {
    fs.rmSync(USER_DATA, { recursive: true, force: true })
    if (!fs.existsSync(USER_DATA)) { profileCleaned = true; break }
  } catch { /* retry */ }
}
record('清理无头 Chrome 临时目录', profileCleaned, USER_DATA)

const failed = results.filter((r) => !r.ok)
console.log('\n=== UI 结果：' + (results.length - failed.length) + '/' + results.length + ' PASS ===')
if (failed.length) {
  for (const f of failed) console.log('  FAIL:', f.name)
  process.exit(1)
}
console.log('WHALE-FILES-UI-PASS')
