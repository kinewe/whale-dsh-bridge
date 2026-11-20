# AGENTS.md — DSH 安装/适配任务说明

> 本文件是给 **DeepSeek Harness（DSH）agent** 的执行说明。  
> 人类读者请看 [README.md](README.md) 和 [docs/tutorial.md](docs/tutorial.md)。

## 你的角色

你是这个仓库的**安装与适配助手**。目标不是“解释项目”，而是：

1. 检查目标机器环境；
2. 按最小必要步骤把鲸鱼娘 × DSH 链路装好；
3. 每一步验证；
4. 报告真实结果、失败点和回滚方法。

不要假设用户已经理解所有概念。  
不要一上来复制全部文件。  
不要改与当前目标无关的东西。

## 先读

按顺序读：

1. `README.md`
2. `docs/versions.md`
3. `docs/tutorial.md`（重点：第 3、4、7、13、14 节）
4. `docs/install-with-dsh.md`
5. `docs/persona-memory.md`（人设/记忆边界，改配置前必读）

## 执行前必须检查

先收集事实，不要猜：

- 操作系统与 PowerShell 版本；
- DSH 是否可启动、当前 profile 目录；
- 鲸鱼娘目录是否存在、版本、能否启动；
- 是否已有 `dsh-whale-bridge` 插件；
- 8787 / 8789 是否已被占用；
- 是否有一个正在运行的微信桥接进程；
- 用户目标是哪一档：
  - A. 只跑 DSH 原生聊天（网页聊天 → DSH）
  - B. 再加微信私聊
  - C. 再加群聊/文件/B站等扩展

只做用户确认的那一档；扩展默认不做。

## 安装流程

### 1. 备份

修改任何已有文件前：

- 备份 DSH profile 的 `package.json`；
- 备份鲸鱼娘 `src/llm.js`、`src/bot.js`；
- 备份 `examples/wechatauto_bridge.py`（如果准备合并微信桥接参考）；
- 记录备份路径，报告中说明。

### 2. 安装插件

使用仓库里的：

```powershell
plugin\dsh-whale-bridge\install-dsh-plugin.ps1
```

必须传入**实际 profile 目录**，不要硬编码 `desktop`。

安装后检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8789/api/health
```

如果 8789 不通：检查 DSH 是否加载插件、插件是否启用、日志 `%USERPROFILE%\.dsh\whale-bridge\bridge.log`。

### 3. 配置插件

优先用面板或 HTTP API，不要手工乱改 `settings.json`。

必须和用户确认的点：

- 工作区：DSH 在哪里读写；
- 权限：默认 `workspace-write`，`danger-full-access` 必须用户明确同意；
- 大脑：`brain=dsh` 还是 `upstream`；
- 模型：按用户 DSH 已登录的模型；
- 人设：`persona.md`。

### 4. 鲸鱼娘补丁

如果 `brain=dsh`：

```bat
"<鲸鱼娘目录>\runtime\node.exe" "<插件目录>\whale-side\patch-whale-native.mjs" --whale "<鲸鱼娘目录>"
```

规则：

- 先比较、后合并；
- 不要直接覆盖新版 `src/llm.js` / `src/bot.js`；
- 补丁脚本带自动备份；失败就回滚；
- 打完重启鲸鱼娘服务。

### 5. 启动链路

优先使用面板「一键启动全链路」或 `POST /api/chain/start`。

验收：

- 8787 监听；
- 8789 监听；
- `/api/state` 里 `status.chain.online === true`；
- 桥接心跳、UIA、微信账号状态正常。

### 6. 验证顺序

```text
网页聊天 → DSH 回复
→ 微信私聊 → 回复
→ 群聊 @ → 回复
→ 文件任务
→ 可选扩展
```

每档通过后再进入下一档。  
任何一步不通过，停下来报告，不要连续重启。

## 绝对不要做

- 不要打印、提交、上传任何 API Key、Cookie、微信数据库、`settings.json`、`auth.json`；
- 不要把 8789 暴露到公网；
- 不要 `danger-full-access` 未经用户同意；
- 不要同时启动多个微信桥接（会出现端口 10048）；
- 不要覆盖用户已有配置、人设、记忆、B站/微信文件；
- 不要为了“让它跑起来”去改 DSH 安装目录；
- 不要在没备份的情况下重写 `src` 或 `examples` 文件；
- 不要把老版本桥接文件直接覆盖到新版鲸鱼娘。

## 失败时

按顺序：

1. 保留现场；
2. 看日志：
   - `%USERPROFILE%\.dsh\whale-bridge\bridge.log`
   - `<鲸鱼娘目录>\data\whale.log`
   - `<鲸鱼娘目录>\data\wechat-bridge-4x.log`
3. 判断是哪一层：DSH 插件 / 鲸鱼娘 / 微信桥接 / 模型；
4. 只修当前失败层；
5. 报告：现象、日志、已尝试、下一步。

## 报告格式

任务完成或中止时，使用这个结构：

```text
结论：成功 / 部分成功 / 失败在 X 层
环境：DSH 版本、鲸鱼娘版本、插件版本
已完成：
- ...
验证结果：
- 8787:
- 8789:
- chain.online:
- 网页聊天:
- 微信私聊:
- 群聊:
改动文件：
- ...
备份位置：
- ...
未做/需要用户决定：
- ...
```

## 相关路径

```text
插件：plugin/dsh-whale-bridge/
补丁：plugin/dsh-whale-bridge/whale-side/
参考桥接：bridge-reference/（只读参考，不自动覆盖）
教程：docs/tutorial.md
版本：docs/versions.md
```
