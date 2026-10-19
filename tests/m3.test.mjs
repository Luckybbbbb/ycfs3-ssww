// tests/m3.test.mjs
// M3 战斗闭环单测:FR-4 波次编排 / FR-1.2 敌人实体与弹幕 / FR-1.3 敌方弹碰撞 / FR-1.4 胜负 / FR-1.5 视差参数
// 数字例对照: docs/design/04-敌人设计.md 第 3/4/5 节、05-关卡设计.md 第 3/5 节、03 文档 4.4
// 运行: node --test tests/m3.test.mjs
// 相对路径: tests/m3.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle, PHASE } from '../scripts/battle/battle.js';
import { Enemy, ENEMY_SPAWN_X, PLAYER_HIT_R, MIN_QUEUE_GAP } from '../scripts/battle/enemy.js';
import { advanceEnemyBolt, enemyBoltHitsPlayer } from '../scripts/battle/projectile.js';
import { killReward } from '../scripts/meta/economy.js';
import {
  ENEMY_TYPES, enemyHp, enemyDmg, barrageDmg, enemySpd, attackInterval,
  barrageCount, fanAngle, barrageSpeed, tideSplit, waveEnemyCount,
  buildWave, guardType, levelWeights,
} from '../scripts/battle/wave.js';
import { Parallax } from '../scripts/battle/parallax.js';
import { makeRng } from '../scripts/board/grid.js';

// 精确推进到 t(避免浮点累计跨过整秒边界,同 m2 测试口径)
const runTo = (b, from, to) => {
  let t = from;
  while (to - t > 1e-9) { const dt = Math.min(0.001, to - t); b.update(dt); t += dt; }
  return t;
};
const events = (b, type) => b.log.filter(l => l.ev === type);

// ---- FR-4 波次编排(04 文档第 4 节) ----
test('FR-4 每波敌人数 = 4+2×w_local:第 1 波 6、第 2 波 8、第 9 波 22', () => {
  assert.equal(waveEnemyCount(1), 6);
  assert.equal(waveEnemyCount(2), 8);
  assert.equal(waveEnemyCount(9), 22);
});

test('FR-4 潮汐拆分:6→[3,3]、8→[4,4]、22→[5,5,4,4,4];各潮 3~5 且总和=敌数', () => {
  assert.deepEqual(tideSplit(6), [3, 3]);
  assert.deepEqual(tideSplit(8), [4, 4]);
  assert.deepEqual(tideSplit(22), [5, 5, 4, 4, 4]);
  for (let w = 1; w <= 9; w++) {
    const count = waveEnemyCount(w);
    const tides = tideSplit(count);
    assert.equal(tides.reduce((a, b) => a + b, 0), count, `w=${w} 总数守恒`);
    for (const t of tides) assert.ok(t >= 3 && t <= 5, `w=${w} 潮 ${t} 在 3~5`);
    assert.equal(tides.length, Math.ceil(count / 5), `w=${w} 潮数=ceil(敌数/5)`);
  }
});

test('FR-4 Boss 波:Boss 按关卡表(需求方 2026-10-19:每关换类型)+护卫×2(权重最高小怪)', () => {
  assert.deepEqual(buildWave(10, 1, makeRng(1)), [['fox', 'slime', 'slime']]); // L1 Boss=狐妖(原写死妖王)
  assert.equal(guardType(5), 'snake'); // L5 权重 {snake:55, tiger:45} 最高 snake(不变)
  assert.equal(guardType(1), 'slime');
  assert.equal(guardType(2), 'slime');  // {slime:60, fox:40}
  assert.equal(guardType(3), 'fox');    // {fox:55, zombie:45}
  assert.equal(guardType(4), 'zombie'); // {zombie:55, snake:45}
});

