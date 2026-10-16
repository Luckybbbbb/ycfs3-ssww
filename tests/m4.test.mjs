// tests/m4.test.mjs
// M4 局外成长纯逻辑单测:FR-5 养成公式/FR-6 关卡解锁/FR-8 存档与后端预留
// 数字例对照: docs/design/03-主角技能设计.md 2.1/2.2、05-关卡设计.md 第 2/8 节
// 运行: node --test tests/m4.test.mjs
// 相对路径: tests/m4.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { expNeed, cumThreshold, maxHpAt, atkAt, levelFromExp, applyExp } from '../scripts/meta/exp.js';
import { initialProgress, canPlay, onVictory, wGlobal, WAVES_PER_LEVEL } from '../scripts/meta/levels.js';
import { defaultProfile, loadProfile, saveProfile, loadProgress, saveProgress, clearAll } from '../scripts/meta/save.js';
import { createApi } from '../scripts/api/api.js';

// 内存 localStorage 桩(FR-8:storage 注入,接口与 localStorage 一致)
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}

// ---- FR-5 养成公式(03 文档 2.1/2.2,TDD 第 14 条) ----
test('FR-5 exp_need 数字例:Lv1→2 需 20、Lv2→3 需 57、Lv3→4 需 104、Lv10→11 需 632', () => {
  assert.equal(expNeed(1), 20);   // round(20×1)=20
  assert.equal(expNeed(2), 57);   // round(20×2^1.5)=round(56.57)=57
  assert.equal(expNeed(3), 104);  // round(103.92)=104
  assert.equal(expNeed(10), 632); // round(632.46)=632
});

test('FR-5 累计阈值:Lv2=20、Lv3=77、Lv4=181(03 文档 2.2 实战曲线口径)', () => {
  assert.equal(cumThreshold(1), 0);
  assert.equal(cumThreshold(2), 20);
  assert.equal(cumThreshold(3), 77);
  assert.equal(cumThreshold(4), 181);
});

test('FR-5 属性表:Lv1 100/10、Lv5 160/14、Lv10 235/19、Lv20 385/29', () => {
  assert.equal(maxHpAt(1), 100); assert.equal(atkAt(1), 10);
  assert.equal(maxHpAt(5), 160); assert.equal(atkAt(5), 14);
  assert.equal(maxHpAt(10), 235); assert.equal(atkAt(10), 19);
  assert.equal(maxHpAt(20), 385); assert.equal(atkAt(20), 29);
});

test('FR-5 累计经验→等级:18→Lv1;50→Lv2 余 30;100→Lv3 余 23;172→Lv3 差 9;181→Lv4 余 0', () => {
  assert.deepEqual(levelFromExp(18), { level: 1, surplus: 18 });
  assert.deepEqual(levelFromExp(50), { level: 2, surplus: 30 });
  assert.deepEqual(levelFromExp(100), { level: 3, surplus: 23 });
  assert.deepEqual(levelFromExp(172), { level: 3, surplus: 95 }); // 172−77=95
  assert.deepEqual(levelFromExp(181), { level: 4, surplus: 0 });
});

test('FR-5 applyExp:升级即时回满 HP;跨级连跳;未升级 HP 保持(钳上限内)', () => {
  // 03 文档 2.2 第 1 关前 4 波:18/32/50/72
  let p = { level: 1, expTotal: 0, hp: 100, maxHp: 100 };
  p = applyExp(p, 18);
  assert.equal(p.level, 1); assert.equal(p.hp, 100, '未升级 HP 不变');
  p = applyExp(p, 32); // 累计 50 ≥ 20 → Lv2,回满 115
  assert.equal(p.level, 2); assert.equal(p.leveledUp, true); assert.equal(p.hp, 115); assert.equal(p.maxHp, 115);
  p = applyExp(p, 50); // 累计 100 ≥ 77 → Lv3,回满 130
  assert.equal(p.level, 3); assert.equal(p.hp, 130);
  p = applyExp(p, 72); // 累计 172 < 181 → 仍 Lv3
  assert.equal(p.level, 3); assert.equal(p.leveledUp, false);
  // HP 受损后未升级不回满;再升级回满
  p.hp = 90;
  p = applyExp(p, 9); // 累计 181 → Lv4
  assert.equal(p.level, 4); assert.equal(p.hp, 145);
});

