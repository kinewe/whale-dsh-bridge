/*!
 * debug-bridge.js —— 鲸鱼娘 /debug 调试台的「DSH 桥接 · 权限与模式」卡片
 * ------------------------------------------------------------------
 * 这是什么：
 *   由 whale-side/install-whale-side.ps1 在鲸鱼娘 web/debug.html 的 </main> 前插入
 *   一个 <script defer> 引用。运行时它会在调试台 <main> 末尾追加一张卡片：
 *     · 显示桥接服务 / 鲸鱼娘接入 / DSH 任务 profile 状态
 *     · 设置 DSH 权限（read-only / workspace-write / danger-full-access）、
 *       模式（standard / creator）、工作区
 *     · 保存设置（PUT /api/settings）、跑一句测试任务（POST /api/task）
 *
 * 约束：
 *   · 纯浏览器脚本，无依赖、无 import，不写入 document.head/main 之外的东西；
 *   · 所有网络请求都打 http://127.0.0.1:<port>/...（默认 8789），全部包了错误处理，
 *     桥接没启动时只在卡片里显示一行可读提示，绝不让页面报错；
 *   · 端口可用全局变量 window.DSH_WHALE_BRIDGE_PORT 覆盖（默认 8789）。
 *
 * 不会做的事：不启动鲸鱼娘服务、不碰微信桥接、不改鲸鱼娘的任何设置文件。
 */
