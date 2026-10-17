// tests/render.test.mjs
// 渲染层演出接线单测(REQ-M6-07 F8 续审:**实际 render 入口**验证段②③④确实绘制——
// 上轮仅测引擎插值未调 render,漏掉了「cl.stage 读错致段②③④全灭」的接线回归)
// 运行: node --test tests/render.test.mjs
// 相对路径: tests/render.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

// 浏览器全局桩(render.js 模块顶层 new Image() 懒加载贴图;complete 为假走矢量兜底)
globalThis.Image = class { set src(v) { this._src = v; } get complete() { return false; } };

const { render } = await import('../scripts/ui/render.js');
const { BoardEngine } = await import('../scripts/board/engine.js');
const { FxLayer } = await import('../scripts/ui/fx.js');
const { emptyGrid, hasNoMatches } = await import('../scripts/board/grid.js');
const { skillById } = await import('../scripts/skills/library.js');

// ---- 录制型 2D context 桩:记录 fillText/scale/stroke/beginPath 调用 ----
function mkCtx() {
  const rec = { fillTexts: [], scales: [], strokes: 0, gradients: 0 };
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === '__rec') return rec;
      if (prop === 'createLinearGradient') return () => { rec.gradients++; return gradient; };
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'fillText') return (text) => rec.fillTexts.push(String(text));
      if (prop === 'scale') return (x, y) => rec.scales.push([x, y]);
      if (prop === 'stroke') return () => { rec.strokes++; };
      return () => {};
    },
    set() { return true; },
  });
  return { ctx, rec };
}

// 公开入口构造(与 board.test 同口径):背景无同色正交相邻,trySwap 构造 2×2
function mkStage(fx) {
  const e = new BoardEngine(7);
  e.fxEnabled = fx;
  let t = 0;
  while (e.state !== 'IDLE' && t < 30) { e.update(0.016); t += 0.016; }
  e.grid = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  e.grid[3][4] = { el: 0 }; e.grid[4][3] = { el: 0 }; e.grid[4][4] = { el: 0 };
  e.grid[3][2] = { el: 1 }; e.grid[3][3] = { el: 1 };
  assert.ok(e.trySwap({ r: 2, c: 3 }, { r: 3, c: 3 }));
  e.update(0.16);
  assert.equal(e.state, 'RESOLVING');
  return e;
}

function mkHud(engine, { fxLayer = new FxLayer(), caster = null, charge = null } = {}) {
  return {
    battle: null,
    parallax: { transform: () => ({ ox: 0, oy: 0, scale: 1 }), draw() {} },
    charge, caster: caster ? { loadout: [], skillCds: {}, ...caster } : null,
    fx: fxLayer,
    screen: () => 'playing',
    profile: () => ({ level: 1, coins: 0, materials: 0 }),
    progress: () => ({ unlockedLevel: 1, lastLevelCleared: 0 }),
    cleared: () => 0,
    drag: () => ({ drag: null, bounces: [] }),
    growPanel: () => false,
    toast: null,
  };
}

test('F8 render 接线:段②五行色粒子迸发 ≤8 真实触发(实际 render 入口)', () => {
  const e = mkStage(true);
  const fx = new FxLayer();
  e.update(0.4); // 段②(0.35~0.5)
  const { ctx } = mkCtx();
  render(ctx, e, mkHud(e, { fxLayer: fx }));
  const key = [...e.blockFx.keys()][0];
  assert.ok(e._flashShown.has(key), '段②闪光粒子已触发(上轮 g.stage 恒 0 时此处必挂)');
  assert.ok(fx.particles.length > 0 && fx.particles.length <= 8, `段②粒子 ${fx.particles.length} 个(02 3.1:≤8)`);
});

test('F8 render 接线:段③技能图标=预约技能名+档位星(状态驱动,认领后可见)', () => {
  const e = mkStage(true);
  e.update(0.6); // 段③(0.5~0.75)
  // 模拟 main 认领(engine.claimBlockFx,事件入口/tick 执行记录共用此绑定)
  const el0 = [...e.blockFx.values()][0].el; // 本轮被消块的实际元素
  assert.ok(e.claimBlockFx(el0, 'fire_bolt', 2), '认领成功');
  const { ctx, rec } = mkCtx();
  render(ctx, e, mkHud(e, { caster: { pending: [] }, charge: { tiers: { [el0]: 0 } } }));
  const name = skillById('fire_bolt')?.name || 'fire_bolt';
  assert.ok(rec.fillTexts.some(t => t.includes(name) && t.includes('★★')), `段③图标绘制「${name} ★★」,实际: ${JSON.stringify(rec.fillTexts)}`);
});

