/**
 * DSH 任务执行器：把任意「功能调用 / 需要动手的活」变成一个 DSH agent 任务。
 *
 * 通道（版本隔离的关键）：调用 DSH 已文档化的 headless CLI 契约
 *   dsh --profile whale-agent --json "<task>"
 * 本模块只依赖该 CLI 契约与 profile 文件，不 import DSH 内部包、不改 DSH 安装目录。
 *
 * 任务 profile `whale-agent` 由本桥接从随安装发布的 headless profile 模板生成，
 * 并写入本桥接拥有的 cordis.patch.yml（启用已保存凭据 + 模型路由 + 可选的创造模式行）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  appendLog, backupsDir, dshHome, profileDir, profileName, stateDir,
} from './config.js'

const MAX_CONCURRENT = 2
const MAX_HISTORY = 20

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 安装根（Electron resources）候选目录。 */
function resourceRoots() {
  const roots = []
  const exeDir = path.dirname(process.execPath)
  roots.push(path.join(exeDir, 'resources'))
  if (process.resourcesPath) roots.push(process.resourcesPath)
  roots.push(path.join(exeDir, '..', 'resources'))
  return [...new Set(roots)]
}

function dshDesktopCli() {
  for (const root of resourceRoots()) {
    const cli = path.join(root, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    if (fs.existsSync(cli) || fs.existsSync(path.join(root, 'app.asar'))) {
      if (fs.existsSync(cli)) return cli
    }
  }
  return undefined
}

function findOnPath(names) {
  const pathVar = process.env.PATH || ''
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      for (const ext of ['', ...exts]) {
        const full = path.join(dir, name + ext.toLowerCase())
        try {
          if (fs.existsSync(full)) return full
        } catch {
          /* ignore */
        }
      }
    }
  }
  return undefined
}

export function dshVersion() {
  const candidates = [
    process.env.DSH_CLIENT_VERSION,
    process.env.DSH_VERSION,
    readJsonSafe(path.join(dshHome(), 'version.json'))?.version,
  ].filter(Boolean)
  if (candidates.length) return String(candidates[0])
  for (const root of resourceRoots()) {
    const pkg = readJsonSafe(path.join(root, 'app.asar', 'dsh', 'package.json'))
    if (pkg?.version) return String(pkg.version)
  }
  return 'unknown'
}

function profilePatchYaml({ model, mode, reasoningEffort }) {
  const lines = [
    '# 由 dsh-whale-bridge 生成并维护；手改会在下次重建任务 profile 时被覆盖。',
    '# 目的：让 whale-agent profile 使用 GUI 已保存的 DeepSeek 账号凭据，并允许按模式调整工具。',
    '- id: credentials',
    '  disabled: false',
    '- id: authorization',
    '  disabled: false',
    '- id: deepseek-account',
    '  disabled: false',
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-account',
    `    model: ${model || 'deepseek-flash'}`,
    `    reasoningEffort: ${reasoningEffort || 'max'}`,
  ]
  if (mode === 'creator') {
    lines.push(
      '# 创造模式：让任务 agent 也能管理 DSH profile 插件（实际安装动作还需完全权限）。',
      '- id: tool-plugin-manager',
      '  disabled: false',
    )
  }
  return lines.join('\n') + '\n'
}

export class DshTaskRunner {
  constructor(getSettings, logger) {
    this.getSettings = getSettings
    this.log = logger || appendLog
    this.running = 0
    this.queue = []
    this.history = this.loadHistory()
    this.profileReady = undefined
    this.profileInfo = { ok: false, profileDir: profileDir(), error: undefined }
  }

  loadHistory() {
    try {
      const raw = fs.readFileSync(path.join(stateDir(), 'tasks.json'), 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.slice(-MAX_HISTORY) : []
    } catch {
      return []
    }
  }

  saveHistory() {
    try {
      fs.mkdirSync(stateDir(), { recursive: true })
      const tmp = path.join(stateDir(), 'tasks.json.' + Math.random().toString(16).slice(2) + '.tmp')
      fs.writeFileSync(tmp, JSON.stringify(this.history.slice(-MAX_HISTORY), null, 2), 'utf8')
      fs.renameSync(tmp, path.join(stateDir(), 'tasks.json'))
    } catch {
      /* history 持久化失败不影响任务 */
    }
  }

  historyList() {
    return this.history
  }

  /** 最近的 DSH 会话（按会话去重、取最新一条），供「相似任务自动续接」提示模型。 */
  recentSessions(limit = 6) {
    const seen = new Map()
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      const t = this.history[i]
      if (!t || !t.sessionId || !t.ok) continue
      if (seen.has(t.sessionId)) continue
      seen.set(t.sessionId, {
        sessionId: t.sessionId,
        at: t.at,
        workspace: t.workspace,
        summary: String(t.prompt || '').slice(0, 80),
      })
      if (seen.size >= limit) break
    }
    return [...seen.values()]
  }

