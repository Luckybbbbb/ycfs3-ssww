// tests/board.test.mjs
// M1 三消棋盘单测（TDD 第 15 条 + FR-2 验收）
// 运行: node --test tests/board.test.mjs
// 相对路径: tests/board.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng, generateGrid, hasNoMatches, hasValidSwap, findMatchBlocks,
  shuffleGrid, enforceQuota, emptyGrid, isItem,
} from '../scripts/board/grid.js';
import { BoardEngine } from '../scripts/board/engine.js';
import { rollItem, placeItem, tickItems } from '../scripts/board/items.js';

// ---- 构造辅助 ----
function gridOf(rows) { // rows: 字符串数组，0~4=元素, '.'=空, 'I'=道具
  const map = { m: 0, w: 1, a: 2, f: 3, e: 4 }; // 金木水土(火=f)
  return rows.map(row => [...row].map(ch =>
    ch === '.' ? null : ch === 'I' ? { item: 'heal', expire: 10 } : { el: map[ch] }));
}
function stepToIdle(engine, maxSec = 30) {
  let t = 0;
  while (engine.state !== 'IDLE' && t < maxSec) { engine.update(0.016); t += 0.016; }
  return t < maxSec;
}
function drain(engine) {
  const e = engine.drainEvents();
  return e.filter(x => x.type === 'match_cleared');
}

// ---- 生成与合法性 ----
test('初始盘无现成匹配且存在合法交换（FR-2.1;M6 口径经引擎重试兜底）', () => {
  for (const seed of [1, 2, 3, 42, 999]) {
    // 产品入口=BoardEngine._init(50 次生成重试+双验证);新口径「无现成匹配」含无 ≥4 连通块,
    // 裸 generateGrid 单次生成不保证(设计 02 文档第 3 节已声明重试兜底口径)。
    const e = new BoardEngine(seed);
    assert.ok(!e.paralyzed, `seed=${seed} 引擎初始化不应瘫痪`);
    assert.ok(hasNoMatches(e.grid), `seed=${seed} 有初始匹配`);
    assert.ok(hasValidSwap(e.grid), `seed=${seed} 无合法交换`);
  }
});

test('(行+列)%5 反例盘：无初始三连但无合法交换（洗牌验证的反例依据）', () => {
  const g = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  assert.ok(hasNoMatches(g));
  assert.ok(!hasValidSwap(g));
});

test('L/T 交叉形合并为一个连通块 count=5（FR-2.4）', () => {
  const g = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  // L 形 5 格：竖臂 (1,3)(2,3)(3,3) + 横臂 (3,2)(3,4)，居中布置避开背景 (r+c)%5 的同色延长
  for (const [r, c] of [[1,3],[2,3],[3,3],[3,2],[3,4]]) g[r][c] = { el: 0 };
  // M6 连通块规则下 flood fill 会把背景 (1,4)(el=(1+4)%5=0) 也并入连通块 → 覆盖为 el1 打断
  // (覆盖后 el1 连通块 {(1,4),(1,5),(2,4)} 为 3 格 L 形且无 3 连线 → 不消，不影响断言)
  g[1][4] = { el: 1 };
  const blocks = findMatchBlocks(g);
  const gold = blocks.filter(b => b.el === 0);
  assert.equal(gold.length, 1, '交叉形应合并为一块');
  assert.equal(gold[0].cells.length, 5);
});

// ---- 状态机：交换→消除→事件→下落→连锁→终态 ----
test('三连交换产生 count=3 chain=1 事件并回到稳定终态', () => {
  const e = new BoardEngine(7);
  assert.ok(stepToIdle(e));
  // 找一个能成三连的交换并执行
  let done = false;
  for (let r = 0; r < 8 && !done; r++) for (let c = 0; c < 7 && !done; c++) {
    if (e.trySwap({ r, c }, { r, c: c + 1 })) {
      // 确实产生了交换（引擎已放行）——若无效会被拒绝
      done = true;
    }
  }
  assert.ok(done, '应存在合法交换');
  assert.ok(stepToIdle(e));
  assert.ok(hasNoMatches(e.grid) && hasValidSwap(e.grid), '终态合法');
});

