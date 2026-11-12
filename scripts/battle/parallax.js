// scripts/battle/parallax.js
// 战斗区远中近景视差(00 文档 3.1 节,FR-1.5):
//   远景 0.15:天空渐变(晨→昏随波次推移)+太阳/云/远山剪影,云随 tile 横移循环 60~90s
//   中景 0.45:树丛/岩丘剪影、薄雾与分关卡环境粒子(≤20)
//   近景 1.0 :草地+草丛簇正弦摆动(±3°,2~3s 周期)+花石点缀
// 约束:三层各为预渲染离屏 canvas tile,每帧每层 drawImage ≤2 次;粒子总数 ≤40;
//      程序化绘制,不新增贴图依赖;动效可整体关闭(关闭后功能不受影响)。
// 全局动效:受击 screenshake(4px/120ms);技能释放 zoom pulse(1.0→1.02→1.0)。
// 相对路径: scripts/battle/parallax.js

import { themeOf } from '../meta/levels.js';

export const BATTLE_H = 448; // 战斗区高度(00 文档第 3 节)

const TILE_W = 720;             // tile 宽=视口宽,循环滚动需两份拼接
const LOOP_W = TILE_W;          // 循环周期宽(tile 本身可无缝首尾相接)
// 层速按 00 文档 3.1 视差系数 0.15:0.45:1.0 取近景基准 60px/s(REQ-M3-03 整改 7:此前 1:2:3 与设计不符)
const NEAR_SPEED = 60;                    // 1.0
const MID_SPEED = NEAR_SPEED * 0.45;      // 27 px/s
const FAR_SPEED = NEAR_SPEED * 0.15;      // 9 px/s → 远景(含云)一圈 720/9 = 80s,落在 60~90s 区间
const SHAKE_AMP = 4;            // screenshake 幅度 px
const SHAKE_TIME = 0.12;        // screenshake 时长 s

// 晨→昏天空色随波次推移(w_local 1..10 线性内插,草案色值,集中此处调参)
const SKY_TOP = [[126, 200, 227], [86, 96, 158]];    // 晨 → 昏
const SKY_BOT = [[201, 236, 245], [66, 58, 96]];
const AMBIENCE = {
  meadow: { count: 16, vx: -18, vy: 11, size: 2.1, stretch: 1.65, color: 'rgba(204,214,145,.64)',
    haze: 'rgba(232,243,214,.13)', dusk: '90,50,70', duskOpacity: 0.25, boss: 'rgba(30,20,50,.22)' },
  swamp: { count: 14, vx: 10, vy: -7, size: 1.8, stretch: 1.1, color: 'rgba(205,240,181,.7)',
    haze: 'rgba(188,236,213,.19)', dusk: '41,64,72', duskOpacity: 0.22, boss: 'rgba(30,29,56,.24)' },
  mist: { count: 12, vx: -23, vy: 4, size: 1.65, stretch: 2.2, color: 'rgba(226,240,247,.61)',
    haze: 'rgba(227,244,252,.24)', dusk: '57,67,110', duskOpacity: 0.21, boss: 'rgba(35,34,63,.23)' },
  snow: { count: 20, vx: 17, vy: 21, size: 2.05, stretch: 1, color: 'rgba(246,253,255,.87)',
    haze: 'rgba(218,236,255,.14)', dusk: '67,76,124', duskOpacity: 0.22, boss: 'rgba(37,32,65,.24)' },
  volcano: { count: 16, vx: -10, vy: -22, size: 2.05, stretch: 1.36, color: 'rgba(255,167,93,.74)',
    haze: 'rgba(239,159,125,.13)', dusk: '78,45,63', duskOpacity: 0.13, boss: 'rgba(42,23,40,.18)' },
};

