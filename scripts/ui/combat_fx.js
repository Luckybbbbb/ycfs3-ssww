// scripts/ui/combat_fx.js
// 五行弹道与命中表现。画面读取已结算事件，所有尺寸均为逻辑像素。

import { BATTLE_ASSET_BAR_H, GEM_COLORS } from './draw_util.js';
import { BATTLE_H } from '../battle/parallax.js';
import { drawSkillImpact } from './skill_effects.js';

const ELEMENT_ART = {
  metal: { light: '#fff2ae', dark: '#865720', aspect: 1.64 },
  wood: { light: '#dff5a1', dark: '#2d6e45', aspect: 1.34 },
  water: { light: '#d7faff', dark: '#235c8c', aspect: 1.43 },
  fire: { light: '#ffe0a0', dark: '#9f3540', aspect: 1.56 },
  earth: { light: '#f3ca91', dark: '#533b35', aspect: 1.07 },
};
const MAX_IMPACTS = 12;
const BOSS_FALL_TIME = 0.58;

function elementPath(ctx, el) {
  ctx.beginPath();
  switch (el) {
    case 'metal':
      ctx.moveTo(-1.15, 0);
      ctx.lineTo(-0.13, -0.61); ctx.lineTo(1.15, 0); ctx.lineTo(-0.13, 0.61);
      break;
    case 'wood':
      ctx.moveTo(-1.07, 0.48);
      ctx.quadraticCurveTo(-0.86, -0.96, 1.02, -0.48);
      ctx.quadraticCurveTo(0.52, 0.94, -1.07, 0.48);
      break;
    case 'water':
      ctx.moveTo(1.02, 0);
      ctx.bezierCurveTo(-0.2, -0.18, -0.14, -0.95, -0.72, -0.64);
      ctx.bezierCurveTo(-1.52, -0.22, -0.92, 0.99, -0.16, 0.67);
      ctx.quadraticCurveTo(0.44, 0.53, 1.02, 0);
      break;
    case 'fire':
      ctx.moveTo(1.03, 0.05);
      ctx.quadraticCurveTo(0.71, -0.91, -0.9, -0.58);
      ctx.quadraticCurveTo(-0.47, -0.25, -0.94, -0.06);
      ctx.lineTo(-1.22, -0.12); ctx.lineTo(-0.8, 0.39);
      ctx.quadraticCurveTo(0.32, 1.02, 1.03, 0.05);
      break;
    case 'earth':
      ctx.moveTo(-0.96, -0.26);
      ctx.lineTo(-0.28, -0.86); ctx.lineTo(0.76, -0.58);
      ctx.lineTo(1.02, 0.14); ctx.lineTo(0.41, 0.74); ctx.lineTo(-0.63, 0.63);
      break;
  }
  ctx.closePath();
}

function impactMark(ctx, el, radius, angle) {
  ctx.beginPath();
  switch (el) {
    case 'metal':
      ctx.moveTo(-radius * 0.75, radius * 0.56); ctx.lineTo(radius * 0.84, -radius * 0.67);
      ctx.moveTo(-radius * 0.32, radius * 0.73); ctx.lineTo(radius * 0.62, -radius * 0.38);
      break;
    case 'wood':
      ctx.moveTo(-radius * 0.68, radius * 0.44);
      ctx.quadraticCurveTo(-radius * 0.22, -radius * 0.7, radius * 0.64, -radius * 0.51);
      ctx.moveTo(-radius * 0.57, radius * 0.53);
      ctx.quadraticCurveTo(radius * 0.22, radius * 0.73, radius * 0.58, radius * 0.2);
      break;
    case 'water':
      ctx.ellipse(0, 0, radius, radius * 0.64, angle, 0.24, Math.PI * 1.57);
      ctx.moveTo(radius * 0.63, 0);
      ctx.ellipse(0, 0, radius * 0.63, radius * 0.43, 0, 0, Math.PI * 1.5);
      break;
    case 'fire':
      ctx.moveTo(-radius * 0.8, radius * 0.17); ctx.lineTo(-radius * 0.33, -radius * 0.1);
      ctx.lineTo(-radius * 0.34, -radius * 0.55); ctx.lineTo(radius * 0.02, -radius * 0.34);
      ctx.lineTo(radius * 0.45, -radius * 0.92); ctx.lineTo(radius * 0.42, -radius * 0.31);
      ctx.lineTo(radius * 0.86, -radius * 0.52);
      break;
    case 'earth':
      ctx.moveTo(-radius * 0.87, radius * 0.36); ctx.lineTo(-radius * 0.48, radius * 0.21);
      ctx.lineTo(-radius * 0.26, radius * 0.44); ctx.lineTo(radius * 0.08, radius * 0.22);
      ctx.lineTo(radius * 0.39, radius * 0.46); ctx.lineTo(radius * 0.8, radius * 0.33);
      break;
  }
}

