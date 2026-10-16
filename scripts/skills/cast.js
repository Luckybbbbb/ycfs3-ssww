// scripts/skills/cast.js
// FR-3.2/FR-3.3 自动释放门控:CD 就绪 且 档位 ≥1 且 目标存活 → 释放并清零档位
// 无敌人时不消耗 CD(档位保留,03 文档 5.3);未装配行档位保留继续累积
// 相对路径: scripts/skills/cast.js

import { BOLT_CD, DEFAULT_LOADOUT } from './registry.js';

export class Caster {
  // loadout: 装配的元素行数组(4 槽);charge: Charge 实例(释放后清零档位)
  constructor(charge, loadout = DEFAULT_LOADOUT) {
    this.charge = charge;
    this.loadout = loadout.slice();
    this.cds = {};
    for (const el of ['fire', 'water', 'wood', 'metal', 'earth']) this.cds[el] = 0;
  }

  update(dt) {
    for (const el in this.cds) this.cds[el] = Math.max(0, this.cds[el] - dt);
  }

  // 换装(FR-3.3:换装立即生效):直接替换槽位集合;档位/CD 均保留
  setLoadout(loadout) {
    this.loadout = loadout.slice();
  }

  // 槽位轮换(最小换装入口):该槽换为下一个未装配的元素行,立即生效
  cycleSlot(slotIndex) {
    const five = ['fire', 'water', 'wood', 'metal', 'earth'];
    const cur = this.loadout[slotIndex];
    const rest = five.filter(el => !this.loadout.includes(el));
    const order = rest.concat([cur]);
    const next = order.find(el => el !== cur);
    if (!next) return this.loadout[slotIndex];
    this.loadout[slotIndex] = next;
    return next;
  }

  // 判定并执行一次释放:返回 {element, tier} 或 null
  // hasTarget=false(场上无存活敌人)时完全不消耗(03 文档 5.3)
  tryCast(el, hasTarget) {
    const tier = this.charge.tiers[el];
    if (tier < 1) return null;                       // 档位门控(4.6:档位 0 → 不发射)
    if (!this.loadout.includes(el)) return null;     // 未装配行仅积档位(FR-3.3)
    if (this.cds[el] > 0) return null;               // CD 门控(档位保留继续累积)
    if (!hasTarget) return null;                     // 无敌人不消耗 CD/档位
    this.cds[el] = BOLT_CD;
    return { element: el, tier: this.charge.drain(el) };
  }
}
