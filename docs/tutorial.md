# 鲸鱼娘 × DSH 接入参考教程

> **如果交给 DSH 安装，请先读仓库根目录的 [`AGENTS.md`](../AGENTS.md) 和 [`docs/install-with-dsh.md`](install-with-dsh.md)。**
>
> **这是一个参考实现，不是一键安装包。**
>
> 本机验证环境：DSH `0.2.2-rc.3`、鲸鱼娘 `3.60`、`dsh-whale-bridge 0.2.0`。
> 鲸鱼娘后续版本可能改了 `src/llm.js`、`src/bot.js`、微信桥接或网页；本仓库里的桥接修改是**老版本参考**，不要直接覆盖新版本文件，先对比/合并。
>
> 适合：愿意看日志、按步骤改配置的技术型网友，或直接交给 DSH 执行。
> 不适合：期待双击安装、完全不想碰路径和命令的人。

## 仓库结构

```text
whale-dsh-bridge/
├─ README.md                 项目介绍
├─ AGENTS.md                 DSH 安装/适配执行规则
├─ docs/
│  ├─ tutorial.md            本教程
│  ├─ install-with-dsh.md    给 DSH 的安装任务说明
│  └─ versions.md            版本与兼容性
├─ plugin/dsh-whale-bridge/  DSH 插件源码
├─ bridge-reference/         老版本微信桥接参考（不要直接覆盖）
└─ scripts/                  辅助脚本
```

## 先读这段

1. 先确认你的 DSH 和鲸鱼娘都能独立运行；
2. 再安装插件、打补丁、接桥接；
3. **不要**把 `bridge-reference/` 直接覆盖到新版鲸鱼娘；
4. 出问题先看日志，不要连续重启/重复启动多个桥接。



> 适用：Windows 10/11 + DSH 桌面端 + 鲸鱼娘（whale-girl）+ 微信 4.x  
> 本机已验证版本：DSH `0.2.2-rc.3`、鲸鱼娘 `3.60`、`dsh-whale-bridge 0.2.0`  
> 鲸鱼娘上游：https://github.com/Banan1cee/whale_girl  
> 目标：**聊天入口还在鲸鱼娘；当前参考部署 `brain=dsh`，聊天回复也由 DSH 会话生成，需要动手时由 DSH 调工具，结果回到聊天。**

---

## 1. 先理解这套方案

鲸鱼娘负责：

- 人设、记忆、表情包、语音、看图；
- 微信/网页聊天入口；
- 群聊里什么话该接、什么时候保持安静。

DSH 负责：

- **`brain=dsh` 时：聊天回复本身也由 DSH 会话生成；**
- 真正动手：读写文件、跑命令、改代码、多步任务、查资料并整理；
- 在自己的工作区里执行，按配置的权限和模式运行；
- 把结果交回鲸鱼娘。

一句话：

> **鲸鱼娘是聊天入口；`brain=dsh` 时，DSH 同时是聊天大脑和干活的手。**  
> 不是把鲸鱼娘源码改造成 DSH，也不是把 DSH 塞进微信；两边各跑各的，通过一个本地桥接插件连接。

两种模式：

| 模式 | 聊天回复 | 工具任务 |
|---|---|---|
| `brain=dsh`（当前参考部署） | DSH 会话生成 | DSH 执行 |
| `brain=upstream`（旧模式） | 鲸鱼娘上游模型生成 | 模型判断后调用 `dsh_task` |

---

## 2. 架构图

```
微信 / 鲸鱼娘网页
        │  聊天消息
        ▼
鲸鱼娘服务（Node，默认 127.0.0.1:8787）
        │  provider=custom
        │  baseUrl=http://127.0.0.1:8789/v1
        ▼
dsh-whale-bridge 插件（跑在 DSH 宿主进程里，监听 127.0.0.1:8789）
        │
        │  ① 闲聊：直接由 DSH 会话生成回复
        │  ② 需要动手：由 DSH agent 调工具执行
        │  ③ 文件：入站给本地路径，出站从 outbox 收集
        ▼
DSH 会话 / 任务（profile: whale-agent）
        │  cwd = 配置的工作区
        │  permission = read-only / workspace-write / danger-full-access
        ▼
结果文本 / 产物文件
        │
        └──→ 回到鲸鱼娘 → 回到微信/网页
```