export class ImpactEffects {
  constructor() {
    this.active = [];
    this.bossFall = null;
    this.heroHit = null;
    this.cameraHit = null;
    this.shieldRaised = null;
    this.shieldContact = null;
  }

  note(ev) {
    if (ev.kind === 'shieldGain') this.shieldRaised = { t: 0 };
    if (ev.shieldContact) {
      const { left, angle } = ev.shieldContact;
      if (left === 0) this.shieldRaised = null;
      // 同帧多次挡击时优先保留碎盾反馈。
      if (this.shieldContact?.t !== 0 || !this.shieldContact.broken || left === 0) {
        this.shieldContact = { t: 0, broken: left === 0, angle: angle ?? Math.PI };
      }
    }
    if (ev.kind === 'kill' && ev.boss) {
      this.bossFall = { x: ev.x, y: ev.y, t: 0 };
      this.kickCamera(8.4, 0);
    }
    const hero = ev.kind === 'hurt';
    const art = ELEMENT_ART[hero ? 'earth' : ev.el];
    if (!(ev.n > 0) || !art || (!ev.impact && !hero)) return;
    const { tier = 1, boss, primary, contact } = ev.impact || {};
    const priority = hero ? 8 : Number(!!ev.crit) * 3 + Number(!!boss) * 2 + Number(tier >= 4) + Number(!!primary);
    const angle = ev.linkFrom ? Math.atan2(ev.y - ev.linkFrom.y, ev.x - ev.linkFrom.x) : (ev.fromAngle ?? (hero ? Math.PI : 0));
    if (hero) this.heroHit = { t: 0, angle };
    if (hero || primary || ev.crit) {
      const strength = hero ? 7.2 : ev.crit ? 6.7 : boss ? 4.8 : tier >= 4 ? 3.6 : 1.9;
      this.kickCamera(strength, angle);
    }
    if (this.active.length >= MAX_IMPACTS) {
      let least = 0;
      for (let i = 1; i < this.active.length; i++) {
        if (this.active[i].priority < this.active[least].priority) least = i;
      }
      if (this.active[least].priority > priority) return;
      this.active.splice(least, 1);
    }
    const inset = primary && !ev.radius ? 15 : 0;
    this.active.push({
      x: contact?.x ?? ev.x - Math.cos(angle) * inset,
      y: contact?.y ?? ev.y - Math.sin(angle) * inset,
      targetX: ev.x, targetY: ev.y, linkFrom: ev.linkFrom, targetName: ev.targetName,
      el: hero ? 'earth' : ev.el, art, priority, angle, crit: ev.crit, hero, primary, contact,
      skillId: ev.skillId, radius: ev.radius,
      t: 0, life: ev.radius && primary ? 0.62 : ev.linkFrom ? 0.52 : ev.crit ? 0.37 : boss ? 0.31 : 0.24,
      reach: hero ? 44 : (26 + tier * 4 + (ev.crit ? 12 : 0)) * (primary ? 1 : 0.75),
      fragments: ev.crit || tier >= 4 ? 6 : primary ? 4 : 3,
    });
  }

  kickCamera(strength, angle) {
    if (!this.cameraHit || this.cameraHit.t >= 0.105 || strength > this.cameraHit.strength) {
      this.cameraHit = { t: 0, strength, angle };
    }
  }

  cameraOffset() {
    const hit = this.cameraHit;
    if (!hit) return { ox: 0, oy: 0 };
    const force = hit.strength * (1 - hit.t / 0.22) ** 2;
    const axis = Math.cos(hit.t * 77), across = Math.sin(hit.t * 101) * 0.36;
    const x = Math.cos(hit.angle), y = Math.sin(hit.angle);
    return { ox: force * (x * axis - y * across), oy: force * (y * axis + x * across) };
  }

  clear() {
    this.active.length = 0;
    this.bossFall = null;
    this.heroHit = null;
    this.cameraHit = null;
    this.shieldRaised = null;
    this.shieldContact = null;
  }

  update(dt) {
    if (this.bossFall && (this.bossFall.t += dt) >= BOSS_FALL_TIME) this.bossFall = null;
    if (this.heroHit && (this.heroHit.t += dt) >= 0.22) this.heroHit = null;
    if (this.cameraHit && (this.cameraHit.t += dt) >= 0.22) this.cameraHit = null;
    if (this.shieldRaised) this.shieldRaised.t += dt;
    if (this.shieldContact && (this.shieldContact.t += dt) >= (this.shieldContact.broken ? 0.38 : 0.22)) this.shieldContact = null;
    if (!this.active.length) return;
    for (const hit of this.active) hit.t += dt;
    this.active = this.active.filter(hit => hit.t < hit.life);
  }

