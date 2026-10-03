# -*- coding: utf-8 -*-
"""tools/layout/make-placeholder-assets.py —— 生成占位素材（147 张），并按清单的 ID/规格落位

为什么要有这个脚本：清单（docs/frontend/assets-manifest.md）列出了所有缺图，但从"缺"到"界面能看到"
还差两件事：① 真的要有文件；② 布局表里的元素要 `asset` 指过去。这个脚本把①做掉（②由
wire-assets-into-layout.js 做），而且**可复现**：以后你把真图放进 public/assets/ 覆盖同名文件后，
再跑这个脚本**不会**覆盖你的真图（只覆盖自己生成过、或本来不存在的文件）。

风格约定（全部**不带文字**，文字由界面自己渲染，避免重影）：
  bg     1920×1080  深色渐变 + 中央光晕 + 六边形网格暗纹 + 暗角
  role   512×512    六边形盾牌剪影（按 id 取色）+ 内圈 + 徽记
  skill  256×256    菱形盘（按 id 取色）+ 按技能类型的方向/挥砍符号
  plugin 128×128    圆角方牌（按类别取色）+ 角色插件=圆环 / 技能插件=三角 徽记
  ai     128×128    代码块样式的圆角块（左侧类别色条 + 几行"代码条"）
  package 256×256   箱体 + 缎带（按包类型取色）
  frame  256×256 SVG 品质边框（颜色取自 qualities.json）
  tier   64×64   SVG 段位盾徽（颜色取自 qualities.json + 星点表示档位）
  ui     按元素框    按钮/控件底版（导航=蓝灰 / 出战队=琥珀 / 战斗=橙红 / 配置=N 号色）；
                     `hit:"path"` 的元素直接画成同样的多边形，被界面 clip-path 裁切后完全贴合

用法：
  python tools/layout/make-placeholder-assets.py            # 生成缺失的（不覆盖非占位文件）
  python tools/layout/make-placeholder-assets.py --force    # 连自己生成过的也重画
"""
import colorsys
import hashlib
import json
import math
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    print('需要 Pillow：请用仓库自带的 Python 运行时，或 pip install pillow')
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(ROOT, 'server', 'data')
PUBLIC = os.path.join(ROOT, 'public')
ASSETS = os.path.join(PUBLIC, 'assets')
LAYOUT = os.path.join(ROOT, 'tools', 'layout', 'layout-bundle.raw.json')
REGISTRY = os.path.join(ROOT, 'tools', 'layout', 'placeholders.json')

FORCE = '--force' in sys.argv


def read_json(p):
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def hue_of(text, lo=0, hi=360):
    h = int(hashlib.sha1(str(text).encode('utf-8')).hexdigest()[:8], 16)
    return lo + (h % 1000) / 1000.0 * (hi - lo)


def rgb(h, s, v):
    r, g, b = colorsys.hsv_to_rgb((h % 360) / 360.0, s, v)
    return (int(r * 255), int(g * 255), int(b * 255))


def rgba(h, s, v, a=255):
    return rgb(h, s, v) + (a,)


def registry_load():
    if os.path.exists(REGISTRY):
        try:
            return read_json(REGISTRY)
        except Exception:
            pass
    return {'generated': []}


def can_write(rel, reg):
    """只写：不存在、或本来就是本脚本生成的（绝不覆盖用户的真素材）"""
    if FORCE:
        return True
    if rel not in reg['generated'] and os.path.exists(os.path.join(PUBLIC, rel)):
        return False
    return True


def save_webp(img, rel, reg):
    if not can_write(rel, reg):
        return False
    path = os.path.join(PUBLIC, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'WEBP', quality=90, method=6)
    return True


