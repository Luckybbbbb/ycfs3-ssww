// scripts/ui/hero_motion.js
// 主角战斗图集每行四帧，出手锚点使用图集绘制后的战场坐标。

import { BOLT_SPEED, PLAYER_X } from '../skills/registry.js';

export const HERO_CAST_TIME = 0.28;
export const HERO_ATLAS_HEIGHT = 1536;
const CELL = 256;
const SIZE = 226;
const FEET = 242;
const LEFT = PLAYER_X - SIZE / 2;
const TOP = 395 - FEET * SIZE / CELL;
const atlasPoint = (x, y) => ({ x: LEFT + x * SIZE / CELL, y: TOP + y * SIZE / CELL });
const IDLE = [0, 0, 0, 1, 2, 3, 0, 0, 0, 0];
const SWORD = { first: 4, release: 2, recover: 3, origin: atlasPoint(208, 111) };
const SEAL = { first: 12, release: 1, recover: 2, origin: atlasPoint(232, 126) };
const GROUND = { first: 16, release: 1, recover: 2, origin: atlasPoint(232, 231), angle: 0.75 };
const GUARD = { first: 20, release: 1, recover: 2, origin: atlasPoint(127, 146) };
const ACTIONS = {
  fire_bolt: SEAL, fire_dotzone: SEAL, fire_pulse: GROUND,
  water_bolt: SWORD, water_chain: SWORD, water_field: GROUND,
  wood_bolt: SEAL, wood_bind: GROUND, wood_aura: GUARD,
  metal_bolt: SWORD, metal_multi: SWORD, metal_pulse: SWORD,
  earth_bolt: SEAL, earth_shield: GUARD, earth_pulse: GROUND,
};
const boltOrigins = new WeakMap();
let blendCanvas;
const idleFrame = clock => IDLE[Math.floor(Math.max(0, clock) * 8) % IDLE.length];
const smooth = t => t * t * (3 - 2 * t);

export function beginHeroCast(usedList, battle, previousFrame) {
  let lead, strongest = -1;
  for (const used of usedList) {
    const weight = used.tier + (used.from === 'elim' ? 6 : 0) + (used.kind === 'bolt' ? 0 : 2);
    if (weight > strongest) { lead = used; strongest = weight; }
  }
  if (!lead) return null;
  const action = ACTIONS[lead.skill.id] || SWORD;
  for (const bolt of battle.bolts) {
    if (bolt.t === 0 && !boltOrigins.has(bolt)) boltOrigins.set(bolt, action.origin);
  }
  const result = lead.result;
  const target = Number.isFinite(result?.x) && Number.isFinite(result?.y) ?
    { x: result.x, y: result.y, name: result.targetName ?? result.name } : null;
  return { at: battle.clock, action, element: lead.skill.el, skillId: lead.skill.id, tier: lead.tier, target,
    from: previousFrame ?? idleFrame(battle.clock) };
}

export function heroWindup(pending, clock) {
  const cast = pending?.find(p => {
    const until = Math.max(p.execFloor ?? p.t0 + 0.75, p.selT) - clock;
    return until > 0 && until <= 0.09;
  });
  const action = ACTIONS[cast?.skillId];
  if (!action) return null;
  const until = Math.max(cast.execFloor ?? cast.t0 + 0.75, cast.selT) - clock;
  return { frame: action.first, alpha: smooth(1 - until / 0.09) };
}

