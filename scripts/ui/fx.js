// scripts/ui/fx.js
// 表现层特效:消除粒子爆裂 + 分数/连锁飞字(纯 Canvas,无依赖)
// 相对路径: scripts/ui/fx.js
// 数值: 粒子 ≤12/次、上限 200(00 文档 FR-1.5 粒子上限口径),飞字 0.9s 上浮 40px

import { CELL, ELEMENTS } from '../board/grid.js';
import { GEM_COLORS as GEM_FLOAT } from './draw_util.js'; // 五行色单一定义源(弹道与冒字共用,REQ-M7-01 F6)

const GEM_RGB = { metal: [200, 200, 255], wood: [80, 200, 90], water: [70, 140, 255], fire: [255, 90, 70], earth: [220, 150, 70] };

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
const FT_LIFE = 1.2; // 寿命(原型 const.js FLOAT_TEXT_LIFE;03 文档 6.1)

// easeOutBack 弹跳缓动(段① scale 0.2→peak 过冲回落,对标原型弹跳;REQ-M7-01 F3)
function easeOutBack(x) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export class FxLayer {
  constructor() {
    this.particles = []; // {x,y,vx,vy,t,life,size,rgb}
    this.floaters = [];  // {x,y,text,t,life,size,color}
    this.combatTexts = []; // v0.3 伤害冒字(上限 64;三段运动/重要度/防重叠,03 文档 6.1)
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

  // ===== v0.3 伤害冒字(03 文档 6.1/6.2;main 每帧转发 battle.drainFloatTexts 事件)=====
  // ev={kind,x,y,n?,el?,fromAngle?,jitter?,importance?}:颜色/文案/重要度按 FT_STYLE 映射;
  // 三段运动(寿命 1.2s):①p<0.12 爆发喷出(速度×6,scale 0.2→peak)②p<0.3 减速外漂(6×→1× 线性衰减)
  // ③其后缓升(-20px/s)+缩小淡出;方向缺省=向上;fromAngle 加 ±jitter 抖动(弹道 0.7/跳伤 0.8,6.3)。
  combatFloat(ev) {
    const st = FT_STYLE[ev.kind];
    if (!st) return;
    const imp = ev.importance ?? st.imp;
    const size = st.size;
    const speed = 50 + imp * 40;      // 重要度分级(6.1:50/90/130)
    const peak = 0.9 + imp * 0.3;     // peakScale(0.9/1.2/1.5)
    const jitter = ev.jitter ?? (ev.fromAngle != null ? 0.7 : 0.8);
    const base = ev.fromAngle != null ? ev.fromAngle : -Math.PI / 2; // 缺省向上
    const a = base + (Math.random() - 0.5) * 2 * jitter;
    // 防重叠(6.1):同位置(±24px)已有冒字则向上推 min(fy, ft.y - size×1.1)
    let y = ev.y;
    for (const t of this.combatTexts) {
      if (Math.abs(t.x - ev.x) < 24 && Math.abs(t.y - y) < 24) y = Math.min(y, t.y - size * 1.1);
    }
    // 上限 64(REQ-M7-02 F3 修正):候选=现有条目+新事件,弃 importance 最低、**最早入队**者;
    // 先后用单调入队序号 seq(同帧连续加入 t 均为 0,无法区分先后——seq 恒可区分);
    // 若新事件本身最差→不入队(64 条 imp2 后进 imp0 → 保留 64 条 imp2)
    this._seq = (this._seq || 0) + 1;
    if (this.combatTexts.length >= 64) {
      const cand = { imp, seq: this._seq };
      let worst = -1; // -1=新事件
      for (let i = 0; i < this.combatTexts.length; i++) {
        const c = this.combatTexts[i];
        const w = worst < 0 ? cand : this.combatTexts[worst];
        if (c.imp < w.imp || (c.imp === w.imp && c.seq < w.seq)) worst = i; // 同 imp:seq 最小=最早入队
      }
      if (worst < 0) return; // 新事件 importance 最低且最新 → 丢弃新事件
      this.combatTexts.splice(worst, 1);
    }
    this.combatTexts.push({
      x: ev.x, y, text: st.fmt(ev), color: st.color(ev), size, imp, seq: this._seq, t: 0, life: FT_LIFE,
      dx: Math.cos(a), dy: Math.sin(a), speed, peak,
    });
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
    // 伤害冒字三段运动(增量式位移;段③缓升 20px/s)
    for (const c of this.combatTexts) {
      c.t += dt;
      const p = c.t / c.life;
      let v; // 段① 6×speed 恒速喷出;段② 6×speed→speed 线性衰减;段③ 0(改缓升)
      if (p < 0.12) v = c.speed * 6;
      else if (p < 0.3) { const k = (p - 0.12) / 0.18; v = c.speed * (6 - 5 * k); }
      else v = 0;
      c.x += c.dx * v * dt;
      c.y += c.dy * v * dt;
      if (p >= 0.3) c.y -= 20 * dt;
    }
    this.combatTexts = this.combatTexts.filter(c => c.t < c.life);
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
    // 伤害冒字绘制(三段 scale:0.2→peak **弹跳**(easeOutBack 过冲,REQ-M7-01 F3)/ peak / 线性缩小;imp2 上移 12px)
    // 黑色描边(2026-10-17 需求方反馈:先 strokeText 后 fillText,描边在外圈)
    ctx.lineJoin = 'round'; // 描边圆角避免尖刺
    for (const c of this.combatTexts) {
      const p = c.t / c.life;
      const scale = p < 0.12
        ? 0.2 + (c.peak - 0.2) * easeOutBack(p / 0.12)
        : p < 0.3 ? c.peak : c.peak * Math.max(0, 1 - (p - 0.3) / 0.7);
      ctx.globalAlpha = p < 0.3 ? 1 : Math.max(0, 1 - (p - 0.3) / 0.7);
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
  }

  /** 由引擎事件驱动(main.js 桥接):match_cleared 事件 → 粒子 + 飞字 */
  onMatchCleared(ev, chainMax) {
    const cx = ev.c * CELL + CELL / 2;
    const cy = 504 + ev.r * CELL + CELL / 2;
    this.burst(cx, cy, ev.element, ev.count);
    if (ev.chain >= 2) {
      this.float(cx, cy - 30, `连锁 ×${ev.chain}`, { size: 22, color: '#e0662e' });
    }
    void chainMax; void ELEMENTS;
  }
  // (段③技能图标与段④图标碎裂改由 render 状态驱动逐帧绘制,REQ-M6-06 F8;
  //  原 showIcon 一次性浮字无法反映认领回写与新建预约,已移除)
}
