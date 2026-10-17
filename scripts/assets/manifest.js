// scripts/assets/manifest.js
// 序列帧路径常量(帧号清单数组化,非等差序列禁止等差循环——04 文档第 6 节 FR-9)
// 相对路径: scripts/assets/manifest.js

import { ENEMY_TYPES } from '../battle/wave.js';

// 主角帧清单(04 文档第 6 节:idle 16 / walk 6 / walk_start 3;M3 用 idle,walk 留 M4+)
export const PLAYER_FRAMES = {
  idle: Array.from({ length: 16 }, (_, i) => i + 1),      // idle_01~16
  walk: Array.from({ length: 6 }, (_, i) => i + 1),       // walk_01~06
  walk_start: Array.from({ length: 3 }, (_, i) => i + 1), // walk_start_01~03
};

// 敌人帧清单(来自 ENEMY_TYPES,路径格式 assets/sprites/<目录>/<前缀>_%03d_nobg.png)
export function enemyFrameList(type) {
  const t = ENEMY_TYPES[type];
  return t.frames.map(n => ({
    key: `${type}:${n}`,
    url: `assets/sprites/${t.dir}/${t.prefix}${String(n).padStart(3, '0')}_nobg.png`,
    entity: type,
  }));
}

// 图标清单(M10 接入:codex 生图 animal-island 风格——五行棋子 5 张+技能图标 15 张;
// FR-9 预载校验,缺图停载;render.js GEM_IMG/SKILL_IMG 消费)
export function iconList() {
  const list = [];
  for (const el of ['metal', 'wood', 'water', 'fire', 'earth']) {
    list.push({ key: `icon:elements:${el}`, url: `assets/icons/elements/${el}.png`, entity: 'board-gem' });
  }
  for (const id of [
    'fire_bolt', 'water_bolt', 'wood_bolt', 'metal_bolt', 'earth_bolt',
    'fire_dotzone', 'water_chain', 'wood_bind', 'metal_multi', 'earth_shield',
    'fire_pulse', 'water_field', 'wood_aura', 'metal_pulse', 'earth_pulse',
  ]) {
    list.push({ key: `icon:skills:${id}`, url: `assets/icons/skills/${id}.png`, entity: id });
  }
  return list;
}

// 全量资源清单(主角 + 六类敌人 + M10 图标;M3 只消费 player.idle 与敌人动画,其余仍预载校验)
export function fullManifest() {
  const list = [];
  for (const [action, frames] of Object.entries(PLAYER_FRAMES)) {
    for (const n of frames) {
      list.push({
        key: `player:${action}:${n}`,
        url: `assets/sprites/player/${action}_${String(n).padStart(2, '0')}.png`,
        entity: 'player',
      });
    }
  }
  for (const type of Object.keys(ENEMY_TYPES)) list.push(...enemyFrameList(type));
  list.push(...iconList());
  return list;
}
