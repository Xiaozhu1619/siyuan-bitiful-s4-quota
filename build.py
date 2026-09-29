# -*- coding: utf-8 -*-
"""打包 package.zip —— 思源集市要求的最小文件集

用法： python build.py
产物： ./package.zip （上传到 GitHub Release 作为附件）
"""

import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

# 集市要求：i18n/*、icon/preview 字段声明的图片、index.css、index.js、plugin.json、README*.md
FILES = [
    "plugin.json",
    "index.js",
    "index.css",
    "icon.png",
    "preview.png",
    "README.md",
    "README_zh_CN.md",
    "i18n/zh_CN.json",
    "i18n/en_US.json",
]

OUT = os.path.join(HERE, "package.zip")


def main():
    missing = [f for f in FILES if not os.path.exists(os.path.join(HERE, f))]
    if missing:
        raise SystemExit("缺少必要文件: " + ", ".join(missing))

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for f in FILES:
            z.write(os.path.join(HERE, f), f)

    size = os.path.getsize(OUT)
    print(f"package.zip  {size} bytes ({size/1024:.1f} KB)")
    with zipfile.ZipFile(OUT) as z:
        for n in z.namelist():
            print(f"  {n:<22} {z.getinfo(n).file_size:>8} B")


if __name__ == "__main__":
    main()
