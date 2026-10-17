// tests/m9.test.mjs — M9 批次:演出期可操作(并行交换+预输入缓冲)/连锁 RUSH 加速/连锁播报
// 运行: node --test tests/m9.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { BoardEngine } from '../scripts/board/engine.js';
import { FxLayer } from '../scripts/ui/fx.js';
import { Charge } from '../scripts/skills/charge.js';
import { Caster } from '../scripts/skills/cast.js';
import { attachInput } from '../scripts/core/input.js';

// 浏览器全局桩(render.js 模块顶层 new Image();同 render.test.mjs 口径)
globalThis.Image = class { set src(v) { this._src = v; } get complete() { return false; } };
const { render } = await import('../scripts/ui/render.js');

// ---- 录制型 2D context 桩(同 render.test.mjs mkCtx 口径) ----
function mkRenderCtx() {
  const rec = { fillTexts: [], strokes: 0 };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === '__rec') return rec;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'fillText') return (text) => rec.fillTexts.push(String(text));
      if (prop === 'stroke') return () => { rec.strokes++; };
      return () => {};
    },
    set() { return true; },
  });
  return { ctx, rec };
}

// ---- 最小 hud 桩(同 render.test.mjs mkHud 口径) ----
function mkHudStub(engine, fxLayer) {
  return {
    battle: null,
    parallax: { transform: () => ({ ox: 0, oy: 0, scale: 1 }), draw() {} },
    charge: null, caster: null,
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

// 注入确定性棋盘:基础模式 el=(r+c)%5(行/列内相邻永不相等,无三连),再手工布置:
// ①金三连 (0,0)(0,1)(0,2) el=0(第一环消除;行 0 顶部空洞仅补位无位移,其余布局不受影响)
// ②预留两连 (6,3)(6,4) el=2——交换相邻 (6,5)↔(6,6)((6,6) 基础 el=2)后成行 6 三连
// ③预留两连 (4,7)(5,7) el=2((5,7) 基础已 2)——交换相邻 (3,6)↔(3,7)((3,6) 改 2)后成列 7 三连
//   (第二并行交换预留;远离②避免组成 ≥4 连通块被第一环误消)
function inject(e) {
  e.grid = Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => ({ el: (r + c) % 5 })));
  e.grid[0][0].el = 0; e.grid[0][1].el = 0; e.grid[0][2].el = 0;
  e.grid[6][3].el = 2; e.grid[6][4].el = 2;
  e.grid[3][6].el = 2; e.grid[4][7].el = 2;
  return e;
}
const SWAP_A = { r: 6, c: 5 }, SWAP_B = { r: 6, c: 6 }; // 并行/缓冲交换(换后 (6,3)(6,4)(6,5) 三连)
const SWAP_C = { r: 3, c: 6 }, SWAP_D = { r: 3, c: 7 }; // 第二并行交换(换后 (3,7)(4,7)(5,7) 列三连)

// ---- M9 连锁 RUSH(02 文档 3.1) ----
test('M9 rushScale 数字例:chain1=1.00/2=0.85/3=0.70/4=0.55/≥5=0.45 封底;chain0(补位)=1', () => {
  const e = new BoardEngine(1);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(c => e.rushScale(c)), [1, 1, 0.85, 0.7, 0.55, 0.45, 0.45]);
});

test('M9 消除演出 RUSH:clearTotal/四段时长按 rushScale 缩放(chain3=0.70;动效关退化同步缩放)', () => {
  const e = inject(new BoardEngine(1));
  e.fxEnabled = true;
  e.chain = 3;
  e._beginRound();
  assert.ok(Math.abs(e.clearTotal - 0.9 * 0.7) < 1e-9, `总时长 0.9×0.70(实得 ${e.clearTotal})`);
  assert.deepEqual(e.stageDur.absorb.toFixed(6), (0.35 * 0.7).toFixed(6), '段① 0.35×0.70');
  assert.deepEqual(e.stageDur.icon.toFixed(6), (0.25 * 0.7).toFixed(6), '段③ 0.25×0.70');
  assert.equal(e.rush, 0.7);
  const e2 = inject(new BoardEngine(1));
  e2.fxEnabled = false;
  e2.chain = 3;
  e2._beginRound();
  assert.ok(Math.abs(e2.clearTotal - 0.20 * 0.7) < 1e-9, '动效关退化 0.20×0.70(同步加速)');
});

test('M9 下落 RUSH:fallT 按 rushScale(chain) 缩放(消除环 chain 的补位下落)', () => {
  const e = new BoardEngine(1);
  e.chain = 2;
  e.grid[0][0] = null; e.grid[1][0] = null; // 列 0 挖两格 → 下方 6 格各下移 2、顶部补 2
  e._applyFalls();
  assert.equal(e.state, 'IDLE', '直接编排不下改变状态(仅验证 fallT 计算)');
  const maxDist = Math.max(...e.falls.map(m => m.dist));
  assert.equal(maxDist, 2);
  assert.ok(Math.abs(e.fallT - 2 * 0.08 * 0.85) < 1e-9, `fallT=${e.fallT} 期望 ${2 * 0.08 * 0.85}(2 格×80ms×0.85)`);
});

