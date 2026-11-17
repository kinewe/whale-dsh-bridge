/**
 * 路径、默认值与持久化设置。
 *
 * 版本隔离约定：本插件不写 DSH 安装目录、不改 DSH 其它 profile；自己的数据全部放在
 * $DSH_HOME/whale-bridge/ 下（settings.json / bridge.log / backups/ / tasks.json）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PACKAGE_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

export const PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access']
export const MODES = ['standard', 'creator']

/** 文件通道默认值（与 lib/file-channel.js 共用；放这里避免循环 import）。 */
export const FILES_DEFAULTS = {
  enabled: true,
  autoOutbox: true,
  maxFileMB: 20,
  linkTtlHours: 24,
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function stateDir() {
  return path.join(dshHome(), 'whale-bridge')
}

export function settingsPath() {
  return path.join(stateDir(), 'settings.json')
}

export function logPath() {
  return path.join(stateDir(), 'bridge.log')
}

export function backupsDir() {
  return path.join(stateDir(), 'backups')
}

export function profileName() {
  return 'whale-agent'
}

export function profileDir() {
  return path.join(dshHome(), 'profiles', profileName())
}

export const DEFAULTS = {
  port: 8789,
  workspace: 'D:\\dsh_work',
  permission: 'workspace-write',
  trustAllChats: false,
  mode: 'standard',
  whaleDir: 'F:\\鲸鱼娘\\whale-girl',
  model: '',
  reasoningEffort: 'max',
  defaultSessionId: '',
  personaFile: path.join(stateDir(), 'persona.md'),
  maxSteps: 4,
  timeoutMs: 600000,
  statusNarration: true,
  statusIntervalSec: 90,
  // 相似任务是否自动接上之前的 DSH 会话：off = 每次都新会话；auto = 模型判断相关才续
  continuity: 'auto',
  // 聊天大脑：upstream = 插件调上游模型（旧模式）；dsh = 第一手聊天直接交给 DSH 会话
  brain: 'upstream',
  // DSH 原生模式：chatId → DSH sessionId 映射（插件自己维护，不通过 API 手改）
  chatSessions: {},
  upstream: { baseUrl: '', apiKey: '', model: '' },
  // 文件通道：出站 media/outbox 下载、入站网页上传（详见 lib/file-channel.js）
  files: { ...FILES_DEFAULTS },
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalize(input) {
  const out = { ...DEFAULTS }
  if (!isPlainObject(input)) return out
  // bootstrap（cordis patch 的 config）与 settings.json 共用同一形状
  for (const key of ['workspace', 'whaleDir', 'model', 'defaultSessionId', 'personaFile']) {
    if (typeof input[key] === 'string' && input[key].trim()) out[key] = input[key].trim()
  }
  if (Number.isFinite(Number(input.port))) {
    const port = Number(input.port)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) out.port = port
  }
  if (Number.isFinite(Number(input.maxSteps))) {
    out.maxSteps = Math.max(1, Math.min(8, Math.floor(Number(input.maxSteps))))
  }
  if (Number.isFinite(Number(input.timeoutMs))) {
    out.timeoutMs = Math.max(30000, Math.min(3600000, Math.floor(Number(input.timeoutMs))))
  }
  if (typeof input.statusNarration === 'boolean') out.statusNarration = input.statusNarration
  if (Number.isFinite(Number(input.statusIntervalSec))) {
    out.statusIntervalSec = Math.max(30, Math.min(600, Math.floor(Number(input.statusIntervalSec))))
  }
  if (input.continuity === 'off' || input.continuity === 'auto') out.continuity = input.continuity
  if (['low', 'medium', 'high', 'max'].includes(input.reasoningEffort)) out.reasoningEffort = input.reasoningEffort
  if (input.brain === 'dsh' || input.brain === 'upstream') out.brain = input.brain
  if (isPlainObject(input.chatSessions)) out.chatSessions = normalizeChatSessions(input.chatSessions)
  if (PERMISSIONS.includes(input.permission)) out.permission = input.permission
  if (input.trustAllChats === true) out.trustAllChats = true
  else if (input.trustAllChats === false) out.trustAllChats = false
  if (MODES.includes(input.mode)) out.mode = input.mode
  if (isPlainObject(input.upstream)) {
    out.upstream = {
      baseUrl: typeof input.upstream.baseUrl === 'string' ? input.upstream.baseUrl.trim() : '',
      apiKey: typeof input.upstream.apiKey === 'string' ? input.upstream.apiKey : '',
      model: typeof input.upstream.model === 'string' ? input.upstream.model.trim() : '',
    }
  }
  out.files = normalizeFiles(input.files, DEFAULTS.files)
  return out
}

/** 文件通道设置：逐项校验，非法项回退默认值。 */
export function normalizeFiles(input, base = FILES_DEFAULTS) {
  const out = { ...base }
  if (!isPlainObject(input)) return out
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled
  if (typeof input.autoOutbox === 'boolean') out.autoOutbox = input.autoOutbox
  if (Number.isFinite(Number(input.maxFileMB))) {
    out.maxFileMB = Math.max(1, Math.min(500, Math.floor(Number(input.maxFileMB))))
  }
  if (Number.isFinite(Number(input.linkTtlHours))) {
    out.linkTtlHours = Math.max(1, Math.min(720, Math.floor(Number(input.linkTtlHours))))
  }
  return out
}

/** DSH 原生模式的聊天→会话映射：逐项清洗，最多保留 120 条。 */
export function normalizeChatSessions(input) {
  const out = {}
  if (!isPlainObject(input)) return out
  const rows = Object.entries(input)
    .filter(([, v]) => isPlainObject(v) && typeof v.sessionId === 'string' && v.sessionId.trim())
    .map(([k, v]) => [String(k), {
      sessionId: String(v.sessionId).trim(),
      updatedAt: Number(v.updatedAt) || 0,
      title: typeof v.title === 'string' ? v.title.slice(0, 60) : '',
    }])
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, 120)
  for (const [k, v] of rows) out[k] = v
  return out
}

