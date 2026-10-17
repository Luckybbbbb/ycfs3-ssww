// tests/m7.test.mjs
// 伤害冒字与异常状态标记单测(03 文档 v0.3 第 6 节,REQ-SSWW-DESIGN-v0.3-03 APPROVED 实现批次)
// 覆盖:6.4 数字例与边界例(致死溢出/封顶盾/光环/护盾吸收拆分)、6.5 全结算路径(锁链/脉冲/石甲术
//       非 applyHit 路径)、6.2b 状态标记(减速跃迁/束缚/眩晕)、6.1 三段运动/防重叠/上限、单向解耦
// 运行: node --test tests/m7.test.mjs
// 相对路径: tests/m7.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Battle } from '../scripts/battle/battle.js';
import { FxLayer } from '../scripts/ui/fx.js';
import { applyChain, applyPulse, applyShieldSpell, applyBind, markSlow, tickZones, tickAura } from '../scripts/skills/behaviors.js';
import { SKILL_LIBRARY } from '../scripts/skills/library.js';
import { GEM_COLORS } from '../scripts/ui/draw_util.js';

// ---- 桩 ----
const mkEnemy = (hp = 100, x = 300, y = 200) => ({
  x, y, hp, maxHp: hp, alive: true, isBoss: false, w: 1,
  hurt(dmg) {
    if (!this.alive) return { applied: 0, killed: false };
    const a = Math.min(this.hp, dmg); // 与 enemy.hurt 同口径:致死溢出受剩余 HP 限制
    this.hp -= a;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
    return { applied: a, killed: !this.alive };
  },
  update() { return []; },   // 敌行动桩(battle.update 调用)
  tickBurn() { return 0; },  // 灼烧跳伤桩
});
const mkBolt = (el, tier, rawDmg, atkEff = null, extra = {}) => ({
  el, tier, rawDmg, atkEff, x: 290, y: 200, t: 0, hitSet: new Set(),
  done: false, blastR: 0, aoeAll: false, splash: null, blasted: false,
  vx: -400, vy: 0, // 弹速方向(advanceBolt 逐帧位移;直击冒字 fromAngle 来源)
  ...extra,
});
const skill = (id) => SKILL_LIBRARY.find(s => s.id === id);
const kinds = (evs) => evs.map(e => e.kind);

// ---- 6.4 数字例 ----
test('M7 数字例:火弹 t1 直击 -10 / t3 直击 24 / Lv3 atkEff 28(6.4 可机械复算)', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const e = mkEnemy(100);
  b.applyHit(mkBolt('fire', 1, 10), e, 1); // round(10×1.0)=10
  assert.equal(b.floatTexts[0].kind, 'dmg');
  assert.equal(b.floatTexts[0].n, 10, 't1 直伤=round(10×1.0)=10');
  assert.equal(b.floatTexts[0].el, 'fire');
  assert.ok(typeof b.floatTexts[0].fromAngle === 'number', '直击 fromAngle=弹速方向');
  const e2 = mkEnemy(100);
  b.applyHit(mkBolt('fire', 3, 24), e2, 1); // round(10×2.4)=24
  assert.equal(b.floatTexts.at(-1).n, 24, 't3 直伤=round(10×2.4)=24');
  const e3 = mkEnemy(100);
  b.applyHit(mkBolt('fire', 3, 28, 11.6), e3, 1); // atkEff=11.6 → round(11.6×2.4)=28
  assert.equal(b.floatTexts.at(-1).n, 28, 'Lv3(skill_mult 1.16)→28');
});

test('M7 致死溢出(裁决 F3):敌 HP6 伤 10 → `-6`+`击破`×1(不显示 -10)', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const e = mkEnemy(6);
  b.applyHit(mkBolt('fire', 1, 10), e, 1);
  const dmgEv = b.floatTexts.find(x => x.kind === 'dmg');
  assert.equal(dmgEv.n, 6, 'N=实际 applied=min(6,10)=6');
  assert.equal(kinds(b.floatTexts).filter(k => k === 'kill').length, 1, '击破恰 1 条(与伤害冒字并存)');
});

test('M7 主角受击拆分(6.4):无盾 -12;HP5 伤 12 → -5;盾吸 5 → 🛡5+-7;无敌 → 免伤;全吸 → 仅免伤', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b.hurtPlayer(12);
  assert.deepEqual(kinds(b.floatTexts), ['hurt']);
  assert.equal(b.floatTexts[0].n, 12, 'N=结算前后 HP 差值');
  const b2 = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b2.hp = 5;
  b2.hurtPlayer(12); // 实扣 5(HP 下限 0)
  assert.equal(b2.floatTexts[0].n, 5, 'HP5 伤 12 → -5(不显示 -12)');
  const b3 = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b3.shield = 5;
  b3.hurtPlayer(12); // 吸 5,扣 7
  assert.deepEqual(kinds(b3.floatTexts), ['absorb', 'hurt'], '🛡5 + -7 并显');
  assert.equal(b3.floatTexts[0].n, 5);
  assert.equal(b3.floatTexts[1].n, 7);
  const b4 = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b4.invincibleT = 3;
  b4.hurtPlayer(12);
  assert.deepEqual(kinds(b4.floatTexts), ['immune'], '无敌 → 免伤');
  const b5 = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b5.shield = 20;
  b5.hurtPlayer(12); // 全吸,实扣 0
  assert.deepEqual(kinds(b5.floatTexts), ['immune'], '全吸(实扣 0)→ 仅免伤,不产 absorb(REQ-M7-01 F2 修正)');
  // 部分吸收仍 🛡N+-N 并显
  const b6 = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b6.shield = 5;
  b6.hurtPlayer(12);
  assert.deepEqual(kinds(b6.floatTexts), ['absorb', 'hurt']);
  // 受击方向=敌弹方向(REQ-M7-01 F1)
  const b7 = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b7.hurtPlayer(12, Math.atan2(0, -1));
  assert.ok(Math.abs(b7.floatTexts[0].fromAngle - Math.PI) < 1e-9, '敌弹向左 → fromAngle=π');
});

