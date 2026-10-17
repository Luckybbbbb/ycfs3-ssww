// scripts/skills/charge.js
// FR-3.1 档位充能(M6/v0.2):消费棋盘 match_cleared 事件,按元素行单一池累加档位(封顶 5)
// 公式(02 文档 5.2):tier_of = min(1 + ⌊(count−3)/3⌋, 5);tier_gain = min(tier_of + min(chain−1, 2), 5)
// 锚点区间:3~5→档1、6~8→档2、9~11→档3、12~14→档4、15+→档5(3/6/9/12 为需求方锚点=区间起点)
// 记账:行单一池;选技建预约时池全部余额转入预约并清池(03 文档 4.0);earliestT=池内最早未消费充能时刻
// (预约执行下限 t0 取被占用档位中最早可用时刻,先到先占)。
// 相对路径: scripts/skills/charge.js

import { ELEMENTS } from '../board/grid.js';

export class Charge {
  constructor() {
    this.tiers = {};
    this.earliestT = {};    // 各行当前池余额中最早充入时刻(整池转预约时的 t0 基准)
    this.earliestFloor = {}; // M9-F2:最早档位**所属轮**的段④起点偏移(随档位留池保存;转预约时作执行下限基准)
    for (const el of ELEMENTS) { this.tiers[el] = 0; this.earliestT[el] = null; this.earliestFloor[el] = null; }
  }

  // 02 文档 5.2 档位映射:v0.2 锚点 3/6/9/12+(区间起点);count=3→1、4~5→1、6→2、9→3、12→4、15+→5
  static tierOf(count) {
    return Math.min(1 + Math.floor((count - 3) / 3), 5);
  }

  static tierGain(count, chain) {
    return Math.min(Charge.tierOf(count) + Math.min(chain - 1, 2), 5);
  }

  // event: {type:'match_cleared', element, count, chain, t?, floor?};t=事件确立时刻(演出起点,03 文档 4.0);
  // floor=本轮段④起点偏移(M9-F2:随档位留池保存——延迟选技/跨轮留池的预约仍继承最早档位所属轮的执行下限)
  // 返回本次 gain(供表现层飘字)
  feed(event) {
    if (event.type !== 'match_cleared') return 0;
    const gain = Charge.tierGain(event.count, event.chain);
    const el = event.element;
    if (!(el in this.tiers)) return 0;
    const before = this.tiers[el];
    this.tiers[el] = Math.min(5, before + gain); // 封顶 5,溢出浪费无补偿(02 文档 5.2)
    if (this.tiers[el] > 0 && this.earliestT[el] === null) {
      this.earliestT[el] = event.t ?? null;
      this.earliestFloor[el] = event.floor ?? null; // 仅池空→首次充入时记录(新事件不重设旧留池档位的等待时间)
    }
    return this.tiers[el] - before;
  }

  // 选技转池(03 文档 4.0 原子动作):池全部余额转入预约并清池;
  // 返回 {tier, t0, floor}(t0=最早可用档位时刻;floor=最早档位所属轮段④起点偏移,M9-F2)
  drainAll(el) {
    const t = this.tiers[el];
    const t0 = this.earliestT[el];
    const floor = this.earliestFloor[el];
    this.tiers[el] = 0;
    this.earliestT[el] = null;
    this.earliestFloor[el] = null;
    return { tier: t, t0, floor };
  }

  // 兼容 M2 演示 API(保留,单测依赖):整行清零
  drain(el) {
    return this.drainAll(el).tier;
  }

  // 终局清空(REQ-05:VICTORY/DEFEAT/重试/换关,预约与池清空、两项记账累计同步归零)
  reset() {
    for (const el of ELEMENTS) { this.tiers[el] = 0; this.earliestT[el] = null; this.earliestFloor[el] = null; }
  }
}