test('FR-4 权重表(需求方 2026-10-19:每关小怪最多 2 种,逐关换血):L2 幽灵+狐妖、L3 狐妖+僵尸', () => {
  const w2 = levelWeights(2);
  assert.deepEqual(w2, { slime: 60, fox: 40 });
  const w3 = levelWeights(3);
  assert.deepEqual(w3, { fox: 55, zombie: 45 });
  // 抽取统计:固定种子下本关敌人只落在权重表键集合内(每关 ≤2 种)
  const rng = makeRng(7);
  const b = new Battle({ rng });
  b.startLevel(2);
  assert.ok(b.enemies.every(e => ['slime', 'fox'].includes(e.name)), 'L2 只出幽灵/狐妖两类');
  // Boss 类型表逐关对应(-05 N2:数字例用真实 w_global=10×L)
  assert.deepEqual(buildWave(10, 5, makeRng(1)).flat()[0], 'boss', 'L5 Boss=妖王');
  assert.deepEqual(buildWave(10, 2, makeRng(1)).flat()[0], 'zombie', 'L2 Boss=僵尸');
  assert.deepEqual(buildWave(10, 3, makeRng(1)).flat()[0], 'snake', 'L3 Boss=蛇妖');
  // -05 N1/N2:产品刷怪路径——五关 Boss 波第一只 isBoss=true、护卫 false,HP 与审核真值表一致
  for (const [L, bh, gh] of [[1, 75, 62], [2, 138, 98], [3, 215, 161], [4, 341, 239], [5, 619, 330]]) {
    const bb = new Battle({ rng: makeRng(L) });
    bb.startLevel(L);
    bb.wave = 10;
    bb.wGlobal = 10 * L;
    bb.tides = buildWave(10, L, makeRng(L));
    bb.tideIdx = 0;
    bb.enemies = [];
    bb.spawnTide();
    assert.equal(bb.enemies[0].isBoss, true, `L${L} 关底第一只 isBoss`);
    assert.equal(bb.enemies[1].isBoss, false, `L${L} 护卫非 Boss`);
    assert.equal(bb.enemies[0].hp, bh, `L${L} Boss HP=${bh}`);
    assert.equal(bb.enemies[1].hp, gh, `L${L} 护卫 HP=${gh}`);
    // Boss 奖励契约(冻结公式:coins=(2+w)×20、mats=20;普通=2+w/1)
    assert.deepEqual(killReward(10 * L, true), { coins: (2 + 10 * L) * 20, mats: 20 }, `L${L} Boss 奖励契约`);
  }
});

// ---- 敌人面板数值(04 文档第 5 节可机械复算) ----
test('04 文档 5.1:第 1 关第 1 波(w=1)slime HP30/DMG8(弹幕4)/1弹/2.0s/SPD150', () => {
  assert.equal(enemyHp('slime', 1), 30);
  assert.equal(enemyDmg('slime', 1), 8);
  assert.equal(barrageDmg('slime', 1), 4);
  assert.equal(barrageCount(1), 1);
  assert.equal(attackInterval(1), 2.0);
  assert.equal(enemySpd(1), 150);
  assert.equal(fanAngle(1), 20); // 15+1×5
  assert.equal(barrageSpeed(1), 305);
});

test('04 文档 5.1:w=25 snake HP186/DMG38(弹幕19)/9弹/60°/弹速425/间隔1.2', () => {
  assert.equal(enemyHp('snake', 25), 186);  // 48×3.88=186.24→186
  assert.equal(enemyDmg('snake', 25), 38);  // 11.2×3.4=38.08→38
  assert.equal(barrageDmg('snake', 25), 19); // round(38.08×0.5)=19
  assert.equal(barrageCount(25), 9);         // 1+⌊24/3⌋
  assert.equal(fanAngle(25), 60);            // 15+9×5
  assert.equal(barrageSpeed(25), 425);       // 300+125
  assert.equal(attackInterval(25), 1.2);     // max(1.2, 2.0−0.96)
});

test('04 文档 5.2:第 1 关 Boss(w=10)HP187/DMG38(弹幕19)/4弹/35°/弹速350/间隔1.64', () => {
  assert.equal(enemyHp('boss', 10), 187);   // 90×2.08=187.2→187
  assert.equal(enemyDmg('boss', 10), 38);   // 20×1.9=38
  assert.equal(barrageDmg('boss', 10), 19);
  assert.equal(barrageCount(10), 4);        // 1+⌊9/3⌋
  assert.equal(fanAngle(10), 35);           // 15+4×5
  assert.ok(Math.abs(barrageSpeed(10) - 350) < 1e-9);
  assert.ok(Math.abs(attackInterval(10) - 1.64) < 1e-9, 'max(1.2, 2.0−9×0.04)=1.64(浮点近似比较)');
});

test('05 文档第 3 节:第 5 关 Boss(w=50)HP619/DMG118(弹幕59)/17弹/100°/弹速550', () => {
  assert.equal(enemyHp('boss', 50), 619);   // 90×6.88=619.2→619
  assert.equal(enemyDmg('boss', 50), 118);  // 20×5.9=118
  assert.equal(barrageDmg('boss', 50), 59);
  assert.equal(barrageCount(50), 17);       // 1+⌊49/3⌋
  assert.equal(fanAngle(50), 100);          // 15+17×5
  assert.equal(barrageSpeed(50), 550);
});

