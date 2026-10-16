// scripts/battle/projectile.js
// 投射物推进与命中判定(FR-1.3:圆形碰撞;金穿透由 battle 层 hitSet 控制)
// 命中采用扫掠检测(帧内弹道线段到敌心距离),与帧步长无关(REQ-M2-04 整改 2)
// 弹的数据结构与形态逻辑(4.2 档位表)在 scripts/battle/battle.js
// 相对路径: scripts/battle/projectile.js

import { BOLT_SPEED } from '../skills/registry.js';
import { ENEMY_RADIUS, PLAYER_HIT_R } from './enemy.js';

export const BOLT_RADIUS = 9;
export const HIT_R = ENEMY_RADIUS + BOLT_RADIUS;

// 推进一颗弹(直线匀速)。命中判定不再按发射时的 flyTime 门控:
// M3 敌人会移动,发射时距离≠命中时距离,改为每帧对全路径做扫掠检测,
// 谁先挡在弹道上谁先被命中(REQ-M3-03 整改 1)。
export function advanceBolt(b, dt) {
  b.t += dt;
  b.x += BOLT_SPEED * dt;
  return true;
}

// 扫掠命中:本帧弹从 (prevX, y) 水平飞到 (b.x, y),线段到敌心距离 ≤ HIT_R 即可命中。
// 与帧步长无关(帧末位置检测会漏掉跨过碰撞区的步长)。
// 返回按「弹道与碰撞圆首次相交位置」升序:命中顺序=物理相遇顺序,
// 不按敌心 x 排序(同 x 不同 y 的圆进入弹道的先后不同,REQ-M3-04 整改 1)。
export function findHitTargets(b, enemies) {
  const prevX = b.x - BOLT_SPEED * b.lastDt;
  const y = b.y;
  const segLo = Math.min(prevX, b.x);
  const segHi = Math.max(prevX, b.x);
  const cands = [];
  for (const e of enemies) {
    if (!e.alive || b.hitSet.has(e)) continue;
    const er = e.radius || ENEMY_RADIUS;      // FR-1.3:敌人按贴图缩放定(boss 60)
    const R = er + BOLT_RADIUS;
    const dy = e.y - y;
    if (Math.abs(dy) > R) continue;               // 粗筛:y 距离(弦不存在)
    const dxMax = Math.sqrt(R * R - dy * dy);     // 圆与弹道线 y 的弦半长
    const enter = e.x - dxMax, leave = e.x + dxMax; // 相交区间 [enter, leave]
    if (leave < segLo || enter > segHi) continue;   // 本帧线段未触及相交区间
    // 首次相交位置=线段起点与圆进入点的较大者(线段从左往右扫)
    const firstX = Math.max(segLo, enter);
    cands.push({ e, firstX });
  }
  return cands.sort((a, c) => a.firstX - c.firstX).map(c => c.e);
}

// ---- 敌方弹幕(FR-1.2:扇形弹;主角判定半径 40,圆形碰撞) ----

// 推进一颗敌方弹(直线匀速)
export function advanceEnemyBolt(b, dt) {
  b.t += dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
}

// 敌方弹对主角的扫掠命中:帧内线段 (prev)→(b.x,b.y) 到主角中心距离 ≤ PLAYER_HIT_R
// 命中返回 true 并由调用方入账伤害(弹即消散,敌方弹无穿透)
export function enemyBoltHitsPlayer(b, px, py) {
  const prevX = b.x - b.vx * b.lastDt;
  const prevY = b.y - b.vy * b.lastDt;
  const dxs = b.x - prevX, dys = b.y - prevY;
  const lenSq = dxs * dxs + dys * dys;
  // t = 线段上离主角最近的点参数(夹到 [0,1])
  let t = lenSq > 0 ? ((px - prevX) * dxs + (py - prevY) * dys) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = prevX + dxs * t, cy = prevY + dys * t;
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= PLAYER_HIT_R * PLAYER_HIT_R;
}
