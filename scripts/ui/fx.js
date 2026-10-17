// scripts/ui/fx.js
// 表现层特效:消除粒子爆裂 + 分数/连锁飞字(纯 Canvas,无依赖)
// 相对路径: scripts/ui/fx.js
// 数值: 粒子 ≤12/次、上限 200(00 文档 FR-1.5 粒子上限口径),飞字 0.9s 上浮 40px

import { CELL, ELEMENTS } from '../board/grid.js';
import { GEM_COLORS as GEM_FLOAT } from './draw_util.js'; // 五行色单一定义源(弹道与冒字共用,REQ-M7-01 F6)

// 粒子 RGB 由 GEM_COLORS 派生(hex→rgb;M8 配色整改后随单一定义源联动,不再独立硬编码)
const hexRgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const GEM_RGB = Object.fromEntries(Object.entries(GEM_FLOAT).map(([k, v]) => [k, hexRgb(v)]));

// 伤害冒字样式表(03 文档 6.2a/6.2b;**全部五行语义色引用 draw_util GEM_COLORS 单一定义源**,
// REQ-M7-02 F6:灼烧/吸血/光环/护盾/状态标记不再硬编码;非五行语义色[免伤/受击/击破]为独立字面值)
// kind → {color, fmt, imp, size};n=实际变化量(6.4),el=元素(直击/溅射/锁链/脉冲/灼烧区)
const FT_STYLE = {
  dmg:        { color: ev => GEM_FLOAT[ev.el] || '#ffffff', fmt: ev => `-${ev.n}`, imp: 1, size: 32 },
  splash:     { color: ev => GEM_FLOAT[ev.el] || '#ffffff', fmt: ev => `-${ev.n}`, imp: 0, size: 20 },
  burn:       { color: () => GEM_FLOAT.fire, fmt: ev => `🔥${ev.n}`, imp: 0, size: 28 },
  bindDot:    { color: ev => GEM_FLOAT[ev.el] || GEM_FLOAT.wood, fmt: ev => `🌿${ev.n}`, imp: 0, size: 28 },
  leech:      { color: () => GEM_FLOAT.wood, fmt: ev => `+${ev.n}`, imp: 1, size: 32 },
  aura:       { color: () => GEM_FLOAT.wood, fmt: ev => `+${ev.n}`, imp: 0, size: 28 },
  shieldGain: { color: () => GEM_FLOAT.earth, fmt: ev => `🛡+${ev.n}`, imp: 1, size: 32 },
  absorb:     { color: () => GEM_FLOAT.earth, fmt: ev => `🛡${ev.n}`, imp: 1, size: 32 },
  hurt:       { color: () => '#ff8888', fmt: ev => `-${ev.n}`, imp: 1, size: 32 },
  immune:     { color: () => '#ffd700', fmt: () => `免伤`, imp: 2, size: 40 },
  kill:       { color: () => '#ffffff', fmt: () => `击破`, imp: 2, size: 40 },
  slowMark:   { color: () => GEM_FLOAT.water, fmt: () => `❄减速`, imp: 0, size: 28 },
  bindMark:   { color: () => GEM_FLOAT.wood, fmt: () => `🌿束缚`, imp: 1, size: 28 },
  stunMark:   { color: () => GEM_FLOAT.earth, fmt: () => `💫眩晕`, imp: 1, size: 28 },
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
const CRIT_COLOR = '#ffd700';   // 暴击金(非五行语义,与免伤同金)
const CRIT_SIZE_MULT = 1.4;     // 暴击字号放大
const CRIT_PEAK = 1.38;         // 暴击 pop 过冲更强
const CRIT_LIFE = 1.25;         // 暴击存在时间延长(调研:暴击应延长存在)

// ===== M9 连锁播报(需求方 2026-10-17:王者「N连XX」屏幕定版播报)=====
// 文案=王者 2017 官方播报(二连击破/三连决胜/四连超凡/五连绝世),≥6 延伸「连锁狂潮 ×N」;
// 动效:0~0.12s 左滑入+easeOutBack 定版(0.3→1.15→1.0)→0.62s 停留(呼吸)→0.9s 上浮淡出;
// 光带 0~0.25s 扫过;chain≥4 附棋盘微震(boardShakeT)。纯 Canvas 矢量,无外部素材。
const ANNOUNCE_TABLE = [
  { min: 6, text: (c) => `连锁狂潮 ×${c}`, color: '#e05a5a' },
  { min: 5, text: () => '五连绝世', color: '#ffd700' },
  { min: 4, text: () => '四连超凡', color: '#f5a02c' },
  { min: 3, text: () => '三连决胜', color: '#b06fd8' },
  { min: 2, text: () => '二连击破', color: '#4aa8cc' },
];
const AN_LIFE = 0.9, AN_IN = 0.12, AN_HOLD = 0.62, AN_BAND = 0.25, AN_SHAKE = 0.3;

// easeOutBack 弹跳缓动(段 pop 过冲回落;REQ-M7-01 F3 沿用)
function easeOutBack(x) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export class FxLayer {
  constructor() {
    this.particles = []; // {x,y,vx,vy,t,life,size,rgb}
    this.floaters = [];  // {x,y,text,t,life,size,color}
    this.combatTexts = []; // v0.3 伤害冒字(上限 64 字符位;M8 A 整条一体运动/暴击,03 文档 6.1)
    this.announces = [];   // M9 连锁播报 [{chain,text,color,t,life}](engine chain_announce 事件驱动)
    this.boardShakeT = 0;  // M9:播报棋盘微震计时(chain≥4 触发)
  }

  // 消除粒子爆裂:cx/cy 格中心(逻辑坐标),el 元素名,count 消除数(越多越密);
  // cap 粒子上限(段②合成闪光 ≤8、段④径向光效 ≤12,02 文档 3.1)
  burst(cx, cy, el, count, cap = 12) {
    const rgb = GEM_RGB[el] || [255, 255, 255];
    const n = Math.min(cap, 6 + count);
    for (let i = 0; i < n && this.particles.length < 200; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 180;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 30, y: cy + (Math.random() - 0.5) * 30,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80,
        t: 0, life: 0.5 + Math.random() * 0.3, size: 4 + Math.random() * 5, rgb,
      });
    }
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
    const charN = [...text].length; // 字符数(上限 64 仍按"位"计数口径,6.1)
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
      x: ev.x, y, text, color, size, imp, seq: this._seq, charN,
      t: 0, life,
      vx: Math.cos(a) * v0, vy: Math.sin(a) * v0, peak,
    });
  }

  // M9 连锁播报(main 转发 engine chain_announce 事件):文案/颜色按表;chain≥4 附微震;
  // 替换式(M9-F5):新播报入队时把未完成旧播报直接推入淡出段(t≥AN_HOLD)——高连锁下
  // 连续播报不相互静止叠加(修复前最多 3 条共用中央位互相覆盖)
  chainAnnounce(chain) {
    const row = ANNOUNCE_TABLE.find(r => chain >= r.min);
    if (!row) return;
    for (const old of this.announces) old.t = Math.max(old.t, AN_HOLD + (AN_LIFE - AN_HOLD) * 0.5); // 推入淡出段中点(alpha≈0.5,0.14s 内消亡——立即让位不再全亮叠加)
    this.announces.push({ chain, text: row.text(chain), color: row.color, t: 0, life: AN_LIFE });
    this.announces = this.announces.slice(-3); // 防堆积(淡出尾最多 3 条)
    if (chain >= 4) this.boardShakeT = AN_SHAKE;
  }

  // 棋盘微震偏移(render 每帧读取;±2px 衰减,chain≥4 播报附带)
  boardShake() {
    if (this.boardShakeT <= 0) return { dx: 0, dy: 0 };
    const a = (this.boardShakeT / AN_SHAKE) * 2;
    return { dx: Math.sin(this.boardShakeT * 70) * a, dy: Math.cos(this.boardShakeT * 53) * a * 0.6 };
  }

  update(dt) {
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
    if (this.boardShakeT > 0) this.boardShakeT = Math.max(0, this.boardShakeT - dt);
  }

  // pop→回落→恒定 scale(M8:过冲后回落 1.0 保持基础字号可读,不再缩小消失)
  _scale(c) {
    const ct = Math.max(0, c.t);
    if (ct < FT_POP_T) return 0.3 + (c.peak - 0.3) * easeOutBack(ct / FT_POP_T);
    if (ct < FT_POP_T + FT_SETTLE_T) return c.peak + (1 - c.peak) * ((ct - FT_POP_T) / FT_SETTLE_T);
    return 1;
  }

  draw(ctx) {
    for (const p of this.particles) {
      const k = 1 - p.t / p.life;
      ctx.globalAlpha = k;
      ctx.fillStyle = `rgb(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * k + 1, 0, Math.PI * 2);
      ctx.fill();
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
    for (const c of this.combatTexts) {
      const p = c.t / c.life;
      const scale = this._scale(c);
      ctx.globalAlpha = p < FT_FADE_FROM ? 1 : Math.max(0, 1 - (p - FT_FADE_FROM) / (1 - FT_FADE_FROM));
      const font = Math.max(6, Math.round(c.size * scale));
      ctx.font = `bold ${font}px 'Nunito','Noto Sans SC',sans-serif`;
      const ty = c.y - (c.imp === 2 ? 12 : 0);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(3, Math.round(font / 8)); // 描边宽≈字号 1/8(随缩放)
      ctx.strokeText(c.text, c.x, ty);
      ctx.fillStyle = c.color;
      ctx.fillText(c.text, c.x, ty);
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
  }

  /** 由引擎事件驱动(main.js 桥接):match_cleared 事件 → 粒子 + 飞字 */
  onMatchCleared(ev, chainMax) {
    // M11:移除消除点「连锁 ×N」飞字——连锁播报唯一化(fx.chainAnnounce 王者式定版播报,
    // 需求方 2026-10-17:旧常显/飞字提示与新播报重复,移除);粒子迸发保留
    const cx = ev.c * CELL + CELL / 2;
    const cy = 504 + ev.r * CELL + CELL / 2;
    this.burst(cx, cy, ev.element, ev.count);
    void chainMax; void ELEMENTS;
  }
  // (段③技能图标与段④图标碎裂改由 render 状态驱动逐帧绘制,REQ-M6-06 F8;
  //  原 showIcon 一次性浮字无法反映认领回写与新建预约,已移除)
}
