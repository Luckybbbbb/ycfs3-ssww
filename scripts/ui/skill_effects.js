// scripts/ui/skill_effects.js
// 在实际弹道、命中位置和区域边界上播放 PixelFX 图集。

import { SKILL_FX_ART } from '../assets/skill_fx_art.js';

const BOLTS = {
  fire: ['fireShot', 0.64], water: ['waterShot', 0.60], wood: ['woodShot', 0.58],
  metal: ['metalShot', 0.57], earth: ['earthShot', 0.58],
};
const HITS = { fire: 'fireHit', water: 'waterHit', wood: 'woodHit', metal: 'metalHit', earth: 'earthHit' };
const PULSES = { fire_pulse: 'fireRing', metal_pulse: 'bladeStorm', earth_pulse: 'earthQuake' };

function sprite(ctx, page, key, x, y, time, scaleX, scaleY = scaleX, angle = 0, alpha = 1) {
  const art = SKILL_FX_ART[key];
  const image = page?.(art.page);
  if (!image?.complete || !image.naturalWidth) return false;
  const progress = time / art.duration;
  const phase = art.loop ? progress - Math.floor(progress) : Math.max(0, Math.min(1, progress));
  const [sx, sy, w, h] = art.frames[Math.min(art.frames.length - 1, Math.floor(phase * art.frames.length))];
  const [ox, oy] = art.pivot;
  ctx.save();
  ctx.translate(x, y);
  if (angle) ctx.rotate(angle);
  ctx.globalAlpha *= alpha;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, sx, sy, w, h, -ox * scaleX, -oy * scaleY, w * scaleX, h * scaleY);
  ctx.restore();
  return true;
}

export function drawSkillBolt(ctx, page, bolt) {
  const art = bolt.skillId === 'metal_multi' ? ['multiShot', 0.63] : BOLTS[bolt.el];
  if (!art) return false;
  const [key, baseScale] = art;
  const scale = baseScale * (1 + 0.065 * ((bolt.tier || 1) - 1));
  const angle = Math.atan2(bolt.vy || 0, bolt.vx || 1);
  return sprite(ctx, page, key, bolt.x, bolt.y, bolt.t || 0, scale, scale, angle);
}

export function drawSkillZone(ctx, page, zone, clock) {
  const key = zone.kind === 'dot' ? 'fireZone' : 'frostField';
  const scale = zone.r * 1.8 / SKILL_FX_ART[key].frames[0][2];
  return sprite(ctx, page, key, zone.x, zone.y + zone.r * 0.48, clock, scale, scale * 0.82, 0, 0.78);
}

export function drawSkillAura(ctx, page, x, y, clock) {
  return sprite(ctx, page, 'lifeAura', x, y, clock, 1.34, 1.34, 0, 0.8);
}

export function drawSkillShield(ctx, page, x, y, clock) {
  return sprite(ctx, page, 'stoneGuard', x, y, clock, 1.65, 1.8, 0, 0.77);
}

export function drawSkillRoots(ctx, page, enemy, y, clock) {
  const remaining = Math.max(0, enemy.bindUntil - clock);
  const duration = SKILL_FX_ART.rootSnare.duration;
  const phase = Math.max(0, Math.min(1, 1 - remaining / 1.5));
  return sprite(ctx, page, 'rootSnare', enemy.x, y, phase * duration, 1.07);
}

export function drawSkillImpact(ctx, page, hit) {
  const p = hit.t / hit.life;
  const pulse = hit.primary && PULSES[hit.skillId];
  const key = pulse || (hit.hero ? 'heroHit' : hit.crit ? 'critical' : HITS[hit.el]);
  if (!key) return false;
  const art = SKILL_FX_ART[key];
  const scale = pulse ? hit.radius * 2 / art.frames[0][2] : hit.reach * 1.8 / art.frames[0][2];
  const y = pulse ? hit.y + 26 : hit.y;
  if (hit.linkFrom) {
    const { x, y } = hit.linkFrom;
    const dx = hit.targetX - x, dy = hit.targetY - y;
    const link = SKILL_FX_ART.chainLink;
    const length = Math.hypot(dx, dy);
    if (length > 1) sprite(ctx, page, 'chainLink', x, y, p * link.duration, length / 48, 0.85, Math.atan2(dy, dx), 1 - p);
  }
  return sprite(ctx, page, key, hit.x, y, p * art.duration, scale, scale,
    pulse ? 0 : hit.angle, Math.min(1, (1 - p) * 2.8));
}
