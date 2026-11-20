# whale-dsh-bridge

把 **鲸鱼娘（whale-girl）** 接到 **DeepSeek Harness（DSH）** 的参考实现。

- 鲸鱼娘继续负责人设、记忆、微信/网页聊天入口和群聊触发；
- **当前参考部署使用 `brain=dsh`：聊天回复本身也交给 DSH 会话生成**，工具任务也由 DSH 执行；
- 另保留 `brain=upstream` 旧模式：鲸鱼娘自己的模型负责闲聊，需要动手时才调用 `dsh_task`；
- 结果回到聊天；
- DSH 侧边栏提供「鲸鱼娘桥接」面板，管理状态、权限、工作区、任务和接入。

> **这不是官方发行版，也不是鲸鱼娘 fork。**  
> 这里保存的是桥接层和适配脚本。鲸鱼娘本体（上游）：https://github.com/Banan1cee/whale_girl

---

## 它解决什么问题

鲸鱼娘本身是聊天壳，擅长聊天，不适合长期执行本机任务。  
DSH 擅长在本地工作区里调工具，但没有微信聊天壳。

这个项目把两边接起来：

```text
微信 / 鲸鱼娘网页
        │
        ▼
鲸鱼娘服务（默认 127.0.0.1:8787）
        │ provider=custom
        ▼
dsh-whale-bridge（DSH 插件，默认 127.0.0.1:8789）
        │
        ▼
DSH 会话 / 任务 / 工具
```

### 两种聊天模式

| 模式 | 聊天回复由谁生成 | 什么时候用 DSH |
|---|---|---|
| `brain=dsh`（当前参考部署） | DSH 会话 | 每一轮聊天都走 DSH；工具也由 DSH 调 |
| `brain=upstream`（旧模式） | 鲸鱼娘原来的上游模型 | 只有需要动手时，模型调用 `dsh_task` |

面板里的「大脑」就是切换这个模式。  
如果你是照着本机参考部署装，默认用 `brain=dsh`。

主链路只有两个端口：

- `8787`：鲸鱼娘网页服务；
- `8789`：DSH 插件 HTTP API。

---

## 版本

本参考实现验证过的环境：

| 组件 | 版本 |
|---|---|
| DSH | `0.2.2-rc.3` |
| 鲸鱼娘 | `3.60` |
| `dsh-whale-bridge` | `0.2.0` |

鲸鱼娘后续版本可能修改了 `src/llm.js`、`src/bot.js`、微信桥接或网页。  
升级后请**对比合并**，不要直接整文件覆盖。详见 [docs/tutorial.md](docs/tutorial.md) 的「新版鲸鱼娘适配清单」。

## 功能覆盖与边界

| 能力 | 本仓库是否覆盖 | 条件 |
|---|---|---|
| DSH 原生聊天（网页/微信聊天交给 DSH 会话） | ✅ 插件 | DSH 版本兼容、插件启用 |
| DSH 任务/工具执行 | ✅ 插件 + DSH | 工作区/权限配置正确 |
| 面板聚合状态、一键启动全链路 | ✅ 插件 | 8787/8789 都可启动 |
| 微信私聊/群聊文字收发 | ⚠️ 参考桥接 | 需要把 `bridge-reference/` 与你的鲸鱼娘桥接对比合并 |
| 文件入站/出站 | ⚠️ 参考桥接 | 需要文件通道配置与桥接合并 |
| 流式 text、任务回执 | ✅ 插件 | 取决于 DSH 输出事件 |
| 引用/上下文判断 | ⚠️ 参考桥接 | 需要合并 quote 处理逻辑 |
| B 站视频理解 | ⚠️ 可选 | 需要 `bili_watch.py` + 本地 B 站登录 Cookie |
| 群聊概率/主动消息/人设 | ❌ 不含个人配置 | 需要在各自环境单独配置 |

**结论：核心「鲸鱼娘 ↔ DSH」链路可以复现；微信自动化、文件、B 站等扩展是参考实现，取决于版本和环境，不能保证 100% 复刻。**

## 人设与记忆边界

- **人设**：`personaFile`（默认 `%USERPROFILE%\.dsh\whale-bridge\persona.md`）只在新建 DSH 会话时注入；已有会话不会自动更新，需要发「新会话 / reset」。
- **DSH 记忆**：每个聊天 `chatKey → DSH session`；上下文由 DSH session 自己持久化，群聊/私聊分开。
- **鲸鱼娘记忆**：和 DSH session 是两套，目前**不会自动互相同步**。
- **反向记忆**：DSH 不会自动把聊天总结成鲸鱼娘 memory，也不会写回 `store.json`。
- 面板「清空该会话记忆」清的是鲸鱼娘侧记忆，不是 DSH session。