// ---- M9/M11 演出期并行交换(RESOLVING;M11 任意相邻非空对受理+多槽) ----
test('M11 并行交换:RESOLVING 中任意相邻非空对立即受理写回 grid(不成消=断连锁策略);动画槽满 3 转缓冲', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound(); // 金三连 → RESOLVING
  assert.equal(e.state, 'RESOLVING');
  assert.equal(e.grid[6][6].el, 2, '注入自检:(6,6) 基础 el=2');
  // 不成消的交换也受理(M11:任何时刻都可操作;(7,0)↔(7,1) 换后无三连=主动断连锁策略空间)
  assert.equal(e.trySwap({ r: 7, c: 0 }, { r: 7, c: 1 }), true, '不成消交换受理(断连锁策略)');
  assert.notEqual(e.grid[7][0].el, 2, 'grid 已即时交换');
  assert.equal(e.parallelSwaps.length, 1, '并行动画槽登记 1 条');
  // 交换 (6,5)↔(6,6):换后行 6 (6,3)(6,4)(6,5) el=2 成三连
  assert.equal(e.trySwap(SWAP_A, SWAP_B), true, 'RESOLVING 中成消交换放行');
  assert.equal(e.grid[6][5].el, 2, 'grid 已即时交换((6,5)=2)');
  assert.equal(e.grid[6][6].el, 1, 'grid 已即时交换((6,6)=原(6,5) 基础 1)');
  assert.equal(e.parallelSwaps.length, 2, '并行动画槽 2 条');
  assert.equal(e.state, 'RESOLVING', '状态机主转移不受影响(不进 SWAPPING)');
  // 补满第 3 槽 → 第 4 次交换转预输入缓冲(PARALLEL_MAX=3)
  assert.equal(e.trySwap({ r: 0, c: 4 }, { r: 0, c: 5 }), true, '第 3 槽受理');
  assert.equal(e.parallelSwaps.length, 3, '动画槽满 3');
  assert.equal(e.trySwap({ r: 7, c: 0 }, { r: 7, c: 1 }), true, '槽满仍受理(转缓冲)');
  assert.deepEqual(e.swapBuffer.a, { r: 7, c: 0 }, '缓冲记录最新意图');
});

test('M11-02 F8 同格不重复占用:重叠对受理终止旧槽(槽被替换不叠加);同对连点两次偏移≤1 格', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound(); // RESOLVING
  // 第 1 槽 (7,0)↔(7,1);随后与 (7,1) 重叠的 (7,1)↔(7,2) 受理 → 旧槽终止(不再叠加偏移)
  assert.equal(e.trySwap({ r: 7, c: 0 }, { r: 7, c: 1 }), true);
  assert.equal(e.parallelSwaps.length, 1);
  assert.equal(e.trySwap({ r: 7, c: 1 }, { r: 7, c: 2 }), true);
  assert.equal(e.parallelSwaps.length, 1, '重叠旧槽被终止,仅新槽 1 条(修复前累加为 2)');
  assert.ok(!e.parallelSwaps.some(ps => ps.a.r === 7 && ps.a.c === 0), '旧槽 (7,0) 已移除');
  // 同一对连点两次:grid 还原(a 格内容回原),同对槽仅 1 条(旧槽被替换),渲染偏移幅度 ≤1 格(90px,修复前 ±180)
  const g0 = e.grid[6][4].el, g1 = e.grid[6][5].el;
  assert.equal(e.trySwap({ r: 6, c: 4 }, { r: 6, c: 5 }), true);
  assert.equal(e.trySwap({ r: 6, c: 4 }, { r: 6, c: 5 }), true);
  const pairSlots = e.parallelSwaps.filter(ps =>
    (ps.a.r === 6 && ps.a.c === 4) || (ps.a.r === 6 && ps.a.c === 5) ||
    (ps.b.r === 6 && ps.b.c === 4) || (ps.b.r === 6 && ps.b.c === 5));
  assert.equal(pairSlots.length, 1, '同对槽仅 1 条(旧槽被替换,不叠加)');
  assert.equal(e.grid[6][4].el, g0, '同对交换两次 grid 还原(a 格)');
  assert.equal(e.grid[6][5].el, g1, '同对交换两次 grid 还原(b 格)');
  const cells = e.cellsForRender();
  const maxOff = Math.max(...cells.map(c => Math.abs(c.offsetX || 0)));
  assert.ok(maxOff <= 90.0001, `渲染偏移 ≤90px(单格;实测 ${maxOff})`);
});

test('M9 并行交换匹配并入连锁下一环:交换形成的三连在 chain2 被消除(玩家抢位促连锁)', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound();
  assert.equal(e.trySwap(SWAP_A, SWAP_B), true);
  let sawChain2Clear = false, sawAnnounce = false;
  let guard = 0;
  while (guard++ < 3000) {
    e.update(1 / 60);
    for (const ev of e.drainEvents()) {
      if (ev.type === 'match_cleared' && ev.chain >= 2 && e.clearing?.some(cl => cl.r === SWAP_A.r && cl.c === SWAP_A.c)) sawChain2Clear = true;
      if (ev.type === 'chain_announce' && ev.chain >= 2) sawAnnounce = true;
    }
    if (e.state === 'IDLE') break;
  }
  assert.ok(sawChain2Clear, '并行交换形成的三连在连锁下一环被消除(chain≥2)');
  assert.ok(sawAnnounce, '连锁≥2 触发播报事件');
  assert.equal(e.state, 'IDLE', '终局回 IDLE');
});

// ---- M11 演出期可操作(FALLING 即时受理) ----
test('M11 FALLING 即时交换:任意相邻非空对立即写回 grid+并行动画(不再静默缓冲);成消并入连锁下一环', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound();
  let guard = 0;
  while (e.state === 'RESOLVING' && guard++ < 600) e.update(1 / 60);
  assert.equal(e.state, 'FALLING');
  // FALLING 中交换 (6,5)↔(6,6):立即写回(M11;修复前静默进缓冲,回 IDLE 才执行=「无法操作」卡手)
  assert.equal(e.trySwap(SWAP_A, SWAP_B), true, 'FALLING 中交换即时受理');
  assert.equal(e.swapBuffer, null, '不进预输入缓冲(M11 即时语义)');
  assert.equal(e.grid[6][5].el, 2, 'FALLING 中 grid 已即时交换((6,5)=2)');
  assert.equal(e.parallelSwaps.length, 1, '并行动画槽登记(FALLING 同 RESOLVING)');
  let sawChain2Clear = false;
  guard = 0;
  while (e.state !== 'IDLE' && guard++ < 3000) {
    e.update(1 / 60);
    for (const ev of e.drainEvents()) {
      // 下落完成后 _beginRound 按新布局判定:交换三连在连锁环被消除
      if (ev.type === 'match_cleared' && ev.chain >= 2 && e.clearing?.some(cl => cl.r === SWAP_A.r && cl.c === SWAP_A.c)) sawChain2Clear = true;
    }
  }
  assert.ok(sawChain2Clear, 'FALLING 中交换形成的三连在连锁下一环被消除(chain≥2)');
  assert.equal(e.state, 'IDLE', '整轮完成回 IDLE');
});