def save_text(text, rel, reg):
    if not can_write(rel, reg):
        return False
    path = os.path.join(PUBLIC, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return True


def center_box(size, k):
    w, h = size
    return [((w - w * k) / 2, (h - h * k) / 2), ((w + w * k) / 2, (h + h * k) / 2)]


# ---------------------------------------------------------------- 背景
def radial(size, inner, outer, power=1.0):
    """平滑径向遮罩：中心 inner、边缘 outer（0..255），避免同心矩形造成的硬边"""
    w, h = size
    small = Image.new('L', (48, 27), outer)
    d = ImageDraw.Draw(small)
    cx, cy = 48 / 2, 27 / 2
    for y in range(27):
        for x in range(48):
            k = min(1.0, (abs(x - cx) / cx) ** 2 + (abs(y - cy) / cy) ** 2) ** (power / 2)
            small.putpixel((x, y), int(inner + (outer - inner) * k))
    return small.resize((w, h), Image.LANCZOS)


def make_bg():
    W, H = 1920, 1080
    img = Image.new('RGB', (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    # 垂直渐变：上深下略亮（给画面一点深度）
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(11 + 13 * t), int(16 + 17 * t), int(27 + 27 * t)))
    # 中央光晕（平滑径向，叠加两次：宽而淡 + 窄而亮）
    for r, alpha, hue in ((1100, 40, (70, 110, 190)), (620, 34, (110, 160, 245))):
        glow = Image.new('RGB', (W, H), (0, 0, 0))
        mask = radial((W, H), 255, 0, 1.6).resize((W, H), Image.LANCZOS)
        glow.paste(Image.new('RGB', (W, H), hue), (0, 0), mask.point(lambda v: int(v * alpha / 255)))
        img = Image.blend(img, Image.blend(img, glow, 0.55), 0.6)
    # 极淡的六边形暗纹（只做纹理暗示）
    d = ImageDraw.Draw(img)
    hexr = 132
    dx, dy = hexr * 1.5, hexr * math.sqrt(3)
    overlay = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for col in range(-1, int(W / dx) + 2):
        for row in range(-1, int(H / dy) + 2):
            cx = col * dx
            cy = row * dy + (dy / 2 if col % 2 else 0)
            pts = [(cx + hexr * math.cos(math.pi / 6 + i * math.pi / 3), cy + hexr * math.sin(math.pi / 6 + i * math.pi / 3))
                   for i in range(6)]
            if -hexr < cx < W + hexr and -hexr < cy < H + hexr:
                od.line(pts + [pts[0]], fill=(150, 190, 255, 9), width=1)
    img = Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB')
    # 平滑暗角（径向遮罩相乘）
    vig = radial((W, H), 255, 96, 2.2)
    img = Image.composite(img, Image.new('RGB', (W, H), (4, 6, 10)), vig)
    # 底部再压一点，让按钮区更稳
    bot = Image.new('L', (W, H), 255)
    bd = ImageDraw.Draw(bot)
    for i in range(160):
        bd.line([(0, H - 160 + i), (W, H - 160 + i)], fill=int(255 - 70 * (1 - i / 159.0)))
    img = Image.composite(img, Image.new('RGB', (W, H), (6, 9, 14)), bot)
    return img


# ---------------------------------------------------------------- 角色
def make_role(name, tpl):
    S = 512
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    h = hue_of(tpl['id'], 0, 360)
    cx, cy, R = S / 2, S / 2 + 6, S * 0.44
    pts = [(cx + R * math.cos(math.radians(-90 + i * 60)), cy + R * math.sin(math.radians(-90 + i * 60))) for i in range(6)]
    # 底色渐变（逐层缩小叠加，模拟垂直渐变）
    for i in range(60):
        k = i / 59.0
        rr = R * (1 - k * 0.02)
        pp = [(cx + (x - cx) * (1 - k * 0.06), cy + (y - cy) * (1 - k * 0.06)) for x, y in pts]
        d.polygon(pp, fill=rgba(h, 0.55 - 0.25 * k, 0.42 + 0.42 * k, 255))
    d.line(pts + [pts[0]], fill=rgba(h, 0.35, 1.0, 220), width=6)
    # 内圈 + 徽记
    R2 = R * 0.62
    pts2 = [(cx + R2 * math.cos(math.radians(-90 + i * 60)), cy + R2 * math.sin(math.radians(-90 + i * 60))) for i in range(6)]
    d.line(pts2 + [pts2[0]], fill=rgba(h, 0.2, 1.0, 130), width=3)
    sym = int(hashlib.md5(tpl['id'].encode()).hexdigest(), 16) % 3
    if sym == 0:                                        # 圆环
        d.ellipse([cx - R2 * 0.42, cy - R2 * 0.42, cx + R2 * 0.42, cy + R2 * 0.42], outline=rgba(h, 0.1, 1.0, 235), width=14)
    elif sym == 1:                                      # 十字
        d.line([(cx, cy - R2 * 0.5), (cx, cy + R2 * 0.5)], fill=rgba(h, 0.1, 1.0, 235), width=16)
        d.line([(cx - R2 * 0.5, cy), (cx + R2 * 0.5, cy)], fill=rgba(h, 0.1, 1.0, 235), width=16)
    else:                                               # 三角
        d.polygon([(cx, cy - R2 * 0.5), (cx + R2 * 0.46, cy + R2 * 0.34), (cx - R2 * 0.46, cy + R2 * 0.34)],
                  fill=rgba(h, 0.1, 1.0, 235))
    return img


# ---------------------------------------------------------------- 技能
def make_skill(tpl):
    S = 256
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    h = hue_of(tpl['id'], 0, 360)
    cx = cy = S / 2
    R = S * 0.42
    d.polygon([(cx, cy - R), (cx + R, cy), (cx, cy + R), (cx - R, cy)], fill=rgba(h, 0.6, 0.5, 255))
    d.line([(cx, cy - R), (cx + R, cy), (cx, cy + R), (cx - R, cy), (cx, cy - R)], fill=rgba(h, 0.3, 1.0, 225), width=4)
    W = 14
    t = str(tpl.get('type', ''))
    col = rgba(h, 0.15, 1.0, 240)
    if t == 'melee':                                    # 两把交叉的斩击
        d.line([(cx - 54, cy + 54), (cx + 54, cy - 54)], fill=col, width=W)
        d.line([(cx - 54, cy - 54), (cx + 54, cy + 54)], fill=col, width=W)
    elif t == 'displace':                               # 位移：两个错开的箭头
        d.line([(cx - 58, cy - 20), (cx + 34, cy - 20)], fill=col, width=W)
        d.polygon([(cx + 40, cy - 34), (cx + 70, cy - 20), (cx + 40, cy - 6)], fill=col)
        d.line([(cx + 58, cy + 24), (cx - 34, cy + 24)], fill=rgba(h, 0.15, 1.0, 160), width=W)
        d.polygon([(cx - 40, cy + 10), (cx - 70, cy + 24), (cx - 40, cy + 38)], fill=rgba(h, 0.15, 1.0, 160))
    elif t == 'vertical':                               # 定点：向上箭头 + 交点
        d.line([(cx, cy + 56), (cx, cy - 34)], fill=col, width=W)
        d.polygon([(cx - 34, cy - 30), (cx, cy - 66), (cx + 34, cy - 30)], fill=col)
        d.ellipse([cx - 9, cy + 44, cx + 9, cy + 62], fill=col)
    else:                                               # 平射（默认）：向右箭头 + 弹道线
        d.line([(cx - 62, cy), (cx + 40, cy)], fill=col, width=W)
        d.polygon([(cx + 34, cy - 30), (cx + 74, cy), (cx + 34, cy + 30)], fill=col)
        for i in range(3):
            d.line([(cx - 70 + i * 10, cy - 40 + i * 40), (cx - 56 + i * 10, cy - 40 + i * 40)],
                   fill=rgba(h, 0.2, 1.0, 110), width=5)
    return img


# ---------------------------------------------------------------- 插件
def make_plugin(p):
    S = 128
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    h = hue_of(p.get('category') or p.get('id'), 0, 360)
    d.rounded_rectangle([6, 6, S - 6, S - 6], radius=22, fill=rgba(h, 0.55, 0.46, 255),
                        outline=rgba(h, 0.35, 1.0, 220), width=4)
    cx = cy = S / 2
    col = rgba(h, 0.12, 1.0, 240)
    if str(p.get('kind', '')) == 'skillPlugin':         # 技能插件：三角 + 加号
        d.polygon([(cx, cy - 26), (cx + 26, cy + 20), (cx - 26, cy + 20)], outline=col, fill=None, width=6)
        d.line([(cx, cy - 6), (cx, cy + 12)], fill=col, width=5)
        d.line([(cx - 9, cy + 3), (cx + 9, cy + 3)], fill=col, width=5)
    else:                                               # 角色插件：圆环 + 加号
        d.ellipse([cx - 27, cy - 27, cx + 27, cy + 27], outline=col, width=6)
        d.line([(cx, cy - 11), (cx, cy + 11)], fill=col, width=5)
        d.line([(cx - 11, cy), (cx + 11, cy)], fill=col, width=5)
    # 点数：右上角小点（1..3）
    pts = int(p.get('pointCost', 1) or 1)
    for i in range(min(3, max(0, pts))):
        d.ellipse([S - 26 + i * 0, 10 + i * 11, S - 18, 18 + i * 11], fill=rgba(h, 0.05, 1.0, 235))
    return img


# ---------------------------------------------------------------- AI 积木节点
def make_ai(node):
    W, H = 128, 128
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    h = hue_of(node.get('category') or node.get('id'), 0, 360)
    d.rounded_rectangle([4, 4, W - 4, H - 4], radius=16, fill=(26, 32, 44, 255), outline=rgba(h, 0.4, 0.95, 235), width=4)
    d.rounded_rectangle([4, 4, 20, H - 4], radius=10, fill=rgba(h, 0.6, 0.9, 255))       # 左侧类别色条
    for i in range(3):                                                                   # 三行"代码条"
        y = 26 + i * 20
        w = [70, 52, 62][i]
        d.rounded_rectangle([30, y, 30 + w, y + 9], radius=4, fill=(150, 175, 205, 150))
    d.rounded_rectangle([30, 92, 46, 101], radius=4, fill=rgba(h, 0.5, 1.0, 220))
    return img


# ---------------------------------------------------------------- 包
def make_package(p):
    S = 256
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    key = p.get('packageKind') or p.get('id') or 'package'
    h = hue_of(key, 0, 360)
    d.rounded_rectangle([34, 92, S - 34, S - 46], radius=14, fill=rgba(h, 0.5, 0.5, 255),
                        outline=rgba(h, 0.3, 1.0, 220), width=5)
    d.rounded_rectangle([26, 62, S - 26, 106], radius=12, fill=rgba(h, 0.45, 0.62, 255),
                        outline=rgba(h, 0.3, 1.0, 220), width=5)
    d.rectangle([S / 2 - 16, 62, S / 2 + 16, S - 46], fill=rgba(h, 0.15, 1.0, 220))       # 缎带
    d.rounded_rectangle([S / 2 - 22, 96, S / 2 + 22, 122], radius=8, fill=rgba(h, 0.1, 1.0, 240))
    return img


# ---------------------------------------------------------------- 品质框 / 段位（SVG）
def frame_svg(q):
    color = q.get('color') or '#888888'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{color}" stop-opacity=".95"/>
    <stop offset="1" stop-color="{color}" stop-opacity=".45"/>
  </linearGradient></defs>
  <rect x="10" y="10" width="236" height="236" rx="26" fill="none" stroke="url(#g)" stroke-width="8"/>
  <rect x="24" y="24" width="208" height="208" rx="18" fill="none" stroke="{color}" stroke-opacity=".28" stroke-width="3"/>
  <g fill="{color}" fill-opacity=".9">
    <polygon points="10,42 10,10 42,10"/><polygon points="214,10 246,10 246,42"/>
    <polygon points="246,214 246,246 214,246"/><polygon points="42,246 10,246 10,214"/>
  </g>
</svg>
'''


def tier_svg(q, index):
    color = q.get('color') or '#888888'
    stars = ''.join(f'<circle cx="{32 - 13 + i * 13}" cy="46" r="4.2" fill="{color}" fill-opacity=".95"/>'
                    for i in range(index + 1))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="{color}" stop-opacity="1"/><stop offset="1" stop-color="{color}" stop-opacity=".55"/>
  </linearGradient></defs>
  <path d="M32 3 L58 13 V33c0 14-11 23-26 28C17 56 6 47 6 33V13Z" fill="url(#t)" stroke="{color}" stroke-width="2.5"/>
  <path d="M32 10 L51 17.5V33c0 10.5-8 17.5-19 21.5C21 50.5 13 43.5 13 33V17.5Z"
        fill="none" stroke="#0b0f18" stroke-opacity=".35" stroke-width="2"/>
  {stars}
</svg>
'''


# ---------------------------------------------------------------- UI 按钮/控件底版
NAV = {'btn_warehouse', 'btn_ai', 'btn_settings', 'btn_board', 'btn_tournament', 'btn_quick',
       '用户头像', '对战历史', 'pick_panel', 'pick_title', 'spick_panel', 'spick_title',
       'plug_panel', 'plug_title', 'splug_panel', 'splug_title'}
CONFIG = {'设为出战（将当前配置设为出战）', 'slot_1', 'slot_2', 'slot_3'}
BATTLE = {'btn_quick', 'btn_tournament'}


def ui_color(el):
    i = el['id']
    if i.startswith('battle_badge'):
        return hue_of('battle_badge', 30, 44), 0.75
    if i in CONFIG:
        return hue_of('config', 34, 46), 0.55
    if i in BATTLE:
        return hue_of('battle', 8, 22), 0.55
    if i.startswith('skill_') or i.startswith('skill') or i.startswith('slot_e'):
        return hue_of(i, 0, 360), 0.5
    if i == 'crest_role':
        return hue_of(i, 200, 230), 0.45
    return 214.0, 0.30        # 导航/面板：蓝灰


def ui_plate(el, w, h):
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, 'RGBA')
    hh, sat = ui_color(el)
    radius = max(6, int(min(w, h) * 0.16))
    path = el.get('path')
    if el.get('hit') == 'path' and path:
        pts = []
        for tok in path.replace('M', ' ').replace('L', ' ').replace('Z', ' ').replace(',', ' ').split():
            pts.append(float(tok))
        poly = [(pts[i] / 100.0 * w, pts[i + 1] / 100.0 * h) for i in range(0, len(pts) - 1, 2)]
        d.polygon(poly, fill=rgba(hh, sat * 0.8, 0.34, 240))
        d.line(poly + [poly[0]], fill=rgba(hh, 0.4, 0.92, 235), width=max(2, int(min(w, h) * 0.02)))
    else:
        d.rounded_rectangle([1, 1, w - 2, h - 2], radius=radius, fill=rgba(hh, sat * 0.7, 0.30, 235),
                            outline=rgba(hh, 0.35, 0.85, 225), width=max(2, int(min(w, h) * 0.012)))
        d.rounded_rectangle([1, 1, w - 2, max(2, int(h * 0.42))], radius=radius, fill=rgba(hh, sat * 0.5, 0.42, 90))
    return img