完整说明见 [docs/persona-memory.md](docs/persona-memory.md)。

---

## 目录

```text
AGENTS.md                  DSH 安装/适配执行规则
plugin/dsh-whale-bridge/   DSH 插件源码（安装入口）
bridge-reference/          参考：老版本微信桥接修改（不直接覆盖）
docs/tutorial.md           完整安装/配置/验证/排障教程
docs/install-with-dsh.md   给 DSH 的安装任务说明
docs/versions.md           版本与兼容性
docs/persona-memory.md     人设与记忆边界
scripts/                   辅助脚本
```

插件内部还带有：

- `whale-side/patch-whale-native.mjs`：给鲸鱼娘打 DSH 原生聊天补丁；
- `whale-side/install-whale-side.ps1`：接入配置/调试卡片；
- `whale-side/check-native-chain.mjs`：链路自检。

---

## 让 DSH 自己装

这个仓库是**写给 DSH agent 读的**。  
把仓库目录交给 DSH，然后说：

```text
请先阅读当前目录的 AGENTS.md 和 docs/install-with-dsh.md，
按里面的步骤在这台机器上安装并验证，先只做最小链路。
```

DSH 会先检查环境、给出计划、再逐步安装；详细提示词和验收标准见：

**[docs/install-with-dsh.md](docs/install-with-dsh.md)**

---

## 快速开始

### 1. 前置条件

- Windows 10/11；
- DSH 桌面端已安装并登录；
- 鲸鱼娘能独立启动、网页聊天能回；
- 如果接微信，需要微信 4.x 已登录；
- 接受改路径、看日志、跑 PowerShell。

### 2. 安装插件

```powershell
cd <解压目录>\plugin\dsh-whale-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-dsh-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
```

如果你的 DSH 使用其他 profile，把 `-ProfileDir` 换成实际目录。

刷新 DSH 页面后，左侧栏应出现「鲸鱼娘桥接」。

### 3. 配置

在面板里设置：

- 工作区：DSH 任务实际读写的目录；
- 权限：建议先 `workspace-write`；
- 模式：`standard`；
- 大脑：`brain=dsh`（DSH 直接聊天）或 `upstream`（保留上游模型）；
- 人设：`persona.md`。

### 4. 给鲸鱼娘打补丁

`brain=dsh` 需要让鲸鱼娘请求带上聊天映射/信任头：

```bat
"<鲸鱼娘目录>\runtime\node.exe" "<插件目录>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>"
```

回滚：

```bat
"<鲸鱼娘目录>\runtime\node.exe" "<插件目录>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>" --revert
```

### 5. 接入并启动

在面板点「接入鲸鱼娘」，然后点「一键启动全链路」。

一键启动会：

1. 启动/检查鲸鱼娘；
2. 启动/检查微信桥接；
3. 等桥接心跳、UIA、微信账号就绪；
4. 返回聚合状态。

完整步骤、验证命令、日志位置、常见问题见：

**[docs/tutorial.md](docs/tutorial.md)**

---

## 能力

- DSH 原生聊天：每个微信/网页聊天映射一个 DSH session；
- 需要动手的任务交给 DSH agent；
- 微信/网页文件进出；
- DSH 产物自动从 outbox 收集并发送；
- 群聊 @/叫名字/引用必回，普通消息可配置随机接话；
- 任务回执由 DSH 生成，不是固定模板；
- 面板聚合「插件 + 鲸鱼娘 + 桥接 + 账号」真实状态；
- 一键启动全链路。

---

## 安全

- 插件只监听 `127.0.0.1`，不要转发到公网；
- 本机 HTTP API 无鉴权，任何本机程序都能调用；
- `danger-full-access` 等于把本机工具权限交给 agent，谨慎使用；
- 建议用单独的微信账号跑自动化；
- 仓库不包含 API Key、Cookie、微信数据库；配置请放在本机，不要提交。

---

## 上游仓库

鲸鱼娘本体：**https://github.com/Banan1cee/whale_girl**

本仓库不包含鲸鱼娘源码，只包含桥接层、DSH 插件和适配说明。安装前请先从上游获取并确认鲸鱼娘能独立运行。

## 上游与许可

- 鲸鱼娘：MIT License，版权归鲸鱼娘上游作者/贡献者所有；
- 本仓库的桥接插件与文档：MIT License；
- `bridge-reference/` 中的微信桥接文件是**基于鲸鱼娘 3.60 的参考修改**，仅供对比合并；上游代码版权仍归原作者；
- 使用/分发时请保留上游版权声明。

见 [LICENSE](LICENSE)。

---

## 相关文档

- [安装与配置教程](docs/tutorial.md)
- [版本与兼容性](docs/versions.md)
- [桥接参考文件说明](bridge-reference/README.md)
