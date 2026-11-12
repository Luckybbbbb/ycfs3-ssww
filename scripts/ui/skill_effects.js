// scripts/ui/skill_effects.js
// 在实际弹道、命中位置和区域边界上播放 PixelFX 图集。

import { SKILL_FX_ART } from '../assets/skill_fx_art.js';
import { ENEMY_TYPES } from '../battle/wave.js';
import { skillById } from '../skills/library.js';
import { PLAYER_X } from '../skills/registry.js';
import { GEM_COLORS } from './draw_util.js';

const BOLTS = {
  fire: { cel: 0, wake: 0.25, width: 24, wave: 6, rim: '#bc3c24', body: '#fb8737', light: '#fff1a2' },
  water: { cel: 1, wake: 0.24, width: 21, wave: 9, rim: '#17769f', body: '#50d6ee', light: '#d4ffff' },
  wood: { cel: 2, wake: 0.22, width: 18, wave: 8, rim: '#497632', body: '#a0d457', light: '#e9ffad' },
  metal: { cel: 3, wake: 0.25, width: 17, wave: 3, rim: '#9d631d', body: '#f4ba45', light: '#fff4bd' },
  earth: { cel: 4, wake: 0.22, width: 22, wave: 5, rim: '#73462d', body: '#c08a50', light: '#ffd7a0' },
};
const MULTI_SHOT = { ...BOLTS.metal, cel: 5, wake: 0.14, width: 13 };
const MULTI_LANES = [0, -64, 64];
const PROJECTILE_CELL_W = 160, PROJECTILE_CELL_H = 128;
const HITS = { fire: 'fireHit', water: 'waterHit', wood: 'woodHit', metal: 'metalHit', earth: 'earthHit' };
const PULSES = { fire_pulse: 'fireRing', metal_pulse: 'bladeStorm', earth_pulse: 'earthQuake' };
const DURATIONS = {
  fire_dotzone: skillById('fire_dotzone').params.duration,
  water_field: skillById('water_field').params.duration,
  wood_aura: skillById('wood_aura').params.duration,
  wood_bind: skillById('wood_bind').params.bindTime,
};
const FIRE_GROUND = { fill: '#9e402a', edge: '#ffc482', light: '#ffdf99' };
const FROST_GROUND = { fill: '#378ca6', edge: '#9ee6f0', light: '#e1fbff' };
const AURA_GROUND = { fill: '#396d3a', edge: '#afdb82', light: '#e6ffad' };
// 按各类型序列帧的可见底边取中位数，避免把贴图的透明留白算成脚底。
const ENEMY_FOOT = { slime: 32, fox: 58, zombie: 79, snake: 49, tiger: 59, boss: 83 };
const clamp = p => Math.max(0, Math.min(1, p));

function lifetime(until, duration, clock) {
  const remaining = Number.isFinite(until) ? Math.max(0, Math.min(duration, until - clock)) : duration;
  return { age: duration - remaining, remaining, fraction: remaining / duration };
}

export function enemyEffectFoot(name, y) {
  return y + (ENEMY_FOOT[name] ?? ENEMY_FOOT.slime);
}