另外两条管理通道：

- DSH 左侧栏「鲸鱼娘桥接」面板：状态、配置、任务测试、接入/还原、一键启动；
- 鲸鱼娘 `/debug` 页面里的「DSH 桥接」卡片：同一套能力。

---

## 3. 前置条件

需要准备：

1. **DSH 桌面端**已安装并登录；
2. **鲸鱼娘**目录完整，能正常启动网页聊天；
3. **微信 4.x** 已登录（如果要做微信接入）；
4. 插件目录 `dsh-whale-bridge`；
5. 鲸鱼娘原本使用的模型服务商（Base URL + API Key + 模型名）。
   - `brain=dsh` 时不是必需，聊天由 DSH 生成；
   - `brain=upstream` 或要保留旧模式时需要。

建议：

- 鲸鱼娘和 DSH 都放在**本机**；
- 路径尽量用英文；中文路径不是绝对不能跑，但 UIA/子进程相关问题会更多；
- 先用网页聊天验证，再接微信。

---

## 4. 最短路径（推荐）

### 第 1 步：安装 DSH 插件

打开普通 PowerShell（不需要管理员）：

```powershell
cd <插件目录>
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-dsh-plugin.ps1
```

默认安装到桌面端 profile：

```text
%USERPROFILE%\.dsh\profiles\desktop
```

如果你的 DSH 使用其他 profile，显式传：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-dsh-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
```

脚本会：

1. 备份 profile 的 `package.json`；
2. 在 profile 的 `node_modules` 里建立指向插件目录的 junction；
3. 把 `dsh-whale-bridge` 加入 profile 的 bundles；
4. 等插件 HTTP 服务起来，探测 `http://127.0.0.1:8789/api/health`。

看到健康检查成功后，**刷新 DSH 页面（Ctrl+R）**，左侧栏应出现「鲸鱼娘桥接」。

> 不要直接 `dsh plugin --profile desktop add ...`：桌面端 profile 由 Electron 应用管理，CLI 会拒绝。安装脚本走的是 profile 清单热重组路径。

### 第 2 步：配置插件

打开 DSH 左栏「鲸鱼娘桥接」，至少确认：

| 配置 | 建议值 | 说明 |
|---|---|---|
| 工作区 | `<DSH工作区>`（按需） | DSH 任务在这里读写 |
| 权限 | 先 `workspace-write`，确认需要再 `danger-full-access` | DSH 沙箱权限 |
| 模式 | `standard` | 标准任务 |
| 大脑 | `dsh` | 聊天由 DSH 会话生成 |
| 模型 | 留空或 `deepseek-flash`/`deepseek-chat` | 按你的 DSH 模型 |
| 超时 | `600000`（10 分钟） | 单任务上限 |
| 进度间隔 | `30` 秒 | 任务期间播报频率 |

在「人设」卡片里确认 `persona.md` 已加载；它决定 DSH 聊天/任务回复的口吻。

### 第 3 步：接入鲸鱼娘

> 换一台机器、第一次做 `brain=dsh` 时，先给鲸鱼娘源码打「DSH 原生聊天」补丁：
>
> ```bat
> "<鲸鱼娘目录>\runtime\node.exe" "<插件目录>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>"
> ```
>
> 补丁做两件事：请求头带 `x-whale-chat`（聊天映射）、`x-whale-trust`（信任边界），并让本地通道支持长超时。  
> 脚本会自动备份鲸鱼娘源码；回滚：
>
> ```bat
> "<鲸鱼娘目录>\runtime\node.exe" "<插件目录>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>" --revert
> ```
>
> 打完补丁后重启鲸鱼娘服务，再继续下面的「接入鲸鱼娘」。

在面板里点：

- **「接入鲸鱼娘」/「一键接入」**（推荐）；或
- 手动运行插件目录下的 `whale-side\install-whale-side.ps1`。

它会做三件事：

