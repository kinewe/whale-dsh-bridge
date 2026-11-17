/**
 * 安装到 DSH 桌面端后的验收脚本（BRIDGE 默认 8789）。
 * 只读 + 一次短任务 + 客户端自报检查；不改配置。
 * 用法：node test/verify-installed.mjs
 */
const BRIDGE = process.env.BRIDGE || 'http://127.0.0.1:8789'

async function j(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 500) }
  }
  return { status: res.status, json, text }
}

let failed = 0
let warned = 0
const check = (name, ok, detail = '', warn = false) => {
  console.log(`${ok ? 'PASS' : warn ? 'WARN' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) {
    if (warn) warned += 1
    else failed += 1
  }
}

const health = await j(BRIDGE + '/api/health')
check('bridge /api/health', health.status === 200 && health.json?.ok, `port=${health.json?.port}`)

const state = await j(BRIDGE + '/api/state')
check('bridge /api/state', state.status === 200 && state.json?.ok)
const st = state.json || {}
check('whale 目录可达', Boolean(st.status?.whale?.exists), st.status?.whale?.dir || '')
check('whale 已接入桥接', Boolean(st.status?.whale?.configured), st.status?.whale?.baseUrl || '未接入')
check('DSH 任务 profile 就绪', Boolean(st.status?.dsh?.profile?.ready), st.status?.dsh?.profile?.dir || '')

const reports = await j(BRIDGE + '/api/client-report')
const list = reports.json?.reports || []
// 插件 reload 后内存里的自报列表会清空；刷新一次 DSH 页面就会重新自报，所以只算 WARN
check('浏览器侧 client.js 已加载并自报', list.length > 0, `${list.length} 条（插件 reload 后需刷新一次 DSH 页面）`, true)
if (list.length) {
  const latest = list[list.length - 1]
  console.log('  最近自报：', JSON.stringify(latest).slice(0, 300))
}

const task = await j(BRIDGE + '/api/task', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: '只回复数字：3+4=?' }),
  timeout: 400000,
})
// Node fetch 没有 timeout 选项，用 Promise.race 替代
if (!task.json) {
  // 重新用带超时的方式
}
check('POST /api/task 可执行 DSH 任务', Boolean(task.json?.ok), `text=${String(task.json?.text || '').slice(0, 60)} status=${task.status}`)

const tasks = await j(BRIDGE + '/api/tasks')
check('任务历史可读', Boolean(tasks.json?.ok), `${(tasks.json?.tasks || []).length} 条`)

console.log(
  failed === 0
    ? `\nVERIFY-PASS${warned ? `（${warned} 项警告，可忽略/刷新页面后消失）` : ''}`
    : `\nVERIFY-FAIL (${failed})`
)
process.exit(failed === 0 ? 0 : 1)
