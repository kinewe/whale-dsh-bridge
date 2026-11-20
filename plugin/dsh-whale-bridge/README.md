# dsh-whale-bridge

DSH 侧插件：把鲸鱼娘的聊天请求接入 DeepSeek Harness（DSH），并提供桥接 HTTP 服务、文件通道和 DSH 侧边栏面板。

> **当前参考部署使用 `brain=dsh`。**
> 这意味着聊天回复也由 DSH 会话生成，不只是“需要动手时”才进 DSH。
> 完整安装/架构/排障请看仓库根目录的 [README](../../README.md) 和 [docs/tutorial.md](../../docs/tutorial.md)。

## 两种模式

| 模式 | 聊天回复 | 工具任务 |
|---|---|---|
| `brain=dsh`（当前参考部署） | DSH 会话生成 | DSH 执行 |
| `brain=upstream`（旧模式） | 鲸鱼娘上游模型生成 | 模型判断后调用 `dsh_task` |

## 安装

在插件目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-dsh-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
```

安装脚本会：

1. 备份 profile 的 `package.json`；
2. 在 profile 的 `node_modules` 下建立指向本目录的 junction；
3. 把插件加入 profile 的 bundles；
4. 探测 `http://127.0.0.1:8789/api/health`。

刷新 DSH 页面后，左侧栏出现「鲸鱼娘桥接」。

## 主要入口

- Host 侧：`index.js` → `lib/host.js` → `lib/bridge-server.js`
- DSH 任务：`lib/dsh-task.js`
- OpenAI 兼容代理：`lib/llm-proxy.js`
- 文件通道：`lib/file-channel.js`
- 人设：`lib/persona.js`
- 鲸鱼娘适配：`lib/whale-adapter.js`

## 常用 API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/health` | 插件存活 |
| GET | `/api/state` | 聚合状态 / 任务 / 文件 |
| POST | `/api/task` | 一次性 DSH 任务 |
| POST | `/api/task/stream` | SSE 流式 DSH 任务 |
| POST | `/api/chain/start` | 一键启动鲸鱼娘 + 微信桥接 |
| GET/PUT | `/api/persona` | 读取/保存人设 |
| GET/PUT | `/api/settings` | 插件设置 |

## 配置

默认配置在插件根目录的 `cordis.patch.yml`，运行时用户设置写入：

```text
%USERPROFILE%\.dsh\whale-bridge\settings.json
```

常用字段：

```json
{
  "port": 8789,
  "workspace": "D:\\dsh_workspace",
  "permission": "workspace-write",
  "mode": "standard",
  "brain": "dsh",
  "timeoutMs": 600000,
  "statusIntervalSec": 30,
  "files": { "enabled": true, "autoOutbox": true, "maxFileMB": 500 }
}
```

## 安全

- 只监听 `127.0.0.1`，不要暴露到公网；
- 本机 API 无鉴权；
- 不要把 Key、Cookie、`settings.json` 提交到仓库；
- `danger-full-access` 只在明确需要时使用。

## 历史文档

`CONTRACT.md` 是早期开发契约，部分内容以 `brain=upstream` 为例；
当前行为以仓库根 README、`docs/tutorial.md` 和本文件为准。