1. 把鲸鱼娘的 provider 指向本桥接：

   ```text
   provider = custom
   llm.baseUrl = http://127.0.0.1:8789/v1
   llm.model   = deepseek-chat
   llm.apiKey  = 本地桥接占位（brain=dsh 时不需要真实上游 key）
   ```

2. 写入鲸鱼娘的 `config.json` 和 `data/settings.json`；
3. 给鲸鱼娘 `/debug` 页面注入「DSH 桥接」卡片。

> 如果你还要保留「上游模型模式」，请在面板「高级」里填真实上游 Base URL / Key / Model。  
> `brain=dsh` 时聊天直接由 DSH 生成，不再依赖上游模型；但任务回执/某些辅助文案仍可能需要它。

### 第 4 步：一键启动全链路

面板右上角点：

```text
一键启动全链路
```

它会：

1. 检查鲸鱼娘 8787；
2. 不在运行就自动启动；
3. 检查微信桥接心跳；
4. 没启动就自动执行 `启动微信桥接.bat`；
5. 等桥接心跳、UIA、微信账号全部就绪；
6. 返回结果并刷新面板状态。

第一次从全下线启动，通常需要 **60–90 秒**。

如果你不用面板，也可以手动：

```text
1. 双击 启动鲸鱼娘.bat
2. 双击 启动微信桥接.bat
```

现在 `启动微信桥接.bat` 会检查 8787，没起来会自动拉起鲸鱼娘，所以顺序不再那么严格。

### 第 5 步：验证

端口：

```powershell
Get-NetTCPConnection -LocalPort 8787,8789 -State Listen
```

插件状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8789/api/state
```

应能看到：

```text
status.chain.whale.running = true
status.chain.bridge.online = true
status.chain.wechat.accountOk = true
status.chain.online = true
```

鲸鱼娘状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/status
```

还可以跑插件自带的一键自检（只读，12 项）：

```bat
"<鲸鱼娘目录>\runtime\node.exe" "<插件目录>\whale-side\check-native-chain.mjs"
```

最后：

1. 先在鲸鱼娘网页聊天发一句「在吗」，确认能回；
2. 私聊微信发一句「在吗」；
3. 群里 @ 她说一句「你好」；
4. 再试一个真实任务，比如：

```text
@<鲸鱼娘名字> 帮我看看工作区里最新的日志，整理成一份摘要
```

---

## 5. 各组件到底在做什么

### 5.1 闲聊

```text
微信/网页 → 鲸鱼娘 → 插件 /v1/chat/completions → DSH 会话 → 回复
```

- 每个聊天（微信私聊/群聊/网页会话）映射一个固定的 DSH session；
- 群聊只把「当前这条消息 + 发言人」交给 DSH，历史由 DSH 会话维护；
- 发「新会话 / 换个话题 / reset」可清空该聊天映射。

### 5.2 需要动手

DSH 判断需要工具时，在自己的工作区里执行：

- 读写文件；
- 跑命令；
- 查资料并整理；
- 多步任务。

任务完成后的最终文本回到聊天。

### 5.3 文件

入站：

```text
微信/网页文件 → 桥接下载到本地 → 消息里追加 [Shared attachment] file: <绝对路径>
→ DSH 直接读这个路径
```

出站：

```text
DSH 把产物写到 <工作区>\.whale-bridge\outbox\
→ 插件登记文件 → 回复里附下载链接 / 微信文件消息
```

### 5.4 回执

- 文档/PDF 这类慢任务开始时，由 **DSH 自己生成**一句自然回执；
- 不是固定模板，能结合当前对话和人设；
- 图片、表情、普通闲聊不触发回执。

### 5.5 流式 text

- DSH 产生的 `text` 片段会经鲸鱼娘状态流回到聊天；
- 最终文本会和已发片段去重，避免重复；
- 不是所有模型/任务都会输出多段，有时只有一段最终结果。

---

## 5.6 人设与记忆边界

> **⚠️ 重点：长期鲸鱼娘记忆不会自动进入 DSH。**  
> 切到 `brain=dsh` 后，DSH 只看到自己 session 的历史；鲸鱼娘长期记住的偏好、约定、项目历史不会自动带过去，也不会自动回写。迁移前要手动导出/总结/注入。