# ---------------------------------------------------------------- 主流程
def main():
    reg = registry_load()
    made, skipped = [], []
    roles = read_json(os.path.join(DATA, 'role-templates.json'))['roleTemplates']
    skills = read_json(os.path.join(DATA, 'skill-templates.json'))['skillTemplates']
    plugins = read_json(os.path.join(DATA, 'plugins.json'))['plugins']
    quals = read_json(os.path.join(DATA, 'qualities.json'))['qualities']
    nodes = read_json(os.path.join(DATA, 'ai-node-catalog.json'))['nodes']
    pkgs = read_json(os.path.join(DATA, 'package-config.json'))['packages']

    def emit(img, rel):
        if save_webp(img, rel, reg):
            made.append(rel)
        else:
            skipped.append(rel)

    emit(make_bg(), 'assets/bg/hub_main.webp')
    for r in roles:
        emit(make_role(r['name'], r), 'assets/role/%s.webp' % r['id'])
    for s in skills:
        emit(make_skill(s), 'assets/skill/%s.webp' % s['id'])
    seen = set()
    for p in plugins:
        key = str(p['id']).replace('_c0', '')
        fam = key
        while fam not in seen and False:
            break
        import re
        fam = re.sub(r'_c\d+$', '', str(p['id']))
        if fam in seen:
            continue
        seen.add(fam)
        emit(make_plugin(p), 'assets/plugin/%s.webp' % fam)
    for n in nodes:
        emit(make_ai(n), 'assets/ai/%s.webp' % n['id'])
    for p in pkgs:
        key = p.get('packageKind') or p.get('id') or 'package'
        emit(make_package(p), 'assets/package/%s.webp' % key)
    for i, q in enumerate(quals):
        rel = 'assets/frame/%s.svg' % q['id']
        if save_text(frame_svg(q), rel, reg):
            made.append(rel)
        else:
            skipped.append(rel)
        rel2 = 'assets/tier/%s.svg' % q['id']
        if save_text(tier_svg(q, i), rel2, reg):
            made.append(rel2)
        else:
            skipped.append(rel2)

    # UI：布局表里所有"没有 asset 的按钮/角标"各一张，尺寸按元素框（×2 分辨率，最小 64）
    # 以**修正后**的布局为准（真源里 设为出战/对战历史 还是 deco，导入期才变 button）
    norm = os.path.join(os.path.dirname(LAYOUT), 'layout-bundle.normalized.json')
    bundle = read_json(norm) if os.path.exists(norm) else read_json(LAYOUT)
    by_id = {}
    for sname in bundle['screens']:
        for el in bundle['screens'][sname].get('elements', []):
            if el.get('asset'):
                continue
            if el.get('kind') != 'button' and not str(el['id']).startswith('battle_badge'):
                continue
            prev = by_id.get(el['id'])
            if prev is None or (el['rect'][2] * el['rect'][3] > prev['rect'][2] * prev['rect'][3]):
                by_id[el['id']] = el
    for eid, el in by_id.items():
        w = max(64, min(1024, int(el['rect'][2] * 2)))
        h = max(64, min(1024, int(el['rect'][3] * 2)))
        safe = str(eid).strip().replace('/', '_').replace('\\', '_').replace(':', '_').replace('*', '_') \
            .replace('?', '_').replace('"', '_').replace('<', '_').replace('>', '_').replace('|', '_').replace(' ', '_')
        emit(ui_plate(el, w, h), 'assets/ui/%s.webp' % safe)

    reg['generated'] = sorted(set(reg['generated']) | set(made))
    reg['note'] = '由 tools/layout/make-placeholder-assets.py 生成的占位素材清单；脚本只覆盖这里列出的文件，绝不动你的真素材'
    with open(REGISTRY, 'w', encoding='utf-8') as f:
        json.dump(reg, f, ensure_ascii=False, indent=1)
        f.write('\n')

    print('生成 %d 张占位素材；跳过 %d 张（已存在且不是占位）' % (len(made), len(skipped)))
    if skipped:
        print('跳过示例：' + ', '.join(os.path.basename(s) for s in skipped[:6]))
    print('登记表：tools/layout/placeholders.json（共 %d 条）' % len(reg['generated']))


if __name__ == '__main__':
    main()
