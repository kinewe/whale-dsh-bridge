#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鲸鲸 · 微信 4.x 桥接（不注入、不修改微信）

原理：
  - 读消息：解密微信 4.x 本地 SQLite 数据库（只读，需要微信处于登录状态）
  - 发消息：驱动微信窗口（UI 自动化 + 剪贴板），相当于有人替你打字发送

前置：
  1. WeChat 4.x 已登录（建议用小号）
  2. 已装依赖：pip install wechatauto-replica requests
  3. 鲸鲸服务已启动（双击 启动鲸鱼娘.bat）
  4. config.json 里 gateway.wechat.enabled = true（脚本会读 token）

用法：
  python examples/wechatauto_bridge.py

注意：
  - 发送消息会抢微信窗口焦点，这是 4.x 自动化的正常表现。
  - 微信必须保持登录；退出登录后数据库密钥会失效。
  - 自动化不是微信官方接口，仍有账号风险，只用小号 + 测试群。
"""

import json
import glob
import html
import random
import re
import urllib.parse
import os
import hashlib
# 关掉 wechatauto 的「拟人节流」（默认 natural：120 秒内 6 次写就冷却 30~75 秒）
os.environ.setdefault("WECHATAUTO_RHYTHM", "off")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
import sys
import threading
import queue
from concurrent.futures import ThreadPoolExecutor
import time

# Windows embeddable Python's ._pth omits the script directory; load only our
# shipped helper from this explicit directory, never from the current working directory.
_EXAMPLES_DIR = os.path.dirname(os.path.abspath(__file__))
if _EXAMPLES_DIR not in sys.path:
    sys.path.insert(0, _EXAMPLES_DIR)
from sticker_transport import (guarded_send as guarded_sticker_send, read_enabled_config,
                               resolve_target as resolve_sticker_target, result as sticker_result,
                               WindowsDesktop, quarantined_input_value,
                               account_evidence_allowed as sticker_account_evidence_ok,
                               alias_match as sticker_alias_match)
import sticker_transport as _sticker_transport_module
import uiautomation as _uiautomation

# 诊断：记录 uiautomation 全局 COM 客户端/线程初始化发生在哪个线程。
# 如果它不在 UIA 专用线程创建，跨套间使用就可能在原生层 access violation。
_UIA_DIAG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "uia-diag.log")

def _uia_diag_write(msg):
    try:
        with open(_UIA_DIAG_PATH, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
    except Exception:
        pass

try:
    _uia_diag_client_instance = _uiautomation._AutomationClient.instance.__func__

    def _uia_diag_instance(cls):
        _uia_diag_write("AutomationClient.instance thread=" + threading.current_thread().name)
        return _uia_diag_client_instance(cls)

    _uiautomation._AutomationClient.instance = classmethod(_uia_diag_instance)
except Exception as _e:
    _uia_diag_write("patching AutomationClient failed: %r" % (_e,))

try:
    _uia_diag_init = _uiautomation.InitializeUIAutomationInCurrentThread

    def _uia_diag_init_wrapper(*a, **kw):
        _uia_diag_write("InitializeUIAutomation thread=" + threading.current_thread().name)
        return _uia_diag_init(*a, **kw)

    _uiautomation.InitializeUIAutomationInCurrentThread = _uia_diag_init_wrapper
except Exception as _e:
    _uia_diag_write("patching Initialize failed: %r" % (_e,))

# 纯函数/常量模块（examples/bridge_modules，路径已在上面加入 sys.path）
from bridge_modules.text_utils import (
    collect_file_urls,
    format_size_kb as _fmt_kb,
    parse_file_meta as _parse_file_meta,
    safe_filename as _safe_wechat_file_name,
    strip_file_links,
    strip_wechat_dup_suffix as _norm_name,
)
from bridge_modules.sender_win32 import Win32Sender
from bridge_modules import bili_watch as _bili_watch
from bridge_modules.wechat_db_utils import (
    DB_ROOT_NAMES,
    account_wxid,
    find_account_dirs,
    iter_drive_roots,
    looks_like_db_root,
    resolve_account_dir,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 原生崩溃诊断：记录 faulting thread / 异常地址 / native 调用栈，供 access violation 分析
try:
    from bridge_modules.native_crash_diag import install as _install_native_crash_diag
    _install_native_crash_diag(os.path.join(ROOT, "data", "native-crash.log"))
except Exception:
    pass
# 让 wechatauto 的媒体下载器也能用到随包 ffmpeg（否则 wxgf/HEVC 原图转不出 jpg）
try:
    _ffmpeg_bin = os.path.join(ROOT, "runtime", "ffmpeg", "bin")
    if os.path.isdir(_ffmpeg_bin) and _ffmpeg_bin not in os.environ.get("PATH", ""):
        os.environ["PATH"] = _ffmpeg_bin + os.pathsep + os.environ.get("PATH", "")
except Exception:
    pass
CONFIG_PATH = os.path.join(ROOT, "config.json")
LOG_FILE = os.path.join(ROOT, "data", "wechat-bridge-4x.log")

# 只回复这些会话（留空 = 全部会话都交给鲸鲸判断）
# 例如 ["文件传输助手", "深海鱼塘"]
ONLY_CHATS = []

# 距离启动多久之前的消息不处理（秒）
SKIP_OLDER_THAN = 10
DIGEST_MINUTES = 30
MASTER_WXID = ''
# 超过这么多秒的旧消息直接不回，避免“回上一条”
STALE_AFTER = float(os.environ.get("WHALE_STALE_AFTER", "4"))

# 主动搭话（care）的开关：先给默认值，下面读 config 时再覆盖。
# 以前这几个只在那段 try 里赋值，而 try 里第一次用到 _as_bool 时它还没 def
# （定义原本在 try 后面），NameError 被 `except Exception: pass` 吞掉 →
# 整块跳过，CARE_* 一个都没定义，care_watch 线程跑到 CARE_QUIET_MIN 就
# NameError 退出（日志里那条 "CARE_QUIET_MIN is not defined" 就是它）。
CARE_ENABLED = False
CARE_ALLOW_GROUPS = False
CARE_ONLY_MASTER = True
CARE_ALLOW_OTHERS = False
CARE_QUIET_MIN = 20.0
# Fail closed even when an earlier setting makes startup config parsing fail.
STICKER_TEST_ON = False

# 文件通道（DSH 桥接 v0.2 的微信侧）：入站把微信文件/图片下载后交给鲸鲸；
# 出站把回复里的 /files/ 下载链接换成真正的微信「文件消息」。
# 可在 config.json 的 wechat.fileChannelIn / fileChannelOut / fileMaxMB 覆盖。
WECHAT_FILE_IN = True
WECHAT_FILE_OUT = True
WECHAT_FILE_MAX_MB = 20.0
MEDIA_KEEP_DAYS = 7.0
# DSH 原生模式下图片直接交给 DSH 用 read_image 看（不依赖鲸鱼娘视觉接口）
WECHAT_IMAGE_TO_DSH = False

# 自测钩子（默认全关；只给「没有第二个微信账号时验证文件通道」用，见项目报告）
#   WHALE_WECHAT_TEST_MODE=1        允许把指定自聊会话当成测试会话处理
#   WHALE_WECHAT_TEST_CHAT=filehelper  测试会话（默认文件传输助手）
#   WHALE_WECHAT_TEST_INJECT=file,text 启动后注入一条文件入站消息 + 一条出站测试文本
WECHAT_TEST_MODE = os.environ.get("WHALE_WECHAT_TEST_MODE") == "1"
WECHAT_TEST_CHAT = os.environ.get("WHALE_WECHAT_TEST_CHAT", "filehelper")
WECHAT_TEST_INJECT = os.environ.get("WHALE_WECHAT_TEST_INJECT", "")


def _as_bool(value, default=False):
    """配置里的布尔：兼容写成字符串 "false" 的老配置。

    以前 bool("false") 是 True —— 于是 care.allowGroups 明明写着 "false"，
    桥接却当成「允许进群」。
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes", "on", "开")


_cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
# 新版发行包不再自带 config.json（免得覆盖安装时把用户的主人名单/token 冲掉）。
# 如果用户先双击了桥接、服务还没起过，这里用 example 生成一份，避免「token 空 → 401 → 她不回话」。
if not os.path.exists(_cfg_path):
    _example = os.path.join(os.path.dirname(_cfg_path), "config.example.json")
    if os.path.exists(_example):
        try:
            import shutil
            shutil.copyfile(_example, _cfg_path)
        except Exception:
            pass
try:
    with open(_cfg_path, "r", encoding="utf-8-sig") as _f:
        _cfg = json.load(_f)
    _stale = (_cfg.get("wechat") or {}).get("staleAfterSec")
    if isinstance(_stale, (int, float)) and _stale > 0:
        STALE_AFTER = float(_stale)
    _wechat = _cfg.get("wechat") or {}
    GAME_TOKENS = [str(x).lower() for x in (_wechat.get("gameWhitelist") or []) if str(x).strip()]
    AWAY_NOTICE = bool(_wechat.get("awayNotice", True))
    RETURN_NOTICE = bool(_wechat.get("returnNotice", True))
    QUEUED_MAX_AGE = float(_wechat.get("queuedMaxAgeSec", 300))
    QUEUED_MAX_CHATS = int(_wechat.get("queuedMaxChats", 2))
    # 引用回复要额外走一遍「悬停消息 → 点回复 → 输入」，实测一条能慢好几秒；默认关
    QUOTE_REPLY = bool(_wechat.get("quoteReply", False))
    # UIA 彻底发不出去时，退到「Ctrl+F 搜索会话 → 粘贴 → 回车」的键盘通道（会抢前台）
    KEYBOARD_FALLBACK = bool(_wechat.get("keyboardFallback", True))
    # 后台发送：不抢前台直接发（实测最小化/被遮挡也能发）。false = 每次先把微信拉到前台
    BACKGROUND_SEND = bool(_wechat.get("backgroundSend", True))
    # 文件通道：入站（微信收到的文件/图片交给 DSH）、出站（DSH 产物发成微信文件消息）
    WECHAT_FILE_IN = _as_bool(_wechat.get("fileChannelIn", True), True)
    WECHAT_IMAGE_TO_DSH = _as_bool(_wechat.get("imageToDsh", False), False)
    WECHAT_FILE_OUT = _as_bool(_wechat.get("fileChannelOut", True), True)
    try:
        WECHAT_FILE_MAX_MB = float(_wechat.get("fileMaxMB", 20) or 20)
    except Exception:
        WECHAT_FILE_MAX_MB = 20.0
    try:
        MEDIA_KEEP_DAYS = float((_cfg.get("storage") or {}).get("mediaKeepDays") or 7)
    except Exception:
        MEDIA_KEEP_DAYS = 7.0
    # 多账号（同时登着大号 + 小号）：启动时钉死在 wechat.account 指定的那个号上，
    # 发送前再确认「要发消息的那个窗口就是这个号」；认不出来宁可不发，也不从别的号发。
    # accountGuard=false 只用于「本机确实只登一个号、但窗口读取时好时坏」的兜底。
    ACCOUNT_GUARD = bool(_wechat.get("accountGuard", True))
    # 手动钉窗口（调试用）：填微信主窗的 hwnd，直接用它，跳过自动识别
    WINDOW_HWND = int(_wechat.get("windowHwnd") or 0)
    # 网页「设置」里选的账号（目录名 / wxid / 昵称都行）；留空 = 自动选「最近活跃」
    ACCOUNT_WANTED = str(_wechat.get("account") or "").strip()
    LOW_BATTERY_PCT = float(_wechat.get("lowBatteryPercent", 5))
    GOODNIGHT_TEXT = str(_wechat.get("goodnightText", "晚安，电量快没了，我先睡啦，明天见～"))
    _share = _cfg.get("share") or {}
    SHARE_ENABLED = bool(_share.get("enabled", True))
    SHARE_EVERY = float(_share.get("everyMinutes", 120))
    # 主动搭话（问「在干啥 / 累不累」）。时间窗和频率由服务端 /api/care/due 算，这里只留一个开关和静默期
    _care = _cfg.get("care") or {}
    # 主动搭话默认关（群里突然打招呼很社死）；就算开了也只私聊，除非显式 allowGroups
    CARE_ENABLED = bool(_care.get("enabled", False))
    CARE_ALLOW_GROUPS = _as_bool(_care.get("allowGroups", False), False)
    CARE_ONLY_MASTER = _as_bool(_care.get("onlyMaster", True), True)
    CARE_ALLOW_OTHERS = _as_bool(_care.get("allowOthers", False), False)
    CARE_QUIET_MIN = float(_care.get("quietAfterMinutes", 20) or 0)
    _digest = _wechat.get("digestMinutes", 30)
    DIGEST_MINUTES = float(_digest) if isinstance(_digest, (int, float)) else 30.0
    # 表情包（实验性）：总闸在 features.stickers。关着就不轮询、不发图、日志一句不提。
    STICKER_TEST_ON = _as_bool(((_cfg.get("features") or {}).get("stickers", False)), False)
    MASTER_WXID = (((_cfg.get("persona") or {}).get("master") or {}).get("wxids") or [''])[0]
except Exception as _cfg_err:                  # noqa: BLE001
    # 别再静默吞掉：整块跳过 = 上面这些开关全部保持默认值，表现成「配置改了没用」。
    print("[wechatauto_bridge] 读取 config.json 出错，相关开关沿用默认值：%r"
          % (_cfg_err,), file=sys.stderr)

# _as_bool 已移到文件前部（读配置之前），不要在这里重复定义

START_TS = time.time()


# 同一类错误 10 分钟只记一行：没配看图 Key 时，每张图刷一条日志会淹掉真正的问题
# 本机请求专用：不读系统代理。用户装了 Clash 之类的代理但没开时，
# HTTP_PROXY 会让连 127.0.0.1 的请求也走代理 → 报「由于目标计算机积极拒绝」。
import requests as _requests  # 延迟到这里再 import，避免顶部依赖顺序问题

LOCAL_HTTP = _requests.Session()
LOCAL_HTTP.trust_env = False
os.environ["NO_PROXY"] = ",".join(filter(None, [os.environ.get("NO_PROXY", ""), "127.0.0.1,localhost,::1"]))
_THROTTLE_LOG = {}
# 和服务端的连接状态：用来只在「断开→恢复」时各打一次日志
CONN_STATE = {"ok": None}


def log_throttled(key, *args, ttl=600):
    now = time.time()
    last = _THROTTLE_LOG.get(key) or 0
    if now - last < ttl:
        _THROTTLE_LOG["__skip_" + key] = _THROTTLE_LOG.get("__skip_" + key, 0) + 1
        return
    skipped = _THROTTLE_LOG.pop("__skip_" + key, 0)
    if skipped:
        log(f"（上面这类日志还有 {skipped} 条被折叠了）")
    _THROTTLE_LOG[key] = now
    log(*args)



def reload_config(path=None):
    """把 config.json 重新读一遍，覆盖上面这些「启动时定型」的开关。

    为什么需要：调试台（/debug）改的是 config.json，但桥接以前只在启动时读一次，
    用户在页面上关掉「主动分享」、改「忽略名单」、调「游戏白名单」……全都没反应，
    只能手动重启「启动微信桥接.bat」，表现出来就是「调了没用，还是默认」。
    现在 config.json 一变，5 秒内自动生效。

    返回是否真的重新加载了。
    """
    global GAME_TOKENS, AWAY_NOTICE, RETURN_NOTICE, QUEUED_MAX_AGE, QUEUED_MAX_CHATS
    global QUOTE_REPLY, KEYBOARD_FALLBACK, BACKGROUND_SEND, LOW_BATTERY_PCT, GOODNIGHT_TEXT
    global ACCOUNT_GUARD, WINDOW_HWND, STICKER_TEST_ON
    global WECHAT_FILE_IN, WECHAT_FILE_OUT, WECHAT_FILE_MAX_MB, WECHAT_IMAGE_TO_DSH, MEDIA_KEEP_DAYS
    global SHARE_ENABLED, SHARE_EVERY, CARE_ENABLED, CARE_QUIET_MIN, DIGEST_MINUTES
    global STALE_AFTER, SYSTEM_SENDER_NAMES, BASE_SYSTEM_SENDERS, MASTER_WXID
    global VOICE_ENABLED, VOICE_BASE_URL, VOICE_MODEL, VOICE_API_KEY, VOICE_TIMEOUT, VOICE_MAX_SECONDS
    target = path or CONFIG_PATH
    try:
        with open(target, "r", encoding="utf-8-sig") as f:
            cfg = json.load(f)
    except Exception as e:                      # noqa: BLE001
        log("重读配置失败（继续用旧值）：", repr(e))
        return False

    w = cfg.get("wechat") or {}
    try:
        STALE_AFTER = float(w.get("staleAfterSec") or STALE_AFTER or 4)
    except Exception:
        pass
    GAME_TOKENS = [str(x).lower() for x in (w.get("gameWhitelist") or []) if str(x).strip()]
    AWAY_NOTICE = bool(w.get("awayNotice", True))
    RETURN_NOTICE = bool(w.get("returnNotice", True))
    try:
        QUEUED_MAX_AGE = float(w.get("queuedMaxAgeSec", 300))
        QUEUED_MAX_CHATS = int(w.get("queuedMaxChats", 2))
        LOW_BATTERY_PCT = float(w.get("lowBatteryPercent", 5))
    except Exception:
        pass
    QUOTE_REPLY = bool(w.get("quoteReply", False))
    KEYBOARD_FALLBACK = bool(w.get("keyboardFallback", True))
    BACKGROUND_SEND = bool(w.get("backgroundSend", True))
    _old_file_in, _old_file_out = WECHAT_FILE_IN, WECHAT_FILE_OUT
    WECHAT_FILE_IN = _as_bool(w.get("fileChannelIn", True), True)
    WECHAT_FILE_OUT = _as_bool(w.get("fileChannelOut", True), True)
    WECHAT_IMAGE_TO_DSH = _as_bool(w.get("imageToDsh", False), False)
    try:
        WECHAT_FILE_MAX_MB = float(w.get("fileMaxMB", 20) or 20)
    except Exception:
        pass
    try:
        MEDIA_KEEP_DAYS = float((cfg.get("storage") or {}).get("mediaKeepDays") or 7)
    except Exception:
        pass
    if (_old_file_in, _old_file_out) != (WECHAT_FILE_IN, WECHAT_FILE_OUT):
        log("文件通道开关被配置改动了：入站=%s 出站=%s（上限 %g MB）"
            % ("开" if WECHAT_FILE_IN else "关", "开" if WECHAT_FILE_OUT else "关", WECHAT_FILE_MAX_MB))
    STICKER_TEST_ON = _as_bool(((cfg.get("features") or {}).get("stickers", False)), False)
    ACCOUNT_GUARD = bool(w.get("accountGuard", True))
    try:
        WINDOW_HWND = int(w.get("windowHwnd") or 0)
    except Exception:
        WINDOW_HWND = 0
    # 账号是在建库时钉死的，改不了；这里只负责「发现网页改了账号 → 让桥接自己重启」。
    wanted_now = str(w.get("account") or "").strip()
    if wanted_now != ACCOUNT_WANTED:
        log("账号设置变了（%r → %r），3 秒后自动重启桥接…" % (ACCOUNT_WANTED, wanted_now))
        time.sleep(3)
        # bridge_loop.bat 把 exit code 7 当成「桥接自己要求重启」，3 秒后会用新配置拉起来。
        # 直接 os._exit 而不是 sys.exit：这里是后台线程，sys.exit 退不掉整个进程。
        os._exit(7)
    GOODNIGHT_TEXT = str(w.get("goodnightText") or GOODNIGHT_TEXT)
    try:
        DIGEST_MINUTES = float(w.get("digestMinutes", 30))
    except Exception:
        DIGEST_MINUTES = 30.0
    # 忽略名单：系统会话是固定底表，配置里的只追加
    SYSTEM_SENDER_NAMES = set(BASE_SYSTEM_SENDERS)
    SYSTEM_SENDER_NAMES |= {str(x).strip() for x in (w.get("ignoreSenders") or []) if str(x).strip()}

    sh = cfg.get("share") or {}
    SHARE_ENABLED = bool(sh.get("enabled", True))
    try:
        SHARE_EVERY = float(sh.get("everyMinutes", 120))
    except Exception:
        SHARE_EVERY = 120.0

    ca = cfg.get("care") or {}
    global CARE_ENABLED, CARE_ALLOW_GROUPS, CARE_ONLY_MASTER, CARE_ALLOW_OTHERS
    CARE_ENABLED = _as_bool(ca.get("enabled", True), True)
    CARE_ALLOW_GROUPS = _as_bool(ca.get("allowGroups", False), False)
    CARE_ONLY_MASTER = _as_bool(ca.get("onlyMaster", True), True)
    CARE_ALLOW_OTHERS = _as_bool(ca.get("allowOthers", False), False)
    try:
        CARE_QUIET_MIN = float(ca.get("quietAfterMinutes", 20) or 0)
    except Exception:
        CARE_QUIET_MIN = 20.0

    vo = cfg.get("voice") or {}
    if "enabled" in vo:
        VOICE_ENABLED = bool(vo.get("enabled"))
    if vo.get("baseUrl"):
        VOICE_BASE_URL = str(vo.get("baseUrl"))
    if vo.get("model"):
        VOICE_MODEL = str(vo.get("model"))
    # 语音这几项以前只在启动时读一次：网页里换了 Key / 调了超时，必须重启才生效
    try:
        if vo.get("timeoutMs") is not None:
            VOICE_TIMEOUT = float(vo.get("timeoutMs")) / 1000.0
        if vo.get("maxSeconds") is not None:
            VOICE_MAX_SECONDS = float(vo.get("maxSeconds"))
    except Exception:
        pass
    VOICE_API_KEY = _resolve_voice_key(cfg)

    wxids = (((cfg.get("persona") or {}).get("master") or {}).get("wxids") or [])
    if wxids:
        MASTER_WXID = wxids[0]
    return True


# 系统 / 公众号通知：只用来记录，不接话（否则会跟「微信团队」吵起来）
SYSTEM_SENDER_NAMES = {
    "微信团队", "微信支付", "服务通知", "订阅号消息", "文件传输助手",
    "微信运动", "微信公众平台", "腾讯客服", "微信安全中心", "微信广告",
}
try:
    SYSTEM_SENDER_NAMES |= {str(x).strip() for x in (_wechat.get("ignoreSenders") or []) if str(x).strip()}
except Exception:
    pass
# 系统会话名单的原始底表（热更新时以它为基准重新算，避免配置里的旧值越滚越多）
BASE_SYSTEM_SENDERS = set(SYSTEM_SENDER_NAMES)

def resolve_db_dir(config_path=None, drives="CDEFGHIJK"):
    """找微信 4.x 的数据库目录，比 wechatauto 自带的 auto_detect 更狠。

    库自带的只查「文档 / 用户目录 / 注册表」，用户把微信文件存到别的盘
    （很常见：E:\\xwechat_files、D:\\xwechat_files）就永远找不到，启动直接
    RuntimeError 崩掉 —— 也就是用户截图里那一整段 Traceback。

    顺序：config.json 的 wechat.dbDir → 正在运行的微信进程打开的文件 → 各盘根目录。
    """
    # 1) 配置里手填的
    manual = ""
    try:
        with open(config_path or CONFIG_PATH, "r", encoding="utf-8-sig") as f:
            manual = str(((json.load(f).get("wechat") or {}).get("dbDir") or "")).strip()
    except Exception:
        manual = ""
    if manual and looks_like_db_root(manual):
        return manual

    # 2) 正在运行的微信进程打开着数据库文件 —— 直接反射出来，最准
    try:
        import psutil
        for proc in psutil.process_iter(["name"]):
            name = str(proc.info.get("name") or "").lower()
            if not any(k in name for k in ("weixin", "wechat")):
                continue
            try:
                open_files = proc.open_files()
            except Exception:
                continue
            for item in open_files:
                m = re.search(r"([\\/])(" + "|".join(DB_ROOT_NAMES) + r")([\\/]|$)",
                              item.path or "", re.I)
                if not m:
                    continue
                # 取「名字之前的那一段」作为盘符/目录，再拼回 xwechat_files
                root = (item.path or "")[: m.start() + 1] + m.group(2)
                if looks_like_db_root(root):
                    return root
    except Exception:
        pass

    # 3) 所有真实磁盘根（以前写死 C..K，L: 盘和网络盘永远找不到）
    for root in iter_drive_roots():
        for name in DB_ROOT_NAMES:
            cand = os.path.join(root, name)
            if looks_like_db_root(cand):
                return cand
    return ""


# ---------------------------------------------------------------------------
# 多账号：账号目录枚举 / 账号写法解析 / 给网页列账号
# ---------------------------------------------------------------------------

def list_accounts_cli():
    """--list-accounts：扫描本机所有微信账号，写 data/accounts.json 给网页下拉用。

    昵称要开库读 contact.db（必须微信在登录、能取到密钥），所以是「尽力而为」：
    单个账号失败就留空，整件事最多花 20 秒，绝不因为读不到昵称就报错。
    """
    db_dir = resolve_db_dir()
    rows = []
    names = find_account_dirs(db_dir) if db_dir else []
    deadline = time.time() + 20
    try:
        from wechatauto import WeChatDB
    except Exception as e:                        # noqa: BLE001
        log("列账号：wechatauto 不可用，只列目录名：", repr(e))
        WeChatDB = None
    for n in names:
        item = {"account": n, "wxid": account_wxid(n), "nick": "", "lastActive": 0}
        base = os.path.join(db_dir, n, "db_storage")
        try:
            newest = 0.0
            for root, _dirs, files in os.walk(base):
                for f in files:
                    if f.endswith(".db") and not f.endswith(("-wal", "-shm")):
                        newest = max(newest, os.path.getmtime(os.path.join(root, f)))
            item["lastActive"] = int(newest * 1000)
        except Exception:
            pass
        if WeChatDB is not None and time.time() < deadline:
            try:
                probe = WeChatDB(db_dir=db_dir, account=n)
                if probe.account == n:
                    info = probe.get_self_info() or {}
                    item["nick"] = str(info.get("nick_name") or info.get("remark") or "").strip()
            except Exception:
                pass
        rows.append(item)
    rows.sort(key=lambda x: -x["lastActive"])
    payload = {
        "dbDir": db_dir or "",
        "generatedAt": int(time.time() * 1000),
        "accounts": rows,
    }
    path = os.path.join(ROOT, "data", "accounts.json")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        log("列账号完成：%d 个（%s）" % (len(rows), "、".join(r["account"] for r in rows) or "无"))
    except Exception as e:                        # noqa: BLE001
        log("列账号：写 %s 失败：%r" % (path, e))
    print(json.dumps(payload, ensure_ascii=False))
    return 0


_SYSTEM_TEXT_RE = __import__("re").compile(r"<a\s+href=|weixin://|&lt;a\s+href=", __import__("re").I)
# 同一会话同一句话的重复回复保护（秒）与每分钟回复上限
DUP_REPLY_WINDOW = 45
MAX_REPLIES_PER_MIN = 8
# 单实例锁端口：被占用就说明已经有桥接在跑，直接退出
BRIDGE_LOCK_PORT = 47821

# —— 语音识别（语音消息 → 文字）——
# 默认用阿里云百炼的 qwen3-asr-flash；Key 依次取 voice.apiKey → data/settings.json → deepseek.apiKey
VOICE_ENABLED = True
VOICE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
VOICE_MODEL = "qwen3-asr-flash"
VOICE_API_KEY = ""
VOICE_TIMEOUT = 90
VOICE_MAX_SECONDS = 120
VOICE_SAMPLE_RATE = 16000


def _resolve_voice_key(cfg):
    """语音 Key 的查找链：voice.apiKey → settings.voiceApiKey → settings.apiKey → config.deepseek.apiKey。

    以前只回退到 settings.apiKey，配置文件里写的 deepseek.apiKey 永远用不上（注释承诺了却没实现）；
    而且 reload_config 不刷新语音 Key，网页里换 Key 必须重启桥接才生效。
    """
    vo = (cfg.get("voice") or {}) if isinstance(cfg, dict) else {}
    key = str(vo.get("apiKey") or "").strip()
    if key:
        return key
    try:
        with open(os.path.join(ROOT, "data", "settings.json"), "r", encoding="utf-8-sig") as sf:
            st = json.load(sf)
        for name in ("voiceApiKey", "apiKey"):
            v = str(st.get(name) or "").strip()
            if v:
                return v
        keys = st.get("keys") or {}
        for name in ("vision", "qwen", "zhipu", "deepseek"):
            v = str(keys.get(name) or "").strip()
            if v:
                return v
    except Exception:
        pass
    try:
        v = str(((cfg.get("deepseek") or {}).get("apiKey") or "")).strip()
        if v:
            return v
    except Exception:
        pass
    return ""