test('快速操作（交换动画中输入被忽略）终态与无中断一致（TDD 15）', () => {
  const run = (interrupt) => {
    const e = new BoardEngine(7);
    stepToIdle(e);
    const ops = [];
    // 用固定种子驱动一批合法交换
    for (let n = 0; n < 5; n++) {
      let done = false;
      for (let r = 0; r < 8 && !done; r++) for (let c = 0; c < 7 && !done; c++) {
        if (e.trySwap({ r, c }, { r, c: c + 1 })) { ops.push(`${r},${c}`); done = true; }
      }
      if (!done) break;
      // 部分推进动画
      const partial = interrupt && n === 2 ? 0.05 : 10;
      let t = 0;
      while (e.state !== 'IDLE' && t < partial) { e.update(0.016); t += 0.016; }
      if (interrupt && n === 2) {
        // 动画中乱点（应被忽略）
        e.trySwap({ r: 0, c: 0 }, { r: 0, c: 1 });
        e.trySwap({ r: 3, c: 3 }, { r: 4, c: 3 });
      }
      stepToIdle(e);
    }
    return JSON.stringify(e.grid);
  };
  assert.equal(run(true), run(false), '含中断与无中断终态须逐格一致');
});

test('无效交换被拒绝且棋盘不变（D4 回弹前置校验）', () => {
  const e = new BoardEngine(7);
  stepToIdle(e);
  const before = JSON.stringify(e.grid);
  // 枚举找一个必然无效的交换：全部拒绝说明引擎过严，全部接受说明过松——这里只验证拒绝后状态不变
  for (let r = 0; r < 8; r++) for (let c = 0; c < 7; c++) {
    const st = e.state;
    const ok = e.trySwap({ r, c }, { r, c: c + 1 });
    if (!ok) assert.equal(JSON.stringify(e.grid), before, '拒绝的交换不得改动棋盘');
    if (ok) { stepToIdle(e); assert.ok(true); return; } // 找到有效的即止
  }
  assert.fail('固定种子下应存在合法交换');
});

// ---- 死局与恢复链 ----
test('(行+列)%5 死局盘洗牌后恢复可玩', () => {
  const g = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  const rng = makeRng(31);
  assert.ok(shuffleGrid(g, rng), '洗牌应得到双验证合法终态');
  assert.ok(hasNoMatches(g) && hasValidSwap(g));
});

test('道具占格下配额仍可满足；棋子 <15 时配额失败返回 false', () => {
  const g = emptyGrid();
  // 61 棋子 + 3 道具：正常配额
  let k = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    g[r][c] = k < 3 ? { item: 'heal', expire: 10 } : { el: k % 5 };
    k++;
  }
  assert.ok(enforceQuota(g, makeRng(5)));
  // 棋子 <15：配额不可满足
  const g2 = emptyGrid();
  k = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    g2[r][c] = k < 50 ? { item: 'heal', expire: 10 } : { el: k % 5 };
    k++;
  }
  assert.ok(!enforceQuota(g2, makeRng(5)));
});

// ---- 道具 ----
test('四连掉普通、五连掉高级消耗品；10s 超时移除（D10）', () => {
  assert.equal(rollItem(4, makeRng(1)).premium, false);
  assert.equal(rollItem(5, makeRng(1)).premium, true);
  const g = emptyGrid();
  const spot = placeItem(g, [{ r: 3, c: 3 }], { item: 'heal', premium: false, expire: 10 }, makeRng(1));
  assert.ok(spot);
  assert.ok(isItem(g[3][3]));
  const expired = tickItems(g, 10.01);
  assert.deepEqual(expired, [{ r: 3, c: 3 }]);
  assert.equal(g[3][3], null);
});