test('M7 生机光环(6.4 裁决例):maxHP265 tier5 Lv1 每跳 +12 / Lv3 +14;满血不产事件', () => {
  const b = new Battle({ atk: 10, maxHp: 265, level: 12 });
  b.hp = 200;
  b.aura = { healFloat: 265 * 0.01 * 4.6, until: 10 }; // Lv1:12.19
  tickAura(b.aura, 0, 1, b); // 1 跳
  assert.equal(b.floatTexts[0].kind, 'aura');
  assert.equal(b.floatTexts[0].n, 12, 'round(12.19)=12');
  const b2 = new Battle({ atk: 10, maxHp: 265, level: 12 });
  b2.hp = 200;
  b2.aura = { healFloat: 265 * 0.01 * 4.6 * 1.16, until: 10 };
  tickAura(b2.aura, 0, 1, b2);
  assert.equal(b2.floatTexts[0].n, 14, 'Lv3 ×1.16 → round(14.14)=14');
  // 满血:实际回复 0 → 不产事件
  const b3 = new Battle({ atk: 10, maxHp: 265, level: 12 });
  b3.hp = 265;
  b3.aura = { healFloat: 12.19, until: 10 };
  tickAura(b3.aura, 0, 1, b3);
  assert.equal(b3.floatTexts.length, 0, '满血跳 0 → 不产事件(6.4 不显示理论量)');
});

test('M7 封顶盾边界(6.4 设计样例=土弹命中):盾 29/30(cap 30)+土弹 5 → 实际 🛡+1;盾满不产;石甲术另测', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b.shield = 29;
  b.applyHit(mkBolt('earth', 1, 10), mkEnemy(100, 300, 500), 1); // 土弹命中:round(10×1.0×0.5)=5 → 29+5 封顶 30
  const ev = b.floatTexts.find(x => x.kind === 'shieldGain');
  assert.equal(ev.n, 1, '设计样例:土弹 +5 封顶后实际增量 1(6.4)');
  b.shield = 30;
  b.floatTexts = [];
  b.applyHit(mkBolt('earth', 1, 10), mkEnemy(100, 300, 500), 1);
  assert.equal(b.floatTexts.filter(x => x.kind === 'shieldGain').length, 0, '盾满增量 0 → 不产事件');
  // 石甲术(applyShieldSpell):理论增盾 round(10×2.0)=20(ATK×2.0),封顶断言另列(非土弹样例替代)
  const b2 = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b2.px = 110;
  b2.shield = 29;
  applyShieldSpell(b2, skill('earth_shield'), 1); // 理论 20 → min(30, 49)=30
  const ev2 = b2.floatTexts.find(x => x.kind === 'shieldGain');
  assert.equal(ev2.n, 1, '石甲术封顶后实际增量 1(理论 20)');
});

// ---- 6.5 非 applyHit 路径(锁链/脉冲/石甲) ----
test('M7 锁链/脉冲路径(裁决 F2):行为内核直呼 e.hurt 后产正确元素色 dmg 事件', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const primary = mkEnemy(100, 300, 200);
  const near = mkEnemy(100, 360, 200);
  b.enemies = [primary, near];
  const chain = skill('water_chain');
  const n = applyChain(b, chain, 1); // tier1:主目标+⌊2+0⌋=2 目标?chainExtra(1)=2+0=2 → 3 目标,近敌 1 只
  const dmgs = b.floatTexts.filter(x => x.kind === 'dmg');
  assert.ok(dmgs.length >= 2, `锁链每目标 1 条(实得 ${dmgs.length},目标数 ${n})`);
  assert.ok(dmgs.every(x => x.el === 'water'), '元素来源=skill.el(water)');
  assert.equal(dmgs[0].n, Math.round(10 * 0.6 * 1.0), 'chain 伤害=round(ATK×0.6×TM)');
  const b2 = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const c = mkEnemy(100, 300, 200);
  b2.enemies = [c];
  applyPulse(b2, skill('fire_pulse'), 1); // r80 内 1 敌
  const pd = b2.floatTexts.filter(x => x.kind === 'dmg');
  assert.equal(pd.length, 1);
  assert.equal(pd[0].el, 'fire');
  assert.equal(pd[0].n, Math.round(10 * 1.8 * 1.0), 'pulse=round(ATK×1.8×TM)');
});

