// scripts/battle/parallax.js
// 战斗区远中近景视差(00 文档 3.1 节,FR-1.5):
//   远景 0.15:天空渐变(晨→昏随波次推移)+太阳/云/远山剪影,云随 tile 横移循环 60~90s
//   中景 0.45:树丛/岩丘剪影+雾带平移,飘叶粒子(≤20,上浮+横飘)
//   近景 1.0 :草地+草丛簇正弦摆动(±3°,2~3s 周期)+花石点缀
// 约束:三层各为预渲染离屏 canvas tile,每帧每层 drawImage ≤2 次;粒子总数 ≤40;
//      程序化绘制,不新增贴图依赖;动效可整体关闭(关闭后功能不受影响)。
// 全局动效:受击 screenshake(4px/120ms);技能释放 zoom pulse(1.0→1.02→1.0)。
// 相对路径: scripts/battle/parallax.js

export const BATTLE_H = 448; // 战斗区高度(00 文档第 3 节)

const TILE_W = 720;             // tile 宽=视口宽,循环滚动需两份拼接
const LOOP_W = TILE_W;          // 循环周期宽(tile 本身可无缝首尾相接)
const FAR_LOOP_S = 75;          // 远景(含云)一个循环 75s——落在新设计「云横移 60~90s/圈」区间
const FAR_SPEED = LOOP_W / FAR_LOOP_S;    // 9.6 px/s 慢速漂移
const MID_SPEED = FAR_SPEED * 2;          // 19.2 px/s(层间相对:中景快于远景)
const NEAR_SPEED = FAR_SPEED * 3;         // 28.8 px/s(近景最快,仍为慢速漂移)
const LEAF_MAX = 20;            // 飘叶上限(中景)
const SHAKE_AMP = 4;            // screenshake 幅度 px
const SHAKE_TIME = 0.12;        // screenshake 时长 s

// 晨→昏天空色随波次推移(w_local 1..10 线性内插,草案色值,集中此处调参)
const SKY_TOP = [[126, 200, 227], [86, 96, 158]];    // 晨 → 昏
const SKY_BOT = [[201, 236, 245], [66, 58, 96]];

export class Parallax {
  constructor({ effects = true } = {}) {
    this.effects = effects;   // 动效总开关(false=静态分层底图,功能不受影响)
    this.t = 0;
    this.wave = 1;            // 当前 w_local(天空推移用)
    this.bossWave = false;    // Boss 波天色压暗 tint
    this.shakeT = 0;          // 受击 screenshake 剩余
    this.pulseT = -1;         // 技能 zoom pulse 计时(−1=未激活)
    this.leaves = [];         // 飘叶粒子 {x,y,vx,vy,s}
    this.far = null; this.mid = null; this.near = null;
    this._skyKey = '';
  }

  // 波次推进时重绘远景 tile(天空晨→昏);非每帧操作
  setWave(wLocal, bossWave) {
    this.wave = wLocal;
    this.bossWave = bossWave;
    this.buildTiles();
  }

  triggerShake() { if (this.effects) this.shakeT = SHAKE_TIME; }
  triggerPulse() { if (this.effects) this.pulseT = 0; }

  // ---- tile 生成(程序化,启动/换波各一次) ----
  buildTiles() {
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
    // 云 ×3(画进 tile,随远景 75s 循环横移)
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
    // 飘叶粒子补充(≤20)
    while (this.leaves.length < LEAF_MAX) {
      this.leaves.push({
        x: Math.random() * TILE_W, y: BATTLE_H - 100 - Math.random() * 200,
        vx: -14 - Math.random() * 12, vy: 8 + Math.random() * 10,
        s: 2 + Math.random() * 2,
      });
    }
    for (const l of this.leaves) {
      l.x += l.vx * dt; l.y += l.vy * dt;
      if (l.x < -8 || l.y > BATTLE_H) { l.x = TILE_W + Math.random() * 80; l.y = 60 + Math.random() * 200; }
    }
  }

  // 变换参数供 render 使用:偏移(含 screenshake)与缩放(zoom pulse)
  transform() {
    let ox = 0, oy = 0, scale = 1;
    if (this.effects && this.shakeT > 0) {
      const p = this.shakeT / SHAKE_TIME;
      ox = Math.sin(this.t * 91) * SHAKE_AMP * p;
      oy = Math.cos(this.t * 103) * SHAKE_AMP * p;
    }
    if (this.effects && this.pulseT >= 0) {
      const q = this.pulseT / 0.3;
      scale = 1 + 0.02 * Math.sin(Math.PI * q); // 1.0→1.02→1.0
    }
    return { ox, oy, scale };
  }

  // ---- 绘制(每层 drawImage ≤2 次;ctx 已平移/缩放到战斗区坐标) ----
  draw(ctx) {
    // 远景 tile 循环滚动(云随之 75s/圈)
    const fx = this.effects ? (this.t * FAR_SPEED) % LOOP_W : 0;
    this._drawLooped(ctx, this.far, fx);
    // 中景 tile 慢速漂移 + 雾带平移 + 飘叶
    const mx = this.effects ? (this.t * MID_SPEED) % LOOP_W : 0;
    this._drawLooped(ctx, this.mid, mx);
    if (this.effects) {
      const fogX = (this.t * 6) % (TILE_W * 2); // 雾带缓慢平移
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fillRect(-fogX, 300, TILE_W, 60);
      ctx.fillRect(TILE_W * 2 - fogX, 300, TILE_W, 60);
      ctx.fillStyle = 'rgba(180,200,120,.8)';
      for (const l of this.leaves) ctx.fillRect(l.x, l.y, l.s, l.s); // 批量绘制,无逐粒子状态切换
    }
    // 近景 tile + 草丛摆动(±3°,2~3s 周期)
    const nx = this.effects ? (this.t * NEAR_SPEED) % LOOP_W : 0;
    this._drawLooped(ctx, this.near, nx);
    if (this.effects) this._drawGrass(ctx);
    // Boss 波天色压暗 tint(画在层之上、实体之下)
    if (this.bossWave) {
      ctx.fillStyle = 'rgba(30,20,50,.28)';
      ctx.fillRect(0, 0, TILE_W, BATTLE_H);
    }
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