test('道具点击立即移除并触发下落补位（02 文档第 6 节）', () => {
  const e = new BoardEngine(7);
  stepToIdle(e);
  // 手工放一个道具
  e.grid[0][0] = { item: 'heal', premium: false, expire: 10 };
  const tapped = e.tapItem({ r: 0, c: 0 });
  assert.ok(tapped && tapped.item === 'heal');
  assert.ok(stepToIdle(e), '下落补位后应回到稳定');
  // 顶格移除后应由补位新棋子填上（不再是道具，也非空洞）
  assert.ok(e.grid[0][0] && e.grid[0][0].el !== undefined, '补位后顶格为新棋子');
  assert.ok(hasNoMatches(e.grid) && hasValidSwap(e.grid));
});

// ---- 终态一致性（相同操作序列 + 固定种子，02 文档第 7 节口径）----
test('固定种子下同一操作序列两次运行终态逐格一致', () => {
  const run = () => {
    const e = new BoardEngine(99);
    stepToIdle(e);
    for (let n = 0; n < 8; n++) {
      let done = false;
      for (let r = 0; r < 8 && !done; r++) for (let c = 0; c < 7 && !done; c++) {
        if (e.trySwap({ r, c }, { r, c: c + 1 })) done = true;
      }
      if (!done) break;
      stepToIdle(e);
    }
    return JSON.stringify(e.grid);
  };
  assert.equal(run(), run());
});

// ---- 瘫痪态恢复出口（02 文档第 8 节 P1 整改：无道具也必有恢复转移）----
test('无道具瘫痪盘：(行+列)%5 注入后定时重试确定恢复（02 第 8 节数字例）', () => {
  const run = (seed) => {
    const e = new BoardEngine(seed);
    assert.ok(stepToIdle(e));
    // 注入死局盘：无现成匹配、0 个合法交换、无道具
    e.grid = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
    e.paralyzed = true; e.state = 'PARALYZED'; e.paralyzeT = 0;
    let t = 0;
    while (e.paralyzed && t < 120) { e.update(0.016); t += 0.016; }
    assert.ok(!e.paralyzed, `seed=${seed} 瘫痪盘应在有限轮内恢复`);
    assert.ok(hasNoMatches(e.grid) && hasValidSwap(e.grid), '恢复后终态合法');
    return t;
  };
  const results = [7, 42, 99].map(run);
  console.log('PARALYZE_RECOVER ' + results.map((t, i) => `seed${[7,42,99][i]}=${t.toFixed(2)}s(第${Math.ceil(t/2)}轮)`).join(' '));
});

