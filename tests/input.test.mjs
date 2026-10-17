// tests/input.test.mjs
// 输入层单测(REQ-M6-06 F7):忙态跨越手势作废、作废手势不得在恢复 IDLE 后重新生效、
// 回弹与新拖动分离保存(A 回弹期间拖 B 正常跟手、回弹起点各归各)
// 运行: node --test tests/input.test.mjs
// 相对路径: tests/input.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { attachInput, DRAG_HALF_CELL, BOUNCE_MS } from '../scripts/core/input.js';

// ---- Canvas 桩(仅 getBoundingClientRect + addEventListener;事件对象为普通 POJO) ----
function mkHarness({ busy = () => false, tryDragSwap = null, onTap = () => {} } = {}) {
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
    busy,
    tryDragSwap: tryDragSwap ? (a, b) => { calls.swap.push([a, b]); return tryDragSwap(a, b); } : undefined,
    onTap: (cell) => calls.tap.push(cell),
  });
  const ev = (type, x, y) => listeners[type]({ clientX: x, clientY: y, preventDefault() {} });
  const cellXY = (r, c) => ({ x: c * 90 + 45, y: 504 + r * 90 + 45 });
  return { input, ev, cellXY, calls };
}

const cellName = (cell) => `(${cell.r},${cell.c})`;

test('F7:忙态跨越手势作废——按下遇忙态,恢复 IDLE 后松手不得触发点选(onTap)', () => {
  let isBusy = true;
  const h = mkHarness({ busy: () => isBusy });
  const p = h.cellXY(2, 3);
  h.ev('mousedown', p.x, p.y); // 按下时引擎忙(如道具超时进入 FALLING)
  isBusy = false;              // 忙态结束(恢复 IDLE)
  h.ev('mouseup', p.x, p.y);   // 松手(位移 <12px,旧实现会补触发 onTap → 可能完成交换)
  assert.equal(h.calls.tap.length, 0, '作废手势不得在恢复 IDLE 后以点选形式重新生效');
});

test('F7:忙态中按下直接丢弃整次手势(无跟手、无点选)', () => {
  const h = mkHarness({ busy: () => true });
  const p = h.cellXY(2, 3);
  h.ev('mousedown', p.x, p.y);
  h.ev('mousemove', p.x + 30, p.y);
  h.ev('mouseup', p.x + 30, p.y);
  assert.equal(h.calls.tap.length, 0, '忙态中按下不产生点选');
  assert.equal(h.calls.swap.length, 0, '忙态中按下不产生拖拽预判定');
  assert.equal(h.input.dragState().drag, null, '忙态中按下无跟手状态');
});

test('F7:手势进行中进入忙态 → 作废预判定,恢复 IDLE 后移动不再补触发交换', () => {
  let isBusy = false;
  const h = mkHarness({ busy: () => isBusy, tryDragSwap: () => true });
  const p = h.cellXY(2, 3);
  h.ev('mousedown', p.x, p.y);
  h.ev('mousemove', p.x + 20, p.y);   // 未过阈值,开始跟手
  isBusy = true;                      // 手势中引擎进入忙态(如交换被接受/消除开始)
  h.ev('mousemove', p.x + 30, p.y);
  isBusy = false;                     // 恢复 IDLE
  h.ev('mousemove', p.x + 60, p.y);   // 越过 45px 阈值(旧实现此时补触发交换)
  assert.equal(h.calls.swap.length, 0, '作废手势不得在忙态结束后补触发预判定');
  h.ev('mouseup', p.x + 60, p.y);
  assert.equal(h.calls.tap.length, 0);
});

