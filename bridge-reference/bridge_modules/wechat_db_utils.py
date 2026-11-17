# -*- coding: utf-8 -*-
"""微信 4.x 数据目录 / 账号名工具（从 examples/wechatauto_bridge.py 抽出）。

只依赖标准库；只有 resolve_account_dir 匹配昵称时才延迟 import wechatauto，
与原来行为一致。不依赖桥接运行时全局变量（CONFIG_PATH/ROOT/log 等留在主文件）。
"""
import os
import re

# 微信 4.x 数据目录的常见名字（不同版本 / 不同安装方式会有差异）
DB_ROOT_NAMES = ("xwechat_files", "WeChat Files", "xwechat_files_data")


def looks_like_db_root(p):
    """这个目录像不像微信 4.x 的数据根（下面有 <账号>/db_storage）。

    兼容四种布局：
      E:\\xwechat_files\\<账号>\\db_storage
      E:\\xwechat_files\\db_storage            （账号目录层级被拍平）
      直接把 <账号> 目录填进来（p\\db_storage）
      直接把 db_storage 目录填进来
    """
    if not p or not os.path.isdir(p):
        return False
    # 直填账号目录 / 直填 db_storage
    if os.path.isdir(os.path.join(p, "db_storage")):
        return True
    if os.path.basename(os.path.normpath(p)).lower() == "db_storage":
        return True
    bases = [p]
    for name in DB_ROOT_NAMES:
        bases.append(os.path.join(p, name))
    for base in bases:
        try:
            entries = os.listdir(base)
        except OSError:
            continue
        for name in entries:
            if os.path.isdir(os.path.join(base, name, "db_storage")):
                return True
    return False


def iter_drive_roots():
    """列出真实的磁盘根（含 L:、网络映射盘、UNC），不再写死 C..K。"""
    roots = []
    try:
        import string
        for letter in string.ascii_uppercase:
            root = letter + ":\\"
            if os.path.isdir(root):
                roots.append(root)
    except Exception:
        pass
    try:
        import psutil
        for part in psutil.disk_partitions(all=False):
            mp = str(part.mountpoint or "")
            if mp and mp not in roots and os.path.isdir(mp):
                roots.append(mp)
    except Exception:
        pass
    return roots


def find_account_dirs(db_dir):
    """列出 <db_dir> 下所有含 db_storage 的账号目录名。

    不能按 wxid_ 前缀判断：设了自定义微信号的账号目录名不一定以 wxid_ 开头。
    """
    out = []
    try:
        for name in os.listdir(db_dir):
            if os.path.isdir(os.path.join(db_dir, name, "db_storage")):
                out.append(name)
    except OSError:
        return []
    return sorted(out)


def account_wxid(account):
    """账号目录名去掉末尾 4 位哈希 = wxid（和 wechatauto 的 WeChatDB.wxid 同一套规则）。"""
    return re.sub(r"_\w{4}$", "", str(account or ""))


def resolve_account_dir(db_dir, wanted):
    """把配置/网页里的账号写法解析成真实账号目录名。

    依次尝试：完整目录名（wxid_xxx_cedb）→ 去掉 4 位哈希的 wxid（wxid_xxx）
    → 唯一前缀 → 昵称（要开库读 contact.db，慢，所以放最后）。
    返回目录名；匹配不到返回 ""。
    """
    wanted = str(wanted or "").strip()
    if not wanted or not db_dir:
        return ""
    names = find_account_dirs(db_dir)
    if not names:
        return ""
    if wanted in names:
        return wanted
    for n in names:
        if account_wxid(n) == wanted:
            return n
    hit = [n for n in names if n.lower().startswith(wanted.lower())]
    if len(hit) == 1:
        return hit[0]
    # 昵称匹配：只有前面都没命中才做（每个账号要开一次库，约 1 秒）
    try:
        from wechatauto import WeChatDB
    except Exception:
        return ""
    for n in names:
        try:
            probe = WeChatDB(db_dir=db_dir, account=n)
            if probe.account != n:
                continue                     # 库自己换号了，别用它的昵称
            info = probe.get_self_info() or {}
            nick = str(info.get("nick_name") or info.get("remark") or "").strip()
        except Exception:
            continue
        if nick and nick == wanted:
            return n
    return ""
