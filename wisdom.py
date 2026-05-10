#!/usr/bin/env python3
"""
Pearls of Wisdom — 浮动名言窗口，用于演讲、讨论前提醒自己引用佳句。

程序结构：
  - load_quotes / save_quotes：从 ~/.wisdom_pearls.json 读写名言列表；启动时合并项目内
    `.claude/requirment` 中的条目（按正文去重并写回）。
  - WisdomApp：置顶半透明主窗口，浏览、收藏、拖拽移动。
  - EditorWindow：管理窗口，增删改、搜索过滤、从 zenquotes.io 在线抓取。
"""

import json
import os
import random
import re
import threading
import tkinter as tk
from tkinter import messagebox
import urllib.error
import urllib.request

# 用户数据文件路径：保存在用户主目录下，首次运行若不存在则写入默认名言。
DATA_PATH = os.path.expanduser("~/.wisdom_pearls.json")

# 项目内名言来源：与 wisdom.py 同仓库的 `.claude/requirment`（启动时合并进列表）。
_REQUIREMENT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".claude")
REQUIREMENT_PATH = os.path.join(_REQUIREMENT_DIR, "requirment")

# 段落首行「书名或人名：」作为本条所属来源（长度上限避免把正文里的冒号误判为标题）。
_TITLE_LINE_RE = re.compile(
    r"^([\u4e00-\u9fffA-Za-z0-9《》·•\s\.\-]{1,50})[：:]\s*(.*)$"
)
# 段落末尾「……某某。」形式的署名（用于无冒号标题的短条）。
_AUTHOR_NAME_ONLY_RE = re.compile(r"^[\u4e00-\u9fff·•]{2,15}$")
# 段末英文署名行（如丘吉尔演说后的 —— Churchill）。
_FOOTER_EN_AUTHOR_RE = re.compile(r"^[—\-–]+\s*(.+?)\s*$")
_BOOK_TITLE_LINE_RE = re.compile(r"^《([^》]+)》\s*$")

# 内置默认名言（每条为 dict：正文、作者、标签列表、是否收藏）。
DEFAULT_QUOTES = [
    {
        "text": "成功的秘诀是立即开始。",
        "author": "马克·吐温",
        "tags": ["动力"],
        "favorite": False,
    },
    {
        "text": "存活下来的不是最强的，而是最能适应的。",
        "author": "查尔斯·达尔文",
        "tags": ["韧性"],
        "favorite": False,
    },
    {
        "text": "每一个困难中都蕴藏着机遇。",
        "author": "阿尔伯特·爱因斯坦",
        "tags": ["心态"],
        "favorite": False,
    },
    {
        "text": "若要开口，就说清楚；每个字都要字斟句酌，方可出口。",
        "author": "奥利弗·温德尔·霍姆斯",
        "tags": ["沟通"],
        "favorite": False,
    },
    {
        "text": "沟通的艺术是领导力的语言。",
        "author": "詹姆斯·休谟斯",
        "tags": ["领导力", "沟通"],
        "favorite": False,
    },
    {
        "text": "没有行动相伴的想法，永远只是一个脑细胞里的念头。",
        "author": "阿诺德·格拉索",
        "tags": ["行动"],
        "favorite": False,
    },
    {
        "text": "人们不在乎你懂多少，直到他们知道你有多在乎。",
        "author": "西奥多·罗斯福",
        "tags": ["同理心", "领导力"],
        "favorite": False,
    },
    {
        "text": "简单是最终的复杂。",
        "author": "列奥纳多·达·芬奇",
        "tags": ["智慧"],
        "favorite": False,
    },
]


def _quote_text_key(text):
    """用于去重的正文规范化键。"""
    return " ".join((text or "").strip().split())


def _split_paragraphs(raw):
    """按空行分段（与 requirment 编辑习惯一致）。"""
    parts = re.split(r"\n\s*\n", raw)
    return [p.strip() for p in parts if p.strip()]


