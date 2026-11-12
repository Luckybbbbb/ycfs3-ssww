# tools/bake_skill_fx.py
"""Bake the local PixelFX library into the game's three combat atlas pages."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory

from PIL import Image

LEAF = ['#19352a', '#305442', '#36764b', '#58a44e', '#99cc57', '#dbef8d', '#fff5c4']
GOLD = ['#3a271a', '#794a24', '#b77925', '#d99a32', '#ffce59', '#ffeb98', '#fff9d7']
EARTH = ['#382825', '#624336', '#986842', '#bd8e59', '#e2b176', '#f1d6a1', '#fff1d0']
ICE = ['#172a58', '#245079', '#346d9d', '#52a8cf', '#94daf7', '#d4f6ff', '#f4ffff']
FIRE = ['#4a1712', '#8a1f17', '#c9281f', '#f2561d', '#ff8a2a', '#ffc23d', '#ffe26b', '#fff3a6', '#ffffff']

# Source clip, maximum sampled frames, source time window, optional palette, optional crop/pivot.
RECIPES = {
    'shots': {
        'fireShot': ('fire/fireball', 18, None, None, None),
        'waterShot': ('ice/ice-lance', 12, None, None, None),
        'woodShot': ('projectiles/plasma-shot', 12, None, LEAF, None),
        'metalShot': ('projectiles/laser-bolt', 8, None, GOLD, None),
        'earthShot': ('pickups/crystal-shard', 16, None, EARTH, 'center'),
        'multiShot': ('projectiles/energy-disc', 8, None, GOLD, None),
    },
    'hits': {
        'fireHit': ('impacts/hit-spark', 9, None, FIRE, None),
        'waterHit': ('ice/snowflake-burst', 14, (0.08, 1.15), ICE, None),
        'woodHit': ('impacts/hit-spark', 9, None, LEAF, None),
        'metalHit': ('impacts/parry', 12, (0.03, 0.82), GOLD, None),
        'earthHit': ('impacts/blunt-hit', 12, None, EARTH, None),
        'critical': ('impacts/crit-hit', 14, None, GOLD, None),
        'chainLink': ('lightning/chain-lightning', 9, (0.17, 0.64), ICE, (49, 52, 99, 81, 50, 64)),
        'heroHit': ('impacts/hit-spark', 9, None, ['#4f202e', '#923347', '#e2646a', '#ffc0a8', '#fff3d7'], None),
        'stoneGuard': ('holy/divine-shield', 20, None, EARTH, 'center'),
    },
    'fields': {
        'fireZone': ('fire/fire-tornado', 22, None, FIRE, None),
        'rootSnare': ('nature/root-snare', 22, None, LEAF, None),
        'fireRing': ('fire/fire-ring', 23, (0, 1.65), FIRE, None),
        'frostField': ('ice/blizzard-vortex', 20, None, ICE, None),
        'lifeAura': ('nature/leaf-storm', 20, None, LEAF, None),
        'bladeStorm': ('melee/spin-slash', 13, None, GOLD, None),
        'earthQuake': ('nature/quake', 21, (0, 1.55), EARTH, None),
    },
}


def read_clip(source, work, key, recipe):
    effect, cap, period, palette, placement = recipe
    out = work / key
    command = ['node', str(source / 'tools/render.mjs'), effect, '--sheet', '--no-actor',
               '--bg', 'none', '--fps', '16', '--zoom', '1', '--max', '4', '--out', str(out)]
    if palette:
        command += ['--opts', json.dumps({'palette': palette}, separators=(',', ':'))]
    subprocess.run(command, check=True, capture_output=True, text=True)
    stem = out / effect / effect.split('/')[-1]
    data = json.loads(stem.with_suffix('.json').read_text(encoding='utf-8'))
    metadata = data['meta']['pixelfx']
    start, stop = period or (0, (len(data['frames']) - 1) / 16)
    lo = max(0, round(start * 16))
    hi = min(len(data['frames']) - 1, round(stop * 16))
    frames = min(hi - lo + 1, cap)
    indices = [round(lo + (hi - lo) * i / max(1, frames - 1)) for i in range(frames)]
    frames = []
    ox, oy = metadata['pivot']
    with Image.open(stem.with_suffix('.png')) as sheet:
        for i in indices:
            rect = data['frames'][i]['frame']
            x, y, w, h = [rect[k] for k in ('x', 'y', 'w', 'h')]
            frames.append(sheet.crop((x, y, x + w, y + h)).convert('RGBA'))
    if isinstance(placement, tuple):
        *bounds, ox, oy = placement
    else:
        boxes = [frame.getchannel('A').getbbox() for frame in frames]
        boxes = [box for box in boxes if box]
        if not boxes:
            raise ValueError(f'{key}: empty clip')
        bounds = [min(box[0] for box in boxes), min(box[1] for box in boxes),
                  max(box[2] for box in boxes), max(box[3] for box in boxes)]
        if placement == 'center':
            ox = round((bounds[0] + bounds[2]) / 2)
            oy = round((bounds[1] + bounds[3]) / 2)
    cropped = [frame.crop(bounds) for frame in frames]
    duration = round((hi - lo + int(metadata['loop'])) / 16, 4)
    return cropped, {
        'source': effect, 'pivot': [ox - bounds[0], oy - bounds[1]],
        'duration': duration, 'loop': metadata['loop'],
    }


def pack_page(page, clips, destination):
    limit = 2048
    tiles = sorted(((key, i, im) for key, (frames, _) in clips.items()
                    for i, im in enumerate(frames)), key=lambda item: -item[2].height)
    layout = {}
    x, y, row, widest = 1, 1, 0, 1
    for key, i, tile in tiles:
        w, h = tile.size
        if x + w + 1 > limit:
            x, y, row = 1, y + row + 2, 0
        layout[key, i] = (x, y, w, h)
        x += w + 2
        row = max(row, h)
        widest = max(widest, x - 1)
    height = y + row + 1
    if height > 4096:
        raise ValueError(f'{page}: oversized atlas {widest}×{height}')
    atlas = Image.new('RGBA', (widest, height))
    for key, i, im in tiles:
        atlas.paste(im, layout[key, i][:2])
    atlas.save(destination, quality=82, method=6, exact=True)
    print(f'{page}: {widest}x{height}, {len(tiles)} frames, {destination.stat().st_size} bytes')
    return {key: {**metadata, 'page': page, 'frames': [layout[key, i] for i in range(len(frames))]}
            for key, (frames, metadata) in clips.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pixelfx', type=Path)
    parser.add_argument('--out', type=Path, default=Path('.'))
    args = parser.parse_args()
    source, out = args.pixelfx.resolve(), args.out.resolve()
    assets = out / 'assets/effects/pixelfx'
    scripts = out / 'scripts/assets'
    assets.mkdir(parents=True, exist_ok=True)
    scripts.mkdir(parents=True, exist_ok=True)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    metadata = {}
    with TemporaryDirectory() as temp:
        for page, recipes in RECIPES.items():
            clips = {key: read_clip(source, Path(temp), key, recipe) for key, recipe in recipes.items()}
            metadata.update(pack_page(page, clips, assets / f'{page}.webp'))
    content = '// scripts/assets/skill_fx_art.js\n'
    content += f'// Generated by tools/bake_skill_fx.py from PixelFX {revision}.\n'
    content += f'export const SKILL_FX_PAGES = {json.dumps(list(RECIPES))};\n'
    content += 'export const SKILL_FX_ART = {\n'
    for key, item in metadata.items():
        content += f'  {key}: {json.dumps(item, separators=(",", ":"))},\n'
    (scripts / 'skill_fx_art.js').write_text(content + '};\n', encoding='utf-8')
    for name in ('LICENSE', 'NOTICE.md'):
        shutil.copyfile(source / name, assets / name)


if __name__ == '__main__':
    main()
