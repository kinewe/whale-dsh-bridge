#!/usr/bin/env node
/**
 * 给鲸鱼娘打「DSH 原生聊天」补丁（幂等，可回滚）。
 *
 * 做两件事（只改鲸鱼娘内部，不动微信桥）：
 *   1. src/llm.js：provider 请求带 `x-whale-chat` 头（告诉 DSH 插件这是哪个聊天）；
 *      本地 provider 超时提到 900s（DSH 任务可能跑几分钟）。
 *   2. src/bot.js：新增 chatKeyOf(msg)，5 处 llm.complete/stream 调用带 chat key。
 *
 * 用法（在鲸鱼娘目录外任意位置）：
 *   "<鲸鱼娘>\runtime\node.exe" "<插件>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>"
 *   "<鲸鱼娘>\runtime\node.exe" "<插件>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>" --revert
 *
 * 退出码：0 = 成功/已打过；1 = 失败（失败会自动还原备份）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function fail(message) {
  console.error('[patch-whale-native] 失败：' + message)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { whale: '', revert: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--whale') out.whale = String(argv[i + 1] || '').trim()
    else if (arg === '--revert') out.revert = true
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node patch-whale-native.mjs --whale <鲸鱼娘目录> [--revert]')
      process.exit(0)
    }
  }
  return out
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

function read(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
}

function write(file, text) {
  fs.writeFileSync(file, text, 'utf8')
}

function check(file, nodeCmd) {
  const result = spawnSync(nodeCmd, ['--check', file], { encoding: 'utf8' })
  return { ok: result.status === 0, output: String(result.stderr || result.stdout || '') }
}

function patchLlm(js) {
  let out = js
  // 1) 本地（自定义）provider 超时 900s
  if (/this\.timeoutMs = ds\.timeoutMs \|\| \(rt\.isLocal \? 900000 : 45000\);/.test(out)) {
    // already
  } else if (/this\.timeoutMs = ds\.timeoutMs \|\| 45000;/.test(out)) {
    out = out.replace(
      'this.timeoutMs = ds.timeoutMs || 45000;',
      '// DSH 原生模式下聊天请求要等 DSH 任务跑完（可能几分钟），本地通道给足时间\n' +
        '    this.timeoutMs = ds.timeoutMs || (rt.isLocal ? 900000 : 45000);'
    )
  } else {
    throw new Error('src/llm.js：找不到 timeoutMs 行（版本可能不匹配）')
  }
  // 2) _open 支持 chat 头
  if (!out.includes('x-whale-chat')) {
    if (!out.includes('  _open(payload, { signal, stream }) {')) {
      throw new Error('src/llm.js：找不到 _open 签名（版本可能不匹配）')
    }
    out = out.replace('  _open(payload, { signal, stream }) {', '  _open(payload, { signal, stream, chat }) {')
    const anchor = "    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;"
    if (!out.includes(anchor)) throw new Error('src/llm.js：找不到 Authorization 行（版本可能不匹配）')
    out = out.replace(
      anchor,
      anchor +
        "\n    // 把「这是哪个聊天」带给 DSH 桥接（它用这个 key 维持同一个 DSH 会话）\n" +
        "    if (chat) headers['x-whale-chat'] = encodeURIComponent(String(chat));"
    )
  }
  // 3) complete / stream 透传 chat
  if (!out.includes('async complete({ system, turns, maxTokens, chat })')) {
    out = out.replace('async complete({ system, turns, maxTokens }) {', 'async complete({ system, turns, maxTokens, chat }) {')
  }
  out = out.replace(
    'const { res } = await this._open(payload, { stream: false });',
    'const { res } = await this._open(payload, { stream: false, chat });'
  )
  if (!out.includes('async *stream({ system, turns, signal, chat })')) {
    out = out.replace('async *stream({ system, turns, signal }) {', 'async *stream({ system, turns, signal, chat }) {')
  }
  out = out.replace(
    'const { req, res } = await this._open(payload, { signal, stream: true });',
    'const { req, res } = await this._open(payload, { signal, stream: true, chat });'
  )
  // 4) trust 头（主人在群里也放行 DSH 工具；本地网页=可信）
  if (!out.includes('x-whale-trust')) {
    out = out.replace(
      '  _open(payload, { signal, stream, chat }) {',
      '  _open(payload, { signal, stream, chat, trust }) {'
    )
    out = out.replace(
      "    if (chat) headers['x-whale-chat'] = encodeURIComponent(String(chat));",
      "    if (chat) headers['x-whale-chat'] = encodeURIComponent(String(chat));\n" +
        "    // 是否主人/本地网页（决定 DSH 桥接是否放行 DSH 工具）\n" +
        "    if (trust !== undefined && trust !== null && trust !== '') headers['x-whale-trust'] = String(trust);"
    )
    out = out.replace(
      'async complete({ system, turns, maxTokens, chat }) {',
      'async complete({ system, turns, maxTokens, chat, trust }) {'
    )
    out = out.replace(
      'const { res } = await this._open(payload, { stream: false, chat });',
      'const { res } = await this._open(payload, { stream: false, chat, trust });'
    )
    out = out.replace(
      'async *stream({ system, turns, signal, chat }) {',
      'async *stream({ system, turns, signal, chat, trust }) {'
    )
    out = out.replace(
      'const { req, res } = await this._open(payload, { signal, stream: true, chat });',
      'const { req, res } = await this._open(payload, { signal, stream: true, chat, trust });'
    )
  }
  return out
}

function patchBot(js) {
  let out = js
  if (!out.includes('function chatKeyOf(')) {
    const anchor = 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));'
    if (!out.includes(anchor)) throw new Error('src/bot.js：找不到 sleep 锚点（版本可能不匹配）')
    out = out.replace(
      anchor,
      anchor +
        '\n\n/** 把一次聊天映射成稳定的 key（DSH 桥接按它维持同一个 DSH 会话）。 */\n' +
        'function chatKeyOf(msg) {\n' +
        "  if (!msg) return '';\n" +
        "  return [msg.platform || 'web', msg.chatType || 'private', msg.chatId || msg.senderId || ''].join('|');\n" +
        '}'
    )
  }
  const streamCall =
    'for await (const piece of this.llm.stream({ system: decision.system, turns: decision.turns, signal })) {'
  if (out.includes(streamCall)) {
    out = out.replace(
      streamCall,
      'for await (const piece of this.llm.stream({ system: decision.system, turns: decision.turns, signal, chat: chatKeyOf(decision.msg) })) {'
    )
  }
  out = out.split('this.llm.complete({ system: decision.system, turns: decision.turns })').join(
    'this.llm.complete({ system: decision.system, turns: decision.turns, chat: chatKeyOf(decision.msg) })'
  )
  if (out.includes('              turns: decision.turns,\n            });') && !out.includes('              chat: chatKeyOf(decision.msg),')) {
    out = out.replace(
      '              turns: decision.turns,\n            });',
      '              turns: decision.turns,\n              chat: chatKeyOf(decision.msg),\n            });'
    )
  }
  out = out.replace(
    "retried = await this.llm.complete({ system: sys, turns: cur ? [{ role: 'user', content: cur }] : [] });",
    "retried = await this.llm.complete({ system: sys, turns: cur ? [{ role: 'user', content: cur }] : [], chat: chatKeyOf(decision.msg) });"
  )
  // trust：主人/本地网页放行 DSH 工具（群里的主人也放行）
  if (!out.includes('function trustOf(')) {
    const chatFn = out.indexOf('function chatKeyOf(msg) {')
    if (chatFn >= 0) {
      const end = out.indexOf('\n}\n', chatFn)
      if (end >= 0) {
        const helper =
          '\n\n/** 这条消息是否来自主人/本地网页（决定是否允许 DSH 工具；群里主人也放行）。 */\n' +
          'function trustOf(decision) {\n' +
          "  const msg = decision && decision.msg ? decision.msg : {};\n" +
          "  const platform = String(msg.platform || 'web').toLowerCase();\n" +
          "  return platform === 'web' || msg.isMaster ? '1' : '0';\n" +
          '}'
        out = out.slice(0, end + 3) + helper + out.slice(end + 3)
      }
    }
  }
  out = out.replace(
    'chat: chatKeyOf(decision.msg) }',
    'chat: chatKeyOf(decision.msg), trust: trustOf(decision) }'
  )
  out = out.replace(
    '              chat: chatKeyOf(decision.msg),\n',
    '              chat: chatKeyOf(decision.msg),\n              trust: trustOf(decision),\n'
  )
  return out
}

