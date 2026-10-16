// scripts/board/engine.js
// 三消棋盘状态机：IDLE/SWAPPING/RESOLVING/FALLING/SETTLE(+PARALYZED)
// 规则依据: docs/design/02-三消玩法设计.md（输入策略=忽略、事件逐轮即发、
//          道具移除走标准下落、洗牌恢复链、连锁 chain 逐轮 +1）
// 纯逻辑无 DOM，可在 Node 单测（终态一致性依赖固定种子 = 相同模拟时钟）。
// 相对路径: scripts/board/engine.js

import {
  ROWS, COLS, ELEMENTS, makeRng, emptyGrid, isPiece, isItem,
  generateGrid, findMatchBlocks, hasNoMatches, hasValidSwap,
  shuffleGrid, enforceQuota, safePickRefill,
} from './grid.js';
import { rollItem, placeItem, tickItems } from './items.js';

export const STATE = {
  IDLE: 'IDLE', SWAPPING: 'SWAPPING', REBOUND: 'REBOUND',
  RESOLVING: 'RESOLVING', FALLING: 'FALLING', PARALYZED: 'PARALYZED',
};

const SWAP_TIME = 0.15;     // 交换/回弹动画（02 文档第 2 节 0.15s）
const CLEAR_TIME = 0.20;    // 消除动画
const FALL_TIME_PER_CELL = 0.08; // 下落 80ms/格（02 文档第 4 节）

export class BoardEngine {
  constructor(seed = 20260601) {
    this.rng = makeRng(seed);
    this.grid = null;
    this.state = STATE.IDLE;
    this.chain = 0;
    this.events = [];          // {type:'match_cleared',element,count,chain} 等，外部 drain
    this.fx = { swapA: null, swapB: null, t: 0, back: false };
    this.clearing = [];        // [{r,c,t}]
    this.falls = [];           // [{r,c,fromY}]  渲染用偏移
    this.paralyzed = false;
    this.pendingItemRemovals = []; // RESOLVING/FALLING 期间被移除的道具格，落定后补位
    this._init();
  }

  _init() {
    // 开局：随机填充 + 双验证（02 文档第 8 节恢复链同一规则）
    for (let i = 0; i < 50; i++) {
      const g = generateGrid(this.rng);
      if (hasNoMatches(g) && hasValidSwap(g)) { this.grid = g; return; }
    }
    this.grid = generateGrid(this.rng); // 理论不可达；进入瘫痪兜底
    this.paralyzed = true;
    this.state = STATE.PARALYZED;
  }

  drainEvents() { const e = this.events; this.events = []; return e; }

  // ---------- 输入（策略：忙时忽略，02 文档第 7 节） ----------
  trySwap(a, b) {
    if (this.state !== STATE.IDLE || this.paralyzed) return false;
    if (Math.abs(a.r - b.r) + Math.abs(a.c - b.c) !== 1) return false;
    const A = this.grid[a.r][a.c], B = this.grid[b.r][b.c];
    if (!A || !B) return false;
    // 道具可自由换位；纯棋子交换必须产生新匹配，否则回弹
    const itemInvolved = isItem(A) || isItem(B);
    if (!itemInvolved && !this._swapCreatesMatchFrom(a, b)) return false;
    [this.grid[a.r][a.c], this.grid[b.r][b.c]] = [B, A];
    this.state = STATE.SWAPPING;
    this.fx = { swapA: a, swapB: b, t: SWAP_TIME, back: false };
    return true;
  }

  _swapCreatesMatchFrom(a, b) {
    const g = this.grid.map(row => row.slice());
    [g[a.r][a.c], g[b.r][b.c]] = [g[b.r][b.c], g[a.r][a.c]];
    const blocks = findMatchBlocks(g);
    return blocks.some(bl => bl.cells.some(k =>
      (k.r === a.r && k.c === a.c) || (k.r === b.r && k.c === b.c)));
  }

  // 道具点击（IDLE 时直接生效；忙时按文档走「落定后追加」——M1 简化为仅 IDLE 可点）
  tapItem(cell) {
    if (this.state !== STATE.IDLE) return null;
    const c = this.grid[cell.r]?.[cell.c];
    if (!isItem(c)) return null;
    this.grid[cell.r][cell.c] = null;
    this.pendingItemRemovals.push(cell);
    this._refillAfterRemovals();
    return c;
  }

