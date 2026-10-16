// scripts/battle/battle.js
// M2 战斗编排:最小敌人批次(静态停位靶,推进/弹幕/胜负 M3)+ 档位形态 + DOT + 同刻事件顺序
// 同刻顺序(03 文档 4.4):投射物命中 → 周期效果跳伤 → 技能自动释放判定
// 形态表(4.2):tier1 单体 / tier2 双目标 / tier3 三目标+溅射 r60 50% / tier4 范围 r90 全额 /
//             tier5 范围 r140 全额+范围内全体附加元素能力
// 相对路径: scripts/battle/battle.js

import { Enemy } from './enemy.js';
import { advanceBolt, findHitTargets } from './projectile.js';
import { BOLT_SPEED, PLAYER_X, boltDamage, BURN_COEFF, LEECH_PCT, SHIELD_ATK, SLOW_PCT } from '../skills/registry.js';

export class Battle {
  // expPerKill = 2 + w_global(04 文档第 3 节;第 1 关第 1 波 w_global=1 → 3)
  constructor({ atk = 10, maxHp = 100, expPerKill = 3 } = {}) {
    this.atk = atk;
    this.maxHp = maxHp;
    this.hp = maxHp;
    this.shield = 0;
    this.enemies = [];
    this.bolts = [];
    this.clock = 0;
    this.kills = 0;
    this.expGained = 0;
    this.expPerKill = expPerKill;
    this.log = [];            // 数字例复核用事件流水
  }

  // M2 演示批次:敌人置于停位列,纵向排列在战斗区可见范围(y 150~375,不被联动栏/棋盘遮挡)
  spawnWave(count, hp) {
    for (let i = 0; i < count; i++) {
      this.enemies.push(new Enemy({ hp, x: 560, y: 150 + i * 45 }));
    }
  }

  aliveEnemies() { return this.enemies.filter(e => e.alive); }