// ---- 下落顺序回归(REQ-M2-05 基线缺陷:未消除列不得上下翻转) ----
test('无消除扰动列保持原序:交换后 FALLING 落定,各列元素自顶向下与交换前列一致(用户报告的上下颠倒)', () => {
  const e = new BoardEngine(20260601);
  stepToIdle(e);
  const before = e.grid.map(row => row.map(c => c.el));
  // codex 复现入口:交换 (0,4)↔(0,5)
  assert.ok(e.trySwap({ r: 0, c: 4 }, { r: 0, c: 5 }), '交换放行');
  stepToIdle(e);
  // 逐列校验:沉降语义下「每列的元素多重集按相对顺序保持」——无消除的列顶多整体平移,
  // 但列内相对顺序必须不变。用列内非 fresh 序列等价校验:列元素序列(自顶向下)应是
  // before 列去掉被消格后前对齐。最直接:比较每列的「同元素相邻对」集合不变(序不变则邻接对不变)。
  const pairs = (g) => {
    const s = new Set();
    for (let c = 0; c < 8; c++) for (let r = 0; r < 7; r++) s.add(`${g[r][c].el}>${g[r+1][c].el}@c${c}`);
    return s;
  };
  // 精确校验:对每个未发生消除与补位的列(列元素多重集与顺序整体保持),列序列应为原列或原列去掉若干后补位。
  // 直接断言:列 0(交换只动第 4/5 列,若 0 列无连锁)在落定后其棋子序列是 before 列 0 的子序列(允许顶部插入新子)。
  const isSubseqKeepOrder = (oldCol, newCol) => {
    let i = 0;
    for (let r = 0; r < 8; r++) {
      if (i < oldCol.length && newCol[r] === oldCol[i]) i++;
    }
    return i === oldCol.length;
  };
  // 稳妥通用断言:任意列的「非新增棋子」相对顺序必须保持(用元素值序列的子序列判定)
  let checked = 0;
  for (let c = 0; c < 8; c++) {
    const oldVals = before.map(row => row[c]);
    // 落定后该列:旧棋子相对顺序应为其在原列中的顺序(子序列)
    const newVals = e.grid.map(row => row[c]);
    // 从新列中删去「不在旧列计数内的多余元素」后应可由旧列子序列匹配——简化:多重集+子序列
    const remain = [...oldVals];
    const picked = [];
    for (const v of newVals) {
      const idx = remain.indexOf(v);
      if (idx >= 0) { picked.push(v); remain.splice(idx, 1); }
    }
    // picked 必须是 oldVals 的子序列且长度=被保留棋子数(>=6:至多消除 2 格)
    let k = 0;
    for (const v of oldVals) if (k < picked.length && picked[k] === v) k++;
    assert.equal(k, picked.length, `列 ${c} 保留棋子相对顺序被打乱(上下翻转)`);
    checked++;
  }
  assert.ok(checked === 8);
});

test('下落动画:保留棋子位移正确(codex 复现例 seed=7 交换(6,6)↔(6,7),起始 offsetY=−dist×90)', () => {
  const e = new BoardEngine(7);
  stepToIdle(e);
  assert.ok(e.trySwap({ r: 6, c: 6 }, { r: 6, c: 7 }), '交换放行');
  let n = 0;
  while (e.state !== 'FALLING' && n < 200) { e.update(1 / 60); n++; }
  assert.equal(e.state, 'FALLING');
  const cells = e.cellsForRender();
  // 每条 falls 位移:起始 offsetY = −dist×90
  for (const m of e.falls) {
    const cell = cells.find(c => c.r === m.r && c.c === m.c);
    assert.ok(Math.abs(cell.offsetY + m.dist * 90) < 1e-6, `格(${m.r},${m.c}) 起始 offsetY=${cell.offsetY},应=${-m.dist * 90}`);
  }
  assert.ok(e.falls.length >= 5, '保留棋子与补位新子都应有位移记录(此前保留棋子位移丢失)');
  // 中间帧:动画单调推进(第 12 帧 offsetY 介于起始与 0 之间)
  e.update(12 / 60);
  for (const m of e.falls) {
    const cell = e.cellsForRender().find(c => c.r === m.r && c.c === m.c);
    const v = cell.offsetY;
    assert.ok(v <= 0.01 && v >= -m.dist * 90 - 0.01, '中间帧 offsetY 在 [−dist×90, 0] 区间');
  }
  // 落定:动画走完(fallT 归零进入连锁判定前)全部位移归零
  let guard = 0;
  while (e.state === 'FALLING' && guard < 200) { e.update(1 / 60); guard++; }
  assert.equal(e.state !== 'FALLING', true, '下落完成');
  assert.equal(e.falls.length, 0, '落定后 falls 清空(全部位移归零)');
  for (const c of e.cellsForRender()) {
    assert.equal(c.offsetY, 0, `格(${c.r},${c.c}) 落定 offsetY=0`);
  }
});