- 人设只在**新建 DSH 会话**时注入；已有会话改人设不生效，要发「新会话 / reset」；
- DSH 自己保存每个聊天的 session 历史，这是 DSH 侧记忆；
- 鲸鱼娘自己的记忆和 DSH session **不会自动同步**；
- DSH 不会自动生成长期记忆，也不会写回鲸鱼娘 `store.json`；
- 不要假设“鲸鱼娘记得 = DSH 记得”。

完整说明见 [docs/persona-memory.md](persona-memory.md)。

> **仓库没有实现长期记忆同步；如果你需要，可以按文档里的扩展方案自己补。**

### 5.7 如果你想自己补长期记忆

推荐从插件侧做，不要直接改鲸鱼娘 `store.json`：

1. 在 `%USERPROFILE%\.dsh\whale-bridge\memory\` 下按 `chatKey` 存独立记忆文件；
2. 每 N 轮或任务结束后，让 DSH 提炼事实/偏好/约定/未完成项；
3. 新 DSH 会话时，把摘要作为 `【长期记忆】` 注入 prompt；
4. 做去重、更新、长度控制和隐私过滤；
5. 可选：通过鲸鱼娘导出/适配层回写，但保持原文件可回滚。

参考位置：`lib/llm-proxy.js` 的 `completeDshChat` 和 `lib/persona.js`。

## 6. 常用配置

插件设置文件：

```text
%USERPROFILE%\.dsh\whale-bridge\settings.json
```

常用字段：

```json
{
  "port": 8789,
  "workspace": "D:\\your-work",
  "permission": "workspace-write",
  "mode": "standard",
  "brain": "dsh",
  "timeoutMs": 600000,
  "statusIntervalSec": 30,
  "files": {
    "enabled": true,
    "autoOutbox": true,
    "maxFileMB": 500
  }
}
```

鲸鱼娘配置：

```text
<鲸鱼娘目录>\config.json
<鲸鱼娘目录>\data\settings.json
```

群聊行为常见字段：

```json
{
  "group": {
    "requireAt": true,
    "freeChat": true,
    "freeChatChance": 0.1,
    "masterAlwaysReply": false,
    "engagedMinutes": 20,
    "maxRepliesPerHour": 100
  }
}
```

- `freeChatChance`：普通群消息主动搭话概率；
- `requireAt`：是否必须 @/叫名字/引用才回；
- `engagedMinutes`：同一话题的连续对话窗口；
- `masterAlwaysReply`：主人不 @ 是否必回。

---

## 7. 常见问题排查

### 7.1 面板显示「部分离线」

看「微信链路」卡片：

| 现象 | 处理 |
|---|---|
| DSH 插件在线，鲸鱼娘未运行 | 点「一键启动全链路」 |
| 鲸鱼娘运行，但微信桥接离线 | 点一键启动；或手动 `启动微信桥接.bat` |
| 桥接在线，但账号不匹配 | 检查微信登录账号/账号目录 |
| UIA 未就绪 | 等 20 秒，桥接心跳会更新 |

注意：面板的「在线」是**聚合状态**，不是只看插件 HTTP 是否响应。

### 7.2 8787 没监听

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen
```

没有结果 = 鲸鱼娘网页服务没启动：

- 面板点一键启动；
- 或双击 `启动鲸鱼娘.bat`；
- 看鲸鱼娘日志 `data\whale.log`。

### 7.3 8789 没监听

说明 DSH 里的插件没加载：

- 确认 DSH 正在运行；
- 在 DSH 插件管理里确认 `dsh-whale-bridge` 已启用；
- 重载插件后刷新页面；
- 看 `%USERPROFILE%\.dsh\whale-bridge\bridge.log`。

### 7.4 出现「端口只允许使用一次 / OSError 10048」

已经有一个桥接在跑。不要重复启动：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'wechatauto_bridge' } |
  Select-Object ProcessId, Name, CreationDate
