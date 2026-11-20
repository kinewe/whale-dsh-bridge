# CONTRACT —— dsh-whale-bridge 桥接契约（v0.1）

> **历史开发说明：本契约以 `brain=upstream` 旧模式为主要示例。**
> 当前参考部署使用 `brain=dsh`：聊天回复也由 DSH 会话生成。
> 以仓库根目录 `README.md` 和 `docs/tutorial.md` 为准。

> 本文件是「鲸鱼娘壳 × DeepSeek Harness（DSH）」集成项目中所有实现者共同遵守的契约。
> 改动契约必须先改本文件；实现与验证都以本文件为准。

## 0. 目标与非目标

**目标**

1. 鲸鱼娘（whale-girl，`C:\whale-girl`，当前包版本 3.60）继续做它的「聊天壳」：人设、微信/网页聊天、记忆、表情包等。
2. 当聊天需要「实际干活」（改文件、跑命令、多步任务、查资料综合、写/改插件等）时，把任务交给 **DSH agent** 去做，结果再回到聊天里。
3. 在 DSH Web 左侧栏新增一个管理入口「鲸鱼娘桥接」，提供：状态、DSH 权限/模式/工作区选项、任务测试台、鲸鱼娘接入/还原。
4. 鲸鱼娘 `/debug` 调试页也出现同一个选项卡片（权限 / 模式 / 工作区 / 测试）。
5. **不在这台电脑上做真实微信调试**：不启动 `启动微信桥接.bat`、不运行 `examples/wechatauto_bridge.py`、不操作微信窗口。

**非目标**

- 不改鲸鱼娘核心逻辑（`server.js`、`src/**`、`web/assets/**` 一律不改）。
- 不改 DSH 安装目录（`F:\DeepSeek Harness\**` 不改，except 无）。
- 不做微信侧联调；网页聊天链路即可验证。

## 1. 版本隔离（硬性）

两侧都可能升级，必须能各自升级而不拖垮对方：

| 部分 | 位置 | 升级影响 |
|---|---|---|
| DSH 侧插件 | `<插件目录>`（链接进 DSH profile） | DSH 升级后可能需要重建任务 profile；插件本身不写死 DSH 版本 |
| 鲸鱼娘侧适配 | 只写两处「用户数据/覆盖层」：`config.json`（用户数据，升级不覆盖）与 `web/debug.html` 中一段带标记的 `<script>`（升级会覆盖 → 用安装脚本幂等重打） | 鲸鱼娘升级后重跑 `install-whale-side.ps1` 即可 |
| 任务 profile | `$DSH_HOME/profiles/whale-agent`（由 headless 模板生成，属本桥接所有） | DSH 升级后可一键重建（面板按钮 / 脚本） |

桥接插件**只依赖**：
- DSH 已文档化的 CLI 契约：`dsh --profile <name> --json "<task>"`（见 `dsh-headless` README）。
- 鲸鱼娘的 `config.json` / OpenAI 兼容 provider 配置（`provider: custom`）。
- 两边都不 import 对方的源码。

## 2. DSH 侧插件（宿主）