test('F8 render 接线:未认领块显示「蓄能」+池内档位;段④图标放大 1.3 倍+碎片飞散+径向光效', () => {
  const e = mkStage(true);
  const fx = new FxLayer();
  e.update(0.55);
  let { ctx, rec } = mkCtx();
  const el0 = [...e.blockFx.values()][0].el;
  render(ctx, e, mkHud(e, { caster: { pending: [] }, charge: { tiers: { [el0]: 1 } }, fxLayer: fx }));
  assert.ok(rec.fillTexts.some(t => t.includes('蓄能') && t.includes('★')), `未认领显示蓄能+池档,实际: ${JSON.stringify(rec.fillTexts)}`);
  // 段④(0.75~0.9):放大 1.3 倍(含 >1 的 scale)+碎片 stroke+径向光效粒子
  e.update(0.25); // elapsed 0.8
  ({ ctx, rec } = mkCtx());
  const before = fx.particles.length;
  render(ctx, e, mkHud(e, { caster: { pending: [] }, charge: { tiers: { [el0]: 1 } }, fxLayer: fx }));
  assert.ok(rec.scales.some(([sx, sy]) => sx > 1 && sy > 1 && sx <= 1.31), `段④放大 scale>1(≤1.3 倍),实际: ${JSON.stringify(rec.scales)}`);
  assert.ok(rec.strokes >= 4, `段④碎片飞散 stroke ${rec.strokes} 次(≥4 片)`);
  assert.ok(fx.particles.length > before, '段④径向光效粒子已触发');
  // 认领发生在段④仍显示(0.8s 延迟选技场景:执行记录认领)
  e.claimBlockFx(el0, 'fire_bolt', 1);
  ({ ctx, rec } = mkCtx());
  render(ctx, e, mkHud(e, { caster: { pending: [] }, charge: { tiers: { [el0]: 1 } } }));
  const name = skillById('fire_bolt')?.name || 'fire_bolt';
  assert.ok(rec.fillTexts.some(t => t.includes(name)), '0.8s 认领后段④图标显示实际技能名');
});

test('F8 render 接线:关动效不绘制段③④图标(退化口径)', () => {
  const e = mkStage(false); // clearFxAtStart=false,总时长 0.2s
  e.update(0.05); // 淡出中(若读 stage 旧路径,fxEnabled false 已短路;此处验证无图标文案)
  const el0 = [...e.blockFx.values()][0].el;
  e.claimBlockFx(el0, 'fire_bolt', 1);
  const { ctx, rec } = mkCtx();
  render(ctx, e, mkHud(e, { caster: { pending: [] }, charge: { tiers: { [el0]: 1 } } }));
  const name = skillById('fire_bolt')?.name || 'fire_bolt';
  assert.ok(!rec.fillTexts.some(t => t.includes(name) || t.includes('蓄能')), '关动效无技能图标/蓄能绘制');
  assert.ok(stepEnd(e));
});

function stepEnd(e) {
  let t = 0;
  while (e.state !== 'IDLE' && t < 5) { e.update(0.016); t += 0.016; }
  return e.state === 'IDLE' && hasNoMatches(e.grid);
}

test('F8 render 接线(REQ-08):同元素双块单候选——已认领块显技能名,第二块保持蓄能', () => {
  const e = mkStage(true);
  e.update(0.6); // 段③
  const el0 = [...e.blockFx.values()][0].el;
  // 注入同刻第二块清除组(mkStage 种子单块;渲染组按 clearing bk 分组,纯显示单元):
  // 双块布局取自 m6.test REQ-08 F8 场景 A 的模块组合结果(b0 绑定火弹 resKey r1,b1 未认领;
  // 真实 main 循环的双块消费接线由 CDP .tmp/m6-f8-cdp.mjs 覆盖,本用例只验证渲染显示)
  const ref = e.clearing[0];
  e.clearing.push({ r: 0, c: 0, t: ref.t, el: ref.el, cx: 0, cc: 0, bk: 'b1', delay: 0 });
  e.blockFx.set('b0', { el: el0, reserved: true, skillId: 'fire_bolt', tier: 1, resKey: 'r1' });
  e.blockFx.set('b1', { el: el0, reserved: false });
  const { ctx, rec } = mkCtx();
  render(ctx, e, mkHud(e, { caster: { pending: [] }, charge: { tiers: { [el0]: 1 } } }));
  const name = skillById('fire_bolt')?.name || 'fire_bolt';
  assert.ok(rec.fillTexts.some(t => t.includes(name)), `b0 段③显示预约技能名,实际: ${JSON.stringify(rec.fillTexts)}`);
  assert.ok(rec.fillTexts.some(t => t.includes('蓄能')), 'b1 显示蓄能+池档(未被同预约误标)');
});
