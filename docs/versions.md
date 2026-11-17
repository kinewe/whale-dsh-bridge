# 版本与兼容性

## 已验证

| 组件 | 版本 |
|---|---|
| DSH | `0.2.2-rc.3` |
| 鲸鱼娘 | `3.60` |
| dsh-whale-bridge | `0.2.0` |
| 微信 | 4.x（Windows） |

## 升级鲸鱼娘时

至少比较：

```text
<鲸鱼娘目录>\src\llm.js
<鲸鱼娘目录>\src\bot.js
<鲸鱼娘目录>\examples\wechatauto_bridge.py
<鲸鱼娘目录>\examples\bridge_modules\*.py
```

重点确认：

1. 请求头 `x-whale-chat` / `x-whale-trust` 是否还在；
2. 群聊消息是否仍带 `chatKey` / `trust`；
3. 微信桥接是否改了文件/发送/群聊逻辑；
4. `web/index.html` 的注入块是否被覆盖。

## 升级 DSH 时

1. 刷新/重载 DSH；
2. 确认「鲸鱼娘桥接」插件仍启用；
3. 面板「重建任务 profile」；
4. 检查 `http://127.0.0.1:8789/api/health`；
5. 再点一键启动。

## 升级插件时

替换 `plugin/dsh-whale-bridge/` 后，重新执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-dsh-plugin.ps1 `
  -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
```

然后刷新页面。
