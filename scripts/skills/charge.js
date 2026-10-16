// scripts/skills/charge.js
// FR-3.1 档位充能:消费棋盘 match_cleared 事件,按元素行累加档位(封顶 5)
// 公式: tier_gain = min(base_tier(count) + min(chain-1, 2), 5), base_tier: 3→1 / 4→2 / ≥5→3
// 数值依据: docs/design/02-三消玩法设计.md 5.2/5.3、docs/design/03-主角技能设计.md 4.1
// 相对路径: scripts/skills/charge.js

import { ELEMENTS } from '../board/grid.js';

export class Charge {
  constructor() {
    this.tiers = {};
    for (const el of ELEMENTS) this.tiers[el] = 0;
  }

  static baseTier(count) {
    if (count >= 5) return 3;
    if (count === 4) return 2;
    return 1; // count=3(棋盘引擎只发 ≥3 的事件)
  }

  static tierGain(count, chain) {
    return Math.min(Charge.baseTier(count) + Math.min(chain - 1, 2), 5);
  }

  // event: {type:'match_cleared', element, count, chain};返回本次 gain(供表现层飘字)
  feed(event) {
    if (event.type !== 'match_cleared') return 0;
    const gain = Charge.tierGain(event.count, event.chain);
    const el = event.element;
    if (!(el in this.tiers)) return 0;
    const before = this.tiers[el];
    this.tiers[el] = Math.min(5, before + gain); // 封顶 5,溢出浪费无补偿(02 文档 5.2)
    return this.tiers[el] - before;
  }

  drain(el) { // 释放清零(Caster 调用)
    const t = this.tiers[el];
    this.tiers[el] = 0;
    return t;
  }
}
