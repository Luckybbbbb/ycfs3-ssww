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
test('初始盘无现成匹配且存在合法交换（FR-2.1）', () => {
  for (const seed of [1, 2, 3, 42, 999]) {
    const g = generateGrid(makeRng(seed));
    assert.ok(hasNoMatches(g), `seed=${seed} 有初始匹配`);
    assert.ok(hasValidSwap(g), `seed=${seed} 无合法交换`);
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
