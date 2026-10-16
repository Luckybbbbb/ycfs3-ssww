// scripts/battle/enemy.js
// 敌人实体:右缘屏外生成→左移至停位 x=560→按间隔发扇形弹幕(04 文档第 2/3 节,FR-1.2)
// M2 基础保留:灼烧 DOT + 减速标记;M3 增加移动/弹幕/类型化数值
// 相对路径: scripts/battle/enemy.js

import { ENEMY_STOP_X } from '../skills/registry.js';
import { ENEMY_TYPES } from './wave.js';

export const ENEMY_RADIUS = 45;      // 默认碰撞半径(slime 0.5 缩放主体 ≈ 45px)
export const BOSS_RADIUS = 60;       // Boss 贴图更大(FR-1.3:敌人按贴图缩放定)
export const ENEMY_SPAWN_X = 760;    // 战斗区右缘屏外(720 宽 + 40 余量)
export const PLAYER_HIT_R = 40;      // 主角判定半径(FR-1.3,04 文档第 2 节)
export const PLAYER_Y = 280;         // 主角判定中心(站位 x=110 由 registry 提供)
export const ATTACK_RANGE = 500;     // 开火射程(04 文档第 2 节:进射程才攻击)
export const MIN_QUEUE_GAP = 110;    // X 轴队列最小中心距(需求方增补:只横向堆叠,草案值 M5 校准)

export class Enemy {
  // 兼容 M2 演示 API:new Enemy({hp, x, y}) → 静态停位靶(spd=0 不移动不攻击)
  // M3 波次实体:new Enemy(spec) 由 wave/battle 传入完整数值(wave.js 公式计算结果)
  constructor({ name = 'slime', hp = 30, x = 560, y = 280,
                dmg = 0, spd = 0, interval = 0, boltCount = 0, fanDeg = 0,
                boltSpeed = 0, boltDmg = 0, w = 0, radius = ENEMY_RADIUS } = {}) {
    this.name = name;
    this.maxHp = hp;
    this.hp = hp;
    this.x = x;
    this.y = y;
    this.alive = true;
    // 弹幕参数
    this.dmg = dmg;            // 面板伤害(round(DMG))
    this.spd = spd;            // 左移速度 px/s
    this.interval = interval;  // 攻击间隔 s
    this.boltCount = boltCount;
    this.fanDeg = fanDeg;
    this.boltSpeed = boltSpeed;
    this.boltDmg = boltDmg;    // 弹幕伤害(round(DMG_float×0.5))
    this.w = w;                // w_global(击杀经验 = 2+w, Boss ×20)
    this.radius = radius;
    this.stopX = ENEMY_STOP_X;
    this.slotX = null;         // X 轴队列槽位目标(battle 分配;null 时用 stopX)
    this.atkTimer = 0;         // 攻击计时(进射程才累计,对标 enemy.gd 超距钳制 interval×0.5)
    this.burn = null;          // {dpsFloat, until};到期由 tickBurn 清空(REQ-M2-01 整改)
    this.slowT = 0;            // 减速剩余秒数(水弹命中,03 文档第 3 节)
    this.slowPct = 0;          // 减速幅度(百分点;速度 ×(1−pct/100))
    this.deathT = 0;           // 死亡表现计时
    this.attackAnimT = 0;      // 攻击动画剩余秒(开火时置满,单次播放)
    const t = ENEMY_TYPES[name];
    // 攻击动画时长 = 帧数 / (fps×2)(开火时序列帧加速单次播放;待机仍按原 fps 循环)
    this.animDur = t ? t.frames.length / (t.fps * 2) : 0;
  }

  get isBoss() { return this.name === 'boss'; }
  // 减益语义(03 文档 4.4):「减 30%」= 属性 ×0.70
  slowFactor() { return this.slowT > 0 ? 1 - this.slowPct / 100 : 1; }

