// tests/m6.test.mjs
// M6 玩法重构单测:批次 C 双链路释放(03 文档 v0.2 4.0,REQ-06 过审版)
// 覆盖:档位新公式(02 5.2)、消除触发链预约(选技转池/执行时刻/共享 CD)、主角链(skill_mult)、
//       两阶段仲裁(同技能消除链优先/不同技能并发)、生命周期(终局清空/无敌人挂起)
// 运行: node --test tests/m6.test.mjs
// 相对路径: tests/m6.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Charge } from '../scripts/skills/charge.js';
import { Caster } from '../scripts/skills/cast.js';
import { BoardEngine } from '../scripts/board/engine.js';
import {
  killReward, victoryReward, levelUpCost, skillUpCost, skillMult,
  applyLevelUp, applySkillUp, gacha, defaultEconomy, COIN_PER_GACHA, SKILL_LEVEL_CAP,
} from '../scripts/meta/economy.js';

// ---- 桩:最小 battle 兼容 ctx(clock/atk/enemies/bolts/launch) ----
function mockCtx(atk = 10, clock = 0) {
  return {
    atk, maxHp: 100, hp: 100, shield: 0, clock,
    enemies: [], bolts: [],
    nearestAlive() { return this.enemies.find(e => e.alive) || null; },
    makeBolt(el, tier, dmg, target) { return { el, tier, dmg, target }; },
    registerKill() { return false; },
    // F6 同一提交:发射成功返回 true(有存活目标),失败返回 null——与 battle.launch 同语义
    launch(used) {
      const t = this.enemies.find(e => e.alive);
      if (!t) return null;
      this.bolts.push({ el: used.element, tier: used.tier, mult: used.mult });
      return true;
    },
  };
}
function makeRngSeq(vals) { // 桩 rng:依次返回给定值(映射正确性验证),耗尽后循环
  let i = 0;
  return () => vals[(i++) % vals.length];
}
const ev = (element, count, chain, t = 0) => ({ type: 'match_cleared', element, count, chain, t });

// ---- 档位新公式(02 文档 5.2/5.3 全域) ----
test('M6 档位:tier_of 全域边界(4/5/8/11/14)+ 64 封顶 + 连锁封顶', () => {
  assert.equal(Charge.tierOf(3), 1);
  assert.equal(Charge.tierOf(4), 1); assert.equal(Charge.tierOf(5), 1);
  assert.equal(Charge.tierOf(6), 2); assert.equal(Charge.tierOf(8), 2);
  assert.equal(Charge.tierOf(9), 3); assert.equal(Charge.tierOf(11), 3);
  assert.equal(Charge.tierOf(12), 4); assert.equal(Charge.tierOf(14), 4);
  assert.equal(Charge.tierOf(15), 5);
  assert.equal(Charge.tierOf(64), 5, '全盘 64 连通块封顶');
  assert.equal(Charge.tierGain(15, 3), 5, '连锁加成封顶 min(5+2,5)');
  assert.equal(Charge.tierGain(3, 4), 3, '三连锁 4 → 1+2 封顶');
});

test('M6 充能:earliestT 记录最早充入时刻;drainAll 原子转池(池全部余额+最早时刻)', () => {
  const c = new Charge();
  c.feed(ev('fire', 3, 1, 0));   // t=0 充 1 档
  c.feed(ev('fire', 9, 1, 2.8)); // t=2.8 再充 3 档(9 连 tier3)→ 池 4
  assert.equal(c.tiers.fire, 4);
  const { tier, t0 } = c.drainAll('fire');
  assert.equal(tier, 4, '池全部余额转入预约');
  assert.equal(t0, 0, 't0=最早可用档位时刻(先到先占)');
  assert.equal(c.tiers.fire, 0, '池清零');
  assert.equal(c.earliestT.fire, null);
});