// ---- FR-6 关卡解锁(05 文档第 2/8 节) ----
test('FR-6 顺序解锁:初始仅第 1 关;通关 L 解锁 L+1;重复通关不回退', () => {
  let progress = initialProgress();
  assert.ok(canPlay(progress, 1));
  assert.ok(!canPlay(progress, 2), '未通关第 1 关时第 2 关不可选');
  ({ progress } = onVictory(progress, 1));
  assert.ok(canPlay(progress, 2));
  assert.ok(!canPlay(progress, 3));
  ({ progress } = onVictory(progress, 3)); // 越关通关(测试构造)→ 不回退只取 max
  assert.equal(progress.unlockedLevel, 4);
  assert.equal(progress.lastLevelCleared, 3);
  const again = onVictory(progress, 1);
  assert.equal(again.progress.unlockedLevel, 4, '重打第 1 关不解锁回退');
  assert.equal(again.firstClear, false, '重复通关无首通');
});

test('FR-6 难度映射:w_global=(L−1)×10+w_local;每关 10 波', () => {
  assert.equal(wGlobal(1, 1), 1);
  assert.equal(wGlobal(1, 10), 10);
  assert.equal(wGlobal(3, 5), 25);  // 04 文档 5.1 数字例的 w
  assert.equal(wGlobal(5, 10), 50); // 05 文档第 3 节第 5 关 Boss 波
  assert.equal(WAVES_PER_LEVEL, 10);
});

// ---- FR-8 存档(D13 键位/新档流程/损坏回落) ----
test('FR-8 profile 往返:保存后读回一致;默认档=Lv1/解锁 1/初始装配', () => {
  const s = memStorage();
  const p = loadProfile(s);
  assert.deepEqual(p, defaultProfile());
  p.level = 7; p.expTotal = 300; p.unlockedLevel = 3; p.loadout = ['metal', 'fire', 'water', 'wood'];
  saveProfile(s, p);
  const back = loadProfile(s);
  assert.equal(back.level, 7);
  assert.equal(back.expTotal, 300);
  assert.deepEqual(back.loadout, ['metal', 'fire', 'water', 'wood']);
});

test('FR-8 损坏/清空回落新档:非 JSON、非对象、缺 loadout 均不抛错', () => {
  const s = memStorage();
  s.setItem('ssww.profile', '{not json');
  assert.deepEqual(loadProfile(s).level, 1);
  s.setItem('ssww.profile', '42');
  assert.deepEqual(loadProfile(s).level, 1);
  s.setItem('ssww.profile', JSON.stringify({ level: 5, loadout: 'bad' }));
  const p = loadProfile(s);
  assert.equal(p.level, 5, '合法字段保留');
  assert.equal(p.loadout.length, 4, 'loadout 非法回落默认');
  clearAll(s);
  assert.equal(s.getItem('ssww.profile'), null);
  assert.deepEqual(loadProfile(s), defaultProfile(), '清 localStorage 重开走新档流程');
});

test('FR-8 progress 往返与 submitRun 通关写档', () => {
  const s = memStorage();
  assert.deepEqual(loadProgress(s), { unlockedLevel: 1, lastLevelCleared: 0, bestChains: 0 });
  saveProgress(s, { lastLevelCleared: 2, bestChains: 8 });
  assert.deepEqual(loadProgress(s), { unlockedLevel: 1, lastLevelCleared: 2, bestChains: 8 });
});

// ---- FR-8 后端预留(api.js 接口签名,本地实现) ----
test('FR-8 api 四方法签名(全 Promise):getProfile/saveProfile/getLevels/submitRun', async () => {
  const s = memStorage();
  const api = createApi(s);
  // 本地空档
  const profile = await api.getProfile();
  assert.equal(profile.level, 1);
  assert.equal((await api.getLevels()).unlockedLevel, 1);
  // 升级+通关写回
  profile.level = 4;
  profile.expTotal = 200;
  profile.unlockedLevel = 4;
  await api.saveProfile(profile);
  await api.submitRun({ level: 2, victory: true, expGained: 100, kills: 30 });
  assert.equal((await api.getProfile()).level, 4);
  const levels = await api.getLevels();
  assert.equal(levels.lastLevelCleared, 2);
  assert.equal(levels.unlockedLevel, 4, '解锁取通关(lastLevelCleared+1=3)与档案(4)的 max');
  // 失败提交不清进度(FR-6 失败无惩罚)
  await api.submitRun({ level: 2, victory: false, expGained: 20, kills: 5 });
  assert.equal((await api.getLevels()).lastLevelCleared, 2);
});