const args = parseArgs(process.argv.slice(2))
if (!args.whale) fail('缺少 --whale <鲸鱼娘目录>')
const whaleDir = path.resolve(args.whale)
const llmPath = path.join(whaleDir, 'src', 'llm.js')
const botPath = path.join(whaleDir, 'src', 'bot.js')
for (const file of [llmPath, botPath]) {
  if (!fs.existsSync(file)) fail('找不到文件：' + file)
}
const backupDir = path.join(whaleDir, 'data', 'restore-backups', 'whale-native-' + stamp)

if (args.revert) {
  const root = path.join(whaleDir, 'data', 'restore-backups')
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => name.startsWith('whale-native-')).sort().reverse()
    : []
  if (!dirs.length) fail('没有找到 whale-native 备份目录，无法回滚')
  const latest = path.join(root, dirs[0])
  for (const name of ['llm.js', 'bot.js']) {
    const src = path.join(latest, name)
    const dst = path.join(whaleDir, 'src', name)
    if (!fs.existsSync(src)) fail('备份里缺少 ' + name)
    fs.copyFileSync(src, dst)
  }
  console.log('[patch-whale-native] 已回滚到备份：' + latest)
  process.exit(0)
}

const needLlm = !read(llmPath).includes('x-whale-chat') || !read(llmPath).includes('x-whale-trust')
const needBot = !read(botPath).includes('function chatKeyOf(') || !read(botPath).includes('function trustOf(')
if (!needLlm && !needBot) {
  console.log('[patch-whale-native] 已经是补丁后的状态，无需修改。')
  process.exit(0)
}

fs.mkdirSync(backupDir, { recursive: true })
fs.copyFileSync(llmPath, path.join(backupDir, 'llm.js'))
fs.copyFileSync(botPath, path.join(backupDir, 'bot.js'))
console.log('[patch-whale-native] 备份：' + backupDir)

try {
  if (needLlm) write(llmPath, patchLlm(read(llmPath)))
  if (needBot) write(botPath, patchBot(read(botPath)))
  const nodeCmd = process.execPath
  const checkLlm = check(llmPath, nodeCmd)
  const checkBot = check(botPath, nodeCmd)
  if (!checkLlm.ok || !checkBot.ok) {
    throw new Error('语法检查失败：' + (checkLlm.output || checkBot.output || '').slice(0, 300))
  }
} catch (err) {
  // 失败自动还原
  fs.copyFileSync(path.join(backupDir, 'llm.js'), llmPath)
  fs.copyFileSync(path.join(backupDir, 'bot.js'), botPath)
  fail(String((err && err.message) || err) + '（已自动还原）')
}

console.log('[patch-whale-native] 完成：src/llm.js + src/bot.js 已打补丁，语法检查通过。')
console.log('[patch-whale-native] 重启鲸鱼娘服务后生效：runtime\\node.exe server.js --no-browser')
