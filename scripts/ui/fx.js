// scripts/ui/fx.js
// 表现层特效:消除粒子爆裂 + 分数/连锁飞字(纯 Canvas,无依赖)
// 相对路径: scripts/ui/fx.js
// 数值: 粒子 ≤12/次、上限 200(00 文档 FR-1.5 粒子上限口径),飞字 0.9s 上浮 40px

import { BOARD_W, BOARD_H, BOARD_Y } from '../board/grid.js';
import { BATTLE_ASSET_BAR_H, GEM_COLORS as GEM_FLOAT, roundRect } from './draw_util.js'; // 五行色单一定义源(弹道与冒字共用,REQ-M7-01 F6)
import { BATTLE_H } from '../battle/parallax.js'; // 战斗区高度单一来源(喊话演出以战斗区为舞台)
import { ImpactEffects } from './combat_fx.js';
import { ItemEffects } from './item_fx.js';

// 伤害冒字样式表(03 文档 6.2a/6.2b;**全部五行语义色引用 draw_util GEM_COLORS 单一定义源**,
// REQ-M7-02 F6:灼烧/吸血/光环/护盾/状态标记不再硬编码;非五行语义色[免伤/受击/击破]为独立字面值)
// n 为实际变化量，el 为元素。状态贴图和文字共用一条飘字。
const FT_STYLE = {
  dmg:        { color: ev => GEM_FLOAT[ev.el] || '#ffffff', fmt: ev => `-${ev.n}`, imp: 1, size: 32 },
  splash:     { color: ev => GEM_FLOAT[ev.el] || '#ffffff', fmt: ev => `-${ev.n}`, imp: 0, size: 20 },
  burn:       { color: () => GEM_FLOAT.fire, fmt: ev => String(ev.n), icon: 'burn', fallback: '灼烧', imp: 0, size: 28 },
  bindDot:    { color: ev => GEM_FLOAT[ev.el] || GEM_FLOAT.wood, fmt: ev => String(ev.n), icon: 'bind', fallback: '束缚', imp: 0, size: 28 },
  leech:      { color: () => GEM_FLOAT.wood, fmt: ev => `+${ev.n}`, imp: 1, size: 32 },
  itemHeal:   { color: () => '#ffc5d6', fmt: ev => `+${ev.n}`, imp: 1, size: 32 },
  aura:       { color: () => GEM_FLOAT.wood, fmt: ev => `+${ev.n}`, imp: 0, size: 28 },
  shieldGain: { color: () => GEM_FLOAT.earth, fmt: ev => `+${ev.n}`, icon: 'shield', fallback: '护盾', imp: 1, size: 32 },
  absorb:     { color: () => GEM_FLOAT.earth, fmt: ev => String(ev.n), icon: 'shield', fallback: '吸收', imp: 1, size: 32 },
  hurt:       { color: () => '#ff8888', fmt: ev => `-${ev.n}`, imp: 1, size: 32 },
  immune:     { color: () => '#ffd700', fmt: () => `免伤`, imp: 2, size: 40 },
  kill:       { color: ev => ev.boss ? '#ffe0a0' : '#ffffff', fmt: ev => ev.boss ? '首领击破' : '击破', imp: 2, size: 40 },
  slowMark:   { color: () => GEM_FLOAT.water, fmt: () => '减速', icon: 'slow', imp: 0, size: 28 },
  bindMark:   { color: () => GEM_FLOAT.wood, fmt: () => '束缚', icon: 'bind', imp: 1, size: 28 },
  stunMark:   { color: () => GEM_FLOAT.earth, fmt: () => '眩晕', icon: 'stun', imp: 1, size: 28 },
};

// ===== M8 冒字运动参数(2026-10-17 需求方选定「方案 A 喷射衰减+暴击」;同日追加口径:整条一体)=====
// A 物理:高初速沿受击方向喷出 → 指数阻力急减速(液体阻力感)+ 微重力下垂;
// pop 过冲弹出后回落到 1.0 保持可读(**不缩小消失**,调研雷点规避);淡出集中末 30% 短窗口。
// 整条一体(替代原方案 E 逐位):「击破」/数值等多字文本**不拆位**,整串同帧起跳同步运动。
const FT_LIFE = 0.85;      // 基础寿命(秒)
const FT_LIFE_IMP2 = 1.1;  // imp2(免伤/击破,里程碑)寿命延长
const FT_POP_T = 0.14;     // pop 过冲窗口(scale 0.3→peak,easeOutBack)
const FT_SETTLE_T = 0.12;  // peak→1 回落窗口(无跳变)
const FT_DRAG = 3.2;       // 指数阻力系数(v ×= e^(-3.2·dt))
const FT_GRAV = 90;        // 微重力(px/s²,血滴下垂感)
const FT_FADE_FROM = 0.7;  // 生命进度 ≥0.7 开始淡出(末 30%)
const FT_V0_MULT = 4;      // 初速=speed×4(imp0 200/imp1 360/imp2 520 px/s)
const FT_LAYOUT_GAP = 4;
const FT_LAYOUT_SPEED = 260;
const CRIT_COLOR = '#ffd700';   // 暴击金(非五行语义,与免伤同金)
const CRIT_SIZE_MULT = 1.4;     // 暴击字号放大
const CRIT_PEAK = 1.38;         // 暴击 pop 过冲更强
const CRIT_LIFE = 1.25;         // 暴击存在时间延长(调研:暴击应延长存在)