// ---- 主角链(养成线) ----
test('M6 主角链:CD 就绪即发(tier=1);同帧多槽就绪全部执行;CD 写入共享表', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt', 'water_bolt'], 1);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  const out = caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(out.length, 2, '两槽同帧就绪并发执行');
  assert.ok(out.every(u => u.from === 'main' && u.tier === 1), '主角链 tier=1(无档位)');
  assert.equal(caster.skillCds.fire_bolt, 2.0, '共享 CD 写入');
  assert.equal(caster.skillCds.water_bolt, 2.0);
  ctx.clock = 1.0;
  assert.equal(caster.tick(ctx, true, makeRngSeq([0])).length, 0, 'CD 中不执行');
  caster.update(2.0); // CD 衰减 2s(update 驱动,tick 只读)
  ctx.clock = 2.0;
  assert.equal(caster.tick(ctx, true, makeRngSeq([0])).length, 2, 'CD 到期再发');
});

test('M6 主角链:skill_mult 接入(03 文档 2.4/4.4——round(10×1.16×2.4)=28,无中间取整)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt'], 1, null, { fire_bolt: 3 }); // Lv3 ×1.16
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  const seen = caster.withSkillMult(ctx, 'fire_bolt', () => ctx.atk);
  assert.ok(Math.abs(seen - 11.6) < 1e-9, `浮点乘数 ${seen}`);
  assert.equal(ctx.atk, 10, '执行后恢复原 atk');
  const dmg = Math.round(10 * caster.skillMult('fire_bolt') * 2.4);
  assert.equal(dmg, 28);
});

// ---- 消除触发链 ----
test('M6 消除链:池 3 逐阶段数字例(REQ-05)——原子单预约 tier=3、池只清零一次、仲裁不重读池', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt'], 1);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  charge.feed(ev('fire', 15, 1, 0));
  charge.tiers.fire = 3; charge.earliestT.fire = 0; // 池 3 场景
  caster.reserveFor('fire', makeRngSeq([0]), 0); // 事件入口:选技+原子建预约(F2)
  assert.equal(caster.pending.length, 1, '恰一个预约');
  assert.equal(caster.pending[0].tier, 3, 'tier=池全部余额 3(原子快照)');
  assert.equal(charge.tiers.fire, 0, '池只清零一次');
  ctx.clock = 0.5;
  assert.equal(caster.tick(ctx, true, makeRngSeq([0])).length, 0, '0.5s 未到执行时刻');
  ctx.clock = 0.75;
  const out2 = caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(out2.length, 1, '0.75s 执行');
  assert.equal(out2[0].tier, 3, '按预约 tier=3 形态执行');
  assert.equal(caster.skillCds.fire_bolt, 2.0, '执行时写共享 CD');
  assert.equal(caster.pending.length, 0, '清预约');
});

test('M6 F2:同轮两组火三连(产品消费入口=逐事件 feed+reserveFor,再统一 tick)', () => {
  // 单候选(仅初始弹):事件1 → tier1 预约;事件2 → 候选空,档位留池(设计 4.0 口径)
  const ch1 = new Charge();
  const c1 = new Caster(ch1, ['fire_bolt'], 1);
  const cx1 = mockCtx(10, 0);
  cx1.enemies = [{ alive: true }];
  for (const t of [0, 0]) { ch1.feed(ev('fire', 3, 1, t)); c1.reserveFor('fire', makeRngSeq([0]), t); }
  assert.equal(c1.pending.length, 1, '同轮两事件只建一个预约(不合并成 tier2)');
  assert.equal(c1.pending[0].tier, 1, '预约 tier=1(逐事件档位,不池层合并)');
  assert.equal(ch1.tiers.fire, 1, '另一档留池蓄能');
  const out1 = c1.tick(cx1, true, makeRngSeq([0]));
  assert.equal(out1.length, 0, '预约未到期不执行');
  // 多候选(两火系技能):逐事件各建 tier1 预约
  const ch2 = new Charge();
  const c2 = new Caster(ch2, ['fire_bolt'], 1, ['fire_bolt', 'fire_dotzone']);
  for (const t of [0, 0]) { ch2.feed(ev('fire', 3, 1, t)); c2.reserveFor('fire', makeRngSeq([0, 0.5]), t); }
  assert.equal(c2.pending.length, 2, '两事件两预约(逐事件选技)');
  assert.ok(c2.pending.every(p => p.tier === 1), '各 tier1');
  assert.equal(new Set(c2.pending.map(p => p.skillId)).size, 2, '两技能各占其一');
  assert.equal(ch2.tiers.fire, 0, '池清零');
});

