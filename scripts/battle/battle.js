// scripts/battle/battle.js
// 战斗编排:M2 档位形态+DOT 保留;M3 增加波次/潮汐/敌方弹幕/胜负(FR-1.2/1.4、FR-4)
// 同刻顺序(03 文档 4.4 + M3 增补):投射物命中 → 周期效果跳伤 → 敌方行动/主角受击 → 技能自动释放判定
// 形态表(4.2):tier1 单体 / tier2 双目标 / tier3 三目标+溅射 r60 50% / tier4 范围 r90 全额 /
//             tier5 范围 r140 全额+范围内全体附加元素能力
// 相对路径: scripts/battle/battle.js

import { Enemy, ENEMY_SPAWN_X, MIN_QUEUE_GAP } from './enemy.js';
import { advanceBolt, findHitTargets, advanceEnemyBolt, enemyBoltHitsPlayer } from './projectile.js';
import { PLAYER_X, BOLT_SPEED, boltDamage, BURN_COEFF, LEECH_PCT, SHIELD_ATK, SLOW_PCT, critChance, CRIT_MULT } from '../skills/registry.js';
import { buildWave, ENEMY_TYPES,
         enemyHp, enemyDmg, barrageDmg, enemySpd, attackInterval, barrageCount, fanAngle, barrageSpeed } from './wave.js';
