// scripts/battle/enemy.js
// 最小敌人实体(M2):静态停位靶(推进/弹幕 M3 实装) + 灼烧 DOT + 减速标记
// HP 公式: HP = 30 × hp_mult × (1 + (w_global−1)×0.12)(04 文档第 3 节)
// 碰撞半径:圆形(FR-1.3),slime 贴图 0.5 缩放主体 ≈ 45px
// 相对路径: scripts/battle/enemy.js

export const ENEMY_RADIUS = 45;

export class Enemy {
  constructor({ name = 'slime', hp = 30, x = 560, y = 280 }) {
    this.name = name;
    this.maxHp = hp;
    this.hp = hp;
    this.x = x;
    this.y = y;
    this.alive = true;
    this.burn = null;        // {dpsFloat, until};到期由 tickBurn 清空(REQ-M2-01 整改)
    this.slowT = 0;          // 减速剩余秒数(M3 移动时按 SLOW_PCT 生效)
    this.deathT = 0;         // 死亡表现计时
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
