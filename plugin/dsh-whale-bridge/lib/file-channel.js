/**
 * 文件通道（参考本机 Hermes 网关的 media 设计，纯 Node 内置模块实现）：
 *
 *  出站（DSH → 用户）：
 *    - DSH 任务最终文本里出现 `MEDIA:<绝对路径>` 行 → 提取、校验、剥掉标记；
 *    - 任务期间在 `<工作区>\.whale-bridge\outbox\` 新增的文件自动收集；
 *    - 每个文件登记一个一次性下载 URL（/files/<token>/<name>），桥接把它附在最终回复末尾，
 *      鲸鱼娘网页里由注入脚本渲染成可点击链接。
 *
 *  入站（用户 → DSH）：
 *    - 鲸鱼娘网页「📎」上传 → POST /api/upload（base64 JSON）→ 落到
 *      `<工作区>\.whale-bridge\inbox\`；
 *    - 聊天请求里以 `[Shared attachment] file: <绝对路径>` 形式带上路径提示；
 *      代理把该提示放进 system 消息，模型把路径写进 dsh_task 后 DSH 就能读。
 *
 * 安全（照抄 Hermes 的思路，按本桥接简化）：
 *    - 只允许白名单扩展名；单文件大小上限（settings.files.maxFileMB，默认 20MB）；
 *    - 不读 DSH 数据目录（~/.dsh）、SSH/云凭据、.env、私钥类文件；
 *    - 下载地址用随机 token，不接受任意路径；token 有 TTL；
 *    - 上传只写 inbox，文件名净化，不覆盖已存在文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { FILES_DEFAULTS, dshHome } from './config.js'

/** 允许收发的扩展名（小写，含点）。 */
export const ALLOWED_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yaml', '.yml', '.toml', '.ini', '.xml',
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp',
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.mp3', '.wav', '.m4a', '.ogg', '.flac',
  '.mp4', '.webm', '.mov', '.mkv',
  '.html', '.htm', '.css',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.ps1', '.bat', '.cmd', '.sh', '.sql', '.java', '.kt', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.rb', '.php', '.lua', '.vue',
  '.whale.json', '.apk', '.exe', '.dll', '.pdb', '.map',
]

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/jsonl; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.cmd': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.html.whale': 'text/html; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
}

const MEDIA_LINE_RE = /^[ \t]*MEDIA:[ \t]*(.+?)[ \t]*$/gim
const ATTACHMENT_RE = /\[Shared attachment\]\s*file:\s*([^\r\n]+)/gi
const MAX_REGISTRY = 200
const MAX_SCAN_FILES = 500
const MAX_SCAN_DEPTH = 3

function unquote(value) {
  const text = String(value || '').trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")) || (text.startsWith('`') && text.endsWith('`'))) {
    return text.slice(1, -1).trim()
  }
  return text
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'))
  let cleaned = base
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  if (!cleaned) cleaned = 'file'
  if (cleaned.length > 120) {
    const ext = path.extname(cleaned).slice(0, 20)
    cleaned = cleaned.slice(0, 120 - ext.length) + ext
  }
  return cleaned
}

function isUnder(parent, child) {
  try {
    const parentReal = fs.realpathSync(parent)
    const childReal = fs.realpathSync(child)
    const rel = path.relative(parentReal, childReal)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  } catch {
    // 路径尚不存在时用词法比较兜底（敏感路径判断不能依赖文件存在）
    return isUnderLexical(parent, child)
  }
}