test('M6 消除链:留池档位在 CD 就绪帧经 tick 回落建预约(REQ-04 F1 每帧判定保留)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt'], 1);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  charge.feed(ev('fire', 3, 1, 0)); // 事件 1:充 1 档 → 预约火弹
  caster.reserveFor('fire', makeRngSeq([0]), 0);
  assert.equal(caster.pending.length, 1);
  charge.feed(ev('fire', 3, 1, 0.1)); // 事件 2:池=1 但火弹被预约 → 蓄能留池
  caster.reserveFor('fire', makeRngSeq([0]), 0.1);
  assert.equal(caster.pending.length, 1, '仍一个预约(排他)');
  assert.equal(charge.tiers.fire, 1, '第二事件档位留池(蓄能)');
  ctx.clock = 0.75;
  caster.tick(ctx, true, makeRngSeq([0])); // 事件 1 执行
  assert.equal(caster.pending.length, 0);
  assert.equal(charge.tiers.fire, 1, '留池档位仍在');
  caster.update(0.05);
  ctx.clock = 0.8;
  caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(caster.pending.length, 0, 'CD 中不建预约');
  caster.update(2.0); // CD 衰减至就绪
  ctx.clock = 2.85;
  const out = caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(caster.pending.length, 0, 'CD 就绪帧 tick 回落建预约并到期即执行');
  assert.equal(out.length, 1, 'CD 就绪后未经新消除即触发(REQ-04 F1 每帧判定)');
  assert.equal(out[0].tier, 1);
});

test('M6 仲裁:同技能同刻消除链优先(主角链合并);不同技能并发', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt'], 1);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  charge.feed(ev('fire', 15, 1, 0));
  caster.reserveFor('fire', makeRngSeq([0]), 0);
  const out = caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(out.length, 0, '预约未到期,主角链同技能被合并(消除链优先)');
  assert.equal(caster.pending.length, 1);
  caster.loadout = ['water_bolt'];
  ctx.clock = 0.75;
  const out2 = caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(out2.length, 2, '水弹(主角链)+火弹(消除链)并发');
  assert.ok(out2.some(u => u.from === 'main' && u.skill.id === 'water_bolt'));
  assert.ok(out2.some(u => u.from === 'elim' && u.skill.id === 'fire_bolt'));
});

test('M6 消除链:选技映射正确性(桩 rng 索引对应,裁决 F7)+ 固定种子复现', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt'], 1, ['fire_bolt', 'fire_dotzone']);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  charge.feed(ev('fire', 15, 1, 0));
  caster.reserveFor('fire', makeRngSeq([0]), 0);
  assert.equal(caster.pending[0].skillId, 'fire_bolt', 'rng=0 → 候选池索引 0');
  caster.resetForNewLevel();
  charge.feed(ev('fire', 15, 1, 0));
  caster.reserveFor('fire', makeRngSeq([0.5]), 0);
  assert.equal(caster.pending[0].skillId, 'fire_dotzone', 'rng=0.5 → 候选池索引 1');
  const run = (seedVals) => {
    const ch = new Charge();
    const c = new Caster(ch, ['fire_bolt'], 1, ['fire_bolt', 'fire_dotzone']);
    ch.feed(ev('fire', 15, 1, 0));
    c.reserveFor('fire', makeRngSeq(seedVals), 0);
    return c.pending.map(p => p.skillId).join(',');
  };
  assert.equal(run([0.3]), run([0.3]), '固定序列复现一致');
});

test('M6 生命周期:resetForNewLevel 清预约/池/CD(REQ-05 局界重置两项累计同步归零)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt'], 1);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  charge.feed(ev('fire', 15, 1, 0));
  caster.reserveFor('fire', makeRngSeq([0]), 0);
  assert.equal(caster.pending.length, 1);
  caster.resetForNewLevel();
  assert.equal(caster.pending.length, 0, '预约清空');
  assert.equal(charge.tiers.fire, 0, '池清零');
  assert.equal(caster.skillCds.fire_bolt, 0, 'CD 清零(局内进度)');
});

