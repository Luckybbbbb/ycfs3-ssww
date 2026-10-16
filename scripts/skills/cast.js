// scripts/skills/cast.js
// FR-3.2/FR-3.3 自动释放门控:CD 就绪 且 档位 ≥1 且 目标存活 → 释放并清零档位
// M4 扩展(03 文档第 5 节):装配槽放技能 ID(初始=元素弹);消除 X 行按 5.1 规则选技能
// (CD 就绪者优先,同就绪取槽位序),子弹类走 launch,非子弹类分发 behaviors 行为内核。
// 兼容 M2 口径:loadout 可传元素名(自动映射 <el>_bolt);cds 保持元素键视图(仅初始弹)。
// 相对路径: scripts/skills/cast.js

import { BOLT_CD } from './registry.js';
import { DEFAULT_LOADOUT } from './registry.js';
import { skillById, pickSkillForElement } from './library.js';
import { dispatch as dispatchBehavior } from './behaviors.js';

const FIVE = ['fire', 'water', 'wood', 'metal', 'earth'];
// 元素名 → 初始弹技能 ID;技能 ID 原样保留(M2 兼容入口)
const toSkillId = (v) => (skillById(v) ? v : `${v}_bolt`);

export class Caster {
  // loadout: 4 槽(元素名或技能 ID);charge: Charge 实例(释放后清零档位)
  constructor(charge, loadout = DEFAULT_LOADOUT, level = 1) {
    this.charge = charge;
    this.loadout = loadout.map(toSkillId);
    this.level = level;
    this.cds = {};        // 元素键 CD 视图(M2 兼容:镜像该行初始弹)
    this.skillCds = {};   // 技能键 CD(技能库真实口径,03 文档 5.2 各技能独立 CD)
    for (const el of FIVE) { this.cds[el] = 0; this.skillCds[`${el}_bolt`] = 0; }
  }

  setLevel(level) { this.level = level; }

  update(dt) {
    for (const id in this.skillCds) this.skillCds[id] = Math.max(0, this.skillCds[id] - dt);
    for (const el of FIVE) this.cds[el] = this.skillCds[`${el}_bolt`];
  }

  // 换装(FR-3.3:换装立即生效):直接替换槽位集合(元素名或技能 ID);档位/CD 均保留
  setLoadout(loadout) {
    this.loadout = loadout.map(toSkillId);
  }

  // 槽位轮换(最小换装入口):该槽换为下一个未装配的元素行(初始弹),立即生效
  cycleSlot(slotIndex) {
    const cur = this.loadout[slotIndex];
    const curEl = skillById(cur)?.el ?? cur;
    const rest = FIVE.filter(el => !this.loadout.some(id => (skillById(id)?.el ?? id) === el));
    const next = rest[0] ?? FIVE.find(el => el !== curEl);
    if (!next) return cur;
    this.loadout[slotIndex] = `${next}_bolt`;
    return next;
  }

  // 判定并执行一次释放:返回 {element, tier, skill, kind, result?} 或 null
  // hasTarget=false(场上无存活敌人)时完全不消耗(03 文档 5.3);
  // 非子弹类需要 ctx(battle)执行行为内核;ctx 缺省时非子弹类不释放(档位保留)。
  tryCast(el, hasTarget, ctx = null) {
    const tier = this.charge.tiers[el];
    if (tier < 1) return null;                       // 档位门控(4.6:档位 0 → 不发射)
    if (!hasTarget) return null;                     // 无敌人不消耗 CD/档位
    const pick = pickSkillForElement(el, this.loadout, this.level, this.skillCds);
    if (!pick) return null;                          // 未装配/全 CD 中:档位保留继续累积
    const { skill } = pick;
    this.skillCds[skill.id] = skill.cd;              // 先占 CD(03 文档 5.2)
    if (skill.kind !== 'bolt' && !ctx) return null;  // 无 ctx 不执行非子弹类(CD 已占,下轮重试)
    const used = { element: el, tier: this.charge.drain(el), skill, kind: skill.kind };
    if (skill.kind === 'bolt') {
      this.cds[el] = skill.cd;
      return used;                                   // 子弹类由 battle.launch 结算(4.2 形态)
    }
    used.result = dispatchBehavior(ctx, skill, tier); // 非子弹类行为内核(4.2 同倍率表)
    return used;
  }
}
