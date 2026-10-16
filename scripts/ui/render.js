// scripts/ui/render.js
// Canvas 渲染:战斗区(M2 实装:序列帧主角/敌人+弹+血条)+ 联动栏(档位条+装配槽)+ 三消棋盘
// 相对路径: scripts/ui/render.js
// 素材: player/slime 序列帧复用 godot-roguelike(04 文档第 6 节帧清单);宝石见 gems/LICENSE.md

import { BOARD_W, BOARD_H, BOARD_Y, CELL, ELEMENTS, isItem } from '../board/grid.js';
import { roundRect } from './draw_util.js';
import { PLAYER_X, ENEMY_STOP_X, TIER_MULT } from '../skills/registry.js';

const ITEM_ICON = { heal: '❤', invincible: '✦', cd: '⏱' };
const GEM_SRC = { metal: '#ccccff', wood: '#44ff44', water: '#4488ff', fire: '#ff4444', earth: '#cc8844' };
const GEM_IMG = {};
const GEM_DIR = new URL('../../assets/sprites/gems/', import.meta.url);
for (const el of ELEMENTS) {
  const img = new Image();
  img.src = new URL(`${el}.png`, GEM_DIR).href;
  GEM_IMG[el] = img;
}

// 序列帧预载(player idle 16 帧 ×0.25=180×320;slime 15 帧 ×0.5)
function loadSeq(dir, prefix, count, pad) {
  const frames = [];
  for (let i = 1; i <= count; i++) {
    const img = new Image();
    const n = pad ? String(i).padStart(3, '0') : String(i).padStart(2, '0');
    img.src = new URL(`../../assets/sprites/${dir}/${prefix}${n}.png`, import.meta.url).href;
    frames.push(img);
  }
  return frames;
}
const PLAYER_FRAMES = loadSeq('player', 'idle_', 16, false);
const SLIME_FRAMES = [];
for (const n of ['001','004','007','010','013','016','019','022','025','028','031','034','037','039','045']) {
  const img = new Image();
  img.src = new URL(`../../assets/sprites/slime/s_${n}_nobg.png`, import.meta.url).href;
  SLIME_FRAMES.push(img);
}
const seqFrame = (frames, t, fps) => frames[Math.floor(t * fps) % frames.length];

let worldT = 0; // 表现层动画时钟

