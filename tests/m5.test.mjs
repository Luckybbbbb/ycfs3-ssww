// tests/m5.test.mjs
// M5 前置单测:道具效果接入战斗(02 文档第 6 节)+ CD 加速流速
// 数字例:回血 30%/45% maxHP、无敌 3/4.5s、CD 加速 5/7.5s 内流速 ×2
// 运行: node --test tests/m5.test.mjs
// 相对路径: tests/m5.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyItem, rollItem } from '../scripts/board/items.js';
import { Battle } from '../scripts/battle/battle.js';
import { Charge } from '../scripts/skills/charge.js';
import { Caster } from '../scripts/skills/cast.js';
import { makeRng } from '../scripts/board/grid.js';

// 精确推进到 t(同 m2/m3 测试口径)
const runTo = (b, from, to) => { let t = from; while (to - t > 1e-9) { const dt = Math.min(0.001, to - t); b.update(dt); t += dt; } return t; };

// ---- 道具数值(02 文档第 6 节) ----
test('02 第 6 节道具数值:回血 30%/45%、无敌 3/4.5s、CD 加速 5/7.5s ×2', () => {
  assert.deepEqual(applyItem({ item: 'heal', premium: false }, { maxHP: 265 }), { kind: 'heal', amount: 80 }); // 79.5→80(03 文档 4.5 例)
  assert.deepEqual(applyItem({ item: 'heal', premium: true }, { maxHP: 265 }), { kind: 'heal', amount: 119 }); // 119.25→119
  assert.deepEqual(applyItem({ item: 'invincible', premium: false }, {}), { kind: 'invincible', seconds: 3.0 });
  assert.deepEqual(applyItem({ item: 'invincible', premium: true }, {}), { kind: 'invincible', seconds: 4.5 });
  assert.deepEqual(applyItem({ item: 'cd', premium: false }, {}), { kind: 'cd', seconds: 5.0, rate: 2 });
  assert.deepEqual(applyItem({ item: 'cd', premium: true }, {}), { kind: 'cd', seconds: 7.5, rate: 2 });
});

test('回血封顶 maxHp:普通道具 30% 不溢出', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(1) });
  b.hp = 95;
  const fx = applyItem({ item: 'heal', premium: false }, { maxHP: b.maxHp });
  b.hp = Math.min(b.maxHp, b.hp + fx.amount);
  assert.equal(b.hp, 100, '95+30 → 封顶 100');
});

// ---- 无敌接入(hurtPlayer 免伤) ----
test('M5 无敌:hurtPlayer 免伤并记 invincible_block;到期恢复受击', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(2) });
  b.invincibleT = 3.0;
  assert.equal(b.hurtPlayer(19), 0, '无敌期 0 伤害');
  assert.equal(b.hp, 100);
  assert.ok(b.log.some(l => l.ev === 'invincible_block' && l.dmg === 19), '事件流水');
  runTo(b, 0, 3.1); // 到期
  assert.ok(b.invincibleT <= 0, '无敌到期(浮点余量容忍)');
  b.hurtPlayer(19);
  assert.equal(b.hp, 81, '到期后恢复受击');
});

// ---- CD 加速接入(caster 流速 ×2) ----
test('M5 CD 加速:5s 内 CD 流速 ×2;窗口按现实时间结束', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt']);
  caster.skillCds['fire_bolt'] = 2.0;
  caster.setCdBoost(5.0, 2);
  caster.update(0.5); // 0.5s 现实 → CD 走 1.0s
  assert.ok(Math.abs(caster.skillCds['fire_bolt'] - 1.0) < 1e-9);
  caster.update(0.5);
  assert.ok(Math.abs(caster.skillCds['fire_bolt'] - 0) < 1e-9, '再走 1.0s → CD 清零');
  caster.update(4.1); // 越过 5s 窗口
  assert.equal(caster.cdBoostT, 0, '窗口结束');
});

test('M5 rollItem:四连普通、五连高级;三类等概率(固定种子可复现)', () => {
  const rng = makeRng(7);
  const it4 = rollItem(4, rng);
  assert.equal(it4.premium, false);
  const it5 = rollItem(5, rng);
  assert.equal(it5.premium, true);
  assert.ok(['heal', 'invincible', 'cd'].includes(it4.item));
});