test('M6 消除链:无存活敌人执行挂起(预约保留,敌人出现后执行)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt'], 1);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [];
  charge.feed(ev('fire', 3, 1, 0));
  caster.reserveFor('fire', makeRngSeq([0]), 0);
  assert.equal(caster.pending.length, 1, '预约建立(选技照常)');
  ctx.clock = 2.0;
  caster.tick(ctx, false, makeRngSeq([0]));
  assert.equal(caster.pending.length, 1, '到期但无敌人 → 执行挂起');
  ctx.enemies = [{ alive: true }];
  const out = caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(out.length, 1, '敌人出现后下一判定帧执行');
  assert.equal(caster.pending.length, 0);
});

test('M6 F6:同帧目标全灭,到期预约不消费不写 CD(执行时刻复检存活)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt'], 1);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  charge.feed(ev('fire', 3, 1, 0));
  caster.reserveFor('fire', makeRngSeq([0]), 0);
  ctx.clock = 0.75;
  ctx.enemies = []; // 同帧主角链脉冲已杀死最后目标;hasTarget 入参过期(仍传 true)
  const out = caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(out.length, 0, '到期但复检无存活敌 → 不执行');
  assert.equal(caster.pending.length, 1, '预约保留(挂起),不被消费');
  assert.equal(caster.skillCds.fire_bolt || 0, 0, 'CD 未写入(执行才写)');
  ctx.enemies = [{ alive: true }];
  const out2 = caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(out2.length, 1, '敌人出现后执行');
  assert.equal(caster.pending.length, 0);
});

test('M6 F6 续审:发射/生效与 CD 写入、预约消费同一提交(锁链击杀末敌反例)', async () => {
  const { Battle } = await import('../scripts/battle/battle.js');
  // 场景 A(裁决反例):同帧到期预约依次=火弹、寒冰锁链,末敌 HP6 将被锁链击杀。
  // 火弹执行时刻目标仍存活 → 发射成功、CD 写入、预约消费(同一提交,弹已真实在飞)。
  const ch1 = new Charge();
  const c1 = new Caster(ch1, ['fire_bolt'], 1, ['fire_bolt', 'water_chain']);
  const ctx1 = new Battle({ atk: 10, maxHp: 100, rng: null });
  ctx1.spawnWave(1, 6); // HP6 静态靶
  ch1.feed(ev('fire', 3, 1, 0)); c1.reserveFor('fire', makeRngSeq([0]), 0);
  ch1.feed(ev('water', 3, 1, 0)); c1.reserveFor('water', makeRngSeq([0]), 0);
  assert.equal(c1.pending.length, 2);
  ctx1.clock = 0.75;
  const out = c1.tick(ctx1, true, makeRngSeq([0]));
  assert.equal(out.length, 2, '火弹+锁链同帧执行');
  assert.equal(ctx1.bolts.length, 1, '火弹在执行提交内真实发射(不再交 main 延后)');
  assert.equal(c1.skillCds.fire_bolt, 2.0, '发射成功才写 CD');
  assert.equal(c1.pending.length, 0, '两预约均消费');
  // 场景 B:执行时刻已无存活目标 → 火弹预约保留挂起、不写 CD(同提交回滚)
  const ch2 = new Charge();
  const c2 = new Caster(ch2, ['fire_bolt'], 1);
  const ctx2 = mockCtx(10, 0);
  ctx2.enemies = [];
  ch2.feed(ev('fire', 3, 1, 0)); c2.reserveFor('fire', makeRngSeq([0]), 0);
  ctx2.clock = 2.0;
  c2.tick(ctx2, true, makeRngSeq([0])); // nearestAlive=null → 挂起(不消费)
  ctx2.enemies = [{ alive: false }]; // 复检通过?否——alive=false → 仍挂起
  c2.tick(ctx2, true, makeRngSeq([0]));
  assert.equal(c2.pending.length, 1, '无存活目标预约保留');
  assert.equal(c2.skillCds.fire_bolt || 0, 0, '未写 CD');
  ctx2.enemies = [{ alive: true }];
  assert.equal(c2.tick(ctx2, true, makeRngSeq([0])).length, 1, '目标出现后执行');
});

