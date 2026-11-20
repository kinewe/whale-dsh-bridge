# dsh-whale-bridge —— 鲸鱼娘聊天壳 × DeepSeek Harness 桥接

> **注意：本文件是插件开发历史说明，部分章节以 `brain=upstream` 旧模式为例。**
>
> 当前参考部署使用 **`brain=dsh`**：聊天回复本身也由 DSH 会话生成，不只是“需要动手时”才走 DSH。
> 以仓库根目录 `README.md` 和 `docs/tutorial.md` 为准。

把「鲸鱼娘」这个**聊天壳**接到 **DeepSeek Harness（DSH）** 上：

- **聊天照旧**：人设、网页/微信聊天、记忆、表情包、B 站/热搜、语音、看图，全在鲸鱼娘里。
- **需要动手时进入 DSH**：聊天里一旦需要「真的干活」（读写文件、跑命令、改代码、多步任务、综合查证），模型会调用 `dsh_task`，任务交给 DSH agent 在指定**工作区**、按指定**权限**、用指定**模式**执行，结果回到聊天里。
- **DSH 侧边栏管理面板**：「鲸鱼娘桥接」入口，管理状态、DSH 权限/模式/工作区、任务测试台、一键接入/还原、重建任务 profile。
- **鲸鱼娘 `/debug` 调试台卡片**：同一个权限/模式/工作区/测试界面，直接出现在鲸鱼娘的调试页里。
- **文件收发（文件通道，v0.2.0）**：网页聊天里点「📎」把本机文件交给 DSH 处理；DSH 产出的文件（报告/表格/图片/压缩包）会自动变成聊天里可点击的下载链接。设计参考本机 Hermes 网关的 media 处理（出站 `MEDIA:<路径>` 标记 + token 下载链接；入站附件路径提示），按本桥接场景简化。

> 本机约定：**不使用真实微信做调试**。所有验证走「鲸鱼娘网页聊天 → 桥接代理 → DSH」链路。

> 换机器 / 笔记本安装见 **[docs/任务书-笔记本安装.md](docs/任务书-笔记本安装.md)**（含路径改造、验证清单、回滚与「文件通道」后续规划）。

## 目录