function closestFreeCoordinate(blocked, desired, min, max, maxShift) {
  // 合并包含目标坐标的阻挡区间，再从两端选最近的空位。
  blocked.sort((a, b) => a.lo - b.lo);
  let lo = -Infinity, hi = -Infinity;
  for (const span of blocked) {
    if (span.lo > hi) {
      if (lo < desired && desired < hi) break;
      if (span.lo >= desired) return desired;
      lo = span.lo;
    }
    hi = Math.max(hi, span.hi);
  }
  if (desired <= lo || desired >= hi) return desired;
  const up = lo >= min && desired - lo <= maxShift ? desired - lo : Infinity;
  const down = hi <= max && hi - desired <= maxShift ? hi - desired : Infinity;
  if (!Number.isFinite(Math.min(up, down))) return null;
  return up <= down ? lo : hi;
}

// ===== M9 连锁播报(需求方 2026-10-17:王者「N连XX」屏幕定版播报)=====
// 文案=王者 2017 官方播报(二连击破/三连决胜/四连超凡/五连绝世),≥6 延伸「连锁狂潮 ×N」;
// 动效:0~0.12s 左滑入+easeOutBack 定版(0.3→1.15→1.0)→0.62s 停留(呼吸)→0.9s 上浮淡出;
// 光带在 0~0.25s 扫过，棋盘保持固定。
const ANNOUNCE_TABLE = [
  { min: 6, text: (c) => `连锁狂潮 ×${c}`, color: '#e05a5a' },
  { min: 5, text: () => '五连绝世', color: '#ffd700' },
  { min: 4, text: () => '四连超凡', color: '#f5a02c' },
  { min: 3, text: () => '三连决胜', color: '#b06fd8' },
  { min: 2, text: () => '二连击破', color: '#4aa8cc' },
];
const AN_LIFE = 0.9, AN_IN = 0.12, AN_HOLD = 0.62, AN_BAND = 0.25;

// easeOutBack 弹跳缓动(段 pop 过冲回落;REQ-M7-01 F3 沿用)
function easeOutBack(x, c1 = 1.70158) {
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// 离屏画布工厂(无 DOM 环境——单测/Node——返回 null,调用方守卫跳过绘制)
function _mkCanvas(w, h) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}

// 大立绘从屏幕左侧滑入，气泡和技能名随后弹出。
const CALL_CUT_T = 0.30, CALL_CUT_D = 0.03;
const CALL_BG_T = 0.50, CALL_BG_D = 0.05;
const CALL_HOLD = 0.50, CALL_EXIT_T = 0.35;        // 定格结束点/退场时长
const CALL_TOTAL = CALL_HOLD + CALL_EXIT_T;
const CAST_ARRIVAL = 0.16;
const CAST_FLIGHT_LIMIT = 8;
const CALL_CD = 2.0;                               // 喊话冷却:2s 内最多 1 次(需求方 2026-10-18;演出中再触发直接忽略)
const CALL_W = 720, CALL_H = BATTLE_H;             // 战斗区逻辑尺寸(高度取 parallax 单一定义源)
const CALL_PORTRAIT_H = Math.round(CALL_H * 1.08);
const CALL_PORTRAIT_DELAY = 0.10, CALL_PORTRAIT_ENTRY = 0.28, CALL_PORTRAIT_EXIT = 0.30;
const CALL_BUBBLE = { x: 296, y: 54, w: 440 };
const CALL_BUBBLE_DELAY = 0.26, CALL_BUBBLE_ENTRY = 0.26, CALL_BUBBLE_EXIT = 0.25;
const CALL_NAME_DELAY = 0.34, CALL_NAME_ENTRY = 0.16;
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

function callPortraitPose(t, hero) {
  if (!(hero?.naturalWidth > 0) || t <= CALL_PORTRAIT_DELAY || t >= CALL_HOLD + CALL_PORTRAIT_EXIT) return null;
  const width = CALL_PORTRAIT_H * hero.naturalWidth / hero.naturalHeight;
  const entry = Math.min(1, (t - CALL_PORTRAIT_DELAY) / CALL_PORTRAIT_ENTRY);
  const out = Math.max(0, (t - CALL_HOLD) / CALL_PORTRAIT_EXIT);
  const x = out > 0 ? -width * out ** 3 : width * (easeOutBack(entry, 0.9) - 1);
  const tilt = entry < 0.6 ? -6 + 8 * entry / 0.6 : 2 - 5 * (entry - 0.6) / 0.4;
  return { x, width, angle: tilt * Math.PI / 180 };
}

