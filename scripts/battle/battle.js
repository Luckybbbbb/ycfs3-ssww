// scripts/battle/battle.js
// 战斗编排:M2 档位形态+DOT 保留;M3 增加波次/潮汐/敌方弹幕/胜负(FR-1.2/1.4、FR-4)
// 同刻顺序(03 文档 4.4 + M3 增补):投射物命中 → 周期效果跳伤 → 敌方行动/主角受击 → 技能自动释放判定
// 形态表(4.2):tier1 单体 / tier2 双目标 / tier3 三目标+溅射 r60 50% / tier4 范围 r90 全额 /
//             tier5 范围 r140 全额+范围内全体附加元素能力
// 相对路径: scripts/battle/battle.js

import { Enemy, ENEMY_SPAWN_X, MIN_QUEUE_GAP } from './enemy.js';
import { advanceBolt, findHitTargets, advanceEnemyBolt, enemyBoltHitsPlayer } from './projectile.js';
import { PLAYER_X, boltDamage, BURN_COEFF, LEECH_PCT, SHIELD_ATK, SLOW_PCT } from '../skills/registry.js';
import { buildWave, ENEMY_TYPES,
         enemyHp, enemyDmg, barrageDmg, enemySpd, attackInterval, barrageCount, fanAngle, barrageSpeed } from './wave.js';
import { ENEMY_STOP_X } from '../skills/registry.js';
import { tickZones, tickAura, tickBind } from '../skills/behaviors.js';

export const PHASE = { FIGHTING: 'FIGHTING', VICTORY: 'VICTORY', DEFEAT: 'DEFEAT' };

export class Battle {
  // expPerKill(M2 演示 API):传入则固定每杀经验;默认 null(M3)按 2+w_global 动态、Boss ×20(05 文档第 5 节)
  constructor({ atk = 10, maxHp = 100, expPerKill = null, level = 1, rng = null } = {}) {
    this.atk = atk;
    this.maxHp = maxHp;
    this.hp = maxHp;
    this.shield = 0;
    this.enemies = [];
    this.bolts = [];      // 主角技能弹
    this.ebolts = [];     // 敌方弹幕(FR-1.2)
    this.clock = 0;
    this.kills = 0;
    this.expGained = 0;
    this.expPerKill = expPerKill;
    this.log = [];            // 数字例复核用事件流水
    // M3 波次状态(FR-4)
    this.level = level;
    this.rng = rng;           // 注入 mulberry32(类型抽取可复现);null 时用 LCG 兜底
    this._rngFallback = 42;
    this.wave = 0;            // w_local 1..10;0=未开波
    this.wGlobal = 0;
    this.tides = [];          // 当前波潮汐序列 [[type,...],...]
    this.tideIdx = 0;
    this.phase = PHASE.FIGHTING;
    this.hurtT = 0;           // 主角受击闪白计时(FR-1.1 验收)
    this.shakeT = 0;          // 受击 screenshake(00 文档 3.1:4px/120ms)
    this.playerAttackT = 0;   // 主角攻击动画计时(释放技能时播放 walk_start 单次,16.7fps×3帧≈0.18s)
    this.zones = [];          // M4 行为区域(dotzone/field;behaviors.pushZone 维护,同技能刷新不叠加)
    this.aura = null;         // M4 生机光环(behaviors.applyAura 维护)
    this.invincibleT = 0;     // M5 无敌道具剩余秒(免伤;02 文档第 6 节)
  }

  // M2 演示 API(保留,单测依赖):敌人置于停位静态靶,不移动不攻击
  spawnWave(count, hp) {
    for (let i = 0; i < count; i++) {
      this.enemies.push(new Enemy({ hp, x: 560, y: 150 + i * 45 }));
    }
  }

  // ---- M3 波次编排(FR-4) ----
  startLevel(level = this.level) {
    this.level = level;
    this.wave = 0;
    this.tides = [];
    this.tideIdx = 0;
    this.enemies = [];
    this.bolts = [];      // 清上一局技能弹(F7:跨局状态不残留)
    this.ebolts = [];     // 清上一局敌方弹(F7:审核复算例——残留 19 伤弹带入次关)
    this.zones = [];      // 清行为区域
    this.aura = null;     // 清光环
    this.phase = PHASE.FIGHTING;
    this.nextWave();
  }

