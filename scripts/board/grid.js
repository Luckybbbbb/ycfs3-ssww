// scripts/board/grid.js
// 8×8 棋盘纯数据结构：生成（避免初始三连）、元素配额、洗牌与合法性验证
// 相对路径: scripts/board/grid.js
// 数值依据: docs/design/02-三消玩法设计.md 第 1/8 节

export const ROWS = 8;
export const COLS = 8;
export const ELEMENTS = ['metal', 'wood', 'water', 'fire', 'earth'];
export const CELL = 90;           // 格 90×90 逻辑像素（02 文档第 1 节）
export const BOARD_W = COLS * CELL;   // 720
export const BOARD_H = ROWS * CELL;
export const BOARD_Y = 448;           // 棋盘顶部逻辑 y(M13:联动栏移除,棋盘上移接战斗区)

// 带种子的随机数（mulberry32）——终态一致性回归依赖固定种子
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function emptyGrid() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

// cell: null(空) | {el: 0..4} | {item: 'heal'|'shield'|'cd', expire: 秒}
export function isPiece(cell) { return cell && cell.el !== undefined; }
export function isItem(cell) { return cell && cell.item !== undefined; }

// 单格放置时避免参与匹配(M6/v0.2 口径,02 文档 FR-2.1+第 4 节):
// ①与左二/上二成横/竖三连(原规则);②放置后与已放置同色邻格形成的连通块 ≥4(REQ-M6 批次 A:
// 仅防 3 连时补位子高频并入 ≥4 连通块,连锁 RESOLVING↔FALLING 无法终止)。理论不可满足时
// (options 空)回落任意色,由引擎连锁上限兜底(见 engine.js MAX_CHAIN)。
export function safePickRefill(rng, grid, r, c) {
  const banned = new Set();
  for (const x of [0, 1, 2, 3, 4]) {
    if (c >= 2 && isPiece(grid[r][c-1]) && isPiece(grid[r][c-2]) &&
        grid[r][c-1].el === x && grid[r][c-2].el === x) { banned.add(x); continue; }
    if (r >= 2 && isPiece(grid[r-1][c]) && isPiece(grid[r-2][c]) &&
        grid[r-1][c].el === x && grid[r-2][c].el === x) { banned.add(x); continue; }
    if (_wouldFormBlock4(grid, r, c, x)) banned.add(x);
  }
  const options = ELEMENTS.map((_, i) => i).filter(i => !banned.has(i));
  const pool = options.length ? options : ELEMENTS.map((_, i) => i);
  return pool[Math.floor(rng() * pool.length)];
}

// 试放 el=x 于 (r,c),局部 flood fill 判定其所在同色连通块是否 ≥4(≥4 即满足消除条件 2)
function _wouldFormBlock4(grid, r, c, x) {
  const seen = new Set([r * COLS + c]);
  const stack = [[r, c]];
  let n = 0;
  while (stack.length) {
    const [cr, cc] = stack.pop();
    n++;
    if (n >= 4) return true; // 提前退出:≥4 即命中
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = cr + dr, nc = cc + dc;
      const key = nr * COLS + nc;
      if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || seen.has(key)) continue;
      if (isPiece(grid[nr][nc]) && grid[nr][nc].el === x) { seen.add(key); stack.push([nr, nc]); }
    }
  }
  return false;
}

// 生成新盘（无初始三连）
export function generateGrid(rng, reservedCells = []) {
  const grid = emptyGrid();
  const reserved = new Set(reservedCells.map(({r, c}) => r * COLS + c));
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (reserved.has(r * COLS + c)) { grid[r][c] = null; continue; } // 道具格由调用方回填
      grid[r][c] = { el: safePickRefill(rng, grid, r, c) };
    }
  }
  return grid;
}