function callBubblePose(t, bubble) {
  if (t <= CALL_BUBBLE_DELAY || t >= CALL_HOLD + CALL_BUBBLE_EXIT) return null;
  const entry = Math.min(1, (t - CALL_BUBBLE_DELAY) / CALL_BUBBLE_ENTRY);
  const out = Math.max(0, (t - CALL_HOLD) / CALL_BUBBLE_EXIT);
  const height = bubble?.naturalWidth > 0 ? CALL_BUBBLE.w * bubble.naturalHeight / bubble.naturalWidth : CALL_BUBBLE.w * 2 / 3;
  return {
    height,
    scale: (0.3 + 0.7 * easeOutBack(entry, 1.2)) * (1 - 0.15 * out),
    alpha: Math.min(1, entry * 3) * (1 - out),
    ox: CALL_BUBBLE.x + 0.08 * CALL_BUBBLE.w,
    oy: CALL_BUBBLE.y + 0.70 * height,
  };
}

// M12 贴图表(初始全空;生产唯一填充入口=bindCallImages(main 预载成功后调用)——
// M11-03 F1 同口径:顶层零加载,启动期图片加载只发生在 preload 内)
export const CALL_IMG = { hero: null, bubble: null, bg: {} };
export function bindCallImages(map) {
  if (!map || typeof map.get !== 'function') return 0;
  let n = 0;
  CALL_IMG.hero = map.get('call:hero') || null;
  if (CALL_IMG.hero) n++;
  CALL_IMG.bubble = map.get('call:bubble') || null;
  if (CALL_IMG.bubble) n++;
  CALL_IMG.bg = {};
  for (const el of ['fire', 'water', 'wood', 'metal', 'earth']) {
    for (const v of [1, 2]) {
      const img = map.get(`call:bg:${el}:${v}`);
      if (img) { CALL_IMG.bg[`${el}:${v}`] = img; n++; }
    }
  }
  return n;
}

export class FxLayer {
  constructor() {
    this.particles = []; // 棋盘内的合成光点与爆发碎片
    this.castFlights = [];
    this.impacts = new ImpactEffects();
    this.itemEffects = new ItemEffects();
    this.floaters = [];  // {x,y,text,t,life,size,color}
    this.combatTexts = []; // v0.3 伤害冒字(上限 64 字符位;M8 A 整条一体运动/暴击,03 文档 6.1)
    this.combatTextLayout = new WeakMap();
    this.announces = [];   // M9 连锁播报 [{chain,text,color,t,life}](engine chain_announce 事件驱动)
    this.call = null;      // M12 技能喊话 {name,el,variant,t}(2s CD 内最多 1 次;CD 期/演出中再触发忽略)
    this.callCdT = 0;      // M12 喊话冷却剩余(触发即计时,含演出期)
    this._bgWork = null;   // 技能背景羽化离屏画布(惰性建,720×448)
    this._bgWorkCtx = null; // 其 2D context(_ensureBgWork 返回值)
  }

  // 消除粒子爆裂:cx/cy 格中心(逻辑坐标),el 元素名,count 消除数(越多越密);
  // cap 粒子上限(段②合成闪光 ≤8、段④径向光效 ≤12,02 文档 3.1)
  burst(cx, cy, el, count, cap = 12, shards = false) {
    const color = GEM_FLOAT[el] || '#fff';
    const n = Math.min(cap, 6 + count);
    const offset = Math.random() * Math.PI * 2;
    for (let i = 0; i < n && this.particles.length < 200; i++) {
      const a = offset + (i + Math.random() * 0.6) * Math.PI * 2 / n;
      const sp = (shards ? 150 : 65) + Math.random() * (shards ? 140 : 90);
      this.particles.push({
        x: cx + Math.cos(a) * 8, y: cy + Math.sin(a) * 8,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 45,
        t: 0, life: (shards ? 0.34 : 0.20) + Math.random() * 0.16,
        size: 3 + Math.random() * (shards ? 6 : 3), color, shards, angle: a,
      });
    }
  }

  flyCast(x, y, target, el) {
    const distance = Math.hypot(target.x - x, target.y - y);
    if (this.castFlights.length >= CAST_FLIGHT_LIMIT) this.castFlights.shift();
    this.castFlights.push({
      x, y, target,
      bendX: x + (target.x - x) * 0.35,
      bendY: target.y + Math.min(168, (y - target.y) * 0.45),
      color: GEM_FLOAT[el] || '#fff1c6',
      t: 0, travel: Math.min(0.38, 0.17 + distance / 3400),
    });
  }

  clearCastFlights() { this.castFlights.length = 0; }