  // ---------- 主推进 ----------
  update(dt) {
    switch (this.state) {
      case STATE.SWAPPING:
      case STATE.REBOUND:
        this.fx.t -= dt;
        if (this.fx.t <= 0) this._afterSwapAnim();
        break;
      case STATE.RESOLVING:
        for (const cl of this.clearing) cl.t -= dt;
        if (this.clearing.every(cl => cl.t <= 0)) this._afterClear();
        break;
      case STATE.FALLING:
        this._stepFall(dt);
        break;
      default: break;
    }
    // 道具倒计时（02 文档第 6 节：10s 超时）
    if (this.state === STATE.IDLE) {
      const expired = tickItems(this.grid, dt);
      for (const cell of expired) this.pendingItemRemovals.push(cell);
      if (expired.length) this._refillAfterRemovals();
      // 瘫痪态恢复：任何道具移除后重试
      if (this.paralyzed && expired.length) this._tryRecover();
    }
  }

  _afterSwapAnim() {
    if (this.fx.back) { this.state = STATE.IDLE; return; }
    // 检查匹配（道具不参与）
    this.chain = 1;
    this._beginRound();
  }

  _beginRound() {
    const blocks = findMatchBlocks(this.grid);
    if (!blocks.length) { this.state = STATE.IDLE; this._onSettle(); return; }
    // 发事件（逐轮即发，02 文档 5.1；每连通块一事件；r/c 为表现层粒子发射点）
    for (const b of blocks) {
      this.events.push({ type: 'match_cleared', element: ELEMENTS[b.el], count: b.cells.length, chain: this.chain, r: b.cells[0].r, c: b.cells[0].c });
    }
    // 消耗品生成（按单事件 count：4→普通、≥5→高级；02 文档 5.1/6）
    const cleared = [];
    for (const b of blocks) for (const k of b.cells) {
      this.grid[k.r][k.c] = null;
      cleared.push(k);
    }
    for (const b of blocks) {
      if (b.cells.length >= 4) {
        const item = rollItem(b.cells.length, this.rng);
        placeItem(this.grid, cleared, item, this.rng);
      }
    }
    this.clearing = cleared.map(k => ({ ...k, t: CLEAR_TIME }));
    this.state = STATE.RESOLVING;
  }

  _afterClear() {
    this.clearing = [];
    this._applyFalls();
    this.state = STATE.FALLING;
  }

  // 标准下落补位：每列非空格（棋子+道具）保持顺序沉降，顶部 safePick 补新（02 文档第 4 节/B3）
  _applyFalls() {
    const moves = []; // {r,c,dist}
    for (let c = 0; c < COLS; c++) {
      // 快照本列旧内容（自底向上）
      const oldCol = [];
      for (let r = ROWS - 1; r >= 0; r--) oldCol.push(this.grid[r][c]);
      // 新列：非空格按原顺序沉降到底部，顶部空位补新
      const kept = oldCol.filter(x => x !== null);
      const newCount = ROWS - kept.length;
      const newCol = [];
      for (let i = 0; i < newCount; i++) newCol.push({ fresh: true });
      for (const cell of kept) newCol.push(cell);
      // 顶部补位用 safePick（此时列下方已是最终态；跨列左二依赖已处理列）
      for (let r = 0; r < newCount; r++) newCol[r] = { el: 0, _fresh: true };
      for (let r = 0; r < ROWS; r++) this.grid[r][c] = newCol[r];
      for (let r = 0; r < newCount; r++) {
        this.grid[r][c] = { el: safePickRefill(this.rng, this.grid, r, c) };
      }
      // 位移 = 新行 − 旧行（kept 中第 i 个自底向上：旧行 = ROWS−1−i）
      for (const cell of kept) {
        const newR = this.grid.findIndex(row => row[c] === cell);
        const oldR = ROWS - 1 - kept.indexOf(cell);
        if (newR !== oldR) moves.push({ r: newR, c, dist: newR - oldR });
      }
      for (let r = 0; r < newCount; r++) moves.push({ r, c, dist: newCount - r });
    }
    const maxDist = Math.max(1, ...moves.map(m => m.dist));
    this.falls = moves;
    this.fallT = maxDist * FALL_TIME_PER_CELL;
    this.fallTotal = this.fallT;
  }

