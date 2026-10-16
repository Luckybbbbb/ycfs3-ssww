// scripts/battle/projectile.js
// 投射物推进与命中判定(FR-1.3:圆形碰撞;金穿透由 battle 层 hitSet 控制)
// 命中采用扫掠检测(帧内弹道线段到敌心距离),与帧步长无关(REQ-M2-04 整改 2)
// 弹的数据结构与形态逻辑(4.2 档位表)在 scripts/battle/battle.js
// 相对路径: scripts/battle/projectile.js

import { BOLT_SPEED } from '../skills/registry.js';
import { ENEMY_RADIUS } from './enemy.js';

export const BOLT_RADIUS = 9;
export const HIT_R = ENEMY_RADIUS + BOLT_RADIUS;

// 推进一颗弹;返回是否已到飞行时长(可判定命中)
export function advanceBolt(b, dt) {
  b.t += dt;
  b.x += BOLT_SPEED * dt;
  return b.t >= b.flyTime;
}

// 扫掠命中:本帧弹从 (prevX, y) 水平飞到 (b.x, y),线段到敌心距离 ≤ HIT_R 即可命中。
// 与帧步长无关(帧末位置检测会漏掉跨过碰撞区的步长)。
export function findHitTargets(b, enemies) {
  const prevX = b.x - BOLT_SPEED * b.lastDt;
  const y = b.y;
  const lo = Math.min(prevX, b.x) - HIT_R;
  const hi = Math.max(prevX, b.x) + HIT_R;
  const cands = [];
  for (const e of enemies) {
    if (!e.alive || b.hitSet.has(e)) continue;
    if (e.x < lo || e.x > hi) continue;           // 粗筛:x 区间
    const dy = e.y - y;
    if (Math.abs(dy) > HIT_R) continue;           // 粗筛:y 距离
    // 点到水平线段的最近距离(线段 y=const, x∈[min(prevX,b.x), max(...)])
    const cx = Math.max(Math.min(prevX, b.x), Math.min(e.x, Math.max(prevX, b.x)));
    const dx = e.x - cx;
    if (dx * dx + dy * dy <= HIT_R * HIT_R) cands.push(e);
  }
  return cands.sort((a, c) =>
    (a.x - 110) * (a.x - 110) + (a.y - 280) * (a.y - 280) -
    ((c.x - 110) * (c.x - 110) + (c.y - 280) * (c.y - 280)));
}