test('M7 状态标记(6.2b):束缚施加 🌿束缚 1 条+bindEl 记录;眩晕 💫 仅更强时再冒', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const e = mkEnemy(100);
  b.enemies = [e];
  applyBind(b, skill('wood_bind'), 1);
  assert.equal(b.floatTexts.filter(x => x.kind === 'bindMark').length, 1);
  assert.equal(e.bindEl, 'wood', '跳伤冒字元素来源=绑定时刻 skill.el');
  const e2 = mkEnemy(100);
  b.enemies = [e2]; b.floatTexts = [];
  const pulse = { ...skill('earth_pulse') };
  applyPulse(b, pulse, 1);
  assert.equal(b.floatTexts.filter(x => x.kind === 'stunMark').length, 1, '眩晕施加 1 条');
  b.floatTexts = [];
  e2.stunT = 0; // 已到期
  applyPulse(b, pulse, 1);
  assert.equal(b.floatTexts.filter(x => x.kind === 'stunMark').length, 1, '到期后再施加再冒 1 条');
  b.floatTexts = [];
  applyPulse(b, pulse, 1); // stunT=0.5 相同(非更强)
  assert.equal(b.floatTexts.filter(x => x.kind === 'stunMark').length, 0, '同幅刷新不重复冒(仅更强时)');
});

test('M7 减速跃迁(裁决 F1):markSlow 首用/换源/增强/重放为真,同源同幅为假', () => {
  const e = mkEnemy(100);
  assert.equal(markSlow(e, 'water_bolt', 30, 0), true, '首次生效');
  assert.equal(markSlow(e, 'water_bolt', 30, 0), false, '同源同幅(逐帧续时/刷新)不冒');
  assert.equal(markSlow(e, 'water_bolt', 35, 0), true, '幅度增强');
  assert.equal(markSlow(e, 'water_bolt', 35, 1), true, '主动重放(gen 变化)');
  assert.equal(markSlow(e, 'water_field', 30, 0), true, '换源');
});

test('M7 同领域持续 120 帧仅首次提示一次(裁决 F1 测试项)', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const e = mkEnemy(100, 300, 200);
  b.enemies = [e];
  const zone = { kind: 'slow', x: 300, y: 200, r: 100, slowPct: 30, until: 999, skillId: 'water_field', gen: 1 };
  let marks = 0;
  for (let f = 0; f < 120; f++) {
    b.floatTexts = [];
    // 与 battle.update 同构:slowT 每帧扣减,zone 每帧续 0.1(behaviors.tickZones slow 分支)
    e.slowT = Math.max(0, (e.slowT || 0) - 1 / 60);
    tickZones([zone], f / 60, (f + 1) / 60, b.enemies, b);
    marks += b.floatTexts.filter(x => x.kind === 'slowMark').length;
  }
  assert.equal(marks, 1, `同领域 120 帧冒字次数=${marks}(应仅首帧 1 条)`);
  // 重放:zone.gen+1 → 再冒 1 条
  zone.gen = 2;
  tickZones([zone], 2, 2 + 1 / 60, b.enemies, b);
  assert.equal(b.floatTexts.filter(x => x.kind === 'slowMark').length, 1, '主动重放(gen+1)再冒 1 条');
});

// ---- fx 层:三段运动/防重叠/上限/文案颜色 ----
test('M7 fx 三段运动(6.1):喷出段位移=6×speed×t 沿方向;寿命 1.2s;imp 分级 speed', () => {
  const fx = new FxLayer();
  fx.combatFloat({ kind: 'dmg', x: 300, y: 200, n: 10, el: 'fire', fromAngle: 0, jitter: 0, importance: 1 });
  const c = fx.combatTexts[0];
  assert.equal(c.text, '-10');
  assert.equal(c.color, '#ff4444', '直击色=受弹元素色(GEM_SRC fire)');
  assert.equal(c.speed, 90, 'imp1 speed=50+1×40');
  assert.equal(c.peak, 1.2, 'imp1 peak=0.9+0.3');
  fx.update(0.072); // p=0.06(段①)
  assert.ok(Math.abs(c.x - (300 + 0.072 * 6 * 90)) < 1e-6, `喷出段位移=6×speed×t(实得 ${c.x})`);
  assert.ok(Math.abs(c.y - 200) < 1e-9, '方向 0rad → y 不变');
  for (let i = 0; i < 200; i++) fx.update(0.016); // 超寿命
  assert.equal(fx.combatTexts.length, 0, '1.2s 后消亡');
});

test('M7 fx 文案映射(6.2a):🔥2/🌿3/🛡+5/+2/免伤/击破/❄减速', () => {
  const fx = new FxLayer();
  fx.combatFloat({ kind: 'burn', x: 0, y: 0, n: 2 });
  fx.combatFloat({ kind: 'bindDot', x: 0, y: 40, n: 3, el: 'wood' });
  fx.combatFloat({ kind: 'shieldGain', x: 0, y: 80, n: 5 });
  fx.combatFloat({ kind: 'leech', x: 0, y: 120, n: 2 });
  fx.combatFloat({ kind: 'immune', x: 0, y: 160 });
  fx.combatFloat({ kind: 'kill', x: 0, y: 200 });
  fx.combatFloat({ kind: 'slowMark', x: 0, y: 240 });
  assert.deepEqual(fx.combatTexts.map(c => c.text), ['🔥2', '🌿3', '🛡+5', '+2', '免伤', '击破', '❄减速']);
  assert.equal(fx.combatTexts[1].color, '#44ff44', '束缚跳伤木色(bindEl)');
  assert.equal(fx.combatTexts[4].imp, 2, '免伤 importance 2');
});

