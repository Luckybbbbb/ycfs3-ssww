// scripts/ui/hero_motion.js
// 主角战斗图集按行排列待机、施法与受击，每行四帧。

import { PLAYER_X } from '../skills/registry.js';

export const HERO_CAST_TIME = 0.26;
const CELL = 256;
const SIZE = 226;
const FEET = 242;
const IDLE = [0, 0, 0, 1, 2, 3, 0, 0, 0, 0];

export function heroMotionFrame(clock, attackT, hurtAge) {
  if (hurtAge != null && hurtAge < 0.22) {
    // 第一帧覆盖主循环的 50ms 步长上限，保证接触动作在低帧下仍可见。
    const frame = hurtAge <= 0.05 ? 0 : hurtAge < 0.105 ? 1 : hurtAge < 0.16 ? 2 : 3;
    return 8 + frame;
  }
  if (attackT > 0) {
    const progress = 1 - attackT / HERO_CAST_TIME;
    const frame = progress < 0.13 ? 0 : progress < 0.27 ? 1 : progress < 0.68 ? 2 : 3;
    return 4 + frame;
  }
  return IDLE[Math.floor(Math.max(0, clock) * 8) % IDLE.length];
}

export function drawHeroMotion(ctx, atlas, frame) {
  ctx.drawImage(atlas, frame % 4 * CELL, Math.floor(frame / 4) * CELL, CELL, CELL,
    PLAYER_X - SIZE / 2, 395 - FEET * SIZE / CELL, SIZE, SIZE);
}