  // 推进 + 队列攻击;返回本帧发射的弹幕数组(空数组=未开火)。
  // 需求方增补(04 文档第 2 节增补):只沿 X 轴排队(最小中心距 MIN_QUEUE_GAP,槽位由 battle 分配),
  // 慢速逼近主角,进开火射程(ATTACK_RANGE)才累计攻击计时;超距时计时钳制在间隔×0.5(对标 enemy.gd)。
  update(dt, px, py) {
    if (!this.alive) return [];
    if (this.attackAnimT > 0) this.attackAnimT = Math.max(0, this.attackAnimT - dt);
    let fired = [];
    const target = this.slotX ?? this.stopX;
    if (this.spd > 0 && this.x > target) {
      // 左移至队列槽位(水面弹减速同时作用于移速,03 文档第 3 节「移速/弹速」)
      this.x = Math.max(target, this.x - this.spd * this.slowFactor() * dt);
    }
    if (this.interval > 0 && this.x - px <= ATTACK_RANGE) {
      this.atkTimer += dt;
      if (this.atkTimer >= this.interval) {
        this.atkTimer -= this.interval;
        fired = this.fireFan(px, py);
        if (fired.length) this.attackAnimT = this.animDur; // 攻击动画单次播放
      }
    } else if (this.interval > 0) {
      this.atkTimer = Math.max(this.atkTimer, this.interval * 0.5); // 超距钳制(进射程后快速首发)
    }
    return fired;
  }

  // 扇形弹幕(对标 roguelike enemy_projectile_manager.gd:46-61 fire_spread):
  // 始终有一颗 0° 直射弹,其余 count−1 颗按 side(±)×level(1,1,2,2…)×step 分到两侧;
  // step = half_spread / max(1, (count−1)/2),half = fanDeg/2。
  // 原版首击计时带随机相位(randf×interval),此处取 0(确定性,单测可复现)。
  fireFan(px, py) {
    const base = Math.atan2(py - this.y, px - this.x);
    const n = this.boltCount;
    const half = (this.fanDeg * Math.PI / 180) / 2;
    const speed = this.boltSpeed * this.slowFactor(); // 减速同时作用于弹速(03 文档第 3 节)
    const bolts = [];
    const fire = (ang) => bolts.push({
      x: this.x, y: this.y,
      vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      dmg: this.boltDmg, t: 0, from: this,
    });
    if (n <= 1) { fire(base); return bolts; }
    fire(base); // 0° 直射
    const remaining = n - 1;
    const step = half / Math.max(1, remaining / 2);
    for (let k = 1; k <= remaining; k++) {
      const side = k % 2 === 1 ? 1 : -1;  // 奇数正侧,偶数负侧
      const level = Math.ceil(k / 2);     // 1,1,2,2,3,3…整数级;最大偏角=half,总张角=fanDeg
      fire(base + side * level * step);   // (REQ-M3-03 整改 5:此前 (k+1)/2 产生 1.5 级半角档,实际张角超出公式)
    }
    return bolts;
  }

  // 伤害入账(4.4:round 后的整值);返回 {applied, killed}——killed 仅在本次伤害致死后为真
  hurt(dmg) {
    if (!this.alive) return { applied: 0, killed: false };
    const d = Math.min(this.hp, dmg);
    this.hp -= d;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
    return { applied: d, killed: !this.alive };
  }

  // 灼烧跳伤:显式整秒边界驱动(帧跨过整秒即在帧内结算,浮点安全;4.4)
  // 先跳伤后清理;到期按真实时间 clock > until(浮点容差),不因取整截断最后一个跳伤
  tickBurn(prevClock, clock) {
    if (!this.alive) return 0;
    let total = 0;
    if (this.burn) {
      const from = Math.floor(prevClock + 1e-9) + 1;
      const to = Math.floor(clock + 1e-9);
      for (let s = from; s <= to; s++) {
        if (s > this.burn.until + 1e-9) break; // 持续期外(灼烧 0.75~3.75 → t=1,2,3 跳 3 次)
        total += this.hurt(Math.round(this.burn.dpsFloat)).applied;
      }
    }
    if (this.burn && clock > this.burn.until + 1e-9) this.burn = null; // 到期清理(REQ-M2-02 整改 4)
    if (total && !this.alive) this.burn = null;
    return total;
  }
}