  draw(ctx, skillFxPage) {
    if (!this.active.length && !this.bossFall) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, BATTLE_ASSET_BAR_H, 720, BATTLE_H - BATTLE_ASSET_BAR_H); ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const hit of this.active) {
      const { el, art } = hit;
      const p = hit.t / hit.life;
      const fade = 1 - p * p;
      const radius = hit.reach * (0.38 + 0.62 * (1 - (1 - p) ** 2));
      const drawn = drawSkillImpact(ctx, skillFxPage, hit);
      drawContactDrops(ctx, hit, p);
      if (drawn) continue;
      ctx.save();
      ctx.translate(hit.x, hit.y);
      if (hit.crit) {
        ctx.globalAlpha = 0.69 * fade;
        ctx.strokeStyle = '#ffe5a1'; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.ellipse(0, 0, radius * 1.13, radius * 0.76, -0.23, -0.58, Math.PI * 1.34); ctx.stroke();
      }
      impactMark(ctx, el, radius, -0.14);
      ctx.globalAlpha = 0.7 * fade;
      ctx.strokeStyle = art.dark; ctx.lineWidth = 7; ctx.stroke();
      ctx.globalAlpha = 0.96 * fade;
      ctx.strokeStyle = GEM_COLORS[el]; ctx.lineWidth = 5; ctx.stroke();
      ctx.strokeStyle = art.light; ctx.lineWidth = 2.2; ctx.stroke();
      for (let i = 0; i < hit.fragments; i++) {
        const angle = hit.angle - 2.45 + i * 4.25 / (hit.fragments - 1);
        const distance = radius * (0.68 + (i % 3) * 0.23);
        const size = (hit.crit ? 7.3 : 5.4) * (1 - p * 0.68);
        ctx.save();
        ctx.translate(Math.cos(angle) * distance, Math.sin(angle) * distance + p * p * 13);
        ctx.rotate(angle + p * 0.9);
        ctx.scale(size * art.aspect, size);
        elementPath(ctx, el);
        ctx.fillStyle = art.light; ctx.fill();
        ctx.strokeStyle = art.dark; ctx.lineWidth = 0.16; ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }
    if (this.bossFall) drawBossFall(ctx, this.bossFall);
    ctx.restore();
  }
}

function drawContactDrops(ctx, hit, p) {
  if (!hit.hero && !hit.targetName) return;
  const spirit = hit.targetName === 'slime';
  const color = spirit ? ['#9dd5e6', '#effcff'] : ['#8e3040', '#f58e83'];
  const count = hit.hero || hit.crit ? 8 : hit.primary ? 6 : 3;
  const motion = 1 - (1 - p) ** 2;
  ctx.save();
  ctx.globalAlpha *= (1 - p) ** 1.3;
  for (let i = 0; i < count; i++) {
    const angle = hit.angle - 0.95 + i * 1.9 / (count - 1);
    const reach = (21 + i % 4 * 8 + Number(!!hit.crit) * 13) * motion;
    const x = hit.x + Math.cos(angle) * reach;
    const y = hit.y + Math.sin(angle) * reach - (15 + i % 3 * 3) * motion + p * p * 20;
    const size = (2.1 + i % 3 * 0.55) * (1 - 0.45 * p);
    ctx.fillStyle = color[i % 2];
    ctx.beginPath(); ctx.ellipse(x, y, size * 1.45, size, angle, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawBossFall(ctx, fall) {
  const p = fall.t / BOSS_FALL_TIME;
  const reach = 1 - (1 - p) ** 2;
  const radius = 18 + 86 * reach;
  const fade = (1 - p) ** 1.3;
  ctx.save();
  ctx.translate(fall.x, fall.y + 22);
  ctx.globalAlpha = fade * 0.6;
  ctx.strokeStyle = '#8e4232';
  ctx.lineWidth = 7;
  ctx.beginPath(); ctx.ellipse(0, 0, radius, radius * 0.46, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#ffe0a0'; ctx.lineWidth = 3; ctx.stroke();
  ctx.globalAlpha = fade * 0.8;
  ctx.fillStyle = '#fff0bc';
  for (let i = 0; i < 10; i++) {
    const angle = i * Math.PI / 5 + 0.25;
    const x = Math.cos(angle) * (radius + i % 3 * 11);
    const y = Math.sin(angle) * radius * 0.72 - reach * 31;
    const r = (5 + i % 3) * fade;
    ctx.beginPath(); ctx.moveTo(x, y - r * 1.8); ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