// ---- M6 F5:skill_mult 覆盖命中时刻与治疗路径(真实 Battle 弹道/命中/光环) ----
test('M6 F5:灼烧/土盾按发射时刻有效攻击(atk×mult)计算(真实 launch→命中路径)', async () => {
  const { Battle } = await import('../scripts/battle/battle.js');
  const battle = new Battle({ atk: 10, maxHp: 100, rng: null });
  battle.spawnWave(1, 500); // 静态靶(x=560)
  const e = battle.enemies[0];
  battle.launch({ element: 'fire', tier: 1, mult: 1.72 }); // Lv10 ×1.72,发射时刻 atkEff=17.2
  for (let i = 0; i < 120 && battle.bolts.length; i++) battle.update(1 / 60); // 飞行至命中
  assert.ok(e.burn, '灼烧已附加');
  assert.ok(Math.abs(e.burn.dpsFloat - 17.2 * 0.2) < 1e-9, `灼烧 dps=${e.burn.dpsFloat}(应 17.2×0.2=3.44,不读已恢复的 atk=10)`);
  // 土盾:round(17.2×0.5)=9
  const b2 = new Battle({ atk: 10, maxHp: 100, rng: null });
  b2.spawnWave(1, 500);
  b2.launch({ element: 'earth', tier: 1, mult: 1.72 });
  for (let i = 0; i < 120 && b2.bolts.length; i++) b2.update(1 / 60);
  assert.equal(b2.shield, 9, `土盾 ${b2.shield}(应 round(17.2×0.5)=9)`);
  // 对照:mult 缺省=1 → 10×0.5=5(旧行为回归保护)
  const b3 = new Battle({ atk: 10, maxHp: 100, rng: null });
  b3.spawnWave(1, 500);
  b3.launch({ element: 'earth', tier: 1 });
  for (let i = 0; i < 120 && b3.bolts.length; i++) b3.update(1 / 60);
  assert.equal(b3.shield, 5, '无乘数时土盾 round(10×0.5)=5');
});

test('M6 F5:光环治疗乘 skill_mult(maxHp 基内核不读 atk,乘数单独透传)', async () => {
  const { Battle } = await import('../scripts/battle/battle.js');
  const { dispatch, tickAura } = await import('../scripts/skills/behaviors.js');
  const { skillById } = await import('../scripts/skills/library.js');
  const battle = new Battle({ atk: 10, maxHp: 100, rng: null });
  battle.hp = 50;
  const skill = skillById('wood_aura');
  dispatch(battle, skill, 1, 1.72); // Lv10 ×1.72
  assert.ok(Math.abs(battle.aura.healFloat - 1.72) < 1e-9, `healFloat=${battle.aura.healFloat}(应 100×0.01×1×1.72)`);
  const healed = tickAura(battle.aura, 0, 1.0, battle);
  assert.equal(healed, 2, '首跳 round(1.72)=2(原无乘数为 1)');
});

test('M6 主角链:未拥有技能不参与(拥有制,03 文档 2.5)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt', 'water_chain'], 1);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  const out = caster.tick(ctx, true, makeRngSeq([0]));
  assert.ok(!out.some(u => u.skill.id === 'water_chain'), '未拥有技能不执行');
  assert.ok(out.some(u => u.skill.id === 'fire_bolt'), '已拥有技能执行');
});

test('M6 F14:主角链逐技能执行前复检目标(前槽非子弹杀光末敌,后槽不消费不写 CD)', () => {
  const charge = new Charge();
  // 装配顺序=烈焰环类(脉冲,前槽)→寒冰锁链(后槽);ATK 足够一击杀光
  const caster = new Caster(charge, ['fire_pulse', 'water_chain'], 1, ['fire_pulse', 'water_chain']);
  const ctx = mockCtx(100, 0);
  let alive = { n: 1 };
  ctx.enemies = [{
    alive: true, hp: 6, x: 500, y: 240,
    hurt(d) { this.hp -= d; if (this.hp <= 0) { this.alive = false; alive.n--; } return { killed: this.hp <= 0 }; },
  }];
  const out = caster.tick(ctx, true, makeRngSeq([0]));
  assert.equal(out.length, 1, '仅前槽脉冲执行(后槽复检无目标被跳过)');
  assert.equal(out[0].skill.id, 'fire_pulse');
  assert.equal(alive.n, 0, '末敌已被前槽击杀');
  assert.equal(caster.skillCds.water_chain || 0, 0, '后槽非子弹技能不写 CD(不再用过期 hasTarget)');
  assert.ok(caster.skillCds.fire_pulse > 0, '前槽正常写 CD');
});