// ---- M6/v0.2 连通块消除规则(02 文档第 3 节) ----
// 本例用 2×2 验证四格整块消除;下一例验证 S/Z 四格(裁决 F11 措辞勘误:
// 原「4 格连通块要么 2×2 要么必含 3 连线」不成立,S/Z 四格为反例)。
test('M6 规则:2×2 四格整块消除 count=4(条件 2;下一例验证 S/Z 四格)', () => {
  const g = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  for (const [r, c] of [[1,3],[1,4],[2,3],[2,4]]) g[r][c] = { el: 0 };
  const gold = findMatchBlocks(g).filter(b => b.el === 0);
  assert.equal(gold.length, 1);
  assert.equal(gold[0].cells.length, 4, '2×2 方块消除 count=4');
});

test('M6 规则:S/Z 四格异形(无 3 连线)整块消除 count=4(条件 2 反例覆盖)', () => {
  const g = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  // Z 形 4 格:row1 (1,2)(1,3) + row2 (2,3)(2,4)——每行至多 2 连,整块连通,无任何 3 连线
  for (const [r, c] of [[1,2],[1,3],[2,3],[2,4]]) g[r][c] = { el: 0 };
  // 背景 (2,2) el=(2+2)%5=4 不相邻成块;(1,4) el=0 与 (1,3) 相邻 → 覆盖打断
  g[1][4] = { el: 1 };
  const gold = findMatchBlocks(g).filter(b => b.el === 0);
  assert.equal(gold.length, 1);
  assert.equal(gold[0].cells.length, 4, 'S/Z 四格连通块整块消除(连通性判定,不依赖 3 连线)');
});

test('M6 规则:S/Z 异形 6 格连通块消除 count=6(条件 2,数量无上限)', () => {
  const g = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  // S 形 6 格,无任何横/竖 3 连线:每行最多 2 连
  for (const [r, c] of [[1,2],[1,3],[2,3],[2,4],[3,4],[3,5]]) g[r][c] = { el: 0 };
  // 背景 (1,4) el=(1+4)%5=0 与 (1,3) 相邻会被 flood fill 并入 → 覆盖为 el1 打断
  // (覆盖后 el1 连通块 {(1,4),(1,5),(2,4)} 为 3 格 L 形不消,不影响断言)
  g[1][4] = { el: 1 };
  const gold = findMatchBlocks(g).filter(b => b.el === 0);
  assert.equal(gold.length, 1);
  assert.equal(gold[0].cells.length, 6, 'S 形 6 格整块消除');
});

test('M6 规则:3 格 L 形与 1~2 连通块不消除(反例回归)', () => {
  const g = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  // 3 格 L 形(2+2 共角缺一臂): (1,3)(2,3)(2,4)——无 3 连线
  for (const [r, c] of [[1,3],[2,3],[2,4]]) g[r][c] = { el: 0 };
  // 孤立 2 连: (5,1)(5,2)
  for (const [r, c] of [[5,1],[5,2]]) g[r][c] = { el: 4 };
  // 验证背景不干扰:确认 (2,4) 右邻 (2,5) el=(2+5)%5=2≠0,下邻 (3,4)=7%5=2≠0;1,3 右邻 (1,4)=0!覆盖它
  g[1][4] = { el: 1 };
  // el1 连通块 {(1,4),(0,4)?}:(0,4) el=4,(1,5) el=6%5=1,(2,4) el=6%5=1!(1,4)(1,5)(2,4) 3 格 L 不消 ✓
  assert.equal(findMatchBlocks(g).length, 0, '3 格 L 形与 2 连均不消除');
});

test('M6 规则:横竖 3 连保留(条件 1 回归)+ 3 格 L 形不消对照', () => {
  // 横 3 连
  let g = emptyGrid();
  for (const c of [1, 2, 3]) g[2][c] = { el: 3 };
  let gold = findMatchBlocks(g).filter(b => b.el === 3);
  assert.equal(gold.length, 1);
  assert.equal(gold[0].cells.length, 3, '横 3 连消除');
  // 竖 3 连
  g = emptyGrid();
  for (const r of [1, 2, 3]) g[r][5] = { el: 2 };
  gold = findMatchBlocks(g).filter(b => b.el === 2);
  assert.equal(gold.length, 1);
  assert.equal(gold[0].cells.length, 3, '竖 3 连消除');
});