export function render(ctx, engine, hud) {
  worldT += 1 / 60;
  ctx.clearRect(0, 0, 720, 1280);
  const battle = hud.battle;

  // ===== 战斗区背景(视差三层底子,M3 接动态) =====
  const sky = ctx.createLinearGradient(0, 0, 0, 448);
  sky.addColorStop(0, '#7ec8e3');
  sky.addColorStop(1, '#c9ecf5');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 720, 448);
  ctx.fillStyle = 'rgba(255,236,150,.9)';
  ctx.beginPath(); ctx.arc(600, 90, 46, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,236,150,.25)';
  ctx.beginPath(); ctx.arc(600, 90, 70, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  for (const [x, y, s] of [[120, 70, 1], [340, 120, 0.7], [520, 55, 0.85]]) {
    ctx.beginPath();
    ctx.arc(x, y, 26 * s, 0, Math.PI * 2);
    ctx.arc(x + 30 * s, y - 10 * s, 20 * s, 0, Math.PI * 2);
    ctx.arc(x + 58 * s, y, 24 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#a8cfa8';
  ctx.beginPath();
  ctx.moveTo(0, 330); ctx.lineTo(140, 210); ctx.lineTo(260, 330);
  ctx.lineTo(420, 180); ctx.lineTo(560, 330);
  ctx.lineTo(660, 240); ctx.lineTo(720, 330);
  ctx.lineTo(720, 448); ctx.lineTo(0, 448);
  ctx.fill();
  const grass = ctx.createLinearGradient(0, 390, 0, 448);
  grass.addColorStop(0, '#6cae57');
  grass.addColorStop(1, '#4f9040');
  ctx.fillStyle = grass;
  ctx.fillRect(0, 396, 720, 52);

  if (battle) {
    // ===== 敌人(slime 序列帧 ×0.5 ≈ 107×193) =====
    for (const e of battle.enemies) {
      if (!e.alive) {
        if (e.deathT < 0.4) {
          e.deathT += 1 / 60;
          ctx.globalAlpha = 1 - e.deathT / 0.4;
          drawSlime(ctx, e, 1 + e.deathT * 2);
          ctx.globalAlpha = 1;
        }
        continue;
      }
      drawSlime(ctx, e, 1);
      // 血条
      const bw = 80, bx = e.x - bw / 2, by = e.y - 105;
      ctx.fillStyle = 'rgba(0,0,0,.4)';
      roundRect(ctx, bx - 2, by - 2, bw + 4, 10, 5); ctx.fill();
      ctx.fillStyle = '#e5484d';
      roundRect(ctx, bx, by, Math.max(0, bw * e.hp / e.maxHp), 6, 3); ctx.fill();
      // 灼烧标记
      if (e.burn) { ctx.fillStyle = '#ff7744'; ctx.font = '16px sans-serif'; ctx.fillText('🔥', e.x + 30, e.y - 90); }
      // 减速标记
      if (e.slowT > 0) { ctx.fillStyle = '#88ccff'; ctx.font = '16px sans-serif'; ctx.fillText('❄', e.x - 38, e.y - 90); }
    }
    // ===== 技能弹 =====
    for (const b of battle.bolts) {
      ctx.fillStyle = GEM_SRC[b.el];
      ctx.shadowColor = GEM_SRC[b.el];
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(b.x, b.y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    // ===== 主角(player idle 16 帧,720×1280×0.25=180×320,站位 x≈110) =====
    const pf = seqFrame(PLAYER_FRAMES, worldT, 8);
    if (pf && pf.complete && pf.naturalWidth > 0) {
      ctx.drawImage(pf, PLAYER_X - 90, 448 - 320, 180, 320);
    } else {
      ctx.fillStyle = '#3f6fb5';
      roundRect(ctx, PLAYER_X - 40, 448 - 220, 80, 220, 24); ctx.fill();
    }
    // 主角 HP/护盾条(战斗区左上)
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    roundRect(ctx, 16, 16, 200, 34, 10); ctx.fill();
    ctx.fillStyle = '#3fae5c';
    roundRect(ctx, 20, 20, Math.max(0, 192 * battle.hp / battle.maxHp), 16, 6); ctx.fill();
    if (battle.shield > 0) {
      ctx.fillStyle = '#8fd3e8';
      roundRect(ctx, 20, 38, Math.max(0, 192 * battle.shield / Math.round(battle.maxHp * 0.3)), 8, 4); ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = "12px 'Nunito','Noto Sans SC',sans-serif";
    ctx.textAlign = 'left';
    ctx.fillText(`HP ${battle.hp}/${battle.maxHp}`, 24, 33);
    ctx.textAlign = 'center';
  }

  // ===== 联动栏(M2 实装:5 行档位条 + 4 装配槽) =====
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 448, 720, 56);
  ctx.strokeStyle = '#dcd8d1';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 449, 718, 54);
  if (hud.charge) {
    // 5 行档位条(每行 90px 宽:小色块 ×5 表示档位)
    for (let i = 0; i < 5; i++) {
      const el = ELEMENTS[i];
      const x0 = 12 + i * 92;
      const t = hud.charge.tiers[el];
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = k < t ? GEM_SRC[el] : 'rgba(0,0,0,.10)';
        roundRect(ctx, x0 + k * 15, 460 + (i % 2) * 12, 12, 14, 3); ctx.fill();
      }
    }
    // 4 装配槽(宝石图 + CD 扫描)
    if (hud.caster) {
      hud.caster.loadout.forEach((el, i) => {
        const x = 500 + i * 52;
        ctx.fillStyle = '#fff';
        roundRect(ctx, x, 458, 44, 36, 8); ctx.fill();
        const img = GEM_IMG[el];
        if (img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, x + 6, 462, 32, 28);
        else { ctx.fillStyle = GEM_SRC[el]; roundRect(ctx, x + 6, 462, 32, 28, 6); ctx.fill(); }
        const cd = hud.caster.cds[el];
        if (cd > 0) {
          ctx.fillStyle = 'rgba(0,0,0,.45)';
          roundRect(ctx, x, 458, 44 * (cd / 2.0), 36, 8); ctx.fill();
        }
      });
    }
  }

  // ===== 三消棋盘 =====
  ctx.fillStyle = '#f8f8f0';
  ctx.fillRect(0, BOARD_Y, BOARD_W, BOARD_H);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#f4f3ea' : '#fbfaf4';
      ctx.fillRect(c * CELL, BOARD_Y + r * CELL, CELL, CELL);
    }
  }
  for (const cell of engine.cellsForRender()) {
    const x = cell.c * CELL + (cell.offsetX || 0);
    const y = BOARD_Y + cell.r * CELL + cell.offsetY;
    if (isItem(cell)) {
      ctx.globalAlpha = cell.alpha;
      ctx.fillStyle = cell.premium ? '#ffe9b8' : '#ffe9c2';
      roundRect(ctx, x + 8, y + 8, CELL - 16, CELL - 16, 18);
      ctx.fill();
      ctx.strokeStyle = '#f5c31c';
      ctx.lineWidth = 3;
      roundRect(ctx, x + 8, y + 8, CELL - 16, CELL - 16, 18);
      ctx.stroke();
      ctx.fillStyle = '#794f27';
      ctx.font = "30px 'Nunito','Noto Sans SC',sans-serif";
      ctx.fillText(ITEM_ICON[cell.item] || '?', x + CELL / 2, y + CELL / 2 - 2);
      ctx.font = "14px 'Nunito','Noto Sans SC',sans-serif";
      ctx.fillText(Math.ceil(cell.expire) + 's', x + CELL / 2, y + CELL / 2 + 22);
      ctx.globalAlpha = 1;
      continue;
    }
    const el = ELEMENTS[cell.el];
    const img = GEM_IMG[el];
    const cx = x + CELL / 2, cy = y + CELL / 2;
    const size = 74 * (cell.scale ?? 1);
    ctx.globalAlpha = cell.alpha;
    if (img && img.complete && img.naturalWidth > 0) {
      if (cell.offsetY === 0) {
        ctx.fillStyle = 'rgba(90,70,40,.16)';
        ctx.beginPath(); ctx.ellipse(cx, y + CELL - 14, size * 0.38, 7, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    } else {
      ctx.fillStyle = GEM_SRC[el];
      ctx.beginPath(); ctx.arc(cx, cy, 37 * (cell.scale ?? 1), 0, Math.PI * 2); ctx.fill();
    }
    if (cell.flash > 0) {
      ctx.globalAlpha = cell.flash * 0.8;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(cx, cy, 40, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ===== 底栏 =====
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 1224, 720, 56);
  ctx.fillStyle = '#9f927d';
  ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
  const st = engine.paralyzed ? '棋盘瘫痪 · 等待恢复' : `M2 · 击杀 ${hud.battle ? hud.battle.kills : 0}`;
  ctx.fillText(st, 360, 1258);

  // 特效层
  if (hud.fx) hud.fx.draw(ctx);

  // 事件提示浮层
  if (hud.toast && hud.toast.t > 0) {
    ctx.fillStyle = 'rgba(121,79,39,.85)';
    roundRect(ctx, 180, 516, 360, 44, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(hud.toast.text, 360, 545);
  }
}

function drawSlime(ctx, e, scale) {
  const f = seqFrame(SLIME_FRAMES, worldT + e.y, 8);
  const w = 107 * scale, h = 193 * scale;
  if (f && f.complete && f.naturalWidth > 0) {
    ctx.drawImage(f, e.x - w / 2, e.y - h / 2, w, h);
  } else {
    ctx.fillStyle = '#5fae5f';
    ctx.beginPath(); ctx.ellipse(e.x, e.y, 45 * scale, 70 * scale, 0, 0, Math.PI * 2); ctx.fill();
  }
}
void TIER_MULT; void ENEMY_STOP_X;