  /** 解析 CLI 启动方式。 */
  resolveLauncher() {
    // 允许显式覆盖（跨版本/非标准安装/离线自检时用）
    const exeOverride = process.env.DSH_WHALE_BRIDGE_EXE
    const cliOverride = process.env.DSH_WHALE_BRIDGE_CLI
    if (exeOverride && cliOverride) {
      return {
        kind: 'electron-node',
        command: exeOverride,
        argsPrefix: ['--expose-internals', cliOverride],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        label: cliOverride,
      }
    }
    const cli = dshDesktopCli()
    if (cli) {
      return {
        kind: 'electron-node',
        command: process.execPath,
        argsPrefix: ['--expose-internals', cli],
        env: { ELECTRON_RUN_AS_NODE: '1' },
        label: cli,
      }
    }
    const dshCmd = findOnPath(['dsh.cmd', 'dsh.bat', 'dsh'])
    if (dshCmd) {
      return {
        kind: 'shell',
        command: dshCmd,
        argsPrefix: [],
        env: {},
        label: dshCmd,
      }
    }
    throw new Error('找不到 DSH 启动器（DeepSeek Harness.exe / dsh 命令）；请在面板里检查 DSH 安装是否完整')
  }

  spawnDsh(extraArgs, { timeoutMs = 120000, cwd, envExtra } = {}) {
    const launcher = this.resolveLauncher()
    const args = [...launcher.argsPrefix, ...extraArgs]
    const env = { ...process.env, ...launcher.env, ...(envExtra || {}) }
    const child = spawn(launcher.command, args, {
      cwd: cwd || undefined,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: launcher.kind === 'shell',
    })
    return { child, launcher }
  }

  /** 写 whale-agent profile 的 patch（本桥接拥有该文件）。 */
  writeProfilePatch({ model, mode, reasoningEffort }) {
    const dir = profileDir()
    if (!fs.existsSync(path.join(dir, 'package.json'))) return
    const patchFile = path.join(dir, 'cordis.patch.yml')
    const desired = profilePatchYaml({ model, mode, reasoningEffort })
    let current = ''
    try {
      current = fs.readFileSync(patchFile, 'utf8')
    } catch {
      current = ''
    }
    if (desired !== current) fs.writeFileSync(patchFile, desired, 'utf8')
  }

  /** 确保 whale-agent 任务 profile 存在且 patch 与当前设置一致。 */
  async ensureProfile(force = false) {
    if (force) this.profileReady = undefined
    if (this.profileReady) return this.profileReady
    this.profileReady = (async () => {
      const settings = this.getSettings()
      const dir = profileDir()
      const pkgFile = path.join(dir, 'package.json')
      const stampFile = path.join(dir, '.bridge-dsh-version')
      const wantVersion = dshVersion()
      let needCreate = force || !fs.existsSync(pkgFile)
      if (!needCreate) {
        const stamp = (() => {
          try {
            return fs.readFileSync(stampFile, 'utf8').trim()
          } catch {
            return ''
          }
        })()
        if (stamp && stamp !== wantVersion) needCreate = true
      }
      if (needCreate) {
        fs.mkdirSync(path.join(dshHome(), 'profiles'), { recursive: true })
        const { child } = this.spawnDsh(
          ['--profile', profileName(), '--from-default-profile', 'headless', '--dump-config'],
          { timeoutMs: 180000, cwd: dshHome() },
        )
        let stderr = ''
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
        const code = await new Promise((resolve) => {
          child.on('error', (err) => { stderr += String(err && err.message) ; resolve(-1) })
          child.on('close', (c) => resolve(c))
        })
        if (code !== 0 || !fs.existsSync(pkgFile)) {
          throw new Error('生成 whale-agent profile 失败：' + (stderr.trim().split('\n').slice(-3).join(' | ') || `exit ${code}`))
        }
        fs.writeFileSync(stampFile, wantVersion + '\n', 'utf8')
      }
      // profile patch 由本桥接维护（每次 ensure 重写，代表当前 mode/model）
      if (needCreate) {
        this.writeProfilePatch({ model: settings.model, mode: settings.mode, reasoningEffort: settings.reasoningEffort })
      }
      const info = { ok: true, profileDir: dir, dshVersion: wantVersion }
      this.profileInfo = info
      this.log(`[profile] ready ${dir} (dsh=${wantVersion}, mode=${settings.mode})`)
      return info
    })().catch((err) => {
      this.profileInfo = { ok: false, profileDir: profileDir(), error: String(err && err.message ? err.message : err) }
      this.profileReady = undefined
      this.log('[profile] failed: ' + this.profileInfo.error)
      throw err
    })
    return this.profileReady
  }

