# -*- coding: utf-8 -*-
"""纯 Win32 微信发送器（B 方案原型）。

不 import uiautomation / comtypes：
  - 找微信主窗：win32gui.EnumWindows
  - 恢复/聚焦：ShowWindow + SetForegroundWindow + AttachThreadInput
  - 打开会话：Ctrl+F 搜索 → 剪贴板粘贴会话名 → Enter
  - 发送文本：点击输入区 → 剪贴板文本 → Ctrl+V → Enter
  - 发送文件：点击输入区 → 剪贴板 CF_HDROP → Ctrl+V → Enter
  - 确认：读微信只读数据库（wechatauto.db.WeChatDB）

这是独立模块，先给命令行/后续 worker 用；bridge 里暂不自动接管。
"""
from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
from ctypes import wintypes
from typing import Any, Optional, Tuple

try:
    import win32api
    import win32clipboard
    import win32con
    import win32gui
except Exception as exc:  # pragma: no cover
    raise RuntimeError("需要 pywin32（win32gui/win32clipboard）") from exc


# ---------------------------------------------------------------------------
# SendInput mouse/keyboard
# ---------------------------------------------------------------------------
class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", _MOUSEINPUT), ("ki", _KEYBDINPUT)]


class _INPUT(ctypes.Structure):
    _fields_ = [("type", ctypes.c_ulong), ("u", _INPUT_UNION)]


_INPUT_MOUSE = 0
_INPUT_KEYBOARD = 1
_KEYEVENTF_KEYUP = 0x0002
_MOUSEEVENTF_MOVE = 0x0001
_MOUSEEVENTF_ABSOLUTE = 0x8000
_MOUSEEVENTF_LEFTDOWN = 0x0002
_MOUSEEVENTF_LEFTUP = 0x0004


def _send_input_mouse(x: int, y: int) -> None:
    sw = win32api.GetSystemMetrics(0)
    sh = win32api.GetSystemMetrics(1)
    nx = int(x * 65535 / max(1, sw - 1))
    ny = int(y * 65535 / max(1, sh - 1))
    for flags in (_MOUSEEVENTF_MOVE | _MOUSEEVENTF_ABSOLUTE, _MOUSEEVENTF_LEFTDOWN, _MOUSEEVENTF_LEFTUP):
        item = _INPUT(type=_INPUT_MOUSE)
        item.u.mi = _MOUSEINPUT(nx, ny, 0, flags, 0, None)
        ctypes.windll.user32.SendInput(1, ctypes.byref(item), ctypes.sizeof(_INPUT))
        time.sleep(0.03)


def _send_input_key(vk: int) -> None:
    for flags in (0, _KEYEVENTF_KEYUP):
        item = _INPUT(type=_INPUT_KEYBOARD)
        item.u.ki = _KEYBDINPUT(vk, 0, flags, 0, None)
        ctypes.windll.user32.SendInput(1, ctypes.byref(item), ctypes.sizeof(_INPUT))
        time.sleep(0.03)


def _send_input_unicode(ch: str) -> None:
    for flags in (0x0004, 0x0004 | _KEYEVENTF_KEYUP):  # KEYEVENTF_UNICODE
        item = _INPUT(type=_INPUT_KEYBOARD)
        item.u.ki = _KEYBDINPUT(0, ord(ch), flags, 0, None)
        ctypes.windll.user32.SendInput(1, ctypes.byref(item), ctypes.sizeof(_INPUT))
        time.sleep(0.01)


def _ctrl_key(vk: int) -> None:
    _send_input_key(0x11)  # Ctrl down
    _send_input_key(vk)
    _send_input_key(0x11)  # Ctrl up (keyup twice is tolerated)
    # 上面的 Ctrl up 实际发的是 down；再补一次 up
    item = _INPUT(type=_INPUT_KEYBOARD)
    item.u.ki = _KEYBDINPUT(0x11, 0, _KEYEVENTF_KEYUP, 0, None)
    ctypes.windll.user32.SendInput(1, ctypes.byref(item), ctypes.sizeof(_INPUT))


