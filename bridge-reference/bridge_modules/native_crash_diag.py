# -*- coding: utf-8 -*-
"""原生 access violation 诊断器（只给 bridge 用，低频、无依赖）。

目的：Python faulthandler 只能打印「崩溃时所有 Python 线程的 Python 栈」，
拿不到 faulting thread 的 native 栈。这里注册一个 first-chance VEH：
遇到 0xC0000005 时把异常线程、异常地址、读写地址和调用栈地址写进文件，
再把异常交还给 WER/faulthandler，不改变原有崩溃处理。

输出示例：
  [18:01:02] code=0xC0000005 addr=0x00007ff... thread=12345 rw=1 fault=0x...
    #00 0x00007ff... module=python312.dll +0x27e990
"""
from __future__ import annotations

import ctypes
import os
import sys
import threading
import time
import traceback
from ctypes import wintypes

_installed = False
_handler_ref = None
_fd = None

# --- ctypes structures -------------------------------------------------
class _ExceptionRecord(ctypes.Structure):
    _fields_ = [
        ("ExceptionCode", wintypes.DWORD),
        ("ExceptionFlags", wintypes.DWORD),
        ("ExceptionRecord", ctypes.POINTER(ctypes.c_void_p)),
        ("ExceptionAddress", ctypes.c_void_p),
        ("NumberParameters", wintypes.DWORD),
        ("ExceptionInformation", ctypes.c_void_p * 15),
    ]


class _ExceptionPointers(ctypes.Structure):
    _fields_ = [
        ("ExceptionRecord", ctypes.POINTER(_ExceptionRecord)),
        ("ContextRecord", ctypes.c_void_p),
    ]


_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_AddVectoredExceptionHandler = _kernel32.AddVectoredExceptionHandler
_AddVectoredExceptionHandler.argtypes = [wintypes.ULONG, ctypes.c_void_p]
_AddVectoredExceptionHandler.restype = ctypes.c_void_p
_RtlCaptureStackBackTrace = _kernel32.RtlCaptureStackBackTrace
_RtlCaptureStackBackTrace.argtypes = [wintypes.ULONG, wintypes.ULONG, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.ULONG)]
_RtlCaptureStackBackTrace.restype = wintypes.USHORT
_GetCurrentThreadId = _kernel32.GetCurrentThreadId
_GetCurrentThreadId.restype = wintypes.DWORD
_GetModuleHandleExW = _kernel32.GetModuleHandleExW
_GetModuleHandleExW.argtypes = [wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
_GetModuleHandleExW.restype = wintypes.BOOL
_GetModuleFileNameW = _kernel32.GetModuleFileNameW
_GetModuleFileNameW.argtypes = [ctypes.c_void_p, wintypes.LPWSTR, wintypes.DWORD]
_GetModuleFileNameW.restype = wintypes.DWORD

_HANDLER = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.POINTER(_ExceptionPointers))
_EXCEPTION_CONTINUE_SEARCH = 0
_GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS = 0x00000004
_MAX_FRAMES = 32


def _write(line: str) -> None:
    global _fd
    if _fd is None:
        return
    try:
        os.write(_fd, (line + "\n").encode("utf-8", "replace"))
    except Exception:
        pass


def _module_offset(addr: int) -> str:
    try:
        hmod = ctypes.c_void_p()
        if not _GetModuleHandleExW(
            _GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
            ctypes.c_void_p(addr),
            ctypes.byref(hmod),
        ):
            return ""
        buf = ctypes.create_unicode_buffer(1024)
        if not _GetModuleFileNameW(hmod, buf, 1024):
            return ""
        return "%s +0x%x" % (os.path.basename(buf.value), addr - int(hmod.value))
    except Exception:
        return ""


def _veh(exception_pointers) -> int:
    try:
        if not exception_pointers:
            return _EXCEPTION_CONTINUE_SEARCH
        rec = exception_pointers.contents.ExceptionRecord
        if not rec:
            return _EXCEPTION_CONTINUE_SEARCH
        r = rec.contents
        # 只记录真正的 access violation；其它异常交给原处理链
        if int(r.ExceptionCode) & 0xFFFFFFFF != 0xC0000005:
            return _EXCEPTION_CONTINUE_SEARCH
        try:
            info = [int(r.ExceptionInformation[i] or 0) for i in range(int(r.NumberParameters))]
        except Exception:
            info = []
        rw = {0: "read", 1: "write", 8: "execute"}.get(info[0] if info else -1, str(info[0] if info else "?"))
        fault = info[1] if len(info) > 1 else 0
        _write(
            "[%s] code=0xC0000005 addr=0x%x thread=%d rw=%s fault=0x%x"
            % (time.strftime("%H:%M:%S"), int(r.ExceptionAddress or 0), int(_GetCurrentThreadId()), rw, fault)
        )
        # 如果 faulting thread 是 Python 线程，顺便记录它当前的 Python 栈；
        # 这能直接告诉我们是哪个 Python 调用触发了原生崩溃。
        try:
            if ctypes.pythonapi.PyGILState_Check():
                tid = int(_GetCurrentThreadId())
                _write("  python-thread=%s tid=%d" % (threading.current_thread().name, tid))
                frame = sys._current_frames().get(tid)
                if frame is not None:
                    for line in traceback.format_stack(frame, limit=25):
                        for part in str(line).rstrip().splitlines():
                            _write("  py " + part)
        except Exception:
            pass
        frames = (ctypes.c_void_p * _MAX_FRAMES)()
        hashv = wintypes.ULONG(0)
        n = int(_RtlCaptureStackBackTrace(0, _MAX_FRAMES, frames, ctypes.byref(hashv)))
        for i in range(n):
            addr = int(frames[i] or 0)
            _write("  #%02d 0x%x module=%s" % (i, addr, _module_offset(addr)))
    except Exception:
        pass
    return _EXCEPTION_CONTINUE_SEARCH


def install(path: str) -> bool:
    """安装 VEH；重复调用幂等。path 为追加写入的日志文件。"""
    global _installed, _handler_ref, _fd
    if _installed:
        return True
    try:
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        # 超过 4MB 先滚动一次，避免长期驻留无限增长
        try:
            if os.path.getsize(path) > 4 * 1024 * 1024:
                os.replace(path, path + ".1")
        except OSError:
            pass
        _fd = os.open(path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o644)
        _handler_ref = _HANDLER(_veh)
        _AddVectoredExceptionHandler(1, _handler_ref)
        _installed = True
        _write("[%s] native crash diag installed" % time.strftime("%H:%M:%S"))
        return True
    except Exception:
        return False
