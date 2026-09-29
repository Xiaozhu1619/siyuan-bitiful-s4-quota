# -*- coding: utf-8 -*-
"""程序化生成插件图标 icon.png（160x160，带透明圆角与抗锯齿）

不依赖任何第三方库：手写 PNG 编码器 + 4x4 超采样抗锯齿。
图形语义：环形额度表（已用约 62%）+ 中心三条刻度，呼应"三项额度"。
"""

import struct
import zlib
import math
import os

S = 160      # 输出边长
SS = 4       # 每轴超采样数 → 16 个样本/像素
N = S * SS

# 调色
BLUE_TOP = (0x4A, 0x86, 0xF7)
BLUE_BOT = (0x2C, 0x63, 0xD8)
CORNER_R = 36.0          # 圆角半径（按 160 坐标系）
CX = CY = 80.0
RING_R = 45.0
RING_W = 13.0
ARC_PROGRESS = 0.62      # 已用比例
BAR_ALPHA = (1.0, 0.75, 0.5)
BARS = [                 # (x0, x1, y0, y1)
    (66.0, 94.0, 64.0, 69.0),
    (66.0, 86.0, 77.5, 82.5),
    (66.0, 79.0, 91.0, 96.0),
]


def in_round_rect(px, py, w, h, r):
    if px < 0 or py < 0 or px > w or py > h:
        return False
    cx = r if px < r else (w - r if px > w - r else px)
    cy = r if py < r else (h - r if py > h - r else py)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= r * r


def in_rounded_bar(px, py, x0, x1, y0, y1, r):
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    cx = min(max(px, x0 + r), x1 - r)
    cy = y0 + (y1 - y0) / 2.0
    dx, dy = px - cx, py - cy
    if abs(py - cy) > (y1 - y0) / 2.0:
        return False
    return dx * dx + dy * dy <= r * r or (x0 + r <= px <= x1 - r)


def sample(px, py):
    """返回 (r, g, b, a)，a 为 0..1。px,py 位于 160 坐标系。"""
    if not in_round_rect(px, py, S, S, CORNER_R):
        return (0, 0, 0, 0.0)

    # 背景：竖向线性渐变
    t = min(1.0, max(0.0, py / S))
    r = int(BLUE_TOP[0] + (BLUE_BOT[0] - BLUE_TOP[0]) * t)
    g = int(BLUE_TOP[1] + (BLUE_BOT[1] - BLUE_TOP[1]) * t)
    b = int(BLUE_TOP[2] + (BLUE_BOT[2] - BLUE_TOP[2]) * t)

    dx, dy = px - CX, py - CY
    dist = math.hypot(dx, dy)
    on_ring = abs(dist - RING_R) <= RING_W / 2.0

    if on_ring:
        # 底环 26% 白
        r = int(r * 0.74 + 255 * 0.26)
        g = int(g * 0.74 + 255 * 0.26)
        b = int(b * 0.74 + 255 * 0.26)

        # 已用弧段：自顶部顺时针 ARC_PROGRESS
        ang = math.degrees(math.atan2(dy, dx))          # -180..180，y 向下
        start, sweep = -90.0, ARC_PROGRESS * 360.0
        rel = (ang - start) % 360.0
        if rel <= sweep:
            r, g, b = 255, 255, 255
        elif rel > sweep:
            # 弧段两端的圆头（stroke-linecap: round）
            for a_deg in (start, start + sweep):
                a = math.radians(a_deg)
                ex, ey = CX + RING_R * math.cos(a), CY + RING_R * math.sin(a)
                if math.hypot(px - ex, py - ey) <= RING_W / 2.0:
                    r, g, b = 255, 255, 255
                    break

    for (x0, x1, y0, y1), al in zip(BARS, BAR_ALPHA):
        if in_rounded_bar(px, py, x0, x1, y0, y1, 2.5):
            r = int(r * (1 - al) + 255 * al)
            g = int(g * (1 - al) + 255 * al)
            b = int(b * (1 - al) + 255 * al)

    return (r, g, b, 1.0)


def render():
    px_buf = bytearray(S * S * 4)
    inv = 1.0 / (SS * SS)
    for oy in range(S):
        for ox in range(S):
            ar = ag = ab = aa = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    sx_f = ox + (sx + 0.5) / SS
                    sy_f = oy + (sy + 0.5) / SS
                    r, g, b, a = sample(sx_f, sy_f)
                    ar += r * a
                    ag += g * a
                    ab += b * a
                    aa += a
            if aa > 0:
                # 预乘还原
                rr = int(round(ar / aa))
                gg = int(round(ag / aa))
                bb = int(round(ab / aa))
            else:
                rr = gg = bb = 0
            alpha = int(round(aa * inv * 255))
            i = (oy * S + ox) * 4
            px_buf[i] = max(0, min(255, rr))
            px_buf[i + 1] = max(0, min(255, gg))
            px_buf[i + 2] = max(0, min(255, bb))
            px_buf[i + 3] = max(0, min(255, alpha))
    return bytes(px_buf)


def write_png(path, w, h, rgba):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)                       # filter type 0
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")
    data = render()
    write_png(out, S, S, data)
    print(f"written {out}  {os.path.getsize(out)} bytes")

    # 统计透明/不透明像素，确认圆角生效
    opaque = sum(1 for i in range(3, len(data), 4) if data[i] > 250)
    clear = sum(1 for i in range(3, len(data), 4) if data[i] < 5)
    print(f"不透明 {opaque} px / 全透明 {clear} px / 总计 {S*S} px")