export class Parallax {
  constructor({ effects = true } = {}) {
    this.effects = effects;   // 动效总开关(false=静态分层底图,功能不受影响)
    this.t = 0;
    this.wave = 1;            // 当前 w_local(天空推移用)
    this.bossWave = false;    // Boss 波天色压暗 tint
    this.shakeT = 0;          // 受击 screenshake 剩余
    this.shakeDur = SHAKE_TIME; // 当前震屏总时长(M12 可变:喊话砸入 0.35s)
    this.shakeAmp = SHAKE_AMP;  // 当前震屏幅度(M12 可变:喊话砸入 5px)
    this.pulseT = -1;         // 技能 zoom pulse 计时(−1=未激活)
    this.ambientParticles = [];
    this.haze = null;
    this.far = null; this.mid = null; this.near = null;
    this._skyKey = '';
    this.imgs = {};           // M13:分关卡背景图 {far:<img>, near:<img>}(未绑定走程序化兜底)
    this.level = 1;
  }

  // M13:绑定分关卡背景图(main boot 从预载 Map 取用;空缺走程序化兜底)
  bindImages(map) {
    if (!map || typeof map.get !== 'function') return 0;
    this.imgs.far = map.get(`bg:${this._themeKey()}:far`) || null;
    this.imgs.near = map.get(`bg:${this._themeKey()}:near`) || null;
    return (this.imgs.far ? 1 : 0) + (this.imgs.near ? 1 : 0);
  }

  // M13:关卡切换(主题循环 meadow→swamp→mist→snow→volcano;重绑图,程序化 tile 保持)
  setLevel(level) {
    const theme = themeOf(level);
    if (theme === this._theme) return; // 同主题免重绑
    this._theme = theme;
    this.imgs.far = null; this.imgs.near = null; // 待 main 重新 bindImages(按新主题 key)
    this.ambientParticles.length = 0;
    this.haze = null;
  }

  _themeKey() { return this._theme || 'meadow'; }

  // 波次推进时重绘远景 tile(天空晨→昏);非每帧操作
  setWave(wLocal, bossWave) {
    this.wave = wLocal;
    this.bossWave = bossWave;
    this.buildTiles();
  }

  // M12:可选幅度/时长参数(技能喊话砸入震屏 5px/0.35s;缺省保持受击 4px/0.12s 原口径)
  triggerShake(amp = SHAKE_AMP, time = SHAKE_TIME) {
    if (!this.effects) return;
    this.shakeAmp = amp;
    this.shakeT = time;
    this.shakeDur = time;
  }
  triggerPulse() { if (this.effects) this.pulseT = 0; }

  // ---- tile 生成(程序化,启动/换波各一次) ----
  buildTiles() {
    if (typeof document === 'undefined') { // 无 DOM 环境(单测):程序化 tile 跳过,draw 走空守卫
      this.far = this.mid = this.near = null;
      return;
    }
    this.far = this._buildFar();
    this.mid = this._buildMid();
    this.near = this._buildNear();
  }

  _mk() {
    const c = document.createElement('canvas');
    c.width = TILE_W; c.height = BATTLE_H;
    return [c, c.getContext('2d')];
  }

