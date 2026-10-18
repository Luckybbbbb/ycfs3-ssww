#!/usr/bin/env python3
# tools/pack_atlas.py — M14 雪碧图打包(Python PIL,本机工具,产物入库)
# 把小尺寸序列帧/图标按目录组合成 ≤2048×2048 的 atlas,输出:
#   assets/atlases/<group>.png + assets/atlases/index.json
# index.json: { "atlas": "<group>.png", "frames": { "<原相对路径>": [x, y, w, h] } }
# 大图(hero/bubble/skillcall 背景/战斗背景)不打包——单文件已大,合并无收益。
# loader.js 优先按 index.json 加载 atlas 并切帧(dataURL Image,绘制代码零改动),
# index.json 缺失(开发新增素材未重打包)时自动回落逐帧原路径。
# 运行: python tools/pack_atlas.py
import json
import os
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ATLAS_DIR = ROOT / 'assets' / 'atlases'
ATLAS_MAX = 2048

# 分组:组名 → 相对 assets/ 的目录(递归收集 .png)
# player 序列帧为 720×1280 全屏大图(与 skillcall/背景同列),合并无收益,不打包
GROUPS = {
    'slime': ['sprites/slime'],
    'fox_anim': ['sprites/fox_anim'],
    'zombie': ['sprites/zombie'],
    'snake': ['sprites/snake'],
    'tiger': ['sprites/tiger'],
    'boss': ['sprites/boss'],
    'icons': ['icons/elements', 'icons/skills', 'icons/items'],
}

def collect(rel_dirs):
    files = []
    for d in rel_dirs:
        base = ROOT / 'assets' / d
        if not base.exists():
            continue
        for p in sorted(base.rglob('*.png')):
            files.append(p)
    return files

def pack_group(group, files):
    """简单行式装箱:按高度降序排列,逐行填充,超宽换行,超高分片。"""
    frames = []
    for f in files:
        with Image.open(f) as im:
            frames.append((f, im.size))
    frames.sort(key=lambda x: -(x[1][1]))  # 高度降序
    rows = []  # [y, h, [(path, x, w)]]
    x = y = row_h = 0
    for f, (w, h) in frames:
        if x + w > ATLAS_MAX:  # 换行
            rows.append([y, row_h, None]); y += row_h; row_h = 0; x = 0
        rows.append([x, y, w, h, f])  # 占位记录
        x += w; row_h = max(row_h, h)
    # 上面记录混乱,重写为直观算法:
    placements = []
    cx = cy = crow_h = 0
    placed_rows = []
    for f, (w, h) in frames:
        if cx + w > ATLAS_MAX:
            placed_rows.append(crow_h); cy += crow_h; cx = 0; crow_h = 0
        placements.append((f, cx, cy, w, h))
        cx += w; crow_h = max(crow_h, h)
    total_h = cy + crow_h
    return placements, total_h

def main():
    ATLAS_DIR.mkdir(parents=True, exist_ok=True)
    index = {}
    for group, dirs in GROUPS.items():
        files = collect(dirs)
        if not files:
            print(f'[skip] {group}: 无文件')
            continue
        placements, total_h = pack_group(group, files)
        atlas = Image.new('RGBA', (ATLAS_MAX, total_h), (0, 0, 0, 0))
        frames = {}
        for f, x, y, w, h in placements:
            with Image.open(f) as im:
                atlas.paste(im, (x, y))
            rel = str(f.relative_to(ROOT)).replace('\\', '/')
            frames[rel] = [x, y, w, h]
        atlas_path = ATLAS_DIR / f'{group}.png'
        atlas.save(atlas_path, optimize=True)
        index[rel_group_atlas(group)] = {'frames': frames}
        print(f'[ok] {group}: {len(frames)} 帧 → {atlas_path.name} ({ATLAS_MAX}×{total_h}, {atlas_path.stat().st_size//1024}KB)')
    # index.json 结构: { "<group>.png": { "frames": {rel: [x,y,w,h]} } }
    merged = {}
    for group, dirs in GROUPS.items():
        ap = ATLAS_DIR / f'{group}.png'
        if ap.exists():
            merged[f'{group}.png'] = index[rel_group_atlas(group)]
    (ATLAS_DIR / 'index.json').write_text(json.dumps(merged, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'[done] {len(merged)} atlas → assets/atlases/index.json')

def rel_group_atlas(group):
    return f'{group}.png'

if __name__ == '__main__':
    main()