test('FR-8 mock 远端替换:同一接口签名注入内存后端,其余模块不感知', async () => {
  // 模拟"换 api.js 实现为 mock 远端":实现同签名的假远端
  const remote = {
    async getProfile() { return { level: 9, expTotal: 900, unlockedLevel: 5, loadout: ['fire', 'fire', 'fire', 'fire'], settings: {} }; },
    async saveProfile() { return null; },
    async getLevels() { return { unlockedLevel: 5, lastLevelCleared: 4 }; },
    async submitRun() { return { ok: true }; },
  };
  const levels = await remote.getLevels();
  assert.equal(levels.unlockedLevel, 5);
  const profile = await remote.getProfile();
  assert.equal(profile.level, 9); // 调用方只依赖签名,不依赖本地实现
});

// ---- FR-3.3 技能库(03 文档 5.1/5.2,纯逻辑部分;battle 接线在 M4 集成) ----
import { SKILL_LIBRARY, skillById, unlockedSkills, pickSkillForElement, canEquip } from '../scripts/skills/library.js';
import {
  chainTargets, applyChain, applyBind, tickBind, applyMulti, applyShieldSpell,
  applyPulse, pushZone, tickZones, applyAura, tickAura,
} from '../scripts/skills/behaviors.js';

test('技能库表:初始 5 弹 + Lv3 五技能 + Lv6 五技能;CD 与 5.2 一致', () => {
  assert.equal(SKILL_LIBRARY.length, 15);
  assert.equal(unlockedSkills(1).length, 5);
  assert.equal(unlockedSkills(3).length, 10);
  assert.equal(unlockedSkills(6).length, 15);
  assert.equal(skillById('water_chain').cd, 4.0);
  assert.equal(skillById('fire_dotzone').cd, 6.0);
  assert.equal(skillById('wood_aura').cd, 5.0);
  assert.equal(skillById('earth_pulse').params.stunTime, 0.5);
});

test('5.1 装配选择:CD 就绪者优先,同就绪取槽位序;未装配/全 CD 中返回 null(档位保留)', () => {
  const slots = ['fire_bolt', 'fire_pulse', 'water_bolt', 'water_chain'];
  const cds = { fire_bolt: 0, fire_pulse: 1.2, water_bolt: 0.5, water_chain: 0 };
  // fire 行:槽 0 就绪、槽 1 CD 中 → 取槽 0
  assert.deepEqual(
    { id: pickSkillForElement('fire', slots, 6, cds).skill.id, slot: pickSkillForElement('fire', slots, 6, cds).slot },
    { id: 'fire_bolt', slot: 0 });
  // 全就绪取槽位序靠前
  assert.equal(pickSkillForElement('fire', slots, 6, { fire_bolt: 0, fire_pulse: 0 }).skill.id, 'fire_bolt');
  // CD 中优先于靠前未就绪:两个都未就绪 → null
  assert.equal(pickSkillForElement('fire', slots, 6, { fire_bolt: 1, fire_pulse: 2 }), null);
  // earth 行未装配 → null(仅积档位,FR-3.3)
  assert.equal(pickSkillForElement('earth', slots, 6, {}), null);
  // 未解锁技能不参与:Lv1 时 fire_pulse 装了也不触发
  assert.equal(pickSkillForElement('fire', ['fire_pulse'], 1, {}), null);
  // canEquip:重复装配拒绝,原槽位保留允许
  assert.equal(canEquip(slots, 3, 'fire_bolt', 6), false, 'fire_bolt 已在槽 0');
  assert.equal(canEquip(slots, 0, 'fire_bolt', 6), true, '原槽位覆盖自身允许');
  assert.equal(canEquip(slots, 3, 'earth_shield', 1), false, 'Lv1 未解锁石甲术');
  assert.equal(canEquip(slots, 3, 'earth_shield', 3), true);
});

