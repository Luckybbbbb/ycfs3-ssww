// scripts/meta/economy.js
// M6/v0.2 养成经济(03 文档第 2 节,取代 exp.js):货币/材料/角色升级/技能升级/抽卡
// 资源:货币 coins=击杀 2+w_global(Boss ×20)+通关 50×L;材料 mats=击杀普通 1/Boss 20+通关 10×L
// 消耗:角色升级 level_up_cost(L)=round(10×L^1.3);技能升级 skill_up_cost=5×lv;
//       skill_mult(lv)=1+0.08×(lv−1) 上限 Lv10;抽卡 100 币/次从未拥有 10 技能均匀随机(无重复,满池 10 抽 1000)
// 相对路径: scripts/meta/economy.js

import { SKILL_LIBRARY } from '../skills/library.js';

export const COIN_PER_GACHA = 100;
export const SKILL_LEVEL_CAP = 10;

// 击杀产出(03 文档 2.2):货币 2+w_global(Boss ×20);材料普通 1 / Boss 20
export function killReward(wGlobal, isBoss = false) {
  const base = 2 + wGlobal;
  return { coins: isBoss ? base * 20 : base, mats: isBoss ? 20 : 1 };
}

// 通关产出:货币 50×L、材料 10×L(首通与重打同额)
export function victoryReward(L) {
  return { coins: 50 * L, mats: 10 * L };
}

// 角色升级成本(03 文档 2.3):从 Lv 升到 Lv+1 所需材料
export function levelUpCost(L) {
  return Math.round(10 * Math.pow(L, 1.3));
}

// 技能升级成本(03 文档 2.4):该技能从 lv 升 lv+1 所需材料
export function skillUpCost(lv) {
  return 5 * lv;
}

// 技能强度乘数(03 文档 2.4):1 + 0.08×(lv−1),Lv10 → 1.72
export function skillMult(lv) {
  return 1 + 0.08 * (lv - 1);
}

// 角色升级(消耗材料;03 文档 2.3):材料不足返回 null;成功返回 {level, materials}
// (材料字段名统一为 profile.materials——存档 v0.2 schema 口径)
export function applyLevelUp(profile) {
  const cost = levelUpCost(profile.level);
  if ((profile.materials ?? 0) < cost) return null;
  profile.materials -= cost;
  profile.level += 1;
  return { level: profile.level, materials: profile.materials, cost };
}

// 技能升级(消耗材料;03 文档 2.4):上限 Lv10;不足/越界返回 null
export function applySkillUp(profile, skillId) {
  const lv = profile.skillLevels[skillId] || 1;
  if (lv >= SKILL_LEVEL_CAP) return null;
  const cost = skillUpCost(lv);
  if ((profile.materials ?? 0) < cost) return null;
  profile.materials -= cost;
  profile.skillLevels[skillId] = lv + 1;
  return { skillId, level: lv + 1, materials: profile.materials, cost };
}

// 抽卡(03 文档 2.5):从「未拥有」的技能中均匀随机(奖池只含未拥有,无重复);
// 全部拥有 → null(入口置灰);货币不足 → { error: 'coins' };成功返回 { skillId, coins, owned }
export function gacha(profile, rng) {
  const owned = new Set(profile.ownedSkills);
  const pool = SKILL_LIBRARY.filter(s => !owned.has(s.id)).map(s => s.id);
  if (!pool.length) return null;
  if (profile.coins < COIN_PER_GACHA) return { error: 'coins' };
  profile.coins -= COIN_PER_GACHA;
  const skillId = pool[Math.floor(rng() * pool.length)];
  owned.add(skillId);
  profile.ownedSkills = [...owned];
  return { skillId, coins: profile.coins, owned: profile.ownedSkills };
}

// 默认档案 v0.2(00 文档 7 节:schemaVer=2;ownedSkills 初始=5 初始弹)
export function defaultEconomy() {
  return {
    coins: 0,
    materials: 0,
    ownedSkills: ['fire_bolt', 'water_bolt', 'wood_bolt', 'metal_bolt', 'earth_bolt'],
    skillLevels: {},
  };
}
