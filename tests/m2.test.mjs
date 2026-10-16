// tests/m2.test.mjs
// M2 联动单测:FR-3.1 充能 / FR-3.2 自动释放 / FR-3.3 装配 / 元素能力 / 击杀时间线
// 数字例对照: docs/design/02-三消玩法设计.md 5.3、03-主角技能设计.md 4.2~4.6
// 运行: node --test tests/m2.test.mjs
// 相对路径: tests/m2.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Charge } from '../scripts/skills/charge.js';
import { Caster } from '../scripts/skills/cast.js';
import { Battle } from '../scripts/battle/battle.js';
import { TIER_MULT, METAL_MULT, BURN_COEFF, LEECH_PCT, SHIELD_ATK, SLOW_PCT } from '../scripts/skills/registry.js';

const ev = (element, count, chain) => ({ type: 'match_cleared', element, count, chain });
function stepToIdle(engine, maxSec = 30) {
  let t = 0;
  while (engine.state !== 'IDLE' && t < maxSec) { engine.update(0.016); t += 0.016; }
  return t < maxSec;
}
// 精确推进到 t(避免浮点累计跨过整秒边界)
const runTo = (b, from, to) => {
  let t = from;
  while (to - t > 1e-9) { const dt = Math.min(0.001, to - t); b.update(dt); t += dt; }
  return t;
};
const events = (b, type) => b.log.filter(l => l.ev === type);

// ---- FR-3.1 tier_gain(02 文档 5.3 表逐行) ----
test('tier_gain 数字例:3/4/5/6 连与连锁(02 文档 5.3)', () => {
  const cases = [
    ['metal', 3, 1, 1], ['water', 4, 1, 2], ['wood', 5, 1, 3], ['fire', 6, 1, 3],
    ['earth', 3, 2, 2], ['metal', 3, 4, 3], ['water', 5, 3, 5],
  ];
  for (const [el, count, chain, want] of cases) {
    assert.equal(Charge.tierGain(count, chain), want, `${el} count=${count} chain=${chain}`);
  }
});

test('FR-3.1 行内累加封顶 5:4 连再 5 连(同元素未释放)→ 5 截断;溢出无补偿', () => {
  const c = new Charge();
  c.feed(ev('fire', 4, 1)); // +2
  c.feed(ev('fire', 5, 1)); // +3 → 5
  assert.equal(c.tiers.fire, 5);
  c.feed(ev('fire', 5, 3)); // gain=5 但已封顶
  assert.equal(c.tiers.fire, 5);
});

// ---- FR-3.2 自动释放(03 文档 4.1) ----
test('FR-3.2:CD 未就绪档位累加至 5 截断;CD 就绪一次释放 5 档并清零', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire']);
  const battle = new Battle({ atk: 10, maxHp: 100 });
  battle.spawnWave(1, 500); // 高血量靶,避免击杀
  // t=0 充能 1 档即释放(档位清零,CD 启动)
  charge.feed(ev('fire', 3, 1));
  let r = caster.tryCast('fire', true);
  assert.ok(r && r.element === 'fire' && r.tier === 1, 't=0 释放 tier1');
  assert.equal(charge.tiers.fire, 0, '释放后清零');
  caster.update(0.5); // t=0.5,CD 剩 1.5s
  charge.feed(ev('fire', 5, 1)); // +3
  charge.feed(ev('fire', 5, 3)); // +3 → 累加至 5 封顶(CD 未就绪保留)
  assert.ok(caster.cds.fire > 0, 'CD 未就绪');
  assert.equal(charge.tiers.fire, 5);
  r = caster.tryCast('fire', true);
  assert.equal(r, null, 'CD 未就绪不释放');
  caster.update(1.6); // t=2.1 CD 就绪
  r = caster.tryCast('fire', true);
  assert.ok(r && r.tier === 5, '一次释放 5 档形态');
  assert.equal(charge.tiers.fire, 0, '释放后清零');
});

test('FR-3.2 对照(03 文档 4.6):CD 就绪但档位 0 → 不发射', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire']);
  caster.update(10); // CD 长时间就绪
  assert.equal(caster.tryCast('fire', true), null, '档位 0 不发射');
});

// ---- FR-3.3 装配(未装配行仅积档位不释放) ----
test('FR-3.3:earth 未在 4 槽装配 → 消除积档位但不释放', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire', 'water', 'wood', 'metal']);
  charge.feed(ev('earth', 5, 1));
  assert.equal(charge.tiers.earth, 3);
  caster.update(10);
  assert.equal(caster.tryCast('earth', true), null, '未装配行不释放');
  assert.equal(charge.tiers.earth, 3, '档位保留');
});