// 构造 battle 兼容 ctx(用真实 Battle;enemies 直接构造可控行列)
import { Battle } from '../scripts/battle/battle.js';
import { Enemy } from '../scripts/battle/enemy.js';
function makeCtx(atk = 10, maxHp = 100) {
  const ctx = new Battle({ atk, maxHp, rng: null });
  ctx.zones = []; ctx.aura = null;
  return ctx;
}
const row = (ctx, xs, hp = 500, y = 240) => {
  for (const x of xs) ctx.enemies.push(new Enemy({ name: 'slime', hp, x, y, w: 1 }));
  return ctx.enemies.slice(-xs.length);
};

test('寒冰锁链:目标数 tier2 总 4、tier5 总 5;各目标 ATK×0.6×档位倍率', () => {
  assert.equal(chainTargets(2), 4);
  assert.equal(chainTargets(5), 5);
  assert.equal(chainTargets(1), 3);
  const ctx = makeCtx(10);
  const es = row(ctx, [560, 600, 640, 680, 720, 760], 500);
  const n = applyChain(ctx, skillById('water_chain'), 2);
  assert.equal(n, 4, '主目标 + 额外 3');
  const dmg = Math.round(10 * 0.6 * 1.6); // tier2 倍率 1.6 → 9.6 → 10
  assert.deepEqual(es.slice(0, 4).map(e => 500 - e.hp), [dmg, dmg, dmg, dmg]);
  assert.equal(es[4].hp, 500, '范围外不受击');
});

test('藤蔓束缚:bindT=1.5s、每秒跳 round(ATK×0.3×倍率),到期清理', () => {
  const ctx = makeCtx(10);
  const [e] = row(ctx, [560], 100);
  applyBind(ctx, skillById('wood_bind'), 1); // tier1: 10×0.3×1.0=3/s
  assert.equal(e.bindT, 1.5);
  assert.equal(Math.abs(e.bindDps - 3) < 1e-9, true);
  // t=1 跳 3;t=2 超出 bindUntil(1.5) 不跳并清理
  const t0 = ctx.clock;
  ctx.clock = t0 + 1.0;
  assert.equal(tickBind(e, t0, ctx.clock), 3);
  assert.equal(e.hp, 97);
  ctx.clock = t0 + 2.0;
  assert.equal(tickBind(e, ctx.clock - 1.0, ctx.clock), 0, '1.5s 后不再跳');
  assert.equal(e.bindT, 0, '到期清理');
});

test('贯日连珠:3 发弹各 ATK×0.7×档位倍率,目标按最近序', () => {
  const ctx = makeCtx(10);
  row(ctx, [560, 600, 640], 500);
  const count = applyMulti(ctx, skillById('metal_multi'), 1);
  assert.equal(count, 3);
  const bolts = ctx.bolts.slice(-3);
  const raw = 10 * 0.7 * 1.0; // 7
  assert.ok(bolts.every(b => Math.abs(b.rawDmg - raw) < 1e-9));
  assert.deepEqual(bolts.map(b => b.target.x), [560, 600, 640]);
});

test('石甲术:护盾 ATK×2×档位倍率,封顶 30% maxHP(4.2 非子弹类同倍率表)', () => {
  const ctx = makeCtx(14, 160); // Lv5:ATK 14,maxHP 160,cap=48
  const r = applyShieldSpell(ctx, skillById('earth_shield'), 3);
  assert.equal(r.add, Math.round(14 * 2 * 2.4)); // 67.2 → 67
  assert.equal(ctx.shield, 48, '67 > cap 48,截断');
});

test('脉冲:以最近敌人为中心半径内全体受击;裂地附加眩晕 0.5s', () => {
  const ctx = makeCtx(10);
  const es = row(ctx, [560, 620, 700], 500);
  const hits = applyPulse(ctx, skillById('fire_pulse'), 1); // r=80,10×1.8×1.0=18
  assert.equal(hits, 2, '560/620 在 r80 内,700 距中心 140 超出');
  assert.deepEqual(es.slice(0, 2).map(e => 500 - e.hp), [18, 18]);
  assert.equal(es[2].hp, 500);
  // 裂地脉冲眩晕
  const ctx2 = makeCtx(10);
  const es2 = row(ctx2, [560, 900], 500);
  applyPulse(ctx2, skillById('earth_pulse'), 1);
  assert.equal(es2[0].stunT, 0.5);
  assert.ok(!es2[1].stunT, '范围外不眩晕');
});

