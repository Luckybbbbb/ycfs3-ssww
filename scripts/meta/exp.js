// scripts/meta/exp.js
// 经验/升级纯逻辑(FR-5,D13):exp_need(L)=round(20×L^1.5) 从 Lv 升到 Lv+1 所需;
// HP(Lv)=100+15×(Lv−1)、ATK(Lv)=10+(Lv−1);升级按累计经验判定、即时回满 HP。
// 数字例(03 文档 2.2,Lv1→2 需 20、Lv2→3 需 57、Lv3→4 需 104、Lv10→11 需 632)
// 相对路径: scripts/meta/exp.js

export const BASE_HP = 100;
export const HP_PER_LV = 15;
export const BASE_ATK = 10;

// 从 Lv 升到 Lv+1 所需经验(03 文档 2.1)
export function expNeed(level) { return Math.round(20 * Math.pow(level, 1.5)); }

// 累计阈值:升到 Lv 所需总经验。cumThreshold(1)=0,cumThreshold(2)=need(1)=20,
// cumThreshold(3)=20+57=77,cumThreshold(4)=181(03 文档 2.2 实战曲线例口径)
export function cumThreshold(level) {
  let sum = 0;
  for (let k = 1; k < level; k++) sum += expNeed(k);
  return sum;
}

// 主角属性(03 文档 2.2 表:Lv1 100/10、Lv5 160/14、Lv10 235/19、Lv20 385/29)
export const maxHpAt = (level) => BASE_HP + HP_PER_LV * (level - 1);
export const atkAt = (level) => BASE_ATK + (level - 1);

// 累计经验 → 等级与余量(可连跳多级;数字例:18→Lv1;50→Lv2 余 30;100→Lv3 余 23;172→Lv3;181→Lv4 余 0)
export function levelFromExp(totalExp) {
  let level = 1;
  while (totalExp >= cumThreshold(level + 1)) level += 1;
  return { level, surplus: totalExp - cumThreshold(level) };
}

// 应用收益:返回新状态;升级时回满 HP(FR-5「升级即时回满」)。
// profile: {level, expTotal, hp};expTotal 为累计经验(与 03 文档 2.2 口径一致)
export function applyExp(profile, gained) {
  const expTotal = profile.expTotal + gained;
  const { level } = levelFromExp(expTotal);
  const leveledUp = level > profile.level;
  const maxHp = maxHpAt(level);
  // 升级即时回满;未升级保持现有 HP(钳到新上限内,防御性)
  const hp = leveledUp ? maxHp : Math.min(profile.hp, maxHp);
  return { level, expTotal, hp, maxHp, leveledUp };
}