  _buildFar() {
    const [c, g] = this._mk();
    const k = (this.wave - 1) / 9; // 0..1 晨→昏
    const mix = (a, b) => Math.round(a + (b - a) * k);
    const top = SKY_TOP[0].map((v, i) => mix(v, SKY_TOP[1][i]));
    const bot = SKY_BOT[0].map((v, i) => mix(v, SKY_BOT[1][i]));
    const sky = g.createLinearGradient(0, 0, 0, BATTLE_H);
    sky.addColorStop(0, `rgb(${top})`);
    sky.addColorStop(1, `rgb(${bot})`);
    g.fillStyle = sky;
    g.fillRect(0, 0, TILE_W, BATTLE_H);
    // 太阳(晨)→ 月亮(昏):随 k 切换
    g.fillStyle = k < 0.5 ? 'rgba(255,236,150,.9)' : 'rgba(230,230,210,.85)';
    g.beginPath(); g.arc(600, 90, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = k < 0.5 ? 'rgba(255,236,150,.25)' : 'rgba(230,230,210,.2)';
    g.beginPath(); g.arc(600, 90, 70, 0, Math.PI * 2); g.fill();
    // 云 ×3(画进 tile,随远景 80s/圈横移,60~90s 区间)
    g.fillStyle = 'rgba(255,255,255,.75)';
    for (const [x, y, s] of [[120, 70, 1], [340, 120, 0.7], [520, 55, 0.85]]) {
      g.beginPath();
      g.arc(x, y, 26 * s, 0, Math.PI * 2);
      g.arc(x + 30 * s, y - 10 * s, 20 * s, 0, Math.PI * 2);
      g.arc(x + 58 * s, y, 24 * s, 0, Math.PI * 2);
      g.fill();
    }
    // 远山/树林剪影(循环拼接处无缝:两端等高)
    g.fillStyle = '#a8cfa8';
    g.beginPath();
    g.moveTo(0, 330); g.lineTo(140, 210); g.lineTo(260, 330);
    g.lineTo(420, 180); g.lineTo(560, 330);
    g.lineTo(660, 240); g.lineTo(TILE_W, 330);
    g.lineTo(TILE_W, BATTLE_H); g.lineTo(0, BATTLE_H);
    g.fill();
    return c;
  }

  _buildMid() {
    const [c, g] = this._mk();
    // 树丛/岩丘剪影
    g.fillStyle = '#7ba86f';
    for (const [x, w, h] of [[60, 90, 120], [300, 70, 90], [540, 110, 140]]) {
      g.beginPath();
      g.moveTo(x, 360); g.lineTo(x + w / 2, 360 - h); g.lineTo(x + w, 360);
      g.closePath(); g.fill();
    }
    g.fillStyle = '#8f9a8a';
    for (const [x, w, h] of [[200, 80, 40], [460, 100, 50]]) {
      g.beginPath(); g.ellipse(x, 380, w, h, 0, 0, Math.PI * 2); g.fill();
    }
    // 雾带(半透明横带,平移动效在 draw 时叠加,不进 tile)
    return c;
  }

  _buildNear() {
    const [c, g] = this._mk();
    const grass = g.createLinearGradient(0, 390, 0, BATTLE_H);
    grass.addColorStop(0, '#6cae57');
    grass.addColorStop(1, '#4f9040');
    g.fillStyle = grass;
    g.fillRect(0, 396, TILE_W, BATTLE_H - 396);
    // 花石点缀
    for (const [x, y, r, col] of [[90, 430, 5, '#e8e0c8'], [330, 442, 4, '#d88'], [600, 426, 6, '#e8e0c8']]) {
      g.fillStyle = col;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    return c;
  }

  // ---- 每帧推进 ----
  update(dt) {
    this.t += dt;
    if (this.shakeT > 0) this.shakeT -= dt;
    if (this.pulseT >= 0) {
      this.pulseT += dt;
      if (this.pulseT > 0.3) this.pulseT = -1; // pulse 0.3s:1.0→1.02→1.0
    }
    if (!this.effects) return;
    const style = AMBIENCE[this._themeKey()];
    while (this.ambientParticles.length < style.count) {
      this.ambientParticles.push({
        x: Math.random() * TILE_W, y: 68 + Math.random() * 320,
        vx: style.vx * (0.6 + Math.random() * 0.8),
        vy: style.vy * (0.6 + Math.random() * 0.8),
        radius: style.size * (0.65 + Math.random() * 0.7),
        angle: Math.random() * Math.PI,
      });
    }
    for (const p of this.ambientParticles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.x < -8) p.x = TILE_W + 8;
      if (p.x > TILE_W + 8) p.x = -8;
      if (p.y < 56) p.y = 407;
      if (p.y > 407) p.y = 56;
    }
  }

  // 变换参数供 render 使用:偏移(含 screenshake)与缩放(zoom pulse)
  transform() {
    let ox = 0, oy = 0, scale = 1;
    if (this.effects && this.shakeT > 0) {
      const p = this.shakeT / this.shakeDur; // M12:随可变时长衰减(受击/喊话各自口径)
      ox = Math.sin(this.t * 91) * this.shakeAmp * p;
      oy = Math.cos(this.t * 103) * this.shakeAmp * p;
    }
    if (this.effects && this.pulseT >= 0) {
      const q = this.pulseT / 0.3;
      scale = 1 + 0.02 * Math.sin(Math.PI * q); // 1.0→1.02→1.0
    }
    return { ox, oy, scale };
  }

  // ---- 绘制(每层 drawImage ≤2 次;ctx 已平移/缩放到战斗区坐标) ----
  draw(ctx) {
    const style = AMBIENCE[this._themeKey()];
    const hasFar = this.imgs.far?.complete && this.imgs.far.naturalWidth;
    if (hasFar) {
      ctx.drawImage(this.imgs.far, 0, 0, TILE_W, BATTLE_H);
    } else {
      // 程序化兜底(图未绑定:单测/演示)
      const fx = this.effects ? (this.t * FAR_SPEED) % LOOP_W : 0;
      this._drawLooped(ctx, this.far, fx);
      const mx = this.effects ? (this.t * MID_SPEED) % LOOP_W : 0;
      this._drawLooped(ctx, this.mid, mx);
    }
    if (this.effects) this._drawAmbience(ctx, style);
    // 近景:绑定图替代 tile+程序化草丛;否则原口径
    if (this.imgs.near && this.imgs.near.complete && this.imgs.near.naturalWidth) {
      ctx.drawImage(this.imgs.near, 0, BATTLE_H - 160, TILE_W, 160);
    } else {
      const nx = this.effects ? (this.t * NEAR_SPEED) % LOOP_W : 0;
      this._drawLooped(ctx, this.near, nx);
      if (this.effects) this._drawGrass(ctx);
    }
    // 远近景共用波次光照，首领额外压暗。实体和 HUD 在这些层之上绘制。
    if (hasFar && this.wave > 1) {
      ctx.fillStyle = `rgba(${style.dusk},${(style.duskOpacity * (this.wave - 1) / 9).toFixed(3)})`;
      ctx.fillRect(0, 0, TILE_W, BATTLE_H);
    }
    if (this.bossWave) {
      ctx.fillStyle = style.boss;
      ctx.fillRect(0, 0, TILE_W, BATTLE_H);
    }
  }

  _drawAmbience(ctx, style) {
    if (this.haze?.ctx !== ctx) {
      const gradient = ctx.createLinearGradient(0, 248, 0, 384);
      gradient.addColorStop(0, 'transparent');
      gradient.addColorStop(0.57, style.haze);
      gradient.addColorStop(1, 'transparent');
      this.haze = { ctx, gradient };
    }
    ctx.save();
    ctx.globalAlpha = 0.74 + Math.sin(this.t * 0.66) * 0.24;
    ctx.fillStyle = this.haze.gradient;
    ctx.fillRect(0, 248, TILE_W, 136);
    ctx.restore();
    ctx.fillStyle = style.color;
    ctx.beginPath();
    for (const p of this.ambientParticles) {
      const rx = p.radius * style.stretch;
      const angle = p.angle + 0.22 * Math.sin(this.t * 2 + p.angle);
      ctx.moveTo(p.x + rx * Math.cos(angle), p.y + rx * Math.sin(angle));
      ctx.ellipse(p.x, p.y, rx, p.radius, angle, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  _drawLooped(ctx, tile, off) {
    if (!tile) return;
    ctx.drawImage(tile, -off, 0);
    if (off > 0) ctx.drawImage(tile, LOOP_W - off, 0); // ≤2 次/层
  }

  _drawGrass(ctx) {
    // 草丛簇:正弦摆动 rotate ±3°,周期 2.5s(2~3s 区间中值)
    for (const gx of [140, 420, 660]) {
      const ang = Math.sin((this.t / 2.5) * Math.PI * 2 + gx) * 3 * Math.PI / 180;
      ctx.save();
      ctx.translate(gx, 448);
      ctx.rotate(ang);
      ctx.strokeStyle = '#4f9040';
      ctx.lineWidth = 3;
      for (const [dx, h] of [[-8, 26], [0, 34], [8, 24]]) {
        ctx.beginPath();
        ctx.moveTo(dx, 0);
        ctx.quadraticCurveTo(dx + 4, -h / 2, dx, -h);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}
