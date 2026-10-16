// scripts/skills/library.js
// 技能库定义与装配选择(03 文档第 5 节,D6):初始 5 弹 + Lv3 五技能 + Lv6 五技能,共 15 项。
// 装配规则(5.1):4 槽,任意五行技能可入槽,同技能不可重复;消除 X 行只触发一个 X 行已装配技能
// ——取 CD 就绪者,多于一个就绪取槽位序靠前;未装配/全 CD 中不释放(档位保留,4.1)。
// 相对路径: scripts/skills/library.js

import { TIER_MULT } from './registry.js';

// kind → 行为内核(behaviors.js 实装):bolt/dotzone/chain/bind/multi/shield/pulse/field/aura
// CD(5.2):子弹类 2.0;锁链/束缚/连珠 4.0;灼烧区/石甲 6.0;脉冲/领域/光环 5.0
export const SKILL_LIBRARY = [
  // 初始:五行单体弹(自带能力见 registry 元素能力,4.3)
  { id: 'fire_bolt',  name: '火弹',     el: 'fire',  unlockLevel: 1, cd: 2.0, kind: 'bolt' },
  { id: 'water_bolt', name: '水弹',     el: 'water', unlockLevel: 1, cd: 2.0, kind: 'bolt' },
  { id: 'wood_bolt',  name: '木弹',     el: 'wood',  unlockLevel: 1, cd: 2.0, kind: 'bolt' },
  { id: 'metal_bolt', name: '金弹',     el: 'metal', unlockLevel: 1, cd: 2.0, kind: 'bolt' },
  { id: 'earth_bolt', name: '土弹',     el: 'earth', unlockLevel: 1, cd: 2.0, kind: 'bolt' },
  // Lv3(5.2 解锁表)
  { id: 'fire_dotzone', name: '燎原弹',   el: 'fire',  unlockLevel: 3, cd: 6.0, kind: 'dotzone',
    params: { r: 40, dpsCoef: 0.25, duration: 3 } },      // 命中生成灼烧区,DPS=ATK×0.25,持续 3s
  { id: 'water_chain',  name: '寒冰锁链', el: 'water', unlockLevel: 3, cd: 4.0, kind: 'chain',
    params: { dmgCoef: 0.6 } },                            // 主目标 + ⌊2+tier/2⌋ 邻近,各 ATK×0.6
  { id: 'wood_bind',    name: '藤蔓束缚', el: 'wood',  unlockLevel: 3, cd: 4.0, kind: 'bind',
    params: { bindTime: 1.5, dpsCoef: 0.3 } },             // 束缚最近敌 1.5s + 每秒 ATK×0.3
  { id: 'metal_multi',  name: '贯日连珠', el: 'metal', unlockLevel: 3, cd: 4.0, kind: 'multi',
    params: { count: 3, dmgCoef: 0.7 } },                  // 3 发弹各 ATK×0.7
  { id: 'earth_shield', name: '石甲术',   el: 'earth', unlockLevel: 3, cd: 6.0, kind: 'shield',
    params: { dmgCoef: 2.0 } },                            // 护盾 ATK×2,上限 30% maxHP
  // Lv6(5.2 解锁表)
  { id: 'fire_pulse',  name: '烈焰环',   el: 'fire',  unlockLevel: 6, cd: 5.0, kind: 'pulse',
    params: { r: 80, dmgCoef: 1.8 } },                     // 最近敌人为中心脉冲环 r=80,ATK×1.8
  { id: 'water_field', name: '寒霜领域', el: 'water', unlockLevel: 6, cd: 5.0, kind: 'field',
    params: { r: 100, slowPct: 20, duration: 6 } },        // 最近敌人为中心 r=100 减速 20%,持续 6s
  { id: 'wood_aura',   name: '生机光环', el: 'wood',  unlockLevel: 6, cd: 5.0, kind: 'aura',
    params: { duration: 6 } },                             // 主角光环,每秒回 maxHP×1%×档位倍率,持续 6s
  { id: 'metal_pulse', name: '金刃风暴', el: 'metal', unlockLevel: 6, cd: 5.0, kind: 'pulse',
    params: { r: 70, dmgCoef: 2.0 } },                     // 最近敌人为中心脉冲 r=70,ATK×2.0
  { id: 'earth_pulse', name: '裂地脉冲', el: 'earth', unlockLevel: 6, cd: 5.0, kind: 'pulse',
    params: { r: 100, dmgCoef: 1.5, stunTime: 0.5 } },     // 脉冲 r=100,ATK×1.5 + 眩晕 0.5s
];

export const skillById = (id) => SKILL_LIBRARY.find(s => s.id === id);

// 等级解锁进技能库(5.2):unlockLevel ≤ 当前等级
export function unlockedSkills(level) {
  return SKILL_LIBRARY.filter(s => s.unlockLevel <= level);
}

// 03 文档 4.4:非子弹类技能同一张倍率表作用于其主数值
export const tiered = (skill, atk, tier) => atk * (skill.params?.dmgCoef ?? 1) * TIER_MULT[tier - 1];

// 消除 X 行的释放选择(5.1):候选=装配槽中 X 行技能;CD 就绪者优先,同就绪取槽位序靠前。
// 返回 {skill, slot} 或 null(未装配/全 CD 中——档位保留由调用方处理)
export function pickSkillForElement(el, slots, level, cds) {
  const unlocked = new Set(unlockedSkills(level).map(s => s.id));
  for (let i = 0; i < slots.length; i++) {
    const skill = skillById(slots[i]);
    if (!skill || skill.el !== el || !unlocked.has(skill.id)) continue;
    if (((cds[skill.id] ?? 0) <= 0)) return { skill, slot: i };
  }
  return null;
}

// 同技能不可重复装配(5.1)
export function canEquip(slots, slot, skillId, level) {
  const skill = skillById(skillId);
  if (!skill) return false;
  if (!unlockedSkills(level).some(s => s.id === skillId)) return false;
  return !slots.includes(skillId) || slots[slot] === skillId;
}