test('区域:燎原弹灼烧区逐秒跳伤、寒霜领域区内减速;同技能重复释放刷新不叠加', () => {
  const ctx = makeCtx(10);
  const [e] = row(ctx, [560], 100);
  pushZone(ctx, skillById('fire_dotzone'), 1, { x: 560, y: 240 }); // dps=10×0.25×1.0=2.5→每秒 round=3? 2.5→round=3
  const z = ctx.zones[0];
  assert.equal(z.kind, 'dot');
  assert.ok(Math.abs(z.dpsFloat - 2.5) < 1e-9);
  tickZones(ctx.zones, 0, 1, ctx.enemies);
  assert.equal(e.hp, 97, 'round(2.5)=3 每秒(4.4 舍入口径)');
  tickZones(ctx.zones, 1, 3, ctx.enemies); // t=2,3 各跳 3(z.until=3 → t=3 仍跳)
  assert.equal(e.hp, 91);
  tickZones(ctx.zones, 3, 4, ctx.enemies); // 超出 until 不跳
  assert.equal(e.hp, 91);
  // 同技能再释放:替换不叠加
  pushZone(ctx, skillById('fire_dotzone'), 1, { x: 560, y: 240 });
  assert.equal(ctx.zones.length, 1);
  // 寒霜领域
  const ctx2 = makeCtx(10);
  const [e2] = row(ctx2, [560], 500);
  pushZone(ctx2, skillById('water_field'), 1, { x: 560, y: 240 });
  const r = tickZones(ctx2.zones, 0, 0.1, ctx2.enemies);
  assert.equal(e2.slowPct, 20);
  assert.equal(r.slowed > 0, true);
});

test('生机光环:每秒回 maxHP×1%×档位倍率;4.4 数字例 Lv12(265) tier1=3/s、tier5=12/s;刷新语义', () => {
  const ctx = makeCtx(19, 265); // Lv12:ATK 19,HP 265
  ctx.hp = 165;
  applyAura(ctx, skillById('wood_aura'), 1);
  assert.ok(Math.abs(ctx.aura.healFloat - 2.65) < 1e-9);
  const healed = tickAura(ctx.aura, 0, 1, ctx);
  assert.equal(healed, 3); // round(2.65)=3
  assert.equal(ctx.hp, 168);
  // tier5 刷新:回速按新档位,时长刷新
  applyAura(ctx, skillById('wood_aura'), 5);
  assert.ok(Math.abs(ctx.aura.healFloat - 265 * 0.046) < 1e-9);
  const healed5 = tickAura(ctx.aura, 1, 2, ctx);
  assert.equal(healed5, 12); // round(12.19)=12
  assert.equal(ctx.hp, 180);
});

// ---- M4 接线集成:Caster(技能库)× Battle(行为内核全栈) ----
import { Charge } from '../scripts/skills/charge.js';
import { Caster } from '../scripts/skills/cast.js';
import { makeRng } from '../scripts/board/grid.js';

const evM = (element, count, chain) => ({ type: 'match_cleared', element, count, chain });
const runToM = (b, from, to) => { let t = from; while (to - t > 1e-9) { const dt = Math.min(0.001, to - t); b.update(dt); t += dt; } return t; };

test('M4 接线:脉冲经 tryCast(ctx) 直接生效,队列间距外不波及', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_pulse'], 6); // 单装脉冲:该行只有非子弹技能
  const b = new Battle({ atk: 10, maxHp: 100, rng: makeRng(1) });
  b.startLevel(1);
  b.enemies.forEach((e, i) => { e.x = 560 + i * 110; e.spd = 0; }); // 停位队列
  charge.feed(evM('fire', 3, 1)); // tier 1
  caster.update(10);
  const r = caster.tryCast('fire', true, b);
  assert.equal(r.kind, 'pulse');
  const front = b.enemies[0];
  assert.ok(front.hp < front.maxHp, '脉冲命中最近敌(ATK×1.8×1.0=18)');
  assert.equal(front.hp, front.maxHp - 18);
  assert.equal(b.enemies[1].hp, b.enemies[1].maxHp, '110px 间距 > r80 不波及');
});