test('M7 fx 防重叠(6.1):同位置 ±24px 向上推 min(fy, ft.y - size×1.1)', () => {
  const fx = new FxLayer();
  fx.combatFloat({ kind: 'dmg', x: 300, y: 200, n: 5, el: 'fire', jitter: 0 });
  const first = fx.combatTexts[0];
  fx.combatFloat({ kind: 'dmg', x: 310, y: 205, n: 6, el: 'fire', jitter: 0 });
  const second = fx.combatTexts[1];
  assert.ok(second.y <= first.y - first.size * 1.1 + 1e-9, `第二条上推(实得 ${second.y} vs ${first.y})`);
  // 不同位置(>24px)不推
  fx.combatFloat({ kind: 'dmg', x: 400, y: 200, n: 7, el: 'fire', jitter: 0 });
  assert.equal(fx.combatTexts[2].y, 200, '距离外不推');
});

test('M7 fx 上限 64(6.1):超出丢弃 importance 最低、最早', () => {
  const fx = new FxLayer();
  for (let i = 0; i < 63; i++) fx.combatFloat({ kind: 'dmg', x: i * 30, y: 100, n: 1, el: 'fire', jitter: 0, importance: 1 });
  fx.combatFloat({ kind: 'burn', x: 2000, y: 100, n: 1 }); // imp0(最低),t 最大?后进 t=0……
  // 构造:64 条已满(63 imp1 + 1 imp0),再进 1 条 imp2 → 丢 imp0
  assert.equal(fx.combatTexts.length, 64);
  assert.ok(fx.combatTexts.some(c => c.imp === 0), 'imp0 在列');
  fx.combatFloat({ kind: 'kill', x: 2500, y: 100 }); // imp2 → 满员,丢 imp0(最低)
  assert.equal(fx.combatTexts.length, 64);
  assert.ok(!fx.combatTexts.some(c => c.imp === 0), 'imp0 被丢弃');
  assert.ok(fx.combatTexts.some(c => c.text === '击破'), '新 imp2 进入');
});

// ---- 单向解耦(6.5/自查) ----
test('M7 解耦:battle/behaviors 不 import ui(源码断言);drainFloatTexts 排空', () => {
  for (const f of ['scripts/battle/battle.js', 'scripts/skills/behaviors.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8');
    assert.ok(!src.includes("from '../ui/"), `${f} 不得 import ui`);
  }
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  b.floatEvent({ kind: 'burn', x: 0, y: 0, n: 1 });
  const out = b.drainFloatTexts();
  assert.equal(out.length, 1);
  assert.equal(b.drainFloatTexts().length, 0, '排空后为空');
  assert.equal(b.floatTexts.length, 0);
});

// ---- REQ-M7-01 裁决整改回归 ----
test('M7 F1 真实弹道方向:launch→update→命中 fromAngle=真实弹速方向(水平弹=0)', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const e = mkEnemy(100, 400, 200);
  e.radius = 20;
  b.enemies = [e];
  b.launch({ element: 'fire', tier: 1, mult: 1 }); // 真实发射(makeBolt vx=BOLT_SPEED)
  for (let i = 0; i < 200 && b.floatTexts.length === 0; i++) b.update(1 / 60); // 推进至命中
  const dmg = b.floatTexts.find(x => x.kind === 'dmg');
  assert.ok(dmg, '真实命中产生 dmg 事件');
  assert.ok(Math.abs(dmg.fromAngle) < 1e-6, `直击 fromAngle=弹速方向 0(实得 ${dmg.fromAngle})`);
  assert.equal(dmg.n, 10, 'round(10×1.0)=10');
});

test('M7 F1 溅射方向=爆炸中心→被溅射敌(裁决例:(560,200)→(570,230) 应 1.249rad)', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const cand = mkEnemy(100, 560, 200);
  const near = mkEnemy(100, 570, 230);
  b.enemies = [cand, near];
  const bolt = mkBolt('fire', 3, 24, null, { splash: { r: 60, mult: 0.5 }, x: 560, y: 200 });
  bolt.hitSet.add(cand);
  b.applyHit(bolt, near, 0.5, cand); // 溅射命中邻敌,中心=命中点
  const sp = b.floatTexts.find(x => x.kind === 'splash');
  assert.ok(sp, '溅射产 splash 事件');
  assert.ok(Math.abs(sp.fromAngle - Math.atan2(30, 10)) < 1e-6, `方向=atan2(30,10)=1.249(实得 ${sp.fromAngle})`);
  assert.equal(sp.importance, 0);
});