test('03 文档 4.4 伤害链:fox 首波面板 9(8.8 取整)、弹幕 4(4.4 取整)——先乘后取整', () => {
  assert.equal(enemyDmg('fox', 1), 9);
  assert.equal(barrageDmg('fox', 1), 4);
});

// ---- FR-1.2 敌人推进与停位 ----
test('FR-1.2 右缘屏外生成→左移至队列槽位(front=560)停下;不越过槽位', () => {
  const b = new Battle({ rng: makeRng(3) });
  b.startLevel(1);
  const e = b.enemies[0];
  assert.equal(e.x, ENEMY_SPAWN_X, '生成于 760 屏外(front 槽位右后方 600 小于屏外点,不调整)');
  assert.equal(e.slotX, 560, 'front 槽位=560');
  runTo(b, 0, 1.0);
  assert.ok(e.x < ENEMY_SPAWN_X && e.x > 560, '1s 后仍在途中');
  runTo(b, 1.0, 2.0);
  assert.equal(e.x, 560, '150px/s → 200px 需 1.333s,2s 内已停位');
  runTo(b, 2.0, 5.0);
  assert.equal(e.x, 560, '停位后不再移动');
});

test('需求增补:X 轴队列堆叠,最小中心距 ≥110;前排死亡后幸存者前移补位', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(4) });
  b.startLevel(1);
  const alive = b.aliveEnemies();
  assert.equal(alive.length, 3);
  // 槽位:560/670/780(按 x 升序分配)
  const slots = alive.map(e => e.slotX).sort((a, b2) => a - b2);
  assert.deepEqual(slots, [560, 670, 780]);
  for (let i = 1; i < slots.length; i++) assert.ok(slots[i] - slots[i - 1] >= MIN_QUEUE_GAP, '最小堆叠距离');
  // 前排死亡 → 幸存者槽位前移
  const front = alive.sort((a, b2) => a.x - b2.x)[0];
  front.hurt(front.hp);
  b.reassignSlots();
  const rest = b.aliveEnemies().sort((a, b2) => a.x - b2.x);
  assert.equal(rest[0].slotX, 560, '次排补位 front');
  assert.equal(rest[1].slotX, 670);
});

test('需求增补:进射程(500)才累计攻击计时;超距钳制 interval×0.5(对标 enemy.gd)', () => {
  const b = new Battle({ rng: makeRng(3) });
  b.startLevel(1);
  const front = b.aliveEnemies().sort((a, c) => a.x - c.x)[0];
  // 出生 760 超射程 → 计时钳制 interval×0.5=1.0;t=1.0s 进射程(x≤610)开始累计 → 首击 2.0s(快速首发)
  runTo(b, 0, 1.9);
  assert.equal(b.ebolts.length, 0, '间隔未满不开火');
  runTo(b, 1.9, 2.2);
  assert.ok(b.ebolts.length > 0, '进射程 + 钳制后余量 1.0s → 首击 2.0s');
  // 后排(x=710,距离 600 > 500)不开火
  const back = b.aliveEnemies().sort((a, c) => a.x - c.x)[1];
  assert.ok(back.x - 110 > 500, '后排超出射程');
  assert.equal(back.atkTimer >= 0, true);
  runTo(b, 2.2, 6.0);
  assert.equal(b.ebolts.filter(eb => eb.from === back).length, 0, '超距者始终不开火');
});

test('需求增补:开火触发敌方攻击动画计时(animDur 内单次);主角 launch 触发攻击动画计时', () => {
  const b = new Battle({ rng: makeRng(3) });
  b.startLevel(1);
  // animDur = 帧数/(fps×2):slime 15/(8×2)=0.9375s、fox 8/(8×2)=0.5s
  const slime = new Enemy({ name: 'slime', hp: 30, x: 560, y: 240, spd: 150, interval: 99 });
  const fox = new Enemy({ name: 'fox', hp: 36, x: 670, y: 240, spd: 150, interval: 99 });
  assert.equal(Math.abs(slime.animDur - 15 / 16) < 1e-9, true);
  assert.equal(Math.abs(fox.animDur - 0.5) < 1e-9, true);
  const front = b.aliveEnemies().sort((a, c) => a.x - c.x)[0];
  runTo(b, 0, 2.1);
  assert.ok(front.attackAnimT > 0, '开火后攻击动画计时置满(首击 2.0s)');
  // 主角:launch 置 0.18s
  const b2 = new Battle({ atk: 10, maxHp: 100, rng: makeRng(1) });
  b2.spawnWave(1, 500);
  b2.launch({ element: 'fire', tier: 1 });
  assert.ok(Math.abs(b2.playerAttackT - 0.18) < 1e-9, 'launch 置攻击动画计时');
  b2.update(0.18);
  assert.ok(b2.playerAttackT <= 0, '动画计时衰减归零');
});