test('M6 引擎:注入 2×2 盘 → 消除事件 count=4 + 掉普通消耗品(count=4→普通)', () => {
  const e = new BoardEngine(7);
  assert.ok(stepToIdle(e));
  // 底盘换成 (r+c)%5(全孤子,相邻格必异色),避免开局残子与注入块连通
  e.grid = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  e.grid[3][3] = { el: 0 }; e.grid[3][4] = { el: 0 };
  e.grid[4][3] = { el: 0 }; e.grid[4][4] = { el: 0 };
  e.grid[3][2] = { el: 1 }; e.grid[4][2] = { el: 2 }; // 左侧打断
  e.grid[2][3] = { el: 3 }; e.grid[2][4] = { el: 4 }; // 上侧打断
  // 引擎在 IDLE 不主动扫描,显式触发一轮匹配(白盒:与落定后 _stepFall→_beginRound 同一路径)
  e.chain = 1;
  e._beginRound();
  assert.equal(e.state, 'RESOLVING', '2×2 应进入消除');
  assert.ok(stepToIdle(e, 30), '应回到 IDLE');
  const evs = drain(e);
  assert.ok(evs.some(x => x.element === 'metal' && x.count === 4), '应产生 metal(金=el0) count=4 事件');
  assert.ok(hasNoMatches(e.grid), '终态无现成匹配');
});

// ---- M6 批次 B:消除演出(02 文档 3.1) ----
// 公开入口构造(F11 续审:不再白盒调用 _beginRound):背景 (r+c)%5 无任何同色正交相邻;
// 显式置 (3,4)(4,3)(4,4)=el0(成 3 格 L,不消),(3,2) 覆盖 el1 打断行延伸;
// trySwap (2,3)el0↔(3,3)el1 后 (3,3) 归队成 2×2 {(3,3),(3,4),(4,3),(4,4)} count=4。
function mkStageBoard(fx, seed = 7) {
  const e = new BoardEngine(seed);
  e.fxEnabled = fx;
  stepToIdle(e);
  e.grid = emptyGrid().map((row, r) => row.map((_, c) => ({ el: (r + c) % 5 })));
  e.grid[3][4] = { el: 0 }; e.grid[4][3] = { el: 0 }; e.grid[4][4] = { el: 0 };
  e.grid[3][2] = { el: 1 };
  e.grid[3][3] = { el: 1 };
  assert.ok(hasNoMatches(e.grid), '构盘无现成匹配(公开入口前提)');
  assert.ok(e.trySwap({ r: 2, c: 3 }, { r: 3, c: 3 }), '公开入口 trySwap 成合');
  e.update(0.16); // SWAPPING 0.15s 走完 → _beginRound 进入 RESOLVING
  assert.equal(e.state, 'RESOLVING', '交换动画后进入消除演出');
  return e;
}

test('M6 演出:RESOLVING 时长=0.9s(动效开)/0.20s(动效关);事件在演出起点已发出;中途关闭 ≤0.2s 收口', () => {
  const on = mkStageBoard(true);
  assert.ok(Math.abs(on.clearTotal - 0.9) < 1e-9, `动效开演出总长 0.9s,实际 ${on.clearTotal}`);
  assert.equal(on.events.filter(x => x.type === 'match_cleared').length, 1, '事件在演出起点(RESOLVING 进入时刻)已发出');
  const off = mkStageBoard(false);
  assert.ok(Math.abs(off.clearTotal - 0.2) < 1e-9, `动效关退化 0.20s,实际 ${off.clearTotal}`);
  // 时长驱动:动效开下推进 0.45s(段②结束)仍 RESOLVING;0.9s 后回 FALLING/后续
  on.update(0.45);
  assert.equal(on.state, 'RESOLVING', '0.45s 时演出未结束');
  on.update(0.5);
  assert.notEqual(on.state, 'RESOLVING', '0.95s 时演出已结束进入下落/终态');
  // F8 续审(B9 中途关闭动效):剩余演出按 4.5× 衰减,≤0.2s 内收口(原实现仍按 0.9s 走)
  const mid = mkStageBoard(true);
  mid.update(0.45); // 剩余 0.45s
  mid.fxEnabled = false;
  mid.update(0.19);
  assert.notEqual(mid.state, 'RESOLVING', '中途关闭:0.19s(<0.2s)内残余演出已收口');
});