# 更可靠的 Ctrl：单独封装
def _key_down(vk: int) -> None:
    item = _INPUT(type=_INPUT_KEYBOARD)
    item.u.ki = _KEYBDINPUT(vk, 0, 0, 0, None)
    ctypes.windll.user32.SendInput(1, ctypes.byref(item), ctypes.sizeof(_INPUT))


def _key_up(vk: int) -> None:
    item = _INPUT(type=_INPUT_KEYBOARD)
    item.u.ki = _KEYBDINPUT(vk, 0, _KEYEVENTF_KEYUP, 0, None)
    ctypes.windll.user32.SendInput(1, ctypes.byref(item), ctypes.sizeof(_INPUT))


def _ctrl_combo(vk: int) -> None:
    _key_down(0x11)
    _key_down(vk)
    _key_up(vk)
    _key_up(0x11)


# ---------------------------------------------------------------------------
# clipboard
# ---------------------------------------------------------------------------
def _clipboard_open(timeout: float = 1.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            win32clipboard.OpenClipboard()
            return True
        except Exception:
            time.sleep(0.05)
    return False


def _set_clipboard_text(text: str) -> bool:
    for _ in range(3):
        if not _clipboard_open():
            continue
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, text)
            win32clipboard.CloseClipboard()
            return True
        except Exception:
            try:
                win32clipboard.CloseClipboard()
            except Exception:
                pass
            time.sleep(0.1)
    return False


def _set_clipboard_files(paths: list[str]) -> bool:
    import struct
    # pywin32 不能直接塞 tuple；CF_HDROP 需要 DROPFILES 结构 + UTF-16 路径
    data = struct.pack("<IiiII", 20, 0, 0, 0, 1)
    for p in paths:
        data += (os.path.abspath(p) + "\0").encode("utf-16le")
    data += "\0".encode("utf-16le")
    for _ in range(3):
        if not _clipboard_open():
            continue
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardData(win32clipboard.CF_HDROP, data)
            win32clipboard.CloseClipboard()
            return True
        except Exception:
            try:
                win32clipboard.CloseClipboard()
            except Exception:
                pass
            time.sleep(0.1)
    return False