  drawCastFlights(ctx) {
    if (!this.castFlights.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const f of this.castFlights) {
      const p = Math.min(1, f.t / f.travel);
      const fade = 1 - Math.max(0, f.t - f.travel) / CAST_ARRIVAL;
      const steps = 8;
      ctx.beginPath();
      let x, y;
      for (let i = 0; i <= steps; i++) {
        const k = Math.max(0, p - (1 - i / steps) * 0.16 * fade);
        const u = 1 - k;
        x = u * u * f.x + 2 * u * k * f.bendX + k * k * f.target.x;
        y = u * u * f.y + 2 * u * k * f.bendY + k * k * f.target.y;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.globalAlpha = 0.26 * fade;
      ctx.strokeStyle = '#2e2520';
      ctx.lineWidth = 16;
      ctx.stroke();
      ctx.globalAlpha = 0.94 * fade;
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 10;
      ctx.stroke();
      ctx.strokeStyle = '#fff4ce';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#fff9e4';
      ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.fill();
      if (p === 1) {
        ctx.globalAlpha = fade * 0.72;
        ctx.strokeStyle = f.color;
        ctx.beginPath(); ctx.arc(x, y, 9 + (1 - fade) * 19, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 飞字:x/y 逻辑坐标,text 文本,color CSS 色
  float(x, y, text, { size = 26, color = '#794f27', life = 0.9 } = {}) {
    this.floaters.push({ x, y, text, t: 0, life, size, color });
  }

  // ===== v0.3 伤害冒字(M8 A 运动模型;main 每帧转发 battle.drainFloatTexts 事件)=====
  // ev={kind,x,y,n?,el?,fromAngle?,jitter?,importance?,crit?}:
  // - 颜色/文案/重要度按 FT_STYLE 映射;crit=true(6.2d 暴击)→ 金色/字号×1.4/过冲更强/寿命 1.25s;
  // - 运动(A):初速=speed×4 沿 fromAngle(缺省向上)±jitter 抖动(弹道 0.7/跳伤 0.8),指数阻力 3.2
  //   + 微重力 90;pop 0.14s 过冲(easeOutBack 0.3→peak)后 0.12s 回落 1.0;末 30% 淡出;
  // - 整条一体(2026-10-17 需求方口径变更,替代原方案 E 逐位):「击破」/数值等多字文本**不拆位**,
  //   整串同帧起跳同步运动,一条文本即一条冒字(绘制层 textAlign=center 以 ev.x 居中)。
  combatFloat(ev) {
    const st = FT_STYLE[ev.kind];
    if (!st) return;
    this.impacts.note(ev);
    const imp = ev.importance ?? st.imp;
    const crit = !!ev.crit;
    const size = crit ? Math.round(st.size * CRIT_SIZE_MULT) : st.size;
    const speed = 50 + imp * 40;                    // 重要度分级(6.1:50/90/130)→初速 ×4
    const peak = crit ? CRIT_PEAK : 0.9 + imp * 0.3; // peakScale(0.9/1.2/1.5;暴击 1.38)
    const life = crit ? CRIT_LIFE : (imp === 2 ? FT_LIFE_IMP2 : FT_LIFE);
    const color = crit ? CRIT_COLOR : st.color(ev);
    const jitter = ev.jitter ?? (ev.fromAngle != null ? 0.7 : 0.8);
    const base = ev.fromAngle != null ? ev.fromAngle : -Math.PI / 2; // 缺省向上
    const text = st.fmt(ev);
    const charN = [...text].length + Number(!!st.icon); // 图标占一位，维持 64 位上限。
    // 防重叠(6.1):同位置(±24px)已有冒字则向上推 min(fy, ft.y - size×1.1)
    let y = ev.y;
    for (const t of this.combatTexts) {
      if (Math.abs(t.x - ev.x) < 24 && Math.abs(t.y - y) < 24) y = Math.min(y, t.y - size * 1.1);
    }
    // 上限 64(REQ-M7-02 F3;M8 整组原子口径,计数单位=字符位):候选=现有整条+本事件;
    // 新事件 importance 低于全部存量 → 整条丢弃(REQ-M7-01 F3);否则弃 importance 最低、
    // 最早入队整条(一条文本一条记录,天然原子,无残缺半组问题)
    this._seq = (this._seq || 0) + 1;
    const totalChars = () => this.combatTexts.reduce((a, c) => a + c.charN, 0);
    while (totalChars() + charN > 64) {
      let wImp = Infinity, wSeq = Infinity; // 现有最差组
      for (const c of this.combatTexts) {
        if (c.imp < wImp || (c.imp === wImp && c.seq < wSeq)) { wImp = c.imp; wSeq = c.seq; }
      }
      if (this.combatTexts.length === 0 || imp < wImp) return; // 新组最差 → 整条丢弃
      this.combatTexts = this.combatTexts.filter(c => !(c.imp === wImp && c.seq === wSeq));
    }
    const a = base + (Math.random() - 0.5) * 2 * jitter;
    const v0 = speed * FT_V0_MULT * (0.92 + Math.random() * 0.16); // 初速 ±8% 自然散布
    this.combatTexts.push({
      x: ev.x, y, text, icon: st.icon, fallback: st.fallback, color, size, imp, crit, seq: this._seq, charN,
      t: 0, life,
      vx: Math.cos(a) * v0, vy: Math.sin(a) * v0, peak,
    });
  }

  // M9 连锁播报由 main 转发，文案和颜色按表。
  // 替换式(M9-F5):新播报入队时把未完成旧播报直接推入淡出段(t≥AN_HOLD)——高连锁下
  // 连续播报不相互静止叠加(修复前最多 3 条共用中央位互相覆盖)
  chainAnnounce(chain) {
    const row = ANNOUNCE_TABLE.find(r => chain >= r.min);
    if (!row) return;
    for (const old of this.announces) old.t = Math.max(old.t, AN_HOLD + (AN_LIFE - AN_HOLD) * 0.5); // 推入淡出段中点(alpha≈0.5,0.14s 内消亡——立即让位不再全亮叠加)
    this.announces.push({ chain, text: row.text(chain), color: row.color, t: 0, life: AN_LIFE });
    this.announces = this.announces.slice(-3); // 防堆积(淡出尾最多 3 条)
  }

  update(dt) {
    this.impacts.update(dt);
    this.itemEffects.update(dt);
    for (const flight of this.castFlights) flight.t += dt;
    if (this.castFlights.length) this.castFlights = this.castFlights.filter(f => f.t < f.travel + CAST_ARRIVAL);
    if (this.call) { this.call.t += dt; if (this.call.t >= CALL_TOTAL) this.call = null; } // M12
    if (this.callCdT > 0) this.callCdT = Math.max(0, this.callCdT - dt); // M12 喊话 CD 衰减
    for (const p of this.particles) {
      p.t += dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 500 * dt; // 重力
    }
    this.particles = this.particles.filter(p => p.t < p.life);
    for (const f of this.floaters) f.t += dt;
    this.floaters = this.floaters.filter(f => f.t < f.life);
    // M8 A 物理:指数阻力(液体阻力感)+ 微重力下垂(整条一体,单步离散积分)
    for (const c of this.combatTexts) {
      c.t += dt;
      const drag = Math.exp(-FT_DRAG * dt);
      c.vx *= drag; c.vy *= drag;
      c.vy += FT_GRAV * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
    }
    this.combatTexts = this.combatTexts.filter(c => c.t < c.life);
    for (const an of this.announces) an.t += dt;
    this.announces = this.announces.filter(an => an.t < an.life);
  }

  // pop→回落→恒定 scale(M8:过冲后回落 1.0 保持基础字号可读,不再缩小消失)
  _scale(c) {
    const ct = Math.max(0, c.t);
    if (ct < FT_POP_T) return 0.3 + (c.peak - 0.3) * easeOutBack(ct / FT_POP_T);
    if (ct < FT_POP_T + FT_SETTLE_T) return c.peak + (1 - c.peak) * ((ct - FT_POP_T) / FT_SETTLE_T);
    return 1;
  }

  draw(ctx, combatHudBounds = [], combatIcons) {
    if (this.particles.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, BOARD_Y, BOARD_W, BOARD_H);
      ctx.clip();
      for (const p of this.particles) {
        const k = 1 - p.t / p.life;
        const s = p.size * (0.5 + k * 0.5);
        ctx.globalAlpha = k;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        if (p.shards) {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle + p.t * 7);
          ctx.moveTo(s * 1.5, 0);
          ctx.lineTo(-s * 0.4, s * 0.7);
          ctx.lineTo(-s, 0);
          ctx.lineTo(-s * 0.4, -s * 0.55);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#fff2c7';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.restore();
        } else {
          ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    for (const f of this.floaters) {
      const k = f.t / f.life;
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = f.color;
      ctx.font = `bold ${f.size}px 'Nunito','Noto Sans SC',sans-serif`;
      ctx.fillText(f.text, f.x, f.y - 40 * k);
    }
    ctx.globalAlpha = 1;
    // 伤害冒字绘制(M8 A:pop 过冲→回落 1.0;末 30% 淡出;黑色描边在外圈;整条一体居中)
    ctx.lineJoin = 'round'; // 描边圆角避免尖刺
    ctx.textBaseline = 'alphabetic';
    const occupied = [...combatHudBounds];
    const ordered = this.combatTexts.slice().sort((a, b) => {
      const aPlaced = this.combatTextLayout.has(a), bPlaced = this.combatTextLayout.has(b);
      if (aPlaced || bPlaced) return aPlaced === bPlaced ? a.seq - b.seq : Number(bPlaced) - Number(aPlaced);
      return b.imp - a.imp || Number(b.crit) - Number(a.crit) || b.seq - a.seq;
    });
    for (const c of ordered) {
      const p = c.t / c.life;
      const scale = this._scale(c);
      const font = Math.max(6, Math.round(c.size * scale));
      ctx.font = `bold ${font}px 'Nunito','Noto Sans SC',sans-serif`;
      const outline = Math.max(3, Math.round(font / 8));
      const edge = c.color === GEM_FLOAT.earth ? outline + 3 : outline;
      const img = c.icon && combatIcons?.[c.icon];
      const hasIcon = img?.complete && img.naturalWidth > 0;
      const iconSize = hasIcon ? Math.round(font * 0.9) : 0;
      const lead = hasIcon ? iconSize + Math.max(3, Math.round(font * 0.12)) : 0;
      const label = !hasIcon && c.fallback ? `${c.fallback} ${c.text}` : c.text;
      const metrics = ctx.measureText(label);
      const half = metrics.width / 2;
      const leftPad = Math.max(half, metrics.actualBoundingBoxLeft ?? 0) + (edge + lead) / 2;
      const rightPad = Math.max(half, metrics.actualBoundingBoxRight ?? 0) + (edge + lead) / 2;
      const ascent = Math.max(font, metrics.actualBoundingBoxAscent ?? 0) + edge / 2;
      const descent = Math.max(font * 0.18, metrics.actualBoundingBoxDescent ?? 0) + edge / 2;
      const minX = leftPad + 6, maxX = BOARD_W - rightPad - 6;
      const minY = BATTLE_ASSET_BAR_H + 6 + ascent, maxY = BATTLE_H - 42 - descent;
      const baseX = Math.max(minX, Math.min(maxX, c.x));
      const baseY = Math.max(minY, Math.min(maxY, c.y - (c.imp === 2 ? 12 : 0)));
      const last = this.combatTextLayout.get(c);
      const projectedX = Math.max(minX, Math.min(maxX, baseX + (last?.dx ?? 0)));
      const projectedY = Math.max(minY, Math.min(maxY, baseY + (last?.dy ?? 0)));
      let x = projectedX, y = projectedY;
      const vertical = [];
      const horizontal = [];
      for (const box of occupied) {
        if (x + rightPad + FT_LAYOUT_GAP > box.left && x - leftPad - FT_LAYOUT_GAP < box.right) {
          vertical.push({ lo: box.top - descent - FT_LAYOUT_GAP, hi: box.bottom + ascent + FT_LAYOUT_GAP });
        }
        if (y + descent + FT_LAYOUT_GAP > box.top && y - ascent - FT_LAYOUT_GAP < box.bottom) {
          horizontal.push({ lo: box.left - rightPad - FT_LAYOUT_GAP, hi: box.right + leftPad + FT_LAYOUT_GAP });
        }
      }
      const freeY = closestFreeCoordinate(vertical, y, minY, maxY, 96);
      if (freeY !== null) {
        y = freeY;
      } else {
        const freeX = closestFreeCoordinate(horizontal, x, minX, maxX, 144);
        if (freeX !== null) x = freeX;
        else if (!last) continue;
      }
      if (last) {
        const distance = Math.hypot(x - projectedX, y - projectedY);
        const maxStep = FT_LAYOUT_SPEED * Math.max(0, c.t - last.t);
        if (distance > maxStep) {
          x = projectedX + (x - projectedX) * maxStep / distance;
          y = projectedY + (y - projectedY) * maxStep / distance;
        }
      }
      this.combatTextLayout.set(c, { dx: x - baseX, dy: y - baseY, t: c.t });
      const bounds = { left: x - leftPad, right: x + rightPad, top: y - ascent, bottom: y + descent };
      // 避让过程中只推进位置，等整条文字移出遮挡区再绘制。
      if (occupied.some(box => bounds.left < box.right && bounds.right > box.left &&
        bounds.top < box.bottom && bounds.bottom > box.top)) continue;
      occupied.push(bounds);
      ctx.globalAlpha = p < FT_FADE_FROM ? 1 : Math.max(0, 1 - (p - FT_FADE_FROM) / (1 - FT_FADE_FROM));
      if (hasIcon) ctx.drawImage(img, x - leftPad + edge / 2, y - font * 0.82, iconSize, iconSize);
      const textX = x + lead / 2;
      if (edge > outline) {
        ctx.strokeStyle = '#fff0d1';
        ctx.lineWidth = edge;
        ctx.strokeText(label, textX, y);
      }
      ctx.strokeStyle = '#000';
      ctx.lineWidth = outline;
      ctx.strokeText(label, textX, y);
      ctx.fillStyle = c.color;
      ctx.fillText(label, textX, y);
    }
    ctx.globalAlpha = 1;
    // M9 连锁播报绘制(王者定版:左滑入→overshoot 定版→停留→上浮淡出;M9-F5:滑入含水平位移、
    // scale 经 easeOutBack 连续回落 1.0 无跳变、替换式不叠加;纯表现不阻塞逻辑)
    for (const an of this.announces) {
      const t = an.t;
      let scale = 1, alpha = 1, yoff = 0, xoff = 0;
      if (t < AN_IN) {
        const p = t / AN_IN;
        const eb = easeOutBack(p); // 0→1,中段自然过冲(~1.1),终点 1.0 连续(修复前映射终点 1.15 跳变)
        scale = 0.3 + 0.7 * eb;
        xoff = -140 * Math.pow(1 - p, 2); // 左侧 140px 滑入(easeOut 二次)
      } else if (t < AN_HOLD) {
        scale = 1 + 0.02 * Math.sin(((t - AN_IN) / (AN_HOLD - AN_IN)) * Math.PI * 4); // 呼吸
      } else {
        const p = (t - AN_HOLD) / (AN_LIFE - AN_HOLD);
        alpha = Math.max(0, 1 - p);
        yoff = -30 * p;
      }
      // 光带(0~0.25s 斜带扫过播报区)
      if (t < AN_BAND) {
        const p = t / AN_BAND;
        const gx = -200 + p * (720 + 400);
        ctx.save();
        ctx.globalAlpha = Math.sin(p * Math.PI) * 0.3;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(gx, 770); ctx.lineTo(gx + 60, 770); ctx.lineTo(gx + 140, 960); ctx.lineTo(gx + 80, 960);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      const font = Math.max(6, Math.round(56 * scale));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      ctx.font = `bold ${font}px 'Nunito','Noto Sans SC',sans-serif`;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(3, Math.round(font / 8));
      const ax = 360 + xoff, ay = 864 + yoff;
      ctx.strokeText(an.text, ax, ay);
      ctx.fillStyle = an.color;
      ctx.fillText(an.text, ax, ay);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    this._drawCallTop(ctx);
  }

  // ===== M12 技能喊话(方案 B「冲击斜切」) =====
  // 入口(main 桥接 caster.tick 执行记录):非普攻弹技能执行时触发;2s CD 内最多 1 次(需求方 2026-10-18)。
  // variant:技能背景变体(Lv3 技能=1,Lv6 技能=2,由 main 按 unlockLevel 传参)。
  // 纯表现不阻塞逻辑(M9 同口径):不写任何战斗状态,演出期输入照常。
  // 返回值(M12M13-ACCEPT F3):true=演出已触发;false=被忽略(演出中或 CD 期)——
  // 调用方据此后接联动演出(如震屏),保证 CD 期「整体忽略」而非只忽略画面。
  skillCall(name, el, variant = 1) {
    if (this.call || this.callCdT > 0) return false; // 演出中或 CD 期:忽略(不排队不替换,需求方 2026-10-18)
    this.call = { name: String(name || ''), el, variant, t: 0 };
    this.callCdT = CALL_CD;
    return true;
  }

  // 终局/重开清场(REQ-M6-05 同口径:表现层不残留旧局演出);CD 同清(与 caster.resetTempState 对齐)
  clearCall() { this.call = null; this.callCdT = 0; }

  // 技能背景层:render 在战场变换内、敌人绘制之前调用(z 序:场景 < 技能背景 < 敌人 < 喊话气泡)。
  // 羽化遮罩自中心向左右展开(替代 clip-path 硬边):离屏画布合成 destination-in 横向渐变。
  drawCallBg(ctx) {
    const c = this.call;
    if (!c) return;
    const img = CALL_IMG.bg[`${c.el}:${c.variant}`] || CALL_IMG.bg[`${c.el}:1`];
    if (!img) return; // 贴图未绑定(单测/兜底):静默跳过,不阻塞渲染
    const t = c.t;
    // 入场:透明度 35% 时长完成淡入;缩放 1.5→0.97(60%)→1(过冲回弹,样板 B-bg 关键帧)
    const p = Math.min(1, Math.max(0, (t - CALL_BG_D) / CALL_BG_T));
    const scale = p < 0.6 ? 1.5 - 0.53 * easeOutCubic(p / 0.6) : 0.97 + 0.03 * ((p - 0.6) / 0.4);
    let alpha = p < 0.35 ? p / 0.35 : 1; // 入场 35% 时长完成淡入(样板 B-bg 35% 关键帧)
    if (t >= CALL_HOLD) { // 退场:整体淡出
      alpha = 1 - Math.min(1, (t - CALL_HOLD) / CALL_EXIT_T);
    }
    const exitScale = t >= CALL_HOLD ? 1 + 0.06 * Math.min(1, (t - CALL_HOLD) / CALL_EXIT_T) : 1;
    const g = this._ensureBgWork();
    if (!g) return; // 无 DOM 环境:跳过合成
    g.clearRect(0, 0, CALL_W, CALL_H);
    g.save();
    g.translate(CALL_W / 2, CALL_H / 2);
    g.scale(scale * exitScale, scale * exitScale);
    g.translate(-CALL_W / 2, -CALL_H / 2);
    const s = Math.max(CALL_W / img.width, CALL_H / img.height); // cover 裁切
    g.drawImage(img, (CALL_W - img.width * s) / 2, (CALL_H - img.height * s) / 2, img.width * s, img.height * s);
    g.restore();
    // 羽化遮罩:--w 0→80% 宽度,两侧各 8% 渐变带(样板 @property 口径)
    const wp = Math.min(1, Math.max(0, (t - CALL_CUT_D) / CALL_CUT_T));
    const e = wp * wp * (3 - 2 * wp); // smoothstep 近似 cubic-bezier(.7,0,.2,1)
    const half = 0.80 * CALL_W * e / 2, fe = 0.08 * CALL_W, cx = CALL_W / 2;
    g.globalCompositeOperation = 'destination-in';
    const grad = g.createLinearGradient(0, 0, CALL_W, 0);
    const stops = [
      [(cx - half - fe) / CALL_W, 0], [(cx - half) / CALL_W, 1],
      [(cx + half) / CALL_W, 1], [(cx + half + fe) / CALL_W, 0],
    ].map(([o, a]) => [Math.min(1, Math.max(0, o)), a]);
    for (let i = 1; i < stops.length; i++) if (stops[i][0] < stops[i - 1][0]) stops[i][0] = stops[i - 1][0]; // 保证非降序
    for (const [o, a] of stops) grad.addColorStop(o, `rgba(0,0,0,${a})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, CALL_W, CALL_H);
    g.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha *= alpha * 0.48;
    ctx.drawImage(this._bgWork, 0, 0);
    ctx.restore();
  }

  drawCallImpact(ctx) {
    const c = this.call;
    if (!c) return;
    const p = (c.t - 0.045) / 0.28;
    if (p < 0 || p >= 1) return;
    const fade = p < 0.24 ? p / 0.24 : (1 - p) / 0.76;
    ctx.save();
    ctx.globalAlpha *= fade * 0.48;
    ctx.fillStyle = '#fff2ce';
    ctx.translate(355, 219);
    ctx.rotate(-0.12 + p * 0.16);
    ctx.beginPath();
    for (let i = 0; i < 28; i++) {
      const angle = i * Math.PI / 14;
      const x = Math.cos(angle), y = Math.sin(angle);
      const inner = 84 + (i % 4) * 19 + p * 92;
      ctx.moveTo(x * inner, y * inner);
      ctx.lineTo(x * 430 - y * 2, y * 430 + x * 2);
      ctx.lineTo(x * 430 + y * 4, y * 430 - x * 4);
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();
    if (p < 0.42) {
      const flash = 0.23 * Math.sin(Math.PI * p / 0.42);
      ctx.save();
      ctx.fillStyle = `rgba(255,248,225,${flash})`;
      ctx.fillRect(0, BATTLE_ASSET_BAR_H, CALL_W, CALL_H - BATTLE_ASSET_BAR_H);
      ctx.restore();
    }
  }

  callBounds() {
    if (!this.call) return null;
    const bounds = [];
    const portrait = callPortraitPose(this.call.t, CALL_IMG.hero);
    if (portrait) {
      const right = Math.min(CALL_W, portrait.x + portrait.width + Math.max(0, Math.sin(portrait.angle) * CALL_PORTRAIT_H));
      if (right > 0) bounds.push({ left: 0, top: BATTLE_ASSET_BAR_H, right, bottom: CALL_H });
    }
    const bubble = callBubblePose(this.call.t, CALL_IMG.bubble);
    if (bubble) {
      const { x, y, w } = CALL_BUBBLE;
      const { scale, ox, oy, height } = bubble;
      bounds.push({
        left: ox + (x - ox) * scale,
        top: Math.max(BATTLE_ASSET_BAR_H, oy + (y - oy) * scale),
        right: Math.min(CALL_W, ox + (x + w - ox) * scale),
        bottom: Math.min(CALL_H, oy + (y + height - oy) * scale),
      });
    }
    return bounds;
  }

  _drawCallTop(ctx) {
    const c = this.call;
    if (!c) return;
    const hero = CALL_IMG.hero;
    const bubble = CALL_IMG.bubble;
    const portraitPose = callPortraitPose(c.t, hero);
    const bubblePose = callBubblePose(c.t, bubble);
    if (!portraitPose && !bubblePose) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, BATTLE_ASSET_BAR_H, CALL_W, CALL_H - BATTLE_ASSET_BAR_H); ctx.clip();
    if (portraitPose) {
      ctx.save();
      ctx.translate(portraitPose.x, CALL_H);
      ctx.rotate(portraitPose.angle);
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = 18;
      ctx.drawImage(hero, 0, -CALL_PORTRAIT_H, portraitPose.width, CALL_PORTRAIT_H);
      ctx.restore();
    }

    if (bubblePose) {
      const { x, y, w } = CALL_BUBBLE;
      const { height, scale, alpha, ox, oy } = bubblePose;
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);
      ctx.translate(-ox, -oy);
      ctx.shadowColor = 'rgba(0,0,0,.6)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;
      if (bubble?.naturalWidth > 0) {
        ctx.drawImage(bubble, x, y, w, height);
      } else {
        ctx.fillStyle = '#fff2d2';
        roundRect(ctx, x + 22, y + height * 0.23, w - 65, height * 0.38, 22); ctx.fill();
      }
      ctx.shadowOffsetY = 0;
      if (c.name && c.t >= CALL_NAME_DELAY) {
        const p = Math.min(1, (c.t - CALL_NAME_DELAY) / CALL_NAME_ENTRY);
        const nameScale = 1.35 - 0.35 * easeOutCubic(p);
        ctx.translate(x + w * 0.48, y + height * 0.42);
        ctx.scale(nameScale, nameScale);
        ctx.shadowBlur = 0;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = "900 42px 'Nunito','Noto Sans SC',sans-serif";
        ctx.strokeStyle = '#1b1a2e';
        ctx.lineWidth = 8;
        ctx.lineJoin = 'round';
        ctx.strokeText(c.name, 0, 0);
        ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 6;
        ctx.fillStyle = '#fff';
        ctx.fillText(c.name, 0, 0);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  _ensureBgWork() {
    if (!this._bgWork) {
      this._bgWork = _mkCanvas(CALL_W, CALL_H);
      this._bgWorkCtx = this._bgWork ? this._bgWork.getContext('2d') : null;
    }
    return this._bgWorkCtx;
  }
}
