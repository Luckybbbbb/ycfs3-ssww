// scripts/ui/render.js
// Canvas 渲染：战斗区占位（M3 实装）+ 联动栏占位 + 三消棋盘
// 相对路径: scripts/ui/render.js

import { BOARD_W, BOARD_H, BOARD_Y, CELL, ELEMENTS, isItem } from '../board/grid.js';

const COLORS = {
  metal: '#ccccff', wood: '#44ff44', water: '#4488ff', fire: '#ff4444', earth: '#cc8844',
};
const NAMES = { metal: '金', wood: '木', water: '水', fire: '火', earth: '土' };
const ITEM_ICON = { heal: '❤', invincible: '✦', cd: '⏱' };

export function render(ctx, engine, hud) {
  ctx.clearRect(0, 0, 720, 1280);

  // ===== 战斗区占位（M3 实装，当前深色底 + 提示） =====
  ctx.fillStyle = '#2f3b2f';
  ctx.fillRect(0, 0, 720, 448);
  ctx.fillStyle = 'rgba(255,255,255,.45)';
  ctx.font = '28px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('战斗区 · M3 实装', 360, 224);

  // ===== 联动栏占位（M2 实装：5 行档位条 + 4 装配槽） =====
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 448, 720, 56);
  ctx.strokeStyle = '#dcd8d1';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 449, 718, 54);
  ctx.fillStyle = '#9f927d';
  ctx.font = '22px sans-serif';
  ctx.fillText('联动栏 · M2 实装（档位充能 → 技能释放）', 360, 483);

  // ===== 三消棋盘 =====
  ctx.fillStyle = '#f8f8f0';
  ctx.fillRect(0, BOARD_Y, BOARD_W, BOARD_H);

  for (const cell of engine.cellsForRender()) {
    const x = cell.c * CELL;
    const y = BOARD_Y + cell.r * CELL + cell.offsetY;
    if (isItem(cell)) {
      // 道具格：金底圆角方 + 图标 + 倒计时
      ctx.globalAlpha = cell.alpha;
      ctx.fillStyle = cell.premium ? '#ffe9b8' : '#ffe9c2';
      roundRect(ctx, x + 8, y + 8, CELL - 16, CELL - 16, 18);
      ctx.fill();
      ctx.strokeStyle = '#f5c31c';
      ctx.lineWidth = 3;
      roundRect(ctx, x + 8, y + 8, CELL - 16, CELL - 16, 18);
      ctx.stroke();
      ctx.fillStyle = '#794f27';
      ctx.font = '30px sans-serif';
      ctx.fillText(ITEM_ICON[cell.item] || '?', x + CELL / 2, y + CELL / 2 - 2);
      ctx.font = '14px sans-serif';
      ctx.fillText(Math.ceil(cell.expire) + 's', x + CELL / 2, y + CELL / 2 + 22);
      ctx.globalAlpha = 1;
      continue;
    }
    ctx.globalAlpha = cell.alpha;
    ctx.fillStyle = COLORS[ELEMENTS[cell.el]];
    ctx.beginPath();
    ctx.arc(x + CELL / 2, y + CELL / 2, 37, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(121,79,39,.35)';
    ctx.lineWidth = 3;
    ctx.stroke();
    const dark = cell.el === 2 || cell.el === 3 || cell.el === 4; // 水/火/土用白字
    ctx.fillStyle = dark ? '#fff' : '#794f27';
    ctx.font = '28px sans-serif';
    ctx.fillText(NAMES[ELEMENTS[cell.el]], x + CELL / 2, y + CELL / 2 + 10);
    ctx.globalAlpha = 1;
  }

  // ===== 底栏 =====
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 1224, 720, 56);
  ctx.fillStyle = '#9f927d';
  ctx.font = '20px sans-serif';
  const st = engine.paralyzed ? '棋盘瘫痪 · 等待道具过期恢复' : `状态 ${engine.state}`;
  ctx.fillText(`M1 原型 · ${st}`, 360, 1258);

  // 事件提示浮层
  if (hud.toast && hud.toast.t > 0) {
    ctx.fillStyle = 'rgba(121,79,39,.85)';
    roundRect(ctx, 210, 516, 300, 44, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '22px sans-serif';
    ctx.fillText(hud.toast.text, 360, 545);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
