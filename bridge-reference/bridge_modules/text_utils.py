# -*- coding: utf-8 -*-
"""纯文本 / 文件名 / 大小 / URL 工具（从 examples/wechatauto_bridge.py 抽出）。

这些函数原来散落在桥接 main() 闭包里或文件功能区，行为和注释保持原样。
约束：只 import 标准库；不许 import uiautomation / wechatauto / gui / 桥接全局变量。
"""
import html
import os
import re

# 桥接出站文件下载链接：http://127.0.0.1:<port>/files/<32位hex>/<文件名>
FILE_URL_RE = re.compile(r"https?://127\.0\.0\.1:\d+/files/[a-f0-9]{32}/[^\s\"'<>）)】]+")
# URL 在自然语言里后面常跟的标点/括号：收集链接时要去掉
FILE_URL_TRAIL = ".,;:!?，。；：！？、）)】"

_CDATA_RE = re.compile(r"<!\[CDATA\[(.*?)\]\]>", re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")
_TITLE_RE = re.compile(r"<title>(.*?)</title>", re.S)
_TOTALLEN_RE = re.compile(r"<totallen>(\d+)</totallen>")
_FILEEXT_RE = re.compile(r"<fileext>(.*?)</fileext>", re.S)
_EXT_TOKEN_RE = re.compile(r"[a-z0-9]{1,12}")
_WECHAT_DUP_SUFFIX_RE = re.compile(r"\s*\(\d+\)$")
_PAPERCLIP_LINE_RE = re.compile(r"(?m)^[ \t]*📎[^\n]*(?:\n|$)")
_TRAILING_SPACE_RE = re.compile(r"[ \t]+\n")
_MANY_NEWLINES_RE = re.compile(r"\n{3,}")
_UNSAFE_FILENAME_RE = re.compile(r"[\x00-\x1f<>:\"/\\|?*]+")


def safe_filename(name, default="wechat-file"):
    """把任意名字变成安全的单层文件名（去路径/控制字符/首尾点，最长 120）。"""
    base = os.path.basename(str(name or "").replace("\\", "/"))
    base = _UNSAFE_FILENAME_RE.sub("_", base).strip().strip(".")
    return (base or default)[:120]


def format_size_kb(size):
    """字节数 → "12.3 KB" / "4.5 MB"（原桥接 _fmt_kb，逻辑不变）。"""
    try:
        n = float(size)
    except (TypeError, ValueError):
        n = 0.0
    if n >= 1024 * 1024:
        return "%.1f MB" % (n / 1024 / 1024)
    return "%.1f KB" % (n / 1024)


def clean_xml_text(value):
    """剥掉微信 XML 字段里的 CDATA / 标签并反转义。"""
    v = _CDATA_RE.sub(r"\1", str(value or ""))
    v = _TAG_RE.sub("", v)
    return html.unescape(v).strip()


def parse_file_meta(raw):
    """从微信「文件/链接/卡片」消息 XML 里取 (title, totallen, fileext)。

    fileext 只接受干净的 [a-z0-9]{1,12} token，防止 CDATA/标签残渣导致缓存匹配失败。
    """
    title = ""
    m = _TITLE_RE.search(raw)
    if m:
        title = clean_xml_text(m.group(1))[:120]
    m2 = _TOTALLEN_RE.search(raw)
    total = int(m2.group(1)) if m2 else 0
    m3 = _FILEEXT_RE.search(raw)
    ext = clean_xml_text(m3.group(1)).lower() if m3 else ""
    if not _EXT_TOKEN_RE.fullmatch(ext or ""):
        ext = ""
    return title, total, ext


def strip_wechat_dup_suffix(name):
    """去掉微信重名后缀："名字(1)(2).flac" → "名字.flac"（循环，最多 8 次）。"""
    base, ext = os.path.splitext(str(name or ""))
    guard = 0
    while _WECHAT_DUP_SUFFIX_RE.search(base) and guard < 8:
        base = _WECHAT_DUP_SUFFIX_RE.sub("", base)
        guard += 1
    return (base + ext).strip()


def collect_file_urls(reply_text, bubbles=None):
    """按出现顺序收集回复里的下载链接（正文在前、bubbles 在后，去重）。"""
    urls = []
    for chunk in [reply_text or ""] + list(bubbles or []):
        for m in FILE_URL_RE.finditer(chunk or ""):
            u = m.group(0).rstrip(FILE_URL_TRAIL)
            if u and u not in urls:
                urls.append(u)
    return urls


def strip_file_links(chunk, drop_urls):
    """文件已发成微信文件消息后：删掉链接本身和残留的「📎 文件名（大小）」行。"""
    out = chunk or ""
    for url in drop_urls or ():
        out = out.replace(url, "")
    out = _PAPERCLIP_LINE_RE.sub("", out)
    out = _TRAILING_SPACE_RE.sub("\n", out)
    out = _MANY_NEWLINES_RE.sub("\n\n", out)
    return out.strip()
