#!/usr/bin/env node
/**
 * DSH 原生链路一键自检（只读，不改任何东西）。
 *
 * 用法（在任意目录）：
 *   "<鲸鱼娘>\runtime\node.exe" "<插件>\whale-side\check-native-chain.mjs"
 *   可选：--bridge http://127.0.0.1:8789 --whale http://127.0.0.1:8787 --json
 *
 * 检查：桥接健康 / brain=dsh / 聊天→DSH 会话映射 / 鲸鱼娘服务与映射一致 /
 *       微信网关在线 / DSH profile 就绪 / 主人名单（安全边界）/ 页面注入。
 * 退出码：0 = 全通过（warn 不算失败）；1 = 有 FAIL。
 */
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const out = { bridge: 'http://127.0.0.1:8789', whale: 'http://127.0.0.1:8787', json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--bridge') out.bridge = String(argv[i + 1] || out.bridge)
    else if (a === '--whale') out.whale = String(argv[i + 1] || out.whale)
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      console.log('用法：node check-native-chain.mjs [--bridge URL] [--whale URL] [--json]')
      process.exit(0)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const checks = []
function add(name, ok, detail = '', warn = false) {
  checks.push({ name, ok, detail, warn })
}
async function jsonFetch(url, timeoutMs = 8000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text.slice(0, 200) }
  }
  return { status: res.status, data }
}

// 1. 桥接健康
let state = null
try {
  const health = await jsonFetch(args.bridge + '/api/health')
  add('桥接 /api/health', health.status === 200 && health.data.ok === true, 'v=' + (health.data.version || '?'))
  const st = await jsonFetch(args.bridge + '/api/state')
  state = st.data && st.data.ok ? st.data : null
  add('桥接 /api/state', Boolean(state), state ? '' : '无法读取状态')
} catch (err) {
  add('桥接连通', false, String(err && err.message ? err.message : err))
}

// 2. 大脑模式 + 会话映射
try {
  const brain = await jsonFetch(args.bridge + '/api/brain')
  const b = brain.data || {}
  add('brain=dsh（DSH 原生）', b.brain === 'dsh', 'brain=' + (b.brain || '?'))
  add('聊天→DSH 会话映射', Array.isArray(b.sessions) && b.sessions.length > 0, 'sessions=' + (b.sessions ? b.sessions.length : 0), true)
} catch (err) {
  add('brain API', false, String(err && err.message ? err.message : err))
}

// 3. 鲸鱼娘服务与映射
if (state && state.status && state.status.whale) {
  const whale = state.status.whale
  add('鲸鱼娘目录有效', Boolean(whale.exists && whale.hasConfig), whale.dir || '')
  add('鲸鱼娘服务运行中', Boolean(whale.running), 'pid=' + (whale.pid || '?'))
  const expected = args.bridge.replace(/\/+$/, '') + '/v1'
  const actual = String(whale.baseUrl || '').replace(/\/+$/, '')
  add('鲸鱼娘 provider 指向本插件', whale.provider === 'custom' && actual === expected, actual || '')
  add('聊天页注入（文件通道）', Boolean(whale.chatPageInjected), '')
  add('DSH 任务 profile 就绪', Boolean(state.status.dsh && state.status.dsh.profile && state.status.dsh.profile.ready), '')
  // 4. 主人名单（安全边界）
  try {
    const cfgPath = path.join(String(whale.dir || ''), 'config.json')
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''))
    const master = (cfg.persona && cfg.persona.master) || {}
    const wxids = Array.isArray(master.wxids) ? master.wxids.filter(Boolean) : []
    add('主人名单 persona.master.wxids（DSH 工具白名单）', wxids.length > 0, 'wxids=' + wxids.length)
  } catch (err) {
    add('主人名单读取', false, String(err && err.message ? err.message : err), true)
  }
} else {
  add('鲸鱼娘状态', false, '桥接状态里没有 whale 信息')
}

// 5. 微信网关在线（可选，鲸鱼娘网页状态下才有该字段；重启后心跳有几秒延迟，重试几次）
try {
  let st = null
  for (let i = 0; i < 5; i += 1) {
    st = await jsonFetch(args.whale + '/api/status')
    const gw = ((st.data && st.data.gateways) || []).find((g) => g && g.platform === 'wechat')
    if (gw && gw.bridge && gw.bridge.online === true) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  const gateways = (st && st.data && st.data.gateways) || []
  const wechat = gateways.find((g) => g && g.platform === 'wechat')
  if (wechat && wechat.bridge) {
    add('微信网关在线', wechat.bridge.online === true, 'listener=' + wechat.bridge.listener + ' uia=' + wechat.bridge.uia)
    add('微信账号已确认', wechat.bridge.accountOk !== false, wechat.bridge.accountNick || '')
  } else {
    add('微信网关状态', false, '鲸鱼娘 /api/status 里没有 wechat 网关', true)
  }
} catch (err) {
  add('鲸鱼娘 /api/status', false, String(err && err.message ? err.message : err), true)
}

const failed = checks.filter((c) => !c.ok && !c.warn)
const warned = checks.filter((c) => !c.ok && c.warn)
if (args.json) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
} else {
  for (const c of checks) {
    const tag = c.ok ? 'PASS' : c.warn ? 'WARN' : 'FAIL'
    console.log(`${tag} ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
  }
  console.log(`\n结果：${checks.length - failed.length - warned.length} PASS / ${warned.length} WARN / ${failed.length} FAIL`)
  if (failed.length === 0) {
    console.log('DSH 原生链路自检通过。主人在微信私聊/网页聊天里说话 = DSH 会话回复；发「新会话」可重开。')
  }
}
process.exit(failed.length === 0 ? 0 : 1)