test('M4 接线:灼烧区 dotzone 落地+battle tickZone 逐秒跳伤;同技能刷新不叠加', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_dotzone'], 3);
  const b = new Battle({ atk: 10, maxHp: 500, rng: makeRng(2) });
  b.startLevel(1);
  const front = b.enemies[0];
  b.enemies.forEach((e, i) => { e.x = 560 + i * 110; e.spd = 0; e.interval = 0; });
  charge.feed(evM('fire', 5, 1)); // tier 3(内插 dpsCoef 0.25 不分档,区间固定)
  caster.update(10);
  caster.tryCast('fire', true, b);
  assert.equal(b.zones.length, 1);
  assert.equal(b.zones[0].kind, 'dot');
  assert.ok(Math.abs(b.zones[0].x - 560) < 1e-9, '中心=最近敌人');
  const hp0 = front.hp;
  runToM(b, b.clock, Math.floor(b.clock) + 1.2); // 跨一个整秒
  assert.ok(front.hp < hp0, '区内逐秒跳伤 round(10×0.25×档位倍率)');
  caster.tryCast('fire', true, b); // 重复释放
  assert.equal(b.zones.length, 1, '刷新不叠加(4.4)');
});

test('M4 接线:生机光环经 battle tickAura 逐秒回血;升级即回满语义在 applyExp(已测)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['wood_aura'], 6);
  const b = new Battle({ atk: 10, maxHp: 265, rng: makeRng(3) });
  b.hp = 200;
  b.startLevel(1);
  b.enemies.forEach(e => { e.spd = 0; e.interval = 0; e.x = 900; }); // 无威胁
  charge.feed(evM('wood', 3, 1)); // tier_gain=1 → tier1
  caster.update(10);
  const r = caster.tryCast('wood', true, b);
  assert.equal(r.kind, 'aura');
  assert.ok(Math.abs(b.aura.healFloat - 2.65) < 1e-9, 'tier1:265×1%×1.0');
  runToM(b, b.clock, Math.floor(b.clock) + 1.0);
  assert.equal(b.hp, 203, 'round(2.65)=3/s');
});

test('M4 接线:藤蔓束缚经 ctx 生效,被缚敌停止攻击(battle 消费 bindT)', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['wood_bind'], 3);
  const b = new Battle({ atk: 10, maxHp: 200, rng: makeRng(4) });
  b.startLevel(1);
  const front = b.enemies[0];
  b.enemies.forEach((e, i) => { e.x = 560 + i * 110; e.spd = 0; e.interval = 0.1; e.boltDmg = 5; });
  charge.feed(evM('wood', 5, 1));
  caster.update(10);
  const r = caster.tryCast('wood', true, b);
  assert.equal(r.kind, 'bind');
  assert.equal(front.bindT > 0, true);
  runToM(b, b.clock, b.clock + 0.5);
  assert.equal(b.ebolts.length, 0, '被缚敌不开火');
  runToM(b, b.clock, b.clock + 2);
  assert.ok(b.ebolts.length > 0, '束缚 1.5s 到期后恢复开火');
});

test('M4 接线:技能 CD 按技能独立;槽位序先选就绪者;子弹类经 launch 入列', () => {
  const charge = new Charge();
  const caster = new Caster(charge, ['fire_bolt', 'fire_pulse'], 6);
  const b = new Battle({ atk: 10, maxHp: 100, rng: makeRng(5) });
  b.startLevel(1);
  b.enemies.forEach((e, i) => { e.x = 560 + i * 110; e.spd = 0; });
  charge.feed(evM('fire', 3, 1)); // tier1
  caster.update(10);
  const r = caster.tryCast('fire', true, b);
  assert.equal(r.kind, 'bolt', '槽位序:初始弹在前且 CD 就绪 → 先走子弹');
  assert.equal(r.skill.id, 'fire_bolt');
  b.launch(r); // main 同口径
  assert.equal(b.bolts.length, 1, '子弹入 battle.launch');
  charge.feed(evM('fire', 3, 1));
  const r2 = caster.tryCast('fire', true, b);
  assert.equal(r2.kind, 'pulse', 'fire_bolt CD 中 → 落到同行的 fire_pulse(5.1 同行只触发一个)');
  assert.equal(b.bolts.length, 1, '脉冲不产生弹');
});