// ---- M6 批次 D:经济系统(03 文档 2.2~2.7 数字例,TDD 第 14 条) ----
test('M6 经济:击杀/通关产出数字例(03 文档 2.2/2.7)', () => {
  assert.deepEqual(killReward(1), { coins: 3, mats: 1 }, '普通怪 2+w=3 币 1 材料');
  assert.deepEqual(killReward(10, true), { coins: 240, mats: 20 }, 'Boss (2+10)×20=240 币 20 材料');
  assert.deepEqual(victoryReward(1), { coins: 50, mats: 10 }, '通关 50×1/10×1');
  assert.deepEqual(victoryReward(3), { coins: 150, mats: 30 }, '通关 50×3/10×3');
  // 第 1 关全通合计(03 文档 2.7):小怪 1026 + Boss 240 + 通关 50 = 1316 币;128+20+10=158 材料
  let coins = 0, mats = 0;
  for (let w = 1; w <= 9; w++) {
    const n = 4 + 2 * w;
    for (let i = 0; i < n; i++) { const r = killReward(w); coins += r.coins; mats += r.mats; }
  }
  for (let i = 0; i < 2; i++) { const r = killReward(10); coins += r.coins; mats += r.mats; }
  const rb = killReward(10, true); coins += rb.coins; mats += rb.mats;
  const rv = victoryReward(1); coins += rv.coins; mats += rv.mats;
  assert.equal(coins, 1316, '第 1 关全通货币 1316(裁决复核口径)');
  assert.equal(mats, 158, '第 1 关全通材料 158');
});

test('M6 经济:角色升级成本与技能乘数(03 文档 2.3/2.4 数字例)', () => {
  assert.equal(levelUpCost(1), 10);  // round(10×1^1.3)
  assert.equal(levelUpCost(2), 25);  // round(10×2^1.3)=round(24.63)
  assert.equal(levelUpCost(3), 42);  // round(10×3^1.3)=round(41.71)
  assert.equal(levelUpCost(10), 200); // round(10×10^1.3)=round(199.53)
  assert.equal(skillUpCost(1), 5); assert.equal(skillUpCost(5), 25);
  assert.equal(skillMult(1), 1.0);
  assert.ok(Math.abs(skillMult(3) - 1.16) < 1e-9);
  assert.ok(Math.abs(skillMult(10) - 1.72) < 1e-9, 'Lv10 上限 ×1.72');
  // 升级流:材料不足 null;成功扣材料
  const p = { level: 1, materials: 9 };
  assert.equal(applyLevelUp(p), null, '材料不足');
  p.materials = 77; // 10+25+42 → Lv1→Lv4 花 77
  assert.equal(applyLevelUp(p).level, 2);
  assert.equal(applyLevelUp(p).level, 3);
  assert.equal(applyLevelUp(p).level, 4);
  assert.equal(p.materials, 0, '77 材料恰好升到 Lv4(03 文档 2.7)');
  // 技能升级:5×lv
  const q = { materials: 75, skillLevels: { fire_bolt: 1 } };
  for (let lv = 1; lv <= 5; lv++) assert.equal(applySkillUp(q, 'fire_bolt').level, lv + 1);
  assert.equal(q.materials, 0, 'Lv1→Lv6 花 75(03 文档 2.7)');
  assert.equal(applySkillUp(q, 'fire_bolt'), null, '材料耗尽');
});

test('M6 经济:抽卡(无重复模型——10 抽 1000 币满池,裁决 F4)', () => {
  const p = { coins: 1000, ownedSkills: defaultEconomy().ownedSkills };
  assert.equal(p.ownedSkills.length, 5, '初始拥有 5 初始弹');
  assert.equal(COIN_PER_GACHA, 100);
  assert.equal(SKILL_LEVEL_CAP, 10);
  const drawn = [];
  let i = 0;
  const seq = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.95]; // 确定性序列
  while (true) {
    const r = gacha(p, () => seq[i++ % seq.length]);
    if (!r) break;
    assert.ok(!r.error, '1000 币足够 10 抽');
    drawn.push(r.skillId);
  }
  assert.equal(drawn.length, 10, '恰好 10 抽集齐(无重复模型)');
  assert.equal(new Set(drawn).size, 10, '每抽必得新技能');
  assert.equal(p.coins, 0, '满池花 1000 币');
  assert.equal(p.ownedSkills.length, 15, '15 技能全拥有');
  assert.equal(gacha(p, () => 0), null, '满池后入口置灰(null)');
  // 货币不足
  const q = { coins: 99, ownedSkills: defaultEconomy().ownedSkills };
  const r2 = gacha(q, () => 0);
  assert.equal(r2.error, 'coins', '货币不足拒绝');
  assert.equal(q.coins, 99, '不足不扣币');
  // 1316 币:满池 10 抽花 1000 余 316(03 文档 2.7)
  const r3 = { coins: 1316, ownedSkills: defaultEconomy().ownedSkills };
  let j = 0;
  while (gacha(r3, () => seq[j++ % seq.length])?.skillId);
  assert.equal(r3.coins, 316, '1316 币满池后余 316');
});

