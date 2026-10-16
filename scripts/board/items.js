// scripts/board/items.js
// 消耗品道具格：生成/点击生效/超时移除（02 文档第 6 节，D10）
// 效果数值: 回血 30%/45% maxHP、无敌 3/4.5s、CD 加速 5/7.5s ×2（高级 ×1.5 效果）
// 相对路径: scripts/board/items.js

import { ROWS, COLS, isItem } from './grid.js';

export const ITEM_TYPES = ['heal', 'invincible', 'cd'];
export const ITEM_LIFETIME = 10; // 秒

// 四连 → 普通，≥5 连 → 高级（效果 ×1.5）
export function rollItem(count, rng) {
  const premium = count >= 5;
  const type = ITEM_TYPES[Math.floor(rng() * ITEM_TYPES.length)];
  return { item: type, premium, expire: ITEM_LIFETIME };
}

// 生成：占用消除区域中心格（若被占则任一空格；无空格则放弃）
export function placeItem(grid, clearedCells, item, rng) {
  const empty = clearedCells.filter(({r, c}) => grid[r][c] === null);
  if (!empty.length) return null;
  const spot = empty[Math.floor(rng() * empty.length)];
  grid[spot.r][spot.c] = { ...item };
  return spot;
}

// 每帧倒计时；返回过期道具格列表（调用方对其走标准下落补位）
export function tickItems(grid, dt) {
  const expired = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const cell = grid[r][c];
    if (!isItem(cell)) continue;
    cell.expire -= dt;
    if (cell.expire <= 0) { expired.push({ r, c }); grid[r][c] = null; }
  }
  return expired;
}

// 点击生效 → 返回效果描述（M1 只回传给 UI/未来战斗层；数值见 02 文档第 6 节）
export function applyItem(cell, ctx) {
  const mult = cell.premium ? 1.5 : 1;
  switch (cell.item) {
    case 'heal': return { kind: 'heal', amount: Math.round(ctx.maxHP * 0.30 * mult) };
    case 'invincible': return { kind: 'invincible', seconds: 3.0 * mult };
    case 'cd': return { kind: 'cd', seconds: 5.0 * mult, rate: 2 };
  }
  return null;
}