test('FR-1.2 单弹(w=1)直射主角;4 弹(w=10)始终有一颗 0° 直射(对标原版 fire_spread)', () => {
  const e1 = new Enemy({ name: 'slime', hp: 30, x: 560, y: 280, boltCount: 1, fanDeg: 20, boltSpeed: 305, boltDmg: 4 });
  const single = e1.fireFan(110, 280);
  assert.equal(single.length, 1);
  const e4 = new Enemy({ name: 'boss', hp: 187, x: 560, y: 230, boltCount: 4, fanDeg: 35, boltSpeed: 350, boltDmg: 19 });
  const bolts = e4.fireFan(110, 280);
  assert.equal(bolts.length, 4);
  // 0° 直射弹:方向与到主角连线同向(enemy_projectile_manager.gd:53-54)
  const b0 = bolts[0];
  const dirx = (110 - e4.x) / Math.hypot(110 - e4.x, 280 - e4.y);
  const diry = (280 - e4.y) / Math.hypot(110 - e4.x, 280 - e4.y);
  assert.ok(Math.abs(b0.vx / 350 - dirx) < 1e-9 && Math.abs(b0.vy / 350 - diry) < 1e-9, '第一颗为 0° 直射');
  // 各弹速度模长 = 弹速;散射弹带侧偏(非全部同向)
  for (const bb of bolts) assert.ok(Math.abs(Math.hypot(bb.vx, bb.vy) - 350) < 1e-9);
  const angles = bolts.map(bb => Math.atan2(bb.vy, bb.vx));
  assert.ok(new Set(angles.map(a => a.toFixed(6))).size === 4, '4 弹 4 个方向');
});

test('FR-1.2 敌方弹幕伤害入账:L5 末波 w_global=50 妖王弹命中 → 主角 −59(03 文档 4.4 取整口径)', () => {
  const b = new Battle({ rng: makeRng(3) });
  b.startLevel(5); // 妖王=L5 Boss(需求方 2026-10-19:L1 Boss 改狐妖)
  // 直接构造第 10 波(-05 N2:真实 w_global=10×L=50;旧 w=10 值 19 仅是独立公式例)
  b.wave = 10; b.wGlobal = 50;
  b.tides = buildWave(10, 5, makeRng(3));
  b.tideIdx = 0;
  b.enemies = [];
  b.spawnTide();
  assert.equal(b.enemies[0].name, 'boss');
  assert.equal(b.enemies[0].isBoss, true, '妖王 isBoss 显式传入');
  assert.equal(b.enemies[0].boltDmg, 59, 'L5 末波 w_global=50:round(8×2.5×(1+49×0.1)×0.5)=59');
  // 瞬移 boss 至停位,取其扇形弹入列,推进至直射弹抵达主角
  const boss = b.enemies[0];
  boss.x = 560;
  b.ebolts.push(...boss.fireFan(110, 280));
  runTo(b, b.clock, b.clock + 1.5);
  assert.ok(b.hp < b.maxHp, '直射弹命中主角');
  assert.equal(events(b, 'player_hurt').some(h => h.dmg === 59), true, '受击 59');
});

// ---- FR-1.3 敌方弹碰撞(圆形,主角半径 40;扫掠与帧步长无关) ----
test('FR-1.3 命中判定:正对主角的弹命中;偏移超过判定半径的弹不命中', () => {
  const px = 110, py = 280;
  const hit = { x: 130, y: 280, vx: -300, vy: 0, t: 0, lastDt: 0.05 }; // 距主角 20px,一步 15px
  advanceEnemyBolt(hit, 0.05);
  assert.equal(enemyBoltHitsPlayer(hit, px, py), true, '直线命中');
  const miss = { x: 130, y: 340, vx: -300, vy: 0, t: 0, lastDt: 0.05 }; // y 偏移 60px > 40
  advanceEnemyBolt(miss, 0.05);
  assert.equal(enemyBoltHitsPlayer(miss, px, py), false, '偏航脱靶');
});