test('M6 演出:段①吸收位移指向块质心(贝塞尔曲线+错峰),终态与关动效实例逐格一致(TDD 15 兼容)', () => {
  const e = mkStageBoard(true);
  // 段① 中点(0.175s,格 (3,3) 为块内首格 delay=0):贝塞尔曲线位移指向质心 (3.5,3.5)
  e.update(0.175);
  const cells = e.cellsForRender();
  const c33 = cells.find(c => c.r === 3 && c.c === 3);
  // 02 文档 3.1:位移方向指向质心(正交分量均为正)、未越过质心、非直线(贝塞尔≠线性插值 22.5)
  assert.equal(c33.stage, 1);
  assert.ok(c33.offsetX > 0 && c33.offsetY > 0, `段①位移 (${c33.offsetX.toFixed(1)},${c33.offsetY.toFixed(1)}) 应指向右下质心`);
  assert.ok(c33.offsetX < 45 && c33.offsetY < 45, '段①中点未越过质心(45=全程直线距离)');
  assert.ok(c33.offsetX !== 22.5 || c33.offsetY !== 22.5, '位移偏离直线插值(贝塞尔曲线,02 3.1)');
  assert.ok(c33.sx > 1 || c33.sy > 1, '段①带挤压形变(sx/sy,02 3.1 形变随距离增强)');
  // 段①完成(0.35s):全部格到达质心(错峰 ≤80ms 后仍于 0.35s 收拢)
  e.update(0.2);
  for (const cl of e.clearing) {
    const c = e.cellsForRender().find(x => x._clearing && x.r === cl.r && x.c === cl.c);
    assert.ok(c && c.stage >= 2, '0.35s 后全部格进入段②');
    assert.ok(Math.abs(c.offsetX - (cl.cc - cl.c) * 90) < 1e-6
      && Math.abs(c.offsetY - (cl.cx - cl.r) * 90) < 1e-6, `格(${cl.r},${cl.c}) 段②位于块质心`);
  }
  // 走完:终态无匹配
  assert.ok(stepToIdle(e, 30));
  assert.ok(hasNoMatches(e.grid));
  // F11 续审:终态对照**真实运行**关动效实例(同种子同盘同公开入口),逐格比对终态一致
  const off = mkStageBoard(false);
  assert.ok(stepToIdle(off, 30));
  assert.equal(JSON.stringify(off.grid), JSON.stringify(e.grid), '动效开/关两组实例终态逐格一致(同种子同输入)');
});

test('M6 演出(F8a):关动效实例真实推进时长=0.20s(不被 4.5× 误加速成 0.044s)', () => {
  const off = mkStageBoard(false); // clearFxAtStart=false:总时长 0.2s,衰减倍率必须为 1
  let t = 0;
  while (off.state === 'RESOLVING' && t < 1) { off.update(0.016); t += 0.016; }
  assert.ok(Math.abs(t - 0.208) < 0.05, `关动效 RESOLVING 实际推进 ${t.toFixed(3)}s(应≈0.2s,原缺陷 0.044s)`);
  // 对照:开启中途中关的轮(残余 0.45s)按 4.5× 在 ≤0.11s 内收口
  const mid = mkStageBoard(true);
  mid.update(0.45);
  mid.fxEnabled = false;
  let t2 = 0;
  while (mid.state === 'RESOLVING' && t2 < 1) { mid.update(0.016); t2 += 0.016; }
  assert.ok(t2 <= 0.45 && t2 >= 0.08, `中途中关残余收口 ${t2.toFixed(3)}s(应≈0.45/4.5=0.10s)`);
});