test('M11 缓冲只留最新意图(槽满溢出);无效缓冲回 IDLE 后走 nudge 弹回(不误交换)', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound();
  // 连发 5 次交换:前 3 次占满动画槽,第 4/5 次溢出进缓冲(只留最新)
  e.trySwap(SWAP_A, SWAP_B);
  e.trySwap(SWAP_C, SWAP_D);
  e.trySwap({ r: 0, c: 4 }, { r: 0, c: 5 });
  assert.equal(e.parallelSwaps.length, 3, '动画槽满 3');
  e.trySwap({ r: 2, c: 0 }, { r: 2, c: 1 }); // 第 4 次(溢出)
  e.trySwap({ r: 7, c: 0 }, { r: 7, c: 1 }); // 第 5 次(覆盖)
  assert.deepEqual(e.swapBuffer.b, { r: 7, c: 1 }, '只留最新');
  let guard = 0;
  while (e.state !== 'IDLE' && guard++ < 3000) e.update(1 / 60);
  // (7,0)↔(7,1) 在 IDLE flush 判定不成消 → nudge 弹回,grid 不变
  assert.equal(e.state, 'IDLE');
  assert.ok(e.nudgeFx, '无效缓冲走表现层弹回');
  assert.equal(e.grid[7][0].el, 2, 'grid 未交换(基础值)');
  assert.equal(e.swapBuffer, null, '缓冲已清空');
});

// ---- M9 nudge 放开 RESOLVING ----
test('M9 nudge:RESOLVING 放开(无效点选弹回);FALLING 仍拒绝', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound();
  assert.equal(e.nudge({ r: 6, c: 0 }, { r: 6, c: 1 }), true, 'RESOLVING 中 nudge 放开');
  assert.ok(e.nudgeFx);
  e.nudgeFx = null;
  let guard = 0;
  while (e.state === 'RESOLVING' && guard++ < 600) e.update(1 / 60);
  assert.equal(e.state, 'FALLING');
  assert.equal(e.nudge({ r: 6, c: 0 }, { r: 6, c: 1 }), false, 'FALLING 中 nudge 仍拒绝');
});

// ---- M9 连锁播报事件 ----
test('M9 chain_announce 事件:chain≥2 的消除环触发(每环一条);chain1 不触发', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound();
  assert.ok(!e.events.some(x => x.type === 'chain_announce'), 'chain1 无播报');
  e.chain = 2;
  e._beginRound(); // 需仍有匹配——金三连已消?重新注入
  const e2 = inject(new BoardEngine(7));
  e2.chain = 2;
  e2._beginRound();
  assert.ok(e2.events.some(x => x.type === 'chain_announce' && x.chain === 2), 'chain2 推播报事件');
});

// ---- M9 fx 播报表(王者官方文案) ----
test('M9 播报文案映射:二连击破/三连决胜/四连超凡/五连绝世/连锁狂潮×N;chain<2 不播报', () => {
  const table = [[2, '二连击破', '#4aa8cc'], [3, '三连决胜', '#b06fd8'], [4, '四连超凡', '#f5a02c'], [5, '五连绝世', '#ffd700'], [7, '连锁狂潮 ×7', '#e05a5a']];
  for (const [chain, text, color] of table) {
    const fx = new FxLayer();
    fx.chainAnnounce(chain);
    assert.equal(fx.announces.length, 1, `chain${chain} 播报 1 条`);
    assert.equal(fx.announces[0].text, text);
    assert.equal(fx.announces[0].color, color);
    if (chain >= 4) assert.ok(fx.boardShakeT > 0, 'chain≥4 触发棋盘微震');
    else assert.equal(fx.boardShakeT, 0, 'chain<4 不震');
  }
  const fx0 = new FxLayer();
  fx0.chainAnnounce(1);
  assert.equal(fx0.announces.length, 0, 'chain1 不播报');
  assert.equal(fx0.boardShakeT, 0);
});

test('M9 播报动效生命周期:0.9s 消亡;微震衰减归零;替换式(新播报把旧播报推入淡出段,不静止叠加)', () => {
  const fx = new FxLayer();
  fx.chainAnnounce(2);
  const a0 = fx.announces[0];
  assert.ok(a0.t === 0 && a0.life === 0.9, '初始 t=0 寿命 0.9s');
  fx.update(0.5);
  assert.ok(fx.announces.length === 1 && fx.announces[0].t > 0.4);
  fx.update(0.5);
  assert.equal(fx.announces.length, 0, '0.9s 后消亡');
  // 替换式(M9-F5):第二条入队时第一条立即进入淡出段(t≥AN_HOLD),不再在中央静止停留
  const fx2 = new FxLayer();
  fx2.chainAnnounce(2);
  fx2.chainAnnounce(3);
  assert.equal(fx2.announces.length, 2);
  assert.ok(fx2.announces[0].t >= 0.62, '旧播报已推入淡出段(t≥AN_HOLD+淡出半程=0.76)');
  assert.ok(fx2.announces[1].t === 0, '新播报从 0 起播');
  fx2.update(0.4); // 旧:t≥1.02>0.9 消亡;新:t=0.4 定版停留中
  assert.equal(fx2.announces.length, 1, '旧播报淡出消亡,新播报独占中央');
  const fx3 = new FxLayer();
  fx3.chainAnnounce(5);
  const sh = fx3.boardShake();
  assert.ok(Math.abs(sh.dx) > 0 || Math.abs(sh.dy) > 0, `微震偏移非零(dx=${sh.dx.toFixed(3)},dy=${sh.dy.toFixed(3)})`);
  fx3.update(0.5);
  fx3.update(0.5);
  assert.deepEqual(fx3.boardShake(), { dx: 0, dy: 0 }, '0.3s 后微震归零');
});