test('F7:A 回弹期间拖 B(桩拒绝交换,保持跟手并独立回弹)——B 正常跟手、回弹各自独立、回弹起点各归各', () => {
  const h = mkHarness({ tryDragSwap: () => false }); // 无效交换(触发 A 回弹)
  const a = h.cellXY(1, 1), b = h.cellXY(5, 5);
  // 拖 A 越过阈值(无效)→ 松手 → A 进入回弹
  h.ev('mousedown', a.x, a.y);
  h.ev('mousemove', a.x + 60, a.y);
  h.ev('mouseup', a.x + 60, a.y);
  let st = h.input.dragState();
  assert.equal(st.bounces.length, 1, 'A 松手后进入回弹');
  assert.equal(cellName(st.bounces[0].cell), cellName({ r: 1, c: 1 }));
  // 回弹未结束(160ms)时按下并拖 B(有效交换)
  h.ev('mousedown', b.x, b.y);
  h.ev('mousemove', b.x + 60, b.y);
  st = h.input.dragState();
  assert.ok(st.drag, 'A 回弹期间拖 B 仍有跟手状态(不再被旧回弹遮蔽)');
  assert.equal(cellName(st.drag.cell), cellName({ r: 5, c: 5 }), '跟手的是 B(不再是 A)');
  assert.equal(st.bounces.length, 1, 'A 的回弹仍在进行(不受 B 拖拽影响)');
  assert.equal(h.calls.swap.at(-1)[0].r, 5, '预判定以 B 为起点');
  // 松手 B:B 的回弹起点=本次手势 B 的偏移(60×0.5=30),不取 A 的残留
  h.ev('mouseup', b.x + 60, b.y);
  st = h.input.dragState();
  assert.equal(st.bounces.length, 2, 'A、B 各自回弹');
  const bBounce = st.bounces.find(x => x.cell.r === 5 && x.cell.c === 5);
  assert.ok(Math.abs(bBounce.dx - 30) < 1e-6, `B 回弹起点=${bBounce.dx}(应=自身偏移 30,不再误用 A 的偏移)`);
  // 回弹计时推进 → 全部归位
  h.input.update(BOUNCE_MS / 1000 + 0.01);
  assert.equal(h.input.dragState().bounces.length, 0, '回弹完成后清空');
});

test('F7(REQ-M6-07 续审):静止按住跨过忙态——IDLE 按下→静止跨 FALLING→IDLE 松手不触发点选', () => {
  // 反例(上轮遗漏):gestureVoid 原先只在 mousemove 设置,指针静止跨越忙态会复活手势
  let isBusy = false;
  const h = mkHarness({ busy: () => isBusy });
  const p = h.cellXY(3, 4);
  h.ev('mousedown', p.x, p.y);      // IDLE 时按下
  isBusy = true;                     // 其他道具超时 → 棋盘 FALLING(忙态);指针保持静止
  h.input.update(1 / 60);            // 主循环每帧调用 update(无任何 mousemove 事件)
  h.input.update(1 / 60);
  isBusy = false;                    // 恢复 IDLE
  h.ev('mouseup', p.x, p.y);         // 松手(全程无 move 事件)
  assert.equal(h.calls.tap.length, 0, '静止跨越忙态的手势不得以点选复活(update 逐帧观察忙态)');
});

test('F7:回弹格锁定——回弹中的格子不可再次开始手势,其他格照常', () => {
  const h = mkHarness({ tryDragSwap: () => false });
  const a = h.cellXY(1, 1), other = h.cellXY(6, 6);
  h.ev('mousedown', a.x, a.y);
  h.ev('mousemove', a.x + 60, a.y);
  h.ev('mouseup', a.x + 60, a.y); // A 回弹中
  const before = h.calls.tap.length + h.calls.swap.length;
  h.ev('mousedown', a.x, a.y);    // 回弹格按下 → 锁定
  h.ev('mouseup', a.x, a.y);
  assert.equal(h.calls.tap.length + h.calls.swap.length, before, '回弹格不接受新手势');
  h.ev('mousedown', other.x, other.y); // 其他格照常
  h.ev('mouseup', other.x, other.y);
  assert.equal(h.calls.tap.at(-1).r, 6, '其他格点选正常');
});