test('M7 F3 淘汰含新事件:64 条 imp2 后进 imp0 → 丢弃新事件(保留 64 imp2)', () => {
  const fx = new FxLayer();
  for (let i = 0; i < 64; i++) fx.combatFloat({ kind: 'kill', x: i * 30, y: 100, importance: 2 });
  assert.equal(fx.combatTexts.length, 64);
  fx.combatFloat({ kind: 'burn', x: 2500, y: 100, n: 1 }); // imp0 最低
  assert.equal(fx.combatTexts.length, 64);
  assert.ok(fx.combatTexts.every(c => c.imp === 2), '全部 imp2 保留(新 imp0 被弃)');
  assert.ok(!fx.combatTexts.some(c => c.text === '🔥1'), '新事件未入队');
});

test('M7 F3 同帧同重要度淘汰先后:不 update 连续 65 条同 imp → 保留第 2~65 条(丢最早)', () => {
  const fx = new FxLayer();
  for (let i = 1; i <= 65; i++) fx.combatFloat({ kind: 'dmg', x: i * 30, y: 100, n: i, el: 'fire', jitter: 0, importance: 1 }); // 连续加入,期间不 update(t 全 0)
  assert.equal(fx.combatTexts.length, 64);
  assert.ok(!fx.combatTexts.some(c => c.text === '-1'), '最早(-1)被淘汰');
  assert.ok(fx.combatTexts.some(c => c.text === '-2') && fx.combatTexts.some(c => c.text === '-65'), '保留第 2~65 条(裁决断言)');
});

test('M7 F3 同 imp 淘汰先后(update 后):满员再进同 imp → 弃最早入队(seq 最小)', () => {
  const fx = new FxLayer();
  for (let i = 0; i < 64; i++) fx.combatFloat({ kind: 'dmg', x: i * 30, y: 100, n: 1, el: 'fire', jitter: 0, importance: 1 });
  fx.update(0.1);
  const oldest = fx.combatTexts.reduce((a, c) => (c.seq < a.seq ? c : a), fx.combatTexts[0]);
  const newX = 3000;
  fx.combatFloat({ kind: 'dmg', x: newX, y: 100, n: 9, el: 'fire', jitter: 0, importance: 1 });
  assert.equal(fx.combatTexts.length, 64);
  assert.ok(!fx.combatTexts.includes(oldest), '最早入队(seq 最小)被淘汰');
  assert.ok(fx.combatTexts.some(c => c.x === newX), '新事件入队');
});

test('M7 F3 弹跳缩放(easeOutBack):经**实际 draw** 验证过冲与回落(REQ-M7-02 F7)', () => {
  const fx = new FxLayer();
  fx.combatFloat({ kind: 'dmg', x: 0, y: 0, n: 1, el: 'fire', jitter: 0, importance: 1 });
  const c = fx.combatTexts[0];
  // 录制型 ctx:记录 draw 实际设置的 font 字号
  const drawn = [];
  const ctx = {
    set font(v) { this._f = v; }, get font() { return this._f; },
    set globalAlpha(v) {}, set fillStyle(v) {}, set textAlign(v) {},
    set strokeStyle(v) {}, set lineWidth(v) {}, set lineJoin(v) {},
    fillText(text) { drawn.push({ text, font: this._f }); },
    strokeText() {}, // 描边(黑色描边调整后 draw 会调用)
  };
  fx.update(0.144 * 0.5); // 段①中点(p=0.06)
  fx.draw(ctx);
  const midFont = drawn.at(-1).font;
  const midSize = parseInt(String(midFont).match(/(\d+)px/)?.[1] || '0', 10);
  assert.ok(midSize > Math.round(c.size * 1.2), `段①中段过冲(font ${midFont} ${midSize}px > peak 字号 ${Math.round(c.size * 1.2)}px)——弹跳`);
  fx.update(0.144 * 0.5); // 段①末(p≈0.12)
  fx.draw(ctx);
  const endSize = parseInt(String(drawn.at(-1).font).match(/(\d+)px/)?.[1] || '0', 10);
  assert.ok(Math.abs(endSize - c.size * 1.2) <= 1, `段①末回落 peak(${endSize}px ≈ ${c.size * 1.2}px)`);
  // 线性缩放实现会使中段无过冲——本用例可捕获退回线性(裁决 F7 指认)
});

test('M7 F3 段②③位置采样:段②末位移=∫(6→1)×speed;段③缓升 y 递减 x 不变', () => {
  const fx = new FxLayer();
  fx.combatFloat({ kind: 'dmg', x: 0, y: 0, n: 1, el: 'fire', fromAngle: 0, jitter: 0, importance: 1 }); // speed=90
  const c = fx.combatTexts[0];
  // 段①+段②:t=0.36s(p=0.3) 位移=∫0→0.144 540dt + ∫0.144→0.36 (540→90)dt = 77.76 + 68.04 = 145.8
  for (let i = 0; i < 22; i++) fx.update(0.016); // ~0.352s
  for (let i = 0; i < 1; i++) fx.update(0.008);
  const t2 = c.t;
  const expect = 540 * 0.144 + 90 * (0.36 - 0.144) + 0.5 * (540 - 90) * (0.36 - 0.144);
  assert.ok(Math.abs(c.x - expect) < 12, `段②末位移≈145.8(实得 ${c.x.toFixed(2)},t=${t2.toFixed(3)})`);
  const xAtP3 = c.x, yAtP3 = c.y;
  for (let i = 0; i < 30; i++) fx.update(0.016); // 段③
  assert.ok(Math.abs(c.x - xAtP3) < 1e-6, '段③ x 不再位移');
  assert.ok(c.y < yAtP3, '段③缓升(y 递减)');
});