test('FR-1.3 帧步长无关:大步长 dt=0.05 不漏检(帧末已越过主角仍判定命中)', () => {
  const px = 110, py = 280;
  // 弹距主角 10px,一步 dt=0.05、速度 300 → 越过主角 5px;帧末位置在主角另一侧
  const b = { x: 120, y: 280, vx: -300, vy: 0, t: 0, lastDt: 0.05 };
  advanceEnemyBolt(b, 0.05);
  assert.ok(b.x < px, '帧末已越过主角');
  assert.equal(enemyBoltHitsPlayer(b, px, py), true, '扫掠检测补中');
});

test('FR-1.3 护盾先吸收:盾 10、弹幕 19 → 盾清零、HP −9(土行护盾语义)', () => {
  const b = new Battle({ atk: 10, maxHp: 100, rng: makeRng(1) });
  b.shield = 10;
  b.hurtPlayer(19);
  assert.equal(b.shield, 0);
  assert.equal(b.hp, 91);
  assert.deepEqual(events(b, 'player_hurt')[0], { t: b.clock, ev: 'player_hurt', dmg: 19, toShield: 10, hp: 91 });
});

// ---- FR-1.4 胜负 ----
test('FR-1.4 主角 HP≤0 → DEFEAT;update 冻结;restart 从第 1 波重来且经验不清退', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(5) });
  b.startLevel(1);
  b.hurtPlayer(100);
  assert.equal(b.phase, PHASE.DEFEAT);
  assert.equal(b.hp, 0);
  const clockFrozen = b.clock;
  b.expGained = 37; b.kills = 9; // 模拟已获收益
  b.update(0.016);
  assert.equal(b.clock, clockFrozen, '结算后冻结');
  b.restart();
  assert.equal(b.phase, PHASE.FIGHTING);
  assert.equal(b.wave, 1, '从第 1 波重来');
  assert.equal(b.hp, b.maxHp);
  assert.equal(b.expGained, 37, '已获经验不清退(05 文档第 2 节)');
  assert.equal(b.kills, 9);
});

test('FR-1.4 波次推进:第 1 波(2 潮)全部清空 → 第 2 波', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(6) });
  b.startLevel(1);
  assert.equal(b.wave, 1);
  assert.equal(b.enemies.length, b.tides[0].length, '首潮已刷');
  // 清空两潮 → 推进到第 2 波
  for (let tide = 0; tide < 2; tide++) {
    for (const e of b.enemies) e.hurt(e.hp);
    b.enemies = b.enemies.filter(e => e.alive);
    b.update(0.016);
  }
  assert.equal(b.wave, 2, '全波清空后推进第 2 波');
  assert.ok(b.enemies.length > 0, '第 2 波首潮已刷');
});

test('FR-1.4 第 10 波清空 → VICTORY + 通关奖励 50×L(第 1 关=50)', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(7) });
  b.startLevel(1);
  b.wave = 10; b.wGlobal = 10;
  b.tides = buildWave(10, 1, makeRng(7));
  b.tideIdx = 0;
  b.enemies = [];
  b.spawnTide();
  assert.equal(b.enemies.length, 3, 'Boss+2 护卫');
  for (const e of b.enemies) e.hurt(e.hp);
  b.enemies = b.enemies.filter(e => e.alive);
  const before = b.expGained;
  b.update(0.016);
  assert.equal(b.phase, PHASE.VICTORY);
  assert.equal(b.expGained - before, 50, '通关奖励 50×1');
});

// ---- 击杀经验(05 文档第 5 节) ----
test('击杀经验 2+w_global 动态;Boss ×20:第 1 关 Boss = 240', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(8) });
  b.startLevel(1);
  const e = b.enemies[0];
  assert.equal(e.w, 1);
  assert.equal(b.expFor(e), 3); // 2+1
  const boss = b.enemies.find(x => x.isBoss)
    || (() => { const bo = new Enemy({ name: 'boss', hp: 187, x: 560, y: 230, w: 10 }); b.enemies.push(bo); return bo; })();
  assert.equal(b.expFor(boss), 240); // (2+10)×20
});

// ---- 潮汐(FR-4 同屏 ≤5) ----
test('FR-4 潮汐推进:第 1 波 2 潮(3+3),首潮清空后刷次潮,同屏 ≤5', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(9) });
  b.startLevel(1);
  assert.equal(b.tides.length, 2);
  assert.equal(b.enemies.length, 3, '首潮 3 只');
  for (const e of b.enemies) e.hurt(e.hp);
  b.enemies = b.enemies.filter(e => e.alive);
  b.update(0.016);
  assert.equal(b.tideIdx, 1);
  assert.equal(b.enemies.length, 3, '次潮 3 只');
  assert.ok(b.enemies.length <= 5, '同屏 ≤5');
});

