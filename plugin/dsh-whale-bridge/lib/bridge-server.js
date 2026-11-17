/**
 * 桥接 HTTP 服务：DSH 侧边栏面板、鲸鱼娘 /debug 卡片、鲸鱼娘聊天代理共用。
 * 只监听 127.0.0.1，无鉴权（同机），CORS 全开以便 file:// / 浏览器页面调用。
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { PACKAGE_ROOT, PACKAGE_VERSION, appendLog } from './config.js'
import { dshVersion } from './dsh-task.js'
import { progressLine } from './progress-line.js'
import { loadPersonaFile, savePersonaFile, personaFilePath } from './persona.js'

const MAX_BODY = 4 * 1024 * 1024

function nowISO() {
  return new Date().toISOString()
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(text)
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-requested-with')
  res.setHeader('Access-Control-Max-Age', '600')
}

function readBody(req, maxBytes = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 对外返回设置时不要把上游 Key 明文发给浏览器/调试页。 */
function redactSettings(settings) {
  const upstream = settings.upstream || {}
  return {
    ...settings,
    upstream: {
      baseUrl: upstream.baseUrl || '',
      model: upstream.model || '',
      apiKey: upstream.apiKey ? '__SET__' : '',
      hasKey: Boolean(upstream.apiKey),
    },
  }
}