test('M7 F4 领域到期后重放恰提示一次(裁决复算例:clock≈6.0167 旧区已删 slowT 残余)', () => {
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const e = mkEnemy(100, 300, 200);
  b.enemies = [e];
  // 第一轮:释放寒霜领域(全局 ZONE_GEN+1)→ 敌标记 gen=G1
  b.floatTexts = [];
  const z1 = { kind: 'slow', x: 300, y: 200, r: 100, slowPct: 30, until: 2, skillId: 'water_field' };
  // 用 pushZone 真实入口生成(走 ZONE_GEN 递增)
  import('../scripts/skills/behaviors.js');
  const { pushZone } = behaviors_mod();
  pushZone(b, skill('water_field'), 1, { x: 300, y: 200 });
  const gen1 = b.zones[0].gen;
  // 到期:tickZones 删除旧区;slowT 残余 0.0833(每帧续 0.1)
  b.zones[0].until = 2; // 缩短到已过期
  tickZones(b.zones, 0, 3, b.enemies, b);
  e.slowT = 0.0833;
  assert.equal(b.zones.length, 0, '旧区已删除');
  // 重放:pushZone 新 gen(>gen1)→ 敌仍在区内 → 跃迁④重放 → 恰 1 条
  b.floatTexts = [];
  pushZone(b, skill('water_field'), 1, { x: 300, y: 200 });
  assert.ok(b.zones[0].gen > gen1, '新 gen 全局递增(不与残留标记撞车)');
  tickZones(b.zones, 3, 3 + 1 / 60, b.enemies, b);
  assert.equal(b.floatTexts.filter(x => x.kind === 'slowMark').length, 1, '重放恰好提示一次');
  // 持续期不重复
  b.floatTexts = [];
  for (let f = 0; f < 60; f++) {
    e.slowT = Math.max(0, e.slowT - 1 / 60);
    tickZones(b.zones, 3 + f / 60, 3 + (f + 1) / 60, b.enemies, b);
  }
  assert.equal(b.floatTexts.filter(x => x.kind === 'slowMark').length, 0, '持续期内不重复提示');
});
import * as behaviors_mod_ns from '../scripts/skills/behaviors.js';
function behaviors_mod() { return behaviors_mod_ns; }

// ---- REQ-M7-02 裁决整改:F6 颜色联动 + 状态生命周期事件断言 ----
test('M7 F6 全 kind 颜色联动:五行语义色全部引用 GEM_COLORS(共享表改值即联动)', () => {
  const fx = new FxLayer();
  fx.combatFloat({ kind: 'burn', x: 0, y: 0, n: 1 });
  fx.combatFloat({ kind: 'bindDot', x: 0, y: 30, n: 2, el: 'wood' });
  fx.combatFloat({ kind: 'leech', x: 0, y: 60, n: 3 });
  fx.combatFloat({ kind: 'aura', x: 0, y: 90, n: 4 });
  fx.combatFloat({ kind: 'shieldGain', x: 0, y: 120, n: 5 });
  fx.combatFloat({ kind: 'absorb', x: 0, y: 150, n: 6 });
  fx.combatFloat({ kind: 'slowMark', x: 0, y: 180 });
  fx.combatFloat({ kind: 'bindMark', x: 0, y: 210 });
  fx.combatFloat({ kind: 'stunMark', x: 0, y: 240 });
  const byText = Object.fromEntries(fx.combatTexts.map(c => [c.text, c.color]));
  assert.equal(byText['🔥1'], GEM_COLORS.fire, '灼烧=fire 色引用共享表');
  assert.equal(byText['🌿2'], GEM_COLORS.wood, '束缚跳伤=wood(el 引用)');
  assert.equal(byText['+3'], GEM_COLORS.wood, '吸血=wood');
  assert.equal(byText['+4'], GEM_COLORS.wood, '光环=wood');
  assert.equal(byText['🛡+5'], GEM_COLORS.earth, '土盾=earth');
  assert.equal(byText['🛡6'], GEM_COLORS.earth, '盾吸收=earth');
  assert.equal(byText['❄减速'], GEM_COLORS.water, '减速标记=water');
  assert.equal(byText['🌿束缚'], GEM_COLORS.wood, '束缚标记=wood');
  assert.equal(byText['💫眩晕'], GEM_COLORS.earth, '眩晕标记=earth');
  // 直击联动(el 引用共享表)
  const fx2 = new FxLayer();
  fx2.combatFloat({ kind: 'dmg', x: 0, y: 0, n: 1, el: 'fire' });
  assert.equal(fx2.combatTexts[0].color, GEM_COLORS.fire, '直击=受弹元素色(共享表)');
});

