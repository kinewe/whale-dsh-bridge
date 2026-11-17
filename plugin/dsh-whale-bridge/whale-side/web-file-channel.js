/**
 * web-file-channel.js —— 鲸鱼娘网页聊天页的「文件通道」增强脚本
 *
 * 由桥接在接入（adopt）时以带标记的 <script> 注入到鲸鱼娘 web/index.html；
 * 本文件由桥接服务（http://127.0.0.1:8789/static/web-file-channel.js）提供，鲸鱼娘源码不改。
 *
 * 功能：
 *  1) 输入框旁注入「📎」按钮：选文件 → base64 上传到桥接 /api/upload → 落到工作区
 *     .whale-bridge/inbox；下一条聊天消息自动追加 `[Shared attachment] file: <绝对路径>`，
 *     桥接代理把路径提示给模型，模型转给 DSH 读取（Hermes 约定）。
 *  2) 把鲸鱼娘回复里的 `http://127.0.0.1:<port>/files/<token>/<name>` 渲染成可点击下载链接。
 *  3) 把历史消息里的 `[Shared attachment] file: ...` 显示成简洁的「📎 附件：名字」。
 *
 * 纯浏览器脚本、无依赖；加载失败不影响鲸鱼娘原有功能。
 */
(function () {
  'use strict'

  if (window.__whaleFileChannelLoaded) return
  window.__whaleFileChannelLoaded = true

  // 桥接地址 = 本脚本的来源（接入时按实际端口写进 src）
  var SELF = document.currentScript
  var BRIDGE = 'http://127.0.0.1:8789'
  try {
    if (SELF && SELF.src) BRIDGE = new URL(SELF.src).origin
  } catch (e) { /* 用默认值 */ }

  var FILE_URL_RE = /(https?:\/\/127\.0\.0\.1:\d+\/files\/[A-Za-z0-9]+\/[^\s<>"'）)】]+)/g
  var ATTACH_RE = /\[Shared attachment\]\s*file:\s*([^\r\n]+)/g

  /** 待发送附件：{ name, path, size } */
  var pending = []
  /** 正在上传的数量 */
  var uploading = 0
  var chatEl = null
  var listEl = null
  var fileInput = null

  function $(sel) { return document.querySelector(sel) }
  function h(tag, cls, text) {
    var el = document.createElement(tag)
    if (cls) el.className = cls
    if (text != null) el.textContent = text
    return el
  }
  function formatSize(n) {
    n = Number(n) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1024 / 1024).toFixed(1) + ' MB'
  }
  function notify(text, isError) {
    try {
      if (typeof window.toast === 'function') { window.toast(text); return }
    } catch (e) { /* ignore */ }
    var el = h('div', 'wb-file-toast', text)
    el.style.borderColor = isError ? 'rgba(255,120,140,.5)' : 'rgba(88,214,224,.45)'
    document.body.appendChild(el)
    setTimeout(function () { el.remove() }, 3200)
  }

  function injectStyles() {
    if (document.getElementById('wb-file-style')) return
    var style = document.createElement('style')
    style.id = 'wb-file-style'
    style.textContent = [
      '.wb-file-btn{border:1px solid rgba(88,214,224,.35);background:rgba(9,40,58,.55);color:#bfeef4;border-radius:12px;width:38px;height:38px;font-size:17px;line-height:1;cursor:pointer;flex:0 0 auto;padding:0;transition:background .15s,border-color .15s}',
      '.wb-file-btn:hover{background:rgba(88,214,224,.16);border-color:rgba(88,214,224,.6)}',
      '.wb-file-btn:disabled{opacity:.45;cursor:default}',
      '.wb-attach-list{display:none;flex-wrap:wrap;gap:6px;padding:6px 2px 8px}',
      '.wb-attach-list.show{display:flex}',
      '.wb-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px solid rgba(88,214,224,.3);background:rgba(9,40,58,.5);color:#cfeff4;border-radius:10px;padding:3px 8px;font-size:12px;line-height:1.5}',
      '.wb-chip .wb-x{border:0;background:transparent;color:#8fc6ce;cursor:pointer;font-size:13px;padding:0 0 0 2px;line-height:1}',
      '.wb-chip .wb-x:hover{color:#ff9aa8}',
      '.wb-chip.uploading{opacity:.6}',
      '.wb-file-link{color:#7fe3ef;text-decoration:underline;text-underline-offset:2px;word-break:break-all}',
      '.wb-file-link:hover{color:#b6f6ff}',
      '.wb-file-toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:9999;max-width:80vw;padding:9px 14px;border-radius:12px;border:1px solid rgba(88,214,224,.45);background:rgba(6,26,38,.95);color:#d8f6fb;font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.4)}',
    ].join('\n')
    document.head.appendChild(style)
  }

  function renderPending() {
    if (!listEl) return
    listEl.textContent = ''
    if (!pending.length) {
      listEl.classList.remove('show')
      return
    }
    listEl.classList.add('show')
    pending.forEach(function (item, index) {
      var chip = h('span', 'wb-chip' + (item.uploading ? ' uploading' : ''))
      chip.appendChild(h('span', null, (item.uploading ? '⏳ ' : '📄 ') + item.name))
      if (!item.uploading) {
        chip.appendChild(h('span', null, '（' + formatSize(item.size) + '）'))
        var x = h('button', 'wb-x', '✕')
        x.type = 'button'
        x.title = '移除这个附件'
        x.addEventListener('click', function () {
          pending.splice(index, 1)
          renderPending()
        })
        chip.appendChild(x)
      }
      listEl.appendChild(chip)
    })
  }

  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () {
        var text = String(reader.result || '')
        var comma = text.indexOf(',')
        resolve(comma >= 0 ? text.slice(comma + 1) : text)
      }
      reader.onerror = function () { reject(reader.error || new Error('读取文件失败')) }
      reader.readAsDataURL(file)
    })
  }

  function uploadOne(file) {
    var item = { name: file.name, size: file.size, uploading: true }
    pending.push(item)
    renderPending()
    return readBase64(file)
      .then(function (base64) {
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
        var timer = controller ? setTimeout(function () { controller.abort() }, 120000) : null
        return fetch(BRIDGE + '/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, data: base64 }),
          signal: controller ? controller.signal : undefined,
        }).then(function (res) {
          if (timer) clearTimeout(timer)
          return res.text().then(function (text) {
            var json = {}
            try { json = JSON.parse(text) } catch (e) { /* ignore */ }
            if (!res.ok || !json.ok) {
              throw new Error((json && json.error) || ('上传失败 HTTP ' + res.status))
            }
            return json.file
          })
        }, function (err) {
          if (timer) clearTimeout(timer)
          throw err
        })
      })
      .then(function (saved) {
        item.uploading = false
        item.name = saved.name || item.name
        item.path = saved.path
        item.size = saved.size || item.size
        renderPending()
      })
      .catch(function (err) {
        var idx = pending.indexOf(item)
        if (idx >= 0) pending.splice(idx, 1)
        renderPending()
        notify('文件上传失败：' + (err && err.message ? err.message : err), true)
      })
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || [])
    if (!files.length) return
    uploading += files.length
    var btn = $('.wb-file-btn')
    if (btn) btn.disabled = true
    var jobs = files.map(function (file) { return uploadOne(file) })
    Promise.all(jobs).then(function () {
      uploading = Math.max(0, uploading - files.length)
      var b = $('.wb-file-btn')
      if (b) b.disabled = uploading > 0
      var ok = pending.filter(function (p) { return p.path }).length
      if (ok) notify('已上传 ' + ok + ' 个文件，下一条消息会交给 DSH 处理')
    })
  }

  function readyAttachments() {
    return pending.filter(function (p) { return p.path && !p.uploading })
  }

  /** 只选了文件、输入框是空的：发送前自动补一句，否则鲸鱼娘页面会直接 return 不发请求。 */
  function prefillForSend() {
    var ready = readyAttachments()
    if (!ready.length) return false
    var input = document.getElementById('input')
    if (!input) return false
    if (String(input.value || '').trim()) return false
    var names = ready.map(function (p) { return p.name }).join('、')
    input.value = '看看这个文件：' + names
    try { input.dispatchEvent(new Event('input', { bubbles: true })) } catch (e) { /* ignore */ }
    return true
  }

  function restoreAttachments(items) {
    if (!items || !items.length) return
    pending = items.concat(pending)
    renderPending()
  }

  /** 从 SSE 文本里收集 done 文本，返回文件下载 URL 列表。 */
  function collectFileUrlsFromSse(raw) {
    var lines = String(raw || '').split(/\r?\n/)
    var full = ''
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i]
      if (line.indexOf('data:') !== 0) continue
      var body = line.slice(5).trim()
      if (!body || body === '[DONE]') continue
      try {
        var evt = JSON.parse(body)
        if (evt.type === 'delta') full += evt.text || ''
        else if (evt.type === 'done') full = String(evt.text != null ? evt.text : full) + (full && evt.text == null ? full : '')
      } catch (e) { /* ignore malformed */ }
    }
    var urls = []
    var re = /(https?:\/\/127\.0\.0\.1:\d+\/files\/[A-Za-z0-9]+\/[^\s"'）)】]+)/g
    var match
    while ((match = re.exec(full))) urls.push(match[1])
    return urls
  }

  var announced = {}
  /** 兜底：鲸鱼娘服务端可能重排/截断长回复，把下载链接切成两半；这里从原始 SSE 里再补一条。 */
  function ensureFileLinks(urls) {
    var chat = document.getElementById('chat')
    var text = chat ? chat.textContent : ''
    var missing = []
    for (var i = 0; i < urls.length; i += 1) {
      var url = urls[i]
      if (announced[url]) continue
      var tokenMatch = /\/files\/([a-f0-9]+)\//.exec(url)
      var token = tokenMatch ? tokenMatch[1] : ''
      if (text.indexOf(url) >= 0 || (token && text.indexOf(token) >= 0)) continue
      announced[url] = true
      missing.push(url)
    }
    if (!missing.length) return
    if (typeof window.addMessage !== 'function') return
    for (var j = 0; j < missing.length; j += 1) {
      window.addMessage({ role: 'bot', text: '📎 文件下载：\n' + missing[j] })
    }
  }

  function watchChatResponse(fetchPromise) {
    fetchPromise.then(function (res) {
      try {
        if (!res || !res.ok || !res.body) return
        var ct = res.headers.get('content-type') || ''
        if (ct.indexOf('text/event-stream') < 0) return
        var clone
        try { clone = res.clone() } catch (e) { return }
        var reader = clone.body.getReader()
        var decoder = new TextDecoder('utf-8')
        var raw = ''
        var pump = function () {
          return reader.read().then(function (r) {
            if (r.done) return raw
            raw += decoder.decode(r.value, { stream: true })
            return pump()
          })
        }
        pump().then(function (all) {
          var urls = collectFileUrlsFromSse(all)
          if (urls.length) setTimeout(function () { ensureFileLinks(urls) }, 1600)
        }).catch(function () { /* ignore */ })
      } catch (e) { /* ignore */ }
    }, function () { /* 请求失败由调用方处理 */ })
  }

  /** 生成实际发给鲸鱼娘 /api/chat 的文本（原文本 + 附件路径提示行）。 */
  function buildOutgoingText(text) {
    var ready = readyAttachments()
    var markers = ready.map(function (p) { return '[Shared attachment] file: ' + p.path }).join('\n')
    return {
      text: String(text || '') + (markers ? '\n\n' + markers : ''),
      markers: markers,
    }
  }

  /** 包装 fetch：给 /api/chat 的请求悄悄追加附件路径提示（界面上的原文不变）。 */
  function wrapFetch() {
    if (typeof window.fetch !== 'function' || window.__wbFetchWrapped) return
    window.__wbFetchWrapped = true
    var original = window.fetch
    window.fetch = function (input, init) {
      var sent = []
      var isChatCall = false
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || ''
        var sameOrigin = !/^https?:\/\//i.test(url) || url.indexOf(location.origin) === 0
        isChatCall = sameOrigin && /\/api\/chat$/i.test(url.split('?')[0])
        var method = (init && init.method ? String(init.method) : 'GET').toUpperCase()
        var ready = readyAttachments()
        if (isChatCall && method === 'POST' && init && typeof init.body === 'string' && ready.length) {
          var body = JSON.parse(init.body)
          var decorated = buildOutgoingText(body.text)
          body.text = decorated.text
          init = Object.assign({}, init, { body: JSON.stringify(body) })
          sent = ready
          pending = []
          renderPending()
        }
      } catch (e) {
        /* 包装失败时按原请求走 */
      }
      var requestPromise
      try {
        requestPromise = original.call(this, input, init)
      } catch (err) {
        restoreAttachments(sent)
        throw err
      }
      if (isChatCall) {
        watchChatResponse(requestPromise)
        if (sent.length) {
          requestPromise.then(function (res) {
            if (!res || !res.ok) restoreAttachments(sent)
          }, function () { restoreAttachments(sent) })
        }
      }
      return requestPromise
    }
  }

  function basename(p) {
    var s = String(p || '')
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
    return i >= 0 ? s.slice(i + 1) : s
  }

  function linkifyTextNode(node) {
    var text = node.nodeValue
    if (!text || text.indexOf('/files/') < 0) return
    var frag = document.createDocumentFragment()
    var last = 0
    var match
    FILE_URL_RE.lastIndex = 0
    while ((match = FILE_URL_RE.exec(text))) {
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)))
      var a = document.createElement('a')
      a.className = 'wb-file-link'
      a.href = match[1]
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = '⬇ 下载'
      a.title = match[1]
      frag.appendChild(a)
      last = match.index + match[1].length
    }
    if (!last) return
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)))
    node.parentNode.replaceChild(frag, node)
  }

  function cleanAttachmentTextNode(node) {
    var text = node.nodeValue
    if (!text || text.indexOf('[Shared attachment]') < 0) return
    ATTACH_RE.lastIndex = 0
    var next = text.replace(ATTACH_RE, function (_m, p) { return '📎 附件：' + basename(p) })
    if (next !== text) node.nodeValue = next
  }

  function walkTextNodes(el, fn) {
    var children = Array.prototype.slice.call(el.childNodes || [])
    for (var i = 0; i < children.length; i += 1) {
      var node = children[i]
      if (node.nodeType === 3) fn(node)
      else if (node.nodeType === 1 && node.nodeName !== 'A') walkTextNodes(node, fn)
    }
  }

  function scanMessages() {
    if (!chatEl) chatEl = document.getElementById('chat')
    if (!chatEl) return
    var bubbles = chatEl.querySelectorAll('.bubble-text')
    for (var i = 0; i < bubbles.length; i += 1) {
      var bubble = bubbles[i]
      if (bubble.closest && bubble.closest('.msg.user')) {
        walkTextNodes(bubble, cleanAttachmentTextNode)
      }
      walkTextNodes(bubble, linkifyTextNode)
    }
  }

  function observeChat() {
    chatEl = document.getElementById('chat')
    if (!chatEl) return
    var scheduled = false
    var schedule = function () {
      if (scheduled) return
      scheduled = true
      setTimeout(function () { scheduled = false; scanMessages() }, 40)
    }
    var observer = new MutationObserver(schedule)
    observer.observe(chatEl, { childList: true, subtree: true, characterData: true })
    scanMessages()
  }

  function injectComposer() {
    var row = document.querySelector('.composer .input-row')
    if (!row) return false
    if (row.querySelector('.wb-file-btn')) return true

    var btn = h('button', 'wb-file-btn', '📎')
    btn.type = 'button'
    btn.title = '发送文件给 DSH（选好后，下一条消息会带上附件路径）'
    btn.setAttribute('aria-label', '发送文件给 DSH')

    var input = h('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    input.addEventListener('change', function () {
      handleFiles(input.files)
      input.value = ''
    })
    fileInput = input
    btn.addEventListener('click', function () { input.click() })

    var textarea = row.querySelector('#input') || row.querySelector('textarea')
    if (textarea) row.insertBefore(btn, textarea)
    else row.appendChild(btn)
    row.appendChild(input)

    var composer = row.parentNode
    listEl = h('div', 'wb-attach-list')
    listEl.id = 'wbAttachList'
    composer.insertBefore(listEl, row)
    return true
  }

  function boot() {
    injectStyles()
    wrapFetch()
    // 调试/自检钩子（只读接口，不影响正常聊天）
    try {
      window.__whaleFileChannel = {
        version: '1.0.0',
        bridge: BRIDGE,
        getPending: function () {
          return pending.map(function (p) { return { name: p.name, path: p.path, size: p.size, uploading: !!p.uploading } })
        },
        buildOutgoingText: buildOutgoingText,
      }
    } catch (e) { /* ignore */ }
    var tries = 0
    var timer = setInterval(function () {
      tries += 1
      var ok = injectComposer()
      if (ok || tries > 60) {
        clearInterval(timer)
        observeChat()
      }
    }, 500)
    // 只选了文件、没打字就点发送：发送前自动补一句（否则鲸鱼娘页面会直接 return）
    document.addEventListener('click', function (e) {
      try {
        if (e.target && e.target.closest && e.target.closest('#send')) prefillForSend()
      } catch (err) { /* ignore */ }
    }, true)
    document.addEventListener('keydown', function (e) {
      try {
        if (e.key !== 'Enter' || e.shiftKey) return
        if (e.target && e.target.id === 'input') prefillForSend()
      } catch (err) { /* ignore */ }
    }, true)
    // 聊天区可能在稍后替换，兜底周期性扫描（开销很小）
    setInterval(function () { scanMessages() }, 4000)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