export function heroMotionFrame(clock, attackT, hurtAge, cast, windup) {
  const age = cast ? clock - cast.at : Infinity;
  if (hurtAge != null && hurtAge < 0.22 && age >= 0.05) {
    // 第一帧覆盖主循环的 50ms 步长上限，保证接触动作在低帧下仍可见。
    const frame = hurtAge <= 0.05 ? 0 : hurtAge < 0.105 ? 1 : hurtAge < 0.16 ? 2 : 3;
    return 8 + frame;
  }
  if (age >= 0 && age < HERO_CAST_TIME) {
    const { first, release, recover } = cast.action;
    return first + (age < 0.085 ? release : age < 0.18 ? recover : 3);
  }
  if (!cast && attackT > 0) {
    const progress = 1 - attackT / HERO_CAST_TIME;
    const frame = progress < 0.13 ? 0 : progress < 0.27 ? 1 : progress < 0.68 ? 2 : 3;
    return 4 + frame;
  }
  return windup?.frame ?? idleFrame(clock);
}

export function heroMotionMix(clock, cast, frame, windup) {
  const age = cast ? clock - cast.at : Infinity;
  if (age >= 0 && age < 0.052 && frame === cast.action.first + cast.action.release && cast.from !== frame) {
    return { under: cast.from, frame, alpha: 0.56 + 0.44 * smooth(age / 0.052) };
  }
  if (age > 0.20 && age < HERO_CAST_TIME && frame === cast.action.first + 3) {
    return { under: frame, frame: idleFrame(clock), alpha: smooth((age - 0.20) / (HERO_CAST_TIME - 0.20)) };
  }
  if (windup?.frame === frame) return { under: idleFrame(clock), frame, alpha: windup.alpha };
  return { frame, alpha: 1 };
}

export function heroBoltView(bolt, age = bolt.t) {
  const origin = boltOrigins.get(bolt);
  const duration = 0.24;
  const lane = Number.isInteger(bolt.visualLane) ? 1 - bolt.visualLane : 0;
  if ((!origin || age >= duration) && age === bolt.t && lane === 0 && bolt.visualCenterY == null) return bolt;
  const p = origin ? Math.max(0, Math.min(1, age / duration)) : 1;
  const remaining = 1 - smooth(p);
  const speed = 6 * p * (1 - p) / duration;
  const dx = origin ? origin.x - PLAYER_X : 0, dy = origin ? origin.y - bolt.y : 0;
  const x = bolt.x - (bolt.t - age) * BOLT_SPEED;
  const end = bolt.target ? Math.max(0, Math.min(1, (bolt.target.x - x - 46) / 85)) : 1;
  const spread = smooth(Math.max(0, Math.min(1, (age - 0.11) / 0.27))) * smooth(end);
  const row = (bolt.visualCenterY ?? bolt.y) - bolt.y - 82 * lane;
  return { ...bolt, x: x + dx * remaining + 54 * lane * spread,
    y: bolt.y + dy * remaining + row * spread,
    vx: BOLT_SPEED - dx * speed, vy: -dy * speed };
}

function paintCel(ctx, atlas, frame, x, y, size) {
  ctx.drawImage(atlas, frame % 4 * CELL, Math.floor(frame / 4) * CELL, CELL, CELL,
    x, y, size, size);
}

export function drawHeroMotion(ctx, atlas, frame, mix) {
  if (mix?.under !== undefined && mix.alpha < 1 && typeof document !== 'undefined') {
    if (!blendCanvas) {
      blendCanvas = document.createElement('canvas');
      blendCanvas.width = blendCanvas.height = CELL;
    }
    // 合并两帧的透明度，避免重叠处因两次普通叠加而变暗。
    const layer = blendCanvas.getContext('2d');
    layer.clearRect(0, 0, CELL, CELL);
    layer.globalAlpha = 1 - mix.alpha;
    paintCel(layer, atlas, mix.under, 0, 0, CELL);
    layer.globalCompositeOperation = 'lighter';
    layer.globalAlpha = mix.alpha;
    paintCel(layer, atlas, mix.frame, 0, 0, CELL);
    layer.globalCompositeOperation = 'source-over';
    ctx.drawImage(blendCanvas, LEFT, TOP, SIZE, SIZE);
    return;
  }
  paintCel(ctx, atlas, mix?.frame ?? frame, LEFT, TOP, SIZE);
}