test('FR-4 第 9 波 22 只 = 5 潮(5+5+4+4+4),逐潮推进', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(10) });
  b.startLevel(1);
  b.wave = 9; b.wGlobal = 9;
  b.tides = buildWave(9, 1, makeRng(10));
  b.tideIdx = 0;
  b.enemies = [];
  b.spawnTide();
  assert.deepEqual(b.tides.map(t => t.length), [5, 5, 4, 4, 4]);
  assert.equal(b.enemies.length, 5);
  const sizes = [];
  for (let tide = 0; tide < 5; tide++) {
    sizes.push(b.enemies.length);
    for (const e of b.enemies) e.hurt(e.hp);
    b.enemies = b.enemies.filter(e => e.alive);
    b.update(0.016);
  }
  assert.deepEqual(sizes, [5, 5, 4, 4, 4], '逐潮刷怪,同屏始终 ≤5');
  assert.equal(b.wave, 10, '第 9 波清空 → 第 10 波(Boss)');
  assert.equal(b.enemies.length, 3);
});

// ---- 减速(水弹 → 敌人移速/弹速 ×(1−pct/100),03 文档第 3 节) ----
test('FR-1.2 减速消费:slowT 内移速 ×0.7(30% 减速);到期恢复', () => {
  const e = new Enemy({ name: 'slime', hp: 30, x: 760, y: 280, spd: 150 });
  e.slowT = 2; e.slowPct = 30;
  e.update(1.0, 110, 280);
  assert.ok(Math.abs((760 - e.x) - 150 * 0.7) < 1e-9, '减速 30% → 105px/s');
  e.slowT = 0;
  const x2 = e.x;
  e.update(0.5, 110, 280);
  assert.ok(Math.abs((x2 - e.x) - 75) < 1e-9, '到期恢复 150px/s(半秒 75px,未触及停位)');
});

test('FR-1.2 减速作用于弹速:boltSpeed ×(1−pct/100)(fireFan 出口)', () => {
  const e = new Enemy({ name: 'slime', hp: 30, x: 560, y: 280, boltCount: 1, fanDeg: 20, boltSpeed: 305, boltDmg: 4, spd: 0, interval: 99 });
  e.slowT = 2; e.slowPct = 50;
  const bolts = e.fireFan(110, 280);
  assert.ok(Math.abs(Math.hypot(bolts[0].vx, bolts[0].vy) - 152.5) < 1e-9, '305×0.5');
});

// ---- FR-1.5 视差参数(逻辑纯函数部分;tile 生成需 DOM,CIP 证据覆盖) ----
test('FR-1.5 screenshake:4px/120ms 衰减;pulse 1.0→1.02→1.0;关闭动效后全部归零', () => {
  const p = new Parallax({ effects: true });
  p.triggerShake();
  p.triggerPulse();
  p.update(0.05); // pulse 进入上升段(sin>0),shake 剩 0.07s
  let tf = p.transform();
  assert.ok(tf.scale > 1 && tf.scale <= 1.02, 'pulse 上升段抬升');
  p.update(0.06);
  tf = p.transform();
  assert.ok(tf.shakeT === undefined); // transform 只回偏移/缩放
  assert.ok(Math.abs(tf.ox) <= 4 && Math.abs(tf.oy) <= 4, '震幅 ≤4px');
  p.update(0.07); // 累计 0.13s > 0.12s
  tf = p.transform();
  assert.equal(tf.ox, 0, 'screenshake 到期归零');
  assert.equal(tf.oy, 0, 'screenshake 到期归零');
  p.update(0.25); // pulse 结束(0.3s)
  tf = p.transform();
  assert.equal(tf.scale, 1, 'pulse 复位');
  // 关闭动效:触发无效,transform 恒等
  const off = new Parallax({ effects: false });
  off.triggerShake(); off.triggerPulse();
  off.update(0.016);
  const tfo = off.transform();
  assert.equal(tfo.ox, 0);
  assert.equal(tfo.oy, 0);
  assert.equal(tfo.scale, 1);
});