  async rebuildProfile() {
    this.log('[profile] rebuild requested')
    const info = await this.ensureProfile(true)
    return info
  }

  async _acquireSlot() {
    while (this.running >= MAX_CONCURRENT) {
      await sleep(150)
    }
    this.running += 1
  }

  _releaseSlot() {
    this.running = Math.max(0, this.running - 1)
  }

  /**
   * 跑一个 DSH 任务。
   * @returns {{ok:boolean,text?:string,sessionId?:string,durationMs:number,toolCalls:number,error?:string,profile?:object}}
   */
  async runTask({ prompt, workspace, permission, mode, sessionId, timeoutMs, signal, onProgress, onText } = {}) {
    const started = Date.now()
    const settings = this.getSettings()
    const taskPrompt = String(prompt || '').trim()
    if (!taskPrompt) return { ok: false, error: '任务内容为空', durationMs: 0, toolCalls: 0 }

    const ws = path.resolve(String(workspace || settings.workspace || '').trim() || settings.workspace)
    if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) {
      return { ok: false, error: `工作区不存在或不是目录：${ws}`, durationMs: Date.now() - started, toolCalls: 0 }
    }
    const perm = ['read-only', 'workspace-write', 'danger-full-access'].includes(permission)
      ? permission
      : settings.permission
    const taskMode = ['standard', 'creator'].includes(mode) ? mode : settings.mode
    const waitMs = Math.max(30000, Math.min(3600000, Number(timeoutMs) || settings.timeoutMs))
    const sid = String(sessionId || settings.defaultSessionId || '').trim()