test('FR-3.3:无敌人时不消耗(档位与 CD 保留,03 文档 5.3)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire']);
  charge.feed(ev('fire', 3, 1));
  caster.update(10);
  assert.equal(caster.tryCast('fire', false), null, '无敌人不释放');
  caster.update(10);
  const r = caster.tryCast('fire', true);
  assert.ok(r && r.tier === 1, '敌人出现后立即可释放(档位此前保留)');
});

// ---- 元素能力数字例(03 文档 4.2/4.3/4.5/4.6) ----
test('火 tier1 直接伤害边界:Lv1 ATK10 3 发杀 slime30(03 文档 4.6)', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(1, 30);
  const e = b.enemies[0];
  let t = 0;
  for (let i = 0; i < 3; i++) {
    b.launch({ element: 'fire', tier: 1 });
    t = runTo(b, t, (i + 1) * 0.8);
  }
  assert.equal(e.alive, false, '第 3 发击杀');
  assert.equal(events(b, 'hit').map(h => h.dmg).join(','), '10,10,10');
  assert.equal(b.kills, 1);
});

test('灼烧时间线(03 文档 4.6 表):tier3 火弹 24/发+跳伤 3,t=2 击杀且第 2 弹不发射', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(1, 30);
  const e = b.enemies[0];
  b.launch({ element: 'fire', tier: 3 }); // t=0 发射(24/发)
  let t = runTo(b, 0, 2.0);
  assert.equal(e.alive, false, 't=2 跳伤击杀');
  assert.equal(b.kills, 1);
  assert.equal(events(b, 'launch').length, 1, '同刻顺序:目标已死,第 2 弹不发射');
  assert.deepEqual(events(b, 'hit').map(h => h.dmg), [24], 't=0.75 命中 24 → 余 6');
  assert.deepEqual(events(b, 'burn').map(l => l.hpAfter), [3, 0], 't=1 跳 3 余 3;t=2 跳 3 击杀');
});

test('Boss 充能前提版(03 文档 4.6 表):ATK19 tier5 87/发+跳伤10,t=2.75 击杀', () => {
  const b = new Battle({ atk: 19, maxHp: 100 });
  b.spawnWave(1, 187); // 第 1 关 Boss HP=187
  const e = b.enemies[0];
  b.launch({ element: 'fire', tier: 5 }); // t=0 第 1 弹(火档位清零)
  let t = runTo(b, 0, 1.5); // 0.75 命中 87 → 100;t=1 跳 10 → 90
  t = runTo(b, t, 2.0);     // t=2 跳 10 → 80(此后玩家消除已使火行重新充至 5 档)
  b.launch({ element: 'fire', tier: 5 }); // t=2.00 第 2 弹发射(充能前提已满足)
  t = runTo(b, t, 2.8);
  assert.equal(e.alive, false, 't=2.75 命中 87 累计 194 击杀');
  assert.deepEqual(events(b, 'hit').map(h => h.dmg), [87, 87]);
  assert.deepEqual(events(b, 'burn').map(l => l.hpAfter), [90, 80]);
});

test('木吸血 tier1(03 文档 4.5):伤害 10×20%=2 HP', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.hp = 50;
  b.spawnWave(1, 100);
  b.launch({ element: 'wood', tier: 1 });
  b.update(0.8);
  assert.equal(b.hp, 52);
  assert.equal(events(b, 'leech')[0].heal, 2);
});

test('土护盾 tier3(03 文档 4.5):ATK14 ×1.0=14;封顶 30% maxHP=48', () => {
  const b = new Battle({ atk: 14, maxHp: 160 });
  b.spawnWave(1, 500);
  let t = 0;
  for (const tier of [3, 5, 5]) {
    b.launch({ element: 'earth', tier });
    t = runTo(b, t, t + 0.8);
  }
  assert.deepEqual(events(b, 'shield').map(s => s.shield), [14, 42, 48], '14 → +28=42 → +28 截断于 cap 48');
});

