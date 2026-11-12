// scripts/ui/combat_fx.js
// 五行弹道与命中表现。画面读取已结算事件，所有尺寸均为逻辑像素。

import { BATTLE_ASSET_BAR_H, GEM_COLORS } from './draw_util.js';
import { BATTLE_H } from '../battle/parallax.js';

const ELEMENT_ART = {
  metal: { light: '#fff2ae', dark: '#865720', aspect: 1.64, trail: 46 },
  wood: { light: '#dff5a1', dark: '#2d6e45', aspect: 1.34, trail: 31 },
  water: { light: '#d7faff', dark: '#235c8c', aspect: 1.43, trail: 40 },
  fire: { light: '#ffe0a0', dark: '#9f3540', aspect: 1.56, trail: 50 },
  earth: { light: '#f3ca91', dark: '#533b35', aspect: 1.07, trail: 26 },
};
const MAX_IMPACTS = 12;

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

export function drawElementBolt(ctx, bolt, effects) {
  const el = bolt.el;
  const art = ELEMENT_ART[el];
  if (!art) return;
  const tier = Math.max(1, Math.min(5, bolt.tier || 1));
  const radius = 8.6 + tier * 0.85;
  const trail = art.trail + (tier - 1) * 4;
  ctx.save();
  ctx.translate(bolt.x, bolt.y);
  ctx.rotate(Math.atan2(bolt.vy || 0, bolt.vx || 1));
  ctx.lineJoin = 'round';
  if (effects) {
    ctx.globalAlpha = 0.36;
    ctx.fillStyle = art.dark;
    ctx.beginPath();
    ctx.moveTo(-trail, 0); ctx.quadraticCurveTo(-radius, -radius, 4, -5);
    ctx.lineTo(4, 5); ctx.quadraticCurveTo(-radius, radius, -trail, 0);
    ctx.fill();
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = GEM_COLORS[el];
    ctx.beginPath();
    ctx.moveTo(-trail + 4, 0); ctx.lineTo(1, -3.4); ctx.lineTo(1, 3.4); ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.scale(radius * art.aspect, radius);
  elementPath(ctx, el);
  ctx.fillStyle = GEM_COLORS[el]; ctx.fill();
  ctx.strokeStyle = art.dark; ctx.lineWidth = 0.16; ctx.stroke();
  ctx.translate(-0.02, -0.06); ctx.scale(0.65, 0.56);
  elementPath(ctx, el);
  ctx.fillStyle = art.light; ctx.fill();
  ctx.restore();
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
  }

  note(ev) {
    const art = ELEMENT_ART[ev.el];
    if (!ev.impact || !art || !(ev.n > 0)) return;
    const { tier = 1, boss, primary } = ev.impact;
    const priority = Number(!!ev.crit) * 3 + Number(!!boss) * 2 + Number(tier >= 4) + Number(!!primary);
    if (this.active.length >= MAX_IMPACTS) {
      let least = 0;
      for (let i = 1; i < this.active.length; i++) {
        if (this.active[i].priority < this.active[least].priority) least = i;
      }
      if (this.active[least].priority > priority) return;
      this.active.splice(least, 1);
    }
    const angle = ev.fromAngle ?? 0;
    const contact = primary ? 15 : 0;
    this.active.push({
      x: ev.x - Math.cos(angle) * contact, y: ev.y - Math.sin(angle) * contact,
      el: ev.el, art, priority, angle, crit: ev.crit,
      t: 0, life: ev.crit ? 0.37 : boss ? 0.31 : 0.24,
      reach: (26 + tier * 4 + (ev.crit ? 12 : 0)) * (primary ? 1 : 0.75),
      fragments: ev.crit || tier >= 4 ? 6 : primary ? 4 : 3,
    });
  }

  clear() { this.active.length = 0; }

  update(dt) {
    if (!this.active.length) return;
    for (const hit of this.active) hit.t += dt;
    this.active = this.active.filter(hit => hit.t < hit.life);
  }

  draw(ctx) {
    if (!this.active.length) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, BATTLE_ASSET_BAR_H, 720, BATTLE_H - BATTLE_ASSET_BAR_H); ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const hit of this.active) {
      const { el, art } = hit;
      const p = hit.t / hit.life;
      const fade = 1 - p * p;
      const radius = hit.reach * (0.38 + 0.62 * (1 - (1 - p) ** 2));
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
    ctx.restore();
  }
}