/** 校验 PUT /api/settings 的部分更新，返回 { settings, errors }。 */
export function applyPatch(current, patch) {
  const errors = []
  const next = { ...current, upstream: { ...(current.upstream || {}) } }
  if (!isPlainObject(patch)) return { settings: next, errors: ['请求体必须是 JSON 对象'] }

  if ('port' in patch) {
    const port = Number(patch.port)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) next.port = port
    else errors.push('端口必须是 1-65535 的整数')
  }
  if ('workspace' in patch) {
    const ws = String(patch.workspace || '').trim()
    if (!ws) errors.push('工作区不能为空')
    else if (!path.isAbsolute(ws)) errors.push('工作区必须是绝对路径')
    else next.workspace = ws
  }
  if ('whaleDir' in patch) {
    const dir = String(patch.whaleDir || '').trim()
    if (!dir) errors.push('鲸鱼娘目录不能为空')
    else if (!path.isAbsolute(dir)) errors.push('鲸鱼娘目录必须是绝对路径')
    else next.whaleDir = dir
  }
  if ('permission' in patch) {
    if (PERMISSIONS.includes(patch.permission)) next.permission = patch.permission
    else errors.push(`权限必须是 ${PERMISSIONS.join(' / ')} 之一`)
  }
  if ('trustAllChats' in patch) {
    if (typeof patch.trustAllChats === 'boolean') next.trustAllChats = patch.trustAllChats
    else errors.push('trustAllChats 必须是布尔值')
  }
  if ('mode' in patch) {
    if (MODES.includes(patch.mode)) next.mode = patch.mode
    else errors.push(`模式必须是 ${MODES.join(' / ')} 之一`)
  }
  if ('model' in patch) next.model = String(patch.model || '').trim()
  if ('reasoningEffort' in patch) {
    if (['low', 'medium', 'high', 'max'].includes(patch.reasoningEffort)) next.reasoningEffort = patch.reasoningEffort
    else errors.push('reasoningEffort 必须是 low / medium / high / max')
  }
  if ('defaultSessionId' in patch) next.defaultSessionId = String(patch.defaultSessionId || '').trim()
  if ('personaFile' in patch) {
    const pf = String(patch.personaFile || '').trim()
    if (!pf || path.isAbsolute(pf)) next.personaFile = pf
    else errors.push('personaFile 必须是绝对路径')
  }
  if ('maxSteps' in patch) {
    const n = Number(patch.maxSteps)
    if (Number.isInteger(n) && n >= 1 && n <= 8) next.maxSteps = n
    else errors.push('maxSteps 必须是 1-8 的整数')
  }
  if ('timeoutMs' in patch) {
    const n = Number(patch.timeoutMs)
    if (Number.isFinite(n) && n >= 30000) next.timeoutMs = Math.min(3600000, Math.floor(n))
    else errors.push('timeoutMs 至少 30000')
  }
  if ('statusNarration' in patch) {
    if (typeof patch.statusNarration === 'boolean') next.statusNarration = patch.statusNarration
    else errors.push('statusNarration 必须是布尔值')
  }
  if ('statusIntervalSec' in patch) {
    const n = Number(patch.statusIntervalSec)
    if (Number.isInteger(n) && n >= 30 && n <= 600) next.statusIntervalSec = n
    else errors.push('statusIntervalSec 必须是 30-600 的整数（秒）')
  }
  if ('continuity' in patch) {
    if (patch.continuity === 'off' || patch.continuity === 'auto') next.continuity = patch.continuity
    else errors.push("continuity 必须是 'off' 或 'auto'")
  }
  if ('brain' in patch) {
    if (patch.brain === 'upstream' || patch.brain === 'dsh') next.brain = patch.brain
    else errors.push("brain 必须是 'upstream' 或 'dsh'")
  }
  if ('chatSessions' in patch) {
    if (isPlainObject(patch.chatSessions)) next.chatSessions = normalizeChatSessions(patch.chatSessions)
    else errors.push('chatSessions 必须是对象')
  }
  if ('upstream' in patch && isPlainObject(patch.upstream)) {
    const before = { ...next.upstream }
    next.upstream = { ...next.upstream, ...normalize({ upstream: patch.upstream }).upstream }
    // 防止把 upstream 指回自己（曾因反向同步把鲸鱼娘指向插件的 baseUrl 抄进来 → /v1 递归）
    try {
      const u = new URL(next.upstream.baseUrl)
      const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
      if (loopback && port === Number(next.port || current.port)) {
        errors.push('upstream.baseUrl 不能指向桥接自身（会造成 /v1 递归）')
        next.upstream.baseUrl = before.baseUrl || ''
      }
    } catch {
      /* 空/非法 URL 交给运行时上游错误处理 */
    }
  }
  if ('files' in patch) {
    if (!isPlainObject(patch.files)) {
      errors.push('files 必须是对象')
    } else {
      next.files = normalizeFiles(patch.files, { ...(current.files || FILES_DEFAULTS) })
    }
  }
  return { settings: next, errors }
}

