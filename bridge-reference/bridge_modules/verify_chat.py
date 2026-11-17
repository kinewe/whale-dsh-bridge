# -*- coding: utf-8 -*-
"""独立 UIA 只读验证进程：输出当前聊天对象名。

用 wechatauto 的 WeChatUIA（它处理了本机微信 4.x 的窗口/可访问性 gate），
但仍然只读、跑在独立子进程里；父进程给 5 秒硬超时，超时就杀掉。
"""
from __future__ import annotations

import json
import os
import sys


def main() -> int:
    current = ""
    err = ""
    try:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if here not in sys.path:
            sys.path.insert(0, here)
        # 兼容本机微信 4.x：先应用窗口识别补丁，再拿 UIA
        try:
            import uia_compat
            uia_compat.apply()
        except Exception:
            pass
        from wechatauto.uia_driver import WeChatUIA

        u = WeChatUIA(timeout=3.0)
        try:
            u.ensure_window()
        except Exception:
            pass
        current = str(u.current_chat() or "").strip()
        if not current:
            raise RuntimeError("当前聊天名为空")
    except Exception as exc:  # noqa: BLE001
        err = str(exc)
    print(json.dumps({"ok": bool(current), "current": current, "error": err}, ensure_ascii=False))
    return 0 if current else 3


if __name__ == "__main__":
    sys.exit(main())