包名 `dsh-whale-bridge`，目录 `<插件目录>`，纯 Node 内置模块（**不 import 任何 @deepseek-ai/* 包**，除 client 端用页面自带的 `react`）。

插件行（`cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-whale-bridge
      name: dsh-whale-bridge
      config:
        port: 8789
```

## 3. 桥接 HTTP API（宿主监听 `127.0.0.1:<port>`，默认 8789）

所有响应 JSON；CORS：`Access-Control-Allow-Origin: *`，允许 `content-type`、`OPTIONS` 预检。
默认只监听 127.0.0.1；任何修改设置的写接口都要带 `X-Bridge-Token` 吗？——**v0.1：仅回环监听即可，不要求 token**（面板与调试页同机访问）。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/health` | – | `{ok:true, name, version, port, uptimeMs}` |
| GET | `/api/state` | – | `{ok, settings, status:{whale, dsh, bridge}, tasks:[...最近20条]}` |
| PUT | `/api/settings` | 部分 settings 对象 | `{ok, settings}` |
| POST | `/api/task` | `{prompt, workspace?, permission?, mode?, sessionId?, timeoutMs?}` | `{ok, text, sessionId, durationMs, toolCalls, error?}` |
| GET | `/api/tasks` | – | `{ok, tasks:[...]}` |
| POST | `/api/client-report` | 浏览器侧自报（`event` 等） | `{ok:true}`（同时写 `bridge.log`，供无浏览器控制权时验证插件已在页面加载） |
| GET | `/api/client-report` | – | `{ok, reports:[...]}` |
| POST | `/api/dsh/rebuild-profile` | – | `{ok, profileDir, created}` |
| GET | `/api/whale/status` | – | `{ok, dir, configured, running, url, version}` |
| POST | `/api/whale/start` | – | 确保鲸鱼娘在跑：已运行/已有进程在启动时只等待，**不重复拉起**；都没有才用 `runtime\node.exe server.js --no-browser` 启动 → `{ok, running, started, alreadyRunning?, url, debugUrl}` |
| POST | `/api/whale/stop` | – | 停止鲸鱼娘网页服务（只杀该服务进程树，不动 DSH/微信桥接）→ `{ok, stoppedPid?, startedBy?, alreadyStopped?}` |
| POST | `/api/whale/open` | `{target:"web"\|"debug"}` | 先确保在跑，再由宿主用系统浏览器打开目标页（不受浏览器弹窗拦截影响）→ `{ok, url, started, running}` |
| POST | `/api/whale/adopt` | `{}` | `{ok, files:[...], backupDir, upstream, debugCard, fileChannelUi, warning?}`；**会顺带向 `web/debug.html` 注入调试卡、向 `web/index.html` 注入文件通道脚本（都带标记块）** |
| POST | `/api/whale/revert` | `{}` | `{ok, restored:[...], debugCardRemoved, fileChannelUiRemoved}`；同时移除两处标记块 |
| GET | `/static/debug-bridge.js` | – | JS（鲸鱼娘 /debug 页面卡片） |
| GET | `/static/web-file-channel.js` | – | JS（鲸鱼娘聊天页文件通道：📎 上传 / 链接可点 / SSE 兜底） |
| POST | `/api/upload` | `{name, data(base64)}` | `{ok, file:{name, originalName, path, size, ext, hint}}`；落到 `<workspace>\.whale-bridge\inbox\` |
| GET | `/api/files` | – | 文件通道状态：`{enabled, autoOutbox, maxFileMB, linkTtlHours, workspace, inbox, outbox, registered:[...]}` |
| GET | `/files/<token>/<name>` | – | token 化文件下载（`Content-Disposition: attachment`；token 仅内存登记、默认 24h 过期） |
| POST | `/v1/chat/completions` | OpenAI 兼容（鲸鱼娘 provider=custom） | 非流式 JSON 或 `text/event-stream` |

### settings（持久化在 `$DSH_HOME/whale-bridge/settings.json`）

```json
{
  "workspace": "D:\\dsh_work",
  "permission": "workspace-write",     // read-only | workspace-write | danger-full-access
  "mode": "standard",                  // standard | creator
  "whaleDir": "F:\\鲸鱼娘\\whale-girl",
  "port": 8789,
  "model": "",                          // 空 = 用 whale-agent profile 默认(deepseek-account)
  "defaultSessionId": "",               // 空 = 每次新会话
  "upstream": { "baseUrl": "", "apiKey": "", "model": "" },  // adopt 时从鲸鱼娘解析后写入
  "maxSteps": 4,
  "timeoutMs": 600000,                  // 单个 DSH 任务上限 = 10 分钟（聊天链路硬上限也是 600000）
  "statusNarration": true,              // 状态播报台词由模型生成（false = 只用固定台词）
  "statusIntervalSec": 90,              // 进度播报间隔秒（30–600）
  "continuity": "auto",                 // 相似任务自动续接：auto | off
  "files": {                            // 文件通道（v0.2.0）
    "enabled": true,                    // 总开关（关掉后 /api/upload 与 MEDIA 收集停用）
    "autoOutbox": true,                 // 任务期间 outbox 新增文件自动登记
    "maxFileMB": 20,                    // 单文件上限（1–200）
    "linkTtlHours": 24                  // 下载 token 有效期（1–720 小时）
  }
}
```

- `permission` → 子进程环境变量 `DSH_PERMISSION_MODE`，同时决定 headless 审批策略（read-only/workdir 可写/full access）。
- `mode` → `standard`（headless 模板原样）或 `creator`（在 whale-agent profile patch 里启用 `tool-plugin-manager`，让任务能改 DSH 插件）。
- `workspace` → 子进程 cwd，也作为 DSH 会话 cwd（必须是存在的绝对路径）。
- `defaultSessionId` → 传给 `--session-id`；需要「同一聊天持续上下文」时用（DSH 侧要求同 cwd、同 preset）。

### DSH 任务执行器（宿主内部）

- 启动：`DeepSeek Harness.exe`（`process.execPath`）+ `ELECTRON_RUN_AS_NODE=1`，执行
  `<install>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`，
  参数 `--profile whale-agent --json "<prompt>"`，`cwd=workspace`，env 加 `DSH_PERMISSION_MODE`、`DSH_PROFILE`、`DSH_PROFILE_DIR`。
  找不到时回退 PATH 上的 `dsh`/`dsh.cmd`。
- 解析 stdout 的按行 JSON 事件：`session`（sessionId）、`text`、`tool_call`、`tool_result`、`final`（最终文本）、`error`。
- 默认超时 600000ms；超时杀进程树；并发上限 2；结果写入内存 ring buffer（最近 20 条，含耗时、工具数、错误）。
- 任务 profile `whale-agent`：启动时若不存在则用 CLI
  `--profile whale-agent --from-default-profile headless --dump-config` 生成；
  然后写它的 `cordis.patch.yml`（本桥接拥有该 profile）：

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
# mode=creator 时追加：
- id: tool-plugin-manager
  disabled: false
```

## 4. OpenAI 兼容代理（`/v1/chat/completions`）

鲸鱼娘把 provider 设为 `custom`、`baseUrl = http://127.0.0.1:<port>/v1`、`model = upstream.model`。
代理内部：

1. 接收 `{model, messages, stream, temperature, max_tokens, ...}`。
2. 取 settings.upstream（baseUrl/apiKey/model）作为上游，附 `tools: [dsh_task]`。
3. 循环最多 `maxSteps` 次：上游返回 `tool_calls` → 逐个执行 DSH 任务 → 以 `role:"tool"` 回填 → 继续；无 tool_calls 则得最终文本。
   - **状态播报**（仅 stream=true）：任务开始时立即流出一句确认；任务进行中每 `statusIntervalSec` 秒（默认 90，范围 30–600）流出一句进度；上游模型思考超过 20 秒且尚无播报时先补一句。播报台词由上游模型按人设生成（轻量无工具调用，8 秒超时），失败回退固定台词；已播报的句子会作为提示放入工具结果，最终回答自然衔接。播报与最终回答同属 assistant 文本。`statusNarration: false` 时只用固定台词。
   - **最大工作时间**：聊天触发的 DSH 任务上限 600000ms；对应地把鲸鱼娘 `config.deepseek.timeoutMs` 放宽到 660000ms（adopt/安装脚本负责），避免请求先超时。
   - **断开即停**：客户端断开时通过 AbortSignal 终止 DSH 子进程。
4. 最终文本：`stream=false` 返回标准 chat.completion；`stream=true` 按 OpenAI SSE（`data: {...chunk...}` + `data: [DONE]`）回放（可分 1~N 个 delta）。
5. 上游不可用 / 未配置 key：返回 200 + 错误文本？——**必须返回可读的错误**（非流式 JSON `{error:{message}}`；流式则先发一个 delta 再 DONE），鲸鱼娘会展示。

`dsh_task` 工具定义（含可选的会话续接参数）：

```json
{
  "name": "dsh_task",
  "description": "把需要实际执行的任务交给 DeepSeek Harness (DSH) 的 agent 在工作区完成：读写文件、跑命令、查代码、多步处理等。日常闲聊不要调用。",
  "parameters": {
    "type": "object",
    "properties": {
      "instruction": {"type":"string","description":"交给 DSH 的完整、自足的任务描述"},
      "workspace": {"type":"string","description":"可选，覆盖默认工作区绝对路径"},
      "session_id": {"type":"string","description":"可选：继续某个已有 DSH 会话（见系统提示里的最近会话列表）；只有同一件事的后续才传"},
      "permission": {"type":"string","enum":["read-only","workspace-write","danger-full-access"]},
      "mode": {"type":"string","enum":["standard","creator"]}
    },
    "required": ["instruction"]
  }
}
```

**会话连续性（`continuity: auto`，默认）**：代理会把 `runner.recentSessions()` 的最近会话（id/时间/工作区/摘要）注入为一条 system 提示，要求模型在"同一件事的后续"时传 `session_id`、无关时开新会话；同一轮内多次调用则固定沿用该轮首个会话。配置了 `defaultSessionId` 时，任务默认用它（优先级高于模型选择）。客户端断开时用 AbortSignal 终止任务。

消息里注入一段 system 提示（追加在鲸鱼娘人设之后）：说明「需要动手时调用 dsh_task；闲聊不要调用；把 DSH 结果用人设口吻转述，不暴露内部路径/命令细节（可概括）」。

### 4.1 文件通道（v0.2.0，参考本机 Hermes media 设计简化）

- **出站**：DSH 任务最终文本里的 `^[ \t]*MEDIA:[ \t]*(.+)$` 行（支持引号/反引号/`**` 包裹、多行、尾部「（大小）」注记，以最后一个白名单扩展名截断）→ 校验后剥离标记并登记下载 token；`files.autoOutbox` 开启时，还会对比任务开始前的 outbox 快照，收集任务期间新增/变更的文件（`<workspace>\.whale-bridge\outbox\`，最多 10 个/任务）。最终回复末尾统一追加 `📎 <文件名>（<大小>）\n<url>`（若模型已原样带出链接则不重复）。URL 固定为 `http://127.0.0.1:<port>/files/<32hex token>/file_<token前8位><ext>`（ASCII 短名，避免鲸鱼娘对回复做 emoji 剥离/标点替换/气泡截断时破坏链接）。
- **入站**：`POST /api/upload`（`{name, data:base64}`）→ 文件名 basename + 控制符清洗 + 时间戳前缀 → `<workspace>\.whale-bridge\inbox\`；返回 `hint = "[Shared attachment] file: <绝对路径>"`。代理收到含该标记的用户消息时，把「用户附件（绝对路径）」作为 system 提示插入（去重、校验存在性/类型/大小/敏感路径），提示模型把路径写进 `dsh_task`。
- **校验/安全**：扩展名白名单（`lib/file-channel.js: ALLOWED_EXTENSIONS`）；单文件 ≤ `files.maxFileMB`（默认 20MB，硬上限 200MB）；拒绝 `dshHome()`、`.ssh/.aws/.gnupg` 等目录与 `.env`/`credentials`/私钥类文件名；outbox 自动收集只收 outbox 目录内文件；`MEDIA:` 显式路径允许 outbox 之外，但必须存在、普通文件、过类型/大小/敏感路径校验。下载只接受已登记 token，URL 里的 `<name>` 仅用于 `Content-Disposition`，不参与查找。
- **配置**：`settings.files = { enabled, autoOutbox, maxFileMB, linkTtlHours }`；`PUT /api/settings` 局部合并且逐项夹取范围。
- **注入脚本**：`whale-side/web-file-channel.js` 由 `web/index.html` 末尾带标记 `<script>` 加载（标记 `<!-- whale-dsh-bridge-files:begin/end -->`）：原生 `fetch` 包装给 `/api/chat` 的 `text` 追加附件行（界面原文不变，失败会恢复未发送的附件）；`#chat .bubble-text` 上的 MutationObserver 把下载 URL 渲染成 `<a target="_blank" rel="noopener">` 并把历史消息里的附件标记显示为「📎 附件：名字」；从原始 SSE 里兜底提取下载链接（防鲸鱼娘服务端截断/切气泡）；输入框为空只选文件时自动补一句再发送。

### 4.2 DSH 原生聊天（`brain=dsh`，2026-11-04）

- **数据流**：鲸鱼娘 `runtime.llm.complete/stream` → 本插件 `/v1/chat/completions`（带 `x-whale-chat` 头）→ 不再调上游模型，直接 `DshTaskRunner.runTask` 到该聊天的 DSH 会话 → 返回/流式输出 DSH 文本。
- **配置**：`settings.brain = 'upstream' | 'dsh'`（默认 upstream）。`settings.chatSessions` 持久化 `chatKey → {sessionId, updatedAt, title}`（最多 120 条）；聊天 key 由鲸鱼娘 `src/bot.js:chatKeyOf(msg)` = `platform|chatType|chatId` 经 `src/llm.js` 头传入；缺失时按「system 头 300 字 + 首条 user 消息」哈希兜底。
- **命令**：最新 user 文本匹配 `新会话|新对话|换个话题|重新开始|清空上下文|重置会话|reset|newchat` → 删除该聊天映射并返回固定台词（0s），下一条自动开新 DSH 会话。群聊时鲸鱼娘把当前消息包在 `【当前需要回应的消息】{json}` 里，插件会先解出 `内容`/`发言人` 再做命令判断与 DSH prompt（历史不重复灌入）。
- **附件**：最新用户消息（群聊取 JSON 里的 `内容`）中 `[Shared attachment] file: <path>` 解析为附件列表写进 DSH prompt；路径必须通过文件通道允许根目录校验。DSH 产物按现有 outbox 文件通道登记并附下载链接。
- **API**：`GET/PUT /api/brain`、`POST /api/brain/reset`（`{key?}`）、`POST /api/brain/chat`（面板原生聊天测试，`{text, chatKey?}`）、`POST /api/brain/sync`（`{direction:'to-whale'|'from-whale'}`）；调试台代理 `GET /api/whale/console`、`POST /api/whale/console/config`、`POST /api/whale/console/prompt`、`POST /api/whale/console/memory/reset`（内部 HTTP 调鲸鱼娘 8787，返回前递归脱敏 apiKey/token/secret）。
- **自环保护**：`from-whale` 检测到鲸鱼娘 `llm.baseUrl` 指向本插件时直接报错（没有「真实上游」可抄）；`PUT /api/settings` 与 `callUpstream` 运行期都会拒绝把 `upstream.baseUrl` 指回桥接自身（曾因反向同步出现 `/v1` 自递归 → 1800+ 消息后请求体过大）。
- **可信边界（DSH 工具权限）**：`chatTrust(settings, headers)` 决定是否交给 DSH。鲸鱼娘补丁带 `x-whale-trust` 头（主人/本地网页 `1`，其他人 `0`）：`1` → DSH（含**群里的主人**），`0` → `plainChatCompletion`（上游模型、`noTools`，不挂 dsh_task）。老版本鲸鱼娘没有该头时回退：`platform=web` 可信，微信只认 `persona.master.wxids`。附件路径只认文件通道允许根目录，伪造 `[Shared attachment]` 无效。
- **面板**：`client.js` 的「DSH 原生（新鲸鱼娘）」卡片与「鲸鱼娘调试台（网页 /debug 搬入）」卡片（大脑切换、会话映射列表/重置、原生聊天测试、映射一致性、prompt 预览、记忆清空、功能开关列表、双向同步按钮、打开 /debug 链接）。
- **验证**：网页 `/api/chat` SSE 7s 回 DSH 文本；微信桥同款 `POST /webhook/wechat` 两条消息同 session（记「墨绿色」→ 追问答「墨绿色」）；「新会话」后新 session 不记得旧内容；`/api/brain/chat` 6s 回包；`/api/brain/sync` 后鲸鱼娘 `provider=custom, llm.baseUrl=http://127.0.0.1:8789/v1`。

## 5. 管理面板（DSH Web 客户端）

文件 `client.js`（纯浏览器 bundle，格式见下方），`package.json` 声明：

```json
"dsh": { "client": { "platform": "web", "immediately": true,
  "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-layout"] } }
```

注册（参考 `@deepseek-ai/dsh-client-ui-plugin-manager` 的实际写法）：

```js
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist", id: PANEL_ID, order: 12,
  label: () => t("panel"), locale: NS,
}, WhaleBridgeIcon));

ctx.slots.inject("main", () => ctx.slots.register({
  name: "main", key: PANEL_ID, locale: NS,
}, WhaleBridgePanel));
```

`apply(ctx)` 里先 `ctx.locale.register(NS, {zh, en})`，`inject = ["slots","locale","layout"]`；
面板内容：状态卡（桥接/鲸鱼娘/DSH profile）、设置（工作区 / 权限 / 模式 / 默认会话）、
按钮（保存、测试任务、接入鲸鱼娘、还原、重建任务 profile、打开鲸鱼娘网页 `/` 与 `/debug`）、
测试台（prompt → 结果文本）、最近任务列表。所有网络请求打 `http://127.0.0.1:8789`，
失败时展示可复制的错误；不要 import 任何 `@deepseek-ai/*` 客户端包（除 `require("react")`）。

## 6. 鲸鱼娘侧适配（非侵入）

目录 `whale-side/`：

| 文件 | 作用 |
|---|---|
| `install-whale-side.ps1` | 幂等：备份 → 写/合并 `config.json`（`provider=custom`；**`llm={baseUrl, model, apiKey}` 是关键**——鲸鱼娘 `resolveRuntime()` 在 custom 下读的是 `cfg.llm`，不是 `cfg.custom`；`custom` 段只用于展示）→ 创建/合并 `data/settings.json`（网页设置优先级最高，必须同步为 custom）→ 在 `web/debug.html` 的 `</main>` 前插入标记块 `<script src="http://127.0.0.1:8789/static/debug-bridge.js" defer></script>`（标记 `<!-- whale-dsh-bridge:begin/end -->`） |
| `revert-whale-side.ps1` | 还原 config.json / settings.json 备份（首次安装前不存在 settings.json 则删除）、删除 debug.html 标记块 |
| `debug-bridge.js` | 注入 `/debug` 的卡片：读 `http://127.0.0.1:8789/api/state`；提供权限 / 模式 / 工作区选择 + 保存 + 测试任务；样式复用页面 CSS 变量（`--card/--line/--text/--dim/--cyan` 等），用 `.card` 类；纯 DOM，无依赖 |
| `web-file-channel.js` | 注入网页聊天页的文件通道脚本：📎 上传（base64 → `/api/upload`）、`[Shared attachment]` 自动随消息发送、下载链接渲染成可点击、SSE 兜底补链接、历史消息附件标记美化 |
| （面板「接入鲸鱼娘」额外做） | 除上述 config/settings/debug 卡片外，**还会向 `web/index.html` 末尾注入带标记的文件通道 `<script>`**（`<!-- whale-dsh-bridge-files:begin/end -->`）；`POST /api/whale/revert` 会一并移除 |

### 6.1 微信私聊/群聊文件通道（v0.2.1，主人明确授权；改鲸鱼娘 `examples/wechatauto_bridge.py`）

微信侧文件收发由**鲸鱼娘自己的 Python 微信桥接**完成（`examples/wechatauto_bridge.py`；不属于本插件，默认不启用，本插件自动测试不碰微信）：

- 入站：`type` 为 `文件/链接/卡片` 且 XML 带 `<fileext>/<totallen>` 的文件消息 → `MediaDownloader.download_file(username, local_id, shard=…)`，失败再按 `<title>` 在 `<账号目录>\msg\file` 缓存兜底复制到 `data\wechat-files\`；图片消息把 `describe_image` 落盘路径一并带上。转给鲸鲸的文本末尾追加 `[Shared attachment] file: <绝对路径>`；用户自己打字的 `[Shared attachment]` 在最终 payload 前被中和成 `[Shared attachment-blocked]`（防陌生人注入读任意本机文件）。入站文件先过「过期/自己发的」闸再下载，超过 `wechat.fileMaxMB`（默认 20MB）不交给 DSH。
- 出站：回复文本里匹配 `http://127.0.0.1:<port>/files/<32hex>/…` → `fetch_media_url` 取到 `data\wechat-outbox\`（20MB 上限）；并兜底扫描 DSH 工作区 `outbox` 里本次回复期间新产出的文件（长回复里的链接可能被服务端截断）。文字气泡发完后逐个发成微信文件消息：打开目标会话 → 输入框聚焦 → CF_HDROP 剪贴板 → `uiautomation.SendKeys('{Ctrl}v')` → 校验 U+FFFC 附件占位符 → `SendKeys('{Enter}')` → 回读数据库确认 `文件/链接/卡片` 新消息。注意微信 4.x 上 `SendInput`（`gui._input.key`）无效、必须用 `uiautomation.SendKeys`；确认不了就清草稿、不重试，回退发下载链接。
- 配置：`config.json` 新增 `wechat.fileChannelIn` / `wechat.fileChannelOut` / `wechat.fileMaxMB`；改动前备份 `examples\wechatauto_bridge.py`（本机备份 `<DSH工作区>\scratch\wechat-bridge-original\`），回滚=还原该 .py + 删三个配置键 + 重启桥接。
- 自测钩子（默认关，仅用于无第二微信账号时验证）：`WHALE_WECHAT_TEST_MODE=1`、`WHALE_WECHAT_TEST_CHAT`、`WHALE_WECHAT_TEST_INJECT=file,text`、`WHALE_WECHAT_TEST_SEND_URL`。

### 6.2 鲸鱼娘侧「DSH 原生」补丁（主人明确授权，可回滚）

第一手聊天要交给 DSH 且按聊天复用 DSH 会话，需要鲸鱼娘把「这是哪个聊天」和长超时带到 provider 请求里（只改鲸鱼娘内部，不动微信桥）：

| 文件 | 改动 |
|---|---|
| `src/llm.js` | `_open(payload,{…,chat,trust})` 增发 `x-whale-chat` / `x-whale-trust` 头；`complete/stream` 透传 `chat`、`trust`；本地 provider（`rt.isLocal`）超时默认 900s。 |
| `src/bot.js` | 新增 `chatKeyOf(msg)`（`platform\|chatType\|chatId`）与 `trustOf(decision)`（主人/本地网页=1）；5 处 `this.llm.complete/stream` 调用带 `chat` + `trust`。 |

备份：`<DSH工作区>\scratch\whale-girl-src-backup-20261104-015709\{llm.js,bot.js}`；幂等补丁脚本 `whale-side/patch-whale-native.mjs`（自动备份到 `<whale>/data/restore-backups/whale-native-*`，失败自动还原，`--revert` 回滚最近一次；已实测「已打补丁→跳过」「未打→打→语法检查通过→revert→还原」）。换机时执行：

```bat
"<鲸鱼娘>\runtime\node.exe" "<插件>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>"
```

回滚=跑同命令加 `--revert`（或手工还原备份两文件）+ 重启鲸鱼娘服务。微信桥 `examples/wechatauto_bridge.py` 不再改（防封号）。

约束：

- 只允许改 `config.json`、`data/settings.json`、`web/debug.html`、`web/index.html` 四处；`web/debug.html` 与 `web/index.html` 各只有一段标记块，脚本可重复执行不重复插入。主人明确授权时例外：微信文件通道可改 `examples/wechatauto_bridge.py` + 在 `config.json` 增加 `wechat.fileChannel*` 键（须备份、可回滚，见 §6.1）；DSH 原生模式可改 `src/llm.js` / `src/bot.js`（须备份、可回滚，见 §6.2）。
- `config.json` 不存在时以 `config.example.json` 为模板生成（鲸鱼娘首次启动也会这么做）；先备份成 `config.json.whale-dsh-bridge.bak`。
- 默认不启动微信桥接；微信侧文件通道的真实验证仅在主人明确授权时进行，验证完恢复原状态（不长期占用微信窗口）。
- 升级鲸鱼娘后重跑 install/接入即可（标记块丢失则重插；config.json 属用户数据不会被升级覆盖；`web/index.html` 被升级覆盖时文件通道脚本需重新注入；`examples/wechatauto_bridge.py` 被升级覆盖时需重新打微信文件通道补丁）。

## 7. 验证（不使用微信）

1. `node --check` 所有 JS；`node -e "JSON.parse(...)"` 所有 JSON。
2. 启动桥接待宿主插件后：`GET /api/health` 200；`POST /api/task {prompt:"回答 1+1"}` 返回 `2`。
3. `POST /v1/chat/completions`（stream=false，messages=[{role:"user",content:"用 dsh 看看 <DSH工作区> 下有几个文件"}]) 能触发 `dsh_task` 并返回文本。
4. 鲸鱼娘侧：`node server.js` 起网页服务（端口 8787）→ `POST /api/chat` 发一句「让 DSH 看看工作区有哪些文件」→ 回复由桥接代理产出（日志可见 tool 调用）。
5. `/static/debug-bridge.js` 可被 GET 到；安装脚本对 debug.html 幂等。
6. DSH 侧边栏注册代码存在且模块能被加载（宿主日志无 import 错误；必要时刷新页面）。
7. **文件通道（v0.2.0）**：
   - `test/files-unit.mjs`：30 项单元（MEDIA 提取/清洗、类型/大小/敏感路径校验、登记与下载链接、上传与路径穿越清洗、附件提示、outbox 收集、settings 合并、LlmProxy 出站收集）。
   - `test/e2e-files.mjs`：真实链路 15 项（上传→鲸鱼娘→DSH 读文件→回复含标记；DSH 产物→回复含 `/files/` 链接→下载内容一致 + `Content-Disposition: attachment`）。
   - `test/ui-file-channel.mjs`：无头 Chrome 17 项（📎 注入、模拟上传、chip、`[Shared attachment]` 自动随消息、链接可点、附件标记美化、截图）。
   - 安全抽查：未知 token 404、非法扩展名 400、`../` 文件名落 inbox、`/api/state` 不泄漏 Key。
8. **DSH 原生模式（2026-11，`brain=dsh`）**：
   - 网页 `/api/chat` → 7s DSH 会话回复；`POST /webhook/wechat`（真号私聊）连续两条同 session（记「墨绿色」→ 追问「墨绿色」）；附件 marker → 10s 正确概括文件；让 DSH 生成文件 → outbox 27B + 回复 `📎 + 下载链接` → 下载 200 内容一致。
   - 「新会话 / 换个话题 / reset」→ 0s 清映射、旧内容不再记得；`GET/PUT /api/brain`、`POST /api/brain/reset|chat|sync` 可用；`/api/whale/console*` 聚合与脱敏正常。
   - `whale-side/patch-whale-native.mjs`：已打→跳过、未打→打+语法检查、`--revert` 还原（临时副本演练通过）。
9. 恢复/回滚：`POST /api/whale/revert` 移除两处标记块并还原 config/settings；`whale-side/revert-whale-side.ps1` 覆盖脚本安装路径；原生模式回滚见 §6.2（`--revert`）+ `PUT /api/brain {brain:'upstream'}`。
10. **DSH 原生一键自检**：`"<鲸鱼娘>\runtime\node.exe" "<插件>\whale-side\check-native-chain.mjs"`（`--json` 可机器读）→ 12 项；网关心跳有 5×2s 重试，重启后不会误报；本机实测 12 PASS。

## 8. 禁止事项

- 默认不启动微信桥接 / 不操作微信窗口 / 不登录微信；**仅在主人明确授权做微信侧文件通道验证时**按 §6.1 操作，并避免给真实会话误发文件（自测优先用「文件传输助手」/测试会话）。
- 不重启 DSH 桌面应用（会中断当前会话）；用 HMR/刷新验证。
- 不修改 `C:\whale-girl` 下除 §6 所列文件以外的文件；不修改 DSH 安装目录。改动鲸鱼娘 `src/llm.js`、`src/bot.js`、`examples/wechatauto_bridge.py` 必须先在 `<DSH工作区>\scratch\` 备份并记录回滚方式。
- 不把 API Key/聊天内容写进日志或交付文档；settings 文件权限保持默认。
- 文件通道：不把桥接 HTTP 暴露到公网；下载 token 不写进日志；`files.enabled=false` 时必须拒绝上传与文件登记。