try:
    _voice_cfg = (_cfg.get("voice") or {})
    VOICE_ENABLED = bool(_voice_cfg.get("enabled", True))
    VOICE_BASE_URL = str(_voice_cfg.get("baseUrl") or VOICE_BASE_URL)
    VOICE_MODEL = str(_voice_cfg.get("model") or VOICE_MODEL)
    VOICE_TIMEOUT = float(_voice_cfg.get("timeoutMs", 90000)) / 1000.0
    VOICE_MAX_SECONDS = float(_voice_cfg.get("maxSeconds", 120))
    VOICE_API_KEY = _resolve_voice_key(_cfg)
except Exception:
    pass


def asr_transcribe(wav_bytes, api_key, model, base_url, timeout=90):
    """把 wav 字节交给语音识别接口，返回文字；失败抛异常或返回空串。"""
    import base64
    import urllib.request

    if not api_key:
        raise RuntimeError("没有可用的语音识别 Key")
    payload = {
        "model": model,
        "input": {
            "messages": [{
                "role": "user",
                "content": [{"audio": "data:audio/wav;base64," + base64.b64encode(wav_bytes).decode()}],
            }]
        },
    }
    req = urllib.request.Request(
        base_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    try:
        text = data["output"]["choices"][0]["message"]["content"][0]["text"]
    except Exception:
        text = ""
    return str(text or "").strip()


def clean_transcript(text):
    """去掉只剩标点的转写结果。"""
    t = str(text or "").strip()
    t = t.strip("，,。.！!？?…~～、 ")
    return t if len(t) >= 1 else ""

_recent_dup = {}
_reply_stamps = {}
_guard_lock = threading.Lock()
# 「演示模式」提示只喊一次，别每条都刷
MOCK_NOTICED = {"done": False}


def is_system_notice(username, nickname, content):
    """系统号 / 通知类消息：带 weixin:// 链接、HTML 链接、或已知系统号名字。"""
    if _SYSTEM_TEXT_RE.search(str(content or "")):
        return True
    name = str(nickname or "").strip()
    if name in SYSTEM_SENDER_NAMES:
        return True
    uid = str(username or "")
    if uid.startswith("gh_"):
        return True
    return False


def duplicate_guard(chat_username, sender, content):
    """同一人 45 秒内重复同一句 → 不再回（微信重投/通知刷屏）。"""
    now = time.time()
    key = (str(chat_username or ""), str(sender or ""), str(content or "").strip())
    with _guard_lock:
        last = _recent_dup.get(key, 0)
        _recent_dup[key] = now
        if len(_recent_dup) > 500:
            for k, v in list(_recent_dup.items()):
                if now - v > 600:
                    _recent_dup.pop(k, None)
        return now - last < DUP_REPLY_WINDOW


def rate_guard(chat_username):
    """同一会话一分钟内已经回了 MAX_REPLIES_PER_MIN 条 → 先停下，避免越聊越乱。"""
    now = time.time()
    key = str(chat_username or "")
    with _guard_lock:
        stamps = [t for t in _reply_stamps.get(key, []) if now - t < 60]
        if len(stamps) >= MAX_REPLIES_PER_MIN:
            _reply_stamps[key] = stamps
            return False
        stamps.append(now)
        _reply_stamps[key] = stamps
    return True


BOOT_LOG = os.path.join(ROOT, "data", "bridge-boot.log")


def boot(msg):
    """启动诊断：只写文件，不依赖控制台（控制台被选中时 print 会卡住）"""
    try:
        os.makedirs(os.path.dirname(BOOT_LOG), exist_ok=True)
        with open(BOOT_LOG, "a", encoding="utf-8") as f:
            f.write("%s [pid %s] %s\n" % (time.strftime("%H:%M:%S"), os.getpid(), msg))
    except Exception:
        pass


boot("脚本开始执行")


def log(*args):
    line = time.strftime("[%H:%M:%S] ") + " ".join(str(a) for a in args)
    # 先写文件，再打印：这样即使控制台卡住，日志也不会丢
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        print(line, flush=True)
    except Exception:
        pass


_win_problem_ts = {}


def log_window_problem(where, err):
    """窗口操作失败两分钟内只报一次。

    挪不动/置顶不了窗口不该让整条发送失败（UIA 还能把字打进去），
    更不该让看门狗以为“发送卡住”把桥接反复重启——那会一直弹「拒绝访问」。
    """
    now = time.time()
    if now - _win_problem_ts.get(where, 0) < 120:
        return
    _win_problem_ts[where] = now
    log(where + "：", repr(err))


def read_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                cfg = json.load(f)
        except Exception as e:
            log("读取 config.json 失败：", e)
    return cfg


def build_bot_url(cfg):
    # 端口优先级：环境变量 > 服务写下的实际端口 > config.server.port
    # （服务用 --port= 启动时 config 里还是老端口，读文件才不会连错）
    port = (cfg.get("server") or {}).get("port", 8787)
    try:
        with open(os.path.join(ROOT, "data", "server-port.txt"), "r", encoding="utf-8") as _pf:
            _p = int((_pf.read() or "").strip())
            if 0 < _p < 65536:
                port = _p
    except Exception:
        pass
    return os.environ.get("WHALE_BOT_URL", "http://127.0.0.1:%s/webhook/wechat" % port)


def wait_for_server(url, timeout=30):
    """等本地服务真的在监听。

    用户最常见的坑：先点桥接、后点服务，或者两者同时启动。
    服务从进程起来到 listen() 完成要 1~3 秒，这段时间桥接每来一条消息就报
    「由于目标计算机积极拒绝，无法连接」。这里先等它起来，再开始监听。
    """
    import time as _t
    health = url.rsplit("/webhook", 1)[0] + "/healthz"
    deadline = _t.time() + max(5, timeout)
    waited = 0
    while _t.time() < deadline:
        try:
            r = LOCAL_HTTP.get(health, timeout=3)
            if r.status_code < 500:
                if waited > 0:
                    log("服务已就绪（等了 %d 秒）" % waited)
                return True
        except Exception:
            pass
        if waited == 0:
            log("等服务起来（最多 %d 秒）…" % timeout)
        _t.sleep(1)
        waited += 1
    log("[!] 等了 %d 秒服务还没起来。先双击「启动鲸鱼娘.bat」，再跑桥接。" % timeout)
    log("    提示：直接双击「先点启动鲸鱼娘再点启动桥接」文件夹里的两个 bat 就不会顺序错。")
    return False


def _server_health_ok(url):
    try:
        health = url.rsplit("/webhook", 1)[0] + "/healthz"
        r = LOCAL_HTTP.get(health, timeout=2)
        return r.status_code < 500
    except Exception:
        return False


def ensure_whale_server(url, timeout=90):
    """鲸鱼娘没监听时自动拉起，避免桥接在跑但 8787 静默。"""
    if _server_health_ok(url):
        return True
    # 先给同时启动留一点时间
    if wait_for_server(url, timeout=8):
        return True
    bat = os.path.join(ROOT, "启动鲸鱼娘.bat")
    if not os.path.exists(bat):
        log("[!] 找不到启动鲸鱼娘.bat，无法自动拉起：", bat)
        return False
    log("鲸鱼娘服务没在监听，自动拉起…")
    try:
        import subprocess as _sp
        flags = getattr(_sp, "CREATE_NO_WINDOW", 0)
        _sp.Popen(
            ["cmd.exe", "/c", bat],
            cwd=ROOT,
            creationflags=flags,
            stdout=_sp.DEVNULL,
            stderr=_sp.DEVNULL,
        )
    except Exception as _e:                      # noqa: BLE001
        log("自动拉起鲸鱼娘失败：", repr(_e))
        return False
    ok = wait_for_server(url, timeout=timeout)
    if ok:
        log("鲸鱼娘已自动拉起并就绪")
    return ok


def ensure_ffmpeg_env():
    """微信 4.x 的普通图片是 HEVC(wxgf) 容器，要 ffmpeg 才能转成 jpg。

    media 库用 shutil.which("ffmpeg") 找，很多机器装了 ffmpeg 但没加进 PATH，
    结果图片一直转不出来、看图全是「图片输入格式/解析错误」。
    这里先自己找一遍常见位置，找到就塞进 PATH。
    """
    import shutil
    if shutil.which("ffmpeg"):
        return True
    cands = [
        os.path.join(ROOT, "runtime", "ffmpeg", "bin"),
        os.path.join(ROOT, "tools", "ffmpeg", "bin"),
        r"C:\ffmpeg\bin", r"D:\ffmpeg\bin", r"E:\ffmpeg\bin", r"F:\ffmpeg\bin",
        os.path.expanduser(r"~\ffmpeg\bin"),
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\ffmpeg\bin"),
        r"C:\Program Files\ffmpeg\bin", r"D:\Program Files\ffmpeg\bin",
    ]
    for d in cands:
        exe = os.path.join(d, "ffmpeg.exe")
        if os.path.isfile(exe):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            _bundled = os.path.join(ROOT, "runtime", "ffmpeg", "bin")
            log("找到 ffmpeg：", exe, "（包里自带，微信图片是 wxgf/HEVC，靠它转 jpg）" if exe.lower().startswith(_bundled.lower()) else "（微信图片是 wxgf/HEVC，靠它转 jpg）")
            return True
    log("[!] 没找到 ffmpeg：微信 4.x 的图片多是 wxgf/HEVC，没有它就看不了图。")
    log("    装一个（解压到 C:\\ffmpeg 即可）或把 ffmpeg.exe 放进 runtime\\ffmpeg\\bin")
    return False


def main():
    boot("进入 main()")
    _startup = {"done": False}

    def _startup_watchdog():
        try:
            timeout = float(os.environ.get("WHALE_BRIDGE_STARTUP_TIMEOUT", "180"))
        except Exception:
            timeout = 180.0
        deadline = time.time() + max(30.0, timeout)
        while time.time() < deadline:
            if _startup.get("done"):
                return
            time.sleep(2)
        try:
            log("[!] 启动超过 %.0f 秒仍未就绪，强制退出，避免半死进程占端口" % max(30.0, timeout))
            with open(os.path.join(ROOT, "data", "bridge-startup-timeout.log"), "a", encoding="utf-8") as _f:
                _f.write(time.strftime("%Y-%m-%d %H:%M:%S") + " startup timeout\n")
        except Exception:
            pass
        os._exit(4)

    threading.Thread(target=_startup_watchdog, name="bridge-startup-watchdog", daemon=True).start()
    # 给网页「设置 → 微信账号」下拉用：只扫账号、不连消息，跑完就退出。
    # 必须放在单实例锁之前 —— 否则桥接正跑着的时候，这条命令会以为自己"重复启动"直接退出。
    if "--list-accounts" in sys.argv:
        return list_accounts_cli()
    ensure_ffmpeg_env()
    # 微信的 Qt accessibility 只在「纯英文路径」下能热激活成功；路径里带中文时，
    # UIA 认不出主窗（ensure_window 超时 37s），之后每次发送都退到 OCR 并报
    # error(5, 'SetWindowPos', '拒绝访问')，日志刷屏、消息发不出去。
    if any(ord(ch) > 127 for ch in ROOT):
        log("[!] 路径里有中文/非英文字符：", ROOT)
        log("    微信 UI 自动化在这种路径下会失败（发送一直报「拒绝访问」）。")
        log("    请把整个文件夹移到纯英文路径再启动，例如 D:\\whale-girl-3.0")
    # 单实例锁：多个桥接连同一份微信数据库会导致同一条消息被回好几遍
    _lock_sock = None
    try:
        import socket as _socket
        _lock_sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        _lock_sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 0)
        _lock_sock.bind(("127.0.0.1", BRIDGE_LOCK_PORT))
        _lock_sock.listen(1)
        boot("单实例锁已获取（端口 %d）" % BRIDGE_LOCK_PORT)
    except OSError as e:
        log("已经有一个桥接在跑了（端口 %d 被占用），本进程退出：%r" % (BRIDGE_LOCK_PORT, e))
        try:
            if _lock_sock:
                _lock_sock.close()
        except Exception:
            pass
        return 0
    except Exception:
        _lock_sock = None
    try:
        import faulthandler

        try:
            if os.environ.get("WHALE_DISABLE_HANG_DUMP", "1") != "1":
                _hang_file = open(os.path.join(ROOT, "data", "bridge-hang.log"), "a", encoding="utf-8")
                faulthandler.dump_traceback_later(40, repeat=True, file=_hang_file)
                boot("已开启卡死堆栈转储（40s）")
            else:
                boot("卡死堆栈转储已禁用（WHALE_DISABLE_HANG_DUMP=1）")
        except Exception:
            pass

        # 原生崩溃（0xC0000005）发生时，让 faulthandler 尽量在死前吐出当时正在跑哪句，
        # 写进 data/bridge-crash.log。能吐出来就省得猜是 UIA 还是别的什么崩的。
        try:
            if os.environ.get("WHALE_DISABLE_CRASH_DUMP", "1") != "0":
                boot("崩溃堆栈记录已禁用（WHALE_DISABLE_CRASH_DUMP=1）")
            else:
                _crash_file = open(os.path.join(ROOT, "data", "bridge-crash.log"), "a", encoding="utf-8")
                _crash_file.write("\n==== %s 进程启动（pid=%d）====\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), os.getpid()))
                _crash_file.flush()
                faulthandler.enable(file=_crash_file, all_threads=True)
                boot("已开启崩溃堆栈记录（data/bridge-crash.log）")
        except Exception:
            pass

        boot("开始 import requests")
        import requests

        boot("开始 import wechatauto（可能较慢，10~20 秒）")
        from wechatauto import MediaDownloader, WeChatDB, WeChatGUI
        from wechatauto.db import Listener

        # 小版本兼容补丁：本机微信上 UIA 控件树其实已经物化，但顶层窗口类名不是
        # mmui::MainWindow，wechatauto 自带的判断会把它当成「没物化」，于是每次
        # 发送都跳过 UIA、掉进会卡死在截屏里的 OCR 兜底。补丁见 uia_compat.py。
        # 包里自带的 Python 开了 safe_path（sys.flags.safe_path=True，sys.path[0]
        # 是 python312.zip 而不是脚本目录），所以同目录的 uia_compat 直接 import 会
        # ModuleNotFoundError。这里显式把 examples 目录塞进 sys.path；再不行就按
        # 文件路径加载（双保险）。
        _here = os.path.dirname(os.path.abspath(__file__))
        if _here not in sys.path:
            sys.path.insert(0, _here)
        # 打开每一步的耗时日志（uia step xxx -> X.XXs），下次卡住能直接看出停在哪步
        os.environ.setdefault("WHALE_STEPLOG", "1")
        boot("应用 uia_compat 补丁")
        try:
            import uia_compat
            boot("uia_compat.apply() = %r" % (uia_compat.apply(),))
        except Exception as _compat_err:
            try:
                import importlib.util as _ilu
                _spec = _ilu.spec_from_file_location(
                    "uia_compat", os.path.join(_here, "uia_compat.py"))
                _mod = _ilu.module_from_spec(_spec)
                sys.modules["uia_compat"] = _mod
                _spec.loader.exec_module(_mod)
                _mod.apply()
                boot("uia_compat 已按文件路径加载并生效")
            except Exception:                # noqa: BLE001
                boot("uia_compat 未生效: %r" % (_compat_err,))

        boot("import 完成")
    except Exception as e:
        boot("导入失败: %r" % (e,))
        log("缺少依赖或导入失败：", e)
        _msg = "%s %s" % (type(e).__name__, e)
        _dll_issue = (
            isinstance(e, OSError)
            or ("DLL load failed" in _msg)
            or ("WinError 126" in _msg)
            or ("WinError 127" in _msg)
            or ("找不到指定的模块" in _msg)
            or ("mfc" in _msg.lower())
            or ("vcruntime" in _msg.lower())
        )
        if _dll_issue:
            # Windows Server 默认不带 MFC/VC++ 运行库，wechatauto-replica 的原生模块就加载不了。
            # 以前这里一律让人 pip install，等于把用户带到沟里。
            log("")
            log("[!] 这不是缺 Python 包，是本机缺 VC++ 运行库（wechatauto-replica 的原生模块要用）。")
            log("    装这个（选 x64）：https://aka.ms/vs/17/release/vc_redist.x64.exe")
            log("    装完重启电脑，再双击「启动微信桥接.bat」。")
            log("    提示：Windows Server 默认不装 MFC，家庭版/专业版一般已有。")
        else:
            log("请先运行：\"%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe\" -m pip install wechatauto-replica requests")
        return 1

    cfg = read_config()
    gw = (cfg.get("gateway") or {}).get("wechat") or {}
    token = gw.get("inboundToken", "")
    bot_url = build_bot_url(cfg)
    aliases = ((cfg.get("persona") or {}).get("aliases") or []) + [
        ((cfg.get("persona") or {}).get("name") or "鲸鲸")
    ]

    log("引用回复：%s（关掉更快，需要时在 config.json 把 wechat.quoteReply 设 true）" % ("开" if QUOTE_REPLY else "关"))
    log("文件通道：入站=%s 出站=%s 单文件上限=%gMB" % (
        "开" if WECHAT_FILE_IN else "关", "开" if WECHAT_FILE_OUT else "关", WECHAT_FILE_MAX_MB))
    log("连接微信 4.x 数据库（只读）…")
    # token 一定要读到：读不到就是「她不理人」最隐蔽的原因（服务端会直接 401）
    if token:
        log("webhook token：已读取（%s…）" % token[:6])
    else:
        log("⚠️ webhook token 是空的！检查 config.json 的 gateway.wechat.inboundToken（文件要能正常解析）")
    db_dir = resolve_db_dir()
    if db_dir:
        log("数据库目录：", db_dir)
    # 多账号/双开：一定要把账号钉死。默认的「最近活跃库」启发式会选到另一个号
    # （大号天天在用 → 库最新 → 拿小号的配置去大号里发消息）。
    acct_dirs = find_account_dirs(db_dir) if db_dir else []
    acct = ACCOUNT_WANTED
    if acct:
        hit = resolve_account_dir(db_dir, acct) if db_dir else ""
        if not hit:
            log("")
            log("✗ 找不到微信账号 %r。" % acct)
            log("  这台机器上现有账号：%s" % ("、".join(acct_dirs) or "（一个都没有）"))
            log("  去网页「设置 → 微信账号」里重新选一个，或把 config.json 的")
            log("  wechat.account 改成上面某个名字（目录名 / wxid / 昵称都行，留空=自动选）。")
            log("  这里直接停下，不会偷偷换成别的号。")
            return 2
        if hit != acct:
            log("配置账号 %r → 账号目录 %s" % (acct, hit))
        acct = hit
        log("指定账号：", acct, "（网页设置 / config.json → wechat.account）")
    elif len(acct_dirs) > 1:
        log("⚠️ 这台机器有 %d 个微信账号：%s" % (len(acct_dirs), "、".join(acct_dirs)))
        log("   没指定账号 → 按「最近活跃」自动选，可能选到大号。")
        log("   去网页「设置 → 微信账号」里选一个（推荐：只选小号）。")

    # 打开微信数据库偶尔会「卡住不返回」（wechatauto-replica 内部去找微信进程/取密钥时挂住），
    # 表现就是「重启了但一直不监听」。这里给它 90 秒上限，超时明确报错退出。
    def _open_db_with_timeout(timeout=90):
        box = {}

        def _work():
            try:
                # 账号在这里一并钉死：不传 account 的话库会按「最近活跃」自己挑一个
                box["db"] = (
                    WeChatDB(db_dir=db_dir, account=acct or None)
                    if db_dir
                    else WeChatDB(account=acct or None)
                )
            except BaseException as exc:      # noqa: BLE001
                box["err"] = exc

        th = threading.Thread(target=_work, name="open-db", daemon=True)
        th.start()
        th.join(timeout)
        if th.is_alive():
            box["timeout"] = True
        return box

    log("打开微信数据库（这一步偶尔会卡，最多等 90 秒）…")
    _db_box = _open_db_with_timeout(90)
    if _db_box.get("timeout"):
        log("")
        log("✗ 打开微信数据库卡住超过 90 秒，已放弃这次启动（不是崩溃，是卡死）。")
        log("  常见原因：微信没完全登录 / 数据库被占用 / 微信正在更新。")
        log("  处理：确认微信已登录 → 重启微信 → 再双击「启动微信桥接.bat」。")
        log("  如果反复卡住，把 data\\bridge-hang.log 和这段日志发给作者。")
        return 2
    db = _db_box.get("db")
    _db_err = _db_box.get("err")
    try:
        if _db_err is not None:
            raise _db_err
    except RuntimeError as e:
        # 不甩 traceback：告诉用户接下来该点哪里
        log("")
        log("✗ 找不到微信的数据库目录，读不到消息。按顺序检查：")
        log("  1) 微信 4.x 是不是已经登录了？（停在扫码/登录界面时还没有数据库）")
        log("  2) 微信 → 左下角三条杠 → 设置 → 文件管理 → 「微信文件默认保存位置」")
        log("     把那个路径填进 config.json：\"wechat\": { \"dbDir\": \"E:\\\\xwechat_files\" }")
        log("     （填到 xwechat_files 这一层，不是里面的 wxid_xxx 目录）")
        log("  3) 保存后重新运行「启动微信桥接.bat」")
        log("  原始错误：%s" % e)
        return 2

    # 建库后硬断言：指定了账号就必须真的是那个账号。
    # wechatauto 在「密钥解不开当前号」时会把 account 换成另一个号（_try_other_accounts），
    # 不拦的话就会变成「读小号、写大号」。宁可停下，也不带着错号跑。
    if acct and db.account != acct:
        log("")
        log("✗ 账号被库自己换掉了：要的是 %s，实际打开的是 %s。" % (acct, db.account))
        log("  多半是微信当前登录的是另一个号，取到的密钥解不开 %s 的库。" % acct)
        log("  请确认微信现在登录的就是小号，再重启「启动微信桥接.bat」。")
        log("  （这里直接停下，绝不会用 %s 继续跑。）" % db.account)
        return 2
    _media_box = {"downloader": None}

    def _get_media():
        """按需创建媒体下载器；图片和表情识别共用一个实例。"""
        if _media_box["downloader"] is None:
            save_dir = os.path.join(ROOT, "data", "media-cache")
            os.makedirs(save_dir, exist_ok=True)
            dl = MediaDownloader(db, save_dir=save_dir)
            # 微信改过「文件保存位置」后，图片缓存可能留在旧目录（msg/attach），而
            # 数据库已经搬到了新位置。这时只看 db.account_dir 图片就永远找不到：
            # 「图片识别只认默认微信文件地址，改了就不行」就是这个原因。
            # 加一层只读兜底：当前目录找不到，就按会话 md5 去其它账号目录/盘里找。
            try:
                from media_fallback import install_media_fallback
                installed = install_media_fallback(
                    dl, db, log=log,
                    root_names=DB_ROOT_NAMES,
                )
                if installed:
                    log("图片目录兜底已就位（%d 处补丁）" % installed)
            except Exception as _e:
                log("图片目录兜底没装上（默认路径不受影响）：", repr(_e))
            _media_box["downloader"] = dl
        return _media_box["downloader"]

    me = db.wxid
    _self_nick = ""
    try:
        info = db.get_self_info() or {}
        _self_nick = str(info.get("nick_name") or info.get("remark") or "").strip()
        log("当前登录账号：", _self_nick or me)
    except Exception:
        log("当前登录账号 wxid：", me)
    log("账号目录：", db.account, "（网页/config 指定）" if acct else "（自动选：最近活跃）")
    if len(acct_dirs) > 1:
        log("（这台机器有 %d 个账号目录：%s）" % (len(acct_dirs), "、".join(acct_dirs)))
    log("数据库目录：", db.db_dir)

    sessions = {}
    try:
        for s in db.get_sessions(limit=800):
            sessions[s["username"]] = s
    except Exception as e:
        log("读取会话列表失败：", e)

    name_cache = {}

    def display_name(username):
        if username in name_cache:
            return name_cache[username]
        name = ""
        try:
            if username.endswith("@chatroom"):
                name = db.group_id_to_name(username) or ""
                if not name:
                    s = sessions.get(username) or {}
                    name = s.get("last_sender") or ""
            else:
                name = db.get_nickname(username) or ""
        except Exception:
            name = ""
        name = name or username
        name_cache[username] = name
        return name

    alias_cache = {}
    # 上次把这个会话切到哪一行名字（微信里没命名的群，行名是成员名）
    open_cache = {}

    def aliases_for(username, shown=""):
        """会话列表里那一行可能叫什么（微信里没命名的群，显示的是成员名）。

        实测：群 45063658812@chatroom 在数据库里 nick_name 是空的，会话列表里显示
        「宇火之于、云白『世一区』」—— 按群名/open_chat 都匹配不上，所以这里把
        「成员名用、连起来」也当候选名。
        """
        key = (username or "", shown or "")
        if key in alias_cache:
            return alias_cache[key]
        out = []
        if shown and shown != username and not str(shown).endswith("@chatroom"):
            out.append(shown)
        if username and str(username).endswith("@chatroom"):
            try:
                nm = db.group_id_to_name(username) or ""
            except Exception:
                nm = ""
            if nm and nm != username:
                out.append(nm)
            try:
                nicks = []
                for m in (db.get_group_members(username) or []):
                    if m.get("username") == me:
                        continue
                    n = (m.get("remark") or "").strip() or (m.get("nick_name") or "").strip()
                    if n:
                        nicks.append(n)
                if nicks:
                    out.append("、".join(nicks))
            except Exception:
                pass
        if not out:
            out.append(shown or username)
        out = [x for x in dict.fromkeys(out) if x]
        alias_cache[key] = out
        return out

    gui = None
    gui_lock = threading.Lock()
    send_lock = threading.Lock()
    dead_chats = set()
    fail_streak = {}
    self_wxid = db.wxid
    pending_replies = {}
    SEND_STATE = {"active": False, "start": 0.0}
    pending_lock = threading.Lock()
    AWAY = {"on": False}
    NOTIFIED = []

    # ---------- 多账号：把「读」和「发」钉在同一个号上 ----------
    # 微信 4.x 一个号一个进程，每个进程的主窗标题都叫「微信」。老逻辑按窗口面积挑，
    # 双开时挑中的往往是窗口更大的大号：
    #   读的是小号的库 → 收到「主人：你好」
    #   发的是大号的窗口 → 搜索结果里点到同名会话，回复从大号发了出去
    # 这里用「库里最近会话」反查窗口：哪个窗口的会话列表对得上这个账号，就钉哪个；
    # 一个都对不上就不发（宁可哑着，也不能从别人的号把私聊发出去）。
    ACCOUNT = {"hwnd": 0, "verified": False, "why": "", "label": ""}

    def _compat_mod():
        return sys.modules.get("uia_compat")

    def _account_recent_names(limit=12):
        """这个账号最近的会话名（用来和窗口里看得见的会话行做比对）。"""
        want = []
        try:
            rows = db.get_sessions(limit=limit) or []
        except Exception as e:                    # noqa: BLE001
            log("账号窗口：读会话列表失败：", repr(e))
            return want
        for s in rows:
            u = s.get("username") or ""
            try:
                nm = display_name(u)
            except Exception:                     # noqa: BLE001
                nm = ""
            if nm and nm != u:
                want.append(nm)
        return want

    def _probe_wechat_windows():
        """[(hwnd, 控件, 可见会话行名...)]：纯只读，不点任何东西。

        先对每个主窗热激活 mmui 树（只写 accessibility gate 字节，不置前、不点击），
        否则刚启动时子控件还是空的，读不到会话行。
        """
        import win32gui
        from wechatauto.uia_driver import WeChatUIA
        probe = WeChatUIA()
        out = []
        try:
            hwnds = list(probe._wechat_hwnds() or ())
        except Exception:                         # noqa: BLE001
            hwnds = []
        for h in hwnds:
            h = int(h)
            try:
                cls = win32gui.GetClassName(h) or ""
            except Exception:                     # noqa: BLE001
                cls = ""
            # 托盘消息窗/工具窗也带 Qt 类名，只有真主窗是 QWindowIcon 或 mmui::MainWindow
            if not ("QWindowIcon" in cls or "mmui::" in cls):
                continue
            try:
                probe._hot_activate_accessibility(h)
            except Exception:                     # noqa: BLE001
                pass
            c = None
            rows = []
            for _try in range(2):
                try:
                    c = probe._anchor(h)
                except Exception:                 # noqa: BLE001
                    c = None
                rows = []
                if c is not None and hasattr(probe, "_session_rows_of"):
                    try:
                        rows = [nm for nm, _ctl in probe._session_rows_of(c)]
                    except Exception:             # noqa: BLE001
                        rows = []
                if rows:
                    break
                time.sleep(0.4)
            out.append((h, c, rows))
        return probe, out

    def bind_gui_window(g):
        """把 WeChatGUI 的坐标/OCR 目标也对齐到锁定的账号窗口。"""
        if g is None:
            return g
        if ACCOUNT.get("hwnd"):
            try:
                g.use_window(ACCOUNT["hwnd"])
            except Exception:                     # noqa: BLE001
                pass
        return g

    def rebind_uia(hwnd, engine=None):
        """把 UIA 引擎 + uia_compat 的钉窗 + GUI 目标全部对齐到 hwnd。"""
        hwnd = int(hwnd or 0)
        if not hwnd:
            return False
        m = _compat_mod()
        if m is not None:
            try:
                m.pin_window(hwnd)
            except Exception:                     # noqa: BLE001
                pass
        targets = []
        if engine is not None:
            targets.append(engine)
        try:
            if UIA_CACHE.get("u") is not None:
                targets.append(UIA_CACHE["u"])
        except Exception:                         # noqa: BLE001
            pass
        for u in targets:
            try:
                u._pinned_hwnd = hwnd
                u._win = u._anchor(hwnd) or u._win
            except Exception:                     # noqa: BLE001
                pass
        try:
            if gui is not None:
                gui.use_window(hwnd)
        except Exception:                         # noqa: BLE001
            pass
        return True

    def pick_account_window(force=False, quiet=False):
        """确认哪个微信窗口是 config/网页指定的账号，并钉死它。"""
        if ACCOUNT["verified"] and not force:
            return True
        # 手动钉窗优先（config.json → wechat.windowHwnd）
        if WINDOW_HWND:
            try:
                import win32gui
                if win32gui.IsWindow(WINDOW_HWND):
                    ACCOUNT.update(hwnd=WINDOW_HWND, verified=True,
                                   label="hwnd=%s（配置）" % WINDOW_HWND,
                                   why="config.wechat.windowHwnd")
                    m = _compat_mod()
                    if m is not None:
                        try:
                            m.pin_window(WINDOW_HWND)
                        except Exception:         # noqa: BLE001
                            pass
                    if not quiet:
                        log("账号窗口：按 config 的 wechat.windowHwnd=%s 直接锁定" % WINDOW_HWND)
                    return True
            except Exception:                     # noqa: BLE001
                pass
        probe, cands = _probe_wechat_windows()
        if not cands:
            ACCOUNT.update(verified=False, hwnd=0, why="没扫到微信主窗")
            return False
        if len(cands) == 1:
            h, _c, _rows = cands[0]
            ACCOUNT.update(hwnd=h, verified=True, label="hwnd=%s" % h,
                           why="本机只登了一个号")
            m = _compat_mod()
            if m is not None:
                try:
                    m.pin_window(h)
                except Exception:                 # noqa: BLE001
                    pass
            if not quiet:
                log("账号窗口：只有一个微信主窗（hwnd=%s），直接用它" % h)
            return True

        want = _account_recent_names()
        log("账号窗口：本机有 %d 个微信主窗，按账号 %s 的最近会话认窗口：%s"
            % (len(cands), db.account, " / ".join(want[:6]) or "（空）"))
        for h, _c, rows in cands:
            log("   hwnd=%s 可见 %d 行：%s"
                % (h, len(rows), " | ".join(rows[:6]) or "（读不到会话列表）"))

        score_fn = getattr(probe, "_row_score", None)
        scored = []
        for h, c, rows in cands:
            if not rows:
                continue
            hits = []
            for i, nm in enumerate(want):
                for r in rows:
                    if score_fn is not None:
                        try:
                            if score_fn(r, [nm]) == 0:
                                hits.append(i)
                                break
                        except Exception:         # noqa: BLE001
                            continue
                    elif r.strip() == str(nm).strip():
                        hits.append(i)
                        break
            scored.append((bool(hits and hits[0] == 0), len(hits), h, c, rows))
        if not scored:
            ACCOUNT.update(verified=False, hwnd=0,
                           why="每个微信窗口都读不到会话列表")
            return False
        scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
        newest_ok, nhit, h, _c, rows = scored[0]
        if not newest_ok:
            best_hits = scored[0][1]
            tied = [x for x in scored if x[1] == best_hits]
            if best_hits < 2 or len(tied) > 1:
                ACCOUNT.update(verified=False, hwnd=0,
                               why="没有一个窗口对得上账号 %s 的最近会话" % db.account)
                return False

        ACCOUNT.update(hwnd=h, verified=True, label="hwnd=%s" % h,
                       why="命中最近会话 %d 条" % nhit)
        m = _compat_mod()
        if m is not None:
            try:
                m.pin_window(h)
            except Exception as e:                # noqa: BLE001
                log("账号窗口：pin_window 失败：", repr(e))
        log("账号窗口：锁定 hwnd=%s（%d 个窗口里对上 %d 条最近会话%s）"
            % (h, len(scored), nhit, "，最新一条也在" if newest_ok else ""))
        return True

    def ensure_account_window(engine=None):
        """发送前确认「锁定的微信窗口」还活着；微信重启/换号后自动重认。

        不这么做的话：微信重开一次，hwnd 变了，而 ACCOUNT["verified"] 还是 True，
        于是每次发送都被「引擎窗口和锁定窗口不一致」拦下、连失败两次后会话被标死。
        """
        hw = int(ACCOUNT.get("hwnd") or 0)
        alive = False
        if hw:
            try:
                import win32gui
                alive = bool(win32gui.IsWindow(hw))
            except Exception:                     # noqa: BLE001
                alive = False
        if ACCOUNT.get("verified") and alive:
            # uia_compat 那边发现旧 hwnd 死了会把钉窗清掉，这里补回去，
            # 否则下一次找主窗又会按面积挑，可能挑到别的号。
            m = _compat_mod()
            if m is not None:
                try:
                    if int(m.pinned_window() or 0) != hw:
                        rebind_uia(hw, engine)
                        log("账号窗口：UIA 钉窗和锁定窗口不一致，已钉回 hwnd=%s" % hw)
                except Exception:                 # noqa: BLE001
                    pass
            return True
        if hw and not alive:
            log("⚠️ 锁定的微信窗口 hwnd=%s 已经不在了（微信重启/换号），重新认账号…" % hw)
            ACCOUNT.update(verified=False, why="锁定窗口已失效")
        try:
            ok = pick_account_window(force=True, quiet=True)
        except Exception as e:                    # noqa: BLE001
            log("重新认账号失败：", repr(e))
            return False
        if not ok:
            return False
        rebind_uia(ACCOUNT.get("hwnd"), engine)
        log("账号窗口已重新锁定 hwnd=%s（%s）"
            % (ACCOUNT.get("hwnd"), ACCOUNT.get("why") or ""))
        return True

    def account_send_allowed(where, engine=None):
        """统一的发送闸：认不出目标账号窗口就不发。"""
        if ensure_account_window(engine):
            return True
        if ACCOUNT_GUARD:
            ACCOUNT["blockedAt"] = time.time()
            log("⚠️ 不发送（%s）：没能确认哪个微信窗口是账号 %s（%s）；"
                "现在可能同时登着别的号，乱发会从别人的号发出去。"
                % (where, db.account, ACCOUNT["why"] or "未知"))
            return False
        return True

    def away_active():
        """主人在微信里发了「我去玩了」→ 写 data/away.json，这里据此静默排队。"""
        try:
            p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "away.json")
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
            return float(d.get("until") or 0) > time.time()
        except Exception:
            return False

    def game_running():
        if not GAME_TOKENS:
            return False
        try:
            import psutil
            for p in psutil.process_iter(["name"]):
                n = (p.info.get("name") or "").lower()
                if any(t in n for t in GAME_TOKENS):
                    return True
        except Exception:
            pass
        return False

    def foreground_is_fullscreen():
        """前台是不是「真全屏」程序（全屏游戏、全屏视频）——这时别抢焦点，先把回复排着。

        不能拿屏幕尺寸判断：Windows 上最大化窗口的 GetWindowRect 带 DWM 隐形边框，
        实测 2560x1440 的屏幕，最大化浏览器返回 rect=(-8,-8,2568,1448)，
        旧的 `r[2] >= sw-2 and r[3] >= sh-2` 会把它当全屏 ——
        表现就是「用户把窗口一最大化，她就不理人了」（3.3.1 实测复现）。

        改成两条一起判：
          ① 盖住整个显示器（MonitorFromWindow 取 rcMonitor，不是屏幕尺寸）；
          ② 没有标题栏和边框（真全屏游戏/无边框视频都是 WS_POPUP）。
        最大化窗口带 WS_CAPTION|WS_THICKFRAME，因此被正确排除。
        """
        try:
            import ctypes
            import ctypes.wintypes as wt
            import psutil
            import win32con
            import win32gui
            import win32process
            h = win32gui.GetForegroundWindow()
            if not h:
                return False
            _, pid = win32process.GetWindowThreadProcessId(h)
            name = psutil.Process(pid).name().lower()
            if name.startswith("weixin"):
                return False
            style = win32gui.GetWindowLong(h, win32con.GWL_STYLE)
            if (style & win32con.WS_CAPTION) and (style & win32con.WS_THICKFRAME):
                return False        # 普通窗口或最大化：有标题栏+可调边框，不是全屏

            class _MONITORINFO(ctypes.Structure):
                _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT),
                            ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]

            user32 = ctypes.windll.user32
            mi = _MONITORINFO()
            mi.cbSize = ctypes.sizeof(_MONITORINFO)
            hmon = user32.MonitorFromWindow(h, 2)  # MONITOR_DEFAULTTONEAREST
            if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                return False
            mon = mi.rcMonitor
            r = win32gui.GetWindowRect(h)
            return (r[0] <= mon.left + 1 and r[1] <= mon.top + 1
                    and r[2] >= mon.right - 1 and r[3] >= mon.bottom - 1)
        except Exception:
            return False

    def group_is_alive(chat_username):
        """被踢出群后，群会话还在，但发不出去；先查成员列表。"""
        if not str(chat_username).endswith("@chatroom"):
            return True
        try:
            members = db.get_group_members(chat_username) or []
            ids = {str(m.get("wxid") or m.get("username")) for m in members}
            return self_wxid in ids
        except Exception:
            return True

    # ---------- 微信窗口置顶（关键：别的窗口挡在微信上面会导致打字落空） ----------
    def find_weixin_hwnd():
        try:
            import win32gui
            import win32con
            import win32process
            import psutil
        except Exception:
            return 0
        found = []
        # 微信（4.x / Qt）会额外建一个「托盘图标隐藏消息窗」：它算可见窗口，
        # 而且 GetWindowRect 出来的面积常常比主窗还大（实测 1320x900 > 主窗 896x776）。
        # 以前按「面积最大」挑，就会挑中它 —— 对它 SetWindowPos 直接 error(5) 拒绝访问，
        # 于是每次发送都失败、走 OCR 兜底、再被看门狗重启，一直循环报「拒绝访问」。
        BAD_CLASS = ("trayicon", "messagewindow", "msctf", "sopy", "sogou", "hintwnd", "default ime", "notifyicon")

        def cb(h, _):
            try:
                title = win32gui.GetWindowText(h) or ""
                _, pid = win32process.GetWindowThreadProcessId(h)
                if pid <= 0:
                    return
                cls = win32gui.GetClassName(h) or ""
                low = cls.lower()
                if any(bad in low for bad in BAD_CLASS):
                    return
                rect = win32gui.GetWindowRect(h)
                area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
                if win32gui.IsIconic(h):
                    # 最小化后 GetWindowRect 是 (-16000,-16000,…) 的退化矩形，
                    # 换算成「还原后」的尺寸再判大小
                    try:
                        rc = win32gui.GetWindowPlacement(h)[4]
                        area = max(0, rc[2] - rc[0]) * max(0, rc[3] - rc[1]) or area
                    except Exception:
                        pass
                # 不再要求 IsWindowVisible：微信缩在托盘里时主窗 visible=0，以前这里
                # 直接 return，于是整条「置顶 + 调窗口」都被跳过。主窗至少 300x250，
                # 托盘提示窗（260x85）和辅助窗（173x196）顺手被排除。
                if area < 300 * 250 and title.strip() != "微信":
                    return
                try:
                    name = psutil.Process(pid).name().lower()
                except Exception:
                    return
                if not name.startswith("weixin"):
                    return
                if "发送" in title or "助手" in title:
                    return
                try:
                    style = win32gui.GetWindowLong(h, win32con.GWL_STYLE)
                    has_min_box = bool(style & win32con.WS_MINIMIZEBOX)
                except Exception:
                    has_min_box = False
                is_main_title = title.strip() == "微信"
                looks_main_class = ("qwindowicon" in low) or ("mmui::mainwindow" in low)
                # 真主窗的三条特征都各加一个大权重，面积只在同类里起作用，
                # 这样托盘消息窗再“大”也排不到前面
                score = area
                if is_main_title:
                    score += 10 ** 9
                if looks_main_class:
                    score += 10 ** 8
                if has_min_box:
                    score += 10 ** 7
                found.append((score, 1 if is_main_title else 0, h))
            except Exception:
                pass

        try:
            win32gui.EnumWindows(cb, None)
        except Exception:
            return 0
        if not found:
            return 0
        found.sort(reverse=True)
        return found[0][2]

    def wechat_window_alive():
        """微信主窗现在是否还存在（每次现找，不缓存 —— 微信窗口回收/更新后，缓存句柄会失效）。

        长时间挂着不管时，微信可能半夜自更新、或把窗口拆了重开，此时 uiautomation
        手里还攥着旧窗口的 COM 指针 / 句柄，再碰一次就直接 0xC0000005（访问违规），
        Python 的 try/except 拦不住，进程当场死掉 —— 也就是「Bridge exited with code
        -1073741819」。这些 UIA 调用前先问一句窗口还在不在，就能把这种崩溃挡在外面。
        """
        try:
            import win32gui
            # 多账号：钉住之后只认钉住的那个窗口，别拿「另一个号的主窗」当活着的证据
            h = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
            return bool(h and win32gui.IsWindow(h))
        except Exception:
            return False

    def normalize_window(hwnd):
        """微信窗口太小 / 超出屏幕 / 被挪走都会让 UI 自动化点空，统一调成稳定尺寸。"""
        try:
            import win32gui
            import win32con
            import win32api
            sw, sh = win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1)
            rect = win32gui.GetWindowRect(hwnd)
            x, y, w, h = rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]
            tw, th = min(1320, sw - 160), min(900, sh - 160)
            need = w < 1080 or h < 760 or w > sw - 80 or h > sh - 80 or x < -20 or y < -20 or x + w > sw + 20 or y + h > sh + 20
            if need:
                win32gui.SetWindowPos(hwnd, win32con.HWND_TOP, 40, 20, tw, th, win32con.SWP_SHOWWINDOW)
                log("微信窗口调整：%dx%d @(%d,%d) → %dx%d（保证自动发送稳定）" % (w, h, x, y, tw, th))
                time.sleep(0.8)
        except Exception as e:
            log_window_problem("调整微信窗口失败（继续发送）", e)

    def force_send_foreground(fn):
        """把微信拉到前台再发送（真正的兜底路径）。

        注意：实测下来大多数时候**不需要**这条路 —— 微信最小化、被别的窗口挡住、
        甚至前台是全屏程序时，UIA 都能正常发送（见 docs/接入微信.md 的实测数据）。
        所以它只作为「后台发送失败后」的第二次尝试。
        """
        hwnd = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
        was_topmost = False
        touched = False
        try:
            import win32gui
            import win32con
            if hwnd:
                try:
                    if not win32gui.IsWindowVisible(hwnd):
                        # 微信在托盘里时主窗是隐藏的，先把窗口拉出来再打字
                        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
                        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                        log("微信在托盘里，已把主窗口拉出来再发送")
                        time.sleep(0.4)
                except Exception as e:
                    log("拉出微信窗口失败：", repr(e))
                normalize_window(hwnd)
                try:
                    fg = win32gui.GetForegroundWindow()
                except Exception:
                    fg = 0
                if fg != hwnd:
                    touched = True
                    force_foreground(hwnd)
                    ex = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
                    was_topmost = bool(ex & win32con.WS_EX_TOPMOST)
                    # 置顶失败不该让整条发送失败（比如挑到了不能定位的窗口），
                    # 顶多是“可能被别的窗口挡住”，打字还有 UIA 兜着
                    try:
                        win32gui.SetWindowPos(
                            hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                            win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
                        )
                    except Exception as e:
                        log_window_problem("窗口置顶失败（继续发送）", e)
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                    time.sleep(0.2)
            return fn()
        finally:
            try:
                if touched and hwnd and not was_topmost:
                    import win32gui
                    import win32con
                    win32gui.SetWindowPos(
                        hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                        win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
                    )
            except Exception:
                pass

    def with_window_on_top(fn):
        """发送前确保能发出去。

        默认**不长期占用前台**（backgroundSend=true）：
          1. 先直接让 UIA 在后台发（微信最小化/被遮挡也能发，实测 18/18）；
          2. 万一失败，才把微信拉到前台重试一次；
          3. 不管成功失败，**发完都把窗口状态还原**（该最小化的重新最小化、前台还给原来的窗口），
             这样你在用电脑时最多看到它闪一下。
        把 wechat.backgroundSend 设成 false 就退回以前的「每次先抢前台、发完不管」。
        """
        if game_running():
            return False
        SEND_STATE["active"] = True
        SEND_STATE["start"] = time.time()
        snap = snapshot_win_state() if BACKGROUND_SEND else None
        try:
            if BACKGROUND_SEND:
                # 最小化/隐藏时 UIA 的 COM 调用可能直接卡死（不会返回 False），
                # 所以发送前先恢复一次窗口；发完 restore_win_state 会还原最小化。
                try:
                    if snap and snap.get("iconic"):
                        import win32gui
                        import win32con
                        win32gui.ShowWindow(snap["hwnd"], win32con.SW_RESTORE)
                        log("微信窗口当时最小化，发送前先恢复（发完再还原）")
                        time.sleep(0.35)
                except Exception:
                    pass
                try:
                    if fn():
                        return True
                except Exception as e:                 # noqa: BLE001
                    log("后台发送异常，改走前台重试：", repr(e))
                log("后台发送没成功，把微信拉到前台再试一次")
                return force_send_foreground(fn)
            return force_send_foreground(fn)
        finally:
            if BACKGROUND_SEND:
                restore_win_state(snap)
            SEND_STATE["active"] = False

    def force_foreground(hwnd):
        """把微信强制拉到前台，并且**确认真的到位**。

        原来的实现「调用完就 return True」，但 SetForegroundWindow 会被 Windows
        的前台锁拒绝（你正在浏览器里打字时尤其明显），于是表情包发送时判断
        「微信不在前台」→ 直接失败。现在每轮都读一次 GetForegroundWindow 复核，
        并补上两种业界常用的解锁手段：
          ① 轻点一下 ALT 解除前台锁，再 SwitchToThisWindow；
          ② AttachThreadInput + BringWindowToTop + SetForegroundWindow。
        连续几轮都不成功才返回 False，交给调用方明确报错。
        """
        try:
            import ctypes
            import win32api
            import win32con
            import win32gui
        except Exception:
            return False
        hwnd = int(hwnd or 0)
        if not hwnd:
            return False
        user32 = ctypes.windll.user32
        try:
            if win32gui.GetForegroundWindow() == hwnd:
                return True
        except Exception:
            return False
        for _attempt in range(4):
            try:
                fg = win32gui.GetForegroundWindow()
                tid_fg = user32.GetWindowThreadProcessId(fg, None)
                tid = user32.GetWindowThreadProcessId(hwnd, None)
                try:
                    user32.AttachThreadInput(tid_fg, tid, True)
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                    user32.BringWindowToTop(hwnd)
                    win32gui.SetForegroundWindow(hwnd)
                finally:
                    try:
                        user32.AttachThreadInput(tid_fg, tid, False)
                    except Exception:
                        pass
                if win32gui.GetForegroundWindow() == hwnd:
                    return True
                # 前台锁最常见：先按一下 ALT，把「前台占用」释放掉
                win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
                win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
                time.sleep(0.05)
                try:
                    user32.SwitchToThisWindow(hwnd, True)
                except Exception:
                    pass
                time.sleep(0.15)
                if win32gui.GetForegroundWindow() == hwnd:
                    return True
            except Exception:
                pass
            time.sleep(0.15)
        try:
            return win32gui.GetForegroundWindow() == hwnd
        except Exception:
            return False

    UIA_CACHE = {"u": None}

    def press_enter(with_ctrl=False):
        """用底层按键补发 Enter（UIA 的 SendKeys 有时不触发发送）。"""
        try:
            import win32api
            import win32con
            hwnd = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
            if hwnd:
                force_foreground(hwnd)
            time.sleep(0.10)
            if with_ctrl:
                win32api.keybd_event(0x11, 0, 0, 0)
            win32api.keybd_event(0x0D, 0, 0, 0)
            win32api.keybd_event(0x0D, 0, win32con.KEYEVENTF_KEYUP, 0)
            if with_ctrl:
                win32api.keybd_event(0x11, 0, win32con.KEYEVENTF_KEYUP, 0)
            time.sleep(0.25)
            return True
        except Exception as e:
            log("手动回车失败：", repr(e))
            return False

    def snapshot_win_state():
        """记下发送前的「窗口长什么样」，发完要还原。

        要还原的东西：微信是不是最小化、原来哪个窗口在前台。
        """
        snap = {"hwnd": 0, "iconic": False, "fg": 0}
        try:
            import win32gui
            snap["hwnd"] = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd() or 0
            if snap["hwnd"]:
                snap["iconic"] = bool(win32gui.IsIconic(snap["hwnd"]))
            snap["fg"] = win32gui.GetForegroundWindow() or 0
        except Exception:
            pass
        return snap

    def restore_win_state(snap):
        """把窗口状态还原：微信重新最小化，前台还给刚才那个窗口。

        实测（2026-10-25 02:5x）：微信最小化 + 前台是浏览器时发一条，窗口会被抬起约 5 秒；
        发完立刻最小化并把前台还回去，用户几乎无感。
        SetForegroundWindow 会被前台锁拒绝，所以带 ALT 解锁 + 重试 + SwitchToThisWindow 兜底。
        """
        if not snap:
            return
        try:
            import ctypes
            import win32api
            import win32gui
            import win32con
            wx = snap.get("hwnd")
            if wx and snap.get("iconic"):
                try:
                    win32gui.ShowWindow(wx, win32con.SW_MINIMIZE)
                except Exception:
                    pass
                time.sleep(0.12)
            fg = snap.get("fg")
            if not fg or fg == wx or not win32gui.IsWindow(fg):
                return
            for attempt in range(3):
                try:
                    # 先按一下 ALT 解锁前台锁（单独 SetForegroundWindow 会被拒绝）
                    win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
                    win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
                    time.sleep(0.04)
                    ctypes.windll.user32.SetForegroundWindow(fg)
                except Exception:
                    pass
                time.sleep(0.12)
                if ctypes.windll.user32.GetForegroundWindow() == fg:
                    return
                # 兜底：SwitchToThisWindow 不受前台锁限制（老 API，但有效）
                try:
                    ctypes.windll.user32.SwitchToThisWindow(fg, True)
                except Exception:
                    pass
                time.sleep(0.12)
                if ctypes.windll.user32.GetForegroundWindow() == fg:
                    return
            log_window_problem("还原前台失败（窗口已最小化，不影响使用）", None)
        except Exception as e:                      # noqa: BLE001
            log_window_problem("还原窗口状态失败", e)

    def install_quiet_uia(u):
        """让 UIA 引擎「别抢前台」。

        wechatauto 的 WeChatUIA.ensure_window() 每次都会调 _activate() →
        _force_foreground()/ShowWindow(9)，也就是把微信窗口恢复并抢到最前面。
        实测 18/18：微信最小化、被遮挡、前台全屏时其实都能发，所以这步纯属多余，
        代价是你正在用的电脑被反复打断。

        这里给引擎实例打个补丁：quiet_mode 打开时 _activate 直接返回。
        不改第三方库文件，随桥接一起走；万一后台发不出去，force_send_foreground()
        会显式把窗口拉出来，不依赖这个补丁。
        """
        try:
            import types
            if getattr(u, "_whale_quiet_patch", False):
                u.quiet_mode = True
                return
            orig = u._activate

            def patched(self, win, _orig=orig):
                if getattr(self, "quiet_mode", False):
                    return
                return _orig(win)

            u._activate = types.MethodType(patched, u)
            u._whale_quiet_patch = True
            u.quiet_mode = True
        except Exception as e:                      # noqa: BLE001
            log("后台模式补丁没打上（不影响发送）：", repr(e))

    def uia_send(text, who, username=""):
        """优先用 UIA 发送：不依赖 OCR 找发送按钮，成功后返回 True。"""
        # 账号闸：先确认「要打字的这个窗口」就是配置指定的那个号，窗口换了就重认
        if not account_send_allowed("UIA"):
            return False
        if not wechat_window_alive():
            # 主窗没了，缓存引擎里的句柄已失效，碰了会 0xC0000005；直接走键盘/OCR 兜底
            with gui_lock:
                UIA_CACHE["u"] = None
            return False
        u = UIA_CACHE["u"]
        # 每次发送都问一次库里的引擎（它内部 30 秒节流、会自己检测「子控件不可见」并重新热激活）。
        # 以前只在缓存为空时才问，结果微信把 accessibility gate byte 归零后，缓存的引擎变成
        # 「假死」：能收消息、但一条也发不出去，挂着挂着就不理人了，只能重启桥接才好。
        try:
            with gui_lock:
                fresh = gui._get_uia() if gui is not None else None
            if fresh is not None:
                u = fresh
            UIA_CACHE["u"] = u
        except Exception:
            u = UIA_CACHE["u"]
        if u is None:
            return False
        if BACKGROUND_SEND:
            # 后台模式：禁止引擎自己恢复窗口/抢前台（真正的抢前台只在兜底那一步做）
            install_quiet_uia(u)
        keys = aliases_for(username, who) if username else [who]
        try:
            cur = None
            try:
                cur = u.current_chat()
            except Exception:
                pass
            hit_cur = (cur == who) or any(cur == k for k in keys if k)
            if not hit_cur and username:
                hit_cur = bool(cur) and open_cache.get(username) == cur
            if not hit_cur:
                if not u.open_chat(keys):
                    try:
                        u.back_to_chat_tab()
                    except Exception:
                        pass
                    if not u.open_chat(keys):
                        return False
                if username:
                    try:
                        open_cache[username] = u.current_chat() or ""
                        log("UIA 已切到会话：", open_cache[username])
                    except Exception:
                        pass
            t_open = time.time()
            sent_ok = False
            try:
                sent_ok = bool(u.send_text(text))
            except Exception:
                sent_ok = False
            if not sent_ok:
                try:
                    u.back_to_chat_tab()
                    sent_ok = bool(u.send_text(text))
                except Exception:
                    sent_ok = False
            log("UIA 发送耗时 %.1fs（打开会话+输入）" % (time.time() - t_open))
            if sent_ok:
                # 多按几次：Enter 两次 + Ctrl+Enter 两次（兼容“按 Ctrl+Enter 发送”的设置）
                press_enter(False)
                press_enter(False)
                press_enter(True)
                press_enter(True)
                return True
        except Exception as e:
            log("UIA 发送异常：", repr(e))
        return False

    def recover_uia(reason=""):
        """强制重新热激活 UIA（rewrite gate byte + 校验），成功返回 True。

        微信跑久了会把 accessibility gate byte 归零，UIA 引擎就变成「假死」：
        能读消息、发不出去。以前只能重启桥接；这里让它自己救回来。
        """
        try:
            if gui is None:
                return False
            if not wechat_window_alive():
                with gui_lock:
                    UIA_CACHE["u"] = None
                log("UIA 重新热激活跳过（微信主窗当前不存在）")
                return False
            with gui_lock:
                u = gui._get_uia(refresh=True)
            UIA_CACHE["u"] = u
            if u is not None:
                log("UIA 已重新热激活%s" % (("（" + reason + "）") if reason else ""))
                return True
            log("UIA 重新热激活失败%s" % (("（" + reason + "）") if reason else ""))
        except Exception as e:                     # noqa: BLE001
            log("UIA 重新热激活异常：", repr(e))
        return False

    def keyboard_send(text, chat_display_name, chat_username=""):
        """完全不依赖 UIA 的发送通道：Ctrl+F 搜索会话 → 粘贴 → 回车 → 回读数据库确认。

        为什么需要它：UIA 依赖微信的 accessibility gate，微信跑久了/窗口状态怪的时候
        整条路都会挂（见 recover_uia 的注释）。键盘通道只用 Win32 按键 + 剪贴板，
        走的是微信自己的搜索框，不碰 accessibility。
        代价：会抢前台、慢一些，所以只在 UIA 真的发不出去时用。
        """
        # 账号闸：键盘通道是在「当前前台窗口」里按 Ctrl+F 搜会话的，
        # 不先钉住目标号的话，搜索会落在另一个账号的微信窗口里。
        if not account_send_allowed("键盘通道"):
            return False
        try:
            import ctypes
            import win32api          # noqa: F401
            import win32clipboard
            import win32con
            import win32gui
            user32 = ctypes.windll.user32
        except Exception as e:                     # noqa: BLE001
            log("键盘通道不可用（缺少 win32 模块）：", repr(e))
            return False

        hwnd = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
        if not hwnd:
            log("键盘通道：找不到微信主窗")
            return False

        def fg():
            return user32.GetForegroundWindow()

        # 抢前台：单独 SetForegroundWindow 会被前台锁拒绝，先按一下 ALT 解锁
        if fg() != hwnd:
            user32.keybd_event(win32con.VK_MENU, 0, 0, 0)
            time.sleep(0.05)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.2)
            user32.keybd_event(win32con.VK_MENU, 0, 2, 0)
            time.sleep(0.2)
        if fg() != hwnd:
            try:
                user32.SwitchToThisWindow(hwnd, True)
                time.sleep(0.3)
            except Exception:
                pass
        if fg() != hwnd:
            log("键盘通道：抢不到前台，放弃这次（UIA 也不可用时这条就发不出去了）")
            return False

        def set_clip(t):
            for _ in range(5):
                try:
                    win32clipboard.OpenClipboard()
                    break
                except Exception:                  # noqa: BLE001
                    time.sleep(0.1)
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, t)
            finally:
                win32clipboard.CloseClipboard()

        def tap(vk, mods=()):
            for m in mods:
                user32.keybd_event(m, 0, 0, 0)
            user32.keybd_event(vk, 0, 0, 0)
            user32.keybd_event(vk, 0, 2, 0)
            for m in reversed(mods):
                user32.keybd_event(m, 0, 2, 0)
            time.sleep(0.12)

        def confirmed_target():
            """打开会话后确认「现在开着的到底是谁」。

            键盘通道是模拟按键，搜不到人时回车会落到「当前那个会话」上，
            正文就直接发给别人了 —— 2026-10-25 12:21 的日志里就出现过
            「键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话）」。
            这里用 UIA 的只读能力核对（读会话名在「能读不能发」的假死状态下依然可用）；
            读不到就宁可这条失败，也不盲发 —— 私聊内容发错人比晚回一条严重得多。
            返回 (是否匹配, 当前会话名)。
            """
            try:
                u = gui._get_uia() if gui is not None else None
                cur = u.current_chat() if u is not None else None
            except Exception:
                cur = None
            if not cur:
                return None, None
            cands = {chat_display_name}
            try:
                if chat_username:
                    cands.update(aliases_for(chat_username, chat_display_name))
                    cached = open_cache.get(chat_username)
                    if cached:
                        cands.add(cached)
            except Exception:
                pass
            return (cur in cands), cur

        try:
            # ① 搜索会话（微信的 Ctrl+F）
            tap(ord("F"), (win32con.VK_CONTROL,))
            time.sleep(0.5)
            set_clip(chat_display_name)
            tap(ord("V"), (win32con.VK_CONTROL,))
            time.sleep(0.8)
            tap(win32con.VK_RETURN)          # ② 打开会话
            time.sleep(0.9)
            # ②.5 先核对打开的是不是目标会话，确认不了就不往输入框里打字
            matched, cur = confirmed_target()
            if matched is None:
                log("键盘通道：读不到当前会话名，为防发错人这次不发")
                return False
            if not matched:
                log("键盘通道：打开的是「%s」而不是「%s」，为防发错人这次不发"
                    % (cur or "", chat_display_name))
                return False
            set_clip(text)                    # ③ 粘贴正文
            tap(ord("V"), (win32con.VK_CONTROL,))
            time.sleep(0.4)
            tap(win32con.VK_RETURN)          # ④ 发送
        except Exception as e:                 # noqa: BLE001
            log("键盘通道按键失败：", repr(e))
            return False

        # ⑤ 回读数据库确认这条真的发出去了（搜错会话时能立刻发现）
        for _ in range(8):
            time.sleep(0.5)
            try:
                msgs = db.get_messages(chat_username or chat_display_name, limit=3) or []
            except Exception:
                msgs = []
            for m in msgs:
                if str(m.get("content") or "").strip()[:12] == str(text).strip()[:12]:
                    return True
        log("键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话），这条按失败处理")
        return False

    # Protected by send_lock. Feature OFF must not erase a latent attachment
    # draft: this guard protects ordinary text/@ sends too, without sending keys.
    sticker_draft_quarantine = {}

    def sticker_quarantine_allows(username, shown="", gui_locked=False):
        requested = str(username or "").strip()
        matches = [(key, entry) for key, entry in sticker_draft_quarantine.items()
                   if key == requested or (not requested and
                       (str(shown or "").strip() == key or str(shown or "").strip() in entry["aliases"]))]
        if not matches:
            return True

        def inspect():
            for key, entry in matches:
                value = None
                try:
                    compat = _compat_mod()
                    if (ACCOUNT.get("verified") and int(ACCOUNT.get("hwnd") or 0) == entry["hwnd"]
                            and compat is not None and int(compat.pinned_window() or 0) == entry["hwnd"]
                            and wechat_window_alive()):
                        value = quarantined_input_value(gui, entry["hwnd"], entry["aliases"])
                except Exception:
                    pass
                if value not in (None, ""):
                    entry["draft_observed"] = True
                if value == "" and entry["draft_observed"]:
                    sticker_draft_quarantine.pop(key, None)
                else:
                    return False
            return True

        if gui_locked:
            allowed = inspect()
        else:
            with gui_lock:
                allowed = inspect()
        if not allowed:
            log_throttled("uncertain-attachment-draft", "发送暂停：上次附件操作可能留有草稿；请手动清空目标输入框后重试。"
                          "无法读取清空证据时，请手动清空后重启桥接。", ttl=60)
        return allowed

    def sticker_account_evidence_allowed():
        # 只有一个可见微信窗口时，文字消息一直是认的；表情包以前额外要求
        # 「手动钉窗口」，结果多开过的机器全都发不出去（日志里就是
        # 「failed target account window could not be verified」）。
        # 现在和文字用同一套证据：只要明确指定了账号、且数据库就是用这个号
        # 打开的，就放行；没指定账号、多个账号目录又分不清时才拒绝。
        explicit_pin = bool(WINDOW_HWND and int(WINDOW_HWND) == int(ACCOUNT.get("hwnd") or 0))
        allowed = sticker_account_evidence_ok(
            configured_account=acct,
            db_account=getattr(db, "account", ""),
            reason=ACCOUNT.get("why"),
            explicit_pin=explicit_pin,
            account_dirs=acct_dirs,
        )
        if not allowed:
            log_throttled(
                "sticker-account-ambiguous",
                "表情包跳过：这台机器有多个微信账号目录，但没指定用哪一个。"
                "去网页「设置 → 微信账号」选一个再发（文字消息已经在用「最近活跃」那个，"
                "表情包不猜，免得从别的号发出去）。",
                ttl=300,
            )
        return allowed

    sticker_headers = {"x-bot-token": token, "x-whale-bridge": "1"}
    sticker_base = bot_url.rsplit("/webhook", 1)[0]

    def sticker_config_now():
        # Dormant worker does no sticker HTTP/path/GUI work while the cached flag
        # is off. Only config_watch re-enables it; an on flag is NEVER authority
        # to act without a fresh disk read.
        global STICKER_TEST_ON
        if not STICKER_TEST_ON:
            return None
        current = read_enabled_config(CONFIG_PATH)
        if current is None:
            STICKER_TEST_ON = False
            return None
        # A pending account change must not send through the old DB/window while
        # config_watch is still waiting to restart the bridge.
        if str((current.get("wechat") or {}).get("account") or "").strip() != ACCOUNT_WANTED:
            return None
        return current

    def sticker_gate(generation, job_id=""):
        if not generation or sticker_config_now() is None:
            return False
        try:
            response = LOCAL_HTTP.get(sticker_base + "/api/stickers/status",
                                      headers=sticker_headers, timeout=3)
            status = response.json() if response.status_code == 200 else None
            return bool(isinstance(status, dict) and status.get("ok") is True
                        and status.get("enabled") is True
                        and status.get("generation") == generation
                        and (not job_id or any(isinstance(job, dict) and job.get("id") == job_id
                                               and job.get("status") == "sending"
                                               and job.get("generation", generation) == generation
                                               for job in (status.get("jobs") or [])))
                        and sticker_config_now() is not None)
        except Exception:
            return False

    def sticker_activity_allowed(username=""):
        try:
            return not (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()
                        or (username and (username in dead_chats or not group_is_alive(username))))
        except Exception:
            return False

    def send_sticker(path, chat_display_name, chat_username="", generation="", job_id=""):
        """一次性、无导航的图片粘贴；只能向已在前台打开且聚焦的精确会话发送。"""
        if not job_id or not sticker_gate(generation, job_id):
            return sticker_result("cancelled", "stickers are disabled or generation expired")
        with send_lock:
            if not sticker_gate(generation, job_id):
                return sticker_result("cancelled", "stickers are disabled or generation expired")
            if not sticker_quarantine_allows(chat_username, chat_display_name):
                return sticker_result("failed", "an uncertain attachment draft must be cleared manually before further sends")
            if not sticker_activity_allowed(chat_username):
                return sticker_result("failed", "activity gate rejected the sticker")
            if (not account_send_allowed("表情包") or not ACCOUNT.get("verified")
                    or not wechat_window_alive() or not sticker_account_evidence_allowed()):
                return sticker_result("failed", "target account window could not be verified")
            hwnd = int(ACCOUNT.get("hwnd") or 0)
            snap = None
            try:
                desktop = WindowsDesktop()
                if not desktop.foreground(hwnd):
                    # 以前这里是「微信不在前台就不发」，结果用户点完发送还得自己去切窗口，
                    # 实际表现就是「表情包发不出去」。文字发送本来就是先抬一下微信、发完还原；
                    # 这里做同样的事：短暂抬到前台，粘贴前仍会重新校验会话标题/焦点/空输入框。
                    snap = snapshot_win_state()
                    if not force_foreground(hwnd) or not desktop.foreground(hwnd):
                        return sticker_result("failed", "could not bring the WeChat window to the foreground")
                    log_throttled("sticker-foreground", "表情包：微信不在前台，先切过去（发完会把窗口还原）", ttl=120)
            except Exception:
                return sticker_result("failed", "foreground safety checks are unavailable")
            try:
              with gui_lock:
                # Do not initialize/activate any window just to send a sticker.
                current_gui = gui
                if current_gui is None:
                    return sticker_result("failed", "window driver is not ready")
                if not sticker_gate(generation, job_id):
                    return sticker_result("cancelled", "stickers are disabled or generation expired")
                try:
                    canonical, aliases = resolve_sticker_target(db, chat_display_name, chat_username)
                    if not sticker_quarantine_allows(canonical, chat_display_name, gui_locked=True):
                        return sticker_result("failed", "an uncertain attachment draft must be cleared manually before further sends")
                    if not sticker_activity_allowed(canonical):
                        return sticker_result("failed", "target or activity gate rejected the sticker")
                    # Unlike bind_gui_window(), failure must not be silently ignored.
                    if not sticker_gate(generation, job_id) or not desktop.foreground(hwnd):
                        return sticker_result("cancelled", "send gates changed before binding")
                    if not current_gui.use_window(hwnd) or int(current_gui.main_hwnd) != hwnd:
                        return sticker_result("failed", "unable to bind the verified account window")
                    uia = getattr(current_gui, "_uia", None)
                    if uia is None:
                        return sticker_result("failed", "UIA target proof is unavailable; no OCR fallback")
                    # 目标会话没打开就自己切过去（和文字发送一样用 UIA 打开），
                    # 打开之后必须核对标题确实是目标，否则宁可不发。
                    # 搜索顺序：先显示名，再其它别名（昵称/备注/wxid）。
                    search_keys = [chat_display_name] + [a for a in aliases if a and a != chat_display_name]
                    try:
                        if not sticker_alias_match(uia.current_chat(), aliases):
                            uia.open_chat(search_keys)
                            # 切换会话有时要 1 秒左右才稳定，最多等 2 秒
                            for _ in range(8):
                                time.sleep(0.25)
                                if sticker_alias_match(uia.current_chat(), aliases):
                                    break
                    except Exception:
                        return sticker_result("failed", "exact target is not open in the pinned window")
                    if not sticker_alias_match(uia.current_chat(), aliases):
                        return sticker_result("failed", "exact target is not open in the pinned window")
                    current = sticker_config_now()
                    if current is None:
                        return sticker_result("cancelled", "stickers are disabled")
                    directory = (current.get("sticker") or {}).get("dir") or "data/stickers"
                    directory = directory if os.path.isabs(directory) else os.path.join(ROOT, directory)

                    def pinned_account_valid():
                        try:
                            compat = _compat_mod()
                            return bool(ACCOUNT.get("verified") and int(ACCOUNT.get("hwnd") or 0) == hwnd
                                        and sticker_account_evidence_allowed()
                                        and wechat_window_alive() and compat is not None
                                        and int(compat.pinned_window() or 0) == hwnd)
                        except Exception:
                            return False

                    def transaction_gate():
                        if not sticker_gate(generation, job_id):
                            return False
                        latest = sticker_config_now()
                        if latest is None:
                            return False
                        latest_dir = (latest.get("sticker") or {}).get("dir") or "data/stickers"
                        latest_dir = latest_dir if os.path.isabs(latest_dir) else os.path.join(ROOT, latest_dir)
                        wanted_hwnd = int((latest.get("wechat") or {}).get("windowHwnd") or 0)
                        return (os.path.normcase(os.path.abspath(latest_dir)) == os.path.normcase(os.path.abspath(directory))
                                and wanted_hwnd in (0, hwnd))

                    SEND_STATE["active"] = True
                    SEND_STATE["start"] = time.time()
                    try:
                        outcome = guarded_sticker_send(
                            current_gui, uia, hwnd, aliases, path, directory, db, canonical,
                            gate=transaction_gate, account_valid=pinned_account_valid,
                            activity_allowed=lambda: sticker_activity_allowed(canonical), desktop=desktop)
                        if not isinstance(outcome, dict) or outcome.get("status") not in {
                                "confirmed", "unconfirmed", "failed", "cancelled"}:
                            raise ValueError("unknown attachment result")
                    except Exception:
                        outcome = sticker_result("unconfirmed", "transport action is uncertain; a draft may remain; do not retry",
                                                 draft_may_remain=True)
                    finally:
                        SEND_STATE["active"] = False
                    if outcome.get("draft_may_remain") or outcome.get("status") == "unconfirmed":
                        sticker_draft_quarantine[canonical] = {
                            "hwnd": hwnd, "aliases": aliases,
                            "draft_observed": bool(outcome.get("draft_observed"))}
                    return outcome
                except Exception:
                    return sticker_result("failed", "sticker safety checks are unavailable")
            finally:
                if snap:
                    try:
                        restore_win_state(snap)
                    except Exception:
                        pass

    def claim_and_send_sticker(item, expected_chat="", expected_username=""):
        """Atomic claim precedes every send, including normal webhook stickers.

        Never send from an unclaimed payload, never retry a claim or attachment,
        and never interpret a truthy result dictionary as confirmed delivery.
        """
        if not isinstance(item, dict) or not sticker_gate(item.get("generation")):
            return sticker_result("cancelled", "stickers are disabled or generation expired")
        job_id = str(item.get("id") or "")
        if not job_id:
            return sticker_result("failed", "sticker job id is missing")
        try:
            response = LOCAL_HTTP.post(sticker_base + "/api/stickers/claim", json={"id": job_id},
                                       headers=sticker_headers, timeout=3)
            claimed = response.json() if response.status_code == 200 else None
            claimed = claimed.get("item") if isinstance(claimed, dict) and claimed.get("ok") is True else None
        except Exception:
            claimed = None
        if not isinstance(claimed, dict):
            return sticker_result("failed", "sticker job was not claimed; nothing was sent")
        if (claimed.get("id") != job_id or claimed.get("generation") != item.get("generation")
                or claimed.get("status") != "sending"
                or (expected_chat and not expected_username and claimed.get("chat") != expected_chat)
                or (expected_username and claimed.get("chatUsername") != expected_username)):
            outcome = sticker_result("failed", "claimed job identity did not match the request")
        else:
            outcome = send_sticker(claimed.get("path"), claimed.get("chat") or "",
                                   claimed.get("chatUsername") or "", claimed.get("generation"), job_id)
        # Off means no sticker requests/logs, including acknowledgements. The
        # server cancels/ages its claimed jobs; loss of ack NEVER causes a resend.
        if sticker_gate(item.get("generation")):
            # 结果必须写回服务端，否则控制台会一直显示「尝试发送中」。
            # 服务端是单线程 Node：正好在生成长回复时，3 秒超时会有概率失败，
            # 以前这里 except: pass 把它吞了，于是界面永远停在 sending。
            payload = {"id": job_id, "status": outcome["status"], "error": outcome["error"]}
            for attempt in range(3):
                try:
                    resp = LOCAL_HTTP.post(sticker_base + "/api/stickers/ack", json=payload,
                                           headers=sticker_headers, timeout=8)
                    if getattr(resp, "status_code", 0) in (200, 404, 409):
                        break
                except Exception as exc:
                    if attempt == 2:
                        log_throttled("sticker-ack-fail",
                                      "表情包结果没能写回服务端（不影响已经发出的消息）：" + repr(exc),
                                      ttl=300)
                time.sleep(0.4)
            if sticker_config_now() is not None:
                log("表情包结果：", outcome["status"], outcome["error"])
        return outcome

    def send_text(text, chat_display_name, chat_username="", force=False, quote_text=None):
        nonlocal gui
        if chat_username and chat_username in dead_chats:
            log("跳过已失效的会话：", chat_display_name)
            return False
        if chat_username and not group_is_alive(chat_username):
            dead_chats.add(chat_username)
            log("群里已经没有我了（被移出？），以后跳过：", chat_display_name)
            return False
        if not force and (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()):
            with pending_lock:
                pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
            log("你在游戏/全屏程序里，回复先排队，等你退出再发：", chat_display_name)
            return True
        # 账号闸：认不出「哪个窗口是小号」就不发（放在排队判断之后，免得游戏里直接丢消息）
        if not account_send_allowed("发送"):
            return False
        # 微信在托盘里时主窗是隐藏的，UIA 没有可操作窗口：后台/前台都发不出去，
        # 与其强拉前台挡视野 60 秒，不如明确报一句，让主人把窗口恢复到任务栏。
        try:
            import win32gui
            _wx = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
            if _wx and not win32gui.IsWindowVisible(_wx):
                log("微信在托盘（主窗隐藏），UIA 发不出去：请把微信设成「最小化到任务栏」或打开窗口")
                return False
        except Exception:
            pass
        log("文件发送[1/7] 开始：%s → %s" % (os.path.basename(path), chat_display_name))
        with send_lock:
            if not sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            if not force and (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()):
                with pending_lock:
                    pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
                log("游戏/全屏中，先排队：", chat_display_name)
                return True
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            # 多账号：GUI 的坐标/OCR 目标也要对齐到钉住的账号窗口
            bind_gui_window(gui)
            # ⓪ 引用回复（引用对方那条消息）——比普通发送慢，失败自动回退
            if quote_text and QUOTE_REPLY:
                try:
                    if with_window_on_top(lambda: gui.quote_msg(text, who=chat_display_name, target_text=quote_text, verify=False)):
                        log("引用回复成功 →", chat_display_name)
                        return True
                except Exception as e:
                    log("引用回复失败，回退普通发送：", repr(e))
            # ① 首选 UIA：稳定、快，不依赖 OCR 找发送按钮
            t_start = time.time()
            uia_available = False
            try:
                uia_available = gui._get_uia() is not None
            except Exception:
                uia_available = False
            for attempt in (1, 2):
                t_att = time.time()
                try:
                    if with_window_on_top(lambda: uia_send(text, chat_display_name, chat_username)):
                        fail_streak.pop(chat_username, None)
                        log("发送成功（%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                        return True
                    log("UIA 发送未成功（第 %d 次，%.1fs），准备重试" % (attempt, time.time() - t_att))
                except Exception as e:
                    log("UIA 发送异常（第 %d 次，%.1fs）：%r" % (attempt, time.time() - t_att, e))
                time.sleep(0.5)
            if uia_available:
                # UIA 报告可用却没发出去：多半是 gate byte 被归零（引擎假死）。
                # 强制重激活一次再试，别让用户只能重启桥接。
                if recover_uia("发送失败"):
                    try:
                        if with_window_on_top(lambda: uia_send(text, chat_display_name, chat_username)):
                            fail_streak.pop(chat_username, None)
                            log("重新激活 UIA 后发送成功（%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                            return True
                    except Exception as e:            # noqa: BLE001
                        log("重新激活后仍失败：", repr(e))
                log("UIA 发不出去，跳过 OCR 兜底：", chat_display_name)
            else:
                log("UIA 不可用，走 OCR 兜底")
            # ①.5 键盘兜底：完全不碰 accessibility（Ctrl+F 搜索会话 → 粘贴 → 回车），
            #      并用数据库回读确认。OCR 这条路会卡在截屏，所以先试它。
            if KEYBOARD_FALLBACK:
                if keyboard_send(text, chat_display_name, chat_username):
                    fail_streak.pop(chat_username, None)
                    log("发送成功（键盘通道，%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                    return True
            # ② 兜底：仅当 UIA 不可用时才走 OCR。
            #    注意：OCR 这条路在这台机器上会卡死在 PIL.ImageGrab.grab 截屏里
            #    （data/bridge-hang.log 有栈），以前直接拖到 40 秒看门狗把整个桥接
            #    os.exit 重启；这里给它 25 秒，超时就放弃这一条。
            if not uia_available:
                try:
                    with gui_lock:
                        try:
                            gui = WeChatGUI()
                        except Exception as e:
                            log("重建窗口驱动失败：", repr(e))
                    bind_gui_window(gui)
                    _box = {}

                    def _ocr_send():
                        try:
                            _box["r"] = with_window_on_top(
                                lambda: gui.send_msg(text, chat_display_name, True))
                        except Exception as _e:      # noqa: BLE001
                            _box["e"] = _e

                    _th = threading.Thread(target=_ocr_send, daemon=True)
                    _th.start()
                    _th.join(25)
                    if _th.is_alive():
                        log("OCR 兜底 25 秒没返回（卡在截屏），放弃这条，等下次消息")
                        resp = False
                    else:
                        if "e" in _box:
                            raise _box["e"]
                        resp = _box.get("r")
                    if bool(resp):
                        fail_streak.pop(chat_username, None)
                        return True
                    log("兜底发送失败：%s" % resp)
                except Exception as e:
                    log("兜底发送异常：%r" % e)
            if chat_username:
                # 微信窗口在托盘/最小化导致发不出去：不是会话失效，别标死
                try:
                    import win32gui
                    _wx2 = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
                    _hidden2 = bool(_wx2) and not win32gui.IsWindowVisible(_wx2)
                    _iconic2 = bool(_wx2) and win32gui.IsIconic(_wx2)
                except Exception:
                    _hidden2 = _iconic2 = False
                if _hidden2 or _iconic2:
                    log("窗口不在桌面（托盘/最小化），这条不标记会话失效：", chat_display_name)
                    return False
                # 账号窗口认不出来导致的失败，不算「这个会话失效」——
                # 否则双开时认不出号会把这个群/好友永久标死，之后就再也不回了。
                if (time.time() - float(ACCOUNT.get("blockedAt") or 0)) < 30:
                    log("账号窗口没确认，这条不算会话失效，先不发：", chat_display_name)
                    return False
                fail_streak[chat_username] = fail_streak.get(chat_username, 0) + 1
                if fail_streak[chat_username] >= 2:
                    dead_chats.add(chat_username)
                    log("连续发送失败，先停掉这个会话：", chat_display_name)
            log("发送最终失败，请把微信窗口保持在桌面、别最小化；内容：", text[:30])
            return False

    def dsh_progress_line(event, title="", size_mb=0.0, waited_sec=0.0, kind="file",
                         chat_user="", chat_type="private"):
        """向 DSH 插件取一句进度话术（由 DSH 现场生成）；可复用该聊天的正式会话。"""
        try:
            _port = int(os.environ.get("WHALE_BRIDGE_PORT") or 8789)
            _r = LOCAL_HTTP.post(
                "http://127.0.0.1:%d/api/wechat/progress-line" % _port,
                json={"event": event, "kind": kind, "title": title or "",
                      "sizeMB": float(size_mb or 0), "waitedSec": float(waited_sec or 0),
                      "chatUser": chat_user or "", "chatType": chat_type or "private"},
                # DSH 现场生成一句要几秒，给足时间；失败返回空串，桥接就不发
                timeout=35,
            )
            if _r.status_code == 200:
                _t = (_r.json() or {}).get("text") or ""
                return str(_t).strip()[:160]
        except Exception:
            pass
        return ""

    def send_at(member, text, chat_display_name, chat_username=""):
        """在群里真 @ 某个成员（UI 选人），失败返回 False 让调用方退回普通发送。"""
        nonlocal gui
        if not member or not text:
            return False
        if chat_username and (chat_username in dead_chats or not group_is_alive(chat_username)):
            return False
        if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
            with pending_lock:
                pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
            log("你在游戏/全屏程序里，@ 回复先排队：", chat_display_name)
            return True
        # 账号闸：@ 人要点开成员列表，窗口不对就会在别的号里 @ 别人
        if not account_send_allowed("@ 成员"):
            return False
        with send_lock:
            if not sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            bind_gui_window(gui)
            try:
                ok = bool(with_window_on_top(lambda: gui.at_member(member, text, who=chat_display_name, verify=False)))
                if ok:
                    log("已 @ %s → %s" % (member, chat_display_name))
                    return True
                log("@ 成员失败（%s），改用普通发送" % member)
            except Exception as e:
                log("@ 成员异常：", repr(e))
        return False

    # ------------------------------------------------------------------
    # 文件通道：出站（DSH 产物 → 微信「文件消息」）
    # 文字回复照旧发；回复里出现桥接的 /files/<token>/... 下载链接时，
    # 先把文件取到本地，再把文件作为微信文件消息发出去（失败则保留下载链接文字）。
    # ------------------------------------------------------------------
    wechat_file_outbox = os.path.join(ROOT, "data", "wechat-outbox")
    def _cleanup_wechat_file_outbox(max_age_sec=None):
        if max_age_sec is None:
            max_age_sec = MEDIA_KEEP_DAYS * 86400
        try:
            os.makedirs(wechat_file_outbox, exist_ok=True)
            now = time.time()
            for root_dir, dirs, files in os.walk(wechat_file_outbox, topdown=False):
                for name in files:
                    p = os.path.join(root_dir, name)
                    try:
                        if now - os.path.getmtime(p) > max_age_sec:
                            os.remove(p)
                    except Exception:
                        pass
                for name in dirs:
                    p = os.path.join(root_dir, name)
                    try:
                        if not os.listdir(p):
                            os.rmdir(p)
                    except Exception:
                        pass
        except Exception:
            pass

    def _cleanup_wechat_files_dir(max_age_sec=None):
        """清理 data/wechat-files 里桥接自己复制的入站文件（默认跟随 mediaKeepDays）。"""
        try:
            if max_age_sec is None:
                max_age_sec = MEDIA_KEEP_DAYS * 86400
            base = os.path.join(ROOT, "data", "wechat-files")
            if not os.path.isdir(base):
                return
            now = time.time()
            removed = 0
            for root_dir, dirs, files in os.walk(base, topdown=False):
                for name in files:
                    p = os.path.join(root_dir, name)
                    try:
                        if now - os.path.getmtime(p) > max_age_sec:
                            os.remove(p)
                            removed += 1
                    except Exception:
                        pass
                for name in dirs:
                    p = os.path.join(root_dir, name)
                    try:
                        if not os.listdir(p):
                            os.rmdir(p)
                    except Exception:
                        pass
            if removed:
                log("文件缓存清理：删了 %d 个超过 %g 天的入站文件副本" % (removed, MEDIA_KEEP_DAYS))
        except Exception:
            pass

    def _raw_message_content(username, local_id):
        """从数据库按 local_id 回查原始 content（监听路径偶尔会把文件 XML 弄丢）。"""
        if local_id is None:
            return ""
        try:
            for row in (db.get_messages(username, limit=200) or []):
                try:
                    if int(row.get("local_id") or -1) != int(local_id):
                        continue
                except Exception:
                    continue
                return str(row.get("content") or "")
        except Exception:
            pass
        return ""

    def copy_cached_wechat_file(title, totallen=0, ext=""):
        """兜底：微信收到的文件一般就在 <账号目录>\\msg\\file\\YYYY-MM\\<原名>。

        库里的行取不到 server_id 时 MediaDownloader.download_file 会失败，这里直接
        去缓存目录找。匹配优先级：
          0) 文件名完全一致；
          1) 去掉微信重名后缀后一致（名字(1).flac / 名字(1)(2).flac 都能对上）；
          2) 名字对不上时按 <totallen> 大小 + <fileext> + 最近 3 分钟兜底；
        有 totallen 时一律要求实际大小完全相等，避免读到半截/旧文件。
        """
        want = str(title or "").strip()
        ext_clean = str(ext or "").strip().lower().lstrip(".")
        if not re.fullmatch(r"[a-z0-9]{1,12}", ext_clean or ""):
            ext_clean = ""

        base = os.path.join(getattr(db, "account_dir", "") or "", "msg", "file")
        if not os.path.isdir(base):
            return None
        candidates = []          # (rank, -mtime, src, fn)
        now = time.time()
        try:
            all_files = glob.glob(os.path.join(base, "**", "*"), recursive=True)
        except Exception:
            all_files = []
        want_norm = _norm_name(want) if want else ""
        for src in all_files:
            try:
                if not os.path.isfile(src):
                    continue
                fn = os.path.basename(src)
                st = os.stat(src)
                rank = None
                if want:
                    if fn == want:
                        rank = 0
                    elif want_norm and _norm_name(fn) == want_norm:
                        rank = 1
                if rank is None:
                    continue
                if totallen and st.st_size != int(totallen):
                    continue
                if not totallen and (now - st.st_mtime) > 600:
                    continue
                if ext_clean and os.path.splitext(fn)[1].lower().lstrip(".") != ext_clean:
                    continue
                candidates.append((rank, -st.st_mtime, src, fn))
            except Exception:
                continue
        # 名字对不上/没标题：按大小+后缀+最近 3 分钟兜底（用于微信改名的极端情况）
        if not candidates and (totallen or ext_clean):
            for src in all_files:
                try:
                    if not os.path.isfile(src):
                        continue
                    fn = os.path.basename(src)
                    st = os.stat(src)
                    if totallen and st.st_size != int(totallen):
                        continue
                    if not totallen and (now - st.st_mtime) > 300:
                        continue
                    if ext_clean and os.path.splitext(fn)[1].lower().lstrip(".") != ext_clean:
                        continue
                    candidates.append((2, -st.st_mtime, src, fn))
                except Exception:
                    continue
        if not candidates:
            return None
        # rank 小优先；同 rank 里 mtime 新优先（刚收到的文件）
        candidates.sort(key=lambda x: (x[0], x[1]))
        _rank, _neg_mtime, src, fn = candidates[0]
        try:
            log("缓存兜底选中（rank=%d mtime=%s）：%s" % (
                _rank, time.strftime("%H:%M:%S", time.localtime(-_neg_mtime)), fn))
        except Exception:
            pass
        try:
            dst_dir = os.path.join(ROOT, "data", "wechat-files")
            os.makedirs(dst_dir, exist_ok=True)
            dst = os.path.join(dst_dir, "%s-%s" % (
                int(time.time() * 1000), _safe_wechat_file_name(fn)))
            import shutil as _shutil
            _shutil.copy2(src, dst)
            return dst
        except Exception:
            return None

    # ---- 出站兜底：直接扫 DSH 工作区 outbox（鲸鱼娘会截断/切分长回复，URL 可能丢） ----
    _dsh_ws_cache = {"path": "", "at": 0.0}
    _sent_media = {
        "loaded": False,
        "keys": set(),
        "path": os.path.join(ROOT, "data", "wechat-sent-files.json"),
    }

    def dsh_bridge_workspace():
        now = time.time()
        if _dsh_ws_cache["path"] and now - _dsh_ws_cache["at"] < 30:
            return _dsh_ws_cache["path"]
        ws = ""
        try:
            home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
            with open(os.path.join(home, ".dsh", "whale-bridge", "settings.json"),
                      "r", encoding="utf-8") as f:
                ws = str((json.load(f) or {}).get("workspace") or "").strip()
        except Exception:
            ws = ""
        if not ws:
            ws = r"C:\Dev_dsh"
        _dsh_ws_cache["path"] = ws
        _dsh_ws_cache["at"] = now
        return ws

    def _load_sent_media():
        if _sent_media["loaded"]:
            return
        _sent_media["loaded"] = True
        try:
            with open(_sent_media["path"], "r", encoding="utf-8") as f:
                data = json.load(f) or {}
            _sent_media["keys"] = set(str(x) for x in (data.get("sent") or []))
        except Exception:
            _sent_media["keys"] = set()

    def _save_sent_media():
        try:
            os.makedirs(os.path.dirname(_sent_media["path"]), exist_ok=True)
            with open(_sent_media["path"], "w", encoding="utf-8") as f:
                json.dump({"sent": sorted(_sent_media["keys"])[-500:]}, f, ensure_ascii=False)
        except Exception:
            pass

    def scan_dsh_outbox(since_ts):
        """扫 DSH 工作区 outbox 里「since_ts 之后新出现/修改」的文件，返回待发送列表。"""
        _load_sent_media()
        base = os.path.join(dsh_bridge_workspace(), ".whale-bridge", "outbox")
        out = []
        if not os.path.isdir(base):
            return out
        limit = max(1.0, float(WECHAT_FILE_MAX_MB)) * 1024 * 1024
        for root_dir, _dirs, files in os.walk(base):
            for fn in files:
                p = os.path.join(root_dir, fn)
                try:
                    st = os.stat(p)
                except Exception:
                    continue
                if st.st_mtime < since_ts or st.st_size <= 0 or st.st_size > limit:
                    continue
                key = "%s|%d|%d" % (os.path.abspath(p).lower(), st.st_size, int(st.st_mtime))
                if key in _sent_media["keys"]:
                    continue
                out.append({"path": os.path.abspath(p), "name": fn,
                            "size": st.st_size, "_key": key, "url": ""})
        out.sort(key=lambda x: x["path"])
        return out[:10]

    def mark_media_sent(item):
        try:
            key = str(item.get("_key") or "")
            if key:
                _sent_media["keys"].add(key)
                _save_sent_media()
        except Exception:
            pass

    def fetch_media_url(url):
        """把桥接的下载链接取到本地 data/wechat-outbox，返回 (path, filename) 或 (None, 原因)。"""
        try:
            with LOCAL_HTTP.get(url, timeout=60, stream=True) as resp:
                if resp.status_code != 200:
                    return None, "HTTP %s" % resp.status_code
                cd = resp.headers.get("Content-Disposition") or ""
                fname = ""
                m = re.search(r"filename\*=UTF-8''([^;]+)", cd)
                if m:
                    fname = urllib.parse.unquote(m.group(1)).strip()
                if not fname:
                    m = re.search(r'filename="([^"]+)"', cd)
                    if m:
                        fname = m.group(1).strip()
                if not fname:
                    fname = os.path.basename(urllib.parse.unquote(url.split("?", 1)[0]))
                fname = _safe_wechat_file_name(fname)
                limit = max(1.0, float(WECHAT_FILE_MAX_MB)) * 1024 * 1024
                os.makedirs(wechat_file_outbox, exist_ok=True)
                # 放独立子目录里保留原名：微信文件消息标题/文件名才好看（以前带时间戳前缀）
                out_dir = os.path.join(wechat_file_outbox, "%d" % int(time.time() * 1000))
                os.makedirs(out_dir, exist_ok=True)
                out = os.path.join(out_dir, fname)
                got = 0
                with open(out, "wb") as f:
                    for chunk in resp.iter_content(chunk_size=256 * 1024):
                        if not chunk:
                            continue
                        got += len(chunk)
                        if got > limit:
                            try:
                                f.close()
                                os.remove(out)
                            except Exception:
                                pass
                            return None, "文件超过上限（%.0f MB）" % WECHAT_FILE_MAX_MB
                        f.write(chunk)
                if got <= 0:
                    try:
                        os.remove(out)
                    except Exception:
                        pass
                    return None, "空文件"
                return out, fname
        except Exception as e:                       # noqa: BLE001
            return None, repr(e)

    # ---------------- 文件通道：出站（UIA SendKeys 版，实测可用） ----------------
    # 关键：这台微信 4.x 上 gui._input.key()（SendInput）粘贴/回车无效，但
    # uiautomation.SendKeys 可以（Ctrl+V 后输入框出现 U+FFFC 附件占位符，Enter 即发送）。
    def _wechat_aliases_for(chat_display_name, chat_username):
        try:
            _c, _a = resolve_sticker_target(db, chat_display_name, chat_username)
            return _a or [chat_display_name]
        except Exception:
            return [chat_display_name]

    def _wechat_input_control(u):
        try:
            return u._chat_input()
        except Exception:
            return None

    def _wechat_input_text(u):
        try:
            ctrl = _wechat_input_control(u)
            vp = ctrl.GetValuePattern() if ctrl else None
            return vp.Value if vp else None
        except Exception:
            return None

    def _wechat_clear_input(u):
        try:
            ctrl = _wechat_input_control(u)
            if ctrl:
                ctrl.SetFocus()
            _uiautomation.SendKeys('{Ctrl}a')
            _uiautomation.SendKeys('{Delete}')
            return True
        except Exception:
            return False

    def _wechat_open_target(u, chat_display_name, chat_username):
        aliases = _wechat_aliases_for(chat_display_name, chat_username)
        try:
            cur = u.current_chat() or ""
        except Exception:
            cur = ""
        if not _sticker_transport_module.alias_match(cur, aliases):
            try:
                u.open_chat(aliases)
            except Exception as _e:                  # noqa: BLE001
                log("文件发送：打开会话异常：", repr(_e))
                return None
            time.sleep(1.0)
            try:
                cur = u.current_chat() or ""
            except Exception:
                cur = ""
            if not _sticker_transport_module.alias_match(cur, aliases):
                log("文件发送：目标会话没打开（当前 %r）" % cur)
                return None
        return aliases

    def send_file_wechat(path, chat_display_name, chat_username=""):
        """把本地文件作为微信「文件消息」发出去（UIA SendKeys 路线，实测可用）。

        流程：打开目标会话 → 输入框聚焦 → 剪贴板 CF_HDROP → Ctrl+V → 校验输入框出现
        附件占位符 U+FFFC → Enter → 回读微信数据库确认新「文件/链接/卡片」消息。
        粘贴/发送失败会清理草稿，绝不重复发送；确认不了由调用方回退发下载链接。
        """
        nonlocal gui
        if not WECHAT_FILE_OUT:
            return {"ok": False, "message": "文件出站已关闭"}
        if chat_username and (chat_username in dead_chats or not group_is_alive(chat_username)):
            log("跳过已失效的会话（文件）：", chat_display_name)
            return {"ok": False, "message": "会话已失效"}
        if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
            log("游戏/全屏中，文件先不发：", chat_display_name)
            return {"ok": False, "message": "游戏/全屏中"}
        if not account_send_allowed("发送文件"):
            return {"ok": False, "message": "账号窗口未确认"}
        fsize = 0
        try:
            fsize = os.path.getsize(path)
        except Exception:
            return {"ok": False, "message": "文件不存在"}
        if fsize > max(1.0, float(WECHAT_FILE_MAX_MB)) * 1024 * 1024:
            return {"ok": False, "message": "文件超过 %.0f MB" % WECHAT_FILE_MAX_MB}
        with send_lock:
            if not sticker_quarantine_allows(chat_username, chat_display_name):
                return {"ok": False, "message": "上次附件操作可能留有草稿"}
            hwnd = int(ACCOUNT.get("hwnd") or 0)
            if not hwnd or not wechat_window_alive():
                return {"ok": False, "message": "微信窗口不可用"}
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            bind_gui_window(gui)
            log("文件发送[2/7] 置前微信")
            if not force_foreground(hwnd):
                return {"ok": False, "message": "微信窗口无法置前"}
            log("文件发送[2/7] 置前完成")
            log("文件发送[3/7] 取 UIA")
            try:
                with gui_lock:
                    u = gui._get_uia()
            except Exception:
                u = None
            log("文件发送[3/7] UIA=%r" % (u is not None,))
            if u is None:
                return {"ok": False, "message": "UIA 不可用"}
            t0 = time.time()
            try:
                log("文件发送[4/7] 打开会话")
                aliases = _wechat_open_target(u, chat_display_name, chat_username)
                if not aliases:
                    return {"ok": False, "message": "目标会话没打开"}
                log("文件发送[4/7] 会话已打开")
                # 等输入框自然清空（刚发完文字时偶尔有残留），不替用户按删除
                blank_ok = False
                for _ in range(20):
                    val = _wechat_input_text(u)
                    if val is None:
                        break
                    if str(val).strip() == "":
                        blank_ok = True
                        break
                    time.sleep(0.2)
                if not blank_ok:
                    return {"ok": False, "message": "输入框有草稿，先手动清空"}
                try:
                    before = int(gui._target_seq(chat_display_name) or 0)
                except Exception:
                    before = 0
                log("文件发送[5/7] 找输入框/设置焦点")
                ctrl = _wechat_input_control(u)
                if not ctrl:
                    return {"ok": False, "message": "找不到输入框"}
                ctrl.SetFocus()
                log("文件发送[5/7] 焦点完成")
                time.sleep(0.2)
                if not gui.copy_files_to_clipboard([os.path.abspath(path)]):
                    return {"ok": False, "message": "剪贴板设置失败"}
                time.sleep(0.2)
                log("文件发送[6/7] 剪贴板粘贴")
                _uiautomation.SendKeys('{Ctrl}v')
                time.sleep(1.2)
                val = _wechat_input_text(u)
                draft = val if isinstance(val, str) else None
                if not (draft is not None and draft.strip() == '\ufffc'):
                    log("文件粘贴未生效（输入框=%r），清理草稿" % (draft,))
                    _wechat_clear_input(u)
                    return {"ok": False, "message": "文件粘贴未生效"}
                log("文件发送[7/7] 发送 Enter")
                _uiautomation.SendKeys('{Enter}')
                confirmed = False
                deadline = time.time() + 20.0
                while time.time() < deadline:
                    try:
                        msgs = db.get_new_messages(chat_username, since_seq=before, limit=30) if chat_username else []
                    except Exception:
                        msgs = []
                    for m in msgs:
                        if int(m.get("sort_seq") or 0) <= before:
                            continue
                        if (m.get("type") or "") not in ("文件/链接/卡片", "文件"):
                            continue
                        c = m.get("content") or ""
                        if os.path.basename(path) in c or "<fileext>" in c:
                            confirmed = True
                            break
                    if confirmed:
                        break
                    time.sleep(0.4)
                log("文件发送[确认] 产物已提交，等待数据库确认 %.0fs" % (time.time() - t0,))
                if confirmed:
                    log("文件已发送（confirmed %.1fs）→ %s：%s（%s）" % (
                        time.time() - t0, chat_display_name, os.path.basename(path), _fmt_kb(fsize)))
                    return {"ok": True, "message": "confirmed"}
                # 未确认：清掉可能残留的附件草稿，避免下一次文字把附件一起带出去
                _wechat_clear_input(u)
                log("文件发送未确认（已清理草稿，不重试）→ %s" % chat_display_name)
                return {"ok": False, "uncertain": True, "message": "未确认"}
            except Exception as e:                     # noqa: BLE001
                log("文件发送异常 → %s：%r" % (chat_display_name, e))
                try:
                    _wechat_clear_input(u)
                except Exception:
                    pass
                return {"ok": False, "message": repr(e)}

    def prepare_reply_files(reply_text, bubbles, target, username):
        """出站第一段：把回复里的下载链接取成本地文件（先不发）。

        返回 (cleaned_reply, cleaned_bubbles, pending, failed)：
        - pending: [{"url","path","name"}]，文字发送后再发成微信文件；
        - failed: [(url, 原因)]，取不到的文件把链接文字保留在回复里兜底。
        """
        text = reply_text or ""
        urls = collect_file_urls(text, bubbles)
        if not urls:
            return reply_text, list(bubbles or []), [], []
        _cleanup_wechat_file_outbox()
        pending, failed = [], []
        for url in urls:
            path, name_or_err = fetch_media_url(url)
            if path:
                pending.append({"url": url, "path": path, "name": name_or_err})
            else:
                failed.append((url, name_or_err))
                log("取文件失败（保留下载链接）：", url, "→", name_or_err)
        drop = {item["url"] for item in pending}
        cleaned_bubbles = [strip_file_links(line, drop) for line in (bubbles or [])]
        return strip_file_links(text, drop), cleaned_bubbles, pending, failed

    def _save_sticker_image(content, tag="sticker"):
        """把表情包图片落盘：PNG/JPEG 原样保存（不二次压缩），GIF/WebP 取首帧存 PNG。"""
        try:
            from PIL import Image
            import io as _io
            img = Image.open(_io.BytesIO(content))
            fmt = (img.format or "").upper()
            dst_dir = os.path.join(ROOT, "data", "media-cache")
            os.makedirs(dst_dir, exist_ok=True)
            base = "%s-%d" % (tag, int(time.time() * 1000))
            if fmt == "PNG":
                dst = os.path.join(dst_dir, base + ".png")
                with open(dst, "wb") as f:
                    f.write(content)
                return dst
            if fmt in ("JPEG", "JPG"):
                dst = os.path.join(dst_dir, base + ".jpg")
                with open(dst, "wb") as f:
                    f.write(content)
                return dst
            try:
                img.seek(0)
            except Exception:
                pass
            buf = _io.BytesIO()
            img.convert("RGBA").save(buf, format="PNG")
            dst = os.path.join(dst_dir, base + ".png")
            with open(dst, "wb") as f:
                f.write(buf.getvalue())
            return dst
        except Exception as _e:
            log("表情包图片保存失败：", repr(_e))
            return ""

    def sticker_cdn_path(msg):
        """表情包本地缓存是微信私有加密格式；从消息 XML 的 CDN URL 取原图/缩略图。"""
        try:
            raw = str(msg.get("content") or "")
            if "<emoji" not in raw:
                return ""
            attrs = dict(re.findall(r'(\w+)\s*=\s*"([^"]*)"', raw))
            md5 = str(attrs.get("md5") or "")[:8]
            for name in ("cdnurl", "thumburl", "encrypturl"):
                url = html.unescape(str(attrs.get(name) or "")).strip()
                if not url.startswith("http"):
                    continue
                for attempt in (1, 2):
                    try:
                        r = LOCAL_HTTP.get(url, timeout=25, headers={"User-Agent": "Mozilla/5.0"})
                    except Exception as _e:
                        log("表情包 CDN 下载失败（%s 第%d次）：%r" % (name, attempt, _e))
                        continue
                    if r.status_code != 200 or not r.content:
                        log("表情包 CDN 状态异常（%s 第%d次）：HTTP %s len=%s" % (
                            name, attempt, r.status_code, len(r.content or b"")))
                        continue
                    dst = _save_sticker_image(r.content, tag="sticker-%s-%s" % (md5 or "x", name))
                    if dst:
                        msg["_bridge_image_path"] = dst
                        log("表情包从 CDN 取到（%s，原格式保留）：%s" % (name, dst))
                        return dst
                    log("表情包 CDN 内容不是可识别图片（%s 第%d次，magic=%r）" % (
                        name, attempt, r.content[:8]))
                    break
        except Exception as _e:
            log_throttled("sticker-cdn-exc:" + type(_e).__name__, "表情包 CDN 处理失败：", repr(_e))
        return ""

    def appmsg_sticker_path(content):
        """有的表情包被微信报成 appmsg type=8（文件/链接/卡片），真身在 <emojiinfo> 里；
        解码后能拿到 CDN URL，直接取 GIF/PNG 并转 JPEG 首帧给 DSH。"""
        try:
            import base64 as _b64
            raw = str(content or "")
            m = re.search(r"<emojiinfo>(.*?)</emojiinfo>", raw, re.S)
            if not m:
                return ""
            b64 = re.sub(r"\s+", "", html.unescape(m.group(1)))
            data = _b64.b64decode(b64, validate=False)
            text = data.decode("utf-8", "replace")
            urls = re.findall(r"https?://[^\s\"'<>]+", text)
            for url in urls:
                try:
                    r = LOCAL_HTTP.get(url, timeout=25, headers={"User-Agent": "Mozilla/5.0"})
                except Exception:
                    continue
                if r.status_code != 200 or not r.content:
                    continue
                dst = _save_sticker_image(r.content, tag="sticker-appmsg")
                if dst:
                    log("表情包(appmsg)从 CDN 取到（原格式保留）：", dst)
                    return dst
        except Exception as _e:
            log_throttled("appmsg-sticker-exc:" + type(_e).__name__, "appmsg 表情包处理失败：", repr(_e))
        return ""

    def convert_wxgf_to_jpg(raw):
        """用随包 ffmpeg 把 wxgf/HEVC 中图转成高质量 JPEG；失败返回空 bytes。"""
        td = None
        try:
            import subprocess as _sp
            import tempfile as _tf
            exe = os.path.join(ROOT, "runtime", "ffmpeg", "bin", "ffmpeg.exe")
            if not os.path.exists(exe):
                exe = "ffmpeg"
            start = raw.find(b"\x00\x00\x00\x01")
            if start < 0:
                return b""
            hevc = raw[start:]
            td = _tf.mkdtemp(prefix="dsh-wxgf-")
            src = os.path.join(td, "in.hevc")
            dst = os.path.join(td, "out.jpg")
            with open(src, "wb") as f:
                f.write(hevc)
            r = _sp.run(
                [exe, "-y", "-v", "error", "-i", src, "-frames:v", "1", "-q:v", "2", dst],
                capture_output=True, timeout=60,
            )
            if r.returncode == 0 and os.path.exists(dst):
                with open(dst, "rb") as f:
                    data = f.read()
                if data[:3] == b"\xff\xd8\xff":
                    return data
        except Exception as _e:
            log("wxgf 转码失败：", repr(_e))
        finally:
            if td:
                try:
                    import shutil as _sh
                    _sh.rmtree(td, ignore_errors=True)
                except Exception:
                    pass
        return b""

    def prepare_image_path(msg):
        """把微信图片下载成 DSH 能 read_image 的本地文件（wxgf 转 jpg）；失败返回空串。"""
        try:
            user = msg.get("username") or ""
            lid = msg.get("local_id")
            shard = msg.get("shard")
            if not user or lid is None:
                return ""
            # 表情包（本地是私有加密格式）：优先走消息里的 CDN 原图/缩略图
            if "<emoji" in str(msg.get("content") or "") or str(msg.get("type") or "") in ("表情", "动画表情"):
                _cdn_path = sticker_cdn_path(msg)
                if _cdn_path:
                    return _cdn_path
            # 1) 先快速拿本机最高档（不碰微信界面）；JPEG/PNG 且够大就直接用
            _fast = None
            try:
                _fast = _get_media().download_image(user, int(lid), tier="full", shard=shard)
            except Exception as _fe:
                _fast = None
                log("图片快速档失败：", repr(_fe))
            if _fast and os.path.exists(_fast):
                try:
                    _fsz = os.path.getsize(_fast)
                except Exception:
                    _fsz = 0
                _fext = os.path.splitext(_fast)[1].lower()
                if _fext in (".png", ".jpg", ".jpeg") and _fsz >= 150 * 1024:
                    try:
                        msg["_bridge_image_path"] = _fast
                    except Exception:
                        pass
                    log("图片用本机高清档：%s（%d KB）" % (_fast, _fsz // 1024))
                    return _fast
            # 2) 本机档位不够清晰：只有本机已经缓存了原图 _h.dat 才去要原图（零界面操作）；
            #    没有缓存时不去点微信界面（那条路可能卡很久，拖死整条消息处理）
            _has_original = False
            try:
                _st = _get_media().image_status(user, int(lid), verify=False, shard=shard)
                _has_original = bool(_st.get("available"))
            except Exception as _se:
                log("查原图状态失败（按无原图处理）：", repr(_se))
                _has_original = False
            _orig = ""
            if _has_original:
                try:
                    _orig = _get_media().download_image_original(user, int(lid), timeout=5.0)
                except Exception as _oe:
                    _orig = ""
                    log("取本机原图失败（改走本机档位）：", repr(_oe))
            if _orig and os.path.exists(_orig):
                try:
                    _osz = os.path.getsize(_orig)
                except Exception:
                    _osz = 0
                if _osz >= 50 * 1024:
                    try:
                        msg["_bridge_image_path"] = _orig
                    except Exception:
                        pass
                    log("图片用原图：%s（%d KB）" % (_orig, _osz // 1024))
                    return _orig
            # 3) 原图取不到：重试 full 档一会（中图常晚 1-2 秒落盘），再退 best
            path = _fast if (_fast and os.path.exists(_fast)) else None
            _full_deadline = time.time() + 15.0
            while not path and time.time() < _full_deadline:
                try:
                    _p = _get_media().download_image(user, int(lid), tier="full", shard=shard)
                except Exception:
                    _p = None
                if _p and os.path.exists(_p):
                    try:
                        _psz = os.path.getsize(_p)
                    except Exception:
                        _psz = 0
                    if _psz >= 20 * 1024:
                        path = _p
                        log("图片档位：full → %d KB" % (_psz // 1024))
                        break
                time.sleep(0.8)
            if not path:
                for _tier in ("full", "best"):
                    try:
                        path = _get_media().download_image(user, int(lid), tier=_tier, shard=shard)
                    except Exception as _e:
                        log("图片下载失败（tier=%s）：%r" % (_tier, _e))
                        path = None
                    if path:
                        log("图片档位：%s → %d KB" % (_tier, os.path.getsize(path) // 1024))
                        break
            if not path:
                log("图片取不到本地文件")
                return ""
            try:
                msg["_bridge_image_path"] = path
            except Exception:
                pass
            with open(path, "rb") as f:
                raw = f.read()
            if len(raw) > 8 * 1024 * 1024:
                log("图片太大，跳过")
                return ""
            if raw[:4] == b"wxgf":
                conv = convert_wxgf_to_jpg(raw)
                if not conv:
                    try:
                        conv = _get_media()._wxgf_to_jpg(raw)
                    except Exception as _e:
                        conv = None
                        log("wxgf 转码异常：", repr(_e))
                if not conv:
                    log("这张图是 wxgf/HEVC，本机 ffmpeg 没能转出来，跳过")
                    return ""
                try:
                    _conv_path = os.path.join(
                        os.path.dirname(path),
                        "vision-%s-%s.jpg" % (
                            int(time.time() * 1000),
                            re.sub(r"[^0-9A-Za-z_.-]", "_", os.path.basename(path)),
                        ),
                    )
                    with open(_conv_path, "wb") as _cf:
                        _cf.write(conv)
                    msg["_bridge_image_path"] = _conv_path
                    return _conv_path
                except Exception:
                    return ""
            # 动图（GIF/WebP，常见于表情包）：转成 JPEG 首帧，DSH read_image 更稳
            _ext = os.path.splitext(path)[1].lower()
            if _ext in (".gif", ".webp") or raw[:3] == b"GIF":
                try:
                    from PIL import Image
                    import io as _io
                    _img = Image.open(_io.BytesIO(raw))
                    try:
                        _img.seek(0)
                    except Exception:
                        pass
                    _rgb = _img.convert("RGB")
                    _buf = _io.BytesIO()
                    _rgb.save(_buf, format="JPEG", quality=88)
                    _conv = os.path.join(
                        os.path.dirname(path),
                        "sticker-%s.jpg" % int(time.time() * 1000),
                    )
                    with open(_conv, "wb") as _cf:
                        _cf.write(_buf.getvalue())
                    msg["_bridge_image_path"] = _conv
                    return _conv
                except Exception as _e2:
                    log("表情包转 JPEG 失败（用原图）：", repr(_e2))
            return path
        except Exception as _e:
            log_throttled("img-prep-exc:" + type(_e).__name__, "图片准备失败：", repr(_e))
            return ""

    def describe_image(msg):
        try:
            import base64
            user = msg.get("username") or ""
            lid = msg.get("local_id")
            shard = msg.get("shard")
            if not user or lid is None:
                return ""
            # 先用完整图（原图 > 压缩版），别拿缩略图去识别；两档都没有才退回 best
            path = None
            for _tier in ("full", "best"):
                try:
                    path = _get_media().download_image(user, int(lid), tier=_tier, shard=shard)
                except Exception as _e:
                    log("图片下载失败（tier=%s）：%r" % (_tier, _e))
                    path = None
                if path:
                    log("图片档位：%s → %d KB" % (_tier, os.path.getsize(path) // 1024))
                    break
            if not path:
                log("图片取不到本地文件")
                return ""
            # 文件通道：把落盘的图片路径留给 on_message_inner，作为附件交给 DSH
            try:
                msg["_bridge_image_path"] = path
            except Exception:
                pass
            with open(path, "rb") as f:
                raw = f.read()
            if len(raw) > 8 * 1024 * 1024:
                log("图片太大，跳过")
                return ""
            # 关键：按文件头判断真实格式。微信 4.x 的普通图片是 wxgf(HEVC) 容器，
            # 老代码只看扩展名，于是把 wxgf 原样当 image/jpeg 发出去，
            # 视觉接口就回「图片输入格式/解析错误」——表现就是「有时能认、有时不能」。
            if raw[:4] == b"wxgf":
                try:
                    conv = _get_media()._wxgf_to_jpg(raw)
                except Exception as _e:
                    conv = None
                    log("wxgf 转码异常：", repr(_e))
                if not conv:
                    log("这张图是 wxgf/HEVC，本机 ffmpeg 没能转出来，跳过（装 ffmpeg 到 C:\\ffmpeg 即可）")
                    return ""
                raw = conv
                ext = ".jpg"
                # wxgf/HEVC 原图 DSH 不一定能直接读，存一份转好的 jpg 给文件通道用
                try:
                    _conv_path = os.path.join(
                        os.path.dirname(path),
                        "vision-%s-%s.jpg" % (
                            int(time.time() * 1000),
                            re.sub(r"[^0-9A-Za-z_.-]", "_", os.path.basename(path)),
                        ),
                    )
                    with open(_conv_path, "wb") as _cf:
                        _cf.write(conv)
                    msg["_bridge_image_path"] = _conv_path
                except Exception:
                    pass
            elif raw[:8] == b"\x89PNG\r\n\x1a\n":
                ext = ".png"
            elif raw[:3] == b"\xff\xd8\xff":
                ext = ".jpg"
            elif raw[:3] == b"GIF":
                ext = ".gif"
            else:
                ext = os.path.splitext(path)[1].lower()
                if ext not in (".jpg", ".jpeg", ".png", ".gif"):
                    log("图片格式不认识（%s），跳过" % raw[:4])
                    return ""
            mime = "image/png" if ext == ".png" else ("image/gif" if ext == ".gif" else "image/jpeg")
            base = bot_url.rsplit("/webhook", 1)[0]

            # 长截图（竖着很长）整张丢给模型，字会被缩糊；切成 2~3 段分别识别再拼起来
            parts = [raw]
            try:
                from PIL import Image
                import io as _io
                img = Image.open(_io.BytesIO(raw))
                img.load()
                w, h = img.size
                if w > 0 and h / float(w) > 2.2 and h > 1200:
                    n = 3 if h / float(w) > 4.0 else 2
                    overlap = int(h * 0.08)
                    parts = []
                    for i in range(n):
                        top = max(0, int(i * h / n) - (overlap if i else 0))
                        bottom = min(h, int((i + 1) * h / n) + overlap)
                        seg = img.crop((0, top, w, bottom)).convert("RGB")
                        buf = _io.BytesIO()
                        seg.save(buf, format="JPEG", quality=88)
                        parts.append(buf.getvalue())
                    log("长截图 %dx%d，切成 %d 段分别识别" % (w, h, len(parts)))
                else:
                    # 普通图：统一转 RGB JPEG 再发，规避 webp/heic 之类的格式坑
                    img2 = img.convert("RGB")
                    buf = _io.BytesIO()
                    img2.save(buf, format="JPEG", quality=88)
                    parts = [buf.getvalue()]
                    mime = "image/jpeg"
            except Exception as _e:
                log("图片预处理跳过（用原图）：", repr(_e))
                parts = [raw]

            texts = []
            for idx, part in enumerate(parts):
                prompt = ""
                if len(parts) > 1:
                    prompt = "这是一张长截图从上往下的第 %d/%d 段。逐条转写这一段里的文字（分清左边对方/右边本人），不要省略。" % (idx + 1, len(parts))
                r = LOCAL_HTTP.post(
                    base + "/api/vision",
                    json={"image": base64.b64encode(part).decode(), "mime": mime, "prompt": prompt},
                    timeout=120,
                )
                data = r.json()
                piece = str(data.get("text") or "").strip()
                if piece:
                    texts.append(piece)
                if not data.get("ok", True):
                    log_throttled("img-fail:" + str(data.get("error"))[:40], "第 %d 段识别失败：%s" % (idx + 1, data.get("error")))
            text = "\n".join(texts).strip()
            if len(text) > 1200:
                text = text[:1200] + "…"
            log("图片识别：", text[:80])
            return text
        except Exception as e:
            log_throttled("img-exc:" + type(e).__name__, "图片识别失败：", repr(e))
            return ""

    def transcribe_voice(msg):
        """语音消息 → 文字；失败返回空串。"""
        if not VOICE_ENABLED:
            log("语音识别已关闭（voice.enabled=false）")
            return ""
        try:
            import io
            import wave
            user = msg.get("username") or ""
            lid = msg.get("local_id")
            shard = msg.get("shard")
            if not user or lid is None:
                return ""
            path = _get_media().download_voice(user, int(lid), shard=shard)
            if not path:
                log("语音没落盘（这条微信没缓存到本地），跳过")
                return ""
            try:
                import pysilk
            except Exception:
                log("缺少 pysilk，装一下：pip install silk-python")
                return ""
            pcm = io.BytesIO()
            with open(path, "rb") as f:
                pysilk.decode(f, pcm, VOICE_SAMPLE_RATE)
            raw = pcm.getvalue()
            seconds = len(raw) / float(VOICE_SAMPLE_RATE * 2)
            if seconds < 0.3:
                log("语音太短（%.1fs），跳过" % seconds)
                return ""
            if seconds > VOICE_MAX_SECONDS:
                log("语音太长（%.0fs > %.0fs），跳过" % (seconds, VOICE_MAX_SECONDS))
                return ""
            wav_path = os.path.splitext(path)[0] + ".wav"
            with wave.open(wav_path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(VOICE_SAMPLE_RATE)
                w.writeframes(raw)
            with open(wav_path, "rb") as f:
                text = asr_transcribe(f.read(), VOICE_API_KEY, VOICE_MODEL, VOICE_BASE_URL, VOICE_TIMEOUT)
            text = clean_transcript(text)
            log("语音识别（%.1fs）：%s" % (seconds, text[:60] or "（空）"))
            return text
        except Exception as e:
            log_throttled("voice-fail:" + type(e).__name__, "语音识别失败：", repr(e))
            return ""


    def on_message_inner(msg, listener):
        try:
            username = msg.get("username") or ""
            if not username:
                return
            _is_test_chat = bool(WECHAT_TEST_MODE and WECHAT_TEST_CHAT
                                 and username == WECHAT_TEST_CHAT)
            mtype = msg.get("type") or ""
            content = (msg.get("content") or "").strip()
            # 文件通道：本次消息要交给 DSH 的附件绝对路径（图片/文件各一支）
            _attachment_path = ""
            _file_handled = False
            # 安全：用户自己打字写的 [Shared attachment] 一律中和掉，只信任桥接自己下载后
            # 追加的那一行；否则陌生人发一句带 marker 的话就能让模型去读本机任意文件。
            # 注意：文本消息下面会重置 content，所以最终 payload 处还会再中和一次。
            if "[Shared attachment]" in content or "[shared attachment]" in content.lower():
                content = re.sub(r"\[\s*Shared\s+attachment\s*\]", "[Shared attachment-blocked]",
                                 content, flags=re.I)
                log("已中和用户输入的附件标记")
            # 有的微信版本把表情包报成「图片」，正文里还是 <emoji md5=...>：
            # DSH 原生模式可以把它当图片交给 DSH 识别；非 DSH 模式仍装死，避免乱接话。
            _emoji_like = "<emoji" in content
            if mtype == "图片" and _emoji_like:
                if WECHAT_IMAGE_TO_DSH:
                    _st_path = prepare_image_path(msg)
                    if _st_path and os.path.exists(_st_path):
                        content = "（对方发了一个表情包）"
                        _attachment_path = os.path.abspath(_st_path)
                        log("表情包交给 DSH 看：", _attachment_path)
                    else:
                        log("表情包取不到图，装死")
                        return
                else:
                    log("收到表情包，装死（不识别不回）")
                    return
            elif mtype == "图片":
                _img_prepared = prepare_image_path(msg) if WECHAT_IMAGE_TO_DSH else ""
                if WECHAT_IMAGE_TO_DSH and _img_prepared:
                    # DSH 原生：图片直接交给 DSH 分析（不发“收到”回执，处理完直接出结果）
                    content = "（对方发了一张图片）"
                    _attachment_path = os.path.abspath(_img_prepared)
                    log("图片交给 DSH 看：", _attachment_path)
                else:
                    # 非 DSH 模式（或图片准备失败）：仍走鲸鱼娘视觉接口
                    desc = describe_image(msg)
                    if not desc:
                        return
                    content = "（对方发了一张图片，图里是：%s）" % desc
                    if WECHAT_FILE_IN:
                        _img_path = msg.get("_bridge_image_path") or ""
                        if _img_path and os.path.exists(_img_path):
                            _attachment_path = os.path.abspath(_img_path)
            if mtype == "语音":
                said = transcribe_voice(msg)
                if not said:
                    log("语音没识别出内容，先不说话")
                    return
                content = "（对方发了一条语音，说的是：%s）" % said
            if mtype in ("表情", "动画表情"):
                # DSH 原生多模态：表情包也交给 DSH 看，由它自己决定说什么；非 DSH 模式仍装死。
                if WECHAT_IMAGE_TO_DSH:
                    _st_path = prepare_image_path(msg)
                    if _st_path and os.path.exists(_st_path):
                        content = "（对方发了一个表情包）"
                        _attachment_path = os.path.abspath(_st_path)
                        log("表情包交给 DSH 看：", _attachment_path)
                    else:
                        log("表情包取不到图，装死")
                        return
                else:
                    log("收到表情包，装死（不识别不回）")
                    return
            # 有的表情包被报成「文件/链接/卡片」（appmsg type=8）：按表情包处理
            _appmsg_sticker_handled = False
            if mtype in ("文件", "文件/链接/卡片") and ("<emojiinfo>" in content or "<emoticonmd5>" in content):
                _appmsg_sticker_handled = True
                _st = appmsg_sticker_path(content)
                if _st and os.path.exists(_st):
                    content = "（对方发了一个表情包）"
                    _attachment_path = os.path.abspath(_st)
                    _file_handled = True
                    log("表情包(appmsg)交给 DSH 看：", _attachment_path)
                else:
                    log("表情包(appmsg)取不到图，装死")
                    return
            # 引用上下文：桥接只把「引用了谁、原话、对方评论」交代清楚；
            # 不猜是任务还是闲聊，也不把引用当新文件下载。
            _quoted_context = False
            _quoted_text = ""
            _quoted_file_title = ""
            _quoted_comment = ""
            _quoted_sender_name = ""
            if "refermsg" in content.lower():
                try:
                    import html as _html
                    _rm = __import__("re").search(r"<refermsg>(.*?)</refermsg>", content, __import__("re").S | __import__("re").I)
                    if _rm:
                        _qblk = _html.unescape(_rm.group(1))
                        _disp = __import__("re").search(r"<displayname>(.*?)</displayname>", _qblk, __import__("re").S)
                        _qcontent = __import__("re").search(r"<content>(.*?)</content>", _qblk, __import__("re").S)
                        _quoted_sender_name = (_disp.group(1).strip() if _disp else "")[:40]
                        _qraw = _html.unescape(_qcontent.group(1)) if _qcontent else ""
                        _quoted_text = __import__("re").sub(r"<[^>]*>", " ", _qraw)
                        _quoted_text = __import__("re").sub(r"\s+", " ", _quoted_text).strip()[:600]
                        _looks_like_file = (
                            "<fileext>" in _qblk.lower() or "<totallen>" in _qblk.lower()
                            or bool(__import__("re").search(r"\.(pdf|docx?|xlsx?|pptx?|zip|rar|txt|md|csv|jpg|png)\b", _qblk, __import__("re").I))
                        )
                        if _looks_like_file:
                            _qt = __import__("re").search(r"<title>(.*?)</title>", _qblk, __import__("re").S)
                            _quoted_file_title = (_qt.group(1).strip() if _qt else "")[:80]
                        _outer = content[:content.lower().find("<refermsg>")]
                        _ot = __import__("re").search(r"<title>(.*?)</title>", _outer, __import__("re").S)
                        _od = __import__("re").search(r"<des>(.*?)</des>", _outer, __import__("re").S)
                        _quoted_comment = ((_ot.group(1).strip() if _ot else "")
                                           or (_od.group(1).strip() if _od else ""))[:300]
                        _quoted_context = bool(_quoted_sender_name or _quoted_text or _quoted_file_title or _quoted_comment)
                except Exception as _qe:                 # noqa: BLE001
                    log("引用上下文解析失败：", repr(_qe))
            if _quoted_context:
                _orig_path = ""
                if _quoted_file_title:
                    # 先找 DSH 产物 outbox（自己发出去的文件）
                    for _dir in (
                        os.path.join(dsh_bridge_workspace(), ".whale-bridge", "outbox"),
                        # 再找微信入站文件缓存（群友引用别人发过的 PDF/文档）
                        os.path.join(ROOT, "data", "wechat-files"),
                    ):
                        try:
                            for _fn in os.listdir(_dir):
                                if _quoted_file_title in _fn or _fn in _quoted_file_title:
                                    _orig_path = os.path.join(_dir, _fn)
                                    break
                        except Exception:
                            pass
                        if _orig_path:
                            break
                if _quoted_file_title:
                    content = ("（对方引用了聊天里出现过的文件《%s》。这是引用卡片；"
                               "引用发送者：%s；对方自己的话/评论：%s。"
                               "如果下面给出了原文件本地路径，请直接读它；"
                               "请结合上下文自行判断是不是新任务：只是评论就自然接话；"
                               "只有明确要求修改/重做/查看时才处理，不要默认重做，也不要要求重发。）"
                               % (_quoted_file_title, _quoted_sender_name or "未知",
                                  _quoted_comment or "（没有文字）"))
                    if _orig_path:
                        _attachment_path = os.path.abspath(_orig_path)
                        content += "（原文件本地路径：%s）" % _attachment_path
                else:
                    content = ("（对方引用了 %s 的消息：“%s”，并说/评论：“%s”。"
                               "这是引用上下文，不是新文件、也不是自动任务。"
                               "请结合上下文自然回复；只有对方明确要求你做事时才当任务，"
                               "不要因为引用/图片/表情就发收到回执。）"
                               % (_quoted_sender_name or "某人", _quoted_text or "（无文字）",
                                  _quoted_comment or "（无文字）"))
                _file_handled = True
                log("引用上下文交给 DSH 判断：", _quoted_sender_name,
                    "文件=", _quoted_file_title or "(无)", "评论=", _quoted_comment)
            # 文件通道（入站）：微信「文件」消息 → 下载到本地 → 作为附件交给鲸鲸/DSH。
            # 微信 4.x 把文件和链接卡片都报成「文件/链接/卡片」，用 XML 里的
            # <fileext>/<totallen> 区分；链接卡片仍走下面的老逻辑（抠 <url>）。
            if (not _appmsg_sticker_handled and not _quoted_context and WECHAT_FILE_IN and mtype in ("文件", "文件/链接/卡片")
                    and ("<fileext>" in content or "<totallen>" in content
                         or ("<title>" in content and "<url>" not in content))):
                # 先过「过期/自己发的」闸再下载，避免为了不回的旧消息白下载大文件
                _early_sender = msg.get("sender_username") or ""
                _early_ct = float(msg.get("create_time") or 0)
                if ((_early_sender == me and not _is_test_chat)
                        or (_early_ct and _early_ct < START_TS - SKIP_OLDER_THAN)
                        or (_early_ct and (time.time() - _early_ct) > STALE_AFTER)):
                    log("跳过过期/自己的文件消息（不下载）")
                    return
                # 微信会先插入一条「预览行」再补齐 XML：监听有可能先拿到没有 title 的版本；
                # 手机刚发的文件在本机落盘也有延迟。先等 1.5s 再按 local_id 回读原始 content，
                # 并且下载/缓存都重试几次——对齐 Hermes 的做法：媒体晚到要等，不能一次失败就报错。
                time.sleep(1.5)

                _raw_content = content
                _file_title = ""
                _file_total = 0
                _file_ext = ""
                _fp = None
                # 取件进度提示：发现文件先说一声；等待/处理期间定期报进展，别让主人干等
                _prog_name = display_name(username)
                # 大文件下载慢：按 totallen 给不同等待窗口，期间持续轮询缓存；有大小就要求完全一致
                _wait_sec = 20.0
                _wait_started = time.time()
                _last_wait_log = 0.0
                _attempt = 0
                _prog_ack_sent = True
                while True:
                    _attempt += 1
                    if _attempt > 1:
                        time.sleep(1.5)
                    _raw_content = _raw_message_content(username, msg.get("local_id")) or _raw_content
                    _t, _tot, _ext = _parse_file_meta(_raw_content)
                    if _t:
                        _file_title = _t
                    if _tot:
                        _file_total = _tot
                        # 大文件按大小给等待窗口（最大 120 秒）
                        if _file_total > 10 * 1024 * 1024:
                            _wait_sec = 120.0
                        elif _file_total > 3 * 1024 * 1024:
                            _wait_sec = 60.0
                        else:
                            _wait_sec = 25.0
                    if _ext:
                        _file_ext = _ext
                    # 一发现文件就发回执（不下载完再发）：复用该聊天的正式 DSH 会话生成一句话
                    if not _prog_ack_sent and (_file_title or _file_total or _attempt >= 2):
                        _ack = dsh_progress_line(
                            "discovered", _file_title, (_file_total or 0) / 1024.0 / 1024.0, 0.0,
                            "file", username,
                            "group" if str(username).endswith("@chatroom") else "private")
                        if _ack:
                            try:
                                send_text(_ack, _prog_name, username, force=True)
                                _prog_ack_sent = True
                                log("已发送文件回执：", _ack)
                            except Exception as _ack_e:      # noqa: BLE001
                                log("文件回执发送失败：", repr(_ack_e))
                    _lid = msg.get("local_id")
                    if _lid is not None:
                        for _kw in ({"shard": msg.get("shard")}, {}):
                            try:
                                _fp = _get_media().download_file(username, int(_lid), **_kw)
                            except Exception as _fe:         # noqa: BLE001
                                _fp = None
                                log("文件下载失败（第%d次 %s）：%r" % (_attempt, _kw, _fe))
                            if _fp and os.path.exists(_fp):
                                break
                    # download_file 也可能只拿到半截：有 totallen 时按大小卡住
                    if _fp and os.path.exists(_fp):
                        try:
                            _sz = os.path.getsize(_fp)
                        except Exception:
                            _sz = 0
                        if _file_total and _sz != int(_file_total):
                            _fp = None
                        else:
                            break
                    try:
                        _fp = copy_cached_wechat_file(_file_title, _file_total, _file_ext)
                    except Exception as _fe2:        # noqa: BLE001
                        _fp = None
                        log("缓存文件兜底失败：", repr(_fe2))
                    if _fp and os.path.exists(_fp):
                        log("文件走缓存兜底：", _fp)
                        break
                    _fp = None
                    _waited = time.time() - _wait_started
                    if _waited >= _wait_sec:
                        break
                    if _waited - _last_wait_log > 10:
                        log("仍在等文件下载：%s（已等 %.0fs/最多 %.0fs）" % (
                            _file_title or "?", _waited, _wait_sec))
                        _last_wait_log = _waited
                if not _fp:
                    log("[dbg] 文件取不到：local_id=%r len=%d title=%r total=%r ext=%r head=%r"
                        % (msg.get("local_id"), len(_raw_content or ""), _file_title,
                           _file_total, _file_ext, (_raw_content or "")[:100]))
                if _fp and os.path.exists(_fp):
                    try:
                        _fsz = os.path.getsize(_fp)
                    except Exception:
                        _fsz = 0
                    _in_limit = max(1.0, float(WECHAT_FILE_MAX_MB)) * 1024 * 1024
                    if _fsz > _in_limit:
                        content = "（对方发了一个文件：%s，%s，超过 %.0f MB 上限，桥接没有交给 DSH）" % (
                            _file_title or os.path.basename(_fp), _fmt_kb(_fsz), WECHAT_FILE_MAX_MB)
                        log("入站文件超过上限，跳过：", _file_title or os.path.basename(_fp), _fmt_kb(_fsz))
                    else:
                        content = "（对方发了一个文件：%s，%s）" % (
                            _file_title or os.path.basename(_fp), _fmt_kb(_fsz))
                        _attachment_path = os.path.abspath(_fp)
                        log("收到文件：", _file_title or os.path.basename(_fp), "→", _attachment_path)
                    _file_handled = True
                else:
                    content = ("（对方发了一个文件：%s，但桥接没能取到本地文件；"
                               "请让主人重发一次，或改用网页聊天上传）"
                               % (_file_title or "未命名文件"))
                    log("文件没能取到本地：", _file_title or "?")
                    _file_handled = True
                # 文字比文件先到（主人的常见发法）：合并成一轮，别回答「文件呢」
                _caption = str(msg.get("_bridge_caption") or "").strip()
                if _caption:
                    content = "%s\n（对方同时说：%s）" % (content, _caption[:300])
            if not _file_handled and mtype not in ("文本", "语音", "图片", "表情", "动画表情"):
                if "移出群聊" in content or "移出" in content:
                    dead_chats.add(username)
                    log("被移出群聊，停掉这个会话：", display_name(username))
                    return
                # 链接卡片 / 分享卡片：从 XML 里把 url 和 title 抠出来，当成一句带链接的话
                import re as _re
                mu = _re.search(r"<url>(.*?)</url>", content, _re.S)
                mt = _re.search(r"<title>(.*?)</title>", content, _re.S)
                if mu:
                    title = (mt.group(1).strip() if mt else "")[:60]
                    content = "分享了一个链接：%s %s" % (title, mu.group(1).strip())
                else:
                    return
            if ONLY_CHATS:
                try:
                    if display_name(username) not in ONLY_CHATS:
                        return
                except Exception:
                    return
            # 图片/语音/表情的 content 已经被上面替换成描述，别再重置回原始 XML
            if mtype == "文本":
                content = (msg.get("content") or "").strip()
            if not content or content.startswith("<"):
                return
            sender = msg.get("sender_username") or ""
            if sender == me and not _is_test_chat:
                return  # 自己发的
            create_time = float(msg.get("create_time") or 0)
            if create_time and create_time < START_TS - SKIP_OLDER_THAN:
                return
            # 已经放了太久的消息（比如前面堵着几条），不再回
            if create_time and (time.time() - create_time) > STALE_AFTER:
                log("跳过过期消息（%.0fs 前）：%s" % (time.time() - create_time, content[:20]))
                return

            is_group = username.endswith("@chatroom")
            nickname = ""
            try:
                nickname = db.get_nickname(sender) or ""
            except Exception:
                nickname = ""
            if not nickname:
                nickname = "群友" if is_group else "微信好友"

            # 系统号 / 通知不接话：之前会跟「微信团队」对骂，还把通知当成人来问
            if not _is_test_chat and is_system_notice(username, nickname, content):
                if ONLY_CHATS:
                    return
                log("跳过系统通知：", nickname, "：", content[:24])
                return
            # 同一人短时间内重复同一句 → 不再回（防刷屏 / 防通知重投）
            # 图片/表情包/文件的描述文字可能完全一样，必须把附件路径/local_id 算进去重键，
            # 否则连续发两张不同的表情包会被当成“重复消息”丢掉
            _dedupe_key = content
            if _attachment_path:
                _dedupe_key = content + "|" + os.path.abspath(_attachment_path)
            elif str(mtype) in ("图片", "表情", "动画表情", "文件", "文件/链接/卡片"):
                _dedupe_key = content + "|lid:" + str(msg.get("local_id"))
            if duplicate_guard(username, sender, _dedupe_key):
                log("跳过重复消息：", nickname, "：", content[:20])
                return


            # 「拍了拍」这类系统提示不是人在说话，别接
            if "拍了拍" in content and "<url>" not in content:
                log("跳过拍一拍提示：", content[:24])
                return
            # 只把真正的 @ 当作 at_me；普通句子里提到「鲸鲸」不能误触发。
            # WeChat 会在 @昵称 后插入 U+2005，先换成普通空格再判定。
            import re as _mention_re
            _at_text = content.replace("\u2005", " ")
            addressed = any(
                a and _mention_re.search(
                    r"@\s*" + _mention_re.escape(str(a)) + r"(?=$|[\s，,：:！!~～…?？。\-—])",
                    _at_text,
                )
                for a in aliases
            )
            # 群里直接叫名字/别名（不 @）也算叫她；否则只有 @ 才必回，
            # 用户会误以为「喊她名字」没用。用别名整体匹配，避免拆字误伤。
            if is_group and not addressed:
                _plain = _mention_re.sub(r"^[A-Za-z0-9_\-]{4,}:\s*", "", _at_text)
                addressed = any(str(a) and str(a) in _plain for a in aliases)
                if addressed:
                    log("群里叫到名字/别名 → 当 addressed：", nickname, "：", content[:24])

            # 引用回复：如果引用块里是机器人自己（fromusr==机器人 wxid，
            # 或 displayname 命中别名），也算 addressed，保证「引用她的话」必回。
            _quoted_bot = False
            if is_group and "refermsg" in _at_text.lower():
                try:
                    _rm = _mention_re.search(r"<refermsg>(.*?)</refermsg>", _at_text, _mention_re.S)
                    if _rm:
                        _blk = _rm.group(1)
                        _from = _mention_re.search(r"<fromusr>(.*?)</fromusr>", _blk, _mention_re.S)
                        _disp = _mention_re.search(r"<displayname>(.*?)</displayname>", _blk, _mention_re.S)
                        _from_s = (_from.group(1) if _from else "").strip()
                        _disp_s = (_disp.group(1) if _disp else "").strip()
                        if (_from_s and _from_s == str(me)) or any(str(a) and str(a) in _disp_s for a in aliases):
                            addressed = True
                            _quoted_bot = True
                            log("群里引用机器人的话 → 当 addressed：", nickname, "：", content[:24])
                except Exception:
                    pass
            # B站链接：被叫到（群里 @/名字/引用）或私聊时，直接走视频理解链路，
            # 不再把原始链接丢给鲸鱼娘（她只能读标题）。
            try:
                _bvid = _bili_watch.extract_bvid(content) if content else ""
            except Exception:
                _bvid = ""
            if _bvid and (addressed or not is_group):
                log("B站视频请求 →", _bvid, "：", display_name(username))
                _BILI_WATCH_EXECUTOR.submit(_bili_watch_worker, _bvid, display_name(username), username)
                return

            _at_remainder = _mention_re.sub(r"^[A-Za-z0-9_\-]{4,}:\s*", "", _at_text).strip()
            for _alias in aliases:
                if _alias:
                    _at_remainder = _mention_re.sub(r"@\s*" + _mention_re.escape(str(_alias)), " ", _at_remainder)
            _bare_mention = not _at_remainder.strip(" \t\r\n，,。.!！?？…~～")
            # 群里先说话、再单独发一个 @ → 把上一条问题补回来
            if username.endswith("@chatroom") and addressed and _bare_mention:
                try:
                    # get_messages 按新到旧返回；直接遍历，拿离这个裸 @ 最近的上一条。
                    for m in db.get_messages(username, limit=12):
                        if m.get("type") != "文本":
                            continue
                        if (m.get("sender_username") or "") != sender:
                            continue
                        prev = (m.get("content") or "").strip()
                        prev = __import__("re").sub(r"^[A-Za-z0-9_\-]{4,}:\s*", "", prev).strip()
                        if prev and not any(a in prev for a in aliases):
                            content = prev
                            log("补上一条问题：", prev[:20])
                            break
                except Exception as e:
                    log("补问题失败：", repr(e))
            # 把群消息里的其他 @ 对象一并交给服务端，帮助模型分清“你”是在说谁。
            _mentioned_names = []
            if is_group:
                for _hit in _mention_re.findall(r"@\s*([^\s@，,：:！!~～…?？。—]+)", _at_text):
                    _name = str(_hit).strip()
                    if _name and _name not in aliases and _name not in _mentioned_names:
                        _mentioned_names.append(_name)
            log("收到", ("群" if is_group else "私聊"), display_name(username), "←", nickname, "：", content[:30])
            # 最终防线：payload 送出前再中和一次用户输入的附件 marker。
            # （文本分支会重置 content，群聊「补上一条问题」也可能换成用户原文；只保留
            #   桥接自己下载后追加的那一行 [Shared attachment] file: <path>。）
            _payload_text = re.sub(r"\[\s*Shared\s+attachment\s*\]",
                                   "[Shared attachment-blocked]", content, flags=re.I)
            if _payload_text != content:
                log("最终 payload 中和了用户输入的附件标记")
            if _attachment_path:
                _payload_text = _payload_text + "\n\n[Shared attachment] file: " + _attachment_path
                log("附件交给鲸鲸：", _attachment_path)
            # 工作类请求：在进主任务之前，先让 DSH 在同一会话里明确回一句「开工」回执；
            # 这样写 PDF / 跑工具这类慢任务不会让用户干等（文件附件已有自己的回执，跳过）。
            _WORK_ACK_RE = re.compile(
                r"(帮我|帮忙|给我|替我|写一份|写个|写一个|做一份|做个|生成|总结|整理|翻译|分析|查一下|搜索|制作|导出|创建|PDF|文档|表格|脚本|代码)"
            )
            if False and (not _attachment_path and not _is_test_chat and not content.startswith("<")
                    and _WORK_ACK_RE.search(str(content or ""))):
                try:
                    _work_ack = dsh_progress_line(
                        "working", "", 0.0, 0.0, "task", username,
                        "group" if is_group else "private")
                    if _work_ack:
                        send_text(_work_ack, display_name(username), username, force=True)
                        log("已发送开工回执：", _work_ack)
                except Exception as _wa_e:      # noqa: BLE001
                    log("开工回执失败：", repr(_wa_e))
            payload = {
                "chat_id": username,
                "chat_type": "group" if is_group else "private",
                "user_id": sender or "unknown",
                "senderId": sender or "unknown",
                "sender_id": sender or "unknown",
                "senderName": nickname,
                "nickname": nickname,
                "text": _payload_text,
                "msg_id": "%s:%s:%s" % (username, msg.get("shard") or "", msg.get("local_id")),
                "at_me": addressed, "reply_to_bot": bool(locals().get("_quoted_bot", False)),
                "mentioned_names": _mentioned_names,
                "chat_title": display_name(username) if is_group else "",
            }


            task_started = time.time()
            data = None
            try:
                headers = {"x-whale-bridge": "1", "x-whale-stream": "1", "Accept": "text/event-stream"}
                if token:
                    headers["x-bot-token"] = token
                r = LOCAL_HTTP.post(
                    bot_url,
                    json=payload,
                    headers=headers,
                    # 文件交给 DSH 阅读时可能跑几分钟（大文本/多工具），别在 120s 就放弃
                    timeout=600,
                    stream=True,
                )
                _ctype = str(r.headers.get("Content-Type") or "")
                if "text/event-stream" in _ctype:
                    # 鲸鱼娘流式返回：status=DSH 真实进度（由插件推给它），done=最终结果
                    _stream_target = "文件传输助手" if _is_test_chat else display_name(username)
                    _sent_status = []
                    _stream_event = ""
                    _done_result = None
                    for _raw in r.iter_lines(decode_unicode=True):
                        if not _raw:
                            continue
                        _line = _raw if isinstance(_raw, str) else _raw.decode("utf-8", "replace")
                        if _line.startswith("event:"):
                            _stream_event = _line[6:].strip()
                            continue
                        if not _line.startswith("data:"):
                            continue
                        try:
                            _obj = json.loads(_line[5:].strip())
                        except Exception:
                            continue
                        _etype = str(_obj.get("type") or _stream_event or "")
                        if _etype == "status":
                            _stext = str(_obj.get("text") or "").strip()
                            if _stext and _stext not in _sent_status:
                                _sent_status.append(_stext)
                                try:
                                    send_text(_stext, _stream_target, username)
                                    log("流式进度 →", _stream_target, "：", _stext[:40])
                                except Exception:
                                    pass
                        elif _etype == "done":
                            _done_result = _obj.get("result") or _obj
                            break
                        elif _etype == "error":
                            raise RuntimeError(str(_obj.get("error") or "stream error"))
                    try:
                        r.close()
                    except Exception:
                        pass
                    if _done_result is None:
                        raise RuntimeError("流式响应结束但没有 done 事件")
                    data = _done_result
                    # 流式文字已经逐段发过：最终结果里把已发部分剥掉，避免重复
                    if _sent_status and isinstance(data, dict):
                        try:
                            _reply0 = str(data.get("reply") or "")
                            _sent_join = "".join(str(x) for x in _sent_status)
                            _norm = lambda s: re.sub(r"\s+", "", str(s or ""))
                            _loose = lambda s: re.sub(r"[\s\W_]+", "", str(s or ""), flags=re.UNICODE)
                            _loose_reply = _loose(_reply0)
                            _sent_loose = [_loose(x) for x in _sent_status]
                            _suffix_loose = [_loose("".join(_sent_status[i:])) for i in range(len(_sent_status))]
                            # 最终回复等于：全部流式内容 / 其中某一段 / 某几段的拼接 → 都是重复，全部跳过
                            _is_dup = bool(_reply0) and _loose_reply and (
                                _loose_reply == _loose(_sent_join)
                                or _loose_reply in _sent_loose
                                or _loose_reply in _suffix_loose
                            )
                            if _is_dup:
                                data = dict(data)
                                # 注意：保留 reply，只跳过正文气泡；否则后面的
                                # 文件通道会因为 reply 为空提前 return，DSH 产物永远发不出去。
                                data["_skip_text"] = True
                                data["bubbles"] = []
                                log("流式去重：最终回复与已发内容一致（段/后缀匹配），跳过最终气泡")
                            elif _reply0 and _sent_join and _norm(_reply0).startswith(_norm(_sent_join)):
                                _tail = _reply0
                                for _seg in _sent_status:
                                    _idx = _tail.find(str(_seg))
                                    if _idx >= 0:
                                        _tail = _tail[:_idx] + _tail[_idx + len(str(_seg)):]
                                _tail = _tail.strip()
                                data = dict(data)
                                data["reply"] = _tail or str(data.get("reply") or "")
                                if _tail:
                                    data["bubbles"] = [_tail]
                                else:
                                    data["_skip_text"] = True
                                    data["bubbles"] = []
                                log("流式去重：最终回复剩余 %d 字" % len(_tail))
                        except Exception as _sde:
                            log("流式去重失败：", repr(_sde))
                else:
                    # 兼容旧行为：鲸鱼娘没走流式时按一次性 JSON 处理
                    data = r.json()
            except Exception as e:
                _msg = repr(e)
                if "10061" in _msg or "refused" in _msg.lower() or "积极拒绝" in _msg:
                    log_throttled(
                        "conn-refused",
                        "连不上本地服务（积极拒绝 = 127.0.0.1 上没有程序在监听）。先双击「启动鲸鱼娘.bat」，等窗口出现「服务已启动」再来。",
                    )
                    if CONN_STATE.get("ok") is not False:
                        CONN_STATE["ok"] = False
                else:
                    log_throttled("webhook-fail:" + _msg[:40], "请求鲸鲸失败：", _msg)
                return

            if CONN_STATE.get("ok") is not True:
                CONN_STATE["ok"] = True
                log("已连上鲸鲸服务：", bot_url.rsplit("/webhook", 1)[0])
            if data.get("action") != "reply" or not data.get("reply"):
                if is_group and addressed:
                    log("鲸鲸没接话：", nickname, "→", content[:20], "|", data.get("reason"))
                return

            # 演示模式（服务端没配 Key，说的是内置台词）：提醒一次，别让人以为「没 Key 也能真聊」
            if data.get("mock") and not MOCK_NOTICED["done"]:
                MOCK_NOTICED["done"] = True
                log("[!] 服务端现在是「演示模式」：没配置 API Key，她回的是内置台词，不是真模型。")
                log("    去网页右上角「设置」填一把 Key（DeepSeek / 智谱 都行）就会切成真模型。")

            target = display_name(username)
            if _is_test_chat:
                target = "文件传输助手"
            if data.get("_skip_text"):
                bubbles = []
            else:
                bubbles = data.get("bubbles") or [data["reply"]]
            # 文件通道（出站）：回复里有 /files/ 下载链接 → 先取到本地，文字发完再发文件。
            # 取不到的文件保留链接文字；发送失败也会回退发链接。
            pending_files, failed_file_urls = [], []
            if WECHAT_FILE_OUT:
                try:
                    _reply_text = str(data.get("reply") or "")
                    _reply_text, bubbles, pending_files, failed_file_urls = prepare_reply_files(
                        _reply_text, bubbles, target, username)
                except Exception as _e:              # noqa: BLE001
                    pending_files, failed_file_urls = [], []
                    log("出站文件预处理失败（按原文字发送）：", repr(_e))
                # 兜底二：不看回复文字，直接扫 DSH outbox 里「本次回复期间」新出现的文件。
                # （鲸鱼娘服务端会截断/切分长回复，下载链接可能整段丢失，靠扫目录更稳。）
                try:
                    _known = {os.path.abspath(x["path"]).lower() for x in pending_files}
                    for _item in scan_dsh_outbox(task_started - 3):
                        _p = os.path.abspath(_item["path"]).lower()
                        if _p in _known:
                            continue
                        _known.add(_p)
                        pending_files.append(_item)
                    if pending_files:
                        # 同一个文件可能同时被插件回复链接和 outbox 扫描登记（路径不同），按内容哈希去重
                        _uniq_files, _seen_hash = [], set()
                        for _it in pending_files:
                            _pth = str(_it.get("path") or "")
                            _h = ""
                            try:
                                if _pth and os.path.exists(_pth):
                                    with open(_pth, "rb") as _hf:
                                        _h = hashlib.md5(_hf.read()).hexdigest()
                            except Exception:
                                _h = ""
                            _key = _h or (os.path.abspath(_pth).lower() if _pth else str(_it.get("url") or ""))
                            if _key in _seen_hash:
                                log("跳过重复待发文件：", os.path.basename(_pth) or _it.get("name"))
                                continue
                            _seen_hash.add(_key)
                            _uniq_files.append(_it)
                        pending_files = _uniq_files
                        log("本次回复待发送文件 %d 个（含 outbox 扫描，已去重）" % len(pending_files))
                except Exception as _e2:             # noqa: BLE001
                    log("扫描 DSH outbox 失败：", repr(_e2))
            mention = str(data.get("mention") or "").strip()
            # 生成期间又来了新消息 → 这条旧回复就不发了（避免回上一句）
            # 不再因为“有新消息”丢掉旧回复：宁可晚一点，也要回
            if not rate_guard(username):
                log("这一分钟回太多了，先停一下：", target)
                return
            log("回复", ("群" if is_group else "私聊"), target, "→", nickname, "：", ((bubbles[0] if bubbles else "") or "")[:40])

            first = True
            for line in bubbles:
                if not line:
                    continue
                # 第一条如果是骂人/点名，用真 @（UI 里选成员），而不是纯文本 @名字
                if first and mention and is_group:
                    body = line
                    for prefix in ("@%s" % mention, "@ %s" % mention):
                        if body.startswith(prefix):
                            body = body[len(prefix):].lstrip(" ，,：:")
                            break
                    if send_at(mention, body, target, username):
                        first = False
                        time.sleep(0.6)
                        continue
                    log("真 @ 失败，退回普通文本：", mention)
                    if not line.startswith("@"):
                        line = "@%s %s" % (mention, line)
                send_text(line, target, username, quote_text=(content if first and QUOTE_REPLY else None))
                first = False
                time.sleep(0.6)
            # 文件通道（出站第二段）：文字发完后，把 DSH 产物发成微信文件消息。
            for _item in pending_files:
                if not WECHAT_FILE_OUT:
                    break
                _sent = send_file_wechat(_item["path"], target, username)
                if _sent.get("ok"):
                    mark_media_sent(_item)
                    continue
                _url = str(_item.get("url") or "")
                if not _url:
                    log("文件发送失败（没有可回退的下载链接）：", _item.get("name") or "")
                    continue
                log("文件发送失败，回退发下载链接：", _item.get("name") or "")
                try:
                    send_text(_url, target, username)
                except Exception as _e:              # noqa: BLE001
                    log("回退发下载链接失败：", repr(_e))
            for _url, _why in failed_file_urls:
                log("文件没取到，保留链接文字：", _url, "→", _why)
            # Stale/queued webhook payloads must claim a current-generation job;
            # local master OFF is silent even if an old server response has a sticker.
            _stk = data.get("sticker") or None
            if STICKER_TEST_ON and isinstance(_stk, dict):
                claim_and_send_sticker(_stk, expected_chat=target, expected_username=username)
        except Exception as e:
            log("处理消息异常：", repr(e))

    ensure_whale_server(bot_url, timeout=90)
    log("开始监听新消息…（Ctrl+C 退出）")
    def sticker_test_loop():
        """常驻但默认休眠：关闭时不访问任何表情包接口、文件或窗口，也不打印日志。"""
        while True:
            try:
                if STICKER_TEST_ON and sticker_config_now() is not None:
                    response = LOCAL_HTTP.get(sticker_base + "/api/stickers/pending",
                                              headers=sticker_headers, timeout=3)
                    body = response.json() if response.status_code == 200 else None
                    items = body.get("items") if isinstance(body, dict) and body.get("ok") is True else []
                    for item in items if isinstance(items, list) else []:
                        if not STICKER_TEST_ON or sticker_config_now() is None:
                            break
                        claim_and_send_sticker(item)
            except Exception:
                # Network/auth/JSON failures are not permission to send or to
                # log an experimental feature while its switch is changing.
                pass
            time.sleep(5)

    executor = ThreadPoolExecutor(max_workers=1)
    threading.Thread(target=sticker_test_loop, daemon=True).start()


    _pending_text = {}
    _pending_lock = threading.Lock()

    def _flush_text(chat):
        with _pending_lock:
            entry = _pending_text.pop(chat, None)
        if entry:
            try:
                executor.submit(on_message_inner, entry["msg"], None)
            except Exception as e:                    # noqa: BLE001
                log("提交消息处理失败：", repr(e))

    def on_message(msg, listener):
        # 文字先到、文件紧随其后（主人的常见发法）：文字先压 1.5 秒，
        # 同会话文件消息到了就合并成一轮；否则再单独发文字。
        try:
            _mt = msg.get("type") or ""
            _chat = msg.get("username") or ""
            # 微信分享的 B 站视频是「链接卡片」，content 是 XML，不是普通文本；
            # 必须在文件/卡片处理之前识别，否则会被当成文件去下载而失败。
            try:
                _raw_content = str(msg.get("content") or "")
                _bvid_early = _bili_watch.extract_bvid(_raw_content)
            except Exception:
                _bvid_early = ""
            _is_self = bool(msg.get("sender_username")) and str(msg.get("sender_username")) == str(me)
            _is_master = bool(MASTER_WXID) and str(msg.get("sender_username") or "") == str(MASTER_WXID)
            _is_group_chat = str(_chat).endswith("@chatroom")
            if _bvid_early and not _is_self and (_is_master or not _is_group_chat):
                log("B站链接卡片/文本 →", _bvid_early, "：", display_name(_chat))
                _BILI_WATCH_EXECUTOR.submit(_bili_watch_worker, _bvid_early, display_name(_chat), _chat, _raw_content[:600])
                return
            if _mt == "文本" and _chat:
                with _pending_lock:
                    old = _pending_text.pop(_chat, None)
                    timer = threading.Timer(1.5, _flush_text, args=(_chat,))
                    timer.daemon = True
                    _pending_text[_chat] = {"msg": msg, "timer": timer}
                if old:
                    try:
                        old["timer"].cancel()
                    except Exception:
                        pass
                    executor.submit(on_message_inner, old["msg"], None)
                timer.start()
                return
            if _mt in ("文件", "文件/链接/卡片") and _chat:
                with _pending_lock:
                    entry = _pending_text.pop(_chat, None)
                if entry:
                    try:
                        entry["timer"].cancel()
                    except Exception:
                        pass
                    merged = dict(msg)
                    merged["_bridge_caption"] = str(entry["msg"].get("content") or "")
                    executor.submit(on_message_inner, merged, listener)
                    return
            executor.submit(on_message_inner, msg, listener)
        except Exception as e:                        # noqa: BLE001
            log("提交消息处理失败：", repr(e))

    listener = Listener(db, interval=0.4)
    listener.add_all(on_message)
    listener.start()

    def _selftest_inject_worker():
        """自测钩子（默认关闭）：没有第二个微信账号时，向测试会话注入消息，
        走一遍真实的文件通道（入站文件 → 鲸鲸/DSH；出站 DSH 产物 → 微信文件消息）。
        由 WHALE_WECHAT_TEST_INJECT=file,text,caption 触发，见文件顶部说明。"""
        time.sleep(8)
        # 自聊时 sender 默认是机器人自己，鲸鱼娘会当自身消息忽略；允许用
        # WHALE_WECHAT_TEST_SENDER 伪装成另一个发送者，才能测通完整链路。
        _test_sender = os.environ.get("WHALE_WECHAT_TEST_SENDER") or me
        _items = [x.strip() for x in WECHAT_TEST_INJECT.split(",") if x.strip()]
        _stamp = time.strftime("%H%M%S")
        try:
            if "caption" in _items:
                _prompt = (os.environ.get("WHALE_WECHAT_TEST_CAPTION")
                           or "鲸鲸，让dsh看看这个文件写了什么")
                _fake_text = {
                    "username": WECHAT_TEST_CHAT, "type": "文本", "content": _prompt,
                    "sender_username": _test_sender, "sender_id": 2,
                    "create_time": time.time(), "local_id": -1, "shard": "",
                }
                log("[selftest] 注入文字（模拟文件前的一句话）：", _prompt[:40])
                on_message(_fake_text, None)
                time.sleep(0.8)
            if "file" in _items:
                _title = os.environ.get("WHALE_WECHAT_TEST_FILE_TITLE") or "任务书-笔记本安装.md"
                _ext = os.environ.get("WHALE_WECHAT_TEST_FILE_EXT") or "md"
                try:
                    _total = int(os.environ.get("WHALE_WECHAT_TEST_FILE_TOTAL") or 10471)
                except Exception:
                    _total = 10471
                _xml = ("<msg><appmsg appid=\"\" sdkver=\"0\"><title>%s</title>"
                        "<fileext>%s</fileext><totallen>%d</totallen></appmsg></msg>"
                        ) % (_title, _ext, _total)
                _fake_file = {
                    "username": WECHAT_TEST_CHAT, "type": "文件/链接/卡片",
                    "content": _xml, "sender_username": _test_sender, "sender_id": 2,
                    "create_time": time.time(), "local_id": -1, "shard": "",
                }
                log("[selftest] 注入入站文件消息：", _title)
                on_message(_fake_file, None)
                time.sleep(100)
            if "text" in _items:
                _prompt = ("让 DSH 生成一个测试文件 wechat-e2e-%s.txt，内容写 HELLO-WECHAT-%s，"
                           "然后把这个文件发给我。") % (_stamp, _stamp)
                _fake_text = {
                    "username": WECHAT_TEST_CHAT, "type": "文本", "content": _prompt,
                    "sender_username": _test_sender, "sender_id": 2,
                    "create_time": time.time(), "local_id": -1, "shard": "",
                }
                log("[selftest] 注入出站测试文本：", _prompt)
                executor.submit(on_message_inner, _fake_text, None)
        except Exception as e:                       # noqa: BLE001
            log("[selftest] 注入失败：", repr(e))

    if WECHAT_TEST_MODE and WECHAT_TEST_INJECT:
        log("[selftest] 测试模式开启：chat=%s inject=%s" % (WECHAT_TEST_CHAT, WECHAT_TEST_INJECT))
        threading.Thread(target=_selftest_inject_worker, daemon=True).start()

    def _selftest_send_url_worker():
        """自测钩子（默认关闭）：只验证出站文件的「回复 URL → 取文件 → 发微信文件」这一段，
        不调模型、不依赖入站消息。由 WHALE_WECHAT_TEST_SEND_URL=<桥接下载链接> 触发。"""
        time.sleep(12)
        try:
            _url = os.environ.get("WHALE_WECHAT_TEST_SEND_URL", "")
            if not _url:
                return
            _reply = "📎 文件下载：\n" + _url
            _clean, _bubbles, _pending, _failed = prepare_reply_files(
                _reply, [], "文件传输助手", WECHAT_TEST_CHAT)
            log("[selftest] 出站 URL 解析：pending=%d failed=%d" % (len(_pending), len(_failed)))
            for _item in _pending:
                _res = send_file_wechat(_item["path"], "文件传输助手", WECHAT_TEST_CHAT)
                log("[selftest] 出站文件发送结果：%r（%s）" % (_res, _item.get("name")))
        except Exception as e:                       # noqa: BLE001
            log("[selftest] 出站发送测试失败：", repr(e))

    if WECHAT_TEST_MODE and os.environ.get("WHALE_WECHAT_TEST_SEND_URL"):
        log("[selftest] 出站文件测试开启（URL 发文件到测试会话）")
        threading.Thread(target=_selftest_send_url_worker, daemon=True).start()

    def _selftest_send_file_worker():
        """自测钩子（默认关闭）：直接调 send_file_wechat 发一个指定文件到测试会话。
        由 WHALE_WECHAT_TEST_SEND_FILE=<绝对路径> 触发。"""
        time.sleep(12)
        try:
            _path = os.environ.get("WHALE_WECHAT_TEST_SEND_FILE", "")
            if not _path:
                return
            _res = send_file_wechat(_path, "文件传输助手", WECHAT_TEST_CHAT)
            log("[selftest] 发文件结果：%r（%s）" % (_res, os.path.basename(_path)))
        except Exception as e:                       # noqa: BLE001
            log("[selftest] 发文件测试失败：", repr(e))

    if WECHAT_TEST_MODE and os.environ.get("WHALE_WECHAT_TEST_SEND_FILE"):
        log("[selftest] 直接发文件测试开启（%s）" % os.path.basename(
            os.environ.get("WHALE_WECHAT_TEST_SEND_FILE", "")))
        threading.Thread(target=_selftest_send_file_worker, daemon=True).start()

    def recent_chats(limit=2, within=1800):
        out = []
        try:
            for s in db.get_sessions(limit=20):
                u = s.get("username") or ""
                if not u or u == "filehelper":
                    continue
                try:
                    ms = db.get_messages(u, limit=1)
                except Exception:
                    continue
                if not ms:
                    continue
                t = float(ms[0].get("create_time") or 0)
                if t and (time.time() - t) > within:
                    continue
                out.append((u, display_name(u)))
                if len(out) >= limit:
                    break
        except Exception:
            pass
        return out

    def notify_away():
        for u, name in recent_chats():
            send_text("我先去休息一下，晚点回你～", name, u, force=True)
            NOTIFIED.append((u, name))
            time.sleep(0.3)
        if NOTIFIED:
            log("已通知最近的聊天：", "、".join(n for _, n in NOTIFIED))

    def share_watch():
        """每隔一段时间自己刷 B 站热门，挑一个没分享过的发到最近活跃的群/私聊。"""
        state_file = os.path.join(ROOT, "data", "share-state.json")
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                last = float(json.load(f).get("lastTs") or 0)
        except Exception:
            last = 0.0
        if not last:
            # 首次启动：5 分钟后再发，别一开机就刷屏
            last = time.time() - SHARE_EVERY * 60 + 60
        while True:
            time.sleep(30)
            if not SHARE_ENABLED:
                continue
            if time.time() - last < SHARE_EVERY * 60:
                continue
            if game_running() or away_active() or foreground_is_fullscreen():
                continue
            target = recent_chats(limit=1, within=7200)
            if not target:
                log("没有最近活跃的会话，这次先不分享")
                last = time.time()
                continue
            u, name = target[0]
            try:
                base = bot_url.rsplit("/webhook", 1)[0]
                r = LOCAL_HTTP.get(base + "/api/share?chat=" + urllib.parse.quote(u), timeout=40)
                data = r.json()
            except Exception as e:
                log("拉取视频失败：", repr(e))
                last = time.time()
                continue
            video = data.get("video")
            last = time.time()
            try:
                with open(state_file, "w", encoding="utf-8") as f:
                    json.dump({"lastTs": last}, f)
            except Exception:
                pass
            if not video:
                log("这次没挑到合适的视频")
                continue
            title = str(video.get("title") or "")[:60]
            link = str(video.get("url") or "")
            topic = str(data.get("topic") or "").strip()
            comment = str(data.get("comment") or "").strip()
            if not comment:
                comment = random.choice([
                    "这个看着还行，评论区比视频有意思",
                    "刚刷到，你们看看",
                    "有点意思，我接着刷了",
                ])
            text = "%s\n%s" % (link, comment)
            log("主动分享视频 →", name, str(video.get("title"))[:30])
            send_text(text, name, u)

    def care_watch():
        """主动搭话：没事的时候她自己来问一句「在干啥 / 累不累」。

        和主动分享同一套节奏，但「该不该发」交给服务端判断（时间窗 / 频率 / 每日上限都在
        src/care.js 里，改配置不用改脚本）。这里只管三件事：到点问一次、挑一个不是正在聊的
        会话、把生成的话发出去。
        """
        state_file = os.path.join(ROOT, "data", "care-state.json")

        def load_state():
            try:
                with open(state_file, "r", encoding="utf-8") as f:
                    return json.load(f) or {}
            except Exception:
                return {}

        def save_state(st):
            try:
                os.makedirs(os.path.dirname(state_file), exist_ok=True)
                with open(state_file, "w", encoding="utf-8") as f:
                    json.dump(st, f, ensure_ascii=False)
            except Exception:
                pass

        while True:
            time.sleep(60)
            if not CARE_ENABLED:
                continue
            if game_running() or away_active() or foreground_is_fullscreen():
                continue
            st = load_state()
            last_ts = float(st.get("lastTs") or 0)
            today = time.strftime("%Y-%m-%d")
            sent = int(st.get("count") or 0) if st.get("day") == today else 0
            base = bot_url.rsplit("/webhook", 1)[0]
            try:
                r = requests.get(
                    base + "/api/care/due",
                    params={"last": int(last_ts * 1000), "sentToday": sent},
                    timeout=15,
                )
                due = r.json() or {}
            except Exception:
                continue
            if not due.get("due"):
                continue
            # 正在聊的会话先别打扰：连续 CARE_QUIET_MIN 分钟内有过消息就跳过
            active = set()
            if CARE_QUIET_MIN > 0:
                try:
                    active = set(u for u, _n in recent_chats(limit=50, within=int(CARE_QUIET_MIN * 60)))
                except Exception:
                    active = set()
            target = None
            try:
                for u, name in recent_chats(limit=8, within=7 * 86400):
                    if u in active:
                        continue
                    is_group = str(u).endswith("@chatroom")
                    # 群聊默认绝不主动（除非显式 care.allowGroups）
                    if is_group and not CARE_ALLOW_GROUPS:
                        continue
                    # 默认只找主人：不是主人的私聊/群一律跳过（除非显式 care.allowOthers）
                    if CARE_ONLY_MASTER and not CARE_ALLOW_OTHERS:
                        if str(u) != str(MASTER_WXID):
                            continue
                    target = (u, name)
                    break
            except Exception:
                target = None
            if not target:
                log_throttled(
                    "care-busy",
                    "主动搭话：最近 %d 分钟内聊过的会话都跳过（quietAfterMinutes），这次不打扰" % int(CARE_QUIET_MIN),
                    ttl=1800,
                )
                continue
            u, name = target
            try:
                r2 = LOCAL_HTTP.get(base + "/api/care", params={"chat": u}, timeout=40)
                text = str((r2.json() or {}).get("text") or "").strip()
            except Exception as e:
                log("生成搭话失败：", repr(e))
                continue
            if not text:
                continue
            log("主动搭话 →", name, text[:30])
            ok = send_text(text, name, u)
            # 发失败也要记一次时间：以前失败不写状态，于是每 60 秒重试一次，
            # 日志里就出现「每分钟都在主动搭话」的刷屏（实测 158 条）。
            save_state({"lastTs": time.time(), "day": today, "count": sent + (0 if ok is False else 1)})


    BATTERY_SENT = {"done": False}

    def battery_watch():
        while True:
            time.sleep(30)
            try:
                import psutil
                b = psutil.sensors_battery()
            except Exception:
                continue
            if not b or b.percent is None:
                continue
            pct = float(b.percent)
            if pct > 10:
                BATTERY_SENT["done"] = False
                continue
            if pct <= LOW_BATTERY_PCT and not BATTERY_SENT["done"]:
                BATTERY_SENT["done"] = True
                log("电量低（%.0f%%），给最近 3 个会话发晚安" % pct)
                try:
                    for u, name in recent_chats(limit=3, within=86400):
                        send_text(GOODNIGHT_TEXT, name, u, force=True)
                        time.sleep(0.4)
                except Exception as e:
                    log("发晚安失败：", repr(e))

    def notify_back():
        for u, name in list(NOTIFIED):
            send_text("我回来啦，刚在打游戏", name, u, force=True)
            time.sleep(0.3)
        NOTIFIED.clear()

    def game_watch():
        while True:
            time.sleep(4)
            running = game_running()
            if running and not AWAY["on"]:
                AWAY["on"] = True
                log("检测到游戏运行，进入休息模式（回复先排队）")
                if AWAY_NOTICE and not game_running():
                    try:
                        notify_away()
                    except Exception as e:
                        log("休息通知失败：", repr(e))
            elif not running and AWAY["on"]:
                AWAY["on"] = False
                log("游戏已退出，补发排队消息")
                with pending_lock:
                    items = list(pending_replies.values())
                    pending_replies.clear()
                now = time.time()
                fresh = [x for x in items if now - x[3] <= QUEUED_MAX_AGE]
                dropped = len(items) - len(fresh)
                fresh = fresh[-QUEUED_MAX_CHATS:]
                if dropped:
                    log("排队里有 %d 条已经太旧（>%ds），不补发" % (dropped, int(QUEUED_MAX_AGE)))
                for text, target, uname, _ts in fresh:
                    send_text(text, target, uname, force=True)
                if RETURN_NOTICE:
                    try:
                        notify_back()
                    except Exception as e:
                        log("回来通知失败：", repr(e))

    def digest_watch():
        last = time.time()
        while True:
            time.sleep(30)
            if DIGEST_MINUTES <= 0 or not MASTER_WXID:
                continue
            if time.time() - last < DIGEST_MINUTES * 60:
                continue
            if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
                continue
            try:
                base = bot_url.rsplit("/webhook", 1)[0]
                r = LOCAL_HTTP.get(base + "/api/digest", params={"since": int(last * 1000)}, timeout=30)
                data = r.json()
            except Exception as e:
                log("拉取消息汇总失败：", repr(e))
                continue
            if data.get("count") and data.get("text"):
                name = display_name(MASTER_WXID) or "主人"
                log("给主人发消息汇总：%d 条" % data["count"])
                if send_text(data["text"], name, MASTER_WXID, force=True):
                    last = time.time()
            else:
                last = time.time()

    def explain_uia_failure():
        """UIA 拿不到时把原因说清楚。

        「热激活 UIA 失败」有三种完全不同的原因，光看那一句没法修：
          A. 主窗所在进程里枚举不到 Weixin.dll（挑到子进程 / 权限 / 微信刚重启）
          B. 这个微信版本库还不支持（特征扫描没命中、版本表里也没有）
          C. 补丁写进去了但 mmui 控件没出现（校验失败，已回滚）
        """
        try:
            import win32process
            from wechatauto.accessibility import AccessibilityGate, QACCESSIBLE_ACTIVE_RVA_BY_VERSION
        except Exception as e:
            log("UIA 诊断不可用：", repr(e))
            return
        hwnd = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
        if not hwnd:
            log("UIA 诊断：找不到标题为「微信」的主窗（微信缩在托盘？先点开它）")
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            mods = list(AccessibilityGate._process_modules(pid) or [])
        except Exception as e:
            log("UIA 诊断：枚举模块失败：", repr(e))
            return
        dll = None
        for _b, _s, name, path in mods:
            if (name or "").lower() == "weixin.dll":
                dll = path
                break
        if not dll:
            log("UIA 诊断（原因A）：主窗进程 pid=%s 里只有 %d 个模块，枚举不到 Weixin.dll" % (pid, len(mods)))
            log("    → 多见于：微信刚重启、主窗属于子进程、或与微信权限不一致")
            return
        ver = os.path.basename(os.path.dirname(dll))
        try:
            cands = AccessibilityGate._qaccessible_candidate_rvas(dll)
        except Exception as e:
            log("UIA 诊断：取候选 RVA 失败：", repr(e))
            return
        known = QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(ver)
        if not cands:
            log("UIA 诊断（原因B）：微信 %s 没有任何可用 gate RVA，这个版本库还不支持" % ver)
            log("    → 升级 wechatauto-replica，或换回 4.1.13.65 / 4.1.15.53")
        else:
            log("UIA 诊断（原因C）：微信 %s，候选 RVA %d 个（%s），补丁写了但 mmui 没出现" % (
                ver, len(cands),
                "版本表命中" if known is not None else "靠特征扫描",
            ))
            log("    → 重启微信后立刻重试；仍失败说明该版本的保护变了，等库更新")

    def warmup():
        """启动后预热发送通道，避免第一条回复慢 5~10 秒。"""
        time.sleep(3)
        if game_running():
            log("游戏在运行，跳过发送通道预热")
            return
        try:
            nonlocal gui
            with gui_lock:
                if gui is None:
                    gui = WeChatGUI()
            u = gui._get_uia()
            UIA_CACHE["u"] = u
            if u is None:
                log("发送通道预热：UIA 不可用（只剩 OCR 兜底，先跑「一键修复并自检.bat」）")
                explain_uia_failure()
            else:
                win = getattr(u, "_win", None)
                try:
                    wcls = win.ClassName if win is not None else None
                    wname = win.Name if win is not None else None
                except Exception:                # noqa: BLE001
                    wcls, wname = None, None
                log("发送通道预热完成（UIA 可用，主窗类名=%r 名称=%r）" % (wcls, wname))
                # 认账号窗口要放在 UIA 起来之后：ensure_window 会热激活 gate 字节，
                # 窗口树物化了才读得到会话行，才分得清哪个窗口是哪个号。
                try:
                    if pick_account_window(quiet=True):
                        if ACCOUNT.get("hwnd"):
                            rebind_uia(ACCOUNT["hwnd"], u)
                        log("账号窗口已确认：hwnd=%s（%s）"
                            % (ACCOUNT.get("hwnd"), ACCOUNT.get("why") or ""))
                    else:
                        log("⚠️ 账号窗口没确认（%s）：发送会先被拦下来，直到能认出来"
                            % (ACCOUNT.get("why") or "未知"))
                except Exception as e:            # noqa: BLE001
                    log("账号窗口识别失败：", repr(e))
        except Exception as e:
            log("发送通道预热失败：", repr(e))

    def send_watchdog():
        """发送卡住超过 40 秒就重启桥接，避免整个队列卡死。"""
        while True:
            time.sleep(5)
            if SEND_STATE["active"] and (time.time() - SEND_STATE["start"]) > 40:
                log("发送卡住超过 40 秒，强制重启桥接进程…")
                time.sleep(0.3)
                # 用 7 而不是 2：2 是「找不到数据库目录」这种优雅报错（不该被守护循环
                # 无限重启），7 才是「我自己要重启」—— 启动脚本看到 7 就连着重启。
                os._exit(7)

    def flush_pending():
        while True:
            time.sleep(2)
            if AWAY["on"] or away_active() or foreground_is_fullscreen():
                continue
            with pending_lock:
                if not pending_replies:
                    continue
                items = list(pending_replies.values())
                pending_replies.clear()
            now = time.time()
            fresh = [x for x in items if now - x[3] <= QUEUED_MAX_AGE][-QUEUED_MAX_CHATS:]
            for text, target, uname, _ts in fresh:
                log("补发排队消息 →", target)
                send_text(text, target, uname, force=True)

    def listener_alive():
        """收消息的轮询线程是否还活着。"""
        try:
            th = getattr(listener, "_thread", None)
            return bool(th is not None and th.is_alive())
        except Exception:
            return False

    def listener_watch():
        """轮询线程死了就把它拉起来。

        症状：桥接进程还在（心跳正常）、微信里发消息也进来了，但一条都不回复 ——
        因为读数据库的那个线程悄悄退出了。以前只能重启桥接。
        """
        misses = 0
        while True:
            time.sleep(15)
            if listener_alive():
                misses = 0
                continue
            misses += 1
            if misses < 2:
                continue
            log("[!] 收消息线程已经不在了，自动重启监听…")
            try:
                listener.start()
                if listener_alive():
                    log("监听已重启，继续收消息")
                else:
                    log("监听重启后仍未启动，建议重启桥接")
            except Exception as e:                 # noqa: BLE001
                log("监听重启失败：", repr(e))
            misses = 0

    def bridge_heartbeat():
        """每 20 秒告诉服务端「桥接还活着、UIA/ffmpeg 状态如何」。

        没有心跳时，服务端只知道「它收到了消息」，不知道回复到底有没有能力发出去；
        网页上也就没法提示「桥接离线」或「UIA 不可用」。
        """
        import shutil as _shutil

        nonlocal gui
        base = bot_url.rsplit("/webhook", 1)[0]
        misses = 0
        gate_logged = False
        while True:
            try:
                # 游戏在跑时桥接会跳过预热、进休息模式，这时 UIA 还没初始化，
                # 不能当成「UIA 坏了」上报 —— 不然网页会误报「消息发不出去」。
                resting = bool(game_running())
                # 不用等消息才去唤醒引擎：心跳每 20 秒问一次（库内部 30 秒节流、
                # 会自动重新热激活），这样状态是真实的，也能顺手把假死的引擎救回来。
                uia_now = None
                if not resting:
                    try:
                        if not wechat_window_alive():
                            # 微信主窗没了（进程更新/重启/被回收）。缓存引擎里那个窗口
                            # 句柄已失效，再调 UIA 可能直接 0xC0000005，Python 拦不住。
                            # 先把手里的引擎丢掉，等窗口回来再重建，别去碰它。
                            with gui_lock:
                                gui = None
                                UIA_CACHE["u"] = None
                            misses = 0
                            uia_now = False
                            if not gate_logged:
                                log("[!] 微信主窗当前不存在（可能缩进托盘/被回收/自更新），已收起 UIA 引擎，等窗口回来再预热")
                                gate_logged = True
                        else:
                            with gui_lock:
                                _u = gui._get_uia() if gui is not None else None
                            if _u is None:
                                # 连续拿不到就重建窗口驱动。
                                # 实测（3.3.2）：桥接启动那一刻微信正好在托盘里（主窗隐藏）时，
                                # gui 会一直定位不到主窗；之后即使把微信拉出来也不会自愈，
                                # 心跳永远报 uia:false。重建一次就好了。
                                misses += 1
                                if misses >= 3:
                                    log("[!] UIA 连续 %d 次拿不到，重建窗口驱动再试…" % misses)
                                    with gui_lock:
                                        gui = WeChatGUI()
                                        _u = gui._get_uia()
                                    if _u is not None:
                                        misses = 0
                            else:
                                misses = 0
                                gate_logged = False
                            UIA_CACHE["u"] = _u
                            uia_now = _u is not None
                    except Exception:
                        uia_now = UIA_CACHE.get("u") is not None
                payload = {
                    "platform": "wechat",
                    "uia": uia_now,
                    "rest": resting,
                    # 收消息线程还活着吗：死了就是「能心跳、但一条消息都不进来」
                    "listener": listener_alive(),
                    "ffmpeg": bool(_shutil.which("ffmpeg")),
                    # 多账号：网页要显示「桥接现在到底在用哪个号、窗口确认了没有」
                    "account": db.account,
                    "account_wxid": db.wxid,
                    "account_nick": _self_nick,
                    "account_ok": bool(ACCOUNT.get("verified")),
                    "account_why": str(ACCOUNT.get("why") or ""),
                    "account_guard": bool(ACCOUNT_GUARD),
                }
                headers = {"x-whale-bridge": "1"}
                if token:
                    headers["x-bot-token"] = token
                LOCAL_HTTP.post(base + "/api/bridge/heartbeat", json=payload, headers=headers, timeout=8)
            except Exception:
                pass  # 服务没起来/重启中，下一轮再报
            time.sleep(20)

    def config_watch():
        """盯 config.json 的修改时间：调试台一保存就热更新，不用重启桥接。

        以前这些开关只在启动时读一次，用户在 /debug 里关掉「主动分享」、
        改「忽略名单」、「游戏白名单」都没反应，只能重启桥接 —— 也就是
        「调了没用，还是默认」。
        """
        last = 0.0
        try:
            last = os.path.getmtime(CONFIG_PATH)
        except Exception:
            last = 0.0
        while True:
            time.sleep(5)
            try:
                mt = os.path.getmtime(CONFIG_PATH)
            except Exception:
                continue
            if mt <= last:
                continue
            last = mt
            if reload_config():
                log("配置已热更新（调试台改完即时生效，不用重启桥接）")

    try:
        _cleanup_wechat_file_outbox()
        _cleanup_wechat_files_dir()
    except Exception:
        pass

    def file_cleanup_loop():
        while True:
            time.sleep(6 * 3600)
            try:
                _cleanup_wechat_file_outbox()
                _cleanup_wechat_files_dir()
            except Exception as e:
                log("文件缓存定时清理失败：", repr(e))

    # ===== UIA 单线程执行器 =====
    # uiautomation/comtypes 的 COM 对象有线程套间亲和性；桥接之前从多个线程直接碰
    # 同一个 UIA 引擎，空闲时会在原生层 access violation。这里把暖机、发送文本、
    # 发文件、@ 成员、发表情包全部投递到同一个专用线程执行，其他线程只排队。
    _uia_q = queue.Queue()
    _uia_done_marker = object()

    def _uia_thread_main():
        try:
            import comtypes
            try:
                comtypes.CoInitializeEx(comtypes.COINIT_APARTMENTTHREADED)
            except Exception:
                pass
            try:
                _uiautomation.InitializeUIAutomationInCurrentThread()
            except Exception:
                pass
            log("UIA 专用线程已启动（单线程执行所有 UIA 操作）")
        except Exception as e:                  # noqa: BLE001
            log("UIA 专用线程初始化失败：", repr(e))
        while True:
            item = _uia_q.get()
            if item is None:
                break
            fn, args, kwargs, box, ev = item
            try:
                box["r"] = fn(*args, **kwargs)
            except BaseException as e:          # noqa: BLE001
                box["e"] = e
            finally:
                ev.set()

    _uia_thread = threading.Thread(target=_uia_thread_main, name="whale-uia", daemon=True)
    _uia_thread.start()

    def uia_call(fn, *args, **kwargs):
        """在 UIA 专用线程执行；如果已经在 UIA 线程则直接调用，避免自锁。"""
        if threading.current_thread() is _uia_thread:
            return fn(*args, **kwargs)
        box = {}
        ev = threading.Event()
        _uia_q.put((fn, args, kwargs, box, ev))
        # 队列里的操作如果卡死，也要让 send_watchdog 看到；否则它只看到
        # 队列等待，不会触发重启。
        SEND_STATE["active"] = True
        SEND_STATE["start"] = time.time()
        try:
            if not ev.wait(900):
                raise TimeoutError("UIA 操作排队超过 900 秒")
        finally:
            SEND_STATE["active"] = False
        if "e" in box:
            raise box["e"]
        return box.get("r")

    # 私聊发送优先走纯 Win32（B 方案）：不 import/不调用 UIA，避免最小化时 COM 卡死。
    # 群聊/@/引用回复暂时保留 UIA 路径。
    _WIN32_SENDER = {"obj": None}

    def _win32_sender():
        if _WIN32_SENDER["obj"] is None:
            _WIN32_SENDER["obj"] = Win32Sender(hwnd=int(ACCOUNT.get("hwnd") or 0), db=db)
        return _WIN32_SENDER["obj"]

    def _strip_bubble_period(text):
        """微信气泡末尾不加中文句号；感叹号/问号/省略号等保留。"""
        s = str(text if text is not None else "")
        s = s.rstrip()
        if s.endswith("。"):
            s = s[:-1].rstrip()
        return s

    def _win32_target(args, kwargs):
        text = args[0] if len(args) > 0 else kwargs.get("text", "")
        display = args[1] if len(args) > 1 else kwargs.get("chat_display_name", "")
        username = args[2] if len(args) > 2 else kwargs.get("chat_username", "")
        return text, display, username

    # 这些入口的所有 UIA 调用都改到专用线程
    _orig_send_text = send_text
    def send_text(*args, **kwargs):
        _text0, _display0, _username0 = _win32_target(args, kwargs)
        _stripped = _strip_bubble_period(_text0)
        if _stripped != _text0:
            if len(args) > 0:
                args = (_stripped,) + tuple(args[1:])
            else:
                kwargs = dict(kwargs)
                kwargs["text"] = _stripped
        text, display, username = _win32_target(args, kwargs)
        # 群聊、引用回复、@ 仍走 UIA
        quote_text = kwargs.get("quote_text")
        if len(args) > 4:
            quote_text = args[4]
        if username and not quote_text:
            try:
                r = _win32_sender().send_text(display, username, text, verify=True)
                if r.get("ok"):
                    log("Win32 发送成功（%s）→ %s" % (r.get("message"), display))
                    return True
                log("Win32 发送失败：", r.get("message"), "→", display)
                return False
            except Exception as e:                 # noqa: BLE001
                log("Win32 发送异常：", repr(e), "→", display)
                return False
        return uia_call(_orig_send_text, *args, **kwargs)

    _orig_send_file_wechat = send_file_wechat
    def send_file_wechat(*args, **kwargs):
        path = args[0] if len(args) > 0 else kwargs.get("path", "")
        display = args[1] if len(args) > 1 else kwargs.get("chat_display_name", "")
        username = args[2] if len(args) > 2 else kwargs.get("chat_username", "")
        if username:
            try:
                r = _win32_sender().send_file(display, username, path, verify=True)
                if r.get("ok"):
                    log("Win32 文件发送成功（%s）→ %s" % (r.get("message"), display))
                    return r
                log("Win32 文件发送失败：", r.get("message"), "→", display)
                return r
            except Exception as e:                 # noqa: BLE001
                log("Win32 文件发送异常：", repr(e), "→", display)
                return {"ok": False, "message": repr(e)}
        return uia_call(_orig_send_file_wechat, *args, **kwargs)

    _orig_send_at = send_at
    def send_at(*args, **kwargs):
        member = args[0] if len(args) > 0 else kwargs.get("member", "")
        body = args[1] if len(args) > 1 else kwargs.get("text", "")
        display = args[2] if len(args) > 2 else kwargs.get("chat_display_name", "")
        username = args[3] if len(args) > 3 else kwargs.get("chat_username", "")
        if username and str(username).endswith("@chatroom"):
            try:
                r = _win32_sender().send_text(display, username, "@%s %s" % (member, body), verify=True)
                if r.get("ok"):
                    log("Win32 群 @ 发送成功（%s）→ %s" % (r.get("message"), display))
                    return True
                log("Win32 群 @ 失败：", r.get("message"))
                return False
            except Exception as e:
                log("Win32 群 @ 异常：", repr(e))
                return False
        return uia_call(_orig_send_at, *args, **kwargs)

    _orig_send_sticker = send_sticker
    def send_sticker(*args, **kwargs):
        return uia_call(_orig_send_sticker, *args, **kwargs)

    _orig_warmup = warmup
    def warmup(*args, **kwargs):
        return uia_call(_orig_warmup, *args, **kwargs)

    # ===== B站视频理解（链接 → 九宫格/分段帧 → DSH → 微信）=====
    _BILI_WATCH_EXECUTOR = ThreadPoolExecutor(max_workers=1)
    _BILI_WATCH_INFLIGHT = set()
    _BILI_WATCH_LOCK = threading.Lock()

    def _plugin_api_port():
        try:
            p = os.path.join(os.path.expanduser("~"), ".dsh", "whale-bridge", "settings.json")
            with open(p, "r", encoding="utf-8") as f:
                return int((json.load(f) or {}).get("port") or 8789)
        except Exception:
            return 8789

    def _split_bili_bubbles(text, max_bubbles=4, max_chars=300):
        """优先按段落切；没有段落再按句子，最多 max_bubbles 条，不切断句子。"""
        text = str(text or "").strip()
        if not text:
            return []
        if len(text) <= max_chars:
            return [text]
        # 1) 优先按空行/段落切
        paras = [x.strip() for x in re.split(r"\n{2,}", text) if x.strip()]
        if 2 <= len(paras) <= max_bubbles:
            return paras
        # 2) 按句子切，尽量保持句子完整
        parts = [x.strip() for x in re.split(r"(?<=[。！？!?；;\n])", text) if x.strip()]
        if not parts:
            parts = [text]
        target = max(max_chars // 2, (len(text) + max_bubbles - 1) // max_bubbles)
        out, cur = [], ""
        for part in parts:
            if cur and len(cur) + len(part) > target and len(out) < max_bubbles - 1:
                out.append(cur)
                cur = part
            else:
                cur = (cur + part).strip() if cur else part
        if cur:
            out.append(cur)
        if len(out) > max_bubbles:
            out = out[:max_bubbles - 1] + ["".join(out[max_bubbles - 1:])]
        return [x for x in out if x]

    def _send_bili_text(text, target, username):
        """B站长总结分段发，避免单条过长/被截断。"""
        text = str(text or "").strip()
        if not text:
            return
        chunk = 900
        for i in range(0, len(text), chunk):
            part = text[i:i + chunk].strip()
            if part:
                send_text(part, target, username)

    def _bili_watch_worker(bvid, target, username, request_text=""):
        key = str(bvid) + "|" + str(username)
        with _BILI_WATCH_LOCK:
            if key in _BILI_WATCH_INFLIGHT:
                return
            _BILI_WATCH_INFLIGHT.add(key)
        try:
            log("B站视频：开始处理", bvid)
            try:
                send_text("我看看这个视频，稍等。", target, username)
            except Exception:
                pass
            workdir = os.path.join(dsh_bridge_workspace(), "scratch", "bili-watch",
                                   "%s-%s" % (bvid, time.strftime("%H%M%S")))
            mat = _bili_watch.build(bvid, workdir=workdir, max_segments=4)
            prompt = _bili_watch.build_prompt(mat, request_text)
            port = _plugin_api_port()
            url = "http://127.0.0.1:%d/api/task/stream" % port
            log("B站视频：%s %s，%d 张图，交给 DSH（流式）" % (mat.title, mat.quality, len(mat.sheets)))
            r = _requests.post(url, json={"prompt": prompt, "timeoutMs": 300000},
                               stream=True, timeout=(10, 320))
            segments = []      # 已经实时发出去的段
            sent_raw = ""
            final_text = ""
            held = ""          # 先压住最后一段，等 done/去重后再决定怎么切
            for line in r.iter_lines(decode_unicode=True):
                if not line:
                    continue
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                try:
                    obj = json.loads(line[5:].strip())
                except Exception:
                    continue
                etype = str(obj.get("type") or "")
                if etype == "text":
                    cur = str(obj.get("text") or "")
                    if not cur:
                        continue
                    if cur.startswith(sent_raw):
                        delta = cur[len(sent_raw):]
                        sent_raw = cur
                    elif sent_raw and sent_raw.startswith(cur):
                        continue
                    else:
                        delta = cur
                        sent_raw = cur
                    delta = delta.strip()
                    if delta:
                        # 前一段先实时发，最后一段压住等最终去重
                        if held:
                            segments.append(held)
                            _send_bili_text(held, target, username)
                            log("B站视频：实时发送段 %d 字" % len(held))
                        held = delta
                        log("B站视频：暂存最后一段 %d 字" % len(held))
                elif etype == "done":
                    res = obj.get("result") or {}
                    final_text = str(res.get("text") or "").strip()
                    if not res.get("ok") and not final_text:
                        log("B站视频：DSH 流式任务失败", res.get("error"))
            try:
                r.close()
            except Exception:
                pass

            # 最后一段 + 最终结果里尚未发送的尾巴，去重后统一切成最多 4 段
            pending = held
            rest = final_text
            for seg in segments:
                if seg and seg in rest:
                    rest = rest.replace(seg, "", 1)
            if pending and pending in rest:
                rest = rest.replace(pending, "", 1)
            rest = rest.strip()
            if rest:
                pending = (pending + rest) if pending else rest
            if not pending:
                pending = _bili_watch.format_fallback(mat, "DSH 没有返回有效总结")
            bubbles = _split_bili_bubbles(pending, max_bubbles=6, max_chars=300)
            log("B站视频：最后 text %d 字，去重后切 %d 段发送" % (len(pending), len(bubbles)))
            for idx, bubble in enumerate(bubbles):
                if idx:
                    time.sleep(0.4)
                _send_bili_text(bubble, target, username)
        except Exception as e:                 # noqa: BLE001
            log("B站视频处理失败：", repr(e))
            try:
                send_text("视频没看成：%s" % str(e)[:100], target, username)
            except Exception:
                pass
        finally:
            with _BILI_WATCH_LOCK:
                _BILI_WATCH_INFLIGHT.discard(key)

    threading.Thread(target=file_cleanup_loop, daemon=True).start()
    threading.Thread(target=flush_pending, daemon=True).start()
    threading.Thread(target=config_watch, daemon=True).start()
    threading.Thread(target=game_watch, daemon=True).start()
    threading.Thread(target=digest_watch, daemon=True).start()
    threading.Thread(target=warmup, daemon=True).start()
    threading.Thread(target=send_watchdog, daemon=True).start()
    threading.Thread(target=battery_watch, daemon=True).start()
    threading.Thread(target=share_watch, daemon=True).start()
    threading.Thread(target=care_watch, daemon=True).start()
    threading.Thread(target=bridge_heartbeat, daemon=True).start()
    threading.Thread(target=listener_watch, daemon=True).start()
    log("已启动。鲸鲸地址：", bot_url)

    # 就绪标记：外部（守护脚本 / 自检）据此判断「进程在，但可能卡在初始化」
    try:
        import json as _json, datetime as _dt
        import shutil as _shutil2
        _startup["done"] = True
        with open(os.path.join(ROOT, "data", "bridge-ready.json"), "w", encoding="utf-8") as _rf:
            _json.dump({
                "readyAt": _dt.datetime.now().isoformat(timespec="seconds"),
                "pid": os.getpid(),
                "botUrl": bot_url,
                "ffmpeg": bool(_shutil2.which("ffmpeg")),
            }, _rf, ensure_ascii=False)
    except Exception:
        pass

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("正在退出…")
        listener.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