# ---------------------------------------------------------------------------
# window
# ---------------------------------------------------------------------------
class Win32Sender:
    def __init__(self, hwnd: Optional[int] = None, db: Any = None, settle: float = 0.8):
        self.hwnd = int(hwnd or 0) or self.find_main_window()
        if not self.hwnd:
            raise RuntimeError("找不到微信主窗口")
        self.db = db
        self.settle = settle
        self._last_chat = ""
        self._gui = None

    @staticmethod
    def find_main_window() -> int:
        found = []

        def _cb(hwnd, _):
            try:
                if not win32gui.IsWindowVisible(hwnd):
                    return True
                cls = win32gui.GetClassName(hwnd) or ""
                title = win32gui.GetWindowText(hwnd) or ""
                if "mmui::MainWindow" in cls:
                    rect = win32gui.GetWindowRect(hwnd)
                    area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
                    found.append((area, hwnd))
                    return True
                if title in ("微信", "Weixin") and ("Qt" in cls or "mmui" in cls):
                    rect = win32gui.GetWindowRect(hwnd)
                    area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
                    found.append((area, hwnd))
            except Exception:
                pass
            return True

        try:
            win32gui.EnumWindows(_cb, None)
        except Exception:
            pass
        found.sort(reverse=True)
        return found[0][1] if found else 0

    def snapshot(self) -> dict:
        snap = {"hwnd": self.hwnd, "fg": 0, "iconic": False}
        try:
            snap["fg"] = int(win32gui.GetForegroundWindow())
            snap["iconic"] = bool(win32gui.IsIconic(self.hwnd))
            if win32gui.IsWindowVisible(self.hwnd) is False:
                snap["hidden"] = True
        except Exception:
            pass
        return snap

    def restore_state(self, snap: dict) -> None:
        try:
            if snap.get("iconic"):
                win32gui.ShowWindow(self.hwnd, win32con.SW_MINIMIZE)
            fg = int(snap.get("fg") or 0)
            if fg and fg != self.hwnd and win32gui.IsWindow(fg):
                try:
                    win32gui.SetForegroundWindow(fg)
                except Exception:
                    pass
        except Exception:
            pass

    def focus_window(self) -> bool:
        try:
            if win32gui.IsIconic(self.hwnd) or not win32gui.IsWindowVisible(self.hwnd):
                win32gui.ShowWindow(self.hwnd, win32con.SW_RESTORE)
            try:
                ctypes.windll.user32.AllowSetForegroundWindow(-1)
            except Exception:
                pass
            thread_fg = ctypes.windll.kernel32.GetCurrentThreadId()
            target_tid = ctypes.windll.user32.GetWindowThreadProcessId(self.hwnd, None)
            try:
                ctypes.windll.user32.AttachThreadInput(thread_fg, target_tid, True)
            except Exception:
                pass
            win32gui.ShowWindow(self.hwnd, win32con.SW_RESTORE)
            # 先临时置顶，绕开 Windows 前台锁；DSH 窗口在前台时也能把微信抬起来
            try:
                win32gui.SetWindowPos(self.hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                                      win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
            except Exception:
                pass
            win32gui.BringWindowToTop(self.hwnd)
            win32gui.SetForegroundWindow(self.hwnd)
            time.sleep(0.2)
            # 恢复普通层级，但保持在前台
            try:
                win32gui.SetWindowPos(self.hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                                      win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
            except Exception:
                pass
            return int(win32gui.GetForegroundWindow()) == int(self.hwnd)
        except Exception:
            return False

    def _focus_window_retry(self, attempts: int = 3) -> bool:
        for _ in range(max(1, attempts)):
            if self.focus_window():
                return True
            try:
                win32gui.ShowWindow(self.hwnd, win32con.SW_RESTORE)
            except Exception:
                pass
            time.sleep(0.8)
        return False

    def _rect(self) -> Tuple[int, int, int, int]:
        return win32gui.GetWindowRect(self.hwnd)

    def _click_input_box(self) -> bool:
        left, top, right, bottom = self._rect()
        w = max(1, right - left)
        h = max(1, bottom - top)
        # 右侧聊天区中心偏下；微信 4.x 输入框在窗口底部约 82%-93% 高度
        x = left + int(w * 0.62)
        y = top + int(h * 0.88)
        _send_input_mouse(x, y)
        time.sleep(0.25)
        return True

    def _verify_current_chat_detail(self, chat_name: str) -> dict:
        """返回当前会话验证详情，失败时写下实际读到的会话名。"""
        detail = {"expected": chat_name, "current": "", "error": "", "ok": False}
        try:
            script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "verify_chat.py")
            r = subprocess.run(
                [sys.executable, script],
                capture_output=True, timeout=10,
            )
            stdout = (r.stdout or b"").decode("utf-8", "replace")
            line = stdout.strip().splitlines()[-1] if stdout.strip() else ""
            data = json.loads(line) if line else {}
            cur = str(data.get("current") or "").strip()
            detail["current"] = cur
            detail["error"] = str(data.get("error") or "")
            if cur:
                detail["ok"] = (cur == chat_name or (len(chat_name) >= 2 and chat_name in cur)
                                or (len(cur) >= 2 and cur in chat_name))
        except Exception as exc:
            detail["error"] = str(exc)
        self._last_verify_detail = detail
        return detail

    def _verify_current_chat(self, chat_name: str) -> bool:
        return bool(self._verify_current_chat_detail(chat_name).get("ok"))

    def _open_chat_ocr(self, chat_name: str) -> bool:
        """慢速兜底：只在 UIA 验证不匹配/不可用时用 OCR 打开一次。"""
        try:
            if self._gui is None:
                from wechatauto import WeChatGUI
                self._gui = WeChatGUI(hwnd=self.hwnd)
                self._gui._uia = None
                self._gui._uia_tried = True
                self._gui._get_uia = lambda *a, **k: None
            try:
                self._gui.ensure_visible()
            except Exception:
                pass
            try:
                self._gui._update_render_rect()
            except Exception:
                pass
            self._gui.open_chat(chat_name)
            time.sleep(0.5)
            return bool(self._gui._chat_is_open(chat_name))
        except Exception:
            return False

    def _open_chat_verified(self, chat_name: str) -> bool:
        if not chat_name:
            return False
        if self._verify_current_chat(chat_name):
            self._last_chat = chat_name
            return True
        if not self._open_chat_by_search(chat_name):
            return False
        if self._verify_current_chat(chat_name):
            self._last_chat = chat_name
            return True
        # UIA 不匹配时才落到 OCR 兜底（慢，但只在异常路径）
        if self._open_chat_ocr(chat_name) and self._verify_current_chat(chat_name):
            self._last_chat = chat_name
            return True
        return False

    def _open_chat_verified_retry(self, chat_name: str, attempts: int = 3) -> bool:
        """发送前验证目标会话；偶发前台/焦点变化时重试，仍不确认才拒发。"""
        for i in range(max(1, attempts)):
            try:
                self.focus_window()
            except Exception:
                pass
            if self._open_chat_verified(chat_name):
                return True
            time.sleep(0.8)
        return False

    def _open_chat_by_search(self, chat_name: str) -> bool:
        if not chat_name:
            return False
        self.focus_window()
        _ctrl_combo(0x46)  # Ctrl+F
        time.sleep(0.35)
        if not _set_clipboard_text(chat_name):
            return False
        _ctrl_combo(0x56)  # Ctrl+V
        time.sleep(0.5)
        _send_input_key(0x0D)  # Enter
        time.sleep(self.settle)
        self._last_chat = chat_name
        return True

    def _db_recent(self, chat_username: str, limit: int = 8) -> list[dict]:
        if self.db is None or not chat_username:
            return []
        try:
            return list(self.db.get_messages(chat_username, limit=limit) or [])
        except Exception:
            return []

    def send_text(self, chat_name: str, chat_username: str, text: str, verify: bool = True) -> dict:
        snap = self.snapshot()
        try:
            if not self._focus_window_retry():
                return {"ok": False, "message": "微信窗口无法置前（已重试）"}
            if chat_name:
                if not self._open_chat_verified_retry(chat_name):
                    _d = getattr(self, "_last_verify_detail", {}) or {}
                    return {"ok": False, "message": "无法确认目标会话（期望=%r 实际=%r 错误=%s），已拒绝发送"
                            % (chat_name, _d.get("current", ""), _d.get("error", ""))}
            if not self._click_input_box():
                return {"ok": False, "message": "点击输入框失败"}
            if not _set_clipboard_text(text):
                return {"ok": False, "message": "剪贴板写入失败"}
            _ctrl_combo(0x56)
            time.sleep(0.35)
            _send_input_key(0x0D)
            time.sleep(0.6)
            if verify:
                recent = self._db_recent(chat_username)
                for item in recent:
                    if str(item.get("sender_username") or "") == str(getattr(self.db, "wxid", "")):
                        if text.strip() and text.strip() in str(item.get("content") or ""):
                            return {"ok": True, "message": "confirmed", "content": text}
                return {"ok": True, "message": "sent-unconfirmed", "content": text}
            return {"ok": True, "message": "sent", "content": text}
        finally:
            self.restore_state(snap)

    def send_file(self, chat_name: str, chat_username: str, path: str, verify: bool = True) -> dict:
        snap = self.snapshot()
        path = os.path.abspath(path)
        try:
            if not os.path.isfile(path):
                return {"ok": False, "message": "文件不存在"}
            if not self._focus_window_retry():
                return {"ok": False, "message": "微信窗口无法置前（已重试）"}
            if chat_name:
                if not self._open_chat_verified_retry(chat_name):
                    _d = getattr(self, "_last_verify_detail", {}) or {}
                    return {"ok": False, "message": "无法确认目标会话（期望=%r 实际=%r 错误=%s），已拒绝发送"
                            % (chat_name, _d.get("current", ""), _d.get("error", ""))}
            if not self._click_input_box():
                return {"ok": False, "message": "点击输入框失败"}
            if not _set_clipboard_files([path]):
                return {"ok": False, "message": "剪贴板文件写入失败"}
            _ctrl_combo(0x56)
            time.sleep(1.5)
            _send_input_key(0x0D)
            time.sleep(0.8)
            if verify:
                base = os.path.basename(path)
                recent = self._db_recent(chat_username)
                for item in recent:
                    content = str(item.get("content") or "")
                    if base in content and ("文件" in str(item.get("type") or "") or "<fileext>" in content):
                        return {"ok": True, "message": "confirmed", "file": base}
                return {"ok": True, "message": "sent-unconfirmed", "file": base}
            return {"ok": True, "message": "sent", "file": base}
        finally:
            self.restore_state(snap)


def _main(argv: list[str]) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="纯 Win32 微信发送器")
    ap.add_argument("--chat", required=True, help="会话显示名")
    ap.add_argument("--username", default="", help="会话 username（用于 DB 确认）")
    ap.add_argument("--text", default="", help="发送文本")
    ap.add_argument("--file", default="", help="发送文件路径")
    ap.add_argument("--hwnd", type=int, default=0)
    ap.add_argument("--no-restore", action="store_true", help="发送后不还原窗口")
    args = ap.parse_args(argv)
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    db = None
    try:
        from wechatauto.db import WeChatDB
        db = WeChatDB()
    except Exception as exc:
        print("DB 初始化失败（仍可发送，只是不确认）:", exc)
    sender = Win32Sender(hwnd=args.hwnd or 0, db=db)
    if args.file:
        result = sender.send_file(args.chat, args.username, args.file, verify=True)
    else:
        result = sender.send_text(args.chat, args.username, args.text, verify=True)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
    def _open_chat_ocr(self, chat_name: str) -> bool:
        """慢速兜底：只在 UIA 验证不匹配/不可用时用 OCR 打开一次。"""
        try:
            if self._gui is None:
                from wechatauto import WeChatGUI
                self._gui = WeChatGUI(hwnd=self.hwnd)
                self._gui._uia = None
                self._gui._uia_tried = True
                self._gui._get_uia = lambda *a, **k: None
            try:
                self._gui.ensure_visible()
            except Exception:
                pass
            try:
                self._gui._update_render_rect()
            except Exception:
                pass
            self._gui.open_chat(chat_name)
            time.sleep(0.5)
            return bool(self._gui._chat_is_open(chat_name))
        except Exception:
            return False

    def _open_chat_verified(self, chat_name: str) -> bool:
        if not chat_name:
            return False
        if self._verify_current_chat(chat_name):
            self._last_chat = chat_name
            return True
        if not self._open_chat_by_search(chat_name):
            return False
        if self._verify_current_chat(chat_name):
            self._last_chat = chat_name
            return True
        # UIA 不匹配时才落到 OCR 兜底（慢，但只在异常路径）
        if self._open_chat_ocr(chat_name) and self._verify_current_chat(chat_name):
            self._last_chat = chat_name
            return True
        return False

    def _open_chat_verified_retry(self, chat_name: str, attempts: int = 3) -> bool:
        """发送前验证目标会话；偶发前台/焦点变化时重试，仍不确认才拒发。"""
        for i in range(max(1, attempts)):
            try:
                self.focus_window()
            except Exception:
                pass
            if self._open_chat_verified(chat_name):
                return True
            time.sleep(0.8)
        return False

    def _open_chat_by_search(self, chat_name: str) -> bool:
        if not chat_name:
            return False
        self.focus_window()
        _ctrl_combo(0x46)  # Ctrl+F
        time.sleep(0.35)
        if not _set_clipboard_text(chat_name):
            return False
        _ctrl_combo(0x56)  # Ctrl+V
        time.sleep(0.5)
        _send_input_key(0x0D)  # Enter
        time.sleep(self.settle)
        self._last_chat = chat_name
        return True

    def _db_recent(self, chat_username: str, limit: int = 8) -> list[dict]:
        if self.db is None or not chat_username:
            return []
        try:
            return list(self.db.get_messages(chat_username, limit=limit) or [])
        except Exception:
            return []

    def send_text(self, chat_name: str, chat_username: str, text: str, verify: bool = True) -> dict:
        snap = self.snapshot()
        try:
            if not self._focus_window_retry():
                return {"ok": False, "message": "微信窗口无法置前（已重试）"}
            if chat_name:
                if not self._open_chat_verified_retry(chat_name):
                    _d = getattr(self, "_last_verify_detail", {}) or {}
                    return {"ok": False, "message": "无法确认目标会话（期望=%r 实际=%r 错误=%s），已拒绝发送"
                            % (chat_name, _d.get("current", ""), _d.get("error", ""))}
            if not self._click_input_box():
                return {"ok": False, "message": "点击输入框失败"}
            if not _set_clipboard_text(text):
                return {"ok": False, "message": "剪贴板写入失败"}
            _ctrl_combo(0x56)
            time.sleep(0.35)
            _send_input_key(0x0D)
            time.sleep(0.6)
            if verify:
                recent = self._db_recent(chat_username)
                for item in recent:
                    if str(item.get("sender_username") or "") == str(getattr(self.db, "wxid", "")):
                        if text.strip() and text.strip() in str(item.get("content") or ""):
                            return {"ok": True, "message": "confirmed", "content": text}
                return {"ok": True, "message": "sent-unconfirmed", "content": text}
            return {"ok": True, "message": "sent", "content": text}
        finally:
            self.restore_state(snap)

    def send_file(self, chat_name: str, chat_username: str, path: str, verify: bool = True) -> dict:
        snap = self.snapshot()
        path = os.path.abspath(path)
        try:
            if not os.path.isfile(path):
                return {"ok": False, "message": "文件不存在"}
            if not self._focus_window_retry():
                return {"ok": False, "message": "微信窗口无法置前（已重试）"}
            if chat_name:
                if not self._open_chat_verified_retry(chat_name):
                    _d = getattr(self, "_last_verify_detail", {}) or {}
                    return {"ok": False, "message": "无法确认目标会话（期望=%r 实际=%r 错误=%s），已拒绝发送"
                            % (chat_name, _d.get("current", ""), _d.get("error", ""))}
            if not self._click_input_box():
                return {"ok": False, "message": "点击输入框失败"}
            if not _set_clipboard_files([path]):
                return {"ok": False, "message": "剪贴板文件写入失败"}
            _ctrl_combo(0x56)
            time.sleep(1.5)
            _send_input_key(0x0D)
            time.sleep(0.8)
            if verify:
                base = os.path.basename(path)
                recent = self._db_recent(chat_username)
                for item in recent:
                    content = str(item.get("content") or "")
                    if base in content and ("文件" in str(item.get("type") or "") or "<fileext>" in content):
                        return {"ok": True, "message": "confirmed", "file": base}
                return {"ok": True, "message": "sent-unconfirmed", "file": base}
            return {"ok": True, "message": "sent", "file": base}
        finally:
            self.restore_state(snap)


def _main(argv: list[str]) -> int:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="纯 Win32 微信发送器")
    ap.add_argument("--chat", required=True, help="会话显示名")
    ap.add_argument("--username", default="", help="会话 username（用于 DB 确认）")
    ap.add_argument("--text", default="", help="发送文本")
    ap.add_argument("--file", default="", help="发送文件路径")
    ap.add_argument("--hwnd", type=int, default=0)
    ap.add_argument("--no-restore", action="store_true", help="发送后不还原窗口")
    args = ap.parse_args(argv)
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    db = None
    try:
        from wechatauto.db import WeChatDB
        db = WeChatDB()
    except Exception as exc:
        print("DB 初始化失败（仍可发送，只是不确认）:", exc)
    sender = Win32Sender(hwnd=args.hwnd or 0, db=db)
    if args.file:
        result = sender.send_file(args.chat, args.username, args.file, verify=True)
    else:
        result = sender.send_text(args.chat, args.username, args.text, verify=True)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