test('FR-1.5 飘叶粒子 ≤20(≤40 总约束);关闭动效不生成粒子', () => {
  const p = new Parallax({ effects: true });
  for (let i = 0; i < 120; i++) p.update(0.016);
  assert.ok(p.leaves.length <= 20, '飘叶上限 20');
  const off = new Parallax({ effects: false });
  for (let i = 0; i < 120; i++) off.update(0.016);
  assert.equal(off.leaves.length, 0, '关闭动效无粒子');
});

// ---- REQ-M3-03 整改回归(裁决 8 项) ----
test('整改1 弹道归属:路径上最先碰到的敌人先被命中,不再按发射时绑定目标穿透', () => {
  const b = new Battle({ atk: 10, maxHp: 100, rng: makeRng(1) });
  // 仅后排存在时发射(bolt 朝其 y);随后前排进入弹道
  const rear = new Enemy({ name: 'slime', hp: 30, x: 700, y: 240, w: 1 });
  b.enemies.push(rear);
  b.launch({ element: 'fire', tier: 1 });
  assert.equal(b.bolts.length, 1);
  const front = new Enemy({ name: 'slime', hp: 30, x: 560, y: 240, w: 1 });
  b.enemies.push(front);
  runTo(b, b.clock, b.clock + 1.3);
  assert.ok(front.hp < front.maxHp, '前排先挡先中(REQ-M3-03 整改 1)');
  assert.equal(rear.hp, rear.maxHp, '后排未被误中');
});

test('REQ-M3-04 整改1 命中顺序=首次相交:二档火弹双靶各归各靶,dt=0.047 与 0.001 一致', () => {
  // 审核反例:spawnWave(2,200) 两敌同 x 不同 y(dy=45<R),按敌心 x 排序时大步长下两弹误中同一靶
  for (const dt of [0.001, 1 / 60, 0.047]) {
    const b = new Battle({ atk: 10, maxHp: 100, rng: makeRng(1) });
    b.spawnWave(2, 200); // (560,150) (560,195)
    b.launch({ element: 'fire', tier: 2 });
    assert.equal(b.bolts.length, 2);
    let t = b.clock;
    const target = b.clock + 0.8;
    while (t < target) { b.update(dt); t += dt; }
    const hps = b.enemies.map(e => e.hp).sort((a, c) => a - c);
    // M8 暴击:单发伤=16 或 round(16×1.5)=24(种子决定)——各中一靶 ⇔ 每敌恰吃 1 发:
    // 无未受击者(200)且无双受击者(≤168);合法集 [176,176]/[176,184]/[184,184]
    assert.ok(hps[0] >= 176 && hps[1] <= 184, `dt=${dt} 双弹各中一靶(单发 16/24 含暴击;实得 [${hps}])`);
  }
});

test('整改1 多步长稳健:dt=0.05 大步长下弹道归属仍正确', () => {
  const b = new Battle({ atk: 10, maxHp: 100, rng: makeRng(1) });
  const rear = new Enemy({ name: 'slime', hp: 30, x: 700, y: 240, w: 1 });
  b.enemies.push(rear);
  b.launch({ element: 'fire', tier: 1 });
  b.enemies.push(new Enemy({ name: 'slime', hp: 30, x: 560, y: 240, w: 1 }));
  let t = b.clock;
  const target = b.clock + 1.3;
  while (t < target) { const dt = 0.05; b.update(dt); t += dt; }
  const front = b.enemies.find(e => e.x === 560);
  assert.ok(front.hp < front.maxHp, '大步长不漏检、归属不变');
  assert.ok(b.enemies[0].hp === b.enemies[0].maxHp || !b.enemies[0].alive || b.enemies[0].x === 560, '前排先结算');
});

test('整改4 出生即保持实际队距 ≥110,入场途中不塌缩', () => {
  const b = new Battle({ maxHp: 100, rng: makeRng(4) });
  b.startLevel(1);
  const minGap = (es) => {
    const xs = es.map(e => e.x).sort((a, c) => a - c);
    let m = Infinity;
    for (let i = 1; i < xs.length; i++) m = Math.min(m, xs[i] - xs[i - 1]);
    return m;
  };
  assert.ok(minGap(b.aliveEnemies()) >= MIN_QUEUE_GAP, '出生位置实际间距 ≥110(此前全员挤在 760)');
  runTo(b, 0, 0.7); // 入场途中(同速左移,间距守恒)
  assert.ok(minGap(b.aliveEnemies()) >= MIN_QUEUE_GAP - 1e-6, '入场途中实际间距 ≥110');
});

