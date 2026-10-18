#!/usr/bin/env python3
# tools/quantize_png.py — M14 PNG 量化压缩(本机工具,原地覆盖;git 有历史可回退)
# 对立绘/背景/atlas 等大 PNG 做 256 色量化(FASTOCTREE 保留 alpha)——
# 平涂黏土风视觉无损,体积约降 50~70%。阈值:仅处理 >80KB 的文件(小图无收益)。
# 运行: python tools/quantize_png.py
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TARGETS = [
    'assets/sprites/player',
    'assets/sprites/skillcall',
    'assets/backgrounds/battle',
    'assets/atlases',
]
MIN_BYTES = 80 * 1024

def main():
    total_before = total_after = 0
    for d in TARGETS:
        base = ROOT / d
        if not base.exists():
            continue
        for f in sorted(base.rglob('*.png')):
            size = f.stat().st_size
            if size <= MIN_BYTES:
                continue
            with Image.open(f) as im:
                im.load()
                if im.mode != 'RGBA':
                    im = im.convert('RGBA')
                q = im.quantize(256, method=Image.FASTOCTREE)
                q.save(f, optimize=True)
            after = f.stat().st_size
            total_before += size; total_after += after
            print(f'{f.relative_to(ROOT)}: {size//1024}KB → {after//1024}KB')
    print(f'[done] {total_before//1024}KB → {total_after//1024}KB (-{100 - total_after*100//max(1,total_before)}%)')

if __name__ == '__main__':
    main()
