# bridge-reference

这里是从本机运行环境整理出来的**参考文件**，不是可直接覆盖上游的补丁包。

包含：

- `wechatauto_bridge.py`：基于鲸鱼娘 3.60 的微信桥接修改；
- `bridge_modules/`：
  - `sender_win32.py`：Win32 发送、窗口置前、会话验证；
  - `verify_chat.py`：会话名只读验证；
  - `bili_watch.py`：可选的 B 站视频材料整理；
  - 其他辅助模块。

## 重要

1. 鲸鱼娘升级后，上游 `examples/wechatauto_bridge.py` 可能已经变化；
2. **不要**直接整个覆盖新版本文件；
3. 先比较上游版本与这里的差异，按需合并；
4. 这些文件仅作参考，仓库主链路是 `plugin/` + `whale-side/` 补丁；
5. 上游代码版权归鲸鱼娘作者，MIT License，保留版权声明。

## 最小使用建议

如果只是先跑通「聊天 → DSH」：

- 不需要这里的微信桥接修改；
- 装插件、打 `patch-whale-native.mjs`、用网页聊天验证即可。

确认主链路可用后，再按需合并微信文件/发送逻辑。
