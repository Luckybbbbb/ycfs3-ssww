// scripts/skills/registry.js
// 五行初始技能定义与档位数值表(M2 实装初始单弹;Lv3+ 技能 M4 解锁)
// 数值依据: docs/design/03-主角技能设计.md 4.2/4.3/5.2
// 相对路径: scripts/skills/registry.js

export const TIER_MULT = [1.0, 1.6, 2.4, 3.4, 4.6]; // 4.2 伤害倍率(×ATK),index=tier-1

// 4.3 元素能力随档位强化(2/4 档线性内插后四舍五入到一位小数——REQ-M2-01 整改冻结口径)
export const BURN_COEFF = [0.2, 0.25, 0.3, 0.4, 0.5];  // 火:灼烧 DPS 系数(×ATK),逐秒跳伤取整
export const SLOW_PCT = [30, 35, 40, 45, 50];          // 水:减速幅度(减益语义:速度 ×(1-pct/100))
export const LEECH_PCT = [20, 25, 30, 35, 40];         // 木:吸血比例(增益语义:伤害 ×pct/100)
export const METAL_MULT = [1.3, 1.4, 1.5, 1.7, 1.8];   // 金:弹伤额外倍率(内插 1.65 四舍五入一位 → 1.7)
export const SHIELD_ATK = [0.5, 0.75, 1.0, 1.5, 2.0];  // 土:护盾量(×ATK),封顶 30% maxHP

export const BOLT_CD = 2.0; // 子弹类 CD(5.2),弹速 600
export const BOLT_SPEED = 600;
export const PLAYER_X = 110;   // FR-1.1 站位
export const ENEMY_STOP_X = 560; // 停位(距主角 450px)

// 初始装配(4 槽,D6):火/水/木/金;土行不装配 → 消除仅积档位不释放(FR-3.3 验收对照)
export const DEFAULT_LOADOUT = ['fire', 'water', 'wood', 'metal'];

export function boltDamage(atk, el, tier) { // 浮点计算,命中入账时取整(4.4 口径由调用方 round)
  const dmg = atk * TIER_MULT[tier - 1];
  return el === 'metal' ? dmg * METAL_MULT[tier - 1] : dmg;
}