    await this._acquireSlot()
    let child
    let timer
    try {
      const profile = await this.ensureProfile()
      // mode/model 以本次任务为准写进 profile patch
      this.writeProfilePatch({ model: settings.model, mode: taskMode, reasoningEffort: settings.reasoningEffort })

      const attempt = async (useSid) => {
        const args = ['--profile', profileName(), '--json']
        if (useSid) args.push('--session-id', useSid)
        args.push(taskPrompt)
        const { child: spawned, launcher } = this.spawnDsh(args, {
          timeoutMs: waitMs,
          cwd: ws,
          envExtra: {
            DSH_PERMISSION_MODE: perm,
            DSH_PROFILE: profileName(),
            DSH_PROFILE_DIR: profile.profileDir,
          },
        })
        child = spawned
        const collected = await this._collect(spawned, { prompt: taskPrompt, ws, perm, taskMode, waitMs, started, profile, signal, onProgress, onText })
        return { ...collected, launcher: launcher.label }
      }

      let result = await attempt(sid)
      // defaultSessionId / 显式 sessionId 首次使用时，headless 会以「不存在」拒绝；
      // 这时自动退化为新会话（并返回新的 sessionId），让「同一个聊天持续上下文」在首次也能用。
      if (!result.ok && sid && /does not exist|不存在|session/i.test(String(result.error || ''))) {
        this.log(`[task] session ${sid} unavailable, retry with a fresh session`)
        result = await attempt('')
        result.sessionReset = true
      }

      this._pushHistory({
        id: 'task-' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6),
        prompt: taskPrompt.length > 200 ? taskPrompt.slice(0, 200) + '…' : taskPrompt,
        workspace: ws,
        permission: perm,
        mode: taskMode,
        sessionId: result.sessionId,
        ok: result.ok,
        durationMs: result.durationMs,
        toolCalls: result.toolCalls,
        error: result.error,
        launcher: result.launcher,
        at: new Date().toISOString(),
      })
      return { ...result, profile }
    } catch (err) {
      const result = {
        ok: false,
        error: String(err && err.message ? err.message : err),
        durationMs: Date.now() - started,
        toolCalls: 0,
      }
      this._pushHistory({
        id: 'task-' + Date.now().toString(36),
        prompt: taskPrompt.slice(0, 200),
        workspace: ws,
        permission: perm,
        mode: taskMode,
        ok: false,
        durationMs: result.durationMs,
        toolCalls: 0,
        error: result.error,
        at: new Date().toISOString(),
      })
      return result
    } finally {
      if (timer) clearTimeout(timer)
      this._releaseSlot()
    }
  }

  async _collect(child, ctx) {
    return new Promise((resolve) => {
      let outBuf = ''
      let errBuf = ''
      let finalText
      let lastText = ''
      let sessionId
      let toolCalls = 0
      const toolNames = []
      const errors = []
      let settled = false

      const finish = (payload) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve({
          durationMs: Date.now() - ctx.started,
          toolCalls,
          toolNames,
          sessionId,
          ...payload,
        })
      }
      const kill = () => {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
          } else {
            child.kill('SIGKILL')
          }
        } catch {
          try { child.kill() } catch { /* ignore */ }
        }
      }
      const timer = setTimeout(() => {
        errors.push(`任务超时（${ctx.waitMs}ms），已终止`)
        kill()
      }, ctx.waitMs)

      // 调用方（如鲸鱼娘网页请求）断开时立刻终止 DSH 子进程，避免白跑长任务
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          errors.push('调用方已断开，任务取消')
          kill()
          finish({ ok: false, aborted: true, error: '调用方已断开，任务取消', text: lastText })
        } else {
          ctx.signal.addEventListener('abort', () => {
            errors.push('调用方已断开，任务取消')
            kill()
            finish({ ok: false, aborted: true, error: '调用方已断开，任务取消', text: lastText })
          }, { once: true })
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        outBuf += chunk
        const lines = outBuf.split(/\r?\n/)
        outBuf = lines.pop() || ''
        for (const line of lines) {
          const text = line.trim()
          if (!text) continue
          let event
          try {
            event = JSON.parse(text)
          } catch {
            continue
          }
          if (event.type === 'session' && event.sessionId) sessionId = event.sessionId
          else if (event.type === 'text' && typeof event.text === 'string') {
            lastText = event.text
            try {
              if (typeof ctx.onText === 'function') ctx.onText(event.text)
            } catch { /* 流式回调失败不影响任务 */ }
          } else if (event.type === 'tool_call') {
            toolCalls += 1
            const name = event.name || event.tool || event.title || 'tool'
            if (toolNames.length < 30) toolNames.push(String(name))
            try {
              if (typeof ctx.onProgress === 'function') {
                ctx.onProgress({ toolCalls, toolName: String(name), elapsedMs: Date.now() - ctx.started })
              }
            } catch {
              /* 进度回调失败不影响任务 */
            }
          } else if (event.type === 'final' && typeof event.text === 'string') finalText = event.text
          else if (event.type === 'turn_end' && event.reason && event.reason.kind === 'error') {
            const message = event.reason.error?.message || event.reason.error?.code || 'turn error'
            errors.push(String(message))
          } else if (event.type === 'error') {
            errors.push(String(event.message || 'error'))
          }
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        errBuf += chunk
        if (errBuf.length > 16000) errBuf = errBuf.slice(-16000)
      })
      child.on('error', (err) => {
        errors.push(String(err && err.message ? err.message : err))
        finish({ ok: false, error: errors.join(' / '), text: lastText })
      })
      child.on('close', (code) => {
        // 处理残留行
        const tail = (outBuf || '').trim()
        if (tail) {
          try {
            const event = JSON.parse(tail)
            if (event.type === 'final' && typeof event.text === 'string') finalText = event.text
          } catch { /* ignore */ }
        }
        const text = typeof finalText === 'string' ? finalText : lastText
        const stderrLast = errBuf.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-2).join(' | ')
        if (code === 0 && errors.length === 0) {
          finish({ ok: true, text: text || '', sessionId })
        } else {
          finish({ ok: false, text: text || '', sessionId, error: errors.slice(-2).join(' / ') || stderrLast || `DSH 退出码 ${code}` })
        }
      })
    })
  }

  _pushHistory(record) {
    this.history.push(record)
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY)
    this.saveHistory()
    this.log(`[task] ${record.ok ? 'ok' : 'fail'} ${record.durationMs}ms tools=${record.toolCalls} ${record.error || ''}`)
  }
}