// ---- REQ-08 F8:预约认领幂等的模块组合测试(REQ-09 F11 口径更正)----
// 说明:本组用例在测试内**复刻** main.js FIGHTING 绑定段的调用序列(逐事件入口→tick→三路回写),
// 验证 cast/engine 模块组合与 resKey/轮次门控语义;**未执行 main.js 实际主循环回调**——
// 产品接线(真实 main 循环消费)由 CDP 冒烟 .tmp/m6-f8-cdp.mjs 经浏览器实际游戏循环覆盖。
function mkWire(owned) {
  const charge = new Charge();
  const caster = new Caster(charge, owned, 1, owned);
  const engine = new BoardEngine(7);
  const ctx = mockCtx(10, 0);
  ctx.enemies = [{ alive: true }];
  const events = [];
  const frame = (dt) => {
    caster.update(dt); ctx.clock += dt;
    for (const e of events.splice(0)) { // 逐事件:feed+reserveFor+入口回填(与 main.js 逐句同构)
      charge.feed({ ...e, t: ctx.clock });
      const p = caster.reserveFor(e.element, () => 0, ctx.clock);
      if (p) {
        p.round = engine.roundSeq; // 盖章所属轮
        engine.setBlockFx(e.bk, { el: e.element, reserved: true, skillId: p.skillId, tier: p.tier, resKey: p.id });
      }
    }
    const usedList = caster.tick(ctx, ctx.enemies.some(e => e.alive), () => 0);
    for (const used of usedList) {
      if (used.from === 'elim' && (used.resRound === undefined || used.resRound === engine.roundSeq)) {
        engine.claimBlockFx(used.skill.el, used.skill.id, used.tier, used.resKey);
      }
    }
    for (const p of caster.pending) {
      if (p.round === undefined) p.round = engine.roundSeq; // 阶段2新建预约首见盖章
      if (p.round === engine.roundSeq) engine.claimBlockFx(p.el, p.skillId, p.tier, p.id);
    }
    return usedList;
  };
  const beginRound = (els) => { // 模拟 _beginRound:轮次+1、块绑定重建
    engine.roundSeq++;
    engine.blockFx = new Map(els.map((el, i) => [`b${i}`, { el, reserved: false }]));
  };
  const mkEv = (bk) => ({ type: 'match_cleared', element: 'fire', count: 3, chain: 1, t: 0, bk });
  return { charge, caster, engine, ctx, events, frame, beginRound, mkEv };
}

test('M6 REQ-08 F8:A 同轮双块单候选——存续预约逐帧回写幂等,第二块保持蓄能', () => {
  const w = mkWire(['fire_bolt']);
  w.beginRound(['fire', 'fire']);
  w.events.push(w.mkEv('b0'), w.mkEv('b1'));
  w.frame(0);
  assert.equal(w.caster.pending.length, 1, '单候选仅 1 个预约(事件2 留池)');
  assert.equal(w.charge.tiers.fire, 1, '留池 1 档蓄能');
  assert.equal(w.engine.blockFx.get('b0').reserved, true, 'b0 入口绑定火弹');
  assert.equal(w.engine.blockFx.get('b1').reserved, false, 'b1 入口不误标');
  for (let i = 0; i < 7; i++) w.frame(0.1); // t=0~0.7:存续预约逐帧回写 7 次(原缺陷第 2 帧即扩散到 b1)
  assert.equal(w.engine.blockFx.get('b1').reserved, false, 'b1 经 7 帧重复回写仍蓄能(resKey 幂等)');
  w.frame(0.1); // t=0.8 ≥ t0+0.75:执行,执行记录回写同 resKey
  assert.equal(w.caster.pending.length, 0, '预约执行消费');
  assert.equal(w.engine.blockFx.get('b0').skillId, 'fire_bolt', '执行记录回写不换块不覆盖(幂等互认)');
  assert.equal(w.engine.blockFx.get('b1').reserved, false, '执行后 b1 仍蓄能');
});

