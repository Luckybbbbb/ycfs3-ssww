// scripts/ui/render.js
// Canvas 渲染:战斗区矢量风景占位(M3 实装)+ 联动栏占位 + 三消棋盘(CC0/CC-BY 宝石贴图)
// 相对路径: scripts/ui/render.js
// 宝石素材与署名: assets/sprites/gems/LICENSE.md(Basic Gems Icon Set - Remix, CC-BY 3.0)

import { BOARD_W, BOARD_H, BOARD_Y, CELL, ELEMENTS, isItem } from '../board/grid.js';
import { roundRect } from './draw_util.js';

const ITEM_ICON = { heal: '❤', invincible: '✦', cd: '⏱' };

// ---- 宝石贴图预载(import.meta.url 解析,兼容子路径部署;未载完前回退色圆) ----
const GEM_SRC = { metal: '#ccccff', wood: '#44ff44', water: '#4488ff', fire: '#ff4444', earth: '#cc8844' };
const GEM_IMG = {};
const GEM_DIR = new URL('../../assets/sprites/gems/', import.meta.url);
for (const el of ELEMENTS) {
  const img = new Image();
  img.src = new URL(`${el}.png`, GEM_DIR).href;
  GEM_IMG[el] = img;
}

export function render(ctx, engine, hud) {
  ctx.clearRect(0, 0, 720, 1280);

  // ===== 战斗区(占位,M3 实装):渐变天空 + 太阳 + 远山 + 树丛 + 草地 =====
  const sky = ctx.createLinearGradient(0, 0, 0, 448);
  sky.addColorStop(0, '#7ec8e3');
  sky.addColorStop(1, '#c9ecf5');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 720, 448);
  // 太阳
  ctx.fillStyle = 'rgba(255,236,150,.9)';
  ctx.beginPath(); ctx.arc(600, 90, 46, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,236,150,.25)';
  ctx.beginPath(); ctx.arc(600, 90, 70, 0, Math.PI * 2); ctx.fill();
  // 云(静态剪影,M3 接视差横移)
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  for (const [x, y, s] of [[120, 70, 1], [340, 120, 0.7], [520, 55, 0.85]]) {
    ctx.beginPath();
    ctx.arc(x, y, 26 * s, 0, Math.PI * 2);
    ctx.arc(x + 30 * s, y - 10 * s, 20 * s, 0, Math.PI * 2);
    ctx.arc(x + 58 * s, y, 24 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // 远山(视差层占位)
  ctx.fillStyle = '#a8cfa8';
  ctx.beginPath();
  ctx.moveTo(0, 330);
  ctx.lineTo(140, 210); ctx.lineTo(260, 330);
  ctx.lineTo(420, 180); ctx.lineTo(560, 330);
  ctx.lineTo(660, 240); ctx.lineTo(720, 330);
  ctx.lineTo(720, 448); ctx.lineTo(0, 448);
  ctx.fill();
  // 树丛(中景)
  ctx.fillStyle = '#7fb37a';
  for (const [x, y, r] of [[80, 360, 40], [170, 375, 32], [300, 365, 42], [470, 372, 36], [620, 362, 40]]) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // 草地(近景)
  const grass = ctx.createLinearGradient(0, 390, 0, 448);
  grass.addColorStop(0, '#6cae57');
  grass.addColorStop(1, '#4f9040');
  ctx.fillStyle = grass;
  ctx.fillRect(0, 396, 720, 52);
  ctx.fillStyle = 'rgba(255,255,255,.4)';
  ctx.font = "24px 'Nunito','Noto Sans SC',sans-serif";
  ctx.textAlign = 'center';
  ctx.fillText('战斗区 · M3 实装', 360, 250);

  // ===== 联动栏占位(M2 实装:5 行档位条 + 4 装配槽) =====
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 448, 720, 56);
  ctx.strokeStyle = '#dcd8d1';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 449, 718, 54);
  ctx.fillStyle = '#9f927d';
  ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
  ctx.fillText('联动栏 · M2 实装（档位充能 → 技能释放）', 360, 483);

  // ===== 三消棋盘 =====
  ctx.fillStyle = '#f8f8f0';
  ctx.fillRect(0, BOARD_Y, BOARD_W, BOARD_H);
  // 棋盘格底:(r+c)%2 微色差,增强格子感
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#f4f3ea' : '#fbfaf4';
      ctx.fillRect(c * CELL, BOARD_Y + r * CELL, CELL, CELL);
    }
  }

  // 棋子(宝石贴图;消除时缩放+白闪)
  for (const cell of engine.cellsForRender()) {
    const x = cell.c * CELL;
    const y = BOARD_Y + cell.r * CELL + cell.offsetY;
    if (isItem(cell)) {
      // 道具格:金底圆角方 + 图标 + 倒计时
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
      // 贴图模式:底部软阴影 + 宝石
      if (cell.offsetY === 0) {
        ctx.fillStyle = 'rgba(90,70,40,.16)';
        ctx.beginPath(); ctx.ellipse(cx, y + CELL - 14, size * 0.38, 7, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    } else {
      // 回退:色圆 + 汉字(素材未载完时)
      ctx.fillStyle = GEM_SRC[el];
      ctx.beginPath(); ctx.arc(cx, cy, 37 * (cell.scale ?? 1), 0, Math.PI * 2); ctx.fill();
    }
    // 消除白闪
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
  const st = engine.paralyzed ? '棋盘瘫痪 · 等待道具过期恢复' : `状态 ${engine.state}`;
  ctx.fillText(`M1 原型 · ${st}`, 360, 1258);

  // 特效层(粒子 + 飞字,由 main.js 驱动 update)
  if (hud.fx) hud.fx.draw(ctx);

  // 事件提示浮层
  if (hud.toast && hud.toast.t > 0) {
    ctx.fillStyle = 'rgba(121,79,39,.85)';
    roundRect(ctx, 210, 516, 300, 44, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = "22px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(hud.toast.text, 360, 545);
  }
}
