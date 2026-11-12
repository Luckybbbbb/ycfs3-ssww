// scripts/ui/board_guide.js
// 首次消除引导：从实际棋盘选示例，所有提示均在输入层上方绘制。

import { BOARD_Y, CELL, COLS, ELEMENTS, ROWS, isPiece, matchBlocksAfterSwap } from '../board/grid.js';
import { GEM_COLORS, roundRect } from './draw_util.js';

export const BOARD_GUIDE_SKIP = { x: 540, y: 1180, w: 148, h: 88 };

export function firstMatchMove(grid, preferredElements = []) {
  let best = null;
  let bestScore = -Infinity;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!isPiece(grid[r][c])) continue;
    const origin = { r, c };
    for (const target of [{ r, c: c + 1 }, { r: r + 1, c }]) {
      const next = grid[target.r]?.[target.c];
      if (!isPiece(next) || next.el === grid[r][c].el) continue;
      const matches = matchBlocksAfterSwap(grid, r, c, target.r, target.c);
      for (const match of matches) {
        const landsAtOrigin = match.el === next.el;
        const from = landsAtOrigin ? target : origin;
        const to = landsAtOrigin ? origin : target;
        const line = match.cells.length === 3 && (
          match.cells.every(cell => cell.r === to.r) || match.cells.every(cell => cell.c === to.c)
        );
        const element = ELEMENTS[match.el];
        const score = Number(line) * 60 + Number(preferredElements.includes(element)) * 30 +
          Number(matches.length === 1) * 12 - Math.abs(to.r - 3) * 2 - Math.abs(to.c - 3.5);
        if (score <= bestScore) continue;
        best = { from, to, cells: match.cells, element, line };
        bestScore = score;
      }
    }
  }
  return best;
}

function outlineCell(ctx, cell, color, alpha, width) {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  roundRect(ctx, cell.c * CELL + 4, BOARD_Y + cell.r * CELL + 4, CELL - 8, CELL - 8, 16);
  ctx.stroke();
}

function drawMove(ctx, move, pulse) {
  const { from, to, cells } = move;
  for (const cell of cells) outlineCell(ctx, cell, '#b9832e', 0.75, 3);
  outlineCell(ctx, to, '#865315', 0.98, 6);
  outlineCell(ctx, to, '#ffdc7d', 1, 3);
  outlineCell(ctx, from, '#205f50', 1, 7);
  outlineCell(ctx, from, '#a5f1bf', 0.78 + pulse * 0.22, 3.5);

  const x = (from.c + 0.5) * CELL, y = BOARD_Y + (from.r + 0.5) * CELL;
  const angle = Math.atan2(to.r - from.r, to.c - from.c);
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.translate(CELL * (0.43 + pulse * 0.11), 0);
  ctx.beginPath();
  ctx.moveTo(-19, -7); ctx.lineTo(0, -7); ctx.lineTo(0, -14);
  ctx.lineTo(19, 0); ctx.lineTo(0, 14); ctx.lineTo(0, 7); ctx.lineTo(-19, 7);
  ctx.closePath();
  ctx.fillStyle = '#fff0b5'; ctx.fill();
  ctx.strokeStyle = '#51452d'; ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.restore();
}

export function drawBoardHint(ctx, move, time, effects) {
  ctx.save();
  drawMove(ctx, move, effects ? 0.5 + 0.5 * Math.sin(time * 5.5) : 0.5);
  ctx.restore();
}

function drawSlot(ctx, slot, element, pulse) {
  const r = 39 + pulse * 3;
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = '#fff1bf';
  ctx.lineWidth = 5;
  roundRect(ctx, slot.x - r, slot.y - r, r * 2, r * 2, 19); ctx.stroke();
  ctx.strokeStyle = GEM_COLORS[element] || '#205f50';
  ctx.lineWidth = 2;
  roundRect(ctx, slot.x - r - 3, slot.y - r - 3, r * 2 + 6, r * 2 + 6, 20); ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawBoardGuide(ctx, guide, time, effects) {
  const pulse = effects ? 0.5 + 0.5 * Math.sin(time * 5.5) : 0.5;
  ctx.save();
  if (guide.mode === 'swap') drawMove(ctx, guide.move, pulse);
  if (guide.mode === 'complete' && guide.slot) drawSlot(ctx, guide.slot, guide.element, pulse);
  ctx.globalAlpha = 1;
  const swap = guide.mode === 'swap', done = guide.mode === 'complete';
  const title = swap ? '交换高亮的棋子' : done ? `已释放「${guide.skill}」` : '消除成功，技能正在蓄势';
  const hint = swap ? (guide.move.line ? '沿箭头拖动，或依次点两格，连成同色三连' : '沿箭头拖动，或依次点两格，连起同色棋子')
    : done ? '继续消除，为下一次出招蓄能' : '看上方，主角会自动出招';
  ctx.fillStyle = '#16453d';
  roundRect(ctx, 16, 1178, 688, 92, 18); ctx.fill();
  ctx.strokeStyle = '#b79659'; ctx.lineWidth = 2;
  roundRect(ctx, 16, 1178, 688, 92, 18); ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff2c4'; ctx.font = "bold 28px 'Nunito','Noto Sans SC',sans-serif";
  ctx.fillText(title, 38, 1216, 480);
  ctx.fillStyle = '#d6eade'; ctx.font = "22px 'Nunito','Noto Sans SC',sans-serif";
  ctx.fillText(hint, 38, 1248, done ? 640 : 480);
  if (!done) {
    const skip = BOARD_GUIDE_SKIP;
    ctx.fillStyle = '#f2e9cc';
    roundRect(ctx, skip.x, skip.y + 10, skip.w, skip.h - 20, 15); ctx.fill();
    ctx.fillStyle = '#344237';
    ctx.font = "bold 23px 'Nunito','Noto Sans SC',sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('跳过', skip.x + skip.w / 2, skip.y + skip.h / 2 + 9);
  }
  ctx.restore();
}