export class SettingsStore {
  constructor(bootstrap) {
    this.bootstrap = normalize(bootstrap)
    this.current = this.load()
  }

  load() {
    fs.mkdirSync(stateDir(), { recursive: true })
    let saved = {}
    try {
      const raw = fs.readFileSync(settingsPath(), 'utf8')
      saved = JSON.parse(raw)
    } catch (err) {
      if (err && err.code !== 'ENOENT') this.broken = String(err && err.message ? err.message : err)
    }
    // 优先级：settings.json > cordis patch 的 bootstrap > 默认值
    return normalize({ ...this.bootstrap, ...(isPlainObject(saved) ? saved : {}) })
  }

  get() {
    return this.current
  }

  patch(patch) {
    const { settings, errors } = applyPatch(this.current, patch)
    if (errors.length) return { ok: false, errors, settings: this.current }
    this.current = settings
    this.save()
    return { ok: true, errors: [], settings }
  }

  save() {
    fs.mkdirSync(stateDir(), { recursive: true })
    const tmp = settingsPath() + '.' + Math.random().toString(16).slice(2) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2), 'utf8')
    fs.renameSync(tmp, settingsPath())
  }
}

export function appendLog(line) {
  try {
    const dir = stateDir()
    if (!fs.existsSync(dir)) return
    const stamp = new Date().toISOString()
    fs.appendFileSync(logPath(), `[${stamp}] ${line}\n`, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}