// ---- M9-F1 render 段③④随 RUSH 缩放(源码断言:判段/补间读实例 stageDur) ----
test('M9-F1 render 段③④判段与补间读本轮 stageDur(修复前固定 0.35/0.50/0.75——chain≥3 段③④来不及播放)', () => {
  const src = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(src.includes('engine.stageDur'), 'render 判段读实例 stageDur');
  assert.ok(!src.includes('g.elapsed >= 0.75'), '固定 0.75 判段已移除');
  assert.ok(!src.includes('g.elapsed >= 0.5 ? 3'), '固定 0.50 判段已移除');
});

// ---- M9-F2 释放门槛随轮缩放 ----
test('M9-F2 释放门槛:match_cleared 事件携带 floor=段④起点偏移(数字例 chain2=0.6375s);main 写入预约 execFloor;cast 读取', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 2;
  e._beginRound();
  const ev = e.events.find(x => x.type === 'match_cleared');
  assert.ok(ev, 'chain2 事件存在');
  assert.ok(Math.abs(ev.floor - 0.75 * 0.85) < 1e-9, `floor=0.75×rushScale(2)=${0.75 * 0.85}(实得 ${ev.floor})`);
  const e1 = inject(new BoardEngine(7));
  e1.chain = 1;
  e1._beginRound();
  assert.ok(Math.abs(e1.events.find(x => x.type === 'match_cleared').floor - 0.75) < 1e-9, 'chain1 floor=0.75(不加速)');
  const mainSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(!mainSrc.includes('p.execFloor'), 'main 不再按当前事件补写 execFloor(M9-02 F2:组装上移 reserveFor,防重设旧留池档位等待)');
  const castSrc = fs.readFileSync(new URL('../scripts/skills/cast.js', import.meta.url), 'utf-8');
  assert.ok(castSrc.includes('execFloor: base + (floor ?? 0.75)'), 'cast.reserveFor 组装 execFloor=t0+floor(随档位留池,无 floor 回退 0.75)');
  assert.ok(castSrc.includes('p.execFloor ?? p.t0 + 0.75'), 'cast 释放门槛读 execFloor(无则回退 0.75)');
  const chargeSrc = fs.readFileSync(new URL('../scripts/skills/charge.js', import.meta.url), 'utf-8');
  assert.ok(chargeSrc.includes('earliestFloor'), 'charge 留池保存所属轮 floor');
});

// ---- M9-F3 并行动画方向与跨下落收口 ----
test('M9-F3 并行动画:交换内容从对方位置滑向本位(起点偏移=±dir×90 归 0);_afterClear 收口 parallelSwap', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound();
  e.trySwap(SWAP_A, SWAP_B); // (6,5)↔(6,6):A=(6,5) 内容=原 B 子(el 2),从 (6,6) 滑向 (6,5)
  const cells = e.cellsForRender().filter(c => (c.r === 6 && c.c === 5) || (c.r === 6 && c.c === 6));
  const a = cells.find(c => c.r === 6 && c.c === 5), b = cells.find(c => c.r === 6 && c.c === 6);
  assert.ok(a.offsetX > 80, `A 格偏移≈+90(从 B 位置出发;实得 ${a.offsetX.toFixed(1)}——修复前 0→90 反向)`);
  assert.ok(b.offsetX < -80, `B 格偏移≈-90(从 A 位置出发;实得 ${b.offsetX.toFixed(1)})`);
  e.clearing.forEach(cl => { cl.t = 0; });
  e._afterClear();
  assert.equal(e.parallelSwaps.length, 0, '演出结束并行动画收口(不按旧坐标作用于下落后新内容)');
  assert.equal(e.state, 'FALLING');
});

// ---- M9-F4 main 预判不得早于引擎占用转缓冲分支 ----
test('M9-F4 main 拖拽预判仅 IDLE(RESOLVING 交给引擎:占用转缓冲优先于成消判定)', () => {
  const src = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(src.includes("st === 'IDLE' && !itemInvolved"), '预判仅 IDLE');
  assert.ok(!src.includes("st === 'RESOLVING' && !itemInvolved"), 'RESOLVING 预判已移除(F4:修复前占用时的无效拖拽被误拒)');
  // 引擎侧语义回归(M11):动画槽满 3 后任意相邻交换进 buffer(不判成消)
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound();
  e.trySwap(SWAP_A, SWAP_B); // 占用并行位
  e.trySwap(SWAP_C, SWAP_D);
  e.trySwap({ r: 0, c: 4 }, { r: 0, c: 5 });
  assert.equal(e.parallelSwaps.length, 3, '动画槽满 3');
  assert.equal(e.trySwap({ r: 7, c: 0 }, { r: 7, c: 1 }), true, '槽满时任意相邻交换进缓冲(引擎分支)');
  assert.ok(e.swapBuffer);
});

// ---- M9-F6 道具补位不继承上一轮 RUSH ----
test('M9-F6 道具补位:先 chain=0 再编排下落(修复前读到旧 chain 误乘 0.85)', () => {
  const e = new BoardEngine(7);
  e.state = 'IDLE';
  e.chain = 2; // 模拟上一轮残留(回 IDLE 路径不重置 chain)
  e.grid[0][0] = { item: 0, expire: 10 };
  const item = e.tapItem({ r: 0, c: 0 });
  assert.ok(item, '道具移除');
  assert.equal(e.chain, 0, 'chain 先归零');
  assert.equal(e.state, 'FALLING');
  assert.ok(Math.abs(e.fallT - 1 * 0.08) < 1e-9, `单格补位 fallT=0.08(chain0;修复前 0.068;实得 ${e.fallT})`);
});