test('金穿透(FR-1.3):弹未消散、每目标只吃一次、纵列双靶各吃一次;伤害含金倍率', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(2, 100); // 双靶 x=560, y=150/195(纵列 45px,均在碰撞圆内)
  b.launch({ element: 'metal', tier: 1 }); // 10×1.0×1.3=13
  runTo(b, 0, 0.8);
  const hits = events(b, 'hit');
  assert.deepEqual(hits.map(h => h.dmg), [13, 13], '穿透双靶各吃一次');
  assert.notEqual(hits[0].target, hits[1].target, '已命中目标失效(hitSet),命中的是两只不同靶');
  assert.equal(b.bolts.length, 1, '金弹命中后未消散(穿透继续飞)');
  // 对照:同参数火弹命中即消散
  const b2 = new Battle({ atk: 10, maxHp: 100 });
  b2.spawnWave(1, 100);
  b2.launch({ element: 'fire', tier: 1 });
  runTo(b2, 0, 0.76);
  assert.equal(b2.bolts.length, 0, '非金系命中即消散');
});

test('数值表完整性(03 文档 4.2/4.3)', () => {
  assert.deepEqual(TIER_MULT, [1.0, 1.6, 2.4, 3.4, 4.6]);
  assert.deepEqual(BURN_COEFF, [0.2, 0.25, 0.3, 0.4, 0.5]);
  assert.deepEqual(LEECH_PCT, [20, 25, 30, 35, 40]);
  assert.deepEqual(SHIELD_ATK, [0.5, 0.75, 1.0, 1.5, 2.0]);
  assert.deepEqual(SLOW_PCT, [30, 35, 40, 45, 50]);
});

// ---- REQ-M2-01 整改回归 ----
test('高档形态(4.2 表):tier2 双目标、tier3 三目标+溅射 50%、tier4/5 范围全额', () => {
  // tier2:两只靶各中一弹(逐目标断言:编号、伤害、最终 HP)
  const b2 = new Battle({ atk: 10, maxHp: 100 });
  b2.spawnWave(2, 200);
  b2.launch({ element: 'fire', tier: 2 });
  runTo(b2, 0, 0.8);
  const h2 = events(b2, 'hit');
  assert.deepEqual(h2.map(h => h.target).sort(), [0, 1], 'tier2 逐目标:两靶各命中一次');
  assert.ok(h2.every(h => h.dmg === 16), 'tier2 10×1.6=16');
  assert.deepEqual(b2.enemies.map(e => e.hp), [184, 184], 'tier2 最终 HP 逐靶 200−16');
  // tier3:三只靶各中一弹,第四只在溅射 r60 内吃 50%
  const b3 = new Battle({ atk: 10, maxHp: 100 });
  b3.spawnWave(4, 200);
  b3.launch({ element: 'fire', tier: 3 });
  runTo(b3, 0, 0.8);
  const h3 = events(b3, 'hit');
  const full3 = h3.filter(h => h.mult === 1);
  assert.equal(full3.length, 3, 'tier3 三发全额');
  assert.equal(new Set(full3.map(h => h.target)).size, 3, 'tier3 三发命中三个不同目标(REQ-M2-02 整改 1)');
  assert.ok(h3.some(h => h.mult === 0.5 && h.dmg === 12), '溅射 24×0.5=12');
  // 逐靶 HP(纵列 45px 布阵:三发直击靶1..3,各弹溅射相邻靶各一次;靶0 无直击仅被溅射一次)
  assert.deepEqual(b3.enemies.map(e => e.hp), [188, 164, 152, 164], '靶0 −12(溅射);靶1 −36(直+溅);靶2 −48(直+2溅);靶3 −36(直+溅)');
  // tier4:纵列 3 靶(间隔 45,均落主目标 r90 内)全体全额;范围外靶不吃
  const b4 = new Battle({ atk: 10, maxHp: 100 });
  b4.spawnWave(3, 200);
  b4.launch({ element: 'fire', tier: 4 });
  runTo(b4, 0, 0.8);
  const h4 = events(b4, 'hit');
  assert.equal(h4.filter(h => h.mult === 1).length, 3, 'tier4 r90 内全体全额 34');
  assert.ok(h4.every(h => h.dmg === 34), 'tier4 10×3.4=34');
  // 范围外边界:第 4 靶距主目标 135 > 90 → 不吃
  const b4b = new Battle({ atk: 10, maxHp: 100 });
  b4b.spawnWave(4, 200);
  b4b.launch({ element: 'fire', tier: 4 });
  runTo(b4b, 0, 0.8);
  assert.equal(events(b4b, 'hit').filter(h => h.mult === 1).length, 3, 'r90 外(135px)不受击');
  // tier5:全体 46 + 灼烧
  const b5 = new Battle({ atk: 10, maxHp: 100 });
  b5.spawnWave(3, 200);
  b5.launch({ element: 'fire', tier: 5 });
  runTo(b5, 0, 0.8);
  const h5 = events(b5, 'hit');
  assert.equal(h5.length, 3, 'tier5 r140 全体');
  assert.ok(h5.every(h => h.dmg === 46), 'tier5 10×4.6=46');
  assert.ok(b5.enemies.every(e => e.burn), 'tier5 全体附加元素能力(灼烧)');
});