  nextWave() {
    this.wave += 1;
    this.wGlobal = (this.level - 1) * 10 + this.wave; // 04 文档第 4 节
    this.tides = buildWave(this.wave, this.level, this.rng || (() => this._fallbackRng()));
    this.tideIdx = 0;
    this.spawnTide();
  }

  // 无注入 rng 时的确定性兜底(LCG);有种子场景一律传 mulberry32
  _fallbackRng() {
    this._rngFallback = (this._rngFallback * 1103515245 + 12345) % 2147483648;
    return this._rngFallback / 2147483648;
  }

  // 潮汐刷怪:同屏 ≤5(每潮 ≤5 只);上一潮清空后刷下一潮。
  // 需求方增补:敌人只沿 X 轴排队(最小中心距 MIN_QUEUE_GAP),不纵向堆叠。
  // 出生点也按 MIN_QUEUE_GAP 逐只错开(屏外右缘起排),入场全程实际队距 ≥ MIN_QUEUE_GAP
  // (REQ-M3-03 整改 4:此前全员挤在 x=760,入场阶段实际间距为 0)。
  spawnTide() {
    const tide = this.tides[this.tideIdx];
    const bossWave = this.wave === 10;
    for (let i = 0; i < tide.length; i++) {
      const type = tide[i];
      const w = this.wGlobal;
      // Boss 居中,护卫上下错开(仍同列排队,仅 y 视觉错开);普通潮同赛道 y 一致
      const y = bossWave ? (type === 'boss' ? 230 : (i === 1 ? 150 : 300)) : 240;
      const spec = { name: type, w, x: ENEMY_SPAWN_X + i * MIN_QUEUE_GAP, y };
      this.enemies.push(this.makeEnemy(type, w, spec));
    }
    this.reassignSlots(); // 出生 x 升序 → 槽位 560+i×110,与入场顺序一致
    this.log.push({ t: this.clock, ev: 'tide', wave: this.wave, tide: this.tideIdx, types: tide.join(',') });
  }

  // X 轴队列槽位:存活敌按当前 x 升序(最靠前=最接近主角)排队,front=560,中心距 ≥ MIN_QUEUE_GAP;
  // 前排死亡后幸存者前移补位(逐个靠近,「慢慢靠近主角」的需求口径)
  reassignSlots() {
    const alive = this.enemies.filter(e => e.alive).sort((a, b) => a.x - b.x);
    alive.forEach((e, i) => { e.slotX = ENEMY_STOP_X + i * MIN_QUEUE_GAP; });
  }

  makeEnemy(type, w, spec) {
    // 数值由 wave.js 公式统一计算(04 文档第 3 节);此处只组装
    return new Enemy({
      ...spec,
      hp: enemyHp(type, w),
      dmg: enemyDmg(type, w),
      spd: enemySpd(w),
      interval: attackInterval(w),
      boltCount: barrageCount(w),
      fanDeg: fanAngle(w),
      boltSpeed: barrageSpeed(w),
      boltDmg: barrageDmg(type, w),
      radius: ENEMY_TYPES[type].radius,
    });
  }

  aliveEnemies() { return this.enemies.filter(e => e.alive); }