// 找出全部匹配连通块(M6/v0.2 规则:同色正交连通块,含横/竖 ≥3 连线 或 块 ≥4 格即整块消除)
// flood fill 天然合并交叉形(L/T/十字),不再需要 run 扫描+并查;道具格不参与。
// 返回: [{el, cells: [{r,c},...]}]
export function findMatchBlocks(grid) {
  const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  const blocks = [];
  for (let r0 = 0; r0 < ROWS; r0++) {
    for (let c0 = 0; c0 < COLS; c0++) {
      if (seen[r0][c0] || !isPiece(grid[r0][c0])) continue;
      const el = grid[r0][c0].el;
      // BFS 收集同色正交连通块
      const cells = [];
      const stack = [[r0, c0]];
      seen[r0][c0] = true;
      while (stack.length) {
        const [cr, cc] = stack.pop();
        cells.push({ r: cr, c: cc });
        if (cr > 0 && !seen[cr-1][cc] && isPiece(grid[cr-1][cc]) && grid[cr-1][cc].el === el) { seen[cr-1][cc] = true; stack.push([cr-1, cc]); }
        if (cr < ROWS-1 && !seen[cr+1][cc] && isPiece(grid[cr+1][cc]) && grid[cr+1][cc].el === el) { seen[cr+1][cc] = true; stack.push([cr+1, cc]); }
        if (cc > 0 && !seen[cr][cc-1] && isPiece(grid[cr][cc-1]) && grid[cr][cc-1].el === el) { seen[cr][cc-1] = true; stack.push([cr, cc-1]); }
        if (cc < COLS-1 && !seen[cr][cc+1] && isPiece(grid[cr][cc+1]) && grid[cr][cc+1].el === el) { seen[cr][cc+1] = true; stack.push([cr, cc+1]); }
      }
      // 保留条件(02 文档第 3 节):块内含横/竖 ≥3 连线 或 块大小 ≥4。
      // 每条 3 连线取其最左/最上格检查向右/向下延伸两格,即可覆盖块内全部 3 连线。
      const inBlock = new Set(cells.map(k => k.r * COLS + k.c));
      const hasLine3 = cells.some(({ r, c }) =>
        (inBlock.has(r * COLS + c + 1) && inBlock.has(r * COLS + c + 2)) ||
        (inBlock.has((r + 1) * COLS + c) && inBlock.has((r + 2) * COLS + c)));
      if (hasLine3 || cells.length >= 4) blocks.push({ el, cells });
    }
  }
  return blocks;
}

// 无现成匹配？（合法终态条件 a，02 文档第 8 节）
export function hasNoMatches(grid) {
  return findMatchBlocks(grid).length === 0;
}

// 交换后「被交换的两子之一参与新匹配」？（合法终态条件 b，严格版）
export function swapCreatesMatch(grid, r1, c1, r2, c2) {
  const g = grid.map(row => row.slice());
  [g[r1][c1], g[r2][c2]] = [g[r2][c2], g[r1][c1]];
  const blocks = findMatchBlocks(g);
  return blocks.some(b => b.cells.some(k =>
    (k.r === r1 && k.c === c1) || (k.r === r2 && k.c === c2)));
}

// 存在合法交换？（穷举 + 严格判定，02 文档第 8 节）
export function hasValidSwap(grid) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (c + 1 < COLS && swapCreatesMatch(grid, r, c, r, c + 1)) return true;
      if (r + 1 < ROWS && swapCreatesMatch(grid, r, c, r + 1, c)) return true;
    }
  }
  return false;
}

// 元素配额：某元素 <3 只时从最多元素抽补（道具格不计；02 文档第 8 节，禁止反向替换）
export function enforceQuota(grid, rng) {
  const count = [0, 0, 0, 0, 0];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (isPiece(grid[r][c])) count[grid[r][c].el]++;
  }
  for (let el = 0; el < ELEMENTS.length; el++) {
    while (count[el] < 3) {
      let maxEl = 0;
      for (let i = 1; i < ELEMENTS.length; i++) if (count[i] > count[maxEl]) maxEl = i;
      if (maxEl === el || count[maxEl] <= 3) return false; // 无法满足（调用方须先补棋子）
      outer:
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (isPiece(grid[r][c]) && grid[r][c].el === maxEl) {
          grid[r][c].el = el; count[maxEl]--; count[el]++;
          break outer;
        }
      }
    }
  }
  return true;
}

// 洗牌：重排棋子（道具格保留原位不动）+ 配额 + 双验证；返回是否得到合法终态
export function shuffleGrid(grid, rng) {
  const pieces = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (isPiece(grid[r][c])) pieces.push(grid[r][c].el);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    // 洗牌（Fisher-Yates）
    for (let i = pieces.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
    }
    const trial = emptyGrid();
    let k = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (isPiece(grid[r][c])) trial[r][c] = { el: pieces[k++] };
      else if (isItem(grid[r][c])) trial[r][c] = grid[r][c]; // 道具原位保留
    }
    if (!enforceQuota(trial, rng)) continue;
    if (hasNoMatches(trial) && hasValidSwap(trial)) {
      // 回写
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) grid[r][c] = trial[r][c];
      return true;
    }
  }
  return false;
}
