// scripts/board/engine.js
// 三消棋盘状态机：IDLE/SWAPPING/RESOLVING/FALLING/SETTLE(+PARALYZED)
// 规则依据: docs/design/02-三消玩法设计.md（输入策略=忽略、事件逐轮即发、
//          道具移除走标准下落、洗牌恢复链、连锁 chain 逐轮 +1）
// 纯逻辑无 DOM，可在 Node 单测（终态一致性依赖固定种子 = 相同模拟时钟）。
// 相对路径: scripts/board/engine.js

import {
  ROWS, COLS, CELL, ELEMENTS, makeRng, emptyGrid, isPiece, isItem,
  generateGrid, findMatchBlocks, hasNoMatches, hasValidSwap,
  shuffleGrid, enforceQuota, safePickRefill,
} from './grid.js';
import { rollItem, placeItem, tickItems } from './items.js';

export const STATE = {
  IDLE: 'IDLE', SWAPPING: 'SWAPPING', REBOUND: 'REBOUND',
  RESOLVING: 'RESOLVING', FALLING: 'FALLING', PARALYZED: 'PARALYZED',
};

const SWAP_TIME = 0.15;     // 交换/回弹动画（02 文档第 2 节 0.15s）
// M11 演出期并发并行交换上限(需求方 2026-10-17「任何时刻都必须可以操作」):
// RESOLVING/FALLING 中交换立即受理写回 grid,动画槽最多 3 个,占满转预输入缓冲
const PARALLEL_MAX = 3;
// 消除演出四段(02 文档 3.1,总 0.9s):①吸收聚集 0.35 ②合成闪光 0.15 ③图标浮现 0.25 ④爆发施放 0.15
const STAGE_ABSORB = 0.35, STAGE_FLASH = 0.15, STAGE_ICON = 0.25, STAGE_BURST = 0.15;
const CLEAR_TIME_FX = STAGE_ABSORB + STAGE_FLASH + STAGE_ICON + STAGE_BURST; // 0.9s(动效开)
const CLEAR_TIME = 0.20;    // 消除动画(动效关退化时长,02 文档 3.1)
const FALL_TIME_PER_CELL = 0.08; // 下落 80ms/格（02 文档第 4 节）
const MAX_CHAIN = 50;            // 连锁防御上限(理论不可达;防补位残余非零概率病态循环,REQ-M6 批次 A)
// M9 连锁 RUSH(需求方 2026-10-17:连锁越大合成消除与补块越快,「进入 rush」):
// 消除演出总时长/四段时长/下落时长全部乘 rushScale(chain)——数字例:chain1=1.00/2=0.85/3=0.70/4=0.55/≥5=0.45(封底)
const RUSH_STEP = 0.15, RUSH_MIN = 0.45;

export class BoardEngine {
  constructor(seed = 20260601) {
    this.rng = makeRng(seed);
    this.fxEnabled = true;     // 动效开关(设置;false 时消除演出退化 0.20s 淡出,02 文档 3.1)
    this.grid = null;
    this.state = STATE.IDLE;
    this.chain = 0;
    this.events = [];          // {type:'match_cleared',element,count,chain} 等，外部 drain
    this.fx = { swapA: null, swapB: null, t: 0, back: false };
    this.clearing = [];        // [{r,c,t}]
    this.falls = [];           // [{r,c,fromY}]  渲染用偏移
    this.paralyzed = false;
    this.roundSeq = 0;         // 消除轮次序号(每 _beginRound +1;预约盖章所属轮,跨轮不误认领新块 REQ-08 F8)
    this.paralyzeT = 0;        // 瘫痪态定时重试计时（02 文档第 8 节恢复转移）
    this.pendingItemRemovals = []; // RESOLVING/FALLING 期间被移除的道具格，落定后补位
    this.parallelSwaps = [];   // M11:演出期并行交换动画 [{a,b,t}](最多 PARALLEL_MAX 个;grid 已即时交换)
                               // (M9 单槽 parallelSwap 升级为数组——需求方「任何时刻都必须可以操作」)
    this.swapBuffer = null;    // M9:忙时预输入缓冲 {a,b}(只留最新意图;回 IDLE 自动执行)
    this.rush = 1;             // M9:本轮 rushScale(渲染/测试读取)
    this.stageDur = null;      // M9:本轮四段时长(按 rush 缩放;cellsForRender 读实例不再读常量)
    this._init();
  }

