// scripts/ui/fx.js
// 表现层特效:消除粒子爆裂 + 分数/连锁飞字(纯 Canvas,无依赖)
// 相对路径: scripts/ui/fx.js
// 数值: 粒子 ≤12/次、上限 200(00 文档 FR-1.5 粒子上限口径),飞字 0.9s 上浮 40px

import { CELL, ELEMENTS } from '../board/grid.js';

const GEM_RGB = { metal: [200, 200, 255], wood: [80, 200, 90], water: [70, 140, 255], fire: [255, 90, 70], earth: [220, 150, 70] };

export class FxLayer {
  constructor() {
    this.particles = []; // {x,y,vx,vy,t,life,size,rgb}
    this.floaters = [];  // {x,y,text,t,life,size,color}
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

  update(dt) {
    for (const p of this.particles) {
      p.t += dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 500 * dt; // 重力
    }
    this.particles = this.particles.filter(p => p.t < p.life);
    for (const f of this.floaters) f.t += dt;
    this.floaters = this.floaters.filter(f => f.t < f.life);
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
