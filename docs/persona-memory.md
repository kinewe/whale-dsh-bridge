# 人设与记忆边界

> 这份文档说明：在当前参考实现里，**人设从哪里来、什么时候注入、DSH 记得什么、鲸鱼娘记得什么、两边是否互通**。  
> 以 `brain=dsh` 为主，同时标注 `brain=upstream` 旧模式的差异。

---

## 1. 人设

### 来源

插件设置：

```text
settings.personaFile
```

默认路径：

```text
%USERPROFILE%\.dsh\whale-bridge\persona.md
```

面板「人设」卡片修改的就是这个文件。

### 注入时机

只在**这个聊天还没有 DSH session** 时注入：

```text
persona.md
   │ 插件 loadPersonaFile 读取
   ▼
【当前聊天人设 / 聊天背景】
   │ 作为 prompt 的一部分
   ▼
DSH 新会话
```

也就是说：

- 一个私聊/群聊第一次进 DSH 时，会带上人设；
- 后续每轮不再重复注入；
- 人设由 DSH session 的历史上下文继续携带；
- 改 `persona.md` 后，**已有会话不会自动更新**；
- 要发「新会话 / 换个话题 / reset」清掉该聊天的 session 映射，下一次才会用新人设；
- 没配 `personaFile` 时，退回鲸鱼娘传入的 system 提示，再退回默认人设。

### 与 DSH 自身 system prompt 的关系

DSH profile 自己还有一层系统提示。  
`persona.md` 是桥接额外注入的对话上下文，**不替换** DSH 的全部系统设定。

### `brain=upstream` 的差异

`brain=upstream` 时：

- 闲聊由鲸鱼娘自己的模型按鲸鱼娘的人设生成；
- DSH 只执行 `dsh_task`，拿到的是一段任务说明，**不会自动继承完整人设**；
- 任务结果回到鲸鱼娘后，再由鲸鱼娘模型按人设转述。

---

## 2. 记忆

### `brain=dsh`：DSH 会话就是记忆

插件用 `chatKey` 把每个聊天映射到一个固定的 DSH session：

```text
chatKey（平台|类型|聊天ID）
   │ settings.chatSessions
   ▼
DSH sessionId
   │
   ▼
DSH 会话历史 = 这个聊天的上下文记忆
```

当前行为：

- 微信私聊一个 session；
- 微信群聊一个 session；
- 网页会话一个 session；
- 群聊每轮只把「当前消息 + 发言人」交给 DSH，前面的历史由 DSH session 承担；
- DSH session 的历史由 DSH 自己持久化；
- 发「新会话 / 重置 / reset」会删除 `chatSessions` 里这个 chatKey 的映射，下一次开新 session。

注意：

- **删除映射不等于删除旧 DSH session 文件**；
- 旧 session 只是不再被这个聊天引用；
- DSH 会话历史有自己的上下文长度限制，不是无限记忆。

### 鲸鱼娘自己的记忆

鲸鱼娘有自己的记忆存储，位置在鲸鱼娘数据目录里（例如 `data/store.json`）。  
它和 DSH session 是两套东西：

```text
鲸鱼娘 memory  ←×→  DSH session
```

当前**没有自动同步**：

- 不会把鲸鱼娘的长期记忆注入 DSH；
- 不会把 DSH 聊天自动总结成鲸鱼娘的 memory notes；
- 不会把 DSH 的结论写回 `store.json`；
- 面板里的「清空该会话记忆」清的是**鲸鱼娘自己的记忆**，不是 DSH session。

### `brain=upstream` 的差异

`brain=upstream` 时：

- 鲸鱼娘模型自己的记忆/上下文在鲸鱼娘侧；
- DSH 任务是一个独立 session，除非任务指令显式带上上下文，否则 DSH 不自动知道鲸鱼娘的记忆；
- 任务结果回传给鲸鱼娘后，才进入鲸鱼娘的会话/记忆流程。

---

## 3. 当前没有实现的能力

以下都**不是**当前参考实现的自带行为，需要额外开发：

- 从 DSH 对话自动生成长期记忆；
- 把长期记忆注入 DSH 每次新会话；
- 把 DSH 记忆写回鲸鱼娘；
- 双向同步；
- 跨设备同步；
- 自动删除旧 DSH session；
- 隐私内容自动过滤/脱敏。

## 4. 如果要扩展记忆

推荐做法：

```text
DSH 会话
   │ 每 N 轮 / 任务结束
   ▼
DSH 生成结构化记忆
   │ 事实 / 偏好 / 约定 / 未完成任务
   ▼
插件自己的 memory 文件
   │ 新会话注入 【长期记忆】
   ▼
DSH
```

不要直接改鲸鱼娘 `store.json`。  
鲸鱼娘的 `/api/memory/*` 目前主要是 info/export/backup/restore，没有安全的“追加一条笔记”接口。

---

## 5. 一句话总结

```text
人设：persona.md → 只在新建 DSH 会话时注入 → 已有会话不会自动更新
记忆：chatKey → DSH session 历史；鲸鱼娘记忆和 DSH 记忆目前互不自动同步
反向：DSH 不会自动生成/写回鲸鱼娘记忆
```