test('同帧多弹死亡去重:同一敌人只记一次击杀、经验一次(REQ-M2-01 整改 2)', () => {
  const b = new Battle({ atk: 10, maxHp: 100, expPerKill: 3 });
  b.spawnWave(1, 20); // HP20,两发 tier1(10)同帧到
  b.launch({ element: 'fire', tier: 1 });
  b.launch({ element: 'water', tier: 1 });
  runTo(b, 0, 0.8);
  assert.equal(b.enemies[0].alive, false);
  assert.equal(b.kills, 1, '重复命中不重复记杀');
  assert.equal(b.expGained, 3, '经验只记一次(2+1)');
  assert.equal(events(b, 'kill').length, 1);
});

test('过量伤害:溢出部分不重复入账', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(1, 5);
  b.launch({ element: 'fire', tier: 3 }); // 24 > 5
  runTo(b, 0, 0.8);
  assert.equal(b.enemies[0].hp, 0);
  const hit = events(b, 'hit')[0];
  assert.equal(hit.killed, true);
});

test('灼烧状态生命周期:过期清理;旧灼烧过期后新档位命中按新 DPS 跳(REQ-M2-01 整改 4)', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(1, 500);
  const e = b.enemies[0];
  b.launch({ element: 'fire', tier: 1 }); // 灼烧 dps 2
  let t = runTo(b, 0, 5.2); // 灼烧 0.75~3.75;5.2 时应已过期清理
  assert.equal(e.burn, null, '过期清理');
  const burnCount1 = events(b, 'burn').length;
  assert.ok(burnCount1 >= 3, 't=1,2,3 三次跳伤');
  b.launch({ element: 'fire', tier: 5 }); // 新档位 dps 5
  runTo(b, t, t + 1.05);
  const dpsValues = b.log.filter(l => l.ev === 'burn');
  // 新灼烧 DPS = round(10×0.5)=5
  assert.equal(e.burn.dpsFloat, 5);
  assert.ok(events(b, 'hit').length === 2);
});

test('灼烧到期边界:非整秒到期即清、最后跳伤保留(REQ-M2-02 整改 4)', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(1, 500);
  const e = b.enemies[0];
  b.launch({ element: 'fire', tier: 1 }); // 命中 0.75,until 3.75,dps 2
  let t = runTo(b, 0, 3.9);
  assert.equal(e.burn, null, 't=3.9 > until 3.75 → 已清理(非整秒到期)');
  assert.deepEqual(events(b, 'burn').length, 3, 't=1,2,3 三次跳伤');
  // 浮点边界:until 恰为整秒边界时最后一次跳伤不被提前清除
  const b2 = new Battle({ atk: 10, maxHp: 100 });
  b2.spawnWave(1, 500);
  const e2 = b2.enemies[0];
  runTo(b2, 0, 4.0); // battle.clock 推到 4.0
  e2.burn = { dpsFloat: 5, until: 5.0 }; // until 恰为整秒
  runTo(b2, 4.0, 5.0);
  assert.equal(e2.hp, 495, 't=5 整秒跳伤保留(round(5)=5)');
  assert.ok(e2.burn !== null, 't=5.0 时尚未过期(clock 不大于 until,不提前清)');
  runTo(b2, 5.0, 5.1);
  assert.equal(e2.burn, null, '跨过 until 后下一帧清理');
});

test('水减速到期:slowT 递减归零(REQ-M2-01 整改 4)', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(1, 500);
  b.launch({ element: 'water', tier: 1 });
  let t = runTo(b, 0, 1.0);
  assert.ok(b.enemies[0].slowT > 0, '减速生效中');
  t = runTo(b, t, 3.0);
  assert.equal(b.enemies[0].slowT, 0, '2s 后到期');
});