```

只保留一个。

### 7.5 微信能收消息但不回

看桥接日志：

```text
<鲸鱼娘目录>\data\wechat-bridge-4x.log
```

常见原因：

- 群里没 @/没叫名字、且 freeChat 随机没命中 → 正常静默；
- 鲸鱼娘服务连不上 → 启动 8787；
- 发送前验证失败 → 桥接会拒发，宁可静默也不发错群；
- 微信窗口被其他窗口挡住 → 发送器会自动临时置顶微信。

### 7.6 DSH 任务很慢

- 大文件/PDF/多页文档正常会比聊天慢；
- 单任务默认上限 10 分钟；
- 看面板「最近任务」和插件日志里的 `[task] ok` / `[stream]`。

### 7.7 DSH 升级后不工作

1. 刷新/重载 DSH；
2. 重新启用「鲸鱼娘桥接」；
3. 面板「重建任务 profile」；
4. 检查插件是否兼容当前 DSH；
5. 鲸鱼娘和微信桥接是独立进程，升级 DSH 不需要重装鲸鱼娘。

---

## 8. 安全边界

- 插件只监听 `127.0.0.1`，不要端口转发到公网；
- 桥接 HTTP API 本机无鉴权，任何本机程序都能调用；
- `danger-full-access` 等于让 DSH 有本机完整工具权限，日常建议 `workspace-write`；
- API Key、Cookie、微信数据库都只在本地，不要提交到仓库或发给别人；
- 建议用**单独的微信小号**跑自动化，不用主号；
- 陌生人/陌生群应限制进入 DSH（配置里的信任规则）；
- 定期备份 `config.json`、`settings.json`、`persona.md`。

---

## 9. 升级与回滚

### 升级插件

1. 替换插件目录；
2. 重新运行 `install-dsh-plugin.ps1`（幂等）；
3. 刷新 DSH 页面；
4. 检查 `/api/health`。

### 升级鲸鱼娘

鲸鱼娘升级可能覆盖：

- `web/index.html`；
- 部分 `src` 文件（如果打过补丁）。

升级后：

1. 重跑一次「接入鲸鱼娘」；
2. 重跑 `whale-side\install-whale-side.ps1`（如果用了）；
3. 重启鲸鱼娘服务。

### 卸载

```powershell
cd <插件目录>
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-dsh-plugin.ps1
```

它会还原 profile 的 `package.json` 并移除 junction。

---

## 10. 可选扩展

这些不是接入 DSH 的必需项，按需再加：

- **微信接入**：桥接 Python 进程轮询微信数据库，Win32/UIA 发送；需要处理窗口焦点、账号选择、文件发送；
- **群聊行为**：@/叫名字/引用必回、普通消息随机接话、20 分钟 engaged 上下文；
- **B站视频理解**：桥接检测 B 站链接/卡片，下载低码率视频、抽帧九宫格、取字幕/弹幕/评论，再交给 DSH 总结；
- **文件通路**：PDF/图片/文档进出，outbox 自动收集；
- **定时/主动消息**：鲸鱼娘侧 care/digest，默认关闭。

这些扩展都建立在同一条主链路上：

```text
鲸鱼娘 ↔ 8787 ↔ 8789 插件 ↔ DSH
```

主链路先跑通，再逐项加，不要一开始全开。

---

## 11. 参考文件

- 插件目录：`<插件目录>`
- 插件 README：`<插件目录>\README.md`
- 插件安装脚本：`<插件目录>\install-dsh-plugin.ps1`
- 插件配置：`%USERPROFILE%\.dsh\whale-bridge\settings.json`
- 插件日志：`%USERPROFILE%\.dsh\whale-bridge\bridge.log`
- 鲸鱼娘目录：`<鲸鱼娘目录>`
- 鲸鱼娘配置：`<鲸鱼娘目录>\config.json`
- 鲸鱼娘日志：`<鲸鱼娘目录>\data\whale.log`
- 微信桥接：`<鲸鱼娘目录>\examples\wechatauto_bridge.py`
- 微信桥接日志：`<鲸鱼娘目录>\data\wechat-bridge-4x.log`
- 本机安装/联通记录：`<DSH工作区>\docs\reports\2026-11-03-鲸鱼娘DSH桥接安装与联通记录.md`

---

## 12. 一页速查

```text
1. 装插件：install-dsh-plugin.ps1
2. 刷新 DSH，左侧栏「鲸鱼娘桥接」
3. 配：workspace / permission / mode / brain=dsh
4. 点「接入鲸鱼娘」（写 config 指向 8789）
5. 点「一键启动全链路」（鲸鱼娘 + 微信桥接）
6. 验证：8787 / 8789 / chain.online=true
7. 网页聊天 → 微信私聊 → 群聊 @ → 真实任务
8. 出问题先看：面板微信链路、bridge.log、whale.log、wechat-bridge-4x.log
```

完成。

---

## 13. 新版鲸鱼娘适配清单

如果你拿到的是新版鲸鱼娘，而本包参考实现基于老版本，先做这几件事：

### 13.1 先比较，不要覆盖
至少比较这些文件：

```text
<鲸鱼娘目录>\src\llm.js
<鲸鱼娘目录>\src\bot.js
<鲸鱼娘目录>\examples\wechatauto_bridge.py
<鲸鱼娘目录>\examples\bridge_modules\*.py
```

- `src/llm.js`：请求头 `x-whale-chat` / `x-whale-trust`，以及本地通道超时；
- `src/bot.js`：各处模型调用是否带 `chatKey` / `trust`；
- `wechatauto_bridge.py`：群聊 @/引用判断、文件通道、发送器调用；
- `bridge_modules`：Win32 发送、文件校验、B 站扩展。

新版可能已经改了这些位置。能合并就合并，不能合并就先只跑「网页聊天 → DSH」，微信桥接作为第二阶段。

### 13.2 用补丁脚本，而不是整文件覆盖
插件自带：

```bat
"<鲸鱼娘目录>\runtime\node.exe" "<插件目录>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>"
```

它负责 `x-whale-chat` / `x-whale-trust` 的核心接入，并带自动备份/回滚：

```bat
"<鲸鱼娘目录>\runtime\node.exe" "<插件目录>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>" --revert
```

微信桥接那部分没有通用补丁脚本，参考包里的 `wechatauto_bridge.py` + `bridge_modules` 自行对比合并。

### 13.3 先跑最小链路
推荐顺序：

```text
鲸鱼娘网页聊天 → 插件 /v1 → DSH 会话
→ 再开微信私聊
→ 再开群聊 @
→ 最后才开文件/图片/B站等扩展
```

## 14. 给 DSH 留空间

这个方案刻意不锁死 DSH 侧：

- **大脑**：`brain=upstream` 用鲸鱼娘原来的模型；`brain=dsh` 让 DSH 直接生成聊天。两种都能接插件；
- **模型**：插件不强制模型，按你的 DSH 已登录账号/模型设置走；
- **权限**：`read-only` / `workspace-write` / `danger-full-access` 自选；普通网友建议先 `workspace-write`；
- **模式**：`standard` 够用；`creator` 才让任务 agent 管插件；
- **工作区**：不要求固定路径，填你自己的项目目录；
- **会话**：每个聊天一个 DSH session；也可以给视频/文件任务单独传 sessionId；
- **人设**：`persona.md` 独立，不跟 DSH 全局提示词绑死。

教程里的路径、端口、权限、群聊概率都只是示例，按你自己的环境改。

## 15. 版本差异与已知坑

- 鲸鱼娘升级可能覆盖 `web/index.html`、`/debug` 注入、`src` 补丁 → 重跑接入/补丁；
- 微信 4.x 的 UI 自动化会随版本变化，发送失败先看日志，不要反复点；
- 中文路径不是绝对不能跑，但 UIA/子进程相关失败会更多；
- DSH 升级后插件可能需要重载/重建 profile；
- 桥接重复启动会报 `OSError(10048)`，只保留一个；
- `danger-full-access` 等于把本机工具权限交给 agent，陌生网友/群聊不要开。

---

**最后提醒：本包是参考实现，不是官方发行版。**  
遇到新版鲸鱼娘，以「能独立运行的新版」为准，把本包当补丁思路和排障参考，不要盲目整目录覆盖。