  // 03 文档 5.3:朝最近敌人释放(欧氏距离到主角站位)
  nearestAlive(exclude = []) {
    let best = null, bestD = Infinity;
    for (const e of this.enemies) {
      if (!e.alive || exclude.includes(e)) continue;
      const dx = e.x - PLAYER_X, dy = e.y - 280;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  // 释放判定后由 main/测试调用:按档位形态生成弹与作用(4.2 表)
  launch(castResult) {
    const target = this.nearestAlive();
    if (!target) return null;
    const el = castResult.element, tier = castResult.tier;
    const raw = boltDamage(this.atk, el, tier); // 浮点,入账时 round(4.4)
    this.log.push({ t: this.clock, ev: 'launch', el, tier });
    if (tier >= 4) {
      // 范围形态:单弹飞向最近敌,命中后以命中点为圆心 r90/tier4、r140/tier5 全额
      const b = this.makeBolt(el, tier, raw, target);
      b.blastR = tier === 5 ? 140 : 90;
      b.aoeAll = true;
      this.bolts.push(b);
    } else {
      // tier1 单体 / tier2 双目标 / tier3 三目标+溅射 r60 50%
      const picked = [];
      for (let i = 0; i < tier; i++) {
        const e = this.nearestAlive(picked);
        if (!e) break;
        picked.push(e);
        const b = this.makeBolt(el, tier, raw, e);
        b.splash = tier >= 3 ? { r: 60, mult: 0.5 } : null;
        this.bolts.push(b);
      }
    }
    return true;
  }

  makeBolt(el, tier, raw, target) {
    return {
      el, tier, rawDmg: raw, x: PLAYER_X, y: target.y,
      t: 0, flyTime: (target.x - PLAYER_X) / BOLT_SPEED,
      target, lastDt: 0, // 弹绑定其发射目标;lastDt 供扫掠检测
      hitSet: new Set(), done: false, blastR: 0, aoeAll: false, splash: null, blasted: false,
    };
  }

  // 命中一个目标:伤害+元素能力(命中点/目标为作用中心)
  applyHit(b, e, mult = 1) {
    const dmg = Math.round(b.rawDmg * mult);
    const r = e.hurt(dmg);
    this.log.push({ t: this.clock, ev: 'hit', el: b.el, tier: b.tier, dmg, mult, hpAfter: e.hp, killed: r.killed, target: this.enemies.indexOf(e) });
    if (r.killed) { this.kills++; this.expGained += this.expPerKill; this.log.push({ t: this.clock, ev: 'kill' }); }
    // 元素能力(4.3;灼烧刷新=覆盖 dpsFloat 并只延长 until,不重置跳伤时钟——4.4)
    if (b.el === 'fire') {
      const dps = this.atk * BURN_COEFF[b.tier - 1];
      const until = this.clock + 3;
      if (e.burn) { e.burn.dpsFloat = dps; e.burn.until = until; }
      else e.burn = { dpsFloat: dps, until };
    }
    if (b.el === 'water') e.slowT = Math.max(e.slowT, 2); // 减速 2s,幅度按 SLOW_PCT[tier-1](M3 移动消费)
    if (b.el === 'wood') {
      const heal = Math.round(dmg * LEECH_PCT[b.tier - 1] / 100);
      this.hp = Math.min(this.maxHp, this.hp + heal);
      this.log.push({ t: this.clock, ev: 'leech', heal });
    }
    if (b.el === 'earth') {
      const add = Math.round(this.atk * SHIELD_ATK[b.tier - 1]);
      const cap = Math.round(this.maxHp * 0.3);
      this.shield = Math.min(cap, this.shield + add);
      this.log.push({ t: this.clock, ev: 'shield', add, shield: this.shield, cap });
    }
    return r;
  }

  update(dt) {
    const prevClock = this.clock;
    this.clock += dt;
    // 1) 弹移动与命中(命中判定在 projectile.js:圆形碰撞 FR-1.3)
    for (const b of this.bolts) {
      b.lastDt = dt; // 记录帧步长(扫掠检测用,REQ-M2-04 整改 2)
      if (!advanceBolt(b, dt)) continue;
      // 命中归属:优先结算弹绑定的目标(多弹各归各靶,REQ-M2-02 整改 1);
      // 同帧处理碰撞圆内全部候选(帧步长无关,整改 3),金穿透继续飞(每目标只一次,FR-1.3)
      let cands = findHitTargets(b, this.enemies);
      if (b.target && b.target.alive && !b.hitSet.has(b.target) &&
          (b.target.x - b.x) ** 2 + (b.target.y - b.y) ** 2 <= 54 * 54) {
        cands = [b.target, ...cands.filter(e => e !== b.target)];
      }
      for (const cand of cands) {
        if (b.hitSet.has(cand)) continue; // 爆炸/溅射已命中过的目标不再直击(REQ-M2-04 整改 1)
        b.hitSet.add(cand);
        this.applyHit(b, cand, 1);
        if (b.aoeAll && !b.blasted) {
          // 范围形态:命中点为圆心,范围内全体(不含已在本弹命中过的)全额
          b.blasted = true;
          for (const e of this.enemies) {
            if (!e.alive || b.hitSet.has(e)) continue;
            const dx = e.x - cand.x, dy = e.y - cand.y;
            if (dx * dx + dy * dy <= b.blastR * b.blastR) {
              b.hitSet.add(e);
              this.applyHit(b, e, 1);
            }
          }
        } else if (b.splash) {
          // tier3 溅射:命中点 r60 内其他未受击敌 50%(同一颗弹每目标只一次)
          for (const e of this.enemies) {
            if (!e.alive || b.hitSet.has(e)) continue;
            const dx = e.x - cand.x, dy = e.y - cand.y;
            if (dx * dx + dy * dy <= 60 * 60) {
              b.hitSet.add(e);
              this.applyHit(b, e, b.splash.mult);
            }
          }
        }
        if (b.el !== 'metal') { b.done = true; break; } // 非金命中即消散;金穿透继续(FR-1.3,无档位例外)
      }
    }
    this.bolts = this.bolts.filter(b => !b.done && b.x < 780);
    // 2) 周期跳伤 + 状态生命周期(减速到期)
    for (const e of this.enemies) {
      if (e.slowT > 0) e.slowT = Math.max(0, e.slowT - dt);
      const burnDmg = e.tickBurn(prevClock, this.clock);
      if (burnDmg > 0) {
        this.log.push({ t: this.clock, ev: 'burn', hpAfter: e.hp });
        if (!e.alive) { this.kills++; this.expGained += this.expPerKill; this.log.push({ t: this.clock, ev: 'kill' }); }
      }
    }
    // 3) 自动释放判定在外部(main/测试)按同刻顺序最后执行:caster.tryCast → battle.launch
  }
}
void SLOW_PCT;