def _maybe_trailing_author(text):
    """若整段以「……一句正文。作者。」收尾（作者为纯中文短名），拆分出作者。"""
    t = text.strip()
    if not t.endswith("。"):
        return text, None
    core = t[:-1]
    dot = core.rfind("。")
    if dot == -1:
        return text, None
    body = core[: dot + 1].strip()
    author = core[dot + 1 :].strip()
    if len(body) < 4 or len(author) < 2 or len(author) > 15:
        return text, None
    if not _AUTHOR_NAME_ONLY_RE.match(author):
        return text, None
    return body, author


def _strip_footer_authors(body_lines):
    """若末行为「—— 名」或「-名」，则去掉该行并返回 (新正文行列表, 姓名或 None)。"""
    if len(body_lines) < 2:
        return body_lines, None
    last = body_lines[-1].strip()
    fm = _FOOTER_EN_AUTHOR_RE.match(last)
    if fm:
        name = fm.group(1).strip()
        if name and len(name) <= 80:
            return body_lines[:-1], name
    dm = re.match(r"^[-–—]\s*(.+)$", last)
    if dm:
        name = dm.group(1).strip()
        if name and len(name) <= 80:
            return body_lines[:-1], name
    return body_lines, None


def parse_requirement_quotes(path):
    """
    将 `.claude/requirment` 拆成多条名言 dict。
    规则：空行分段；段首「标题：」或单独一行《书名》视为来源并继承到后续无标题段；
    无标题段末可带中文句号署名；末行「—— 英文名」单独解析为作者。
    """
    if not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError:
        return []

    quotes = []
    current_author = "摘录"

    for para in _split_paragraphs(raw):
        lines = [ln.rstrip() for ln in para.splitlines()]
        while lines and not lines[-1].strip():
            lines.pop()
        if not lines:
            continue

        first = lines[0].strip()
        title_hit = False
        author = current_author
        body_lines = []

        m = _TITLE_LINE_RE.match(first)
        if m:
            left, right = m.group(1).strip(), m.group(2).strip()
            if len(left) <= 50:
                title_hit = True
                author = left or "摘录"
                current_author = author
                if right:
                    body_lines.append(right)
                body_lines.extend(l.strip() for l in lines[1:] if l.strip())

        if not title_hit:
            bm = _BOOK_TITLE_LINE_RE.match(first)
            if bm and len(lines) > 1:
                title_hit = True
                author = bm.group(1).strip()
                current_author = author
                body_lines = [l.strip() for l in lines[1:] if l.strip()]

        if not title_hit:
            body_lines = [l.strip() for l in lines if l.strip()]

        body_lines, footer_author = _strip_footer_authors(body_lines)
        if footer_author:
            author = footer_author
            current_author = "摘录"

        text = "\n".join(body_lines).strip()
        if not text:
            continue

        if not footer_author and not title_hit:
            text2, trail_author = _maybe_trailing_author(text)
            if trail_author:
                text = text2
                author = trail_author
                current_author = "摘录"

        tag_author = author if author != "摘录" else "摘录"
        quotes.append(
            {
                "text": text,
                "author": author,
                "tags": ["requirment", tag_author],
                "favorite": False,
            }
        )

    return quotes


def merge_requirement_into(quotes):
    """把 requirment 文件中的条目合并进列表（按正文去重），有新条目时写回磁盘。"""
    extra = parse_requirement_quotes(REQUIREMENT_PATH)
    if not extra:
        return quotes
    keys = {_quote_text_key(q.get("text", "")) for q in quotes}
    added = False
    for q in extra:
        k = _quote_text_key(q["text"])
        if not k or k in keys:
            continue
        quotes.append(q)
        keys.add(k)
        added = True
    if added:
        save_quotes(quotes)
    return quotes


# ---------------------------------------------------------------------------
# 数据读写（JSON 持久化）
# ---------------------------------------------------------------------------

def load_quotes():
    """若存在有效 JSON 列表则加载；否则复制默认名言并保存后返回。"""
    if os.path.exists(DATA_PATH):
        try:
            with open(DATA_PATH) as f:
                data = json.load(f)
            # 必须是「非空列表」，否则视为损坏或空文件，走默认分支。
            if isinstance(data, list) and data:
                return merge_requirement_into(data)
        except (json.JSONDecodeError, IOError):
            # 解析失败或读失败：忽略，后面会用默认数据重建文件。
            pass
    quotes = list(DEFAULT_QUOTES)
    save_quotes(quotes)
    return merge_requirement_into(quotes)