import { ENEMY_STOP_X } from '../skills/registry.js';
import { tickZones, tickAura, tickBind, markSlow } from '../skills/behaviors.js';
import { killReward } from '../meta/economy.js';

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
    this.expGained = 0;      // M2 演示口径保留(单测依赖);v0.2 局内产出如下
    this.coinsGained = 0;    // M6 v0.2 击杀产出(货币 2+w_global,Boss ×20;03 文档 2.2)
    this.matsGained = 0;     // M6 v0.2 击杀产出(材料普通 1/Boss 20)
    this.floatTexts = [];    // v0.3 伤害冒字事件队列(纯数据;03 文档 6.5——battle 不 import ui,main 每帧 drainFloatTexts 转发 fx)
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
    this.shield = 0;      // 清上一局护盾(REQ-M4-03 F7 续审:石甲术盾不带入次关)
    this.invincibleT = 0; // 清上一局无敌(道具免伤不跨局)
    this.hurtT = 0;       // 清受击闪白
    this.shakeT = 0;      // 清受击震动
    this.coinsGained = 0; // 清本局经济产出累计(新局重计)
    this.matsGained = 0;
    this.floatTexts = []; // 清冒字事件队列(跨局不残留)
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

  // 统一随机源入口(暴击 roll 等战斗内随机;注入 rng 时可复现,否则走 LCG 兜底)
  roll() {
    return this.rng ? this.rng() : this._fallbackRng();
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
    const rw = killReward(e.w || this.wGlobal, !!e.isBoss); // M6 v0.2 经济产出(幂等同 kills)
    this.coinsGained += rw.coins;
    this.matsGained += rw.mats;
    this.log.push({ t: this.clock, ev: 'kill', boss: !!e.isBoss });
    this.floatEvent({ kind: 'kill', x: e.x, y: e.y, importance: 2 }); // `击破`(每次击杀固定 1 条;03 文档 6.2a)
    return true;
  }

  // ===== v0.3 伤害冒字事件队列(03 文档 6.5):battle 产纯数据事件,main 转发 fx 层绘制 =====
  // ev={kind, x, y, n?, el?, fromAngle?, jitter?, importance?};颜色/文案映射在 fx 层(FT_STYLE),
  // 方向缺省(跳伤/主角处增益)由 fx 默认向上 ±0.8rad;弹道类由调用方给 fromAngle(弹速/源点→被击敌)。
  floatEvent(ev) {
    this.floatTexts.push(ev);
  }
  drainFloatTexts() {
    const out = this.floatTexts;
    this.floatTexts = [];
    return out;
  }

  // 击杀经验:固定 expPerKill(M2)或 2+w_global(Boss ×20,05 文档第 5 节)
  expFor(e) {
    if (this.expPerKill != null) return this.expPerKill;
    const base = 2 + (e.w || this.wGlobal);
    return e.isBoss ? base * 20 : base;
  }

  // 释放判定后由 main/测试调用:按档位形态生成弹与作用(4.2 表)
  // skill_mult 烘焙(REQ-M6-04 F5):乘数随 castResult.mult 传入,发射时快照
  // effAtk=atk×mult 入弹(b.atkEff)——命中时刻的灼烧/土盾(applyHit)同乘,不读已恢复的 this.atk
  launch(castResult) {
    const target = this.nearestAlive();
    if (!target) return null;
    this.playerAttackT = 0.18; // 主角攻击动画(walk_start 3 帧 @16.7fps,对标 player.tscn startup)
    const el = castResult.element, tier = castResult.tier;
    const mult = castResult.mult || 1;
    const effAtk = this.atk * mult;
    const raw = boltDamage(effAtk, el, tier); // 浮点,入账时 round(4.4)
    this.log.push({ t: this.clock, ev: 'launch', el, tier, mult });
    if (tier >= 4) {
      // 范围形态:单弹飞向最近敌,命中后以命中点为圆心 r90/tier4、r140/tier5 全额
      const b = this.makeBolt(el, tier, raw, target, effAtk);
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
        const b = this.makeBolt(el, tier, raw, e, effAtk);
        b.splash = tier >= 3 ? { r: 60, mult: 0.5 } : null;
        this.bolts.push(b);
      }
    }
    return true;
  }

  makeBolt(el, tier, raw, target, atkEff = null) {
    // target 仅决定弹道 y 与初始朝向;命中归属按路径先后(projectile.findHitTargets x 升序),
    // 不再按发射时距离冻结 flyTime(REQ-M3-03 整改 1:移动目标下原逻辑会穿过前排误中后排)
    // atkEff:发射时刻有效攻击(atk×skill_mult,REQ-M6-04 F5);null(行为内核造弹)时命中按 this.atk
    return {
      el, tier, rawDmg: raw, atkEff, x: PLAYER_X, y: target.y,
      vx: BOLT_SPEED, vy: 0, // 弹速方向(直线匀速水平右;直击冒字 fromAngle=atan2(vy,vx),6.3/REQ-M7-01 F1)
      t: 0, target, lastDt: 0,
      hitSet: new Set(), done: false, blastR: 0, aoeAll: false, splash: null, blasted: false,
    };
  }

  // 命中一个目标:伤害+元素能力(命中点/目标为作用中心)
  // center:范围/溅射形态的爆炸中心(REQ-M7-01 F1:溅射与 tier4/5 范围伤害的方向=中心→被击敌,
  // 不用帧末弹位置——帧末弹已越过命中点,方向失真);直击缺省用弹速方向
  applyHit(b, e, mult = 1, center = null) {
    // 暴击(2026-10-17 M8;03 文档 6.2d):仅弹道直击(mult=1,溅射/多段系数不暴击);
    // 率=critChance(b.tier)=5%+档位×4%,倍率 CRIT_MULT=1.5,先乘后结算(N 仍=实际 applied)
    const isSplash = mult !== 1 && b.splash;
    let dmg = Math.round(b.rawDmg * mult);
    let crit = false;
    if (!isSplash) {
      crit = this.roll() < critChance(b.tier);
      if (crit) dmg = Math.round(dmg * CRIT_MULT);
    }
    const r = e.hurt(dmg, { flash: true, crit });
    this.log.push({ t: this.clock, ev: 'hit', el: b.el, tier: b.tier, dmg, mult, crit, hpAfter: e.hp, killed: r.killed, target: this.enemies.indexOf(e) });
    if (r.killed) this.registerKill(e);
    // 伤害冒字(v0.3 6.2a/6.4):N=本次结算实际 applied(致死溢出受剩余 HP 限制,enemy.hurt min(hp,dmg));
    // 方向(6.3,REQ-M7-01 F1):溅射/范围=爆炸中心→被击敌;直击=弹速方向(makeBolt vx/vy 真实弹速)
    this.floatEvent({
      kind: isSplash ? 'splash' : 'dmg', x: e.x, y: e.y, n: r.applied, el: b.el, crit,
      fromAngle: center
        ? Math.atan2(e.y - center.y, e.x - center.x)
        : (typeof b.vx === 'number' || typeof b.vy === 'number' ? Math.atan2(b.vy || 0, b.vx == null ? -1 : b.vx) : null),
      importance: isSplash ? 0 : 1,
    });
    // 元素能力(4.3;灼烧刷新=覆盖 dpsFloat 并只延长 until,不重置跳伤时钟——4.4)
    // 有效攻击取发射时刻快照 b.atkEff(REQ-M6-04 F5:技能等级乘数覆盖命中时刻计算)
    const atkEff = b.atkEff ?? this.atk;
    if (b.el === 'fire') {
      const dps = atkEff * BURN_COEFF[b.tier - 1];
      const until = this.clock + 3;
      if (e.burn) { e.burn.dpsFloat = dps; e.burn.until = until; }
      else e.burn = { dpsFloat: dps, until };
    }
    if (b.el === 'water') {
      e.slowT = Math.max(e.slowT, 2); // 减速 2s
      e.slowPct = SLOW_PCT[b.tier - 1]; // 幅度按档位(03 文档 4.3;M3 移动/弹速消费)
      // 减速施加冒字:状态跃迁判定(03 文档 6.2b——首用/换源/增强才冒;逐帧续时/同幅刷新不冒)
      if (markSlow(e, b.skillId || `${b.el}_bolt`, e.slowPct, 0)) {
        this.floatEvent({ kind: 'slowMark', x: e.x, y: e.y, importance: 0 });
      }
    }
    if (b.el === 'wood') {
      const heal = Math.round(dmg * LEECH_PCT[b.tier - 1] / 100);
      const hpBefore = this.hp;
      this.hp = Math.min(this.maxHp, this.hp + heal);
      const gained = this.hp - hpBefore;
      this.log.push({ t: this.clock, ev: 'leech', heal });
      if (gained > 0) this.floatEvent({ kind: 'leech', x: PLAYER_X, y: 280, n: gained, importance: 1 }); // 实际回复,满血 0 不产(6.4)
    }
    if (b.el === 'earth') {
      const add = Math.round(atkEff * SHIELD_ATK[b.tier - 1]);
      const cap = Math.round(this.maxHp * 0.3);
      const shBefore = this.shield;
      this.shield = Math.min(cap, this.shield + add);
      const gained = this.shield - shBefore;
      this.log.push({ t: this.clock, ev: 'shield', add, shield: this.shield, cap });
      if (gained > 0) this.floatEvent({ kind: 'shieldGain', x: PLAYER_X, y: 280, n: gained, importance: 1 }); // 实际增量,盾满 0 不产
    }
    return r;
  }

  // 主角受击:护盾先吸收,余量入 HP(03 文档第 3 节土行护盾语义;FR-1.4 失败判定)
  // fromAngle:敌弹方向(受击冒字,REQ-M7-01 F1;缺省向上)
  hurtPlayer(dmg, fromAngle = null) {
    if (this.invincibleT > 0) {
      this.log.push({ t: this.clock, ev: 'invincible_block', dmg });
      this.floatEvent({ kind: 'immune', x: PLAYER_X, y: 280, importance: 2 }); // `免伤`(无敌;6.2a)
      return 0;
    }
    const hpBefore = this.hp;
    const toShield = Math.min(this.shield, dmg);
    this.shield -= toShield;
    const rest = dmg - toShield;
    this.hp = Math.max(0, this.hp - rest);
    const realDmg = hpBefore - this.hp; // 主角受击 N=结算前后 HP 差值(裁决 F3:hurtPlayer 返回伤害额非实扣)
    this.hurtT = 0.2;   // 受击闪白反馈
    this.shakeT = 0.12; // screenshake 4px/120ms(00 文档 3.1)
    this.log.push({ t: this.clock, ev: 'player_hurt', dmg, toShield, hp: this.hp });
    // 受击冒字拆分(6.4;REQ-M7-01 F2 修正):**部分吸收**→`🛡N`+`-N` 并显;
    // **完全吸收/实扣 0→仅 `免伤`**(不产 absorb);实扣>0 无盾→仅 `-N`
    if (realDmg > 0) {
      if (toShield > 0) this.floatEvent({ kind: 'absorb', x: PLAYER_X, y: 280, n: toShield, importance: 1 });
      this.floatEvent({ kind: 'hurt', x: PLAYER_X, y: 280, n: realDmg, fromAngle, importance: 1 });
    } else if (toShield > 0) {
      this.floatEvent({ kind: 'immune', x: PLAYER_X, y: 280, importance: 2 });
    }
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
    // M8-F2:敌人受击反馈计时按现实时间衰减——死敌(update 不再调用)与结算定格期(VICTORY/DEFEAT
    // 提前 return)也要到期,否则最后一杀的白闪/卡肉常驻结算画面
    const m8Fighting = this.phase === PHASE.FIGHTING;
    for (const e of this.enemies) {
      if (m8Fighting && e.alive) continue; // 活敌在 FIGHTING 内由 e.update 衰减(避免双计)
      e.hitFlashT = Math.max(0, (e.hitFlashT || 0) - dt);
      e.hitStopT = Math.max(0, (e.hitStopT || 0) - dt);
    }
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
              this.applyHit(b, e, 1, cand); // 方向=爆炸中心(命中点)→被击敌(REQ-M7-01 F1)
            }
          }
        } else if (b.splash) {
          // tier3 溅射:命中点 r60 内其他未受击敌 50%(同一颗弹每目标只一次)
          for (const e of this.enemies) {
            if (!e.alive || b.hitSet.has(e)) continue;
            const dx = e.x - cand.x, dy = e.y - cand.y;
            if (dx * dx + dy * dy <= 60 * 60) {
              b.hitSet.add(e);
              this.applyHit(b, e, b.splash.mult, cand); // 方向=爆炸中心(命中点)→被溅射敌(REQ-M7-01 F1)
            }
          }
        }
        if (b.el !== 'metal') { b.done = true; break; } // 非金命中即消散;金穿透继续(FR-1.3,无档位例外)
      }
    }
    this.bolts = this.bolts.filter(b => !b.done && b.x < 780);
    // 2) 周期跳伤 + 状态生命周期(减速到期:slowT 归零清提示标记,重入可再提示)+ 束缚 DOT(M4 行为内核)
    for (const e of this.enemies) {
      if (e.slowT > 0) {
        e.slowT = Math.max(0, e.slowT - dt);
        if (e.slowT === 0) { e.slowMarkSrc = null; e.slowMarkGen = 0; } // 失效清标记(6.2b 重入跃迁的前置)
      }
      const burnDmg = e.tickBurn(prevClock, this.clock);
      const bindDmg = tickBind(e, prevClock, this.clock);
      if (burnDmg > 0) {
        this.log.push({ t: this.clock, ev: 'burn', hpAfter: e.hp });
        this.floatEvent({ kind: 'burn', x: e.x, y: e.y, n: burnDmg, fromAngle: null, importance: 0 }); // 🔥N 每整秒(60fps 单帧至多跨 1 整秒;卡顿跨多跳时合并为合计一条)
        this.registerKill(e); // 幂等:合杀时另一路径已登记则跳过(REQ-M4-02 整改 F2)
      }
      if (bindDmg > 0) {
        this.log.push({ t: this.clock, ev: 'bind', hpAfter: e.hp });
        this.floatEvent({ kind: 'bindDot', x: e.x, y: e.y, n: bindDmg, el: e.bindEl || 'wood', fromAngle: null, importance: 0 }); // 🌿N 每整秒(元素=绑定时刻 skill.el)
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
        this.hurtPlayer(eb.dmg, Math.atan2(eb.vy, eb.vx)); // 受击冒字方向=敌弹方向(6.3,REQ-M7-01 F1)
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