test('圆形碰撞边界(FR-1.3):距离 ≤ 半径和(45+9)才命中', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(1, 100);
  b.launch({ element: 'fire', tier: 1 });
  b.enemies[0].y += 60; // 发射后偏移 60 > 54 → 命中判定失败
  runTo(b, 0, 1.0);
  assert.equal(events(b, 'hit').length, 0, '偏离 60 超出碰撞圆');
  const b2 = new Battle({ atk: 10, maxHp: 100 });
  b2.spawnWave(1, 100);
  b2.launch({ element: 'fire', tier: 1 });
  b2.enemies[0].y += 30; // 偏移 30 ≤ 54 → 命中
  runTo(b2, 0, 1.0);
  assert.equal(events(b2, 'hit').length, 1, '偏移 30 在碰撞圆内');
});

test('金弹伤害路径统一去重:溅射/直击同一目标只结算一次(REQ-M2-02 整改 2 反例)', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(3, 500); // 高血量靶,统计每靶受击
  b.launch({ element: 'metal', tier: 3 }); // 直击 36=round(10×2.4×1.5)/发,溅射 18
  runTo(b, 0, 1.2);
  // 每靶受击总额:直击 36/发 + 溅射 18;同一颗弹对同一靶不得重复(直击后又溅射)
  const perTarget = [0, 1, 2].map(i => {
    const hits = b.log.filter(l => l.ev === 'hit' && l.target === i);
    return { n: hits.length, total: hits.reduce((s, h) => s + h.dmg, 0), hp: 500 - b.enemies[i].hp };
  });
  for (const t of perTarget) {
    assert.equal(t.total, t.hp, `靶${perTarget.indexOf(t)} 日志总额与实际扣血一致(无重复结算)`);
  }
});

test('四/五档金弹穿透语义:爆炸后弹继续飞(无设计例外)', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(2, 500);
  b.launch({ element: 'metal', tier: 4 });
  runTo(b, 0, 0.8);
  assert.equal(b.bolts.length, 1, 'tier4 金弹爆炸后未消散(继续穿透)');
  // 非金系对照:tier4 火弹爆炸后消散
  const b2 = new Battle({ atk: 10, maxHp: 100 });
  b2.spawnWave(3, 500);
  b2.launch({ element: 'fire', tier: 4 });
  runTo(b2, 0, 0.8);
  assert.equal(b2.bolts.length, 0, 'tier4 火弹爆炸后消散');
});

test('帧步长无关:纵列双靶金弹在 dt=0.001/1/60/1/30/0.05 下结果一致(REQ-M2-02 整改 3)', () => {
  const results = [];
  for (const dt of [0.001, 1 / 60, 1 / 30, 0.05]) {
    const b = new Battle({ atk: 10, maxHp: 100 });
    b.spawnWave(2, 500);
    b.launch({ element: 'metal', tier: 1 });
    let t = 0;
    while (t < 1.2) { b.update(Math.min(dt, 1.2 - t)); t += Math.min(dt, 1.2 - t); }
    results.push(JSON.stringify(b.enemies.map(e => 500 - e.hp)));
  }
  assert.ok(new Set(results).size === 1, '各步长受击总额一致: ' + results.join(' vs '));
  assert.equal(results[0], '[13,13]', '双靶各 13');
});

test('非金弹不穿透:火弹命中第一靶后消散,第二靶不受击(REQ-M2-01 整改 6 对照)', () => {
  const b = new Battle({ atk: 10, maxHp: 100 });
  b.spawnWave(2, 100);
  b.launch({ element: 'fire', tier: 1 });
  runTo(b, 0, 0.85);
  assert.equal(events(b, 'hit').length, 1, '火弹只命中第一靶');
  assert.equal(b.bolts.length, 0, '命中即消散');
});

test('经验基数:w_global=1 → exp_kill=3(04 文档 exp_kill=2+w_global)', () => {
  const b = new Battle({ atk: 10, maxHp: 100, expPerKill: 3 });
  b.spawnWave(1, 5);
  b.launch({ element: 'fire', tier: 3 });
  runTo(b, 0, 0.8);
  assert.equal(b.expGained, 3);
});

test('FR-3.3 换装立即生效:cycleSlot 后新行立即可释放(REQ-M2-01 整改 5)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire', 'water', 'wood', 'metal']);
  charge.feed(ev('earth', 5, 1)); // earth 档 3
  caster.update(10);
  assert.equal(caster.tryCast('earth', true), null, '未装配不释放');
  const old = caster.loadout[3]; // metal 槽
  const next = caster.cycleSlot(3);
  assert.equal(next, 'earth', 'metal 槽轮换到未装配的 earth');
  assert.ok(caster.loadout.includes('earth'));
  const r = caster.tryCast('earth', true);
  assert.ok(r && r.tier === 3, '换装立即生效');
  assert.ok(!caster.loadout.includes(old), '旧技能离槽');
});