def save_quotes(quotes):
    """将名言列表写入 JSON 文件（UTF-8，缩进便于人工编辑）。"""
    with open(DATA_PATH, "w") as f:
        json.dump(quotes, f, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# 主窗口：深色半透明浮层，始终置顶，可拖拽
# ---------------------------------------------------------------------------

class WisdomApp:
    # 深色主题配色（背景、前景、强调色、次要文字、按钮等）
    BG = "#16213e"
    FG = "#e0e0ff"
    ACCENT = "#7c7cff"
    DIM = "#8888aa"
    BTN_BG = "#2a2a5a"
    BTN_FG = "#e0e0ff"
    BTN_ACTIVE = "#5555cc"
    GOLD = "#ffd700"
    SEP = "#2d2d5a"

    def __init__(self):
        self.quotes = load_quotes()
        # current：在「当前可见列表」中的下标（见 _visible_quotes）。
        self.current = 0
        # fav_only：主界面是否只显示收藏（本文件中未提供切换 UI，默认 False，便于扩展）。
        self.fav_only = False

        self.root = tk.Tk()
        self.root.title("智慧明珠")
        self.root.configure(bg=self.BG)
        self.root.attributes("-topmost", True)   # 窗口始终在最前，方便边看边讲
        self.root.attributes("-alpha", 0.93)     # 半透明，不挡背后内容太多
        self.root.minsize(360, 180)

        # 初始放在屏幕右上角（宽 420、高 240，距右边缘约 30px，距顶 60px）
        sw = self.root.winfo_screenwidth()
        self.root.geometry(f"420x240+{sw - 450}+60")

        self._build_ui()
        self._bind_keys()
        self._show_quote()
        self.root.mainloop()

    # ------------------------------------------------------------------
    # 界面搭建
    # ------------------------------------------------------------------

    def _build_ui(self):
        # ── 顶栏：标题 + 透明度滑块 ─────────────────────────────────
        header = tk.Frame(self.root, bg=self.BG)
        header.pack(fill="x", padx=10, pady=(8, 2))

        title = tk.Label(
            header, text="✦ 智慧明珠",
            bg=self.BG, fg=self.ACCENT,
            font=("Helvetica Neue", 11, "bold"),
        )
        title.pack(side="left")

        # 右侧：不透明度（0.2～1.0），拖动即改 root 的 -alpha
        tk.Label(header, text="透明度", bg=self.BG, fg=self.DIM,
                 font=("Helvetica Neue", 9)).pack(side="right")
        self._opacity_var = tk.DoubleVar(value=0.93)
        tk.Scale(
            header, from_=0.2, to=1.0, resolution=0.05,
            variable=self._opacity_var, orient="horizontal",
            command=lambda v: self.root.attributes("-alpha", float(v)),
            bg=self.BG, fg=self.DIM, troughcolor=self.BTN_BG,
            highlightthickness=0, length=70, showvalue=False, bd=0,
        ).pack(side="right", padx=(0, 4))

        # 顶栏与标题可拖拽移动整个窗口（见 _drag_start / _drag_motion）
        for w in (header, title):
            w.bind("<ButtonPress-1>", self._drag_start)
            w.bind("<B1-Motion>", self._drag_motion)

        # ── 分隔线 ─────────────────────────────────────────────────
        tk.Frame(self.root, height=1, bg=self.SEP).pack(fill="x", padx=8)

        # ── 名言正文（只读 Text，禁用编辑以免误触；亦可拖拽）──────────
        self._quote_text = tk.Text(
            self.root, wrap="word",
            font=("Georgia", 14),
            bg=self.BG, fg=self.FG,
            relief="flat", bd=0,
            padx=14, pady=10,
            state="disabled",
            cursor="arrow",
            height=5,
        )
        self._quote_text.pack(fill="both", expand=True, padx=4)
        self._quote_text.bind("<ButtonPress-1>", self._drag_start)
        self._quote_text.bind("<B1-Motion>", self._drag_motion)

        # ── 作者 / 标签（右对齐）────────────────────────────────────
        meta = tk.Frame(self.root, bg=self.BG)
        meta.pack(fill="x", padx=16, pady=(0, 4))

        self._author_lbl = tk.Label(
            meta, text="", bg=self.BG, fg=self.GOLD,
            font=("Helvetica Neue", 11, "italic"), anchor="e",
        )
        self._author_lbl.pack(fill="x")

        self._tags_lbl = tk.Label(
            meta, text="", bg=self.BG, fg=self.ACCENT,
            font=("Helvetica Neue", 9), anchor="e",
        )
        self._tags_lbl.pack(fill="x")

        # ── Separator ───────────────────────────────────────────────
        tk.Frame(self.root, height=1, bg=self.SEP).pack(fill="x", padx=8)

        # ── 底栏：上一条、随机、下一条、计数、收藏、管理 ───────────
        ctrl = tk.Frame(self.root, bg=self.BG)
        ctrl.pack(fill="x", padx=8, pady=(4, 8))

        self._btn(ctrl, "←", self._prev).pack(side="left", padx=2)
        self._btn(ctrl, "↺", self._random).pack(side="left", padx=2)
        self._btn(ctrl, "→", self._next).pack(side="left", padx=2)

        self._counter_lbl = tk.Label(
            ctrl, text="", bg=self.BG, fg=self.DIM,
            font=("Helvetica Neue", 9),
        )
        self._counter_lbl.pack(side="left", padx=6)

        self._fav_btn = self._btn(ctrl, "☆", self._toggle_fav, width=2)
        self._fav_btn.pack(side="right", padx=2)
        self._btn(ctrl, "✎ 管理", self._open_editor).pack(side="right", padx=2)

    def _btn(self, parent, text, cmd, width=None):
        """统一样式的扁平按钮；可选 width 用于窄图标按钮（如收藏星）。"""
        kw = dict(
            text=text, command=cmd,
            bg=self.BTN_BG, fg=self.BTN_FG,
            activebackground=self.BTN_ACTIVE, activeforeground="#fff",
            relief="flat", padx=7, pady=3,
            font=("Helvetica Neue", 10), cursor="hand2", bd=0,
        )
        if width:
            kw["width"] = width
        return tk.Button(parent, **kw)

    # ------------------------------------------------------------------
    # 窗口拖拽：记录按下时鼠标在控件内的坐标，移动时用增量更新窗口位置
    # ------------------------------------------------------------------

    def _drag_start(self, e):
        self._dx = e.x
        self._dy = e.y

    def _drag_motion(self, e):
        # 当前窗口左上角 + 鼠标位移（相对按下点），只改 geometry 的 +x+y
        x = self.root.winfo_x() + e.x - self._dx
        y = self.root.winfo_y() + e.y - self._dy
        self.root.geometry(f"+{x}+{y}")

    # ------------------------------------------------------------------
    # 名言显示：根据「仅收藏」过滤，得到 (真实下标, 条目) 列表
    # ------------------------------------------------------------------

    def _visible_quotes(self):
        """返回 [(原始 quotes 中的索引, 字典), ...]，供导航与显示使用。"""
        if self.fav_only:
            return [(i, q) for i, q in enumerate(self.quotes) if q.get("favorite")]
        return list(enumerate(self.quotes))

    def _show_quote(self):
        """根据 self.current 在 visible 中取一条，刷新正文、作者、标签、计数、收藏按钮。"""
        visible = self._visible_quotes()
        if not visible:
            self._set_text("暂无名言。\n点击 ✎ 管理 来添加。")
            self._author_lbl.config(text="")
            self._tags_lbl.config(text="")
            self._counter_lbl.config(text="0 / 0")
            self._fav_btn.config(text="☆")
            return

        # 过滤后条数变少时，把 current 钳在合法范围内
        if self.current >= len(visible):
            self.current = len(visible) - 1
        _, q = visible[self.current]

        self._set_text(f'“{q["text"]}”')
        author = q.get("author", "").strip()
        self._author_lbl.config(text=f"— {author}" if author else "")
        tags = q.get("tags", [])
        self._tags_lbl.config(text="  ".join(f"#{t}" for t in tags) if tags else "")
        self._counter_lbl.config(text=f"{self.current + 1} / {len(visible)}")
        self._fav_btn.config(text="★" if q.get("favorite") else "☆",
                             fg=self.GOLD if q.get("favorite") else self.BTN_FG)

    def _set_text(self, text):
        """只读 Text 需先 normal 再写入，最后改回 disabled 防止用户编辑。"""
        self._quote_text.config(state="normal")
        self._quote_text.delete("1.0", "end")
        self._quote_text.insert("1.0", text)
        self._quote_text.config(state="disabled")

    # ------------------------------------------------------------------
    # 导航：在可见列表里循环；随机从 [0, n) 取一条
    # ------------------------------------------------------------------

    def _next(self):
        n = len(self._visible_quotes())
        if n:
            self.current = (self.current + 1) % n
            self._show_quote()

    def _prev(self):
        n = len(self._visible_quotes())
        if n:
            self.current = (self.current - 1) % n
            self._show_quote()

    def _random(self):
        n = len(self._visible_quotes())
        if n:
            self.current = random.randrange(n)
            self._show_quote()

    def _toggle_fav(self):
        """切换当前条在 app.quotes 中的 favorite 字段并立即写盘。"""
        visible = self._visible_quotes()
        if not visible:
            return
        real_idx, q = visible[self.current]
        q["favorite"] = not q.get("favorite", False)
        save_quotes(self.quotes)
        self._show_quote()

    # ------------------------------------------------------------------
    # 快捷键：方向键翻页、空格随机、f 收藏、Esc 最小化到 Dock
    # ------------------------------------------------------------------

    def _bind_keys(self):
        self.root.bind("<Right>", lambda _: self._next())
        self.root.bind("<Left>", lambda _: self._prev())
        self.root.bind("<space>", lambda _: self._random())
        self.root.bind("<Escape>", lambda _: self.root.iconify())
        self.root.bind("<f>", lambda _: self._toggle_fav())

    # ------------------------------------------------------------------
    # 管理窗口：模态编辑后刷新内存中的 quotes 并校正 current
    # ------------------------------------------------------------------

    def _open_editor(self):
        EditorWindow(self)

    def refresh(self):
        """编辑窗口关闭或保存后调用：重新读盘并保证 current 不越界。"""
        self.quotes = load_quotes()
        if self.current >= len(self._visible_quotes()):
            self.current = max(0, len(self._visible_quotes()) - 1)
        self._show_quote()


# ---------------------------------------------------------------------------
# 管理窗口：浅色主题，左侧列表 + 右侧表单，支持在线抓取（后台线程）
# ---------------------------------------------------------------------------

class EditorWindow:
    BG = "#f4f4ef"
    PANEL = "#eaeae4"
    FG = "#1a1a1a"
    DIM = "#666666"
    ACCENT = "#4444bb"
    DANGER = "#bb3333"
    OK = "#337733"
    SEL_BG = "#4444bb"

    def __init__(self, app: WisdomApp):
        self.app = app
        self._edit_idx = None          # 正在编辑的条目在 app.quotes 中的真实下标；None 表示「新增未保存」
        self._filtered = []            # 搜索/收藏过滤后保留的真实下标列表，与 Listbox 行一一对应

        self.win = tk.Toplevel(app.root)
        self.win.title("管理智慧明珠")
        self.win.configure(bg=self.BG)
        self.win.geometry("760x540")
        self.win.minsize(600, 400)
        self.win.grab_set()            # 模态：拦截其他窗口输入直到关闭
        self.win.protocol("WM_DELETE_WINDOW", self._close)

        self._build()
        self._refresh_list()

    def _close(self):
        """关闭前让主窗口重新 load_quotes 并刷新显示。"""
        self.app.refresh()
        self.win.destroy()

    # ------------------------------------------------------------------
    # 布局：左列表 + 右表单
    # ------------------------------------------------------------------

    def _build(self):
        # ── 左栏：标题、搜索、仅收藏、列表、操作按钮 ────────────────
        left = tk.Frame(self.win, bg=self.BG)
        left.pack(side="left", fill="both", expand=True, padx=(12, 0), pady=12)

        tk.Label(left, text="我的收藏", bg=self.BG, fg=self.ACCENT,
                 font=("Helvetica Neue", 13, "bold")).pack(anchor="w", pady=(0, 6))

        # 搜索框内容变化时 trace 触发 _refresh_list；勾选「仅收藏」同样刷新列表
        search_row = tk.Frame(left, bg=self.BG)
        search_row.pack(fill="x", pady=(0, 6))

        tk.Label(search_row, text="🔍", bg=self.BG, fg=self.DIM,
                 font=("Helvetica Neue", 11)).pack(side="left")
        self._search_var = tk.StringVar()
        self._search_var.trace_add("write", lambda *_: self._refresh_list())  # 每次输入都过滤列表
        tk.Entry(search_row, textvariable=self._search_var,
                 font=("Helvetica Neue", 11), relief="flat",
                 bg="#ffffff").pack(side="left", fill="x", expand=True, padx=(4, 6))

        self._fav_filter = tk.BooleanVar(value=False)
        tk.Checkbutton(search_row, text="★ 仅收藏", variable=self._fav_filter,
                       command=self._refresh_list,
                       bg=self.BG, fg=self.FG,
                       font=("Helvetica Neue", 10)).pack(side="left")

        # 列表：显示截断正文 + 作者；收藏前有 ★
        list_frame = tk.Frame(left, bg=self.BG)
        list_frame.pack(fill="both", expand=True)
        sb = tk.Scrollbar(list_frame)
        sb.pack(side="right", fill="y")
        self._listbox = tk.Listbox(
            list_frame, yscrollcommand=sb.set,
            font=("Helvetica Neue", 11),
            selectmode="single",
            bg="#ffffff", fg=self.FG,
            selectbackground=self.SEL_BG, selectforeground="#ffffff",
            relief="flat", activestyle="none", bd=0,
        )
        self._listbox.pack(side="left", fill="both", expand=True)
        sb.config(command=self._listbox.yview)
        self._listbox.bind("<<ListboxSelect>>", self._on_select)

        # 新增 / 删除 / 在线抓取
        btn_row = tk.Frame(left, bg=self.BG)
        btn_row.pack(fill="x", pady=(8, 0))

        self._lbtn(btn_row, "+ 新增", self._add_new, self.ACCENT).pack(side="left", padx=(0, 4))
        self._lbtn(btn_row, "删除", self._delete, self.DANGER).pack(side="left", padx=4)
        self._fetch_btn = self._lbtn(btn_row, "⬇ 在线获取", self._fetch_online, self.OK)
        self._fetch_btn.pack(side="left", padx=4)

        self._count_lbl = tk.Label(btn_row, text="", bg=self.BG, fg=self.DIM,
                                   font=("Helvetica Neue", 9))
        self._count_lbl.pack(side="right")

        # ── 中间竖线分隔 ───────────────────────────────────────────
        tk.Frame(self.win, width=1, bg="#cccccc").pack(side="left", fill="y", pady=16)

        # ── 右栏：编辑表单（Grid 布局）──────────────────────────────
        right = tk.Frame(self.win, bg=self.PANEL, padx=14, pady=12)
        right.pack(side="right", fill="both", padx=(0, 12), pady=12, ipadx=2)
        right.columnconfigure(1, weight=1)

        tk.Label(right, text="编辑名言", bg=self.PANEL, fg=self.ACCENT,
                 font=("Helvetica Neue", 13, "bold")).grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, 10))

        self._form_widgets = {}  # 预留扩展用，当前未使用

        # 名言正文（多行）
        self._form_lbl(right, "名言：", 1)
        self._quote_box = tk.Text(
            right, width=32, height=6,
            font=("Georgia", 12), wrap="word", relief="flat",
            bg="#ffffff", padx=4, pady=4,
        )
        self._quote_box.grid(row=1, column=1, pady=(0, 8), sticky="nsew")
        right.rowconfigure(1, weight=1)

        # 作者（单行）
        self._form_lbl(right, "作者：", 2)
        self._author_var = tk.StringVar()
        tk.Entry(right, textvariable=self._author_var, font=("Helvetica Neue", 11),
                 relief="flat", bg="#ffffff").grid(row=2, column=1, pady=(0, 8), sticky="ew")

        # 标签：存盘时按逗号拆分并 strip
        self._form_lbl(right, "标签：", 3)
        self._tags_var = tk.StringVar()
        tk.Entry(right, textvariable=self._tags_var, font=("Helvetica Neue", 11),
                 relief="flat", bg="#ffffff").grid(row=3, column=1, pady=(0, 4), sticky="ew")
        tk.Label(right, text="逗号分隔，如：领导力, 思维",
                 bg=self.PANEL, fg=self.DIM, font=("Helvetica Neue", 9)).grid(
            row=4, column=1, sticky="w", pady=(0, 8))

        # 是否收藏
        self._fav_var = tk.BooleanVar()
        tk.Checkbutton(right, text="★  标记收藏", variable=self._fav_var,
                       bg=self.PANEL, fg=self.FG,
                       font=("Helvetica Neue", 11)).grid(
            row=5, column=0, columnspan=2, sticky="w", pady=(0, 10))

        # 保存：新增或覆盖 self._edit_idx 指向的那一条
        tk.Button(
            right, text="保存", command=self._save,
            bg=self.ACCENT, fg="#ffffff",
            activebackground="#2222aa", activeforeground="#ffffff",
            relief="flat", padx=16, pady=6,
            font=("Helvetica Neue", 11, "bold"), cursor="hand2",
        ).grid(row=6, column=0, columnspan=2, sticky="ew", pady=(0, 6))

        # 底部状态提示（错误/成功用颜色区分）
        self._status_lbl = tk.Label(right, text="选择一条名言，或点击新增。",
                                    bg=self.PANEL, fg=self.DIM,
                                    font=("Helvetica Neue", 9), wraplength=230, justify="left")
        self._status_lbl.grid(row=7, column=0, columnspan=2, sticky="w")

    def _form_lbl(self, parent, text, row):
        tk.Label(parent, text=text, bg=self.PANEL, fg=self.FG,
                 font=("Helvetica Neue", 10), anchor="ne").grid(
            row=row, column=0, sticky="ne", padx=(0, 8), pady=(0, 8))

    def _lbtn(self, parent, text, cmd, color):
        return tk.Button(
            parent, text=text, command=cmd,
            bg=color, fg="#ffffff",
            activebackground="#222222", activeforeground="#ffffff",
            relief="flat", padx=10, pady=4,
            font=("Helvetica Neue", 10), cursor="hand2",
        )

    # ------------------------------------------------------------------
    # 列表：按搜索词（正文或作者子串）与「仅收藏」过滤，重建 _filtered
    # ------------------------------------------------------------------

    def _refresh_list(self):
        self._listbox.delete(0, "end")
        query = self._search_var.get().lower()
        fav_only = self._fav_filter.get()
        self._filtered = []

        for i, q in enumerate(self.app.quotes):
            if fav_only and not q.get("favorite"):
                continue
            text = q.get("text", "")
            author = q.get("author", "")
            if query and query not in text.lower() and query not in author.lower():
                continue
            self._filtered.append(i)
            star = "★ " if q.get("favorite") else "  "
            snippet = text[:52] + ("…" if len(text) > 52 else "")  # 列表中最多显示约 52 字
            display = f"{star}{snippet}"
            if author:
                display += f"  — {author}"
            self._listbox.insert("end", display)

        self._count_lbl.config(
            text=f"共 {len(self.app.quotes)} 条，显示 {len(self._filtered)} 条"
        )

    def _on_select(self, _=None):
        """选中列表某行：用 _filtered 映射回真实下标，并把数据填入右侧表单。"""
        sel = self._listbox.curselection()
        if not sel:
            return
        real_idx = self._filtered[sel[0]]
        self._edit_idx = real_idx
        q = self.app.quotes[real_idx]
        self._quote_box.delete("1.0", "end")
        self._quote_box.insert("1.0", q.get("text", ""))
        self._author_var.set(q.get("author", ""))
        self._tags_var.set(", ".join(q.get("tags", [])))
        self._fav_var.set(q.get("favorite", False))
        self._status(f"正在编辑第 {real_idx + 1} 条。", self.DIM)

    # ------------------------------------------------------------------
    # 增删改：直接修改 app.quotes 并 save_quotes
    # ------------------------------------------------------------------

    def _save(self):
        text = self._quote_box.get("1.0", "end").strip()
        if not text:
            self._status("名言内容不能为空。", self.DANGER)
            return
        tags = [t.strip() for t in self._tags_var.get().split(",") if t.strip()]
        q = {
            "text": text,
            "author": self._author_var.get().strip(),
            "tags": tags,
            "favorite": self._fav_var.get(),
        }
        if self._edit_idx is None:
            self.app.quotes.append(q)
            self._edit_idx = len(self.app.quotes) - 1
        else:
            self.app.quotes[self._edit_idx] = q
        save_quotes(self.app.quotes)
        self._refresh_list()
        self._status("已保存！", self.OK)

    def _add_new(self):
        self._edit_idx = None
        self._listbox.selection_clear(0, "end")
        self._quote_box.delete("1.0", "end")
        self._author_var.set("")
        self._tags_var.set("")
        self._fav_var.set(False)
        self._status("填写表单后点击保存。", self.DIM)
        self._quote_box.focus_set()

    def _delete(self):
        """删除前弹出确认框；删的是当前筛选列表选中项对应的真实 quotes 下标。"""
        sel = self._listbox.curselection()
        if not sel:
            self._status("请先选择一条名言。", self.DIM)
            return
        real_idx = self._filtered[sel[0]]
        q = self.app.quotes[real_idx]
        if not messagebox.askyesno(
            "删除名言",
            f'确认删除这条名言？\n\n"{q["text"][:100]}"',
            parent=self.win,
        ):
            return
        self.app.quotes.pop(real_idx)
        save_quotes(self.app.quotes)
        self._edit_idx = None
        self._refresh_list()
        self._status("名言已删除。", self.DANGER)

    # ------------------------------------------------------------------
    # 在线抓取：子线程请求 API，避免卡住 GUI；结果用 win.after(0, ...) 回到主线程更新 UI
    # ------------------------------------------------------------------

    def _fetch_online(self):
        self._fetch_btn.config(state="disabled", text="获取中…")
        self._status("正在连接 zenquotes.io…", self.DIM)

        def worker():
            try:
                # zenquotes 返回 JSON 数组，每项含 q（正文）、a（作者）
                url = "https://zenquotes.io/api/quotes"
                req = urllib.request.Request(
                    url, headers={"User-Agent": "WisdomPearls/1.0"}
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    data = json.loads(resp.read().decode())

                # 用已有正文集合去重，避免重复导入相同名言
                existing_texts = {q["text"].strip() for q in self.app.quotes}
                added = 0
                for item in data:
                    text = item.get("q", "").strip()
                    author = item.get("a", "").strip()
                    if not text or text in existing_texts:
                        continue
                    if author in ("zenquotes.io",):      # 跳过占位作者名
                        continue
                    self.app.quotes.append({
                        "text": text, "author": author,
                        "tags": ["online"], "favorite": False,
                    })
                    existing_texts.add(text)
                    added += 1

                save_quotes(self.app.quotes)
                # 必须在主线程操作 Tk 控件
                self.win.after(0, lambda: self._refresh_list())
                self.win.after(0, lambda: self._status(
                    f"新增了 {added} 条名言！", self.OK))
            except urllib.error.URLError as e:
                self.win.after(0, lambda: self._status(
                    f"网络错误：{e.reason}", self.DANGER))
            except Exception as e:
                self.win.after(0, lambda: self._status(f"错误：{e}", self.DANGER))
            finally:
                self.win.after(0, lambda: self._fetch_btn.config(
                    state="normal", text="⬇ 在线获取"))

        # daemon=True：主程序退出时线程不阻塞进程结束
        threading.Thread(target=worker, daemon=True).start()

    # ------------------------------------------------------------------

    def _status(self, msg, color):
        self._status_lbl.config(text=msg, fg=color)


# ---------------------------------------------------------------------------
# 入口：直接运行本脚本时启动主窗口事件循环
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    WisdomApp()
