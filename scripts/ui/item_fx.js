// scripts/ui/item_fx.js
// 道具用掉后的棋盘反馈、主角治疗和无敌护罩。

import { BOARD_W, BOARD_H, BOARD_Y } from '../board/grid.js';
import { PLAYER_X } from '../skills/registry.js';

const ITEM_COLORS = {
  heal: { edge: '#c24768', light: '#ffe6eb' },
  invincible: { edge: '#ac6c24', light: '#fff0a9' },
  cd: { edge: '#327d9e', light: '#c5f5ff' },
};
const TAU = Math.PI * 2;
const PICKUP_TIME = 0.42;
const HEAL_TIME = 0.78;
const MAX_PICKUPS = 6;

function cross(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
  ctx.stroke();
}

export class ItemEffects {
  constructor() {
    this.active = [];
  }

  trigger(kind, x, y, premium, healed = 0) {
    if (!ITEM_COLORS[kind]) return;
    if (this.active.length >= MAX_PICKUPS) this.active.shift();
    this.active.push({ kind, x, y, premium, healed, t: 0 });
  }

  update(dt) {
    if (!this.active.length) return;
    for (const cue of this.active) cue.t += dt;
    this.active = this.active.filter(cue => cue.t < (cue.healed > 0 ? HEAL_TIME : PICKUP_TIME));
  }

  clear() { this.active.length = 0; }

  drawBoard(ctx) {
    if (!this.active.length) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, BOARD_Y, BOARD_W, BOARD_H); ctx.clip();
    for (const cue of this.active) {
      if (cue.t >= PICKUP_TIME) continue;
      const p = cue.t / PICKUP_TIME;
      const radius = 12 + (cue.premium ? 38 : 31) * (1 - (1 - p) ** 2);
      const { edge, light } = ITEM_COLORS[cue.kind];
      ctx.globalAlpha = (1 - p) * 0.9;
      ctx.beginPath(); ctx.arc(cue.x, cue.y, radius, 0, TAU);
      ctx.strokeStyle = edge; ctx.lineWidth = 6; ctx.stroke();
      ctx.strokeStyle = light; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = light;
      for (let i = 0; i < (cue.premium ? 8 : 6); i++) {
        const angle = i * Math.PI / (cue.premium ? 4 : 3) - Math.PI / 2;
        const x = cue.x + Math.cos(angle) * (radius + 7);
        const y = cue.y + Math.sin(angle) * (radius + 7);
        ctx.beginPath(); ctx.arc(x, y, 3 * (1 - p) + 1, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
  }

  drawHeal(ctx) {
    const cue = this.active.findLast(cue => cue.healed > 0);
    if (!cue) return;
    const p = cue.t / HEAL_TIME;
    const { edge, light } = ITEM_COLORS.heal;
    ctx.save();
    ctx.globalAlpha = Math.min(1, p * 10) * (1 - p);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(PLAYER_X, 411, 28 + p * 39, 8 + p * 5, 0, 0, TAU);
    ctx.strokeStyle = edge; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = light; ctx.lineWidth = 3; ctx.stroke();
    for (let i = 0; i < (cue.premium ? 6 : 4); i++) {
      const phase = i * 1.65 + p * 3.4;
      const x = PLAYER_X + Math.cos(phase) * (39 + i * 3);
      const y = 394 - (54 + i * 12) * p - i * 12;
      const size = (5 + i % 2 * 2) * (1 - p * 0.5);
      ctx.strokeStyle = edge; ctx.lineWidth = 5; cross(ctx, x, y, size);
      ctx.strokeStyle = light; ctx.lineWidth = 2.6; cross(ctx, x, y, size);
    }
    ctx.restore();
  }

  drawShield(ctx, remaining, animated) {
    if (!(remaining > 0)) return;
    const opacity = animated ? Math.min(1, remaining * 2) : 1;
    const cue = animated && this.active.findLast(cue => cue.kind === 'invincible');
    const pop = cue ? Math.sin(Math.PI * cue.t / PICKUP_TIME) * (1 - cue.t / PICKUP_TIME) : 0;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(PLAYER_X, 307);
    const rim = ctx.createLinearGradient(-88, -108, 84, 100);
    rim.addColorStop(0, '#fff3a6'); rim.addColorStop(0.46, '#ffce68'); rim.addColorStop(1, '#a76c27');
    ctx.beginPath(); ctx.ellipse(0, 0, 84 + pop * 8, 103 + pop * 5, 0, 0, TAU);
    ctx.fillStyle = 'rgba(255,211,103,.12)'; ctx.fill();
    ctx.strokeStyle = 'rgba(97,54,20,.66)'; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = rim; ctx.lineWidth = 3 + pop * 3; ctx.stroke();
    if (animated) {
      const angle = -1.6 + remaining * 1.7;
      ctx.beginPath(); ctx.ellipse(0, 0, 89 + pop * 8, 108 + pop * 5, 0, angle, angle + 0.95);
      ctx.strokeStyle = '#fff6d3'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
    }
    ctx.restore();
  }
}