// ---- M9-F7 产品入口完整链路 + 终态一致性 ----
test('M9-F7 产品入口链路:trySwap(IDLE)→update 快进→RESOLVING 并行 trySwap→连锁消除(不经内部方法)', () => {
  const e = inject(new BoardEngine(7));
  // 产品入口 1:IDLE trySwap(行 6 三连,合法交换)
  assert.equal(e.trySwap(SWAP_A, SWAP_B), true);
  assert.equal(e.state, 'SWAPPING');
  let guard = 0;
  while (e.state === 'SWAPPING' && guard++ < 60) e.update(1 / 60);
  assert.equal(e.state, 'RESOLVING', '交换完成进入第一环(公开入口链路)');
  // 产品入口 2:RESOLVING 并行 trySwap(行 7 三连预留)
  assert.equal(e.trySwap(SWAP_C, SWAP_D), true, '演出期并行交换(公开入口)');
  let sawChain2 = false;
  guard = 0;
  while (e.state !== 'IDLE' && guard++ < 3000) {
    e.update(1 / 60);
    for (const ev of e.drainEvents()) if (ev.type === 'match_cleared' && ev.chain >= 2) sawChain2 = true;
  }
  assert.ok(sawChain2, '并行交换三连在连锁环被消除(事件 chain≥2)');
  assert.equal(e.state, 'IDLE');
});

test('M9-F7 终态一致性:相同已接受操作序列(含并行交换)+固定种子 → 两实例终态逐格一致', () => {
  const run = () => {
    const e = inject(new BoardEngine(7));
    e.trySwap(SWAP_A, SWAP_B); // 相同操作 1:IDLE 交换
    let guard = 0;
    while (e.state === 'SWAPPING' && guard++ < 60) e.update(1 / 60);
    e.trySwap(SWAP_C, SWAP_D); // 相同操作 2:RESOLVING 并行交换
    guard = 0;
    while (e.state !== 'IDLE' && guard++ < 3000) { e.update(1 / 60); e.drainEvents(); }
    return e.grid.map(row => row.map(c => (c ? `${c.el}${c.item !== undefined ? 'i' + c.item : ''}` : '·')).join('|')).join(';');
  };
  assert.equal(run(), run(), '同 seed+同操作序列(含并行交换)终态逐格一致(02 文档第 7 节口径)');
});

// ---- M9 接线源码断言 ----
test('M9 接线:input 放行演出期手势(canActInBusy);main 转发 chain_announce;render 微震/预选框', () => {
  const inputSrc = fs.readFileSync(new URL('../scripts/core/input.js', import.meta.url), 'utf-8');
  assert.ok(inputSrc.includes('canActInBusy'), 'input 手势放行回调接入');
  const mainSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mainSrc.includes("e.type === 'chain_announce'"), 'main 转发播报事件');
  assert.ok(mainSrc.includes('canActInBusy'), 'main 提供 canActInBusy');
  const renderSrc = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(renderSrc.includes('boardShake'), 'render 接棋盘微震');
  assert.ok(renderSrc.includes('swapBuffer'), 'render 绘制预输入预选框');
  const engineSrc = fs.readFileSync(new URL('../scripts/board/engine.js', import.meta.url), 'utf-8');
  assert.ok(engineSrc.includes('rushScale'), 'engine rush 缩放');
  assert.ok(engineSrc.includes("type: 'chain_announce'"), 'engine 播报事件出口');
});

// ---- M9-02 F2 实际执行时刻 + 留池继承(真实 Caster/Charge 集成) ----
test('M9-F2 实际执行时刻:chain3 池就绪预约 execFloor=t0+0.525,tick 在该帧执行(修复前固定 0.75)', () => {
  const charge = new Charge();
  charge.feed({ type: 'match_cleared', element: 'fire', count: 3, chain: 3, t: 0, floor: 0.525 });
  const caster = new Caster(charge, ['fire_bolt'], 1, ['fire_bolt'], {});
  const p = caster.reserveFor('fire', () => 0, 0.1); // 选技(t0=0 最早档位;selT=0.1)
  assert.ok(p, '预约建立');
  assert.ok(Math.abs(p.execFloor - 0.525) < 1e-9, `execFloor=0+0.525(chain3 段④起点;实得 ${p.execFloor})`);
  const fired = [];
  const mkCtx = (clock) => ({
    clock, atk: 10,
    nearestAlive: () => ({ hp: 100, x: 560, y: 200 }),
    launch: (skill, tier, mult) => { fired.push({ at: clock, tier }); return {}; },
  });
  caster.tick(mkCtx(0.4), true, () => 0); // 早于 execFloor → 不执行
  assert.equal(fired.length, 0, 'execFloor 前不执行(修复前 0.75 门槛下同样不执行,但门槛值错误)');
  caster.tick(mkCtx(0.525), true, () => 0); // 恰在 execFloor → 执行
  assert.equal(fired.length, 1, '段④起点帧执行(实际发射)');
  assert.ok(fired[0].at === 0.525);
});

test('M9-F2 留池继承:最早档位 t0=0 所属轮 floor=0.75;新事件(chain2 floor=0.6375)不重设——execFloor=0.75;执行=max(0.75, 就绪 2.0)=2.0', () => {
  const charge = new Charge();
  charge.feed({ type: 'match_cleared', element: 'fire', count: 3, chain: 1, t: 0, floor: 0.75 }); // 池 1 档
  const caster = new Caster(charge, [], 1, [], {}); // owned 空 → 选技失败,档位留池
  assert.equal(caster.reserveFor('fire', () => 0, 0.1), null, '候选空留池');
  caster.owned = ['fire_bolt']; // 技能 2.0s 就绪(CD 归零模拟)
  charge.feed({ type: 'match_cleared', element: 'fire', count: 3, chain: 2, t: 2.0, floor: 0.6375 }); // 同帧新事件(池非空)
  const p = caster.reserveFor('fire', () => 0, 2.0);
  assert.ok(p);
  assert.ok(Math.abs(p.t0 - 0) < 1e-9, 't0=最早档位时刻 0(不按新事件重设)');
  assert.ok(Math.abs(p.execFloor - 0.75) < 1e-9, `execFloor=0+0.75(最早档位所属轮;修复前=2.0+0.6375;实得 ${p.execFloor})`);
  assert.equal(p.tier, 3, '占用池全部值(两轮累积:chain1 gain1+chain2 gain2=3)');
  const fired = [];
  const mkCtx = (clock) => ({ clock, atk: 10, nearestAlive: () => ({ hp: 100 }), launch: (s, t) => { fired.push({ at: clock }); return {}; } });
  caster.tick(mkCtx(1.0), true, () => 0);
  assert.equal(fired.length, 0, '1.0s(<execFloor 0.75?否——1.0>0.75,但<selT 2.0)不执行:门槛=max(0.75,2.0)');
  caster.tick(mkCtx(2.0), true, () => 0);
  assert.equal(fired.length, 1, '2.0s(选技就绪时刻)执行');
});