test('M6 REQ-08 F8:B 同轮双块双候选——各自显示本块预约(resKey 互不串块)', () => {
  const w = mkWire(['fire_bolt', 'fire_dotzone']);
  w.beginRound(['fire', 'fire']);
  w.events.push(w.mkEv('b0'), w.mkEv('b1'));
  w.frame(0);
  assert.equal(w.caster.pending.length, 2, '两事件两预约');
  const b0 = w.engine.blockFx.get('b0'), b1 = w.engine.blockFx.get('b1');
  assert.equal(b0.reserved && b1.reserved, true, '双块各自绑定');
  assert.notEqual(b0.skillId, b1.skillId, '两技能各占其一(不重复)');
  assert.notEqual(b0.resKey, b1.resKey, 'resKey 互异(预约身份)');
  for (let i = 0; i < 5; i++) w.frame(0.1); // 存续回写多帧
  assert.equal(w.engine.blockFx.get('b0').skillId, b0.skillId, '重复回写不换块');
  assert.equal(w.engine.blockFx.get('b1').skillId, b1.skillId, '重复回写不覆盖他块');
});

test('M6 REQ-08 F8:C 0.60s 延迟回落预约正确绑定(阶段2 首见盖章+存续认领)', () => {
  const w = mkWire(['fire_bolt']);
  w.caster.skillCds.fire_bolt = 0.5; // 事件时 CD 未就绪 → 池蓄能,0.5s 后 tick 阶段2 回落建预约
  w.beginRound(['fire']);
  w.events.push(w.mkEv('b0'));
  w.frame(0);
  assert.equal(w.caster.pending.length, 0, 'CD 未就绪不建预约');
  assert.equal(w.engine.blockFx.get('b0').reserved, false, '蓄能口径');
  for (let i = 0; i < 6; i++) w.frame(0.1); // t=0.6 CD 就绪(浮点累加,0.5 时残留 3e-17)
  assert.equal(w.caster.pending.length, 1, '阶段2 回落建预约(REQ-04 F1)');
  assert.equal(w.engine.blockFx.get('b0').reserved, true, '延迟预约已绑定本块(段③内)');
  w.frame(0.2); // t=0.8 ≥ max(t0+0.75, selT)=0.75 执行
  assert.equal(w.caster.pending.length, 0, '执行消费');
  assert.equal(w.engine.blockFx.get('b0').skillId, 'fire_bolt', '执行记录回写幂等(不换块)');
});

test('M6 REQ-08 F8:D 跨轮存续预约——不误认领新轮块(轮次关系保留)', () => {
  const w = mkWire(['fire_bolt']);
  w.beginRound(['fire']);
  w.events.push(w.mkEv('b0'));
  w.frame(0); // 建预约绑 b0(第 1 轮);此后无敌人挂起
  w.ctx.enemies = [];
  w.frame(0.3); // t=0.3 挂起(p.round=1)
  w.beginRound(['fire']); // 第 2 轮:块绑定重建,新块未认领
  w.frame(0.1); // t=0.4 存续预约回写
  assert.equal(w.caster.pending.length, 1, '预约仍存续(执行权保留)');
  assert.equal(w.engine.blockFx.get('b0').reserved, false, '跨轮存续预约不认领新轮块(轮次门控)');
  w.ctx.enemies = [{ alive: true }];
  w.frame(0.5); // t=0.9 执行(resRound=1 ≠ 当前轮 2 → 执行记录也不认领新块)
  assert.equal(w.caster.pending.length, 0, '跨轮预约到期正常执行消费');
  assert.equal(w.engine.blockFx.get('b0').reserved, false, '跨轮执行记录不绑定新轮块(所属轮次关系)');
});