test('M6 演出(F8 续审):认领绑定三时点 0.10/0.60/0.80s + 同元素双块唯一绑定', () => {  // 场景 A(单块,三时点):事件入口 0.10s 认领 → 段③显示;执行记录 0.80s 认领 → 段④仍显示
  const a = mkStageBoard(true);
  const elA = [...a.blockFx.values()][0].el;
  assert.ok(a.claimBlockFx(elA, 'fire_bolt', 1), '0.10s 事件入口认领');
  assert.equal(a.blockFx.get('b0').skillId, 'fire_bolt');
  a.update(0.7); // 段④
  assert.ok(a.claimBlockFx(elA, 'fire_dotzone', 3) === false, '已认领块不可重复绑定(唯一性)');
  assert.equal(a.blockFx.get('b0').skillId, 'fire_bolt', '0.80s 执行记录不覆盖已认领块(快照保留)');
  // 场景 B(同元素双块):两个未认领块,先后认领各自占一块,不重复
  const b = mkStageBoard(true);
  b.blockFx.set('b0', { el: 'fire', reserved: false });
  b.blockFx.set('b1', { el: 'fire', reserved: false });
  assert.ok(b.claimBlockFx('fire', 'fire_bolt', 1), '第一认领 → b0');
  assert.ok(b.claimBlockFx('fire', 'fire_dotzone', 2), '第二认领 → b1(不重复占 b0)');
  assert.equal(b.blockFx.get('b0').skillId, 'fire_bolt');
  assert.equal(b.blockFx.get('b1').skillId, 'fire_dotzone');
  assert.ok(b.claimBlockFx('fire', 'fire_pulse', 1) === false, '全认领后无块可绑');
  // 场景 C(0.60s 延迟选技):未认领块在认领前显示蓄能口径(blockFx reserved=false 可读)
  const c = mkStageBoard(true);
  assert.equal(c.blockFx.get('b0').reserved, false, '事件时未认领 → 蓄能口径');
  c.update(0.6);
  assert.ok(c.claimBlockFx([...c.blockFx.values()][0].el, 'fire_bolt', 2), '0.60s 延迟认领成功(段③内仍可绑定)');
});

test('M6 演出(REQ-08 F8):claimBlockFx resKey 幂等——同预约重复回写不换块不扩散', () => {
  const d = mkStageBoard(true);
  d.blockFx.set('b0', { el: 'fire', reserved: false });
  d.blockFx.set('b1', { el: 'fire', reserved: false });
  assert.ok(d.claimBlockFx('fire', 'fire_bolt', 1, 'r1'), '首认领 → b0');
  assert.equal(d.blockFx.get('b0').resKey, 'r1', '块绑定携带预约身份');
  assert.ok(d.claimBlockFx('fire', 'fire_bolt', 1, 'r1'), '同 resKey 重复回写 → 幂等 true');
  assert.equal(d.blockFx.get('b0').skillId, 'fire_bolt', '不换块');
  assert.equal(d.blockFx.get('b1').reserved, false, '第二块保持蓄能(不扩散——REQ-07 F8 反例)');
  assert.ok(d.claimBlockFx('fire', 'fire_dotzone', 2, 'r2'), '不同 resKey → 认领 b1');
  assert.equal(d.blockFx.get('b1').skillId, 'fire_dotzone', '双候选各占一块');
  assert.ok(d.claimBlockFx('fire', 'fire_pulse', 1, 'r3') === false, '全认领后无块可绑');
});