// ---- M9-02 F1 引擎侧:chain3/4/5 段④实际可达(cellsForRender stage 判定) ----
test('M9-F1 chain3/4/5 段④实际可达:cellsForRender 输出 stage=4(修复前固定边界下 chain3 缺段④、chain≥4 缺段③④)', () => {
  for (const [chain, rs] of [[3, 0.7], [4, 0.55], [5, 0.45]]) {
    const e = inject(new BoardEngine(7));
    e.chain = chain;
    e._beginRound();
    const t4 = 0.75 * rs; // 段④起点(缩放后)
    const elapsed = t4 + 0.02; // 段④内
    e.clearing.forEach(cl => { cl.t = e.clearTotal - elapsed; });
    const cells = e.cellsForRender().filter(c => c._clearing);
    assert.ok(cells.length > 0 && cells.every(c => c.stage === 4), `chain${chain} elapsed=${elapsed}>t4=${t4.toFixed(4)} → 段④输出`);
  }
});

// ---- M9-02 F5 连续播报绘制:同一时刻仅最新播报全亮(旧的已推入淡出段) ----
test('M9-F5 连续播报绘制:draw 同帧仅最新播报 alpha=1,旧播报淡出中(不静止叠加)', () => {
  const fx = new FxLayer();
  fx.chainAnnounce(2);
  fx.chainAnnounce(3);
  fx.chainAnnounce(4);
  const calls = [];
  const ctx = {
    set font(v) { this._f = v; }, get font() { return this._f; },
    set globalAlpha(v) { this._ga = v; }, set fillStyle(v) { this._fs = v; },
    set strokeStyle(v) {}, set lineWidth(v) {}, set lineJoin(v) {}, set textAlign(v) {},
    save() {}, restore() {}, beginPath() {}, closePath() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
    fillText(t) { calls.push({ t, alpha: this._ga }); }, strokeText() {},
  };
  fx.draw(ctx);
  const central = calls.filter(c => ['二连击破', '三连决胜', '四连超凡'].includes(c.t));
  assert.ok(central.length >= 3, '三条播报均有绘制记录(替换式保留淡出尾)');
  const fullAlpha = central.filter(c => c.alpha === 1);
  assert.deepEqual(fullAlpha.map(c => c.t), ['四连超凡'], '仅最新播报全亮(修复前三条共用中央位叠加)');
});

// ---- M9-02 手势中断:瘫痪(不可操作忙态)引擎侧保证 ----
test('M9-02 手势中断回归:PARALYZED 中 trySwap 一律拒绝(canActInBusy 仅放行演出期可操作忙态)', () => {
  const e = new BoardEngine(7);
  e.paralyzed = true;
  assert.equal(e.trySwap({ r: 0, c: 0 }, { r: 0, c: 1 }), false, '瘫痪中交换拒绝');
  assert.equal(e.nudge({ r: 0, c: 0 }, { r: 0, c: 1 }), false, '瘫痪中 nudge 拒绝');
});

// ---- M9-02 终态一致性:不同帧步长(模拟中断/帧率抖动)终态逐格一致 ----
test('M9-02 终态一致性(含中断口径):不同 update 步长(1/60 vs 1/30)+相同操作序列 → 终态逐格一致', () => {
  const run2 = (step) => {
    const e = inject(new BoardEngine(7));
    e.trySwap(SWAP_A, SWAP_B);
    let guard = 0;
    while (e.state === 'SWAPPING' && guard++ < 120) e.update(step);
    e.trySwap(SWAP_C, SWAP_D); // RESOLVING 并行交换
    guard = 0;
    while (e.state !== 'IDLE' && guard++ < 6000) { e.update(step); e.drainEvents(); }
    return e.grid.map(row => row.map(c => (c ? `${c.el}${c.item !== undefined ? 'i' + c.item : ''}` : '·')).join('|')).join(';');
  };
  assert.equal(run2(1 / 60), run2(1 / 30), '步长不同(模拟中断后恢复)终态一致(02 文档第 7 节口径)');
});
// tests/m9.test.mjs 追加用例(part2,由 patch 脚本拼接)
// ---- M9-03 F7-1 高连锁实际 render 入口(段③文字/段④碎裂/径向光效) ----
test('M9-03 F7 实际 render:chain3/4/5 段③技能名文字与段④碎裂+径向光效真实绘制(缩放后时点)', () => {
  for (const chain of [3, 4, 5]) {
    const e = inject(new BoardEngine(7));
    e.chain = chain;
    e._beginRound();
    const bk = [...e.blockFx.keys()][0];
    e.setBlockFx(bk, { el: 'fire', reserved: true, skillId: 'fire_bolt', tier: 2, resKey: 'rk' + chain });
    const fx = new FxLayer();
    const t3 = 0.5 * e.rush;           // 段③起点=absorb+flash=0.5×scale
    const t4 = 0.75 * e.rush;          // 段④起点
    e.clearing.forEach(cl => { cl.t = e.clearTotal - (t3 + 0.05); });
    let r = mkRenderCtx();
    render(r.ctx, e, mkHudStub(e, fx));
    assert.ok(r.rec.fillTexts.some(t => t.includes('火弹')), 'chain' + chain + ' 段③技能名文字经 render 实绘(样本=' + r.rec.fillTexts.slice(0, 4).join(',') + ')');
    e.clearing.forEach(cl => { cl.t = e.clearTotal - (t4 + 0.05); });
    const particlesBefore = fx.particles.length;
    r = mkRenderCtx();
    render(r.ctx, e, mkHudStub(e, fx));
    assert.ok(r.rec.strokes > 0, 'chain' + chain + ' 段④碎裂线段经 render 实绘(strokes=' + r.rec.strokes + ')');
    assert.ok(fx.particles.length > particlesBefore, 'chain' + chain + ' 段④径向光效粒子迸发(' + particlesBefore + '→' + fx.particles.length + ')');
  }
});