- [架构一图流](#架构一图流)
- [文件与版本隔离](#文件与版本隔离)
- [安装（DSH 侧）](#安装dsh-侧)
- [接入鲸鱼娘](#接入鲸鱼娘)
- [使用](#使用)
- [文件收发（文件通道）](#文件收发文件通道)
- [DSH 权限与模式](#dsh-权限与模式)
- [升级与回滚](#升级与回滚)
- [验证](#验证)
- [限制与安全](#限制与安全)

## 架构一图流

```
鲸鱼娘（C:\whale-girl，版本 3.60）
  web/微信消息 → bot.decide → LLM 流式生成
        │ provider=custom（config.llm.baseUrl = http://127.0.0.1:8789/v1）
        ▼
dsh-whale-bridge（本插件，跑在 DSH 宿主进程里，监听 127.0.0.1:8789）
  /v1/chat/completions  OpenAI 兼容代理
        │ ① 转发给「鲸鱼娘原来的模型服务商」（上游，带 tools:[dsh_task]）
        │ ② 模型判断需要动手 → 返回 tool_call: dsh_task
        │ ③ 桥接执行 DSH 任务（见下）
        │ ④ DSH 结果回填给上游模型 → 最终回复流式返回鲸鱼娘
        ▼
  DSH 任务执行器：dsh --profile whale-agent --json "<task>"
        │ cwd = 工作区；env DSH_PERMISSION_MODE = 权限
        │ whale-agent profile 使用 GUI 已登录的 DeepSeek 账号
        ▼
  DSH agent 在工作区里读/写/跑（工具调用）→ 最终文本 → 回到聊天
```

另外两条管理/调试通道：

- DSH 左栏「鲸鱼娘桥接」面板 → 调桥接 HTTP API（`/api/state`、`/api/settings`、`/api/task`、`/api/whale/*`、`/api/dsh/rebuild-profile`）。
- 鲸鱼娘 `/debug` 页里由安装脚本注入的卡片 → 同一套 API。

文件通道（v0.2.0 起）：

```
鲸鱼娘网页聊天页（注入的 📎 上传控件 / 链接可点脚本）
  上传 → POST 127.0.0.1:8789/api/upload（base64 JSON）→ <工作区>\.whale-bridge\inbox\
  下一条消息文本里自动追加 [Shared attachment] file: <绝对路径>
        ▼
桥接代理把附件路径作为 system 提示交给模型 → 模型写进 dsh_task → DSH 直接读文件
        ▼
DSH 任务产物（outbox 新文件 / MEDIA: 标记）→ 桥接登记 token → 回复末尾附下载链接
  http://127.0.0.1:8789/files/<token>/file_<token8>.<ext> → 浏览器下载
```

## 文件与版本隔离

两侧都会升级，所以本项目刻意把所有东西分成三层，互不污染：

| 层 | 位置 | 升级时怎么办 |
|---|---|---|
| **桥接插件**（DSH 侧） | 本目录 `<插件目录>`（以 junction 链接进 DSH profile） | 只改本目录；DSH 升级后若任务跑不起来，点面板「重建任务 profile」即可 |
| **DSH profile 改动** | `<USERPROFILE>\.dsh\profiles\desktop\package.json` 两处（依赖 + bundles）+ `node_modules\dsh-whale-bridge` 链接 | 安装脚本自动备份；卸载脚本可完全还原 |
| **鲸鱼娘侧改动** | 只碰它的**用户数据/覆盖层**：`config.json`（用户数据，升级不覆盖）+ `data/settings.json`（网页设置）+ `web/debug.html` 里一段带标记的 `<script>` | 鲸鱼娘升级后重跑一次 `whale-side\install-whale-side.ps1`（标记块被覆盖时自动重插；config.json 不受升级影响） |

桥接**不 import 任何 `@deepseek-ai/*` 包**、不修改 DSH 安装目录、不修改鲸鱼娘源码（`server.js`、`src/**`、`web/assets/**` 一律不动）。

## 安装（DSH 侧）

1. 确认 DSH 桌面端正在运行（本机 Web/桌面 GUI：`http://127.0.0.1:8158`）。
2. 以管理员无关的普通 PowerShell 运行：

```powershell
cd <插件目录>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-dsh-plugin.ps1
```

脚本做三件事（幂等、可重复执行）：
1. 备份 profile `package.json`；
2. 在 profile 的 `node_modules` 下建 junction 指向本目录，并把 `dsh-whale-bridge` 追加进 `dsh.profile.bundles`；
3. 等 HMR 自动重组后探测 `http://127.0.0.1:8789/api/health`。

看到 `桥接已激活` 后**刷新 DSH 页面（Ctrl+R）**，左侧栏出现「鲸鱼娘桥接」。
> 为什么不用 `dsh plugin --profile desktop add ...`：desktop profile 由 Electron 应用独占，CLI 会拒绝；这里改走 HMR 监听 profile 清单的官方热重组路径。原理见 `CONTRACT.md`。

## 接入鲸鱼娘

两种方式等价（推荐第一种）：

1. DSH 左栏「鲸鱼娘桥接」→「接入鲸鱼娘」按钮。
2. 或运行 `whale-side\install-whale-side.ps1`（自动生成/合并 `config.json`、`data/settings.json`、注入 `/debug` 卡片）。

**前提 / 首次使用（重要）**：桥接代理需要一个「上游模型」来生成聊天回复——也就是鲸鱼娘原本要填的那家服务商（默认 `https://api.deepseek.com` + `deepseek-chat`）和它的 Key。
如果鲸鱼娘之前没配过 Key，请二选一补齐：

1. DSH 左栏「鲸鱼娘桥接」→「高级」→ 填上游 baseUrl / Key / model → 保存（推荐）；
2. 或先在鲸鱼娘网页「设置」里把模型 Key 填好、确认能正常聊天，再回到 DSH 点一次「接入鲸鱼娘」。

补齐后聊天与以前完全一样（走你的上游模型），只是需要动手时会多一次 `dsh_task` 调用。
接入成功后 `/debug` 调试页会自动出现「DSH 桥接 · 权限与模式」卡片，**网页聊天页会自动出现「📎」上传按钮并让下载链接可点**（都由接入动作自动注入，带标记块）。

> 用 `whale-side\install-whale-side.ps1` 接入时，脚本只写 config/settings 与 `/debug` 卡片；文件通道 UI 需要再在 DSH 面板点一次「接入鲸鱼娘」（幂等），或手动把 `whale-side` 里的 `web-file-channel.js` 以标记块 `<script>` 注入 `web/index.html`。

## 使用

- **闲聊**：照旧，不会调用 DSH，零额外开销（只多一个 tool schema）。
- **发文件给 DSH**：网页聊天输入框左边的「📎」→ 选文件（可多选）→ 自动上传到 `<工作区>\.whale-bridge\inbox\`，输入框上方出现附件 chip；直接点发送（不写字也行）就会把 `[Shared attachment] file: <绝对路径>` 一并交给模型，模型再写进 `dsh_task`，DSH 直接读该文件。
- **DSH 把文件给你**：让 DSH 生成产物（报告/表格/图片/压缩包）时，它把文件放进 `<工作区>\.whale-bridge\outbox\` 或输出 `MEDIA:<绝对路径>`；桥接会自动登记并在回复末尾附「📎 文件名（大小）+ 下载链接」，点链接即可下载。
- **启动 / 停止鲸鱼娘**（面板按钮）：鲸鱼娘是后台进程时也能看到状态——「鲸鱼娘」状态卡会显示 **运行中/未运行、进程 PID、启动来源（桥接启动 / 你手动启动）**；卡片下方有「启动鲸鱼娘」「停止鲸鱼娘」按钮。停止只结束网页服务进程，不动 DSH、不动微信桥接；已停止时再点停止会提示"本来就没在运行"。
- **打开鲸鱼娘网页 / 调试台**（面板按钮）：会先检查鲸鱼娘是否在跑——**已经双击过启动 bat、或已有进程/端口时只等待，不会重复启动**；确实没在跑才用她自带的 `runtime\node.exe server.js --no-browser` 拉起来，健康检查通过后由宿主用系统浏览器打开目标页（所以不会再被浏览器弹窗拦截）。
- **需要动手**：例如「帮我把工作区里昨天的日志整理成摘要」「看看这个项目为什么测试挂了并修一下」「把这份表格按月份汇总」。这类消息会先收到一句「收到～我让 DSH 去处理，稍等一下」，任务久时每 1~2 分钟报一次进度（由模型按人设自己写，会带上真实进度），完成后给出结果（单任务上限 10 分钟）。

面板/调试卡里可调：

| 选项 | 取值 | 说明 |
|---|---|---|
| 工作区 | 绝对路径 | DSH 任务在哪个目录里干活（默认 `<DSH工作区>`） |
| 权限 | `read-only` / `workspace-write` / `danger-full-access` | 对应 DSH 沙箱与审批策略（见下） |
| 模式 | `standard` / `creator` | 标准任务 / 创造（任务 agent 也能管理 DSH 插件，需完全权限才真正能装东西） |
| 默认会话 | DSH session id | 留空=每次新任务；填了则同一聊天沿用同一 DSH 会话上下文 |
| 上游 | baseUrl / apiKey / model | 桥接代理所用的「鲸鱼娘原模型服务商」 |

## 文件收发（文件通道）

设计参考本机 Hermes 网关（`gateway/platforms/base.py` 的 `MEDIA:` 出站标记、token 化下载、入站附件提示、路径白名单），按本桥接场景简化；鲸鱼娘源码不改，只在 `web/index.html` 注入一个带标记的 `<script>`。

**出站（DSH → 用户）**

1. 模型在 `dsh_task` 的 instruction 里要求 DSH 把产物保存到 `<工作区>\.whale-bridge\outbox\`，并让 DSH 在最终文本输出一行 `MEDIA:<绝对路径>`（系统提示已内置该约定）。
2. 任务结束后桥接：① 提取/剥离 `MEDIA:` 标记（支持引号、`**`、多行、尾部「（大小）」注记）；② 自动扫描 outbox 在任务期间新增/变更的文件（`files.autoOutbox`，默认开）；③ 校验（扩展名白名单、大小上限、敏感路径拒绝）后登记 token。
3. 最终回复末尾自动追加（模型漏写也会补）：
   ```
   📎 report.pdf（782.6 KB）
   http://127.0.0.1:8789/files/<32位token>/file_<token前8位>.pdf
   ```
   URL 用 ASCII 短名，避免鲸鱼娘服务端加工/截断长文本；注入脚本还有 SSE 兜底：若回复被切坏导致链接没显示，会从原始流里再补一条下载消息。

**入站（用户 → DSH）**

1. 网页聊天页「📎」→ 选文件 → 脚本读成 base64 → `POST /api/upload` → 保存到 `<工作区>\.whale-bridge\inbox\<时间戳>-<随机>-<原名>`。
2. 下一条 `/api/chat` 请求的 `text` 末尾自动追加：
   ```
   [Shared attachment] file: <DSH工作区>\.whale-bridge\inbox\20261103-235509-xxxx-报告.txt
   ```
3. 桥接代理在发给上游模型的 system 消息里注入「用户附件（绝对路径）」提示，模型需要处理时把路径写进 `dsh_task`，DSH 直接读；路径还会校验存在性/大小/类型/敏感目录。

**API**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/upload` | `{name, data(base64)}` → `{ok, file:{name,path,size,ext,hint}}`；单文件上限 `files.maxFileMB` |
| GET | `/api/files` | 文件通道状态：开关、inbox/outbox 路径、最近登记的文件 |
| GET | `/files/<token>/<name>` | token 化下载（`Content-Disposition: attachment`） |
| GET | `/static/web-file-channel.js` | 注入到鲸鱼娘聊天页的文件通道脚本 |

**设置（`PUT /api/settings`，也可写进 cordis patch / `~/.dsh/whale-bridge/settings.json`）**

```json
"files": { "enabled": true, "autoOutbox": true, "maxFileMB": 20, "linkTtlHours": 24 }
```

**安全**

- 只监听 `127.0.0.1`；下载必须带随机 token（32 hex），不接受任意路径，默认 24h 过期。
- 扩展名白名单；单文件默认 20MB；上传文件名做 basename + 控制符清洗，防路径穿越。
- 敏感路径拒绝：`~/.dsh`（含桥接 settings/凭据）、`.ssh/.aws/.gnupg` 等、`.env`/`credentials`/私钥类文件名。
- 出站显式 `MEDIA:` 路径也会校验真实存在、普通文件、大小、类型与敏感目录；outbox 只收工作区内的文件。

**升级/回滚**：鲸鱼娘升级会覆盖 `web/index.html` → 重跑一次「接入鲸鱼娘」重新注入；`POST /api/whale/revert` 会移除标记块（备份在 `web/index.html.whale-dsh-bridge-files.bak`）。

### 微信私聊/群聊文件通道（v0.2.1，需主人明确授权）

网页侧之外，微信侧也做了文件收发；它改的是**鲸鱼娘自己的 Python 微信桥接** `examples/wechatauto_bridge.py`（不是本插件目录），所以默认不启用、也不在本插件的自动测试范围内。

- **入站（微信 → DSH）**：微信「文件」消息（微信 4.x 里 `type` 显示为 `文件/链接/卡片`）→ 桥接用 `MediaDownloader.download_file` 取本地路径，取不到再按 XML `<title>` 去 `<账号目录>\msg\file` 缓存兜底复制到 `data\wechat-files\` → 在转给鲸鲸的文本末尾追加 `[Shared attachment] file: <绝对路径>` → 模型转给 DSH 读。图片消息也会把落盘路径一并带上。
- **出站（DSH → 微信）**：① 优先从回复文本里的 `http://127.0.0.1:<port>/files/<32hex>/...` 取文件；② 兜底直接扫 DSH 工作区 `outbox` 里「本次回复期间」新产出的文件（鲸鱼娘服务端会截断/切分长回复，链接常丢，扫目录更稳）。取到后在 `data\wechat-outbox\<毫秒>\<原名>` 落盘（保留原文件名），文字发完再逐个个发成**微信文件消息**：打开目标会话 → 输入框聚焦 → 剪贴板 CF_HDROP → `uiautomation.SendKeys('{Ctrl}v')` → 校验输入框出现附件占位符 U+FFFC → `SendKeys('{Enter}')` → 回读微信数据库确认新的 `文件/链接/卡片` 消息。关键点：这台微信 4.x 上 `SendInput`（`gui._input.key`）粘贴/回车无效，必须用 `uiautomation.SendKeys`；确认不了就清理草稿、绝不重复发送，并回退发下载链接。目标输入框有残留草稿时会 fail-closed（提示先手动清空）。
- **配置**：`config.json` 的 `wechat.fileChannelIn` / `wechat.fileChannelOut` / `wechat.fileMaxMB`（默认 `true/true/20`）。
- **自测钩子**（只用于没有第二个微信账号时验证，默认关闭；用环境变量启动桥接）：
  - `WHALE_WECHAT_TEST_MODE=1` + `WHALE_WECHAT_TEST_CHAT=filehelper`：允许把「文件传输助手」自聊消息当测试会话处理；
  - `WHALE_WECHAT_TEST_INJECT=file,text`：启动后向测试会话注入一条文件入站消息 + 一条出站测试文本；
  - `WHALE_WECHAT_TEST_SEND_URL=<下载链接>`：只验证「回复 URL → 取文件 → 发微信文件」这段，不调模型。
- **备份/回滚**：改前备份 `examples\wechatauto_bridge.py`（本机备份在 `<DSH工作区>\scratch\wechat-bridge-original\`）；回滚 = 停桥接 → 还原该 .py → 去掉 `config.json` 里三个 `fileChannel*` 键 → 重启「启动微信桥接.bat」。`config.json` 本身不要整份还原（接入 DSH 后的改动会丢）。
- **注意**：这是 UI 自动化，发文件时微信窗口可能被短暂置前/闪一下；受微信版本、窗口状态影响，失败会自动回退下载链接；微信私聊/群聊的**文字**聊天不受影响。

## DSH 原生聊天（brain=dsh，新鲸鱼娘）

> 2026-11-04 起：第一手聊天直接交给 DSH，砍掉上游模型当聊天大脑；微信/网页的闲聊都由 DSH 会话生成（文件通道保留）。

- **开关**：`settings.brain = 'upstream' | 'dsh'`（默认 upstream 保持旧行为）。面板「DSH 原生（新鲸鱼娘）」卡片切换；API：`GET/PUT /api/brain`。
- **一个聊天 = 一个 DSH 会话**：聊天 key 从鲸鱼娘请求头 `x-whale-chat` 取（`platform|chatType|chatId`），映射持久化在 settings.json 的 `chatSessions`；同一微信私聊/群聊/网页会话始终复用同一个 DSH sessionId，上下文天然连续。群聊里只把「当前这条消息 + 发言人」交给 DSH（历史由 DSH 会话维护），「新会话」在群聊里同样生效。
- **换会话命令**：发「新会话 / 新对话 / 换个话题 / 重新开始 / 清空上下文 / 重置会话 / reset / newchat」→ 清掉该聊天映射，下一条自动开新 DSH 会话（0s 返回）。
- **附件**：最新用户消息里的 `[Shared attachment] file: <路径>` 会直接告诉 DSH；DSH 产物写到 `<workspace>\.whale-bridge\outbox\` 的文件仍会被登记成下载链接、由微信桥发成文件消息。
- **调试台（从鲸鱼娘网页 /debug 搬入）**：面板卡片可看/改鲸鱼娘 LLM 映射（provider / `llm.baseUrl` / `llm.model`）、看记忆统计、生成 system prompt 预览、清空指定会话记忆、**功能开关点选切换**、**微信账号扫描/切换**、**看图 Key 测试**、**手动记忆快照**。API：`GET /api/whale/console`、`POST /api/whale/console/{config,prompt,memory/reset,memory/backup,feature,vision-test,account,accounts/refresh}`。
- **映射同步（双向）**：`POST /api/brain/sync {direction:'to-whale'|'from-whale'}`；面板按钮「同步到鲸鱼娘 / 从鲸鱼娘读取」。to-whale 调鲸鱼娘 adopt（写回 provider=custom、`llm.baseUrl=http://127.0.0.1:<port>/v1`）；from-whale 读鲸鱼娘 config 的 llm 映射到插件 upstream。
- **安全边界（默认开启）**：DSH 有本机工具权限，所以只有**主人**与**本地网页聊天**会进 DSH 会话——鲸鱼娘补丁在请求头带 `x-whale-trust`（主人/本地网页=1，其他人=0）；主人私聊、主人参与的群聊都算可信。陌生私聊和陌生人群聊自动回退「纯聊天」——用上游模型按人设回复，但不给任何 DSH 工具（读不了本机文件、跑不了命令）。陌生人手打 `[Shared attachment]` 也没用（附件路径只认文件通道允许根目录）。
- **鲸鱼娘侧补丁（主人授权、可回滚）**：`src/llm.js`（请求带 `x-whale-chat` / `x-whale-trust` 头、本地通道超时 900s）、`src/bot.js`（5 处模型调用带 `chatKeyOf(msg)` + `trustOf(decision)`）。备份在 `<DSH工作区>\scratch\whale-girl-src-backup-*\`；回滚=还原两文件 + 重启鲸鱼娘服务。
- **另一台机器怎么开**（幂等补丁脚本，带自动备份/回滚）：
  ```bat
  "<鲸鱼娘>\runtime\node.exe" "<插件>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>"
  ```
  打完后重启鲸鱼娘服务（`runtime\node.exe server.js --no-browser`），在 DSH 面板「DSH 原生」卡片把大脑切到 `dsh` 并点「同步到鲸鱼娘」；回滚加 `--revert`（会还原最近一次备份）。
- **一键自检**（只读，12 项；失败返回非 0）：
  ```bat
  "<鲸鱼娘>\runtime\node.exe" "<插件>\whale-side\check-native-chain.mjs"
  ```
  检查：桥接健康 / `brain=dsh` / 聊天→DSH 会话映射 / 鲸鱼娘服务与 provider 映射一致 / 微信网关在线与账号确认 / DSH profile 就绪 / 主人名单（DSH 工具白名单）/ 聊天页文件通道注入。加 `--json` 输出机器可读结果。
- **微信桥 `examples/wechatauto_bridge.py` 本轮没有再改**（防检测封号），只负责收发消息/文件。

## DSH 权限与模式

| 权限 | 行为 |
|---|---|
| `read-only` | 只能读、不能写；写/跑命令会被沙箱拒绝（实测：agent 会如实汇报被拒）。 |
| `workspace-write` | 工作区内可读写，越界需审批；无审批通道时失败关闭。默认，推荐。 |
| `danger-full-access` | 完全权限、不再询问。只建议在受控机器上短期启用。 |

`creator` 模式会在任务 profile 里启用 `plugin_manager` 工具，让 DSH 任务能创建/修改 DSH 插件；实际安装动作仍要求完全权限。普通任务用 `standard` 即可。

## 升级与回滚

- **DSH 升级后**：桥接进程内自带的启动器探测会找新安装的 `resources/app.asar/.../dsh-desktop-host/lib/cli.js`；任务 profile 若因版本变化不可用，DSH 面板 →「重建任务 profile」。
- **鲸鱼娘升级后**：重跑「接入鲸鱼娘」（或 `whale-side\install-whale-side.ps1` + 手动补聊天页脚本）；`config.json`/`data/settings.json` 是用户数据不会被覆盖，`web/index.html` 的标记块会被升级覆盖需重注入。
- **撤销 DSH 侧**：`powershell -File .\uninstall-dsh-plugin.ps1`（移除链接与 bundles 项，自动重组；用户数据 `~/.dsh/whale-bridge` 保留）。
- **撤销鲸鱼娘侧**：面板「还原」/ `POST /api/whale/revert` 或 `whale-side\revert-whale-side.ps1`（还原 config/settings 备份、删除 debug.html 与 index.html 的标记块）。
- 桥接数据（设置、任务历史、日志、备份）在 `<USERPROFILE>\.dsh\whale-bridge\`：`settings.json` / `tasks.json` / `bridge.log` / `backups\`。
- 文件通道数据：`<工作区>\.whale-bridge\inbox\`、`<工作区>\.whale-bridge\outbox\`（可随时手动清理；登记 token 在桥接进程内，重启后失效，文件本身还在）。

## 常见问题

**1. 网页/群里发了消息，很久没有回复？**
需要动手的消息会先由聊天模型判断，再交给 DSH 执行，最后流式回来。为兼容这一点：
- **状态播报**：收到任务时先回一句（如「交给 DSH 了，先等等看。」），任务进行中每 **90 秒（1.5 分钟，可调 30–600 秒）**补一句进度，且台词是**模型按鲸鱼娘人设自己写的**、会带上真实进度（已等待秒数、DSH 正在执行哪个工具），不让你面对静默等待；上游模型思考较久（>20 秒）时也会先回一句。模型写失败时回退固定台词，保证一定播报。播报间隔用 `statusIntervalSec` 调整（默认 90），也可 `statusNarration: false` 关掉模型写词、只用固定台词。
- **衔接自然**：播报过的句子会作为提示告诉模型，最终回答会接着往下说，不会重复。
- **最大工作时间 10 分钟**：聊天触发的单个 DSH 任务上限 600 秒；对应「接入鲸鱼娘」会把鲸鱼娘请求超时 `config.deepseek.timeoutMs` 放宽到 660 秒（原来默认 45 秒，重任务会被它先掐断而表现为「没回复」）。
- **断开即停**：鲸鱼娘先超时/断开时，桥接会终止还在跑的 DSH 子进程，不再后台白跑。
如果任务确实超过 10 分钟上限，你会收到明确的失败说明，而不是静默无回复。想更快：把工作区指向更小的目录，或把要求写得更具体（例如「只统计 lib 目录下一层」）。

**2. 群聊里为什么有时她不理？**
群聊默认要 @ 或叫名字（`group.requireAt`）；回复元信息里的 `reason: addressed` 表示是被点名后回应的。这是鲸鱼娘原有行为，和桥接无关。

**4. 点「打开鲸鱼娘网页」没反应/显示已打开但浏览器没动？**
旧版在 DSH 宿主进程里用 `cmd start` 调起浏览器，实际可能不生效却误报「已打开」。现已改为由宿主多方式尝试（powershell / explorer / cmd / rundll32），并用桥接的 `/open` 跳板确认浏览器真的命中后才算成功（实测有效方式是 `rundll32 url.dll,FileProtocolHandler`）；全部失败会提示手动打开地址。鲸鱼娘已在运行时不会再重复启动 bat，这是有意为之。

**3. 面板/调试卡里上游 Key 显示“已配置”但看不到内容？**
按安全约定 Key 不回显（接口返回 `apiKey: "__SET__"` + `hasKey: true`）。留空保存表示保持原 Key；只有填入新值才会覆盖。

## 相似任务会自动接上之前的 DSH 会话吗？

默认开启 `continuity: auto` 时**会（由模型判断，不是硬匹配）**：

- 桥接会把「最近的 DSH 会话」列表（会话 id、时间、工作区、任务摘要）作为提示交给上游模型；
- `dsh_task` 工具多了一个可选参数 `session_id`；
- 当模型判断这次任务和某个会话是**同一件事的后续**（「继续」「刚才那个」「把上次改的再测一下」…），它会带上那个 `session_id`，DSH 就续接旧会话（上下文/记忆都在），而不是新开；
- 判断不准或无关（新话题、新项目）时不传，开新会话——宁可新开，也不接错。

其他相关行为：

- **同一轮回复内多次 `dsh_task`** 一定共用该轮第一个会话（上下文连续）。
- **「默认会话」**（面板里的字段）优先级最高：填了它就所有任务都固定用同一个 DSH 会话（适合"一个长期项目"）。
- `continuity: "off"` 可关闭自动续接（回到每次独立）。
- 旧模式（`brain=upstream`）下无法按"鲸鱼娘的每个私聊/群"分别映射会话；**DSH 原生模式（`brain=dsh`）已解决**：鲸鱼娘 `src/llm.js` 带 `x-whale-chat` 头，插件按聊天固定 DSH 会话，发「新会话」可重开。

## 验证

已在本机做过（全部不使用微信）：

1. **安装**：`install-dsh-plugin.ps1` 改 profile manifest + junction 后，DSH 桌面端 HMR 自动重组，桥接插件在运行中的 DSH 进程内监听 `127.0.0.1:8789`（`/api/health` 200，日志 `[plugin] start port=8789`）；无需重启桌面端。
2. **浏览器半侧**：客户端 bundle 被页面加载并完成槽位注册，桥接收到自报 `{"event":"client-applied","panelId":"whale-bridge","sidebarEntry":true,"mainEntry":true}`（说明 `sidebar.panellist` 与 `main` 注册成功）。
3. **DSH 任务**：`POST /api/task` 简单问答返回 `成功`；写文件任务用 `write` 工具落地；`read-only` 权限下写被拒且 agent 如实汇报；`creator` 模式下 `plugin_manager` 工具可用（实测列出 99 个插件）。
4. **代理 E2E**：`/v1/chat/completions` → `dsh_task` → DSH 执行 → 非流式/流式（SSE）都返回。
5. **鲸鱼娘网页聊天 E2E**（真实鲸鱼娘进程，端口 8787，`--no-browser`）：`POST /api/chat` → provider=custom（`config.llm.baseUrl=http://127.0.0.1:8789/v1`）→ 桥接代理 → DSH 读工作区 → 回复里带 DSH 结果（`WHALE-E2E-PASS`；验证时上游用本地 mock 模型，不消耗真实额度）。
6. **`/debug` 卡片**：`web/debug.html` 出现带标记的 `<script src="http://127.0.0.1:8789/static/debug-bridge.js">`，桥接 `/static/debug-bridge.js` 返回 200 / `text/javascript`。
7. **文件通道（v0.2.0，本机真实上游实测）**：
   - `node test/files-unit.mjs` → 30 项全过（MEDIA 提取、类型/大小/敏感路径校验、登记与下载链接、上传/穿越清洗、附件提示、outbox 自动收集、配置合并、LlmProxy 出站收集）。
   - `node test/e2e-files.mjs` → `WHALE-FILES-E2E-PASS` 15/15：入站（上传文件 → 鲸鱼娘转 DSH 读取 → 回复含文件内容标记，~30s）；出站（DSH 在 outbox 生成文件 → 回复带短 URL 下载链接 → 下载内容一致、`Content-Disposition: attachment`，~50s）。
   - `node test/ui-file-channel.mjs` → `WHALE-FILES-UI-PASS` 17/17（无头 Chrome + CDP：📎 按钮注入、模拟上传出 chip、`[Shared attachment]` 自动随消息、下载链接渲染成可点击 `<a>`、历史消息附件标记显示为「📎 附件：名字」）；截图 `scratch/ui-file-channel.png`。
8. **聊天页注入**：`web/index.html` 末尾有 `whale-dsh-bridge-files:begin/end` 标记块，页面 HTML 与桥接脚本均 200；页面需刷新一次让注入脚本生效。
9. **DSH 原生模式（2026-11，`brain=dsh`，真实鲸鱼娘 + 真实 DSH）**：
   - 网页聊天 `POST /api/chat` → 7s 返回 DSH 会话文本；
   - 微信桥同款 `POST /webhook/wechat`（真号私聊，未改微信进程）：连续两条同 session（记「墨绿色」→ 追问回答「墨绿色」）；附件 marker（任务书 md）→ 10s 正确三点概括；让 DSH 生成文件 → outbox 27B + 回复 `📎 + 下载链接` → 下载 200、内容 `HELLO-WECHAT-NATIVE-021006` 一致；
   - 「新会话」命令：0s 清掉映射，旧暗号不再记得；
   - 鲸鱼娘侧补丁幂等脚本 `whale-side/patch-whale-native.mjs`：已打→跳过、未打→打+语法检查、`--revert` 还原（临时副本演练通过）；
   - `node test/files-unit.mjs` → **ALL PASS (30 checks)**（本次改动后回归通过）。
10. **DSH 原生一键自检**：`"<鲸鱼娘>\runtime\node.exe" "<插件>\whale-side\check-native-chain.mjs"` → **12 PASS / 0 WARN / 0 FAIL**（桥接/brain/会话映射/鲸鱼娘映射/微信网关/DSH profile/主人白名单/文件通道注入；网关心跳会自动重试）。

> 旧版本验证时无真实模型 Key，第 5 步用 mock 上游；v0.2.0 起本机已配真实 DeepSeek 上游，文件通道 E2E 走真实模型与真实 DSH。

复跑脚本：`test\mock-upstream.mjs`、`test\manual-host.mjs`、`test\e2e-proxy.mjs`、`test\e2e-whale.mjs`、`test\verify-installed.mjs`、`test\files-unit.mjs`、`test\e2e-files.mjs`、`test\ui-file-channel.mjs`（详见 `CONTRACT.md`）。

> `verify-installed.mjs` 的「浏览器侧 client.js 已加载并自报」在插件 reload 后会变成 **WARN**（内存里的自报列表被清空）；刷新一次 DSH 页面即恢复，脚本仍返回 VERIFY-PASS。

## 限制与安全

- **微信侧文件通道需要主人明确授权**：本轮按主人要求做了微信私聊/群聊的文件收发（改鲸鱼娘 `examples/wechatauto_bridge.py`，见上）；但它依赖真实微信 UI 自动化，不适合无人值守长期高频使用，且微信升级后可能需要重新适配。本插件的自动测试脚本仍然不碰微信。
- 微信侧文件通道的边界：单文件默认 20MB（`wechat.fileMaxMB`）；发送时微信窗口可能短暂被置前；失败自动回退发下载链接；图片入站仍走鲸鱼娘原有看图流程（视觉 Key 未配置时只给 DSH 路径）。
- 微信「文件」消息在库里的 type 是 `文件/链接/卡片`（不是 `文件`），和链接卡片共用；桥接用 XML 的 `<fileext>/<totallen>` 区分。
- 文件通道只处理**聊天触发的 DSH 任务**（`/v1` 代理链路）；面板任务测试台 `/api/task` 直连执行器，不登记下载链接。
- 单文件默认 20MB、下载链接 24h 过期、桥接重启后已登记 token 失效（文件仍在磁盘）。
- 桥接 HTTP 只监听 `127.0.0.1`，无鉴权；不要把它暴露到公网。
- DSH 任务以本机用户权限运行；`danger-full-access` 等于把整台机器的操作权交给聊天模型，谨慎开启。
- 鲸鱼娘的任务/对话内容会经过 DSH 会话持久化（`~/.dsh/sessions`）；敏感聊天请留意。
- 上游 Key 明文保存在 `~/.dsh/whale-bridge/settings.json`（本机用户目录，与鲸鱼娘自己的 data 同级敏感度）。

## 文件结构

```
whale-dsh-bridge/
├─ index.js                  # Host 半侧入口（cordis 插件）
├─ lib/                      # 桥接实现（纯 Node 内置模块）
│  ├─ config.js              # 路径/默认值/设置持久化（含 files.* 文件通道设置）
│  ├─ dsh-task.js            # DSH 任务执行器 + whale-agent profile 维护
│  ├─ whale-adapter.js       # 鲸鱼娘 config 适配（接入/还原/状态/注入聊天页与调试卡）
│  ├─ file-channel.js        # 文件通道：MEDIA 提取/校验/token 下载/inbox 上传/outbox 收集
│  ├─ llm-proxy.js           # OpenAI 兼容代理 + dsh_task 工具循环（入站附件提示、出站文件链接）
│  ├─ bridge-server.js       # 127.0.0.1 HTTP API + 静态资源（/api/upload、/files/* 等）
│  └─ host.js                # 组装
├─ client.js                 # 浏览器半侧：DSH 侧边栏入口 + 管理面板
├─ locale/{zh,en}.json       # 展示文案
├─ icon.svg
├─ whale-side/               # 鲸鱼娘侧最小侵入适配
│  ├─ debug-bridge.js        # /debug 调试台卡片
│  ├─ web-file-channel.js    # 聊天页注入脚本：📎 上传 + 下载链接可点 + SSE 兜底
│  ├─ install-whale-side.ps1 # config/settings/debug 卡片（文件通道 UI 由面板接入注入）
│  └─ revert-whale-side.ps1
├─ install-dsh-plugin.ps1    # DSH profile 热安装
├─ uninstall-dsh-plugin.ps1
├─ test/                     # 自检脚本
│  ├─ files-unit.mjs         # 文件通道单元测试（不联网）
│  ├─ e2e-files.mjs          # 文件收发真实 E2E（真实模型 + DSH）
│  ├─ ui-file-channel.mjs    # 聊天页 UI 自检（无头 Chrome + CDP）
│  └─ …（原有 mock 上游/代理 E2E 脚本）
├─ CONTRACT.md               # 实现契约（API/配置/隔离/验证）
└─ README.md
```

## 常见问题（文件通道）

**1. 聊天页没有「📎」按钮？**
页面需在「接入鲸鱼娘」之后刷新一次（`Ctrl+R`）；仍没有就检查 `web/index.html` 里是否有 `whale-dsh-bridge-files:begin/end` 标记块（鲸鱼娘升级会覆盖，重跑接入即可）。

**2. 上传了文件但 DSH 没看到？**
看桥接日志 `~/.dsh/whale-bridge/bridge.log` 是否出现 `[files] inbound attachments=1`；确认聊天确实发给了模型（不是演示模式）、且文件在 inbox 里。输入框空着直接点发送也可以（脚本会自动补一句）。

**3. 回复里没有下载链接？**
确认 DSH 任务确实产出了文件（outbox 或 `MEDIA:`）；面板任务测试台 `/api/task` 不会附链接。回复被鲸鱼娘切气泡导致链接丢失时，注入脚本会从原始流里兜底补一条下载消息。

## 2026-11-04 增量：DSH 原生模式与人设/配置面板

### 新增设置
- `brain`: `upstream` 或 `dsh`（默认 `dsh` 用于微信原生聊天）
- `model`: DSH 任务模型；留空 = `deepseek-flash`
- `reasoningEffort`: `low / medium / high / max`，默认 `max`
- `personaFile`: 插件侧人设文件，默认 `~/.dsh/whale-bridge/persona.md`
- `files.*`: 文件通道开关、autoOutbox、maxFileMB、linkTtlHours
- `chatSessions`: 每个微信会话固定映射到一个 DSH 会话

### 新增 API
- `GET/PUT /api/persona`：读取/保存 persona.md
- `GET/POST /api/whale/console/care`：主动搭话设置
- `GET/POST /api/whale/console/media`：媒体缓存清理设置
- 既有 `/api/state`、`PUT /api/settings` 继续可用

### 面板卡片
DSH 原生、鲸鱼娘调试台、主动搭话、媒体与文件、人设、模型/思考强度、任务/维护。

### 验证
- `test/files-unit.mjs` 30/30
- `test/e2e-files.mjs` 15/15
- 强化版 `test/e2e-proxy.mjs`（要求 `PROXY_REAL_DSH_OK`）实测 PASS
- UI 离线 harness 136 PASS / 0 FAIL

### 已知限制
- 面板与鲸鱼娘 `/debug` 还有少量高级项未搬
- 真机验收需要主人发真实微信消息；自聊/文件传输助手不能替代
