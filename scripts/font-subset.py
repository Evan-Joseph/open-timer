#!/usr/bin/env python3
"""Noto Sans SC 子集化：从 Google Fonts 可变字体生成项目专用 woff2。

字符集 = 项目 UI 静态中文文案 ∪ GB2312 一级汉字(3755) ∪ ASCII/常用标点。
输出单个 variable woff2（font-weight 100-900），体积 ~1MB 内。
备注等自由文本缺字时回退系统黑体（PingFang SC 等）。

用法: python3 scripts/font-subset.py <NotoSansSC[wght].ttf>
输出: web/src/fonts/noto-sans-sc-subset.woff2
"""
import os
import re
import sys

from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/NotoSansSC-var.ttf'
OUT = os.path.join(ROOT, 'web', 'src', 'fonts', 'noto-sans-sc-subset.woff2')


def ui_chars() -> set[str]:
    """收集 web/src 内所有静态中文（tsx/ts/css 源码中的汉字）。"""
    chars: set[str] = set()
    for dirpath, _, files in os.walk(os.path.join(ROOT, 'web', 'src')):
        for fn in files:
            if not fn.endswith(('.tsx', '.ts', '.css')):
                continue
            text = open(os.path.join(dirpath, fn), encoding='utf-8').read()
            chars.update(ch for ch in text if '\u4e00' <= ch <= '\u9fff')
    return chars


def gb2312_level1() -> set[str]:
    """GB2312 一级汉字（3755 常用字，拼音序）。"""
    chars: set[str] = set()
    for hi in range(0xB0, 0xD8):  # 一级区
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    return chars


def main() -> None:
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    chars = ui_chars() | gb2312_level1()
    extra = set('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ：·（）—？！、，。；""\'\'《》【】%＋－×÷≈≠≤≥°')
    chars |= extra
    text = ''.join(sorted(chars))
    print(f'字符集: {len(chars)} 字')

    # 固定 wght 轴为静态实例会丢失可变性；直接保留 variable 输出（现代浏览器支持）
    # 但 subset 前先把 wght 轴 clamp 到 100-900（本就如此），输出仍为 variable。
    options = subset.Options()
    options.flavor = 'woff2'
    options.desubroutinize = False
    options.ignore_missing_glyphs = True
    options.name_IDs = [1, 2, 4, 6]  # 家族/子家族/全名/PostScript
    options.name_languages = [0x409, 0x804]
    options.layout_features = ['*']
    options.notdef_outline = True
    options.recalc_bounds = True

    subsetter = subset.Subsetter(options=options)
    font = TTFont(SRC)
    subsetter.populate(text=text)
    subsetter.subset(font)
    font.save(OUT)
    print(f'输出: {OUT} ({os.path.getsize(OUT) / 1024:.0f} KB)')


if __name__ == '__main__':
    main()