  // M9 连锁 RUSH 缩放(02 文档 3.1):chain1=1.00/2=0.85/3=0.70/4=0.55/≥5=0.45 封底
  rushScale(chain) {
    return chain <= 1 ? 1 : Math.max(RUSH_MIN, 1 - RUSH_STEP * (chain - 1));
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

  // M11-02 F9 整改:局界重置(放弃后重开/新局入口调用)——清空全部演出/缓冲/事件状态并
  // 重新生成棋盘。修复缺陷:放弃仅切屏不清理,演出或缓冲期间放弃后再出战会继续旧局轮次
  // (clearing/falls 残留)、旧预输入缓冲 swapBuffer 自动执行。终局快进收口只保证到 IDLE,
  // 不覆盖「非终局路径放弃」(暂停面板 quit 在 RESOLVING/FALLING 中直接切 menu)。
  resetBoard() {
    this.state = STATE.IDLE;
    this.chain = 0;
    this.events = [];
    this.fx = { swapA: null, swapB: null, t: 0, back: false };
    this.clearing = [];
    this.falls = [];
    this.fallT = 0; this.fallTotal = 0;
    this.paralyzed = false;
    this.paralyzeT = 0;
    this.pendingItemRemovals = [];
    this.parallelSwaps = [];
    this.swapBuffer = null;
    this.nudgeFx = null;
    this.blockFx = new Map();
    this.roundSeq = 0;
    this.rush = 1;
    this.stageDur = null;
    this.clearTotal = 0;
    this.clearFxAtStart = undefined;
    this._init(); // 重新生成棋盘(双验证;失败瘫痪兜底)
  }

  // ---------- 输入(02 文档第 7 节,M9/M11 修订:演出期随时可操作) ----------
  // IDLE=正常交换;RESOLVING/**FALLING**=**并行交换**(M11:任意相邻非空对立即受理写回 grid——
  // RESOLVING 被消格已置 null 其余格静止,FALLING grid 已是落定终态,均不再要求「立即成消」:
  // 成消并入连锁下一环(_beginRound 统一判定),不成消则断连锁回 IDLE,均为策略空间;
  // 动画槽最多 PARALLEL_MAX 个,占满转预输入缓冲);SWAPPING/REBOUND=预输入缓冲
  // (0.15s 短动画,只留最新意图,回 IDLE 自动执行)。
  trySwap(a, b) {
    if (this.paralyzed) return false;
    if (Math.abs(a.r - b.r) + Math.abs(a.c - b.c) !== 1) return false;
    const A = this.grid[a.r]?.[a.c], B = this.grid[b.r]?.[b.c];
    if (!A || !B) return false;
    if (this.state === STATE.IDLE) {
      // 道具可自由换位；纯棋子交换必须产生新匹配，否则回弹
      const itemInvolved = isItem(A) || isItem(B);
      if (!itemInvolved && !this._swapCreatesMatchFrom(a, b)) return false;
      [this.grid[a.r][a.c], this.grid[b.r][b.c]] = [B, A];
      this.state = STATE.SWAPPING;
      this.fx = { swapA: a, swapB: b, t: SWAP_TIME, back: false };
      return true;
    }
    if (this.state === STATE.RESOLVING || this.state === STATE.FALLING) {
      // M11:任意相邻非空对立即受理(不再要求成消);动画槽占满 → 预输入缓冲(最新意图优先)
      if (this.parallelSwaps.length >= PARALLEL_MAX) {
        this.swapBuffer = { a: { r: a.r, c: a.c }, b: { r: b.r, c: b.c } };
        return true;
      }
      // M11-02 F8 整改:同格不重复占用——新槽受理前终止与 a/b 重叠的旧槽
      // (grid 已即时交换,旧槽动画立即作废,由新槽呈现;修复前同格可挂多条槽,
      // cellsForRender 逐条累加偏移,同一对连点两次偏移达 ±180px)
      this.parallelSwaps = this.parallelSwaps.filter(ps =>
        !((ps.a.r === a.r && ps.a.c === a.c) || (ps.a.r === b.r && ps.a.c === b.c) ||
          (ps.b.r === a.r && ps.b.c === a.c) || (ps.b.r === b.r && ps.b.c === b.c)));
      [this.grid[a.r][a.c], this.grid[b.r][b.c]] = [B, A];
      this.parallelSwaps.push({ a: { r: a.r, c: a.c }, b: { r: b.r, c: b.c }, t: SWAP_TIME });
      return true;
    }
    if (this.state === STATE.SWAPPING || this.state === STATE.REBOUND) {
      this.swapBuffer = { a: { r: a.r, c: a.c }, b: { r: b.r, c: b.c } };
      return true;
    }
    return false;
  }

  // 回 IDLE 时执行预输入缓冲(最新意图;失败=无效交换走 nudge 表现层弹回)
  _flushBuffer() {
    const buf = this.swapBuffer;
    this.swapBuffer = null;
    if (!buf || this.state !== STATE.IDLE || this.paralyzed) return;
    if (!this.trySwap(buf.a, buf.b)) this.nudge(buf.a, buf.b);
  }

  // 点选无效交换的表现层弹回(REQ-M6-05 F7 续审):**不进状态机**(逻辑状态保持不变,
  // 02 文档第 7 节禁止无效交互产生 REBOUND 转移),仅登记往返回弹动画数据 nudgeFx,
  // 由 cellsForRender 消费:位移=出~31px 再原路返回(正弦包络,真实往返);
  // 期间仅 a/b 两格锁定(main 输入层按 nudgeFx 拒绝),其他格照常可操作。
  // M9:RESOLVING 演出期放开(并行交换的无效回弹,IDLE 语义不变)。
  nudge(a, b) {
    if (this.paralyzed) return false;
    if (this.state !== STATE.IDLE && this.state !== STATE.RESOLVING) return false;
    if (Math.abs(a.r - b.r) + Math.abs(a.c - b.c) !== 1) return false;
    this.nudgeFx = { a: { r: a.r, c: a.c }, b: { r: b.r, c: b.c }, t: SWAP_TIME, total: SWAP_TIME };
    return true;
  }

  _swapCreatesMatchFrom(a, b) {
    const g = this.grid.map(row => row.slice());
    [g[a.r][a.c], g[b.r][b.c]] = [g[b.r][b.c], g[a.r][a.c]];
    const blocks = findMatchBlocks(g);
    return blocks.some(bl => bl.cells.some(k =>
      (k.r === a.r && k.c === a.c) || (k.r === b.r && k.c === b.c)));
  }

  // 道具点击(M11 修订:任何时刻都可操作——IDLE 即时生效走标准下落补位;RESOLVING 移除后
  // 与本轮消除合并,由 _afterClear→_applyFalls 统一补位;FALLING/SWAPPING/REBOUND grid 已是
  // 落定终态,移除后原地静默补新(safePick,新子随既有下落/交换动画呈现);PARALYZED 不可点
  // ——瘫痪恢复链自身管理道具超时,02 文档第 8 节)
  tapItem(cell) {
    if (this.paralyzed) return null;
    const c = this.grid[cell.r]?.[cell.c];
    if (!isItem(c)) return null;
    this.grid[cell.r][cell.c] = null;
    if (this.state === STATE.IDLE) {
      this.pendingItemRemovals.push(cell);
      this._refillAfterRemovals();
    } else if (this.state !== STATE.RESOLVING) {
      // FALLING/SWAPPING/REBOUND:原地补新(不改动 falls/fallT——该位既有位移动画照播)
      this.grid[cell.r][cell.c] = { el: safePickRefill(this.rng, this.grid, cell.r, cell.c) };
    }
    // RESOLVING:留空,随本轮 _afterClear→_applyFalls 与被消格一起补位
    return c;
  }

  // ---------- 主推进 ----------
  update(dt) {
    // 点选无效弹回动画计时(纯表现层,不依赖状态机;REQ-M6-05 F7)
    if (this.nudgeFx) { this.nudgeFx.t -= dt; if (this.nudgeFx.t <= 0) this.nudgeFx = null; }
    // M9/M11:RESOLVING/FALLING 演出期并行交换动画计时(纯表现;grid 已在 trySwap 即时交换)
    if (this.parallelSwaps.length) {
      this.parallelSwaps = this.parallelSwaps.filter(ps => (ps.t -= dt) > 0);
    }
    switch (this.state) {
      case STATE.SWAPPING:
      case STATE.REBOUND:
        this.fx.t -= dt;
        if (this.fx.t <= 0) this._afterSwapAnim();
        break;
      case STATE.RESOLVING:
        // REQ-M6-06 F8a:加速衰减**仅限「开启动效中途中关闭」的轮**(clearFxAtStart=true)——
        // 从关闭状态启动的轮总时长本就是 0.20s,不得再按 4.5× 扣成 0.044s
        const decayMul = (!this.fxEnabled && this.clearFxAtStart) ? CLEAR_TIME_FX / CLEAR_TIME : 1;
        for (const cl of this.clearing) cl.t -= dt * decayMul;
        if (this.clearing.every(cl => cl.t <= 0)) this._afterClear();
        break;
      case STATE.FALLING:
        this._stepFall(dt);
        break;
      default: break;
    }
    // 道具倒计时（02 文档第 6 节：10s 超时；瘫痪态同样倒计时，超时是恢复链的一环）
    if (this.state === STATE.IDLE) {
      const expired = tickItems(this.grid, dt);
      for (const cell of expired) this.pendingItemRemovals.push(cell);
      if (expired.length) this._refillAfterRemovals();
    }
    // 瘫痪态恢复转移（02 文档第 8 节）：道具超时移除即时重试 + 每 2s 定时重试一轮
    if (this.state === STATE.PARALYZED) {
      this.paralyzeT += dt;
      const expired = tickItems(this.grid, dt);
      if (expired.length) {
        for (const cell of expired) this.grid[cell.r][cell.c] = null;
        this._applyFalls(); // 标准下落补位（瘫痪态瞬时完成，不播动画）
        this.falls = [];
        this._paralyzeRetry();
      }
      if (this.paralyzed && this.paralyzeT >= 2) {
        this.paralyzeT -= 2;
        this._paralyzeRetry();
      }
    }
  }

  _afterSwapAnim() {
    if (this.fx.back) { this.state = STATE.IDLE; this._flushBuffer(); return; }
    // 检查匹配（道具不参与）
    this.chain = 1;
    this._beginRound();
  }

  _beginRound() {
    const blocks = findMatchBlocks(this.grid);
    if (!blocks.length) { this.state = STATE.IDLE; this._onSettle(); this._flushBuffer(); return; }
    // M9 连锁 RUSH:总时长/四段时长/段①错峰全部乘 rushScale(chain)——chain 越大演出越快(02 文档 3.1);
    // **先于事件发出**(match_cleared 事件携带 floor=本轮段④起点偏移,M9-F2:释放执行门槛随轮缩放)
    const rs = this.rushScale(this.chain);
    this.rush = rs;
    this.stageDur = {
      absorb: STAGE_ABSORB * rs, flash: STAGE_FLASH * rs, icon: STAGE_ICON * rs, burst: STAGE_BURST * rs,
    };
    // M9 连锁播报(需求方 2026-10-17:王者「N连XX」屏幕播报;chain≥2 触发,main 转发 fx 层)
    if (this.chain >= 2) this.events.push({ type: 'chain_announce', chain: this.chain });
    // 块-事件-预约绑定(REQ-M6-05 F8):每块一个稳定键 bk(本轮内唯一),事件与演出格都携带;
    // main 逐事件预约后经 setBlockFx 回填实际选技结果,渲染段③按 bk 读本块自己的预约/蓄能
    // (不再按元素全局找第一个 pending——同元素双块不同技能/单候选第二块蓄能各自正确)。
    this.roundSeq++; // 预约认领的所属轮次基准(REQ-08 F8:跨轮存续预约不得认领新轮块)
    this.blockFx = new Map();
    blocks.forEach((b, bi) => this.blockFx.set(`b${bi}`, { el: ELEMENTS[b.el], reserved: false }));
    // 发事件（逐轮即发，02 文档 5.1；每连通块一事件；r/c 为表现层粒子发射点;
    // floor=本轮段④起点偏移(相对 t0)——charge 在档位首次充入时保存(earliestFloor 留池),
    // reserveFor 转池时写入预约 execFloor 供 cast 释放门槛用,M9-F2)
    blocks.forEach((b, bi) => {
      this.events.push({ type: 'match_cleared', element: ELEMENTS[b.el], count: b.cells.length, chain: this.chain, r: b.cells[0].r, c: b.cells[0].c, bk: `b${bi}`, floor: this.stageDur.absorb + this.stageDur.flash + this.stageDur.icon });
    });
    // 消耗品生成（按单事件 count：4→普通、≥5→高级；02 文档 5.1/6）
    const cleared = [];
    const gridElBeforeClear = new Map();
    for (const b of blocks) for (const k of b.cells) {
      gridElBeforeClear.set(k.r * COLS + k.c, this.grid[k.r][k.c]?.el);
      this.grid[k.r][k.c] = null;
      cleared.push(k);
    }
    for (const b of blocks) {
      if (b.cells.length >= 4) {
        const item = rollItem(b.cells.length, this.rng);
        placeItem(this.grid, cleared, item, this.rng);
      }
    }
    // 消除演出(M6 v0.2 02 文档 3.1):每连通块一个质心,段①各格向质心汇聚;事件已于上文发出(演出起点=事件确立)。
    // rush/stageDur 已在事件发出前计算(本方法开头)
    const blockOf = new Map(); // cellKey -> 质心 {r,c} + 块键 bk
    blocks.forEach((b, bi) => {
      const cr = b.cells.reduce((a, k) => a + k.r, 0) / b.cells.length;
      const cc = b.cells.reduce((a, k) => a + k.c, 0) / b.cells.length;
      for (const k of b.cells) blockOf.set(k.r * COLS + k.c, { r: cr, c: cc, bk: `b${bi}` });
    });
    const total = this.fxEnabled ? CLEAR_TIME_FX * rs : CLEAR_TIME * rs;
    this.clearFxAtStart = this.fxEnabled; // F8 续审:记录本轮演出起始动效状态(中途关闭才加速收口)
    this.clearTotal = total;
    this.clearing = cleared.map(k => ({
      ...k, t: total,
      el: gridElBeforeClear.get(k.r * COLS + k.c),
      cx: blockOf.get(k.r * COLS + k.c)?.r ?? k.r,
      cc: blockOf.get(k.r * COLS + k.c)?.c ?? k.c,
      bk: blockOf.get(k.r * COLS + k.c)?.bk ?? null,
      delay: 0, // 段①错峰(≤80ms),下方按块内序号填充
    }));
    // 段①错峰启动(02 文档 3.1:≤80ms×rush):按块内格子序号线性铺开,全部格仍于段①内完成
    for (const b of blocks) {
      const cells = b.cells;
      cells.forEach((k, i) => {
        const cl = this.clearing.find(x => x.r === k.r && x.c === k.c);
        if (cl) cl.delay = cells.length > 1 ? (i * 0.08 * rs) / (cells.length - 1) : 0;
      });
    }
    this.state = STATE.RESOLVING;
  }

  // 回填某块的实际预约结果(main 逐事件消费后调用;REQ-M6-05 F8)
  setBlockFx(bk, info) {
    if (bk && this.blockFx?.has(bk)) this.blockFx.set(bk, info);
  }

  // 认领绑定(REQ-M6-07/08 F8):把预约唯一认领到**第一个未认领的同元素块**。
  // 幂等(REQ-08 F8):带 resKey(预约唯一 id)重复回写时,若该预约已绑定任一块则直接返回
  // true 不再扩散——同轮双块单候选场景,每帧存续预约回写不得把第二个块也标成已预约;
  // 执行记录回写(used.resKey)与事件入口/存续预约回写共用同一 resKey,三者幂等互不覆盖。
  // 覆盖延迟选技全场景——0.10s(事件入口)/0.60s(tick 回落预约存续)/0.80s(预约建立后
  // 同帧即执行移除,渲染层查不到 pending,只能按执行记录认领);认领持久,渲染段③④按块显示。
  claimBlockFx(el, skillId, tier, resKey = null) {
    if (resKey) {
      for (const [, s] of this.blockFx || []) {
        if (s.resKey === resKey) return true; // 本预约已绑定:幂等返回,不换块不扩散
      }
    }
    for (const [bk, s] of this.blockFx || []) {
      if (!s.reserved && s.el === el) {
        this.setBlockFx(bk, { el, reserved: true, skillId, tier, resKey });
        return true;
      }
    }
    return false;
  }

  _afterClear() {
    this.clearing = [];
    this.parallelSwaps = []; // M9-F3/M11:演出结束并行动画一并收口(极限 rush 下动画未播完即截断,grid 已交换、内容瞬间到位)
    this._applyFalls();
    this.state = STATE.FALLING;
  }

  // 标准下落补位：每列非空格（棋子+道具）保持顺序沉降，顶部 safePick 补新（02 文档第 4 节/B3）
  // 收集自底向上,回写必须自顶向下(kept 反转)——此前直接写回导致未消除列整列上下翻转(REQ-M2-05 基线缺陷)
  _applyFalls() {
    const moves = []; // {r,c,dist}
    for (let c = 0; c < COLS; c++) {
      // 快照本列旧内容（自底向上,带真实旧行号——底部被消除时 kept 不贴底,不能用 ROWS-1-i 反推）
      const oldCol = [];
      for (let r = ROWS - 1; r >= 0; r--) oldCol.push({ cell: this.grid[r][c], row: r });
      // 新列：顶部空位补新(占位),kept 反转为自顶向下接在后面 → 列内相对顺序保持
      const kept = oldCol.filter(x => x.cell !== null);
      const newCount = ROWS - kept.length;
      const newCol = [];
      for (let i = 0; i < newCount; i++) newCol.push({ el: 0, _fresh: true });
      for (let i = kept.length - 1; i >= 0; i--) newCol.push(kept[i].cell);
      for (let r = 0; r < ROWS; r++) this.grid[r][c] = newCol[r];
      // 顶部补位用 safePick（此时列下方已是最终态；跨列左二依赖已处理列）
      for (let r = 0; r < newCount; r++) {
        this.grid[r][c] = { el: safePickRefill(this.rng, this.grid, r, c) };
      }
      // 位移 = 新行 − 旧行（kept 记录真实旧行号;保留棋子与补位新子都生成位移）
      for (const { cell, row: oldR } of kept) {
        const newR = this.grid.findIndex(row => row[c] === cell);
        if (newR !== oldR) moves.push({ r: newR, c, dist: newR - oldR });
      }
      for (let r = 0; r < newCount; r++) moves.push({ r, c, dist: newCount - r });
    }
    const maxDist = Math.max(1, ...moves.map(m => m.dist));
    this.falls = moves;
    // M9 连锁 RUSH:下落时长乘 rushScale(chain)——chain1(首轮消除后)=1.00,chain2 起 0.85/0.70/…(tapItem 补位 chain=0 同 1.00)
    this.fallT = maxDist * FALL_TIME_PER_CELL * this.rushScale(this.chain);
    this.fallTotal = this.fallT;
  }

  _stepFall(dt) {
    this.fallT -= dt;
    if (this.fallT > 0) return;
    this.falls = [];
    this.chain++;
    if (this.chain >= MAX_CHAIN) {
      // 防御上限(REQ-M6 批次 A):补位已按 M6 口径规避新匹配,理论上连锁有限;
      // 交叉列合并等残余非零概率的病态循环以此硬性终止(不再消除,直接终态校验)。
      this.chain = 0;
      this.state = STATE.IDLE;
      this._onSettle();
      this._flushBuffer();
      return;
    }
    this._beginRound(); // 连锁判定（无匹配则回 IDLE + SETTLE）
  }

  // 道具移除后补位（等价一次单格下落，02 文档第 6 节「移除后走标准下落补位」）
  _refillAfterRemovals() {
    if (this.state === STATE.IDLE) {
      this.chain = 0; // M9-F6:先归零再编排下落(补位下落不构成连锁升级;修复前 _applyFalls 读到上一轮 chain 而误乘 rushScale)
      this._applyFalls();
      this.state = STATE.FALLING;
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
    if (this._tryRegenerate()) return;
    this.paralyzed = true;
    this.state = STATE.PARALYZED;
    this.paralyzeT = 0;
    this.events.push({ type: 'board_paralyzed' });
  }

  // 重新生成 50 次（开局同规则+双验证，道具格保留原位）；成功回写 grid 返回 true
  _tryRegenerate() {
    for (let i = 0; i < 50; i++) {
      const reserved = [];
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (isItem(this.grid[r][c])) reserved.push({ r, c });
      }
      const g = generateGrid(this.rng, reserved);
      if (hasNoMatches(g) && hasValidSwap(g)) { this.grid = g; return true; }
    }
    return false;
  }

  // 瘫痪态恢复转移（02 文档第 8 节）：洗牌 3 次 + 重生成 50 次为一轮；
  // 每 2s 定时触发一轮（+道具过期即时触发），各轮独立抽样，无次数上限——
  // 单轮成功率 P>0 时失败 k 轮概率 (1-P)^k → 0，恢复时间以实测数字例标定（见 02 文档）。
  _paralyzeRetry() {
    if (!this.paralyzed) return;
    for (let i = 0; i < 3; i++) {
      if (shuffleGrid(this.grid, this.rng)) return this._recover();
    }
    if (this._tryRegenerate()) this._recover();
  }

  _recover() {
    this.paralyzed = false;
    this.state = STATE.IDLE;
    this.paralyzeT = 0;
    this._flushBuffer();
  }

  _tryRecover() {
    if (!this.paralyzed) return;
    this._paralyzeRetry();
  }

  // ---------- 渲染辅助 ----------
  // 返回 [{r,c,el|item,offsetX,offsetY,alpha,scale,flash}]:
  // offsetX/Y 为交换动画偏移(交换含水平分量,修复水平交换误用垂直偏移),下落为 offsetY;
  // alpha/scale/flash 为消除淡出参数。
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
        let offsetX = 0, offsetY = 0, alpha = 1, scale = 1, flash = 0, stage = 0, jx = 0, jy = 0;
        const fm = this.falls.find(m => m.r === r && m.c === c);
        if (fm && fallProgress < 1) offsetY = -fm.dist * 90 * (1 - easeOutCubic(fallProgress));
        // M11:演出期并行交换偏移(grid 已即时交换,A 格内容=原 B 子,从 B 位置滑向 A 位置:
        // 起点偏移=±(dirC,dirR)×CELL,随进度归 0;M9-F3 修正,修复前 0→90px 反向跳变;
        // M11-02 F8 整改:每格只应用**最新一条**涉及槽(倒序取首个匹配即 break)——
        // trySwap 已保证槽间不共享格,此处为渲染层防御;修复前逐条累加,
        // 同格挂多槽时偏移叠加(同对连点两次 → ±180px 与 grid 状态矛盾)
        for (const ps of [...this.parallelSwaps].reverse()) {
          const q = Math.max(0, ps.t) / SWAP_TIME; // 剩余比例 1→0
          const prog = easeInOutQuad(1 - q); // 滑动进度 0→1
          const k = 1 - prog; // 偏移系数 1→0(起点=对方位置满幅,归 0=到位;M9-F3)
          const dirR = ps.b.r - ps.a.r, dirC = ps.b.c - ps.a.c;
          if (r === ps.a.r && c === ps.a.c) { offsetX += dirC * 90 * k; offsetY += dirR * 90 * k; break; }
          if (r === ps.b.r && c === ps.b.c) { offsetX += -dirC * 90 * k; offsetY += -dirR * 90 * k; break; }
        }
        // 点选无效弹回(REQ-M6-05 F7):状态保持 IDLE,纯位移叠加——
        // 正弦包络出~31px(90×0.35)再原路返回(真实往返),仅 a/b 两格
        if (this.nudgeFx) {
          const nf = this.nudgeFx;
          const p = 1 - Math.max(0, nf.t) / nf.total;
          const disp = Math.sin(Math.PI * p) * 90 * 0.35;
          const dirR = nf.b.r - nf.a.r, dirC = nf.b.c - nf.a.c;
          if (r === nf.a.r && c === nf.a.c) { offsetX += dirC * disp; offsetY += dirR * disp; }
          if (r === nf.b.r && c === nf.b.c) { offsetX += -dirC * disp; offsetY += -dirR * disp; }
        }
        if (this.state === STATE.SWAPPING || this.state === STATE.REBOUND) {
          const { swapA: A, swapB: B } = this.fx;
          if (A && B) {
            const dirR = B.r - A.r, dirC = B.c - A.c;
            const t = this.fx.back ? swapProgress : 1 - swapProgress; // 交换进度(A→B);回弹反向
            const amp = this.fx.amp ?? 1; // 点选无效弹回=半程往返(F7);正常交换=全程
            if (r === A.r && c === A.c) {
              offsetX += dirC * 90 * t * amp;
              offsetY += dirR * 90 * t * amp;
            }
            if (r === B.r && c === B.c) {
              offsetX += -dirC * 90 * t * amp;
              offsetY += -dirR * 90 * t * amp;
            }
          }
        }
        // 消除中的格已在 grid 置 null,不在本循环;演出状态在下方 clearing 附加输出
        void stage; void jx; void jy;
        out.push({ r, c, ...cell, offsetX, offsetY, alpha, scale, flash, stage: 0 });
      }
    }
    // 消除演出格(M6 v0.2 02 文档 3.1):被消格已从 grid 移除,按四段插值单独输出
    // ①吸收=贝塞尔曲线向质心汇聚(错峰 ≤80ms,挤压形变随距离增强);
    // ②合成闪光=质心位白闪收缩到 0.5(粒子迸发由渲染层一次性触发);
    // ③图标浮现=质心位半透明缩聚(技能图标由渲染层**状态驱动**逐帧绘制,F8);
    // ④爆发=图标放大 1.3 倍碎裂+径向光效(图标/光效由渲染层绘制)。
    for (const cl of this.clearing) {
      const sd = this.stageDur || { absorb: STAGE_ABSORB, flash: STAGE_FLASH, icon: STAGE_ICON, burst: STAGE_BURST };
      const elapsed = Math.max(0, this.clearTotal - cl.t);
      let alpha = 1, scale = 1, flash = 0, stage = 0, jx = 0, jy = 0, sx = 1, sy = 1;
      if (!this.fxEnabled) {
        alpha = Math.min(1, Math.max(0, this.clearTotal > 0 ? cl.t / this.clearTotal : 0));
        scale = 0.4 + 0.6 * alpha;
        flash = alpha > 0.7 ? (alpha - 0.7) / 0.3 : 0;
      } else {
        const absT = sd.absorb - 0.08 * (this.rush || 1); // 段①净时长(错峰铺开后全部格仍于段①内完成;随 rush 同缩)
        const p1 = Math.min(1, Math.max(0, (elapsed - (cl.delay || 0)) / absT));
        const dist = Math.hypot(cl.cc - cl.c, cl.cx - cl.r);
        if (elapsed < sd.absorb) {
          // 段① 吸收聚集:二次贝塞尔(控制点=中点+法向偏移 0.35×距离)
          stage = 1;
          const dx = cl.cc - cl.c, dy = cl.cx - cl.r;
          const mx = cl.c + dx * 0.5 - dy * 0.35, my = cl.r + dy * 0.5 + dx * 0.35;
          const q = 1 - p1;
          jx = (q * q * cl.c + 2 * q * p1 * mx + p1 * p1 * cl.cc - cl.c) * CELL;
          jy = (q * q * cl.r + 2 * q * p1 * my + p1 * p1 * cl.cx - cl.r) * CELL;
          // 果冻挤压:沿运动方向拉伸、垂直压缩,幅度随距离与进度增强
          const k = 0.22 * p1 * Math.min(1, dist / 2);
          if (Math.abs(dx) >= Math.abs(dy)) { sx = 1 + k; sy = 1 - k * 0.6; } else { sy = 1 + k; sx = 1 - k * 0.6; }
        } else if (elapsed < sd.absorb + sd.flash) {
          // 段② 合成闪光:质心位,白闪+收缩到 0.5
          stage = 2;
          jx = (cl.cc - cl.c) * CELL; jy = (cl.cx - cl.r) * CELL;
          const p = (elapsed - sd.absorb) / sd.flash;
          alpha = 1;
          scale = 1 - 0.5 * p;
          flash = 0.5 + 0.5 * (1 - p);
        } else if (elapsed < sd.absorb + sd.flash + sd.icon) {
          // 段③ 图标浮现:质心位半透明缩聚(图标由渲染层按块状态驱动绘制)
          stage = 3;
          jx = (cl.cc - cl.c) * CELL; jy = (cl.cx - cl.r) * CELL;
          alpha = 0.15;
          scale = 0.5;
        } else {
          // 段④ 爆发施放:淡出消散(图标放大碎裂与径向光效由渲染层绘制)
          stage = 4;
          jx = (cl.cc - cl.c) * CELL; jy = (cl.cx - cl.r) * CELL;
          const p = (elapsed - sd.absorb - sd.flash - sd.icon) / sd.burst;
          alpha = Math.max(0, 1 - p);
          scale = 0.5 + 0.2 * p;
        }
      }
      out.push({ r: cl.r, c: cl.c, el: cl.el, offsetX: jx, offsetY: jy, alpha, scale, flash, stage, sx, sy, _clearing: true });
    }
    return out;
  }
}