  // 03 文档 5.3:朝最近敌人释放(欧氏距离到主角站位)
  nearestAlive(exclude = []) {
    let best = null, bestD = Infinity;
    for (const e of this.enemies) {
      if (!e.alive || exclude.includes(e)) continue;
      const dx = e.x - PLAYER_X, dy = e.y - 280;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  // 统一击杀登记(REQ-M4-02 整改 F2):幂等——同一敌人只登记一次,
  // 供直击/灼烧/束缚/锁链/脉冲/灼烧区等全部伤害路径调用,杜绝同秒合杀重复计数
  registerKill(e) {
    if (!e || e.alive || e._killRegistered) return false; // 击杀入账时 alive 已为 false
    e._killRegistered = true;
    this.kills++;
    this.expGained += this.expFor(e);
    this.log.push({ t: this.clock, ev: 'kill', boss: !!e.isBoss });
    return true;
  }

  // 击杀经验:固定 expPerKill(M2)或 2+w_global(Boss ×20,05 文档第 5 节)
  expFor(e) {
    if (this.expPerKill != null) return this.expPerKill;
    const base = 2 + (e.w || this.wGlobal);
    return e.isBoss ? base * 20 : base;
  }

  // 释放判定后由 main/测试调用:按档位形态生成弹与作用(4.2 表)
  launch(castResult) {
    const target = this.nearestAlive();
    if (!target) return null;
    this.playerAttackT = 0.18; // 主角攻击动画(walk_start 3 帧 @16.7fps,对标 player.tscn startup)
    const el = castResult.element, tier = castResult.tier;
    const raw = boltDamage(this.atk, el, tier); // 浮点,入账时 round(4.4)
    this.log.push({ t: this.clock, ev: 'launch', el, tier });
    if (tier >= 4) {
      // 范围形态:单弹飞向最近敌,命中后以命中点为圆心 r90/tier4、r140/tier5 全额
      const b = this.makeBolt(el, tier, raw, target);
      b.blastR = tier === 5 ? 140 : 90;
      b.aoeAll = true;
      this.bolts.push(b);
    } else {
      // tier1 单体 / tier2 双目标 / tier3 三目标+溅射 r60 50%
      const picked = [];
      for (let i = 0; i < tier; i++) {
        const e = this.nearestAlive(picked);
        if (!e) break;
        picked.push(e);
        const b = this.makeBolt(el, tier, raw, e);
        b.splash = tier >= 3 ? { r: 60, mult: 0.5 } : null;
        this.bolts.push(b);
      }
    }
    return true;
  }

  makeBolt(el, tier, raw, target) {
    // target 仅决定弹道 y 与初始朝向;命中归属按路径先后(projectile.findHitTargets x 升序),
    // 不再按发射时距离冻结 flyTime(REQ-M3-03 整改 1:移动目标下原逻辑会穿过前排误中后排)
    return {
      el, tier, rawDmg: raw, x: PLAYER_X, y: target.y,
      t: 0, target, lastDt: 0,
      hitSet: new Set(), done: false, blastR: 0, aoeAll: false, splash: null, blasted: false,
    };
  }

  // 命中一个目标:伤害+元素能力(命中点/目标为作用中心)
  applyHit(b, e, mult = 1) {
    const dmg = Math.round(b.rawDmg * mult);
    const r = e.hurt(dmg);
    this.log.push({ t: this.clock, ev: 'hit', el: b.el, tier: b.tier, dmg, mult, hpAfter: e.hp, killed: r.killed, target: this.enemies.indexOf(e) });
    if (r.killed) this.registerKill(e);
    // 元素能力(4.3;灼烧刷新=覆盖 dpsFloat 并只延长 until,不重置跳伤时钟——4.4)
    if (b.el === 'fire') {
      const dps = this.atk * BURN_COEFF[b.tier - 1];
      const until = this.clock + 3;
      if (e.burn) { e.burn.dpsFloat = dps; e.burn.until = until; }
      else e.burn = { dpsFloat: dps, until };
    }
    if (b.el === 'water') {
      e.slowT = Math.max(e.slowT, 2); // 减速 2s
      e.slowPct = SLOW_PCT[b.tier - 1]; // 幅度按档位(03 文档 4.3;M3 移动/弹速消费)
    }
    if (b.el === 'wood') {
      const heal = Math.round(dmg * LEECH_PCT[b.tier - 1] / 100);
      this.hp = Math.min(this.maxHp, this.hp + heal);
      this.log.push({ t: this.clock, ev: 'leech', heal });
    }
    if (b.el === 'earth') {
      const add = Math.round(this.atk * SHIELD_ATK[b.tier - 1]);
      const cap = Math.round(this.maxHp * 0.3);
      this.shield = Math.min(cap, this.shield + add);
      this.log.push({ t: this.clock, ev: 'shield', add, shield: this.shield, cap });
    }
    return r;
  }

  // 主角受击:护盾先吸收,余量入 HP(03 文档第 3 节土行护盾语义;FR-1.4 失败判定)
  hurtPlayer(dmg) {
    if (this.invincibleT > 0) {
      this.log.push({ t: this.clock, ev: 'invincible_block', dmg });
      return 0;
    }
    const toShield = Math.min(this.shield, dmg);
    this.shield -= toShield;
    const rest = dmg - toShield;
    this.hp = Math.max(0, this.hp - rest);
    this.hurtT = 0.2;   // 受击闪白反馈
    this.shakeT = 0.12; // screenshake 4px/120ms(00 文档 3.1)
    this.log.push({ t: this.clock, ev: 'player_hurt', dmg, toShield, hp: this.hp });
    if (this.hp <= 0 && this.phase === PHASE.FIGHTING) {
      this.phase = PHASE.DEFEAT; // FR-1.4:失败不扣等级不扣解锁(D14,存档 M4 接)
      this.log.push({ t: this.clock, ev: 'defeat' });
    }
    return rest;
  }

  // 失败重试(05 文档第 2/6 节):从本关第 1 波重来,局内已获经验/击杀不清退
  restart() {
    this.enemies = [];
    this.bolts = [];
    this.ebolts = [];
    this.zones = [];  // 重试不保留区域/光环(F7)
    this.aura = null;
    this.hp = this.maxHp;
    this.shield = 0;
    this.hurtT = 0;
    this.shakeT = 0;
    this.startLevel(this.level);
  }

  update(dt) {
    // 受击反馈计时在结算后也要衰减(否则 DEFEAT 定格时闪白常驻)
    if (this.hurtT > 0) this.hurtT -= dt;
    if (this.shakeT > 0) this.shakeT -= dt;
    if (this.playerAttackT > 0) this.playerAttackT -= dt;
    if (this.invincibleT > 0) this.invincibleT -= dt; // 无敌按现实时间衰减(道具效果,02 第 6 节)
    if (this.phase !== PHASE.FIGHTING) return; // 结算后冻结(胜负弹层接管,FR-1.4)
    const prevClock = this.clock;
    this.clock += dt;
    // 1) 主角技能弹移动与命中(每帧全路径扫掠,路径上最先碰到的先结算)
    for (const b of this.bolts) {
      b.lastDt = dt; // 记录帧步长(扫掠检测用,REQ-M2-04 整改 2)
      advanceBolt(b, dt);
      // 命中归属:按路径先后(x 升序),谁先挡在弹道上谁先被命中,
      // 不再优先绑定目标(REQ-M3-03 整改 1);金穿透继续飞(每目标只一次,FR-1.3)
      const cands = findHitTargets(b, this.enemies);
      for (const cand of cands) {
        if (b.hitSet.has(cand)) continue; // 爆炸/溅射已命中过的目标不再直击(REQ-M2-04 整改 1)
        b.hitSet.add(cand);
        this.applyHit(b, cand, 1);
        if (b.aoeAll && !b.blasted) {
          // 范围形态:命中点为圆心,范围内全体(不含已在本弹命中过的)全额
          b.blasted = true;
          for (const e of this.enemies) {
            if (!e.alive || b.hitSet.has(e)) continue;
            const dx = e.x - cand.x, dy = e.y - cand.y;
            if (dx * dx + dy * dy <= b.blastR * b.blastR) {
              b.hitSet.add(e);
              this.applyHit(b, e, 1);
            }
          }
        } else if (b.splash) {
          // tier3 溅射:命中点 r60 内其他未受击敌 50%(同一颗弹每目标只一次)
          for (const e of this.enemies) {
            if (!e.alive || b.hitSet.has(e)) continue;
            const dx = e.x - cand.x, dy = e.y - cand.y;
            if (dx * dx + dy * dy <= 60 * 60) {
              b.hitSet.add(e);
              this.applyHit(b, e, b.splash.mult);
            }
          }
        }
        if (b.el !== 'metal') { b.done = true; break; } // 非金命中即消散;金穿透继续(FR-1.3,无档位例外)
      }
    }
    this.bolts = this.bolts.filter(b => !b.done && b.x < 780);
    // 2) 周期跳伤 + 状态生命周期(减速到期)+ 束缚 DOT(M4 行为内核)
    for (const e of this.enemies) {
      if (e.slowT > 0) e.slowT = Math.max(0, e.slowT - dt);
      const burnDmg = e.tickBurn(prevClock, this.clock);
      const bindDmg = tickBind(e, prevClock, this.clock);
      if (burnDmg > 0) {
        this.log.push({ t: this.clock, ev: 'burn', hpAfter: e.hp });
        this.registerKill(e); // 幂等:合杀时另一路径已登记则跳过(REQ-M4-02 整改 F2)
      }
      if (bindDmg > 0) {
        this.log.push({ t: this.clock, ev: 'bind', hpAfter: e.hp });
        this.registerKill(e); // 同上
      }
    }
    // 2.5) 区域/光环 tick(M4:dot 区逐秒跳伤、领域减速、光环回血;03 文档 4.4 周期口径)
    tickZones(this.zones, prevClock, this.clock, this.enemies, this); // ctx 供区内击杀登记(F2)
    tickAura(this.aura, prevClock, this.clock, this);
    // 3) 敌方行动(FR-1.2):队列补位 → 推进/进射程开火(扇形弹幕) → 敌方弹推进与主角碰撞
    this.reassignSlots();
    for (const e of this.enemies) {
      if (!e.alive) continue;
      for (const eb of e.update(dt, PLAYER_X, 280)) this.ebolts.push(eb);
    }
    // 队距守恒(REQ-M3-04 整改 2):速度差(如水弹减速)会破坏 110px 间距,
    // 按实际位置钳制——同赛道(y 相同)内后车不得越过「前车 x + MIN_QUEUE_GAP」。
    // 仅同赛道生效:M2 演示 API 的纵列双靶(同 x 不同 y)不是队列,不受钳制。
    const lanes = new Map();
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const key = Math.round(e.y);
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(e);
    }
    for (const list of lanes.values()) {
      list.sort((a, b) => a.x - b.x);
      for (let i = 1; i < list.length; i++) {
        const min = list[i - 1].x + MIN_QUEUE_GAP;
        if (list[i].x < min) list[i].x = min;
      }
    }
    for (const eb of this.ebolts) {
      eb.lastDt = dt;
      advanceEnemyBolt(eb, dt);
      if (enemyBoltHitsPlayer(eb, PLAYER_X, 280)) {
        eb.done = true;
        this.hurtPlayer(eb.dmg);
      }
    }
    this.ebolts = this.ebolts.filter(b => !b.done && b.x > -40 && b.x < 780 && b.y > -40 && b.y < 490);
    this.enemies = this.enemies.filter(e => e.alive || e.deathT < 0.4); // 死亡表现 0.4s 后移除
    for (const e of this.enemies) if (!e.alive) e.deathT += dt;
    // 4) 潮汐/波次推进(FR-4):本潮清空 → 下一潮;全波清空 → 下一波/通关
    if (this.phase === PHASE.FIGHTING && this.aliveEnemies().length === 0 && this.bolts.length === 0) {
      if (this.tideIdx < this.tides.length - 1) {
        this.tideIdx += 1;
        this.spawnTide();
      } else if (this.wave >= 10) {
        this.phase = PHASE.VICTORY; // FR-1.4:第 10 波清空 → 通关
        const bonus = 50 * this.level; // 通关奖励(05 文档第 5 节)
        this.expGained += bonus;
        this.log.push({ t: this.clock, ev: 'victory', bonus });
      } else if (this.wave > 0) {
        this.nextWave();
      }
    }
    // 5) 自动释放判定在外部(main/测试)按同刻顺序最后执行:caster.tryCast → battle.launch
  }
}