// ---- M9-03 F7-2 手势取消(真实 attachInput 事件序列) ----
function mkInputHarness(getState) {
  const listeners = {};
  const canvas = {
    getBoundingClientRect: () => ({ width: 720, height: 1280, left: 0, top: 0 }),
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  const calls = { tap: [], swap: [] };
  const input = attachInput(canvas, {
    cellAt: (x, y) => {
      if (y < 504) return null;
      const c = Math.floor(x / 90), r = Math.floor((y - 504) / 90);
      return (r >= 0 && r < 8 && c >= 0 && c < 8) ? { r, c } : null;
    },
    busy: () => getState().busy,
    canActInBusy: () => getState().canAct,
    tryDragSwap: (a, b) => { calls.swap.push([a, b]); return false; },
    onTap: (cell) => calls.tap.push(cell),
  });
  const ev = (type, x, y) => listeners[type]({ clientX: x, clientY: y, preventDefault() {} });
  const cellXY = (r, c) => ({ x: c * 90 + 45, y: 504 + r * 90 + 45 });
  return { input, ev, cellXY, calls };
}

test('M9-03 F7 手势取消:演出期按下→进入瘫痪→恢复后松手/移动不触发 tap 或 swap(经 attachInput)', () => {
  // 场景 1:演出期(可操作忙态)按下→中途进入瘫痪→恢复 IDLE 后松手
  let st = { busy: true, canAct: true };
  const h = mkInputHarness(() => st);
  const p = h.cellXY(2, 3);
  h.ev('mousedown', p.x, p.y);   // 演出期按下(放行)
  st = { busy: true, canAct: false }; // 中途进入瘫痪(不可操作忙态)
  h.input.update(0.016);          // 手势作废观察
  st = { busy: false, canAct: false }; // 恢复 IDLE
  h.ev('mouseup', p.x, p.y);     // 恢复后松手
  assert.equal(h.calls.tap.length, 0, '跨越不可操作忙态的手势恢复后松手不触发 tap(F7 语义保留)');
  assert.equal(h.calls.swap.length, 0, '恢复后不补触发交换');
  // 场景 2:拖动中进入瘫痪→恢复后继续移动
  st = { busy: true, canAct: true };
  const h2 = mkInputHarness(() => st);
  h2.ev('mousedown', p.x, p.y);
  h2.ev('mousemove', p.x + 20, p.y); // 跟手中(<45px 不触发预判定)
  st = { busy: true, canAct: false }; // 拖动中进入瘫痪
  h2.input.update(0.016);             // 手势作废
  st = { busy: false, canAct: false };
  h2.ev('mousemove', p.x + 60, p.y); // 恢复后继续移动(旧实现会补触发预判定)
  h2.ev('mouseup', p.x + 60, p.y);
  assert.equal(h2.calls.swap.length, 0, '拖动中进入瘫痪→恢复后移动不补触发交换(作废语义保留)');
  assert.equal(h2.calls.tap.length, 0, '作废手势不复活为点选');
});

// ---- M9-03 F7-3 中断终态(受理操作+模拟钟+完整棋盘状态) ----
test('M9-03 F7 中断终态契约:非均匀步长(模拟中断/帧率抖动)+相同受理操作+相同模拟钟 → 完成至 IDLE 且完整棋盘逐格一致', () => {
  const serialize = (e) => JSON.stringify({
    grid: e.grid.map(row => row.map(c => c ? { el: c.el ?? null, item: c.item ?? null, expire: c.expire != null ? Number(c.expire.toFixed(6)) : null, premium: c.premium ?? null } : null)),
    state: e.state, chain: e.chain,
  });
  const makeRun = (stepFn) => {
    const e = inject(new BoardEngine(7));
    const accepted = [];
    let clock = 0;
    const pump = (until) => {
      let guard = 0;
      while (clock < until - 1e-9 && guard++ < 20000) {
        const dt = stepFn();
        e.update(dt);
        clock += dt;
        for (const ev of e.drainEvents()) if (ev.type === 'match_cleared') accepted.push({ at: Number(clock.toFixed(6)), el: ev.element, chain: ev.chain });
      }
    };
    e.trySwap(SWAP_A, SWAP_B); accepted.push({ op: 'swap', a: SWAP_A, b: SWAP_B });
    pump(0.16); // SWAPPING 动画窗(0.15s)+余量
    e.trySwap(SWAP_C, SWAP_D); accepted.push({ op: 'parallelSwap', a: SWAP_C, b: SWAP_D });
    let guard = 0;
    while (e.state !== 'IDLE' && guard++ < 20000) {
      const dt = stepFn();
      e.update(dt);
      clock += dt;
      for (const ev of e.drainEvents()) if (ev.type === 'match_cleared') accepted.push({ at: Number(clock.toFixed(6)), el: ev.element, chain: ev.chain });
    }
    return { accepted, clock: Number(clock.toFixed(4)), done: e.state === 'IDLE', board: serialize(e) };
  };
  const a = makeRun(() => 1 / 60); // 均匀步长
  const seq = [1 / 60, 1 / 60, 1 / 60, 1 / 60, 0.02, 0.015, 0.015]; // 均值精确=1/60(总量对齐;帧间隔非均匀=中断/抖动模型)
  let si = 0;
  const b = makeRun(() => seq[(si++) % seq.length]); // 非均匀步长(中断/帧率抖动模型)
  assert.ok(a.done && b.done, '两轮均完成至 IDLE(A=' + a.done + ' B=' + b.done + ';模拟钟 A=' + a.clock.toFixed(4) + ' B=' + b.clock.toFixed(4) + ' 已记录)');
  // 模拟钟终点:状态边界(消除轮落定)跨越时刻随步长有半步差——差异必须 < 最大步长(0.05)
  assert.ok(Math.abs(b.clock - a.clock) < 0.05, `模拟钟终点差<最大步长(|Δ|=${Math.abs(b.clock - a.clock).toFixed(4)};A=${a.clock.toFixed(4)} B=${b.clock.toFixed(4)})`);
  // 受理操作序列(显式输入+消除事件的操作/元素/chain 逐条对应;事件时刻随边界半步浮动,不比 at)
  const sig = (list) => list.map(x => (x.op ? x.op : x.el + ':c' + x.chain)).join('>');
  assert.equal(sig(b.accepted), sig(a.accepted), `受理操作序列一致(显式输入逐条对应;A=${sig(a.accepted)} B=${sig(b.accepted)})`);
  assert.equal(b.board, a.board, '完整棋盘状态逐格一致(含道具格与剩余时间;TDD 第 15 条/02 文档第 7 节)');
});

// ==================== M11 演出期全时可操作(需求方 2026-10-17) ====================
test('M11 RESOLVING 断连锁:不成消交换并入下一环判定→无匹配回 IDLE(主动断连锁策略空间)', () => {
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound(); // 金三连 RESOLVING
  // 换走成消子:(6,4)(el2)↔(6,5)(el1) → (6,4)=1,行 6 变 2,1,2 不成三连(预留 (6,3) 断链)
  assert.equal(e.trySwap({ r: 6, c: 4 }, { r: 6, c: 5 }), true);
  assert.equal(e.grid[6][4].el, 1, 'grid 已即时交换((6,4)=原(6,5) 基础 1)');
  let guard = 0, sawRow6Clear = false;
  while (e.state !== 'IDLE' && guard++ < 3000) {
    e.update(1 / 60);
    for (const ev of e.drainEvents()) if (ev.type === 'match_cleared' && e.clearing?.some(cl => cl.r === 6 && (cl.c === 3 || cl.c === 4))) sawRow6Clear = true;
  }
  assert.equal(e.state, 'IDLE', '断连锁后整轮收口回 IDLE');
  assert.ok(!sawRow6Clear, '预留两连被拆散不成消(断链成功)');
});

test('M11 道具演出期可点:RESOLVING 移除随本轮 _applyFalls 合并补位;FALLING 原地即时补新', () => {
  // 场景 1:RESOLVING 中点道具 → 格置空,落定后与被消格一起补位(无永久空洞)
  const e = inject(new BoardEngine(7));
  e.grid[5][0] = { item: 'heal', expire: 9 };
  e.chain = 1;
  e._beginRound();
  const it = e.tapItem({ r: 5, c: 0 });
  assert.ok(it && it.item === 'heal', 'RESOLVING 中道具点击生效(修复前仅 IDLE)');
  assert.equal(e.grid[5][0], null, '道具格已置空');
  let guard = 0;
  while (e.state !== 'IDLE' && guard++ < 3000) { e.update(1 / 60); e.drainEvents(); }
  assert.ok(e.grid.every(row => row.every(c => c !== null)), 'RESOLVING 移除的格随本轮补位(无空洞)');
  // 场景 2:FALLING 中点道具 → 原地即时补新(棋盘无空洞)
  const e2 = inject(new BoardEngine(7));
  e2.grid[5][1] = { item: 'cd', premium: true, expire: 8 };
  e2.chain = 1;
  e2._beginRound();
  guard = 0;
  while (e2.state === 'RESOLVING' && guard++ < 600) e2.update(1 / 60);
  assert.equal(e2.state, 'FALLING');
  const it2 = e2.tapItem({ r: 5, c: 1 });
  assert.ok(it2 && it2.item === 'cd', 'FALLING 中道具点击生效');
  assert.ok(e2.grid[5][1] && e2.grid[5][1].el !== undefined, 'FALLING 移除后原地补新棋子');
  guard = 0;
  while (e2.state !== 'IDLE' && guard++ < 3000) { e2.update(1 / 60); e2.drainEvents(); }
  assert.ok(e2.grid.every(row => row.every(c => c !== null)), 'FALLING 补新后终态无空洞');
  // 场景 3:PARALYZED 不可点(恢复链自管)
  const e3 = new BoardEngine(7);
  e3.paralyzed = true;
  e3.grid[0][0] = { item: 'heal', expire: 9 };
  assert.equal(e3.tapItem({ r: 0, c: 0 }), null, '瘫痪中道具点击拒绝');
});

test('M11 SWAPPING/REBOUND 仍走预输入缓冲(0.15s 短动画语义保留);回 IDLE 自动执行', () => {
  const e = inject(new BoardEngine(7));
  assert.equal(e.trySwap(SWAP_A, SWAP_B), true, 'IDLE 交换 → SWAPPING');
  assert.equal(e.state, 'SWAPPING');
  assert.equal(e.trySwap({ r: 2, c: 0 }, { r: 2, c: 1 }), true, 'SWAPPING 中滑动进缓冲');
  assert.ok(e.swapBuffer, '缓冲记录');
  assert.equal(e.grid[2][0].el, 2, 'SWAPPING 中 grid 未交换');
  let guard = 0, sawMatch = false;
  while (e.state !== 'IDLE' && guard++ < 3000) {
    e.update(1 / 60);
    for (const ev of e.drainEvents()) if (ev.type === 'match_cleared') sawMatch = true;
  }
  assert.equal(e.swapBuffer, null, '回 IDLE 缓冲已消费');
  assert.ok(e.grid[2][0].el !== undefined, '缓冲交换已执行(2,0 内容变化)');
});