test('REQ-M3-04 整改2 减速不破坏队距:前车减速后车钳制,全程实际间距 ≥110', () => {
  // 审核复算例:第一波立即放一档水弹,前车减速后间距最小 91.55px
  const b = new Battle({ atk: 10, maxHp: 100, rng: makeRng(4) });
  b.startLevel(1);
  b.launch({ element: 'water', tier: 1 }); // 减速最近的前车
  let t = b.clock;
  const minSeen = { v: Infinity };
  while (t < 2.0) {
    b.update(0.01);
    t += 0.01;
    const xs = b.aliveEnemies().map(e => e.x).sort((a, c) => a - c);
    for (let i = 1; i < xs.length; i++) minSeen.v = Math.min(minSeen.v, xs[i] - xs[i - 1]);
  }
  assert.ok(minSeen.v >= MIN_QUEUE_GAP - 1e-6, `减速全程实际队距 ≥110(实测最小 ${minSeen.v.toFixed(2)})`);
  // 恢复后仍守恒
  runTo(b, t, 4.0);
  const xs = b.aliveEnemies().map(e => e.x).sort((a, c) => a - c);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= MIN_QUEUE_GAP - 1e-6, '恢复后队距');
});

test('整改5 扇形逐弹角度:9 弹 60° 偏角恰为 0,±7.5,±15,±22.5,±30;17 弹 100° 最大偏角 50°;4 弹对标原版', () => {
  // 原版 GDScript level 为整数除法 (n+1)/2 → 1,1,2,2…;JS 直译浮点除法是 REQ-M3-03 整改 5 根因
  const offsets = (n, deg) => {
    const e = new Enemy({ name: 'slime', hp: 30, x: 560, y: 240, boltCount: n, fanDeg: deg, boltSpeed: 300, boltDmg: 4, interval: 99 });
    return e.fireFan(110, 240).map(bb => {
      let o = Math.atan2(bb.vy, bb.vx) * 180 / Math.PI - 180; // 基准角=180°(朝 −x);归一化到 (−180,180]
      o = ((o % 360) + 540) % 360 - 180;
      return +o.toFixed(6);
    }).sort((a, c) => a - c);
  };
  assert.deepEqual(offsets(9, 60), [-30, -22.5, -15, -7.5, 0, 7.5, 15, 22.5, 30], '9 弹总张角恰为 60°');
  const o17 = offsets(17, 100);
  assert.equal(Math.max(...o17.map(Math.abs)), 50, '17 弹最大偏角=半角 50°');
  assert.equal(new Set(o17.map(Math.abs)).size, 9, '17 弹 9 个绝对档位');
  assert.deepEqual(offsets(4, 35), [-70 / 6, 0, 70 / 6, 140 / 6].map(v => +v.toFixed(6)),
    '4 弹:step=17.5/1.5,level 1,1,2(偶数弹数单侧溢出为原版 fire_spread 固有行为,已注释)');
});

test('整改6 默认 RNG 兜底:不传 rng 时 startLevel/update/restart 全程可跑', () => {
  const b = new Battle({ atk: 10, maxHp: 100 }); // 无 rng → LCG 兜底(此前传入未绑定方法直接 TypeError)
  b.startLevel(1);
  assert.ok(b.enemies.length > 0, '兜底 rng 可完成波次构建与刷怪');
  runTo(b, 0, 0.2);
  b.restart();
  assert.equal(b.wave, 1);
  assert.ok(b.enemies.length > 0, '重试路径同样可用');
});

// ---- 类型表完整性(FR-9/04 文档第 1 节) ----
test('六类敌人倍率表与 04 文档第 1 节一致;帧清单非空(slime 15/fox 8/zombie 11/snake 12/tiger 9/boss 19)', () => {
  const want = {
    slime: [1.0, 1.0, 15], fox: [1.2, 1.1, 8], zombie: [1.4, 1.2, 11],
    snake: [1.6, 1.4, 12], tiger: [2.0, 1.7, 9], boss: [3.0, 2.5, 19],
  };
  for (const [name, [hp, dmg, frames]] of Object.entries(want)) {
    assert.equal(ENEMY_TYPES[name].hpMult, hp, `${name} hpMult`);
    assert.equal(ENEMY_TYPES[name].dmgMult, dmg, `${name} dmgMult`);
    assert.equal(ENEMY_TYPES[name].frames.length, frames, `${name} 帧数`);
  }
  assert.equal(ENEMY_TYPES.boss.radius, 60, 'Boss 碰撞半径更大(FR-1.3 按贴图缩放定)');
  assert.equal(PLAYER_HIT_R, 40, '主角判定半径 40(04 文档第 2 节)');
});