test('复合回归(公开入口):消除事件→充能→门控→发射→命中→击杀(Caster 同步推进)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire', 'water', 'wood', 'metal']);
  const b = new Battle({ atk: 10, maxHp: 100, expPerKill: 3 });
  b.spawnWave(1, 30);
  const tick = (dt) => { caster.update(dt); b.update(dt); };
  // t=0 消除火行 5 连 → tier 3 → 门控放行 → 发射
  charge.feed(ev('fire', 5, 1));
  caster.update(0);
  const r = caster.tryCast('fire', b.aliveEnemies().length > 0);
  assert.ok(r && r.tier === 3);
  b.launch(r);
  let t = 0;
  while (t < 2.0) { const dt = Math.min(0.001, 2.0 - t); tick(dt); t += dt; }
  assert.equal(b.enemies[0].hp, 0, 't=0.75 命中 24(余 6)+t=1/2 灼烧各 3 → 击杀');
  assert.equal(b.kills, 1);
  assert.equal(b.expGained, 3);
  // t=2 后无再次充能:档位 0,即使 CD 就绪也不发射(隔离门控断言)
  const r2 = caster.tryCast('fire', true);
  assert.equal(r2, null, '档位 0 → 不发射(与 03 文档 4.6 对照例一致)');
});

// ---- REQ-M2-04 整改回归 ----
test('金 tier4/5 双靶全额:爆炸不与直击重复结算(REQ-M2-04 整改 1)', () => {
  for (const tier of [4, 5]) {
    const b = new Battle({ atk: 10, maxHp: 200 });
    b.spawnWave(2, 200);
    b.launch({ element: 'metal', tier });
    runTo(b, 0, 0.8);
    const dmg = tier === 4 ? 58 : 83; // tier4:10×3.4×1.7=57.8→58;tier5:10×4.6×1.8=82.8→83
    assert.deepEqual(b.enemies.map(e => e.hp), [200 - dmg, 200 - dmg], `tier${tier} 双靶各吃一次全额 ${dmg}`);
  }
});

test('帧步长扫掠覆盖:dt=0.04999 不再漏靶(REQ-M2-04 整改 2)', () => {
  for (const dt of [0.001, 1 / 60, 1 / 30, 0.05, 0.04999]) {
    const b = new Battle({ atk: 10, maxHp: 500 });
    b.spawnWave(2, 500);
    b.launch({ element: 'metal', tier: 1 });
    let t = 0;
    while (t < 1.2) { const step = Math.min(dt, 1.2 - t); b.update(step); t += step; }
    assert.deepEqual(b.enemies.map(e => 500 - e.hp), [13, 13], `dt=${dt.toFixed(5)} 双靶各 13`);
  }
});

test('水平交换动画:offsetX 滑动而非垂直跳动(用户报告的上下颠倒 bug)', async () => {
  const { BoardEngine } = await import('../scripts/board/engine.js');
  const e = new BoardEngine(7);
  stepToIdle(e);
  // 找一个合法水平交换
  let done = null;
  for (let r = 0; r < 8 && !done; r++) for (let c = 0; c < 7 && !done; c++) {
    if (e.trySwap({ r, c }, { r, c: c + 1 })) done = { r, c };
  }
  assert.ok(done, '存在合法水平交换');
  const cells = e.cellsForRender();
  const A = cells.find(c => c.r === done.r && c.c === done.c);
  const B = cells.find(c => c.r === done.r && c.c === done.c + 1);
  // 初始时刻 t≈0:offsetX 接近 0 但随进度向 +90/−90 滑动;此断言中点时刻
  e.update(0.075); // 半程
  const mid = e.cellsForRender();
  const Am = mid.find(c => c.r === done.r && c.c === done.c);
  const Bm = mid.find(c => c.r === done.r && c.c === done.c + 1);
  assert.ok(Math.abs(Am.offsetX) > 20, 'A 水平滑动中');
  assert.ok(Math.abs(Bm.offsetX) > 20, 'B 水平滑动中');
  assert.equal(Am.offsetX, -Bm.offsetX, 'A/B 反向');
  assert.equal(Am.offsetY, 0, '水平交换无垂直偏移(修复:此前误用 dir.r 上下跳)');
});
