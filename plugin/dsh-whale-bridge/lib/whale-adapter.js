/**
 * 鲸鱼娘侧适配（非侵入）：
 * 只读写鲸鱼娘的用户数据文件 config.json / data/settings.json（config 属升级不覆盖的用户数据），
 * 以及由安装脚本维护的 web/debug.html 标记块；不改它的任何源码。
 *
 * 通过鲸鱼娘自己的 config 模块解析当前模型运行时（版本隔离：不复制它的 PRESETS 表）。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { appendLog, backupsDir, stateDir } from './config.js'

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: 8000, windowsHide: true, encoding: 'utf8', ...options }, (err, stdout) => {
        resolve({ err, stdout: String(stdout || '') })
      })
    } catch (err) {
      resolve({ err, stdout: '' })
    }
  })
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.' + Math.random().toString(16).slice(2) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const PRESET_FALLBACK = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
}

function isBridgeUpstreamUrl(url) {
  // 本桥接自己的 OpenAI 兼容地址：http://127.0.0.1:<port>/v1
  return /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/v1\/?$/i.test(String(url || '').trim())
}

export class WhaleAdapter {
  constructor(getSettings, logger) {
    this.getSettings = getSettings
    this.log = logger || appendLog
  }

  configPath() {
    return path.join(this.getSettings().whaleDir, 'config.json')
  }

  examplePath() {
    return path.join(this.getSettings().whaleDir, 'config.example.json')
  }

  settingsPath() {
    return path.join(this.getSettings().whaleDir, 'data', 'settings.json')
  }

  readConfig() {
    const cfg = readJson(this.configPath())
    if (cfg) return cfg
    const example = readJson(this.examplePath())
    if (example) return example
    return undefined
  }

  /**
   * 用鲸鱼娘自己的 src/config.js 解析当前模型运行时；失败回退到内置最小的 preset 表。
   * 返回 { provider, baseUrl, model, apiKey, mock, needsKey, source }
   */
  async resolveUpstream() {
    const settings = this.getSettings()
    const root = settings.whaleDir
    const script = `
      const path = require('path');
      const root = process.cwd();
      const c = require(path.join(root, 'src', 'config.js'));
      const cfg = c.loadConfig({ root });
      const r = c.resolveRuntime(cfg);
      console.log('__BRIDGE_UPSTREAM__' + JSON.stringify({
        provider: r.provider, baseUrl: r.baseUrl, model: r.model,
        apiKey: r.apiKey || '', mock: !!r.mock, needsKey: !!r.needsKey
      }));
    `
    const candidate = await new Promise((resolve) => {
      let out = ''
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        const child = spawn(process.execPath, ['-e', script], {
          cwd: root,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const timer = setTimeout(() => {
          try { child.kill() } catch { /* ignore */ }
          done(undefined)
        }, 20000)
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => { out += chunk })
        child.on('error', () => { clearTimeout(timer); done(undefined) })
        child.on('close', () => {
          clearTimeout(timer)
          const line = out.split(/\r?\n/).find((l) => l.includes('__BRIDGE_UPSTREAM__')) || ''
          const json = line.slice(line.indexOf('__BRIDGE_UPSTREAM__') + '__BRIDGE_UPSTREAM__'.length).trim()
          try {
            const parsed = JSON.parse(json)
            done({ ...parsed, source: 'whale-config' })
          } catch {
            done(undefined)
          }
        })
      } catch {
        done(undefined)
      }
    })
    if (candidate) return candidate
    // 回退：最小 preset 表
    const cfg = this.readConfig() || {}
    const saved = readJson(this.settingsPath()) || {}
    const provider = String(saved.provider || cfg.provider || 'deepseek')
    const preset = PRESET_FALLBACK[provider] || { baseUrl: '', model: '' }
    const llm = cfg.deepseek || {}
    const providerIsDeepseek = provider === 'deepseek'
    return {
      provider,
      baseUrl: String(saved.baseUrl || (providerIsDeepseek ? llm.baseUrl : '') || preset.baseUrl || ''),
      model: String(saved.model || (providerIsDeepseek ? llm.model : '') || preset.model || ''),
      apiKey: String(saved.apiKey || (providerIsDeepseek ? llm.apiKey : '') || ''),
      mock: false,
      needsKey: provider !== 'ollama',
      source: 'fallback',
    }
  }

  webPort() {
    const cfg = this.readConfig() || {}
    return Number(cfg?.server?.port) || 8787
  }

  urlFor(target) {
    const port = this.webPort()
    return target === 'debug' ? `http://127.0.0.1:${port}/debug` : `http://127.0.0.1:${port}/`
  }

  /** 探测鲸鱼娘网页服务是否在跑（/healthz）。 */
  probeRunning(timeoutMs = 900) {
    const port = this.webPort()
    return new Promise((resolve) => {
      try {
        const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        })
        req.on('timeout', () => { req.destroy(); resolve(false) })
        req.on('error', () => resolve(false))
      } catch {
        resolve(false)
      }
    })
  }

  /** 探测端口是否已被监听（服务可能在启动中、尚未通过 /healthz）。 */
  probeListening(timeoutMs = 600) {
    return new Promise((resolve) => {
      try {
        const socket = new net.Socket()
        const done = (value) => {
          try { socket.destroy() } catch { /* ignore */ }
          resolve(value)
        }
        socket.setTimeout(timeoutMs)
        socket.once('connect', () => done(true))
        socket.once('timeout', () => done(false))
        socket.once('error', () => done(false))
        socket.connect(this.webPort(), '127.0.0.1')
      } catch {
        resolve(false)
      }
    })
  }

  /** 找出鲸鱼娘相关进程（node server.js / start.ps1），用于判断"已经有人在启动/运行"，避免重复拉起。 */
  async findWhaleProcesses() {
    if (process.platform !== 'win32') return []
    const root = this.getSettings().whaleDir
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      '$root=$env:WHALE_ROOT',
      'Get-CimInstance Win32_Process | Where-Object {',
      "  $_.CommandLine -and $_.CommandLine.Contains($root) -and",
      "  $_.CommandLine -notmatch 'dsh-subprocess-local|runner\\.js|dsh-whale-bridge|Test-Path' -and (",
      "    ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'server\\.js') -or",
      "    ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'scripts\\\\start\\.ps1' -and $_.CommandLine -match '-File')",
      '  )',
      '} | Select-Object ProcessId,Name | ConvertTo-Json -Compress',
    ].join('\n')
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, WHALE_ROOT: root },
    })
    const text = stdout.trim()
    if (!text) return []
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return []
    }
  }

  async waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      if (await this.probeRunning()) return true
    }
    return false
  }

  /** 启动鲸鱼娘（已有 bat/进程在跑时只等待，不重复拉起）。 */
  async ensureRunning({ timeoutMs = 90000 } = {}) {
    // 并发点击合并为一次
    if (this._starting) return this._starting
    this._starting = this._ensureRunningInner({ timeoutMs }).finally(() => {
      this._starting = undefined
    })
    return this._starting
  }

  async _ensureRunningInner({ timeoutMs }) {
    const settings = this.getSettings()
    const root = settings.whaleDir
    const urls = { url: this.urlFor('web'), debugUrl: this.urlFor('debug') }
    if (await this.probeRunning()) {
      return { running: true, started: false, alreadyRunning: true, ...urls }
    }
    if (!fs.existsSync(root)) {
      return { running: false, started: false, error: `鲸鱼娘目录不存在：${root}` }
    }
    // 已经有进程在跑 / 端口已被监听：只等它起来，绝不重复打开
    const existing = await this.findWhaleProcesses()
    const listening = await this.probeListening()
    if (existing.length > 0 || listening) {
      this.log(`[whale] detected existing process/listener (procs=${existing.length}, listening=${listening}), wait instead of relaunch`)
      if (await this.waitHealthy(Math.min(timeoutMs, 30000))) {
        return { running: true, started: false, alreadyRunning: true, ...urls }
      }
      return {
        running: false,
        started: false,
        alreadyRunning: true,
        error: '检测到鲸鱼娘已经在启动/运行（窗口或端口已存在），但网页服务还没就绪，请查看它自己的窗口有没有报错',
        ...urls,
      }
    }
    const bat = path.join(root, '启动鲸鱼娘.bat')
    const startPs1 = path.join(root, 'scripts', 'start.ps1')
    const runtimeNode = path.join(root, 'runtime', 'node.exe')
    const serverJs = path.join(root, 'server.js')
    const openLog = () => {
      try {
        return fs.openSync(path.join(stateDir(), 'whale-server.log'), 'a')
      } catch {
        return 'ignore'
      }
    }
    const cleanEnv = () => {
      const env = { ...process.env }
      // 与鲸鱼娘 start.ps1 一致：清掉残留代理，避免模型请求连到本地代理失败
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[name]
      env.NO_PROXY = '127.0.0.1,localhost,::1'
      env.no_proxy = env.NO_PROXY
      env.TZ = 'Asia/Shanghai'
      delete env.ELECTRON_RUN_AS_NODE
      return env
    }
    const launchAndWatch = (label, command, args, options) => {
      const child = spawn(command, args, options)
      this.log(`[whale] spawn ${label} pid=${child.pid || '?'}`)
      child.on('error', (err) => this.log(`[whale] spawn ${label} error: ${err && err.message ? err.message : err}`))
      child.on('exit', (code, signal) => this.log(`[whale] ${label} exited code=${code} signal=${signal}`))
      if (child.unref) child.unref()
      return child
    }
    try {
      if (fs.existsSync(runtimeNode) && fs.existsSync(serverJs)) {
        // 首选：直接用它自带的 Node 运行 server.js（不经过 PowerShell/cmd，避免无法弹窗/引号问题）
        const child = launchAndWatch('runtime node server.js', runtimeNode, [serverJs, '--no-browser'], {
          cwd: root,
          env: cleanEnv(),
          detached: true,
          stdio: ['ignore', openLog(), openLog()],
          windowsHide: true,
        })
        // 记录由桥接启动的进程，供状态显示与停止按钮使用
        if (child && child.pid) this.writeWhalePid(child.pid)
      } else if (fs.existsSync(startPs1)) {
        launchAndWatch('scripts/start.ps1', 'powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startPs1, '-NoBrowser',
        ], {
          cwd: root,
          env: cleanEnv(),
          detached: true,
          stdio: ['ignore', openLog(), openLog()],
          windowsHide: true,
        })
      } else if (fs.existsSync(bat)) {
        launchAndWatch('启动鲸鱼娘.bat', 'cmd.exe', ['/d', '/s', '/c', `start "" "${bat}" -NoBrowser`], {
          cwd: root,
          env: cleanEnv(),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
      } else {
        return { running: false, started: false, error: '找不到 runtime\\node.exe、scripts\\start.ps1 或启动鲸鱼娘.bat，无法自动启动' }
      }
    } catch (err) {
      return { running: false, started: false, error: String(err && err.message ? err.message : err) }
    }
    if (await this.waitHealthy(timeoutMs)) {
      this.log('[whale] started and healthy')
      return { running: true, started: true, ...urls }
    }
    return { running: false, started: true, error: `鲸鱼娘启动超时（${Math.round(timeoutMs / 1000)}s），请看它的启动窗口是否报错`, ...urls }
  }

  /* ---------------- 鲸鱼娘进程状态 / 启动 / 停止 ---------------- */

  pidFilePath() {
    return path.join(stateDir(), 'whale.pid')
  }

  readWhalePid() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.pidFilePath(), 'utf8'))
      if (raw && Number.isInteger(raw.pid) && raw.pid > 0) return raw
    } catch {
      /* 没有或损坏都当不存在 */
    }
    return null
  }

  writeWhalePid(pid) {
    try {
      fs.writeFileSync(this.pidFilePath(), JSON.stringify({ pid, at: new Date().toISOString(), by: 'bridge' }, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  clearWhalePid() {
    try {
      fs.unlinkSync(this.pidFilePath())
    } catch {
      /* ignore */
    }
  }

  isPidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async waitNotRunning(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      if (!(await this.probeRunning())) return true
    }
    return false
  }

  /** 当前运行的鲸鱼娘网页服务进程：{pid, startedBy: 'bridge'|'external'} 或 null。 */
  async currentServerProcess() {
    const pidInfo = this.readWhalePid()
    if (pidInfo && this.isPidAlive(pidInfo.pid)) {
      return { pid: pidInfo.pid, startedBy: 'bridge', startedAt: pidInfo.at }
    }
    if (pidInfo && !this.isPidAlive(pidInfo.pid)) this.clearWhalePid()
    const procs = await this.findWhaleProcesses()
    const nodeProc = procs.find((p) => String(p.Name || '').toLowerCase() === 'node.exe') || procs[0]
    if (nodeProc && nodeProc.ProcessId) {
      return { pid: Number(nodeProc.ProcessId), startedBy: 'external' }
    }
    return null
  }

  /** 停止鲸鱼娘网页服务（只停服务进程，不动 DSH、不动微信桥接）。 */
  async stopServer() {
    const running = await this.probeRunning()
    const current = await this.currentServerProcess()
    if (!current) {
      this.clearWhalePid()
      if (!running) return { ok: true, alreadyStopped: true }
      return { ok: false, error: '端口在监听但没找到可结束的鲸鱼娘进程，请手动处理' }
    }
    const pid = current.pid
    await new Promise((resolve) => {
      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('exit', () => resolve())
        killer.on('error', () => resolve())
      } catch {
        try {
          process.kill(pid)
        } catch {
          /* ignore */
        }
        resolve()
      }
    })
    const down = await this.waitNotRunning(10000)
    if (down) {
      this.clearWhalePid()
      this.log(`[whale] stopped pid=${pid} (startedBy=${current.startedBy})`)
      return { ok: true, stoppedPid: pid, startedBy: current.startedBy }
    }
    return { ok: false, error: '已请求结束但网页服务仍在响应，请打开它的窗口手动关闭', pid, startedBy: current.startedBy }
  }

  /** 用系统默认浏览器打开 URL（由宿主进程打开，不受浏览器弹窗拦截影响）。 */
  openUrl(url) {
    const methods = ['powershell', 'explorer', 'cmd-start', 'rundll32']
    for (const method of methods) {
      if (this._spawnOpen(method, url)) {
        this.log(`[whale] open-url via ${method} (fire-and-forget): ${url}`)
        return { ok: true, method }
      }
    }
    return { ok: false, error: '没有可用的系统浏览器打开方式' }
  }

  /** 记录「浏览器确实打开过」的回调（由 bridge server 提供）。 */
  setOpenEvidenceWaiter(fn) {
    this._waitEvidence = fn
  }

  /** 由宿主调起浏览器打开探测地址；只有浏览器真的命中 /open 才认为成功。 */
  async openUrlWithEvidence(target) {
    const settings = this.getSettings()
    const token = 'o' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const probe = `http://127.0.0.1:${settings.port}/open?to=${target}&t=${token}`
    const methods = ['powershell', 'explorer', 'cmd-start', 'rundll32']
    const order = this._openMethod ? [this._openMethod, ...methods.filter((m) => m !== this._openMethod)] : methods
    for (const method of order) {
      if (!this._waitEvidence) {
        this._spawnOpen(method, probe)
        return { ok: true, method, unverified: true }
      }
      this._spawnOpen(method, probe)
      const hit = await this._waitEvidence(token, 2500)
      this.log(`[whale] open-method ${method} -> ${hit ? 'confirmed' : 'no-evidence'}`)
      if (hit) {
        this._openMethod = method
        return { ok: true, method }
      }
    }
    return { ok: false, error: '无法调起系统浏览器自动打开' }
  }

  _spawnOpen(method, url) {
    try {
      const base = { windowsHide: true, stdio: 'ignore', detached: true }
      if (method === 'powershell') {
        const quoted = url.replace(/'/g, "''")
        spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${quoted}'`], base).unref()
        return true
      }
      if (method === 'explorer') {
        spawn('explorer.exe', [url], base).unref()
        return true
      }
      if (method === 'rundll32') {
        spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], base).unref()
        return true
      }
      if (method === 'cmd-start') {
        spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], base).unref()
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /** 确保鲸鱼娘在跑，然后用系统浏览器打开网页或调试台（并确认浏览器真的被调起）。 */
  async openPage(target = 'web') {
    const ensured = await this.ensureRunning()
    const url = target === 'debug' ? ensured.debugUrl || this.urlFor('debug') : ensured.url || this.urlFor('web')
    if (!ensured.running) {
      return { ok: false, ...ensured, url }
    }
    let opened
    if (this._waitEvidence) {
      opened = await this.openUrlWithEvidence(target)
    } else {
      opened = this.openUrl(url)
    }
    this.log(`[whale] open ${target} -> ${url} (started=${ensured.started}, ok=${opened.ok}, method=${opened.method || ''})`)
    return { ok: Boolean(opened.ok), url, started: ensured.started, running: true, method: opened.method, error: opened.error, unverified: opened.unverified }
  }

  async status() {
    const settings = this.getSettings()
    const cfg = this.readConfig()
    const version = (() => {
      const pkg = readJson(path.join(settings.whaleDir, 'package.json'))
      return pkg?.version || ''
    })()
    const custom = cfg?.custom || {}
    const llm = cfg?.llm || {}
    const provider = String(cfg?.provider || '')
    const target = `127.0.0.1:${settings.port}`
    const configured = provider === 'custom'
      && (String(custom.baseUrl || '').includes(target) || String(llm.baseUrl || '').includes(target))
    const port = this.webPort()
    const running = await this.probeRunning()
    const processInfo = running ? await this.currentServerProcess() : null
    return {
      dir: settings.whaleDir,
      exists: fs.existsSync(settings.whaleDir),
      hasConfig: fs.existsSync(this.configPath()),
      version,
      provider,
      configured,
      baseUrl: String(custom.baseUrl || ''),
      running,
      pid: processInfo ? processInfo.pid : null,
      startedBy: processInfo ? processInfo.startedBy : null,
      startedAt: processInfo ? processInfo.startedAt || null : null,
      url: `http://127.0.0.1:${port}/`,
      debugUrl: `http://127.0.0.1:${port}/debug`,
      webPort: port,
      chatPageInjected: this.chatPageInjected(),
    }
  }

  backupCurrent() {
    const dir = path.join(backupsDir(), stamp())
    fs.mkdirSync(dir, { recursive: true })
    const files = []
    for (const [name, file] of [
      ['config.json', this.configPath()],
      ['settings.json', this.settingsPath()],
    ]) {
      if (fs.existsSync(file)) {
        const dest = path.join(dir, name)
        fs.copyFileSync(file, dest)
        files.push(dest)
      }
    }
    return { dir, files }
  }

  debugHtmlPath() {
    return path.join(this.getSettings().whaleDir, 'web', 'debug.html')
  }

  debugHtmlBackup() {
    return this.debugHtmlPath() + '.whale-dsh-bridge.bak'
  }

  /**
   * 在鲸鱼娘 /debug 页注入「DSH 桥接」卡片脚本（带标记块，幂等；只改 web/debug.html 这一处）。
   * 与 whale-side/install-whale-side.ps1 行为一致，供面板一键接入直接完成，无需再跑脚本。
   */
  injectDebugCard(port, result = {}) {
    const file = this.debugHtmlPath()
    if (!fs.existsSync(file)) return { ok: false, error: `找不到调试页：${file}` }
    const original = fs.readFileSync(file, 'utf8')
    const hasBom = original.charCodeAt(0) === 0xfeff
    const text = hasBom ? original.slice(1) : original
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    const begin = '<!-- whale-dsh-bridge:begin -->'
    const end = '<!-- whale-dsh-bridge:end -->'
    const srcLine = `<script src="http://127.0.0.1:${port}/static/debug-bridge.js" defer></script>`
    const block = [begin, srcLine, end].join(newline)
    let next
    const beginAt = text.indexOf(begin)
    const endAt = text.indexOf(end)
    if (beginAt >= 0 && endAt > beginAt) {
      next = text.slice(0, beginAt) + block + text.slice(endAt + end.length)
    } else {
      const closeMain = text.toLowerCase().lastIndexOf('</main>')
      if (closeMain < 0) return { ok: false, error: 'debug.html 里找不到 </main>，无法注入卡片（可能版本结构变化）' }
      const indent = newline + '  '
      next = text.slice(0, closeMain) + indent + block + newline + text.slice(closeMain)
    }
    if (!fs.existsSync(this.debugHtmlBackup())) {
      fs.copyFileSync(file, this.debugHtmlBackup())
      result.backedUp = [...(result.backedUp || []), this.debugHtmlBackup()]
    }
    fs.writeFileSync(file, (hasBom ? '\ufeff' : '') + next, 'utf8')
    return { ok: true, path: file }
  }

  removeDebugCard() {
    const file = this.debugHtmlPath()
    if (!fs.existsSync(file)) return { ok: false, error: '找不到 debug.html' }
    const backup = this.debugHtmlBackup()
    const current = fs.readFileSync(file, 'utf8')
    const begin = '<!-- whale-dsh-bridge:begin -->'
    const end = '<!-- whale-dsh-bridge:end -->'
    const beginAt = current.indexOf(begin)
    const endAt = current.indexOf(end)
    if (beginAt < 0 || endAt < beginAt) {
      return { ok: true, skipped: true }
    }
    // 升级后 debug.html 被整文件替换时，备份已失效：只删除标记块，不恢复旧版页面
    const upgraded = current.indexOf(begin) >= 0 && (() => {
      try {
        const backupText = fs.readFileSync(backup, 'utf8')
        const normalized = backupText.replace(/\r\n/g, '\n')
        const withoutBlock = current.replace(
          new RegExp(begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          '',
        ).replace(/\r\n/g, '\n')
        return !withoutBlock.includes('</main>') || normalized.slice(0, 200) !== withoutBlock.slice(0, 200)
      } catch {
        return true
      }
    })()
    let next = current.slice(0, beginAt) + current.slice(endAt + end.length)
    // 去掉注入时带来的行首缩进空行
    next = next.replace(/\r?\n[ \t]*\r?\n(?=[ \t]*<\/main>)/, '\n')
    // 若备份仍在且恢复后内容与备份完全一致，直接用备份覆盖（逐字节还原）
    try {
      if (fs.existsSync(backup)) {
        const backupText = fs.readFileSync(backup, 'utf8')
        if (backupText.replace(/\r\n/g, '\n') === next.replace(/\r\n/g, '\n')) {
          fs.copyFileSync(backup, file)
          return { ok: true, path: file, restoredFromBackup: true }
        }
      }
    } catch {
      /* 还原失败时仍保留已剥离标记块的结果 */
    }
    fs.writeFileSync(file, next, 'utf8')
    return { ok: true, path: file, restoredFromBackup: false, upgraded }
  }

  /** 鲸鱼娘网页聊天页（文件通道注入：上传按钮 + 下载链接可点）。 */
  chatPagePath() {
    return path.join(this.getSettings().whaleDir, 'web', 'index.html')
  }

  chatPageBackup() {
    return this.chatPagePath() + '.whale-dsh-bridge-files.bak'
  }

  /** 聊天页是否已注入文件通道脚本（标记块存在）。 */
  chatPageInjected() {
    try {
      return fs.readFileSync(this.chatPagePath(), 'utf8').includes('<!-- whale-dsh-bridge-files:begin -->')
    } catch {
      return false
    }
  }

  /**
   * 在鲸鱼娘网页聊天页注入文件通道脚本（只加一个带标记的 <script>，逻辑全在桥接的
   * /static/web-file-channel.js 里；幂等，可被 revert 移除）。
   */
  injectChatPage(port, result = {}) {
    const file = this.chatPagePath()
    if (!fs.existsSync(file)) return { ok: false, error: `找不到聊天页：${file}` }
    const original = fs.readFileSync(file, 'utf8')
    const hasBom = original.charCodeAt(0) === 0xfeff
    const text = hasBom ? original.slice(1) : original
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    const begin = '<!-- whale-dsh-bridge-files:begin -->'
    const end = '<!-- whale-dsh-bridge-files:end -->'
    const srcLine = `<script src="http://127.0.0.1:${port}/static/web-file-channel.js" defer></script>`
    const block = [begin, srcLine, end].join(newline)
    let next
    const beginAt = text.indexOf(begin)
    const endAt = text.indexOf(end)
    if (beginAt >= 0 && endAt > beginAt) {
      next = text.slice(0, beginAt) + block + text.slice(endAt + end.length)
    } else {
      const closeBody = text.toLowerCase().lastIndexOf('</body>')
      if (closeBody < 0) return { ok: false, error: '聊天页里找不到 </body>，无法注入文件通道脚本（可能版本结构变化）' }
      next = text.slice(0, closeBody) + '  ' + block + newline + text.slice(closeBody)
    }
    if (!fs.existsSync(this.chatPageBackup())) {
      fs.copyFileSync(file, this.chatPageBackup())
      result.backedUp = [...(result.backedUp || []), this.chatPageBackup()]
    }
    fs.writeFileSync(file, (hasBom ? '\ufeff' : '') + next, 'utf8')
    return { ok: true, path: file }
  }

  /** 移除聊天页文件通道脚本（标记块），能从备份还原就逐字节还原。 */
  removeChatPage() {
    const file = this.chatPagePath()
    if (!fs.existsSync(file)) return { ok: false, error: '找不到聊天页 index.html' }
    const backup = this.chatPageBackup()
    const current = fs.readFileSync(file, 'utf8')
    const begin = '<!-- whale-dsh-bridge-files:begin -->'
    const end = '<!-- whale-dsh-bridge-files:end -->'
    const beginAt = current.indexOf(begin)
    const endAt = current.indexOf(end)
    if (beginAt < 0 || endAt < beginAt) return { ok: true, skipped: true }
    let next = current.slice(0, beginAt) + current.slice(endAt + end.length)
    next = next.replace(/\r?\n[ \t]*(?=<\/body>)/i, '\n')
    try {
      if (fs.existsSync(backup)) {
        const backupText = fs.readFileSync(backup, 'utf8')
        if (backupText.replace(/\r\n/g, '\n') === next.replace(/\r\n/g, '\n')) {
          fs.copyFileSync(backup, file)
          return { ok: true, path: file, restoredFromBackup: true }
        }
      }
    } catch {
      /* 还原失败时保留已剥离标记块的结果 */
    }
    fs.writeFileSync(file, next, 'utf8')
    return { ok: true, path: file, restoredFromBackup: false }
  }

  /** 把鲸鱼娘切换到 provider=custom → 本桥接代理。 */
  async adopt() {
    const settings = this.getSettings()
    const root = settings.whaleDir
    if (!fs.existsSync(root)) throw new Error(`鲸鱼娘目录不存在：${root}`)
    const example = readJson(this.examplePath())
    const existing = readJson(this.configPath())
    const cfg = existing || (example ? JSON.parse(JSON.stringify(example)) : {})
    const backup = this.backupCurrent()

    // 接入前先解析原上游模型配置（以后代理用它）；已经在桥接里存过上游且鲸鱼娘已指向 custom 时复用旧值
    const previous = settings.upstream || {}
    const alreadyCustom = String(cfg.provider || '') === 'custom'
    const previousUsable = Boolean(previous.baseUrl) && !isBridgeUpstreamUrl(previous.baseUrl)
    let upstream
    if (alreadyCustom && previousUsable) {
      upstream = { baseUrl: previous.baseUrl, apiKey: previous.apiKey || '', model: previous.model || '' }
    } else {
      const resolved = await this.resolveUpstream()
      upstream = {
        baseUrl: resolved.baseUrl || '',
        apiKey: resolved.apiKey || '',
        model: resolved.model || '',
      }
      // 防止把桥接自己的 /v1 当成上游（settings 被清空后重复接入时会这样）
      if (!upstream.baseUrl || isBridgeUpstreamUrl(upstream.baseUrl)) {
        upstream.baseUrl = example?.deepseek?.baseUrl || 'https://api.deepseek.com'
        upstream.model = example?.deepseek?.model || 'deepseek-chat'
        upstream.apiKey = ''
      }
    }
    const bridgeBase = `http://127.0.0.1:${settings.port}/v1`
    const keyForWhale = upstream.apiKey || 'whale-dsh-bridge'

    // 鲸鱼娘 resolveRuntime 的关键点：provider=custom 时它读 cfg.llm（不是 cfg.custom）。
    // data/settings.json（网页设置）优先级最高，所以两边都要写。
    cfg.provider = 'custom'
    cfg.llm = {
      ...(cfg.llm || {}),
      provider: 'custom',
      baseUrl: bridgeBase,
      model: upstream.model || 'deepseek-chat',
      apiKey: keyForWhale,
    }
    cfg.custom = {
      ...(cfg.custom || {}),
      baseUrl: bridgeBase,
      model: upstream.model || 'deepseek-chat',
      apiKey: keyForWhale,
      needsKey: true,
      label: 'DSH 桥接（DeepSeek Harness）',
      hint: '由 dsh-whale-bridge 提供：需要动手的任务会交给 DSH agent 执行。',
    }
    // 鲸鱼娘的请求超时来自 config.deepseek.timeoutMs（默认 45s）。桥接在需要动手时会等 DSH
    // 任务完成（聊天委托上限 10 分钟），必须放宽到比它更长，否则会先报 request timeout 拿不到回复。
    cfg.deepseek = { ...(cfg.deepseek || {}) }
    const previousTimeout = Number(cfg.deepseek.timeoutMs) || 0
    cfg.deepseek.timeoutMs = Math.max(previousTimeout, 660000)
    writeJsonAtomic(this.configPath(), cfg)

    // 网页设置文件（存在则合并；不存在则创建，保证网页设置页也显示 custom）
    const savedFile = this.settingsPath()
    const saved = readJson(savedFile) || {}
    writeJsonAtomic(savedFile, {
      ...saved,
      provider: 'custom',
      baseUrl: bridgeBase,
      model: upstream.model || 'deepseek-chat',
      apiKey: keyForWhale,
      keys: { ...(saved.keys || {}), custom: keyForWhale },
    })

    // 顺手把 /debug 调试页卡片注入（只改带标记的一处；失败不影响接入本身）
    const debugResult = this.injectDebugCard(settings.port)
    // 网页聊天页注入文件通道脚本（📎 上传 + 下载链接可点）
    const chatPageResult = this.injectChatPage(settings.port)

    const result = {
      ok: true,
      backupDir: backup.dir,
      backedUp: [
        ...backup.files,
        ...(debugResult.ok && debugResult.path ? [debugResult.path] : []),
        ...(chatPageResult.ok && chatPageResult.path ? [chatPageResult.path] : []),
      ],
      upstream: { baseUrl: upstream.baseUrl, model: upstream.model, hasKey: Boolean(upstream.apiKey) },
      internalUpstream: upstream,
      files: [this.configPath(), savedFile, debugResult.ok ? debugResult.path : '', chatPageResult.ok ? chatPageResult.path : ''].filter(Boolean),
      debugCard: debugResult.ok ? '已注入 /debug 卡片' : `调试页卡片未注入：${debugResult.error}`,
      fileChannelUi: chatPageResult.ok ? '已在聊天页注入文件通道（📎 上传 / 下载链接可点）' : `文件通道 UI 未注入：${chatPageResult.error}`,
      warning: upstream.apiKey
        ? undefined
        : '鲸鱼娘还没有可用的模型 Key：桥接会以它原来的服务商/模型作为上游，但需要 Key 才能真的对话。请先在鲸鱼娘网页「设置」里填好 Key 并确认能聊天，再回到 DSH 点一次「接入鲸鱼娘」。',
    }
    this.log(`[whale] adopted -> ${bridgeBase} (upstream=${upstream.baseUrl}, model=${upstream.model}, hasKey=${Boolean(upstream.apiKey)})`)
    return result
  }

  /** 还原到接入前的备份（最近一次 adopt 的备份），并移除 /debug 卡片。 */
  revert() {
    const base = backupsDir()
    let dirs = []
    try {
      dirs = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse()
    } catch {
      dirs = []
    }
    if (!dirs.length) throw new Error('没有可还原的备份；请检查是否执行过「接入鲸鱼娘」')
    const dir = path.join(base, dirs[0])
    const restored = []
    const cfgBackup = path.join(dir, 'config.json')
    const setBackup = path.join(dir, 'settings.json')
    if (fs.existsSync(cfgBackup)) {
      fs.copyFileSync(cfgBackup, this.configPath())
      restored.push(this.configPath())
    }
    if (fs.existsSync(setBackup)) {
      fs.copyFileSync(setBackup, this.settingsPath())
      restored.push(this.settingsPath())
    }
    // 移除 /debug 卡片（失败不影响主回滚）
    let debugResult = { ok: false }
    try {
      debugResult = this.removeDebugCard()
      if (debugResult.ok && debugResult.path) restored.push(debugResult.path)
    } catch (err) {
      this.log('[whale] remove debug card failed: ' + (err && err.message ? err.message : err))
    }
    let chatPageResult = { ok: false }
    try {
      chatPageResult = this.removeChatPage()
      if (chatPageResult.ok && chatPageResult.path) restored.push(chatPageResult.path)
    } catch (err) {
      this.log('[whale] remove chat page files script failed: ' + (err && err.message ? err.message : err))
    }
    this.log(`[whale] reverted from ${dir} (${restored.length} files)`)
    return {
      ok: true,
      backupDir: dir,
      restored,
      debugCardRemoved: Boolean(debugResult.ok),
      fileChannelUiRemoved: Boolean(chatPageResult.ok),
    }
  }
}