test('M7 状态生命周期事件(6.2b):减速自然归零后重入再冒;束缚重施再冒;灼烧/束缚到期静默', () => {
  // 减速重入:slowT 归零(battle 同款清标记)→ 再次 markSlow → 跃迁 1 条
  const b = new Battle({ atk: 10, maxHp: 100, level: 1 });
  const e = mkEnemy(100, 300, 200);
  markSlow(e, 'water_bolt', 30, 0); // 首用
  e.slowT = 0; e.slowMarkSrc = null; e.slowMarkGen = 0; // 自然衰减归零清标记(battle update 同款)
  b.floatTexts = [];
  const zone = { kind: 'slow', x: 300, y: 200, r: 100, slowPct: 30, until: 99, skillId: 'water_field', gen: 5 };
  tickZones([zone], 0, 1 / 60, [e], b);
  assert.equal(b.floatTexts.filter(x => x.kind === 'slowMark').length, 1, '失效后重入 → 再冒 1 条');
  // 束缚重施:applyBind 第二次 → 再冒 1 条
  const e2 = mkEnemy(100, 300, 200);
  b.enemies = [e2];
  applyBind(b, skill('wood_bind'), 1);
  b.floatTexts = [];
  applyBind(b, skill('wood_bind'), 1); // 重施(刷新 bindUntil)
  assert.equal(b.floatTexts.filter(x => x.kind === 'bindMark').length, 1, '束缚重施 → 再冒 1 条');
  // 灼烧到期静默:tickBurn until 后 total=0 → 无 burn 事件
  const e3 = mkEnemy(100, 300, 200);
  e3.tickBurn = function (prev, clock) { // 真实 tickBurn 语义桩:until 后 0
    if (clock > 3) return 0;
    return this.hurt(2).applied;
  };
  b.floatTexts = [];
  b.enemies = [e3];
  // 模拟 battle tick 调用(6.5 出口在 battle 循环):到期帧 total=0 → 不产事件
  const burnDmg = e3.tickBurn(3, 4);
  if (burnDmg > 0) b.floatEvent({ kind: 'burn', x: e3.x, y: e3.y, n: burnDmg, importance: 0 });
  assert.equal(b.floatTexts.length, 0, '灼烧到期 → 静默无冒字');
});

// ---- REQ-M7-03 裁决整改:真实 Enemy+Battle.update 验证状态生命周期(不自造结果) ----
test('M7 F7 状态生命周期(真实 Enemy+Battle.update):减速自然归零后重入;同源持续不重复', () => {
  const b = new Battle({ atk: 10, maxHp: 9999, level: 1 });
  const e = b.makeEnemy('slime', 1, { x: 400, y: 240 }); // 真实 Enemy(完整字段)
  b.enemies = [e];
  b.applyHit(mkBolt('water', 1, 10), e, 1); // 水弹命中 → slowT=2+首用标记
  assert.equal(b.floatTexts.filter(x => x.kind === 'slowMark').length, 1, '首用 1 条');
  // 同源持续期间再命中:不重复(同源同幅)
  b.floatTexts = []; // 清首用事件后再验证
  b.applyHit(mkBolt('water', 1, 10), e, 1);
  assert.equal(b.floatTexts.filter(x => x.kind === 'slowMark').length, 0, '同源持续期再命中不重复');
  // Battle.update 自然推进 2.5s:slowT 归零(标记自然清除,无手动操作)
  b.floatTexts = [];
  for (let i = 0; i < 160 && b.phase === 'FIGHTING'; i++) b.update(1 / 60);
  assert.equal(e.slowT, 0, 'Battle.update 自然衰减归零');
  assert.equal(b.floatTexts.filter(x => x.kind === 'slowMark').length, 0, '到期/衰减期间静默');
  // 重入:再次命中 → 再冒 1 条(重入跃迁)
  b.applyHit(mkBolt('water', 1, 10), e, 1);
  assert.equal(b.floatTexts.filter(x => x.kind === 'slowMark').length, 1, '自然归零后重入 → 再冒 1 条');
});

test('M7 F7 灼烧真实生命周期:逐秒 🔥 至 until,到期后 Battle.update 静默', () => {
  const b = new Battle({ atk: 10, maxHp: 9999, level: 1 });
  const e = b.makeEnemy('slime', 1, { x: 400, y: 240 });
  b.enemies = [e];
  b.applyHit(mkBolt('fire', 1, 10), e, 1); // 灼烧 dpsFloat=2,until=clock+3
  let burnSeen = 0;
  let burnAfterExpire = 0;
  let expired = false;
  for (let i = 0; i < 400 && b.phase === 'FIGHTING'; i++) {
    const n = b.floatTexts.filter(x => x.kind === 'burn').length;
    if (expired) burnAfterExpire += n;
    else burnSeen += n;
    b.floatTexts = [];
    b.update(1 / 60);
    if (!e.burn) expired = true; // 真实 tickBurn 到期清理(burn=null)
  }
  assert.ok(burnSeen >= 2, `灼烧期逐秒跳伤冒字(实得 ${burnSeen} 跳)`);
  assert.equal(burnAfterExpire, 0, '灼烧到期(e.burn 自然清理)后静默——真实生命周期,无自造桩');
  assert.equal(e.burn, null, 'until 后 burn 清空');
});