  _stepFall(dt) {
    this.fallT -= dt;
    if (this.fallT > 0) return;
    this.falls = [];
    this.chain++;
    this._beginRound(); // 连锁判定（无匹配则回 IDLE + SETTLE）
  }

  // 道具移除后补位（等价一次单格下落，02 文档第 6 节「移除后走标准下落补位」）
  _refillAfterRemovals() {
    if (this.state === STATE.IDLE) {
      this._applyFalls();
      this.state = STATE.FALLING;
      this.chain = 0; // 补位下落不构成连锁升级；落定后 _beginRound 无匹配即回 IDLE
    } else {
      // 忙时移除（超时/瘫瘓恢复重试）：登记，落定后追加
      this.pendingItemRemovals.push(...this._takeEmptyFromItems());
    }
  }

  _takeEmptyFromItems() { return []; } // 忙时移除在 tapItem 已拦截，占位保持接口

  _onSettle() {
    // 死局检测与恢复链（02 文档第 8 节）：双验证失败 → 洗牌 3 次 → 重生成 50 次 → 瘫痪
    if (this.paralyzed) return;
    if (hasNoMatches(this.grid) && hasValidSwap(this.grid)) return;
    for (let i = 0; i < 3; i++) {
      if (shuffleGrid(this.grid, this.rng)) return; // shuffleGrid 内含配额+双验证
    }
    this._regenerate();
  }

  _regenerate() {
    for (let i = 0; i < 50; i++) {
      const reserved = [];
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (isItem(this.grid[r][c])) reserved.push({ r, c });
      }
      const g = generateGrid(this.rng, reserved);
      // 配额（棋子数不足时由瘫痪态兜底，此处棋子 ≥61 足够）
      if (hasNoMatches(g) && hasValidSwap(g)) { this.grid = g; return; }
    }
    this.paralyzed = true;
    this.state = STATE.PARALYZED;
    this.events.push({ type: 'board_paralyzed' });
  }

  _tryRecover() {
    if (!this.paralyzed) return;
    // 任一道具移除后重试一次洗牌
    if (shuffleGrid(this.grid, this.rng)) {
      this.paralyzed = false;
      this.state = STATE.IDLE;
    }
  }

  // ---------- 渲染辅助 ----------
  // 返回 [{r,c,el|item,offsetY,alpha,scale,flash}]：offsetY 为下落/交换动画偏移(逻辑像素,
  // 内置缓动:下落 cubic-out、交换 easeInOutQuad),alpha/scale/flash 为消除淡出参数。
  cellsForRender() {
    const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
    const easeInOutQuad = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
    const out = [];
    const swapRaw = (this.state === STATE.SWAPPING || this.state === STATE.REBOUND)
      ? 1 - Math.max(0, this.fx.t) / SWAP_TIME : 0;
    const swapProgress = easeInOutQuad(swapRaw);
    const fallProgress = this.state === STATE.FALLING && this.fallTotal > 0
      ? 1 - Math.max(0, this.fallT) / this.fallTotal : 1;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = this.grid[r][c];
        if (!cell) continue;
        let offsetY = 0, alpha = 1, scale = 1, flash = 0;
        const fm = this.falls.find(m => m.r === r && m.c === c);
        if (fm && fallProgress < 1) offsetY = -fm.dist * 90 * (1 - easeOutCubic(fallProgress));
        if (this.state === STATE.SWAPPING || this.state === STATE.REBOUND) {
          const { swapA: A, swapB: B } = this.fx;
          if (A && B) {
            const dir = { r: B.r - A.r, c: B.c - A.c };
            const t = this.fx.back ? swapProgress : 1 - swapProgress; // 回弹反向
            if (r === A.r && c === A.c) offsetY += (dir.r * 90) * (1 - swapProgress) * (this.fx.back ? -1 : 1);
            if (r === B.r && c === B.c) offsetY += (-dir.r * 90) * (1 - swapProgress) * (this.fx.back ? -1 : 1);
          }
        }
        const cl = this.clearing.find(k => k.r === r && k.c === c);
        if (cl) {
          alpha = Math.max(0, cl.t / CLEAR_TIME);
          scale = 0.4 + 0.6 * alpha;        // 消除时收缩
          flash = alpha > 0.7 ? (alpha - 0.7) / 0.3 : 0; // 消除起始白闪
        }
        out.push({ r, c, ...cell, offsetY, alpha, scale, flash });
      }
    }
    return out;
  }
}