(function () {
  'use strict';

  var VERSION = '0.1.0';
  var CARD_ID = 'whale-bridge-card';
  var STYLE_ID = 'whale-bridge-card-style';
  var GLOBAL_KEY = '__dshWhaleBridgeCard';
  var DEFAULT_PORT = 8789;
  var REFRESH_MS = 5000;      // 状态刷新间隔
  var API_TIMEOUT_MS = 8000;  // 普通接口超时
  var TASK_TIMEOUT_MS = 660000; // 测试任务：桥接默认 600s 超时，再宽限一点

  var PERMISSIONS = [
    { value: 'read-only', label: 'read-only · 只读' },
    { value: 'workspace-write', label: 'workspace-write · 工作区可写' },
    { value: 'danger-full-access', label: 'danger-full-access · 完全权限' }
  ];
  var MODES = [
    { value: 'standard', label: 'standard · 标准' },
    { value: 'creator', label: 'creator · 创造' }
  ];

  var CARD_CSS = [
    '#whale-bridge-card .whale-bridge-row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:8px 0; }',
    '#whale-bridge-card .whale-bridge-row > label { font-size:12.5px; color:var(--dim); display:flex; gap:6px; align-items:center; flex-wrap:wrap; }',
    '#whale-bridge-card .whale-bridge-dim { font-size:12.5px; color:var(--dim); }',
    '#whale-bridge-card .whale-bridge-hint { margin:0 0 8px; font-size:12.5px; color:var(--dim); line-height:1.6; }',
    '#whale-bridge-card .whale-bridge-subtitle { margin:14px 0 6px; font-size:13px; color:var(--text); font-weight:600; border-top:1px dashed rgba(120,210,255,.16); padding-top:12px; }',
    '#whale-bridge-card input[type=text] { min-width:280px; }',
    '#whale-bridge-card textarea { width:100%; min-height:56px; resize:vertical; line-height:1.5; }',
    '#whale-bridge-card .whale-bridge-out { white-space:pre-wrap; word-break:break-word; font-size:12.5px; line-height:1.6;',
    '  background:rgba(2,14,26,.65); border:1px solid var(--line); border-radius:12px; padding:10px 12px;',
    '  max-height:340px; overflow:auto; margin:8px 0 0; color:var(--text); }',
    '#whale-bridge-card .whale-bridge-error { margin:8px 0 0; font-size:12.5px; line-height:1.6; color:var(--bad);',
    '  background:rgba(255,120,140,.08); border:1px solid rgba(255,120,140,.3); border-radius:12px; padding:8px 10px; white-space:pre-wrap; word-break:break-word; }',
    '#whale-bridge-card .whale-bridge-foot { margin:14px 0 0; padding-top:10px; border-top:1px dashed rgba(120,210,255,.14);',
    '  font-size:11.5px; color:rgba(169,207,228,.75); line-height:1.7; word-break:break-all; }'
  ].join('\n');

  /* ------------------------------ 小工具 ------------------------------ */

  function resolvePort() {
    var raw;
    try { raw = (typeof window !== 'undefined') ? window.DSH_WHALE_BRIDGE_PORT : undefined; } catch (e) { raw = undefined; }
    var n = Number(raw);
    if (isFinite(n) && n >= 1 && n <= 65535 && Math.floor(n) === n) return n;
    return DEFAULT_PORT;
  }

  function baseUrl() {
    return 'http://127.0.0.1:' + port;
  }

  function makeError(message, kind, httpStatus, data) {
    var err = new Error(String(message || '未知错误'));
    err.kind = kind || 'unknown';
    err.httpStatus = httpStatus || 0;
    err.data = data;
    return err;
  }

  function networkHint(err) {
    var detail = err && err.message ? String(err.message) : '';
    return '连不上桥接服务 ' + baseUrl() + '（' + (detail || '网络错误') + '）'
      + '——请确认 DSH 已启动、且「鲸鱼娘桥接」插件已加载';
  }

  function describeError(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    try { return JSON.stringify(err); } catch (e) { return String(err); }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function timeText(date) {
    try {
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
    } catch (e) { return ''; }
  }

  function fmtDuration(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n < 0) return '未知';
    if (n < 1000) return Math.round(n) + ' ms';
    return (n / 1000).toFixed(n < 10000 ? 1 : 0) + ' s';
  }

  function shorten(text, max) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  function pick(obj, keys) {
    if (obj === null || obj === undefined) return undefined;
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  }

  function jsonTitle(obj) {
    try {
      var s = JSON.stringify(obj);
      return s && s.length > 800 ? s.slice(0, 800) + '…' : s;
    } catch (e) { return ''; }
  }

  /* ------------------------------ DOM ------------------------------ */

  function el(tag, opts) {
    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.id) node.id = opts.id;
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
    if (opts.title) node.title = String(opts.title);
    if (opts.attrs) {
      for (var k in opts.attrs) {
        if (Object.prototype.hasOwnProperty.call(opts.attrs, k)) {
          try { node.setAttribute(k, String(opts.attrs[k])); } catch (e) { /* ignore */ }
        }
      }
    }
    if (opts.style) {
      for (var s in opts.style) {
        if (Object.prototype.hasOwnProperty.call(opts.style, s)) {
          try { node.style[s] = opts.style[s]; } catch (e) { /* ignore */ }
        }
      }
    }
    return node;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CARD_CSS;
    var head = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
    if (head) head.appendChild(style);
  }

  function setPill(pill, text, kind, title) {
    if (!pill) return;
    pill.textContent = text;
    pill.className = 'tag' + (kind ? ' ' + kind : '');
    if (title) {
      try { pill.title = title; } catch (e) { /* ignore */ }
    } else {
      try { pill.removeAttribute('title'); } catch (e) { /* ignore */ }
    }
  }

  function setMsg(node, text, kind) {
    if (!node) return;
    node.textContent = text || '';
    node.className = 'whale-bridge-dim' + (kind ? ' ' + kind : '');
  }

  function showBox(node, text) {
    if (!node) return;
    if (text) {
      node.textContent = text;
      node.style.display = '';
    } else {
      node.textContent = '';
      node.style.display = 'none';
    }
  }

  /* --------------------------- 网络（全部有 try/catch） --------------------------- */

  async function apiFetch(path, options, timeoutMs) {
    if (typeof fetch !== 'function') {
      throw makeError('当前浏览器不支持 fetch，无法连接桥接服务', 'nocors');
    }
    var opts = {};
    var src = options || {};
    for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) opts[k] = src[k]; }
    var headers = {};
    var srcHeaders = src.headers || {};
    for (var h in srcHeaders) { if (Object.prototype.hasOwnProperty.call(srcHeaders, h)) headers[h] = srcHeaders[h]; }
    if (!headers.Accept) headers.Accept = 'application/json';
    opts.headers = headers;

    var ctrl = null;
    var timer = null;
    if (typeof AbortController === 'function') {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
      timer = setTimeout(function () {
        try { ctrl.abort(); } catch (e) { /* ignore */ }
      }, timeoutMs || API_TIMEOUT_MS);
    }
    try {
      var res;
      try {
        res = await fetch(baseUrl() + path, opts);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw makeError('请求超时（' + fmtDuration(timeoutMs || API_TIMEOUT_MS) + '）：' + path, 'timeout');
        }
        throw makeError(networkHint(err), 'network');
      }
      var text = '';
      try { text = await res.text(); } catch (e) { text = ''; }
      var data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (e) { data = null; }
      }
      if (!res.ok) {
        var detail = '';
        if (data) {
          if (typeof data.error === 'string') detail = data.error;
          else if (data.error && typeof data.error.message === 'string') detail = data.error.message;
          else if (Array.isArray(data.errors) && data.errors.length) detail = data.errors.join('；');
        }
        if (!detail && text) detail = shorten(text, 160);
        throw makeError('HTTP ' + res.status + (detail ? '：' + detail : ''), 'http', res.status, data);
      }
      if (data === null) {
        throw makeError('桥接返回的内容不是合法 JSON（HTTP ' + res.status + '）', 'badjson', res.status, text);
      }
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* --------------------------- 状态渲染 --------------------------- */

  function renderBridgeOnline(health, err) {
    var v = health && health.version ? ' v' + health.version : '';
    var p = health && health.port ? ' · 端口 ' + health.port : '';
    setPill(refs.bridgePill, '桥接服务：在线' + v, 'ok', jsonTitle(health));
    refs.bridgePill.title = '桥接运行中' + p + (health && health.uptimeMs ? ' · 已运行 ' + fmtDuration(health.uptimeMs) : '');
    if (err) refs.bridgePill.title += '\n' + describeError(err);
  }

  function renderBridgeOffline(err) {
    setPill(refs.bridgePill, '桥接服务：离线', 'bad', err ? describeError(err) : '');
  }

  function renderWhale(whale) {
    var what = '鲸鱼娘';
    if (whale === undefined || whale === null) {
      setPill(refs.whalePill, what + '：未知', '', '状态接口没有返回鲸鱼娘信息');
      return;
    }
    if (typeof whale === 'boolean') {
      setPill(refs.whalePill, what + (whale ? '：已接入' : '：未接入'), whale ? 'ok' : 'warn');
      return;
    }
    if (typeof whale === 'string') {
      var okText = !/未接入|未安装|未配置|no|false|error/i.test(whale);
      setPill(refs.whalePill, what + '：' + shorten(whale, 40), okText ? 'ok' : 'warn', whale);
      return;
    }
    var configured = pick(whale, ['configured', 'adopted', 'installed', 'ok']);
    var running = pick(whale, ['running', 'up', 'webRunning']);
    var version = pick(whale, ['version']);
    var dir = pick(whale, ['dir', 'root', 'whaleDir', 'path']);
    var text;
    var kind;
    if (configured === true) { text = what + '：已接入'; kind = 'ok'; }
    else if (configured === false) { text = what + '：未接入'; kind = 'warn'; }
    else if (typeof configured === 'string') { text = what + '：' + shorten(configured, 30); kind = ''; }
    else { text = what + '：未知'; kind = ''; }
    if (running === true) text += ' · 网页运行中';
    else if (running === false && configured !== undefined) text += ' · 网页未启动';
    if (version) text += ' · v' + version;
    setPill(refs.whalePill, text, kind, jsonTitle({ configured: configured, running: running, version: version, dir: dir }));
  }

  function renderProfile(dsh) {
    var label = '任务 profile';
    if (dsh === undefined || dsh === null) {
      setPill(refs.profilePill, label + '：未知', '', '状态接口没有返回任务 profile 信息（首次跑任务时才会生成）');
      return;
    }
    if (typeof dsh === 'boolean') {
      setPill(refs.profilePill, label + (dsh ? '：就绪' : '：未就绪'), dsh ? 'ok' : 'warn');
      return;
    }
    if (typeof dsh === 'string') {
      setPill(refs.profilePill, label + '：' + shorten(dsh, 40), '', dsh);
      return;
    }
    var ready = pick(dsh, ['ok', 'ready', 'created', 'exists']);
    var name = pick(dsh, ['name', 'profile', 'profileName']);
    var dir = pick(dsh, ['profileDir', 'dir']);
    var err = pick(dsh, ['error', 'message']);
    var text = label + '：' + (name ? shorten(String(name), 24) : 'whale-agent');
    var kind;
    if (ready === true) { text += ' 就绪'; kind = 'ok'; }
    else if (ready === false) { text += ' 未就绪'; kind = 'warn'; }
    else { text += ' 未知'; kind = ''; }
    if (err) text += '（' + shorten(err, 50) + '）';
    var title = { ready: ready, name: name, dir: dir };
    if (err) title.error = err;
    setPill(refs.profilePill, text, kind, jsonTitle(title));
  }

  function hydrateForm(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (typeof settings.permission === 'string' && hasOption(refs.permission, settings.permission)) {
      refs.permission.value = settings.permission;
    }
    if (typeof settings.mode === 'string' && hasOption(refs.mode, settings.mode)) {
      refs.mode.value = settings.mode;
    }
    if (typeof settings.workspace === 'string' && settings.workspace) {
      refs.workspace.value = settings.workspace;
    }
    hydrated = true;
  }

  function hasOption(select, value) {
    if (!select || !select.options) return false;
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === value) return true;
    }
    return false;
  }

  async function refreshStatus() {
    if (disposed) return;
    if (!document.getElementById(CARD_ID)) { destroy(); return; }
    if (refreshing) return;
    refreshing = true;
    try {
      var healthPromise = apiFetch('/api/health', {}, API_TIMEOUT_MS).then(
        function (d) { return d; },
        function (e) { return { __error: e }; }
      );
      var statePromise = apiFetch('/api/state', {}, API_TIMEOUT_MS).then(
        function (d) { return d; },
        function (e) { return { __error: e }; }
      );
      var both = await Promise.all([healthPromise, statePromise]);
      if (disposed) return;

      var health = both[0];
      var state = both[1];
      var healthErr = health && health.__error ? health.__error : null;
      var stateErr = state && state.__error ? state.__error : null;

      var healthOk = !!health && !healthErr && health.ok !== false;
      var stateOk = !!state && !stateErr && state.ok !== false;

      if (healthOk) {
        renderBridgeOnline(health, null);
      } else if (stateOk) {
        // /api/state 能通也说明桥接在线
        renderBridgeOnline({ inferred: true }, stateErr);
      } else {
        renderBridgeOffline(healthErr || stateErr);
      }

      if (stateOk) {
        var st = (state.status && typeof state.status === 'object') ? state.status : {};
        renderWhale(st.whale);
        renderProfile(st.dsh);
        if (!hydrated && state.settings && typeof state.settings === 'object') hydrateForm(state.settings);
        showBox(refs.statusError, '');
        setMsg(refs.statusNote, '状态更新于 ' + timeText(new Date()));
      } else if (healthOk) {
        renderWhale(undefined);
        renderProfile(undefined);
        setMsg(refs.statusNote, '状态更新于 ' + timeText(new Date()) + '（/api/state 暂时不可用）');
        showBox(refs.statusError, stateErr ? '读取桥接状态失败：' + describeError(stateErr) : '');
      } else {
        renderWhale(undefined);
        renderProfile(undefined);
        setMsg(refs.statusNote, '等待桥接服务…');
        showBox(refs.statusError,
          '连不上桥接服务 ' + baseUrl() + '。请确认 DSH 已启动、且「鲸鱼娘桥接」插件已加载；'
          + '本卡片每 ' + Math.round(REFRESH_MS / 1000) + ' 秒会自动重试。'
          + (healthErr ? '\n' + describeError(healthErr) : ''));
      }
    } finally {
      refreshing = false;
    }
  }

  function refreshStatusSafe() {
    Promise.resolve().then(refreshStatus).catch(function (err) {
      if (disposed) return;
      try {
        renderBridgeOffline(err);
        showBox(refs.statusError, '刷新桥接状态失败：' + describeError(err));
      } catch (e) { /* 卡片已被移除之类的，忽略 */ }
    });
  }

  /* --------------------------- 交互 --------------------------- */

  function updateBusy() {
    if (!refs.saveBtn || !refs.testBtn) return;
    refs.saveBtn.disabled = saving;
    refs.testBtn.disabled = taskRunning;
  }

  async function onSave() {
    if (saving || disposed) return;
    var body = {
      workspace: String(refs.workspace.value || '').trim(),
      permission: refs.permission.value,
      mode: refs.mode.value
    };
    if (!body.workspace) {
      setMsg(refs.saveMsg, '工作区不能为空', 'bad');
      try { refs.workspace.focus(); } catch (e) { /* ignore */ }
      return;
    }
    if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(body.workspace)) {
      setMsg(refs.saveMsg, '工作区要填绝对路径，例如 D:\\dsh_work', 'bad');
      return;
    }
    saving = true;
    updateBusy();
    setMsg(refs.saveMsg, '保存中…', '');
    try {
      var data = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, 15000);
      if (!data || data.ok === false) {
        var errors = data && (data.errors || (data.error ? [String(data.error)] : []));
        throw makeError(errors && errors.length ? errors.join('；') : '桥接拒绝了这次保存', 'reject', 0, data);
      }
      if (data.settings && typeof data.settings === 'object') hydrateForm(data.settings);
      setMsg(refs.saveMsg, '已保存 ' + timeText(new Date()), 'ok');
      await refreshStatus().catch(function () { /* 状态刷新失败不影响保存结果 */ });
    } catch (err) {
      setMsg(refs.saveMsg, '保存失败：' + describeError(err), 'bad');
    } finally {
      saving = false;
      updateBusy();
    }
  }

  async function onTestTask() {
    if (taskRunning || disposed) return;
    var prompt = String(refs.prompt.value || '').trim();
    if (!prompt) {
      showBox(refs.taskError, '先在上面输入要让 DSH 做的事，再点「测试任务」。');
      try { refs.prompt.focus(); } catch (e) { /* ignore */ }
      return;
    }
    taskRunning = true;
    var startedAt = Date.now();
    updateBusy();
    showBox(refs.taskError, '');
    refs.result.textContent = '运行中…（DSH agent 正在执行，可能需要几十秒）';
    setMsg(refs.elapsed, '运行中… 0.0s');
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    elapsedTimer = setInterval(function () {
      if (disposed || !taskRunning) return;
      setMsg(refs.elapsed, '运行中… ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
    }, 250);
    try {
      var data = await apiFetch('/api/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt })
      }, TASK_TIMEOUT_MS);
      var ms = data && typeof data.durationMs === 'number' ? data.durationMs : (Date.now() - startedAt);
      var tools = data && typeof data.toolCalls === 'number' ? data.toolCalls : null;
      var tail = ' · 用时 ' + fmtDuration(ms) + (tools !== null ? ' · 工具调用 ' + tools + ' 次' : '');
      var text = data && typeof data.text === 'string' && data.text ? data.text : '（DSH 没有返回文本）';
      refs.result.textContent = text;
      var failed = !!(data && data.error);
      if (failed) {
        setMsg(refs.elapsed, '失败' + tail);
        showBox(refs.taskError, '任务失败：' + String(data.error));
      } else {
        setMsg(refs.elapsed, '完成' + tail);
      }
    } catch (err) {
      refs.result.textContent = '（没有拿到结果）';
      setMsg(refs.elapsed, '失败 · 用时 ' + fmtDuration(Date.now() - startedAt));
      showBox(refs.taskError, '测试任务失败：' + describeError(err));
    } finally {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      taskRunning = false;
      updateBusy();
    }
  }

  /* --------------------------- 卡片构建 / 生命周期 --------------------------- */

  function buildCard() {
    ensureStyle();
    var main = null;
    try { main = document.querySelector('main'); } catch (e) { main = null; }
    if (!main) main = document.body;
    if (!main) return null;

    var root = el('section', {
      id: CARD_ID,
      className: 'card',
      attrs: { 'data-bridge-port': String(port), 'aria-label': 'DSH 桥接设置' }
    });

    root.appendChild(el('h2', { text: 'DSH 桥接 · 权限与模式' }));

    var statusRow = el('div', { className: 'whale-bridge-row' });
    refs.bridgePill = el('span', { className: 'tag', text: '桥接服务：检测中…' });
    refs.whalePill = el('span', { className: 'tag', text: '鲸鱼娘：检测中…' });
    refs.profilePill = el('span', { className: 'tag', text: '任务 profile：检测中…' });
    refs.statusNote = el('span', { className: 'whale-bridge-dim' });
    statusRow.appendChild(refs.bridgePill);
    statusRow.appendChild(refs.whalePill);
    statusRow.appendChild(refs.profilePill);
    statusRow.appendChild(refs.statusNote);
    root.appendChild(statusRow);

    refs.statusError = el('div', { className: 'whale-bridge-error', attrs: { role: 'alert' } });
    refs.statusError.style.display = 'none';
    root.appendChild(refs.statusError);

    root.appendChild(el('p', {
      className: 'whale-bridge-hint',
      text: '这里改的是 DSH 桥接的设置（保存在 DSH 侧），不是鲸鱼娘自己的设置。聊天里需要动手的任务会交给 DSH agent 执行。'
    }));

    var permRow = el('div', { className: 'whale-bridge-row' });
    var permLabel = el('label', { text: 'DSH 权限' });
    refs.permission = el('select', { attrs: { 'data-whale-setting': 'permission', 'aria-label': 'DSH 权限' } });
    PERMISSIONS.forEach(function (item) {
      refs.permission.appendChild(el('option', { text: item.label, attrs: { value: item.value } }));
    });
    permLabel.appendChild(refs.permission);
    permRow.appendChild(permLabel);

    var modeLabel = el('label', { text: '模式' });
    refs.mode = el('select', { attrs: { 'data-whale-setting': 'mode', 'aria-label': '模式' } });
    MODES.forEach(function (item) {
      refs.mode.appendChild(el('option', { text: item.label, attrs: { value: item.value } }));
    });
    modeLabel.appendChild(refs.mode);
    permRow.appendChild(modeLabel);
    root.appendChild(permRow);

    var wsRow = el('div', { className: 'whale-bridge-row' });
    var wsLabel = el('label', { text: '工作区' });
    refs.workspace = el('input', {
      attrs: {
        type: 'text',
        'data-whale-setting': 'workspace',
        placeholder: '例如 D:\\dsh_work',
        spellcheck: 'false',
        autocomplete: 'off'
      }
    });
    wsLabel.appendChild(refs.workspace);
    wsRow.appendChild(wsLabel);
    wsRow.appendChild(el('span', { className: 'whale-bridge-dim', text: '填已存在的绝对路径；DSH 任务会在这里跑' }));
    root.appendChild(wsRow);

    var saveRow = el('div', { className: 'whale-bridge-row' });
    refs.saveBtn = el('button', { className: 'primary', text: '保存设置', attrs: { type: 'button' } });
    refs.saveMsg = el('span', { className: 'whale-bridge-dim', attrs: { role: 'status' } });
    refs.saveBtn.addEventListener('click', function () { onSave(); });
    saveRow.appendChild(refs.saveBtn);
    saveRow.appendChild(refs.saveMsg);
    root.appendChild(saveRow);

    root.appendChild(el('h3', { className: 'whale-bridge-subtitle', text: '测试任务' }));
    refs.prompt = el('textarea', {
      attrs: {
        rows: '2',
        placeholder: '输入一句要交给 DSH 的任务，例如：回答 1+1 / 看看 D:\\dsh_work 下有哪些文件'
      }
    });
    root.appendChild(refs.prompt);

    var testRow = el('div', { className: 'whale-bridge-row' });
    refs.testBtn = el('button', { text: '测试任务', attrs: { type: 'button' } });
    refs.elapsed = el('span', { className: 'whale-bridge-dim', attrs: { role: 'status' } });
    refs.testBtn.addEventListener('click', function () { onTestTask(); });
    testRow.appendChild(refs.testBtn);
    testRow.appendChild(refs.elapsed);
    root.appendChild(testRow);

    refs.result = el('pre', {
      className: 'whale-bridge-out',
      text: '（还没有测试结果）',
      attrs: { role: 'log', 'aria-live': 'polite' }
    });
    root.appendChild(refs.result);

    refs.taskError = el('div', { className: 'whale-bridge-error', attrs: { role: 'alert' } });
    refs.taskError.style.display = 'none';
    root.appendChild(refs.taskError);

    refs.footer = el('p', { className: 'whale-bridge-foot' });
    refs.footer.textContent = '桥接地址：' + baseUrl()
      + ' · 端口可用 window.DSH_WHALE_BRIDGE_PORT 覆盖（默认 8789） · 每 '
      + Math.round(REFRESH_MS / 1000) + ' 秒自动刷新状态';
    root.appendChild(refs.footer);

    main.appendChild(root);
    return root;
  }

  function removePreviousCard() {
    try {
      var prev = window[GLOBAL_KEY];
      if (prev && typeof prev.destroy === 'function') prev.destroy();
    } catch (e) { /* ignore */ }
    try {
      var old = document.getElementById(CARD_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);
    } catch (e) { /* ignore */ }
    try {
      var oldStyle = document.getElementById(STYLE_ID);
      if (oldStyle && oldStyle.parentNode) oldStyle.parentNode.removeChild(oldStyle);
    } catch (e) { /* ignore */ }
  }

  function destroy() {
    if (disposed) return;
    disposed = true;
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    try { window.removeEventListener('beforeunload', destroy); } catch (e) { /* ignore */ }
    try {
      var node = document.getElementById(CARD_ID);
      if (node && node.parentNode) node.parentNode.removeChild(node);
    } catch (e) { /* ignore */ }
    try {
      if (window[GLOBAL_KEY] === api) window[GLOBAL_KEY] = undefined;
    } catch (e) { /* ignore */ }
  }

  function start() {
    if (disposed) return;
    removePreviousCard();
    try {
      card = buildCard();
    } catch (err) {
      // 页面结构异常时不要影响调试台本身
      try { console.warn('[dsh-whale-bridge] 注入卡片失败：', err); } catch (e) { /* ignore */ }
      card = null;
    }
    if (!card) return;
    try { window[GLOBAL_KEY] = api; } catch (e) { /* ignore */ }
    try { window.addEventListener('beforeunload', destroy); } catch (e) { /* ignore */ }
    updateBusy();
    refreshStatusSafe();
    refreshTimer = setInterval(refreshStatusSafe, REFRESH_MS);
    try { console.info('[dsh-whale-bridge] 卡片已注入，桥接地址 ' + baseUrl()); } catch (e) { /* ignore */ }
  }

  /* --------------------------- 启动 --------------------------- */

  var port = resolvePort();
  var disposed = false;
  var card = null;
  var refreshTimer = null;
  var elapsedTimer = null;
  var refreshing = false;
  var saving = false;
  var taskRunning = false;
  var hydrated = false;
  var refs = {};
  var api = {
    version: VERSION,
    port: port,
    destroy: destroy,
    refresh: refreshStatusSafe,
    refreshStatus: refreshStatus
  };

  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(); }, { once: true });
  } else {
    start();
  }
})();
