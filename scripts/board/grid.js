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
export const BOARD_Y = 504;           // 棋盘顶部逻辑 y（00 文档第 3 节）

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

// 单格放置时避免与左二/上二成三连（02 文档 FR-2.1 生成规则；下落补位同用，第 4 节）
export function safePickRefill(rng, grid, r, c) {
  const banned = new Set();
  if (c >= 2 && isPiece(grid[r][c-1]) && isPiece(grid[r][c-2]) &&
      grid[r][c-1].el === grid[r][c-2].el) banned.add(grid[r][c-1].el);
  if (r >= 2 && isPiece(grid[r-1][c]) && isPiece(grid[r-2][c]) &&
      grid[r-1][c].el === grid[r-2][c].el) banned.add(grid[r-1][c].el);
  const options = ELEMENTS.map((_, i) => i).filter(i => !banned.has(i));
  return options[Math.floor(rng() * options.length)];
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

// 找出全部匹配连通块（横/竖 ≥3 同元素；交叉 L/T 由并查合并为一块）
// 返回: [{el, cells: [{r,c},...]}]
export function findMatchBlocks(grid) {
  const marks = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  const groups = [];
  // 横向
  for (let r = 0; r < ROWS; r++) {
    let run = 1;
    for (let c = 1; c <= COLS; c++) {
      const same = c < COLS && isPiece(grid[r][c]) && isPiece(grid[r][c-1]) &&
                   grid[r][c].el === grid[r][c-1].el;
      if (same) { run++; continue; }
      if (run >= 3) {
        const cells = [];
        for (let k = c - run; k < c; k++) { marks[r][k] = true; cells.push({r, c: k}); }
        groups.push({ el: grid[r][c-1].el, cells, dir: 'h' });
      }
      run = 1;
    }
  }
  // 纵向
  for (let c = 0; c < COLS; c++) {
    let run = 1;
    for (let r = 1; r <= ROWS; r++) {
      const same = r < ROWS && isPiece(grid[r][c]) && isPiece(grid[r-1][c]) &&
                   grid[r][c].el === grid[r-1][c].el;
      if (same) { run++; continue; }
      if (run >= 3) {
        const cells = [];
        for (let k = r - run; k < r; k++) { marks[k][c] = true; cells.push({r: k, c}); }
        groups.push({ el: grid[r-1][c].el, cells, dir: 'v' });
      }
      run = 1;
    }
  }
  if (!groups.length) return [];
  // 交叉合并：共享格子的横竖组并查合并为一个连通块（count = 参与格数，02 文档第 3 节）
  const parent = groups.map((_, i) => i);
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { parent[find(a)] = find(b); }
  const cellGroups = new Map(); // cellKey -> [groupIdx...]
  groups.forEach((g, i) => g.cells.forEach(k => {
    const key = k.r * COLS + k.c;
    if (cellGroups.has(key)) union(i, cellGroups.get(key)[0]);
    (cellGroups.get(key) || cellGroups.set(key, []).get(key)).push(i);
  }));
  const merged = new Map(); // root -> {el, Set<cellKey>}
  groups.forEach((g, i) => {
    const root = find(i);
    if (!merged.has(root)) merged.set(root, { el: g.el, cells: new Set() });
    for (const k of g.cells) merged.get(root).cells.add(k.r * COLS + k.c);
  });
  return [...merged.values()].map(m => ({
    el: m.el,
    cells: [...m.cells].map(k => ({ r: Math.floor(k / COLS), c: k % COLS })),
  }));
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