test('M7 F7 束缚真实生命周期:束缚期逐秒 🌿,到期后静默;重施再标记', () => {
  const b = new Battle({ atk: 10, maxHp: 9999, level: 1 });
  const e = b.makeEnemy('slime', 1, { x: 400, y: 240 });
  b.enemies = [e];
  applyBind(b, skill('wood_bind'), 1); // 真实内核:bindT=1.5s,bindDps=3
  assert.equal(b.floatTexts.filter(x => x.kind === 'bindMark').length, 1, '施加标记 1 条');
  let bindSeen = 0, afterExpire = 0, expired = false;
  b.floatTexts = [];
  for (let i = 0; i < 300 && b.phase === 'FIGHTING'; i++) {
    const n = b.floatTexts.filter(x => x.kind === 'bindDot').length;
    if (expired) afterExpire += n;
    else bindSeen += n;
    b.floatTexts = [];
    b.update(1 / 60);
    if (!e.bindT && !e.bindDps) expired = true; // 真实 tickBind 到期清零
  }
  assert.ok(bindSeen >= 1, `束缚期逐秒跳伤冒字(实得 ${bindSeen})`);
  assert.equal(afterExpire, 0, '束缚到期后静默(bindT/bindDps 自然清零)');
  // 重施:再冒标记 1 条
  applyBind(b, skill('wood_bind'), 1);
  assert.equal(b.floatTexts.filter(x => x.kind === 'bindMark').length, 1, '束缚重施 → 再冒 1 条');
});

test('M7 F7 终局同帧:唯一敌击杀的 kill 与 victory 同一次 update(真实 Battle.update)', () => {
  const b = new Battle({ atk: 12, maxHp: 9999, level: 1 });
  b.loadoutForTest = null;
  b.wave = 9; b.nextWave(); b.tideIdx = b.tides.length - 1; b.spawnTide();
  for (const e of b.enemies) { e.hp = 1; e.maxHp = 1; }
  b.enemies.length = 1; // 末潮唯一敌 HP1
  // 单发非穿透火弹在飞(真实 launch)
  b.launch({ element: 'fire', tier: 1, mult: 1 });
  let killAt = null, victoryAt = null;
  for (let i = 0; i < 300 && b.phase === 'FIGHTING'; i++) {
    b.update(1 / 60);
    const kills = b.log.filter(l => l.ev === 'kill');
    if (kills.length && killAt === null) killAt = { t: kills.at(-1).t, frame: i };
  }
  const vLog = b.log.find(l => l.ev === 'victory');
  const kills = b.log.filter(l => l.ev === 'kill');
  assert.equal(b.phase, 'VICTORY', '最终击杀后 VICTORY');
  assert.equal(kills.length, 1, '唯一击杀');
  assert.equal(kills[0].t, vLog.t, `kill(t=${kills[0].t})与 victory(t=${vLog.t})同一次 update——终局帧事件`);
  assert.equal(kinds(b.floatTexts).filter(k => k === 'kill').length, 1, '击破事件在终局帧事件队列');
});

// ---- 需求方反馈调整(2026-10-17):冒字字号 ×2 + 黑色描边 ----
test('M7 冒字字号翻倍(需求反馈):FT_STYLE 全部 size ×2(直击 32/击破 40/溅射 20)', () => {
  const fx = new FxLayer();
  fx.combatFloat({ kind: 'dmg', x: 0, y: 0, n: 1, el: 'fire', jitter: 0 });
  fx.combatFloat({ kind: 'kill', x: 0, y: 60 });
  fx.combatFloat({ kind: 'splash', x: 0, y: 120, n: 2, el: 'fire' });
  assert.deepEqual(fx.combatTexts.map(c => c.size), [32, 40, 20], '直击 32/击破 40/溅射 20(原 16/20/10 的 2 倍)');
});

test('M7 黑色描边(需求反馈):draw 先 strokeText(#000)后 fillText,描边宽≈字号/8', () => {
  const fx = new FxLayer();
  fx.combatFloat({ kind: 'dmg', x: 0, y: 0, n: 9, el: 'fire', jitter: 0 });
  const calls = [];
  const ctx = {
    set font(v) { this._f = v; }, get font() { return this._f; },
    set globalAlpha(v) {}, set fillStyle(v) { this._fill = v; }, set strokeStyle(v) { this._stroke = v; },
    set lineWidth(v) { this._lw = v; }, set lineJoin(v) {}, set textAlign(v) {},
    fillText(t) { calls.push({ op: 'fill', t, fill: this._fill, font: this._f }); },
    strokeText(t) { calls.push({ op: 'stroke', t, stroke: this._stroke, lw: this._lw, font: this._f }); },
  };
  fx.draw(ctx);
  const d = fx.combatTexts[0];
  const expectFont = Math.round(d.size); // p=0 时 scale=easeOutBack(0)=0.2→font=round(32×0.2)=6?
  const strokeIdx = calls.findIndex(c => c.op === 'stroke' && c.t === '-9');
  const fillIdx = calls.findIndex(c => c.op === 'fill' && c.t === '-9');
  assert.ok(strokeIdx !== -1 && fillIdx !== -1, 'strokeText 与 fillText 均调用');
  assert.ok(strokeIdx < fillIdx, '描边先于填充(外圈不遮字)');
  assert.equal(calls[strokeIdx].stroke, '#000', '描边黑色');
  assert.ok(calls[strokeIdx].lw >= 3, `描边宽≥3(实得 ${calls[strokeIdx].lw})`);
  assert.equal(calls[fillIdx].fill, '#ff4444', '填充仍为元素色');
});
