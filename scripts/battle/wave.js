// scripts/battle/wave.js
// 敌人类型表 / 成长公式 / 关卡权重表 / 波次编排(潮汐拆分)
// 数值依据: docs/design/04-敌人设计.md 第 1/3/4/6 节、docs/design/05-关卡设计.md 第 1/4 节
// 相对路径: scripts/battle/wave.js

// ---- 敌人类型表(04 文档第 1 节总表 + 第 6 节帧清单,帧号非等差必须按数组加载) ----
export const ENEMY_TYPES = {
  slime:  { dir: 'slime',    prefix: 's_', frames: [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34, 37, 39, 45], fps: 8,
            hpMult: 1.0, dmgMult: 1.0, srcW: 214, srcH: 385, scale: 0.5, radius: 45 },
  fox:    { dir: 'fox_anim', prefix: 'f_', frames: [1, 10, 20, 30, 40, 50, 60, 70], fps: 8,
            hpMult: 1.2, dmgMult: 1.1, srcW: 216, srcH: 216, scale: 0.8, radius: 45 },
  zombie: { dir: 'zombie',   prefix: 'z_', frames: [12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32], fps: 8,
            hpMult: 1.4, dmgMult: 1.2, srcW: 149, srcH: 201, scale: 0.8, radius: 45 },
  snake:  { dir: 'snake',    prefix: 'f_', frames: [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110], fps: 8,
            hpMult: 1.6, dmgMult: 1.4, srcW: 144, srcH: 192, scale: 0.8, radius: 45 },
  tiger:  { dir: 'tiger',    prefix: 'f_', frames: [1, 7, 10, 13, 16, 19, 22, 23, 24], fps: 10,
            hpMult: 2.0, dmgMult: 1.7, srcW: 216, srcH: 288, scale: 0.6, radius: 45 },
  boss:   { dir: 'boss',     prefix: 'b_', frames: [22, 31, 40, 49, 58, 67, 76, 85, 94, 103, 112, 121, 130, 139, 148, 157, 166, 175, 184], fps: 10,
            hpMult: 3.0, dmgMult: 2.5, srcW: 432, srcH: 432, scale: 0.4, radius: 60 },
};

// ---- 成长公式(w = w_global,04 文档第 3 节;计算浮点、入实体时 round,03 文档 4.4) ----
export const enemyHp = (type, w) =>
  Math.round(30 * ENEMY_TYPES[type].hpMult * (1 + (w - 1) * 0.12));
// 面板伤害 = round(浮点 DMG)
export const enemyDmg = (type, w) =>
  Math.round(8 * ENEMY_TYPES[type].dmgMult * (1 + (w - 1) * 0.10));
// 弹幕伤害 = round(浮点 DMG × 0.5)——先乘后取整(03 文档 4.4:fox 首波 8.8→4.4→4)
export const barrageDmg = (type, w) =>
  Math.round(8 * ENEMY_TYPES[type].dmgMult * (1 + (w - 1) * 0.10) * 0.5);
export const enemySpd = (w) => 150 * (1 + (w - 1) * 0.03);
export const attackInterval = (w) => Math.max(1.2, 2.0 - (w - 1) * 0.04);
export const barrageCount = (w) => 1 + Math.floor((w - 1) / 3);
export const fanAngle = (w) => 15 + barrageCount(w) * 5; // 度
export const barrageSpeed = (w) => 300 + 5 * w;

// ---- 关卡编成权重表(05 文档第 4 节;草案数值,集中于此调参) ----
// Boss 护卫 = 本关权重最高的小怪(并列取表序靠前,04 文档第 4 节)
export const LEVEL_WEIGHTS = [
  /* L1 */ { slime: 60, fox: 40 },
  /* L2 */ { slime: 40, fox: 30, zombie: 30 },
  /* L3 */ { slime: 30, fox: 20, zombie: 25, snake: 25 },
  /* L4 */ { slime: 25, fox: 15, zombie: 20, snake: 20, tiger: 20 },
  /* L5+*/ { slime: 10, fox: 20, zombie: 20, snake: 25, tiger: 25 },
];
export function levelWeights(L) { return LEVEL_WEIGHTS[Math.min(L, LEVEL_WEIGHTS.length) - 1]; }
export function guardType(L) {
  const w = levelWeights(L);
  let best = null, bestW = -1;
  for (const k of Object.keys(w)) if (w[k] > bestW) { bestW = w[k]; best = k; }
  return best;
}

// 按权重随机选类型(rng 注入,种子固定可复现)
export function pickType(L, rng) {
  const w = levelWeights(L);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (const k of Object.keys(w)) { r -= w[k]; if (r < 0) return k; }
  return Object.keys(w)[Object.keys(w).length - 1];
}

// ---- 波次编排(04 文档第 4 节) ----
// 每波敌人数 = 4 + 2×w_local(第 10 波除外:Boss×1 + 护卫×2)
export function waveEnemyCount(wLocal) { return 4 + 2 * wLocal; }
export function isBossWave(wLocal) { return wLocal === 10; }

// 潮汐拆分:潮数 = ceil(敌数/5),每潮 3~5 只、末潮补余数(1~5 只,不受 3 只下限约束)
// 拆分法:base = ⌊敌数/潮数⌋,余数 rem 逐潮 +1(前 rem 潮多 1)。
// 例:6→[3,3];8→[4,4];22→[5,5,4,4,4](04 文档第 4 节拆分例)
export function tideSplit(count) {
  const tides = Math.ceil(count / 5);
  const base = Math.floor(count / tides);
  const rem = count % tides;
  return Array.from({ length: tides }, (_, i) => base + (i < rem ? 1 : 0));
}

// 构造一波的刷怪序列:[[潮内类型...], ...];Boss 波 = [[boss, 护卫, 护卫]]
export function buildWave(wLocal, L, rng) {
  if (isBossWave(wLocal)) {
    const guard = guardType(L);
    return [['boss', guard, guard]];
  }
  const count = waveEnemyCount(wLocal);
  return tideSplit(count).map(n =>
    Array.from({ length: n }, () => pickType(L, rng)));
}