function drawFootprint(ctx, x, y, r, ry, palette, life, effects) {
  const fade = effects ? clamp(life.remaining / 0.3) : 1;
  if (fade === 0) return;
  ctx.save();
  ctx.globalAlpha *= fade;
  ctx.beginPath(); ctx.ellipse(x, y, r, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = palette.fill;
  ctx.globalAlpha *= 0.28;
  ctx.fill();
  ctx.strokeStyle = palette.edge;
  ctx.lineWidth = 2;
  ctx.stroke();
  if (effects) {
    ctx.globalAlpha *= 2.65;
    ctx.strokeStyle = palette.light;
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(x, y, r, ry, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * life.fraction);
    ctx.stroke();
    if (life.age < 0.24) {
      const p = clamp(life.age / 0.24);
      ctx.globalAlpha *= 1 - p;
      ctx.lineWidth = 3.4 - 2 * p;
      ctx.beginPath(); ctx.ellipse(x, y, r * (0.5 + 0.5 * p), ry * (0.5 + 0.5 * p), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawCastRelease(ctx, projectileHeads, cast, clock) {
  if (!cast) return;
  const p = (clock - cast.at) / 0.16;
  if (p < 0 || p >= 1) return;
  const { x, y } = cast.action.origin;
  const r = 7 + p * (21 + cast.tier * 2);
  const color = GEM_COLORS[cast.element];
  ctx.save();
  if (cast.target && (cast.skillId === 'fire_dotzone' || cast.skillId === 'wood_bind')) {
    const tx = cast.target.x, ty = enemyEffectFoot(cast.target.name, cast.target.y);
    const fire = cast.skillId === 'fire_dotzone';
    const launchY = fire ? ty : y;
    const beam = ctx.createLinearGradient(x, launchY, tx, ty);
    beam.addColorStop(0, 'transparent');
    beam.addColorStop(0.55, color);
    beam.addColorStop(1, fire ? '#ffe39c' : '#daff9c');
    const from = Math.max(0, p - (fire ? 0.30 : 0.52));
    const xAt = t => x + (tx - x) * t;
    const yAt = t => fire ? ty : (1 - t) ** 2 * y + 2 * (1 - t) * t * (ty - 16) + t * t * ty;
    ctx.strokeStyle = beam;
    ctx.lineWidth = fire ? 16 : 4;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(xAt(from), yAt(from));
    if (fire) {
      ctx.lineTo(xAt(p), ty);
    } else {
      for (let i = 1; i <= 5; i++) {
        const t = from + (p - from) * i / 5;
        ctx.lineTo(xAt(t), yAt(t));
      }
    }
    ctx.stroke();
    if (fire) {
      drawBoltHead(ctx, projectileHeads, BOLTS.fire.cel, xAt(p), ty, tx < x ? Math.PI : 0, 1);
    }
    ctx.restore();
    ctx.save();
  }
  ctx.translate(x, y);
  if (cast.action.angle) ctx.rotate(cast.action.angle);
  ctx.globalAlpha *= (1 - p) ** 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 4 - 2.5 * p;
  ctx.beginPath(); ctx.ellipse(0, 0, r * 0.57, r, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff5d9';
  ctx.beginPath(); ctx.moveTo(-r * 0.72, 0); ctx.lineTo(0, -r * 0.26);
  ctx.lineTo(r, 0); ctx.lineTo(0, r * 0.26); ctx.closePath(); ctx.fill();
  ctx.restore();
}

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

function drawBoltHead(ctx, image, cel, x, y, angle, size) {
  if (!image?.complete || !image.naturalWidth) return;
  // 图集内每发约宽 144 像素，绘制后约宽 100 逻辑像素，接近主角头部。
  const w = 112 * size, h = w * PROJECTILE_CELL_H / PROJECTILE_CELL_W;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, cel % 3 * PROJECTILE_CELL_W, Math.floor(cel / 3) * PROJECTILE_CELL_H,
    PROJECTILE_CELL_W, PROJECTILE_CELL_H, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawBoltTrail(ctx, bolt, art, points, angle, width) {
  const head = points[0], tail = points.at(-1);
  const nx = -Math.sin(angle), ny = Math.cos(angle);
  const wake = ctx.createLinearGradient(head.x, head.y, tail.x, tail.y);
  wake.addColorStop(0, art.light);
  wake.addColorStop(0.32, art.body);
  wake.addColorStop(0.67, art.rim);
  wake.addColorStop(1, 'transparent');
  ctx.save();
  const alpha = ctx.globalAlpha;
  ctx.fillStyle = wake;
  ctx.globalAlpha = alpha * 0.92;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const { x, y } = points[i];
    const w = width * (1 - i / (points.length - 1)) ** 0.84;
    ctx.lineTo(x + nx * w, y + ny * w);
  }
  for (let i = points.length - 2; i >= 0; i--) {
    const { x, y } = points[i];
    const w = width * (1 - i / (points.length - 1)) ** 0.84;
    ctx.lineTo(x - nx * w, y - ny * w);
  }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = wake;
  ctx.lineWidth = width * 0.38;
  ctx.globalAlpha = alpha * 0.9;
  ctx.beginPath();
  for (const [i, { x, y }] of points.entries()) {
    const drift = Math.sin(bolt.t * 30 - i * 1.37) * art.wave * Math.sin(Math.PI * i / (points.length - 1));
    ctx.lineTo(x + nx * drift, y + ny * drift);
  }
  ctx.stroke();
  ctx.fillStyle = art.light;
  for (let i = 1; i < points.length - 1; i++) {
    const { x, y } = points[i];
    const side = (i % 2 ? -1 : 1) * (width * 0.5 + i * 2.7);
    const size = width * (0.24 - i * 0.03);
    const px = x + nx * side, py = y + ny * side;
    ctx.globalAlpha = alpha * (0.76 - i * 0.13);
    ctx.beginPath(); ctx.moveTo(px - size * 1.6, py + size * 0.3);
    ctx.lineTo(px + size * 0.24, py - size);
    ctx.lineTo(px + size * (bolt.el === 'wood' ? 2.7 : 1.25), py - size * 0.16);
    ctx.lineTo(px + size * 0.24, py + size * 0.65); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

export function drawSkillBolt(ctx, projectileHeads, bolt, effects = true) {
  const art = bolt.skillId === 'metal_multi' ? MULTI_SHOT : BOLTS[bolt.el];
  if (!art) return;
  const size = 1 + 0.07 * ((bolt.tier || 1) - 1);
  const age = bolt.t;
  const duration = Math.min(age, art.wake);
  const vx = bolt.vx ?? 0, vy = bolt.vy ?? 0;
  // 连珠的三条绘制轨道从发射起就分开。碰撞继续使用弹丸原有坐标。
  const laneOffset = art === MULTI_SHOT ? (MULTI_LANES[bolt.visualLane] ?? 0) : 0;
  const head = { x: bolt.x, y: bolt.y + laneOffset };
  const angle = Math.atan2(vy, vx);
  if (effects && duration > 0.022) {
    const points = [head];
    for (let i = 1; i <= 5; i++) {
      const back = duration * i / 5;
      points.push({ x: head.x - vx * back, y: head.y - vy * back });
    }
    drawBoltTrail(ctx, bolt, art, points, angle, art.width * size);
  }
  const spin = effects ? age * (art === MULTI_SHOT ? 10 : bolt.el === 'earth' ? 5 : 0) : 0;
  drawBoltHead(ctx, projectileHeads, art.cel, head.x, head.y, angle + spin, size);
}

export function drawSkillZone(ctx, page, zone, clock, effects) {
  const fire = zone.kind === 'dot';
  const key = fire ? 'fireZone' : 'frostField';
  const duration = DURATIONS[zone.skillId] ?? (fire ? DURATIONS.fire_dotzone : DURATIONS.water_field);
  const life = lifetime(zone.until, duration, clock);
  const y = enemyEffectFoot(zone.targetName, zone.y);
  drawFootprint(ctx, zone.x, y, zone.r, zone.r * 0.30, fire ? FIRE_GROUND : FROST_GROUND, life, effects);
  if (!effects || life.remaining <= 0) return;
  const scale = zone.r * 1.95 / SKILL_FX_ART[key].frames[0][2];
  const spread = 0.64 + 0.36 * clamp(life.age / 0.2);
  sprite(ctx, page, key, zone.x, y, life.age, scale * spread, scale * (fire ? 0.59 : 0.38),
    0, (0.44 + 0.40 * clamp(life.age / 0.16)) * clamp(life.remaining / 0.30));
  if (fire && life.age > 0.06) {
    const fade = clamp(life.remaining / 0.30) * clamp((life.age - 0.06) / 0.15);
    for (const side of [-1, 1]) {
      sprite(ctx, page, key, zone.x + side * zone.r * 0.48, y + side * zone.r * 0.10,
        life.age + (side + 2) * 0.3, scale * spread * 0.43, scale * 0.32, 0, fade * 0.68);
    }
  }
}

export function drawSkillAura(ctx, page, x, y, aura, clock, effects) {
  const life = lifetime(aura.until, DURATIONS.wood_aura, clock);
  drawFootprint(ctx, x, y, 71, 20, AURA_GROUND, life, effects);
  if (!effects || life.remaining <= 0) return;
  sprite(ctx, page, 'lifeAura', x, y, life.age, 1.45, 1.36, 0,
    (0.4 + 0.4 * clamp(life.age / 0.22)) * clamp(life.remaining / 0.32));
}

export function drawSkillShield(ctx, page, x, y, shield, maxHp, clock, raised) {
  const strength = clamp(shield / Math.max(1, Math.round(maxHp * 0.3)));
  const forming = raised ? 0.78 + 0.22 * clamp(raised.t / 0.17) : 1;
  const age = raised?.t ?? clock;
  sprite(ctx, page, 'stoneGuard', x, y, age, 1.91 * forming, 2.35 * forming, 0, 0.30 + 0.32 * strength);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(forming, forming);
  ctx.globalAlpha *= 0.55 + 0.32 * strength;
  ctx.strokeStyle = '#ffd286';
  ctx.lineWidth = 2;
  for (let i = 0; i < 7; i++) {
    const a = i * Math.PI * 2 / 7 - 0.23;
    const drift = Math.sin(age * 3 + i * 1.6) * 2.4;
    ctx.save();
    ctx.translate(Math.cos(a) * (70 + drift), Math.sin(a) * (90 + drift));
    ctx.rotate(a + Math.PI / 2);
    ctx.fillStyle = i % 2 ? '#a06c42' : '#c4935a';
    ctx.beginPath(); ctx.moveTo(-13, -9); ctx.lineTo(2, -15); ctx.lineTo(16, -5);
    ctx.lineTo(12, 9); ctx.lineTo(-8, 12); ctx.lineTo(-16, 2); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

export function drawShieldContact(ctx, x, y, contact) {
  if (!contact) return;
  const p = clamp(contact.t / (contact.broken ? 0.38 : 0.22));
  const angle = contact.angle + Math.PI;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha *= 1 - p;
  ctx.strokeStyle = contact.broken ? '#e9a76d' : '#ffe8ab';
  ctx.lineWidth = (contact.broken ? 4 : 6) * (1 - 0.6 * p);
  ctx.beginPath(); ctx.ellipse(0, 0, 56 + 22 * p, 66 + 18 * p, 0, angle - 0.78, angle + 0.78); ctx.stroke();
  ctx.fillStyle = contact.broken ? '#e7b285' : '#fff1cb';
  const pieces = contact.broken ? 9 : 4;
  for (let i = 0; i < pieces; i++) {
    const a = angle - 0.82 + i * 1.64 / (pieces - 1);
    const reach = 55 + p * (19 + i % 3 * 9);
    const px = Math.cos(a) * reach, py = Math.sin(a) * reach + p * p * 26;
    const size = (3 + i % 3) * (1 - 0.5 * p);
    ctx.beginPath(); ctx.moveTo(px, py - size);
    ctx.lineTo(px + size, py); ctx.lineTo(px, py + size * 1.5);
    ctx.lineTo(px - size, py); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

export function drawSkillRoots(ctx, page, enemy, clock) {
  const life = lifetime(enemy.bindUntil, DURATIONS.wood_bind, clock);
  if (life.remaining <= 0) return;
  const art = SKILL_FX_ART.rootSnare;
  // 先沿源素材生长，再在藤蔓闭合的帧间变化，剩余时间很短时淡出。
  const frame = life.age < 0.26 ? Math.floor(life.age / 0.26 * 7) : 6 + Math.floor(3.9 * (1 + Math.sin(life.age * 12)));
  const type = ENEMY_TYPES[enemy.name] || ENEMY_TYPES.slime;
  const scale = Math.max(1.22, Math.min(1.85, type.srcW * type.scale / 70));
  sprite(ctx, page, 'rootSnare', enemy.x, enemyEffectFoot(enemy.name, enemy.y),
    (frame + 0.1) / art.frames.length * art.duration, scale, scale, 0, clamp(life.remaining / 0.24));
}

function drawFrostLink(ctx, x, y, dx, dy, p) {
  const length = Math.hypot(dx, dy);
  if (length <= 1) return;
  const count = Math.max(2, Math.ceil(length / 27));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.globalAlpha *= Math.min(1, (1 - p) * 2.35);
  ctx.beginPath(); ctx.moveTo(0, 0);
  for (let i = 1; i < count; i++) ctx.lineTo(i * length / count, i % 2 ? -5 : 5);
  ctx.lineTo(length, 0);
  ctx.strokeStyle = '#2782b1'; ctx.lineWidth = 9; ctx.stroke();
  ctx.strokeStyle = '#e1ffff'; ctx.lineWidth = 3.2; ctx.stroke();
  ctx.strokeStyle = '#adf0ff'; ctx.lineWidth = 2;
  for (let i = 1; i < count; i++) {
    const at = i * length / count, off = i % 2 ? -5 : 5;
    ctx.beginPath(); ctx.moveTo(at - 7, off); ctx.lineTo(at, off - 6);
    ctx.lineTo(at + 7, off); ctx.lineTo(at, off + 6); ctx.closePath(); ctx.stroke();
  }
  ctx.restore();
}

function drawPulseShape(ctx, hit, y, p) {
  const r = hit.radius * (0.48 + 0.52 * (1 - (1 - p) ** 3));
  ctx.save();
  ctx.translate(hit.x, y);
  ctx.globalAlpha *= Math.min(1, (1 - p) * 1.55, 0.64 + p * 12);
  if (hit.skillId === 'metal_pulse') {
    for (let i = 0; i < 3; i++) {
      const angle = i * Math.PI * 2 / 3 + p * 5;
      ctx.beginPath(); ctx.ellipse(0, -r * 0.25, r, r * 0.48, i * 0.25 - 0.25, angle, angle + 1.37);
      ctx.strokeStyle = '#d99e3e'; ctx.lineWidth = 8 - p * 4; ctx.stroke();
      ctx.strokeStyle = '#fff4b2'; ctx.lineWidth = 2.8; ctx.stroke();
    }
  } else {
    const fire = hit.skillId === 'fire_pulse';
    const palette = fire ? ['#d54921', '#fff1a2'] : ['#b16c35', '#ffdc99'];
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.32, 0, 0, Math.PI * 2);
    ctx.strokeStyle = palette[0]; ctx.lineWidth = 9 - p * 6; ctx.stroke();
    ctx.strokeStyle = palette[1]; ctx.lineWidth = 2.4; ctx.stroke();
    if (!fire) {
      ctx.strokeStyle = '#8a5739';
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, dx = Math.cos(a) * r, dy = Math.sin(a) * r * 0.32;
        ctx.moveTo(dx * 0.2, dy * 0.2); ctx.lineTo(dx * 0.55, dy * 0.55 - 3);
        ctx.lineTo(dx * 0.76 + 4, dy * 0.76); ctx.lineTo(dx, dy);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawBoltContact(ctx, hit) {
  const p = hit.t / 0.14;
  if (p >= 1) return;
  const art = BOLTS[hit.el];
  const radius = Math.min(46, hit.reach) * (0.73 + p * 0.48);
  ctx.save();
  ctx.translate(hit.x, hit.y);
  ctx.rotate(hit.angle);
  ctx.globalAlpha *= (1 - p) ** 1.45;
  // 弹头消散后，最后一截拖尾沿弹道收向命中点。金弹穿透时由弹头继续带出拖尾。
  const tail = Math.min(86, hit.x - PLAYER_X) * (1 - p);
  if (hit.el !== 'metal' && tail > 0) {
    const light = ctx.createLinearGradient(0, 0, -tail, 0);
    light.addColorStop(0, art.light);
    light.addColorStop(0.27, art.body);
    light.addColorStop(1, 'transparent');
    ctx.fillStyle = light;
    ctx.beginPath(); ctx.moveTo(-tail, 0); ctx.lineTo(-3, -radius * 0.34);
    ctx.lineTo(radius * 0.22, 0); ctx.lineTo(-3, radius * 0.34); ctx.closePath();
    ctx.fill();
  }
  // 纵向闪光露出命中轮廓，让同帧的弹头、闪白和飘字仍能分辨。
  ctx.beginPath();
  ctx.moveTo(4, -radius);
  ctx.lineTo(radius * 0.27, -radius * 0.29);
  ctx.lineTo(radius * 0.68, -radius * 0.09);
  ctx.lineTo(radius * 0.23, radius * 0.19);
  ctx.lineTo(-3, radius * 0.79);
  ctx.lineTo(-radius * 0.24, radius * 0.24);
  ctx.lineTo(-radius * 0.59, radius * 0.07);
  ctx.lineTo(-radius * 0.24, -radius * 0.19);
  ctx.closePath();
  ctx.lineWidth = 4;
  ctx.strokeStyle = art.rim;
  ctx.stroke();
  ctx.fillStyle = art.body;
  ctx.fill();
  ctx.scale(0.55, 0.72);
  ctx.fillStyle = art.light;
  ctx.beginPath();
  ctx.moveTo(4, -radius); ctx.lineTo(radius * 0.54, -radius * 0.11);
  ctx.lineTo(-3, radius * 0.73); ctx.lineTo(-radius * 0.49, radius * 0.07);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

export function drawSkillImpact(ctx, page, hit) {
  const p = hit.t / hit.life;
  const pulse = hit.primary && PULSES[hit.skillId];
  const key = pulse || (hit.hero ? 'heroHit' : hit.crit ? 'critical' : HITS[hit.el]);
  if (!key) return false;
  const art = SKILL_FX_ART[key];
  const width = pulse ? hit.radius * 2 : hit.reach * (hit.contact ? 2.7 : 1.8);
  const scale = width / art.frames[0][2];
  const y = pulse ? enemyEffectFoot(hit.targetName, hit.y) : hit.y;
  if (hit.linkFrom) {
    const { x, y } = hit.linkFrom;
    const dx = hit.targetX - x, dy = hit.targetY - y;
    const link = SKILL_FX_ART.chainLink;
    const length = Math.hypot(dx, dy);
    drawFrostLink(ctx, x, y, dx, dy, p);
    if (length > 1) sprite(ctx, page, 'chainLink', x, y, p * link.duration, length / 48, 0.85, Math.atan2(dy, dx), 1 - p);
  }
  if (pulse) drawPulseShape(ctx, hit, y, p);
  const height = pulse && hit.skillId !== 'metal_pulse' ? scale * 0.83 : scale;
  const drawn = sprite(ctx, page, key, hit.x, y, p * art.duration, scale, height,
    pulse ? 0 : hit.angle, Math.min(1, (1 - p) * 2.8));
  if (hit.contact) drawBoltContact(ctx, hit);
  return drawn;
}