export function createBridgeServer({ store, runner, whale, proxy, files, log = appendLog }) {
  const state = {
    startedAt: Date.now(),
    listening: false,
    port: store.get().port,
    lastError: '',
    server: undefined,
  }
  const routes = new Map()
  const proxyState = { running: 0 }
  const chainCache = { at: 0, value: null }

  const route = (method, pathname, handler) => routes.set(method + ' ' + pathname, handler)

  async function fetchWhaleStatus(webPort) {
    const url = `http://127.0.0.1:${webPort}/api/status`
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error('鲸鱼娘 /api/status HTTP ' + res.status)
    return await res.json()
  }

  function gatewayBridge(whaleStatusPayload) {
    const gateways = Array.isArray(whaleStatusPayload?.gateways) ? whaleStatusPayload.gateways : []
    const gw = gateways.find((g) => g && g.platform === 'wechat') || gateways[0] || null
    return gw && gw.bridge ? gw.bridge : null
  }

  async function chainSnapshot(whaleStatus) {
    const whaleRunning = Boolean(whaleStatus && whaleStatus.running)
    let bridge = null
    let wechat = null
    if (whaleRunning && whaleStatus.webPort) {
      try {
        const ws = await fetchWhaleStatus(whaleStatus.webPort)
        bridge = gatewayBridge(ws)
        wechat = bridge ? {
          online: Boolean(bridge.online),
          uia: bridge.uia !== false,
          listener: bridge.listener !== false,
          account: bridge.account || '',
          accountNick: bridge.accountNick || '',
          accountOk: bridge.accountOk !== false,
          lastSeenSec: bridge.lastSeenSec,
          ffmpeg: bridge.ffmpeg,
        } : null
      } catch (err) {
        wechat = { online: false, error: String(err && err.message ? err.message : err) }
      }
    }
    return {
      plugin: true,
      whale: { running: whaleRunning, pid: whaleStatus ? whaleStatus.pid : null },
      bridge: { online: Boolean(wechat && wechat.online) },
      wechat,
      online: Boolean(whaleRunning && wechat && wechat.online && wechat.accountOk !== false),
    }
  }


  async function cachedChainSnapshot(whaleStatus) {
    const now = Date.now()
    if (chainCache.value && now - chainCache.at < 5000) return chainCache.value
    const value = await chainSnapshot(whaleStatus)
    chainCache.value = value
    chainCache.at = now
    return value
  }

  route('GET', '/api/health', async (req, res) => {
    sendJson(res, 200, {
      ok: true,
      name: 'dsh-whale-bridge',
      version: PACKAGE_VERSION,
      port: state.port,
      uptimeMs: Date.now() - state.startedAt,
    })
  })

  route('GET', '/api/state', async (req, res) => {
    const settings = store.get()
    const whaleStatus = await whale.status().catch((err) => ({ error: String(err && err.message ? err.message : err) }))
    const profile = runner.profileInfo || {}
    const chain = await cachedChainSnapshot(whaleStatus).catch((err) => ({ online: false, error: String(err && err.message ? err.message : err) }))
    sendJson(res, 200, {
      ok: true,
      now: nowISO(),
      settings: redactSettings(settings),
      status: {
        bridge: {
          listening: state.listening,
          port: state.port,
          uptimeMs: Date.now() - state.startedAt,
          lastError: state.lastError || undefined,
        },
        whale: whaleStatus,
        chain,
        dsh: {
          version: dshVersion(),
          profile: {
            name: 'whale-agent',
            dir: profile.profileDir,
            ready: Boolean(profile.ok),
            error: profile.error,
          },
        },
      },
      tasks: runner.historyList().slice(-20).reverse(),
      proxy: { running: proxyState.running },
      files: files ? files.status() : undefined,
    })
  })

  route('POST', '/api/chain/start', async (req, res) => {
    log('[chain] one-click start requested')
    const settings = store.get()
    const logs = []
    try {
      const ensured = await whale.ensureRunning({ timeoutMs: 120000 })
      logs.push('whale: ' + (ensured.running ? 'running' : 'failed') + (ensured.started ? ' (started)' : ''))
      let chain = await chainSnapshot({ running: ensured.running, webPort: chainPort(settings) })
      if (!chain.bridge.online) {
        const bat = path.join(settings.whaleDir, '启动微信桥接.bat')
        if (!fs.existsSync(bat)) {
          return sendJson(res, 500, { ok: false, error: '找不到启动微信桥接.bat：' + bat, logs, chain })
        }
        logs.push('bridge: spawning ' + bat)
        const child = spawn('cmd.exe', ['/c', bat], {
          cwd: settings.whaleDir, windowsHide: true, detached: true, stdio: 'ignore',
        })
        child.unref()
        const deadline = Date.now() + 120000
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          const st = await whale.status().catch(() => null)
          if (!st || !st.running) continue
          chain = await chainSnapshot(st).catch(() => chain)
          if (chain && chain.online) break
        }
      }
      const st = await whale.status().catch(() => null)
      if (st) chain = await chainSnapshot(st).catch(() => chain)
      logs.push('chain: ' + (chain && chain.online ? 'online' : 'not-online'))
      log('[chain] one-click result ' + (chain && chain.online ? 'online' : 'not-online'))
      return sendJson(res, 200, { ok: Boolean(chain && chain.online), chain, logs })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err), logs })
    }
  })

  function chainPort(settings) {
    const st = settings && settings.server ? settings.server : null
    if (st && Number(st.port)) return Number(st.port)
    return 8787
  }

  route('GET', '/api/persona', async (req, res) => {
    const settings = store.get()
    sendJson(res, 200, { ok: true, path: personaFilePath(settings), text: loadPersonaFile(settings) })
  })

  route('PUT', '/api/persona', async (req, res, body) => {
    const settings = store.get()
    const payload = body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'text')
      ? body.text
      : body
    const text = typeof payload === 'string' ? payload : ''
    if (!text) {
      sendJson(res, 400, { ok: false, error: '人设正文为空（需要 JSON 字符串字段 text）' })
      return
    }
    const r = savePersonaFile(settings, text)
    if (!r.ok) {
      sendJson(res, r.code === 'IO' ? 500 : 400, { ok: false, error: r.error })
      return
    }
    log(`[persona] saved ${r.length} chars -> ${r.path}`)
    sendJson(res, 200, { ok: true, path: r.path, length: r.length })
  })

  route('PUT', '/api/settings', async (req, res, body) => {
    const before = store.get()
    const payload = { ...(body || {}) }
    // 面板/调试卡从不回显 Key：空值或掩码占位表示「保持原 Key」
    if (payload.upstream && typeof payload.upstream === 'object') {
      const incoming = payload.upstream
      const key = incoming.apiKey
      if (!key || key === '__SET__') {
        payload.upstream = { ...incoming, apiKey: before.upstream?.apiKey || '' }
      }
    }
    const result = store.patch(payload)
    if (!result.ok) {
      sendJson(res, 400, { ok: false, errors: result.errors, settings: redactSettings(result.settings) })
      return
    }
    const warnings = []
    if (result.settings.port !== before.port) {
      warnings.push('端口已保存；插件重载后新端口才会生效，鲸鱼娘侧的接入地址需重新接入。')
    }
    if (result.settings.whaleDir !== before.whaleDir) {
      warnings.push('鲸鱼娘目录已更新；若之前接入过，请重新点「接入鲸鱼娘」。')
    }
    if (result.settings.mode !== before.mode) {
      // 让 profile patch 与当前设置一致
      try {
        await runner.ensureProfile()
        runner.writeProfilePatch({ model: result.settings.model, mode: result.settings.mode, reasoningEffort: result.settings.reasoningEffort })
      } catch (err) {
        warnings.push('任务 profile 更新失败：' + String(err && err.message ? err.message : err))
      }
    }
    log(`[settings] updated: ${Object.keys(body || {}).join(',')}`)
    sendJson(res, 200, { ok: true, settings: redactSettings(result.settings), warnings })
  })

  route('POST', '/api/task', async (req, res, body) => {
    const settings = store.get()
    const payload = body || {}
    log(`[api] task: ${String(payload.prompt || '').slice(0, 120)}`)
    const result = await runner.runTask({
      prompt: payload.prompt,
      workspace: payload.workspace || settings.workspace,
      permission: payload.permission || settings.permission,
      mode: payload.mode || settings.mode,
      sessionId: payload.sessionId || settings.defaultSessionId,
      timeoutMs: payload.timeoutMs || settings.timeoutMs,
    })
    // 配置了「默认会话」且本次是自动新建（原会话不可用）时，把新会话写回设置
    if (!payload.sessionId && settings.defaultSessionId && result.sessionReset && result.sessionId) {
      store.patch({ defaultSessionId: result.sessionId })
    }
    sendJson(res, 200, { ok: Boolean(result.ok), ...result })
  })

  // 流式任务：SSE 返回 DSH 的 text 事件，最后 done 带完整 result。
  // 给微信视频理解等需要“边做边显示”的链路用。
  route('POST', '/api/task/stream', async (req, res, body) => {
    const settings = store.get()
    const payload = body || {}
    log(`[api] task(stream): ${String(payload.prompt || '').slice(0, 120)}`)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const send = (obj) => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* client gone */ }
    }
    const sendText = (text) => send({ type: 'text', text: String(text || '') })
    let clientGone = false
    res.on('close', () => { clientGone = true })
    try {
      const result = await runner.runTask({
        prompt: payload.prompt,
        workspace: payload.workspace || settings.workspace,
        permission: payload.permission || settings.permission,
        mode: payload.mode || settings.mode,
        sessionId: payload.sessionId || settings.defaultSessionId,
        timeoutMs: payload.timeoutMs || settings.timeoutMs,
        onText: sendText,
        onProgress: (evt) => send({ type: 'progress', event: evt }),
      })
      if (!payload.sessionId && settings.defaultSessionId && result.sessionReset && result.sessionId) {
        store.patch({ defaultSessionId: result.sessionId })
      }
      send({ type: 'done', result: { ok: Boolean(result.ok), ...result } })
    } catch (err) {
      send({ type: 'done', result: { ok: false, error: String(err && err.message ? err.message : err) } })
    } finally {
      try { res.end() } catch { /* ignore */ }
    }
  })

  route('GET', '/api/tasks', async (req, res) => {
    sendJson(res, 200, { ok: true, tasks: runner.historyList().slice(-20).reverse() })
  })

  // ---- 文件通道（入站：鲸鱼娘网页「📎」上传） ----
  route('POST', '/api/upload', async (req, res, body) => {
    const result = files.upload(body || {})
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error })
      return
    }
    log(`[files] upload ok ${result.file.name} -> ${result.file.path}`)
    sendJson(res, 200, { ok: true, file: result.file, hint: result.file.hint })
  })

  route('GET', '/api/files', async (req, res) => {
    sendJson(res, 200, { ok: true, ...(files ? files.status() : {}) })
  })

  // 客户端面板自报：用于在拿不到浏览器控制权时确认「页面里真的加载了本插件」。
  const clientReports = []
  route('POST', '/api/client-report', async (req, res, body) => {
    const report = { at: nowISO(), ...(body || {}) }
    clientReports.push(report)
    if (clientReports.length > 50) clientReports.shift()
    log(`[client] ${JSON.stringify(report).slice(0, 500)}`)
    sendJson(res, 200, { ok: true })
  })

  route('GET', '/api/client-report', async (req, res) => {
    sendJson(res, 200, { ok: true, reports: clientReports.slice(-50) })
  })

  // 「打开鲸鱼娘页面」的确认跳板：宿主用各种方式调起浏览器打开这个地址，
  // 浏览器真的打开后会命中这里（留下证据），再 302 跳到目标页。
  // 这样面板可以确认「浏览器确实被叫起来了」，而不是 spawn 成功就假报「已打开」。
  const openEvidence = new Map()
  route('GET', '/open', async (req, res) => {
    let target = 'web'
    let token = ''
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      target = url.searchParams.get('to') === 'debug' ? 'debug' : 'web'
      token = url.searchParams.get('t') || ''
    } catch {
      /* 用默认值 */
    }
    if (token) {
      openEvidence.set(token, Date.now())
      const stale = [...openEvidence.keys()].filter((k) => Date.now() - openEvidence.get(k) > 120000)
      for (const k of stale) openEvidence.delete(k)
    }
    log(`[open] browser hit token=${token.slice(0, 12)} target=${target}`)
    const location = target === 'debug'
      ? `http://127.0.0.1:${whale.webPort()}/debug`
      : `http://127.0.0.1:${whale.webPort()}/`
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' })
    res.end()
  })

  function waitOpenEvidence(token, timeoutMs = 2500) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        if (openEvidence.has(token)) {
          openEvidence.delete(token)
          resolve(true)
          return
        }
        if (Date.now() >= deadline) {
          resolve(false)
          return
        }
        setTimeout(tick, 120)
      }
      tick()
    })
  }

  route('POST', '/api/dsh/rebuild-profile', async (req, res) => {
    try {
      const info = await runner.rebuildProfile()
      sendJson(res, 200, { ok: true, profileDir: info.profileDir, dshVersion: info.dshVersion })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  route('GET', '/api/whale/status', async (req, res) => {
    const status = await whale.status().catch((err) => ({ error: String(err && err.message ? err.message : err) }))
    sendJson(res, 200, { ok: true, ...status })
  })

  // 先帮忙启动鲸鱼娘（若没在跑），再由宿主打开网页/调试台（避免浏览器弹窗拦截）
  route('POST', '/api/whale/start', async (req, res) => {
    try {
      const result = await whale.ensureRunning()
      sendJson(res, 200, { ok: Boolean(result.running), ...result })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  route('POST', '/api/whale/stop', async (req, res) => {
    try {
      const result = await whale.stopServer()
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  route('POST', '/api/whale/open', async (req, res, body) => {
    try {
      const target = body && body.target === 'debug' ? 'debug' : 'web'
      const result = await whale.openPage(target)
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  route('POST', '/api/whale/adopt', async (req, res) => {
    try {
      const result = await whale.adopt()
      const internal = result.internalUpstream
      if (internal) {
        store.patch({ upstream: { baseUrl: internal.baseUrl, apiKey: internal.apiKey, model: internal.model } })
      }
      log(`[whale] adopted: baseUrl=${internal?.baseUrl || ''} model=${internal?.model || ''}`)
      sendJson(res, 200, { ...result, internalUpstream: undefined })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  route('POST', '/api/whale/revert', async (req, res) => {
    try {
      const result = whale.revert()
      sendJson(res, 200, result)
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // ---------------- DSH 原生聊天（brain=dsh）----------------
  route('GET', '/api/brain', async (req, res) => {
    const settings = store.get()
    const sessions = Object.entries(settings.chatSessions || {})
      .map(([key, v]) => ({ key, sessionId: v.sessionId, updatedAt: v.updatedAt || 0, title: v.title || '' }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    sendJson(res, 200, { ok: true, brain: settings.brain || 'upstream', port: settings.port, sessions })
  })

  route('PUT', '/api/brain', async (req, res, body) => {
    const next = String((body && body.brain) || '')
    if (next !== 'upstream' && next !== 'dsh') {
      sendJson(res, 400, { ok: false, error: "brain 必须是 'upstream' 或 'dsh'" })
      return
    }
    const result = store.patch({ brain: next })
    sendJson(res, 200, { ok: true, brain: result.settings.brain, errors: result.errors || [] })
  })

  route('POST', '/api/brain/reset', async (req, res, body) => {
    const key = body && body.key ? String(body.key) : ''
    const current = store.get()
    if (key) {
      const map = { ...(current.chatSessions || {}) }
      delete map[key]
      store.patch({ chatSessions: map })
      sendJson(res, 200, { ok: true, cleared: key })
      return
    }
    store.patch({ chatSessions: {} })
    sendJson(res, 200, { ok: true, cleared: 'all' })
  })

  // 面板「原生聊天测试」：不经过鲸鱼娘，直接走 DSH 原生聊天（带 chat key，便于看会话是否复用）
  route('POST', '/api/brain/chat', async (req, res, body) => {
    const text = String((body && body.text) || '').trim()
    const chatKey = String((body && body.chatKey) || 'panel|u|test').trim() || 'panel|u|test'
    const system = String(
      (body && body.system) || '你是鲸鱼娘（小肥鱼），深海鲸鱼女孩，说话口语化、简短。'
    )
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'text 不能为空' })
      return
    }
    const result = await proxy.complete(
      {
        model: 'deepseek-chat',
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
      },
      { headers: { 'x-whale-chat': encodeURIComponent(chatKey) } }
    )
    sendJson(res, 200, {
      ok: !result.error,
      reply: result.content || '',
      error: result.error || '',
      chatKey,
    })
  })

  // 桥接在文件/任务等待阶段来取一句「进度话术」：措辞由 DSH 侧（本插件的人格模板）决定，
  // 桥接只负责把返回的文本用微信 UIA 发出去——避免进度话术写死在桥接里。
  route('POST', '/api/wechat/progress-line', async (req, res, body) => {
    let text = ''
    try {
      text = await proxy.progressLineViaDsh(body || {})
    } catch {
      text = ''
    }
    sendJson(res, 200, { ok: true, text })
  })

  // 让鲸鱼娘指向 DSH（同步 config.json / data/settings.json 的 provider 映射；支持双向）
  route('POST', '/api/brain/sync', async (req, res, body) => {
    const direction = String((body && body.direction) || 'to-whale')
    const settings = store.get()
    if (direction === 'from-whale') {
      try {
        const whaleDir = String(settings.whaleDir || '').trim()
        const cfgPath = path.join(whaleDir, 'config.json')
        const dataCfgPath = path.join(whaleDir, 'data', 'settings.json')
        const readJson = (file) => {
          try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return {} }
        }
        const cfg = readJson(cfgPath)
        const webSettings = readJson(dataCfgPath)
        const llm = { ...(cfg.llm || {}), ...(cfg.deepseek || {}) }
        const baseUrl = String(webSettings.baseUrl || llm.baseUrl || '').trim()
        const model = String(webSettings.model || llm.model || '').trim()
        const apiKey = String(webSettings.apiKey || llm.apiKey || '').trim()
        if (!baseUrl && !model && !apiKey) {
          sendJson(res, 400, { ok: false, error: '鲸鱼娘配置里没有可读取的 llm 映射' })
          return
        }
        // 反向同步保护：鲸鱼娘此刻若正指向本插件，就没有「真实上游」可抄回来
        try {
          const u = new URL(baseUrl)
          const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
          if (loopback && Number(u.port || 80) === Number(settings.port)) {
            sendJson(res, 400, {
              ok: false,
              error: '鲸鱼娘的 llm.baseUrl 正指向本插件，无法反向导入；请先在鲸鱼娘里填真实上游，或改用「同步到鲸鱼娘」',
            })
            return
          }
        } catch {
          /* 非法 URL 由下游校验 */
        }
        const next = store.patch({ upstream: { baseUrl, model, apiKey } })
        sendJson(res, 200, {
          ok: true,
          brain: next.settings.brain || 'upstream',
          direction,
          upstream: {
            baseUrl: next.settings.upstream.baseUrl,
            model: next.settings.upstream.model,
            hasKey: Boolean(next.settings.upstream.apiKey),
          },
        })
        return
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
        return
      }
    }
    try {
      const result = await whale.adopt()
      const after = store.get()
      sendJson(res, 200, { ok: true, brain: after.brain || 'upstream', direction: 'to-whale', adopt: result })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // ---------------- 鲸鱼娘网页调试台（搬进插件面板）----------------
  const WHALE_CONSOLE_BASE = () => `http://127.0.0.1:${whale.webPort()}`
  async function whaleCall(method, pathname, payload) {
    const init = { method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) }
    if (payload !== undefined) init.body = JSON.stringify(payload)
    const response = await fetch(WHALE_CONSOLE_BASE() + pathname, init)
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = { ok: false, error: '鲸鱼娘返回了非 JSON：' + text.slice(0, 200) } }
    if (!response.ok && data && !data.error) data.error = 'HTTP ' + response.status
    return data
  }
  function redactSecrets(value) {
    if (Array.isArray(value)) return value.map(redactSecrets)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [key, val] of Object.entries(value)) {
        if (/apikey|token|secret|password/i.test(key)) {
          out[key] = val ? '__SET__' : val
          continue
        }
        out[key] = redactSecrets(val)
      }
      return out
    }
    return value
  }

  // 聚合调试台数据：状态 / 记忆 / 人设 / 功能开关 / 映射一致性（只读）
  route('GET', '/api/whale/console', async (req, res) => {
    const settings = store.get()
    const result = { ok: true, plugin: { port: settings.port, brain: settings.brain || 'upstream', model: settings.model || '', workspace: settings.workspace || '' }, whale: {}, mapping: {}, errors: [] }
    const jobs = [
      ['status', '/api/status'],
      ['memory', '/api/memory/info'],
      ['persona', '/api/persona'],
      ['features', '/api/features'],
      ['config', '/api/config'],
      ['sessions', '/api/debug/sessions'],
    ]
    await Promise.all(jobs.map(async ([key, pathname]) => {
      try {
        const data = await whaleCall('GET', pathname)
        result.whale[key] = key === 'config' ? redactSecrets(data) : data
      } catch (err) {
        result.errors.push(key + ': ' + String(err && err.message ? err.message : err))
      }
    }))
    const cfg = result.whale.config && result.whale.config.config ? result.whale.config.config : {}
    const llm = cfg.llm || cfg.deepseek || {}
    result.mapping = {
      whaleProvider: result.whale.status ? result.whale.status.provider : (cfg.provider || ''),
      whaleBaseUrl: result.whale.status ? result.whale.status.baseUrl : (llm.baseUrl || ''),
      whaleModel: result.whale.status ? result.whale.status.model : (llm.model || ''),
      pluginBaseUrl: 'http://127.0.0.1:' + settings.port + '/v1',
      pluginModel: settings.model || '',
      brain: settings.brain || 'upstream',
      consistent: Boolean(result.whale.status && String(result.whale.status.baseUrl || '').replace(/\/+$/, '') === ('http://127.0.0.1:' + settings.port + '/v1')),
    }
    sendJson(res, 200, result)
  })

  // 调试台：改鲸鱼娘配置（白名单字段，防误改）
  route('POST', '/api/whale/console/config', async (req, res, body) => {
    const patch = body && body.patch
    if (!patch || typeof patch !== 'object') {
      sendJson(res, 400, { ok: false, error: 'patch 必须是对象' })
      return
    }
    const allowed = {}
    if (typeof patch.model === 'string') allowed.model = patch.model
    if (typeof patch.provider === 'string') allowed.provider = patch.provider
    if (patch.llm && typeof patch.llm === 'object') {
      allowed.llm = {}
      if (typeof patch.llm.baseUrl === 'string') allowed.llm.baseUrl = patch.llm.baseUrl
      if (typeof patch.llm.model === 'string') allowed.llm.model = patch.llm.model
    }
    if (!Object.keys(allowed).length) {
      sendJson(res, 400, { ok: false, error: '没有可修改的字段（只允许 provider / model / llm.baseUrl / llm.model）' })
      return
    }
    try {
      const data = await whaleCall('POST', '/api/config', { patch: allowed })
      sendJson(res, 200, { ok: Boolean(data.ok), changed: data.changed || [], config: redactSecrets(data.config || {}) })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // 调试台：主动搭话设置（care.*）
  route('GET', '/api/whale/console/care', async (req, res) => {
    try {
      const data = await whaleCall('GET', '/api/config')
      const cfg = data && data.config ? data.config : {}
      const care = cfg.care || {}
      sendJson(res, 200, { ok: true, care })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  route('POST', '/api/whale/console/care', async (req, res, body) => {
    const src = body && body.care && typeof body.care === 'object' ? body.care : null
    if (!src) {
      sendJson(res, 400, { ok: false, error: 'care 必须是对象' })
      return
    }
    const care = {}
    for (const k of ['enabled', 'allowGroups', 'onlyMaster', 'allowOthers']) {
      if (typeof src[k] === 'boolean') care[k] = src[k]
    }
    for (const k of ['everyMinutes', 'jitterMinutes', 'maxPerDay', 'quietAfterMinutes']) {
      if (src[k] !== undefined) {
        const n = Number(src[k])
        if (!Number.isFinite(n) || n < 0) {
          sendJson(res, 400, { ok: false, error: k + ' 必须是非负数字' })
          return
        }
        care[k] = n
      }
    }
    if (Array.isArray(src.windows)) {
      const windows = src.windows.map((w) => String(w || '').trim()).filter(Boolean)
      if (windows.some((w) => !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(w))) {
        sendJson(res, 400, { ok: false, error: 'windows 格式应为 09:00-12:00' })
        return
      }
      care.windows = windows
    }
    if (!Object.keys(care).length) {
      sendJson(res, 400, { ok: false, error: '没有可修改的 care 字段' })
      return
    }
    try {
      const data = await whaleCall('POST', '/api/config', { patch: { care } })
      sendJson(res, 200, { ok: Boolean(data.ok), changed: data.changed || [], care: care })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // 调试台：媒体缓存清理设置（features.mediaCleanup + storage.mediaKeepDays/mediaMaxMB）
  route('GET', '/api/whale/console/media', async (req, res) => {
    try {
      const data = await whaleCall('GET', '/api/config')
      const cfg = data && data.config ? data.config : {}
      sendJson(res, 200, {
        ok: true,
        media: {
          cleanup: Boolean(cfg.features && cfg.features.mediaCleanup !== false),
          keepDays: Number((cfg.storage || {}).mediaKeepDays) || 7,
          maxMB: Number((cfg.storage || {}).mediaMaxMB) || 500,
        },
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  route('POST', '/api/whale/console/media', async (req, res, body) => {
    const src = body && body.media && typeof body.media === 'object' ? body.media : null
    if (!src) {
      sendJson(res, 400, { ok: false, error: 'media 必须是对象' })
      return
    }
    const patch = {}
    if (typeof src.cleanup === 'boolean') patch['features.mediaCleanup'] = src.cleanup
    if (src.keepDays !== undefined) {
      const n = Number(src.keepDays)
      if (!Number.isFinite(n) || n < 1 || n > 365) {
        sendJson(res, 400, { ok: false, error: 'keepDays 必须是 1-365' })
        return
      }
      patch['storage.mediaKeepDays'] = Math.floor(n)
    }
    if (src.maxMB !== undefined) {
      const n = Number(src.maxMB)
      if (!Number.isFinite(n) || n < 10 || n > 100000) {
        sendJson(res, 400, { ok: false, error: 'maxMB 必须是 10-100000' })
        return
      }
      patch['storage.mediaMaxMB'] = Math.floor(n)
    }
    if (!Object.keys(patch).length) {
      sendJson(res, 400, { ok: false, error: '没有可修改的媒体设置' })
      return
    }
    try {
      const data = await whaleCall('POST', '/api/config', { patch })
      sendJson(res, 200, { ok: Boolean(data.ok), changed: data.changed || [], media: src })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // 调试台：prompt 预览（和微信/网页同一套人设与规则，返回组装好的 system 提示词）
  route('POST', '/api/whale/console/prompt', async (req, res, body) => {
    const text = String((body && body.text) || '').trim()
    if (!text) {
      sendJson(res, 400, { ok: false, error: 'text 不能为空' })
      return
    }
    try {
      const data = await whaleCall('POST', '/api/debug/prompt', {
        text,
        senderName: String((body && body.senderName) || '调试主人'),
        chatType: (body && body.chatType) === 'group' ? 'group' : 'private',
        chatTitle: String((body && body.chatTitle) || ''),
        senderId: '',
      })
      sendJson(res, 200, {
        ok: Boolean(data.ok),
        system: String(data.system || ''),
        length: Number(data.length) || 0,
        isMaster: Boolean(data.isMaster),
        linkText: Boolean(data.linkText),
      })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // 调试台：清掉某个鲸鱼娘会话的记忆
  route('POST', '/api/whale/console/memory/reset', async (req, res, body) => {
    const key = String((body && body.key) || '').trim()
    if (!key) {
      sendJson(res, 400, { ok: false, error: '缺少 key（可从调试台会话列表里选）' })
      return
    }
    try {
      const data = await whaleCall('POST', '/api/debug/reset', { key })
      sendJson(res, 200, { ok: Boolean(data.ok), cleared: key })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // 调试台：功能开关（表情包/群聊判定/开怼校验等）
  route('POST', '/api/whale/console/feature', async (req, res, body) => {
    const key = String((body && body.key) || '').trim()
    if (!key) {
      sendJson(res, 400, { ok: false, error: '缺少 key' })
      return
    }
    try {
      const data = await whaleCall('POST', '/api/features', { key, value: Boolean(body && body.value) })
      sendJson(res, 200, { ok: Boolean(data.ok), key, value: Boolean(data.value), features: data.features || null, error: data.error || '' })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // 调试台：看图 Key 测试
  route('POST', '/api/whale/console/vision-test', async (req, res) => {
    try {
      const data = await whaleCall('POST', '/api/vision/test', {})
      sendJson(res, 200, { ok: Boolean(data.ok), sample: data.sample || '', vision: data.vision || data, error: data.error || '' })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // 调试台：微信账号列表 / 选账号
  route('GET', '/api/whale/console/accounts', async (req, res) => {
    try {
      const data = await whaleCall('GET', '/api/wechat/accounts')
      sendJson(res, 200, data)
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })
  route('POST', '/api/whale/console/accounts/refresh', async (req, res) => {
    try {
      const data = await whaleCall('POST', '/api/wechat/accounts/refresh', {})
      sendJson(res, 200, data)
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })
  route('POST', '/api/whale/console/account', async (req, res, body) => {
    const account = String((body && body.account) || '').trim()
    try {
      const data = await whaleCall('POST', '/api/wechat/account', { account })
      sendJson(res, 200, { ok: Boolean(data.ok), needBridgeRestart: Boolean(data.needBridgeRestart), error: data.error || '', accounts: data.accounts || null })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  // 调试台：手动记忆快照
  route('POST', '/api/whale/console/memory/backup', async (req, res) => {
    try {
      const data = await whaleCall('POST', '/api/memory/backup', {})
      sendJson(res, 200, { ok: Boolean(data.ok), file: data.file || '', message: data.message || '' })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  })

  route('GET', '/v1/models', async (req, res) => {
    const settings = store.get()
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: settings.upstream?.model || 'deepseek-chat', object: 'model', owned_by: 'dsh-whale-bridge' }],
    })
  })

  route('POST', '/v1/chat/completions', async (req, res, body) => {
    proxyState.running += 1
    // 鲸鱼娘可能先超时断开：把断开信号传给代理/任务执行器，及时终止 DSH 子进程
    const abortController = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) abortController.abort()
    }
    res.on('close', onClose)
    try {
      const payload = body || {}
      const wantsStream = Boolean(payload.stream)
      log(`[proxy] chat completion stream=${wantsStream} messages=${(payload.messages || []).length}`)
      let streamState
      const ensureStream = () => {
        if (!streamState) streamState = proxy.openStream(res, payload.model)
        return streamState
      }
      // 状态播报：收到 DSH 任务 / 任务进行中 / 上游思考较久时，先流式回一句话
      const onStatus = (text) => {
        if (!wantsStream || abortController.signal.aborted) return
        ensureStream()
        proxy.streamDelta(res, text, streamState)
      }
      if (wantsStream) ensureStream()
      const result = await proxy.complete(payload, {
        signal: abortController.signal,
        onStatus,
        headers: req.headers,
      })
      if (abortController.signal.aborted) {
        log('[proxy] client disconnected, response dropped')
        return
      }
      if (wantsStream) {
        const text = result.content || (result.error ? '（DSH 桥接错误）' + result.error : '')
        if (text) proxy.streamDelta(res, text, ensureStream())
        proxy.finishStream(res, streamState)
      } else if (result.error && !result.content) {
        proxy.writeJson(res, { error: result.error })
      } else {
        proxy.writeJson(res, { content: result.content || '', model: payload.model })
      }
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      log('[proxy] error: ' + message)
      if (abortController.signal.aborted) return
      try {
        if (body && body.stream) {
          proxy.writeStream(res, '（DSH 桥接错误）' + message, { model: body.model })
        } else {
          proxy.writeJson(res, { error: message })
        }
      } catch {
        /* 响应可能已发出 */
      }
    } finally {
      res.removeListener('close', onClose)
      proxyState.running = Math.max(0, proxyState.running - 1)
    }
  })

  function serveStatic(pathname, res) {
    const map = {
      '/static/debug-bridge.js': path.join(PACKAGE_ROOT, 'whale-side', 'debug-bridge.js'),
      '/static/web-file-channel.js': path.join(PACKAGE_ROOT, 'whale-side', 'web-file-channel.js'),
      '/static/icon.svg': path.join(PACKAGE_ROOT, 'icon.svg'),
    }
    const file = map[pathname]
    if (!file) return false
    try {
      const data = fs.readFileSync(file)
      const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'image/svg+xml'
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
      res.end(data)
      return true
    } catch {
      sendJson(res, 404, { ok: false, error: '静态文件未找到：' + pathname })
      return true
    }
  }

  const server = http.createServer(async (req, res) => {
    cors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    let pathname = '/'
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      pathname = url.pathname
    } catch {
      pathname = '/'
    }
    if (req.method === 'GET' && serveStatic(pathname, res)) return
    // 文件下载：GET /files/<token>/<name>
    if (req.method === 'GET' && pathname.startsWith('/files/')) {
      const rest = pathname.slice('/files/'.length)
      const slash = rest.indexOf('/')
      const token = slash >= 0 ? rest.slice(0, slash) : rest
      const urlName = slash >= 0 ? rest.slice(slash + 1) : ''
      files.serve(req, res, token, urlName)
      return
    }
    const handler = routes.get(req.method + ' ' + pathname)
    if (!handler) {
      sendJson(res, 404, { ok: false, error: `未知接口：${req.method} ${pathname}` })
      return
    }
    try {
      let body
      const bodyLimit = pathname === '/api/upload' && files ? files.uploadBodyLimit() : MAX_BODY
      if (req.method !== 'GET') body = await readBody(req, bodyLimit)
      await handler(req, res, body)
    } catch (err) {
      const message = String(err && err.message ? err.message : err)
      state.lastError = message
      log('[http] error: ' + message)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: message })
      else {
        try { res.end() } catch { /* ignore */ }
      }
    }
  })

  function listen(port) {
    return new Promise((resolve) => {
      state.server = server
      const onError = (err) => {
        server.removeListener('listening', onListening)
        state.lastError = String(err && err.message ? err.message : err)
        log(`[http] listen ${port} failed: ${state.lastError}`)
        resolve({ ok: false, error: state.lastError })
      }
      const onListening = () => {
        server.removeListener('error', onError)
        state.listening = true
        state.port = port
        state.startedAt = Date.now()
        log(`[http] listening 127.0.0.1:${port}`)
        resolve({ ok: true, port })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  async function rebind(port) {
    try {
      await new Promise((resolve) => {
        if (!state.listening) return resolve()
        server.close(() => resolve())
        try { server.closeAllConnections?.() } catch { /* ignore */ }
      })
    } catch {
      /* ignore */
    }
    state.listening = false
    return listen(port)
  }

  function close() {
    return new Promise((resolve) => {
      if (!state.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
      try { server.closeAllConnections?.() } catch { /* ignore */ }
      state.listening = false
    })
  }

  return { server, listen, close, rebind, state, getPort: () => state.port, waitOpenEvidence }
}