function isUnderLexical(parent, child) {
  const parentAbs = path.resolve(String(parent || ''))
  const childAbs = path.resolve(String(child || ''))
  const rel = path.relative(parentAbs, childAbs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 敏感路径（绝不下发/收取）。 */
export function isSensitivePath(absPath) {
  const p = path.resolve(String(absPath || ''))
  const home = os.homedir()
  const blockedRoots = [
    dshHome(),
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.azure'),
    path.join(home, '.kube'),
    path.join(home, 'AppData', 'Roaming', 'gcloud'),
  ]
  for (const root of blockedRoots) {
    if (!root) continue
    if (isUnder(root, p)) return '该路径属于敏感目录，禁止收发'
  }
  const base = path.basename(p).toLowerCase()
  if (/^\.(env|env\..+|credentials|credentials\..+|npmrc|netrc|git-credentials|pgpass)$/.test(base)) {
    return '敏感配置文件禁止收发：' + base
  }
  if (/\.(pem|key|pfx|p12|jks|keystore)$/.test(base)) return '私钥/证书文件禁止收发：' + base
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(base)) return 'SSH 私钥禁止收发：' + base
  return ''
}

export class FileChannel {
  constructor({ getSettings, logger, getPort } = {}) {
    this.getSettings = getSettings || (() => ({}))
    this.log = logger || (() => {})
    this.getPort = getPort || (() => Number(this.getSettings().port) || 8789)
    /** token → { token, path, name, size, ext, mime, at, source } */
    this.registry = new Map()
  }

  filesSettings() {
    const settings = this.getSettings() || {}
    return { ...FILES_DEFAULTS, ...(settings.files && typeof settings.files === 'object' ? settings.files : {}) }
  }

  enabled() {
    return this.filesSettings().enabled !== false
  }

  workspace() {
    return String((this.getSettings() || {}).workspace || '')
  }

  dirs(workspace) {
    const ws = path.resolve(workspace || this.workspace())
    return {
      workspace: ws,
      outbox: path.join(ws, '.whale-bridge', 'outbox'),
      inbox: path.join(ws, '.whale-bridge', 'inbox'),
    }
  }

  ensureDirs(workspace) {
    const dirs = this.dirs(workspace)
    fs.mkdirSync(dirs.inbox, { recursive: true })
    fs.mkdirSync(dirs.outbox, { recursive: true })
    return dirs
  }

  /**
   * 清理工作区里的额外缓存（inbox/outbox/pdf-pages/attn），保留天数跟随鲸鱼娘
   * config.json 的 storage.mediaKeepDays（默认 7 天）。
   */
  cleanupOldBuffers(keepDaysOverride) {
    const settings = this.getSettings() || {}
    let keepDays = Number(keepDaysOverride)
    try {
      const whaleDir = String(settings.whaleDir || '').trim()
      if (whaleDir) {
        const cfg = JSON.parse(
          fs.readFileSync(path.join(whaleDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '')
        )
        const d = Number((cfg.storage || {}).mediaKeepDays)
        if (Number.isFinite(d) && d >= 1) keepDays = d
      }
    } catch {
      /* 用默认值 */
    }
    if (!Number.isFinite(keepDays) || keepDays < 1) keepDays = 7
    const dirs = this.dirs(settings.workspace)
    const base = path.dirname(dirs.inbox)
    const roots = [dirs.inbox, dirs.outbox, path.join(base, 'pdf-pages'), path.join(base, 'attn')]
    const cutoff = Date.now() - keepDays * 86400000
    let removed = 0
    const walk = (dir) => {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          walk(full)
          try {
            if (!fs.readdirSync(full).length) fs.rmdirSync(full)
          } catch {
            /* ignore */
          }
          continue
        }
        try {
          const st = fs.statSync(full)
          if (st.mtimeMs < cutoff) {
            fs.unlinkSync(full)
            removed += 1
          }
        } catch {
          /* ignore */
        }
      }
    }
    for (const root of roots) walk(root)
    try {
      this.log(`[files] cleanup: removed ${removed} buffer file(s) older than ${keepDays}d`)
    } catch {
      /* ignore */
    }
    return { removed, keepDays }
  }

  maxBytes() {
    const mb = Number(this.filesSettings().maxFileMB)
    const safe = Number.isFinite(mb) && mb > 0 ? Math.min(mb, 500) : FILES_DEFAULTS.maxFileMB
    return Math.floor(safe * 1024 * 1024)
  }

  uploadBodyLimit() {
    // base64 膨胀约 4/3，再留 1MB 余量
    return Math.ceil(this.maxBytes() * 1.4) + 1024 * 1024
  }

  linkTtlMs() {
    const hours = Number(this.filesSettings().linkTtlHours)
    const safe = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) : FILES_DEFAULTS.linkTtlHours
    return safe * 3600 * 1000
  }

  extensionAllowed(absPath) {
    const lower = String(absPath || '').toLowerCase()
    return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))
  }

  /** 校验一个真实文件能否作为下载产物。 */
  validateFile(absPath, { source = 'media', workspace } = {}) {
    if (!this.enabled()) return { ok: false, reason: '文件通道已关闭' }
    const input = String(absPath || '').trim()
    if (!input) return { ok: false, reason: '路径为空' }
    if (!path.isAbsolute(input)) return { ok: false, reason: '需要绝对路径：' + input }
    const resolved = path.resolve(input)
    let stat
    try {
      stat = fs.statSync(resolved)
    } catch {
      return { ok: false, reason: '文件不存在：' + resolved }
    }
    if (!stat.isFile()) return { ok: false, reason: '不是普通文件：' + resolved }
    if (stat.size > this.maxBytes()) {
      return { ok: false, reason: `文件超过上限（${formatSize(stat.size)} > ${formatSize(this.maxBytes())}）` }
    }
    const sensitive = isSensitivePath(resolved)
    if (sensitive) return { ok: false, reason: sensitive }
    if (!this.extensionAllowed(resolved)) {
      return { ok: false, reason: '不允许的文件类型：' + (path.extname(resolved) || '（无扩展名）') }
    }
    if (source === 'outbox') {
      const dirs = this.dirs(workspace)
      if (!isUnder(dirs.outbox, resolved)) return { ok: false, reason: '不在 outbox 目录内：' + resolved }
    }
    return {
      ok: true,
      path: resolved,
      name: path.basename(resolved),
      size: stat.size,
      ext: path.extname(resolved).toLowerCase(),
    }
  }

  /** 从 DSH 任务最终文本里提取 `MEDIA:<绝对路径>` 行，返回清理后的文本与路径列表。 */
  extractMedia(text) {
    const raw = String(text || '')
    const found = []
    const cleaned = raw.replace(MEDIA_LINE_RE, (_match, value) => {
      const filePath = this.cleanMediaPath(unquote(value))
      if (filePath) found.push(filePath)
      return ''
    })
    return {
      text: cleaned.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim(),
      paths: found,
    }
  }

  /**
   * 清洗 MEDIA: 后面的值：去掉列表符号/包裹符/尾部大小注记（"report.pdf（782.6 KB）"），
   * 以最后一个白名单扩展名截断，避免把说明文字当成路径。
   */
  cleanMediaPath(value) {
    let text = String(value || '').trim()
    text = text.replace(/^[-*•\s]+/, '')
    const wrappers = [['**', '**'], ['__', '__'], ['`', '`'], ['"', '"'], ["'", "'"]]
    let changed = true
    while (changed) {
      changed = false
      for (const [open, close] of wrappers) {
        if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
          text = text.slice(open.length, -close.length).trim()
          changed = true
        }
      }
    }
    const lower = text.toLowerCase()
    let bestEnd = -1
    for (const ext of ALLOWED_EXTENSIONS) {
      const at = lower.lastIndexOf(ext)
      if (at >= 0 && at + ext.length > bestEnd) bestEnd = at + ext.length
    }
    if (bestEnd > 0 && bestEnd < text.length) text = text.slice(0, bestEnd)
    return text.trim()
  }

  /** 从用户消息里提取 `[Shared attachment] file: <路径>`（Hermes 约定）。 */
  attachmentsFromText(text) {
    const raw = String(text || '')
    const out = []
    let match
    ATTACHMENT_RE.lastIndex = 0
    while ((match = ATTACHMENT_RE.exec(raw))) {
      const value = unquote(match[1])
      if (value) out.push(value)
    }
    return out
  }

  /** 入站附件允许的目录：工作区 inbox/outbox + 鲸鱼娘自己的媒体缓存/微信文件目录。 */
  attachmentRoots(workspace) {
    const roots = []
    try {
      const dirs = this.dirs(workspace)
      roots.push(dirs.inbox, dirs.outbox)
    } catch {
      /* ignore */
    }
    const whaleDir = String((this.getSettings() || {}).whaleDir || '')
    if (whaleDir) {
      roots.push(path.join(whaleDir, 'data', 'media-cache'))
      roots.push(path.join(whaleDir, 'data', 'wechat-files'))
      roots.push(path.join(whaleDir, 'data', 'wechat-outbox'))
    }
    return roots
  }

  /** 校验用户消息里的附件路径，返回可用的附件信息（只收白名单目录内的文件）。 */
  resolveAttachments(texts, workspace) {
    const list = []
    const seen = new Set()
    const roots = this.attachmentRoots(workspace)
    for (const text of texts) {
      for (const rawPath of this.attachmentsFromText(text)) {
        const key = path.resolve(rawPath).toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const check = this.validateFile(rawPath, { source: 'attachment', workspace })
        if (!check.ok) {
          this.log(`[files] 附件被拒绝：${rawPath} — ${check.reason}`)
          continue
        }
        // 防伪造：只接受桥接自己的上传/下载目录 + 鲸鱼娘媒体缓存，
        // 避免有人在聊天里手打 marker 让模型读任意本机文件。
        const allowed = roots.some((root) => isUnder(root, check.path))
        if (!allowed) {
          this.log(`[files] 附件不在允许目录内，拒绝：${rawPath}`)
          continue
        }
        list.push(check)
      }
    }
    return list
  }

  prune() {
    const ttl = this.linkTtlMs()
    const now = Date.now()
    for (const [token, entry] of this.registry) {
      if (now - entry.at > ttl) this.registry.delete(token)
    }
    while (this.registry.size > MAX_REGISTRY) {
      const oldest = this.registry.keys().next().value
      if (oldest === undefined) break
      this.registry.delete(oldest)
    }
  }

  /** 登记一个文件，返回可下载条目。 */
  register(absPath, { source = 'media', workspace } = {}) {
    const check = this.validateFile(absPath, { source, workspace })
    if (!check.ok) {
      this.log(`[files] 拒绝登记：${absPath} — ${check.reason}`)
      return { ok: false, reason: check.reason }
    }
    this.prune()
    const token = crypto.randomBytes(16).toString('hex')
    const entry = {
      token,
      path: check.path,
      name: check.name,
      size: check.size,
      ext: check.ext,
      mime: MIME[check.ext] || 'application/octet-stream',
      at: Date.now(),
      source,
      url: this.urlFor(token, check.ext),
    }
    this.registry.set(token, entry)
    this.log(`[files] registered ${entry.name} (${formatSize(entry.size)}) source=${source}`)
    return { ok: true, entry }
  }

  urlFor(token, ext) {
    const port = Number(this.getPort()) || 8789
    // URL 里只放 ASCII 短名：鲸鱼娘服务端会加工/截断回复文本（! ~ () 等字符会被改写），
    // 用 file_<token8><ext> 保证链接在任何位置都安全；真实文件名只用于展示。
    const safeExt = /^\.[a-z0-9]{1,10}$/i.test(String(ext || '')) ? String(ext).toLowerCase() : ''
    return `http://127.0.0.1:${port}/files/${token}/file_${token.slice(0, 8)}${safeExt}`
  }

  /** 拼出附在回复末尾的下载信息块（尽量短，避免被鲸鱼娘气泡切坏）。 */
  buildLinkBlock(entries) {
    if (!Array.isArray(entries) || !entries.length) return ''
    const lines = []
    for (const entry of entries) {
      lines.push(`📎 ${entry.name}（${formatSize(entry.size)}）`)
      lines.push(entry.url)
    }
    return lines.join('\n')
  }

  /** outbox 快照（用于任务结束后找新增文件）。 */
  snapshotOutbox(workspace) {
    const dirs = this.dirs(workspace)
    const files = new Map()
    const walk = (dir, depth) => {
      if (depth > MAX_SCAN_DEPTH || files.size >= MAX_SCAN_FILES) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of entries) {
        if (files.size >= MAX_SCAN_FILES) return
        const full = path.join(dir, item.name)
        if (item.isDirectory()) {
          walk(full, depth + 1)
        } else if (item.isFile()) {
          try {
            const stat = fs.statSync(full)
            files.set(full.toLowerCase(), { path: full, size: stat.size, mtimeMs: stat.mtimeMs })
          } catch {
            /* ignore */
          }
        }
      }
    }
    walk(dirs.outbox, 0)
    return { at: Date.now(), files }
  }

  /** 找出快照之后 outbox 里新增/更新的文件。 */
  collectNewOutbox(workspace, snapshot) {
    if (!snapshot) return []
    const dirs = this.dirs(workspace)
    const fresh = []
    const now = this.snapshotOutbox(workspace)
    for (const [key, item] of now.files) {
      const previous = snapshot.files.get(key)
      // 新文件；或大小变化；或修改时间比快照时明显前进（避开文件系统时间粒度误差）
      if (!previous || item.size !== previous.size || item.mtimeMs - (previous.mtimeMs || 0) > 1000) {
        fresh.push(item.path)
      }
    }
    fresh.sort((a, b) => a.localeCompare(b))
    const results = []
    for (const file of fresh.slice(0, 10)) {
      const check = this.validateFile(file, { source: 'outbox', workspace })
      if (check.ok) results.push(check)
      else this.log(`[files] 跳过 outbox 文件：${file} — ${check.reason}`)
    }
    this.log(`[files] outbox scan: +${results.length}/${fresh.length} (${dirs.outbox})`)
    return results
  }

  /** 上传：base64 → inbox 文件。 */
  upload({ name, data } = {}) {
    if (!this.enabled()) return { ok: false, error: '文件通道已关闭（可在 DSH 面板里打开）' }
    const rawName = sanitizeFileName(name)
    if (typeof data !== 'string' || !data.trim()) return { ok: false, error: '缺少文件内容（base64）' }
    let buffer
    try {
      buffer = Buffer.from(data, 'base64')
    } catch {
      return { ok: false, error: 'base64 解码失败' }
    }
    if (!buffer.length) return { ok: false, error: '文件内容为空' }
    if (buffer.length > this.maxBytes()) {
      return { ok: false, error: `文件超过上限（${formatSize(buffer.length)} > ${formatSize(this.maxBytes())}）` }
    }
    const ext = path.extname(rawName).toLowerCase()
    if (!this.extensionAllowed(rawName)) return { ok: false, error: '不允许的文件类型：' + (ext || '（无扩展名）') }
    const dirs = this.ensureDirs()
    const stamp = new Date()
    const prefix = [
      stamp.getFullYear(),
      String(stamp.getMonth() + 1).padStart(2, '0'),
      String(stamp.getDate()).padStart(2, '0'),
    ].join('') + '-' + [
      String(stamp.getHours()).padStart(2, '0'),
      String(stamp.getMinutes()).padStart(2, '0'),
      String(stamp.getSeconds()).padStart(2, '0'),
    ].join('') + '-' + crypto.randomBytes(3).toString('hex')
    const storedName = `${prefix}-${rawName}`
    const target = path.join(dirs.inbox, storedName)
    fs.writeFileSync(target, buffer)
    const check = this.validateFile(target, { source: 'inbox', workspace: dirs.workspace })
    if (!check.ok) {
      try { fs.unlinkSync(target) } catch { /* ignore */ }
      return { ok: false, error: check.reason }
    }
    this.log(`[files] upload ${storedName} (${formatSize(buffer.length)})`)
    return {
      ok: true,
      file: {
        name: storedName,
        originalName: rawName,
        path: check.path,
        size: buffer.length,
        ext,
        hint: `[Shared attachment] file: ${check.path}`,
      },
    }
  }

  displayNameFromUrlName(name) {
    try {
      return decodeURIComponent(name || '') || 'file'
    } catch {
      return name || 'file'
    }
  }

  /** 下载：GET /files/<token>/<name> */
  serve(req, res, token, urlName) {
    const entry = this.registry.get(token)
    if (!entry) {
      this.writeJson(res, 404, { ok: false, error: '下载链接不存在或已过期' })
      return
    }
    if (Date.now() - entry.at > this.linkTtlMs()) {
      this.registry.delete(token)
      this.writeJson(res, 404, { ok: false, error: '下载链接已过期' })
      return
    }
    let stat
    try {
      stat = fs.statSync(entry.path)
    } catch {
      this.registry.delete(token)
      this.writeJson(res, 404, { ok: false, error: '文件已不存在' })
      return
    }
    if (!stat.isFile()) {
      this.writeJson(res, 404, { ok: false, error: '不是文件' })
      return
    }
    // 下载保存名用登记时的真实文件名（URL 里的 name 段只是 ASCII 短名，不参与查找）
    const filename = entry.name || this.displayNameFromUrlName(urlName) || 'file'
    const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    res.writeHead(200, {
      'Content-Type': entry.mime || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    })
    const stream = fs.createReadStream(entry.path)
    stream.on('error', () => {
      try { res.destroy() } catch { /* ignore */ }
    })
    stream.pipe(res)
  }

  writeJson(res, status, obj) {
    const text = JSON.stringify(obj)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    res.end(text)
  }

  /** 给面板/调试页看的概览。 */
  status() {
    const dirs = this.dirs()
    const files = [...this.registry.values()].map((entry) => ({
      name: entry.name,
      size: entry.size,
      url: entry.url,
      at: new Date(entry.at).toISOString(),
      source: entry.source,
    }))
    const settings = this.filesSettings()
    return {
      enabled: this.enabled(),
      autoOutbox: settings.autoOutbox !== false,
      maxFileMB: this.maxBytes() / 1024 / 1024,
      linkTtlHours: this.linkTtlMs() / 3600000,
      workspace: dirs.workspace,
      outbox: dirs.outbox,
      inbox: dirs.inbox,
      outboxExists: fs.existsSync(dirs.outbox),
      inboxExists: fs.existsSync(dirs.inbox),
      registered: files.slice(-20),
    }
  }
}
