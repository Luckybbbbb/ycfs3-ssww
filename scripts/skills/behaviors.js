// scripts/skills/behaviors.js
// 非子弹类技能行为实装(03 文档 5.2):实现八类非子弹技能行为 dotzone/chain/bind/multi/shield/pulse/field/aura
// 纯函数、以 ctx(battle 兼容接口:atk/maxHp/hp/shield/enemies/bolts/makeBolt/clock)操作;
// 区域(zones)/光环(aura)状态与逐秒 tick 以纯函数提供,battle 接线在 M4 集成时完成。
// 口径:非子弹类主数值 ×4.2 档位倍率(4.4);计算浮点、作用时 round;区域/光环重复释放=刷新时长按新档位,不叠加。
// 相对路径: scripts/skills/behaviors.js

import { TIER_MULT } from './registry.js';
import { tiered, skillById } from './library.js';

const TM = (tier) => TIER_MULT[tier - 1];

// ---- 减速提示跃迁判定(03 文档 6.2b,REQ-SSWW-DESIGN-v0.3-02 裁决 F1):----
// 领域内每帧 slowT 被续 0.1s(battle 逐帧扣减)——「时长增加」不可作提示条件;
// 仅四种状态跃迁冒字:①首次生效/失效重入(无标记)②换源 ③幅度增强 ④主动重放(gen 变化)。
// 调用方(applyHit water / tickZones slow)在跃迁为真时产 slowMark 冒字事件。
export function markSlow(e, srcId, pct, gen = 0) {
  if (!e.slowMarkSrc || e.slowMarkSrc !== srcId) {
    e.slowMarkSrc = srcId; e.slowMarkPct = pct; e.slowMarkGen = gen;
    return true; // 首次生效 / 失效后重入 / 换源
  }
  if (pct > (e.slowMarkPct || 0) || gen !== e.slowMarkGen) {
    e.slowMarkPct = pct; e.slowMarkGen = gen;
    return true; // 幅度增强 / 主动重放(同技能 zone 重新释放,pushZone gen+1)
  }
  return false; // 同源同幅持续(逐帧续时):不冒字
}

// ---- 寒冰锁链(water_chain):主目标 + ⌊2+tier/2⌋ 个邻近,各 ATK×0.6×档位倍率 ----
// 4.5 数字例:tier2 总 4(额外 3)、tier5 总 5(额外 ⌊4.5⌋=4)
export function chainExtra(tier) { return 2 + Math.floor(tier / 2); }
export function chainTargets(tier) { return 1 + chainExtra(tier); }
export function applyChain(ctx, skill, tier) {
  const primary = ctx.nearestAlive();
  if (!primary) return 0;
  const n = chainTargets(tier);
  const dmg = Math.round(tiered(skill, ctx.atk, tier));
  const picked = [primary];
  for (let i = 1; i < n; i++) {
    const e = ctx.nearestAlive(picked);
    if (!e) break;
    picked.push(e);
  }
  for (const e of picked) {
    const r = e.hurt(dmg, { flash: true }); // M8 受击反馈:锁链直击白闪+卡肉(不暴击,暴击仅 applyHit)
    // 伤害冒字(03 文档 6.5:锁链直呼 e.hurt 不经 applyHit——行为内核产事件;元素来源=skill.el)
    // 方向=中心敌→被击敌;中心自身方向缺省(向上)
    ctx.floatEvent({
      kind: 'dmg', x: e.x, y: e.y, n: r.applied, el: skill.el,
      fromAngle: e === primary ? null : Math.atan2(e.y - primary.y, e.x - primary.x),
      importance: 1,
    });
    if (r.killed) ctx.registerKill(e); // 统一击杀登记(F2)
  }
  return picked.length;
}

// ---- 藤蔓束缚(wood_bind):束缚最近敌 1.5s + 每秒 ATK×0.3×档位倍率(束缚期内逐整秒跳) ----
export function applyBind(ctx, skill, tier) {
  const e = ctx.nearestAlive();
  if (!e) return null;
  e.bindT = skill.params.bindTime;                 // 消费(停止移动/攻击)在 enemy 接线
  e.bindDps = ctx.atk * skill.params.dpsCoef * TM(tier);
  e.bindUntil = ctx.clock + skill.params.bindTime;
  e.bindEl = skill.el;                             // 跳伤冒字元素来源(6.2a:🌿N 木色)
  // 束缚施加标记(6.2b):施加=一次冒字;重复施加刷新 bindUntil→再冒 1 条
  ctx.floatEvent({ kind: 'bindMark', x: e.x, y: e.y, importance: 1 });
  return e;
}
// 束缚 DOT 逐整秒跳伤(与灼烧同口径:先跳后清)
export function tickBind(e, prevClock, clock) {
  if (!e.alive || !e.bindT || !e.bindDps) return 0;
  let total = 0;
  const from = Math.floor(prevClock + 1e-9) + 1;
  const to = Math.min(Math.floor(clock + 1e-9), Math.floor(e.bindUntil + 1e-9));
  for (let s = from; s <= to; s++) total += e.hurt(Math.round(e.bindDps)).applied;
  if (clock > e.bindUntil + 1e-9) { e.bindT = 0; e.bindDps = 0; }
  return total;
}

// ---- 贯日连珠(metal_multi):3 发弹各 ATK×0.7×档位倍率(多目标:按最近序分配) ----
export function applyMulti(ctx, skill, tier) {
  const raw = tiered(skill, ctx.atk, tier);
  const fired = [];
  const picked = [];
  for (let i = 0; i < skill.params.count; i++) {
    // 3 发弹按最近序分配(5.1);目标不足 count 时回落最近敌,仍发满 count 发
    // (REQ-M4-02 整改 F8:单敌场景也发满 3 发)
    const e = ctx.nearestAlive(picked) || ctx.nearestAlive();
    if (!e) break;
    if (!picked.includes(e)) picked.push(e);
    const b = ctx.makeBolt(skill.el, tier, raw, e);
    b.skillId = skill.id;
    ctx.bolts.push(b);
    fired.push(b);
  }
  return fired.length;
}

// ---- 石甲术(earth_shield):护盾 ATK×2×档位倍率,封顶 30% maxHP(溢出不存) ----
export function applyShieldSpell(ctx, skill, tier) {
  const add = Math.round(tiered(skill, ctx.atk, tier));
  const cap = Math.round(ctx.maxHp * 0.3);
  const before = ctx.shield;
  ctx.shield = Math.min(cap, ctx.shield + add);
  const gained = ctx.shield - before;
  // 冒字(6.5:石甲直加盾不经 applyHit——行为内核产事件;N=实际增量,盾满 0 不产;6.4)
  if (gained > 0) ctx.floatEvent({ kind: 'shieldGain', x: ctx.px ?? 110, y: 280, n: gained, importance: 1 });
  return { add, shield: ctx.shield, cap };
}

// ---- 脉冲(fire_pulse/metal_pulse/earth_pulse):以最近敌人为中心,半径内全体 ATK×coef×档位倍率 ----
// 裂地脉冲附加眩晕 0.5s(消费在 enemy 接线)
export function applyPulse(ctx, skill, tier) {
  const center = ctx.nearestAlive();
  if (!center) return 0;
  const dmg = Math.round(tiered(skill, ctx.atk, tier));
  let hits = 0;
  for (const e of ctx.enemies) {
    if (!e.alive) continue;
    const dx = e.x - center.x, dy = e.y - center.y;
    if (dx * dx + dy * dy <= skill.params.r * skill.params.r) {
      const r = e.hurt(dmg, { flash: true }); // M8 受击反馈:脉冲直击白闪+卡肉(不暴击)
      // 伤害冒字(6.5:脉冲直呼 e.hurt 不经 applyHit;元素来源=skill.el;方向=中心→被击敌)
      ctx.floatEvent({
        kind: 'dmg', x: e.x, y: e.y, n: r.applied, el: skill.el,
        fromAngle: e === center ? null : Math.atan2(e.y - center.y, e.x - center.x),
        importance: 1,
      });
      if (r.killed) ctx.registerKill(e); // 统一击杀登记(F2)
      if (skill.params.stunTime) {
        const stronger = !e.stunT || skill.params.stunTime > e.stunT;
        e.stunT = Math.max(e.stunT || 0, skill.params.stunTime);
        // 眩晕标记(6.2b):施加=一次冒字;仅更强覆盖时再冒 1 条
        if (stronger) ctx.floatEvent({ kind: 'stunMark', x: e.x, y: e.y, importance: 1 });
      }
      hits++;
    }
  }
  return hits;
}

// ---- 区域(dotzone/field)与光环(aura):状态为纯数据,由 battle 接线每帧 tick ----
// zones: [{kind:'dot'|'slow', x, y, r, dpsFloat?, slowPct?, until}](同种区域刷新不叠加,4.4)
// zone 重放代数:模块级全局递增(REQ-M7-01 F4 修正——按存活旧区生成会在区域到期删除后
// 重置为 1,与敌侧残留标记 gen 撞车导致重放漏提示;全局递增跨区域销毁仍可区分)
let ZONE_GEN = 0;

export function pushZone(ctx, skill, tier, center) {
  ctx.zones = ctx.zones || [];
  const p = skill.params;
  const old = ctx.zones.find(z => z.skillId === skill.id);
  const zone = skill.kind === 'dotzone'
    ? { kind: 'dot', x: center.x, y: center.y, r: p.r, dpsFloat: ctx.atk * p.dpsCoef * TM(tier), until: ctx.clock + p.duration, skillId: skill.id }
    : { kind: 'slow', x: center.x, y: center.y, r: p.r, slowPct: p.slowPct, until: ctx.clock + p.duration, skillId: skill.id };
  zone.gen = ++ZONE_GEN; // 每次释放(新建或重放)都是新代数
  if (old) ctx.zones[ctx.zones.indexOf(old)] = zone; // 刷新:时长/效果按新档位,不叠加
  else ctx.zones.push(zone);
  return zone;
}

// 区域逐帧 tick:dot 区对区内敌每整秒跳 round(dpsFloat);slow 区对区内敌刷新减速(幅度/时长)。
// 返回 {dotDamage, slowed}
export function tickZones(zones, prevClock, clock, enemies, ctx = null) {
  let dotDamage = 0;
  let slowed = 0;
  for (let zi = zones.length - 1; zi >= 0; zi--) {
    const z = zones[zi];
    // 先结算本帧效果、后删到期区域(REQ-M4-03 F6 续审:跨过 until 的帧仍须完成
    // min(floor(clock),floor(until)) 内的最后一跳;dt=0.047 跨帧反例见 m4 回归)。
    // to 已按 until 截断,不产生超时跳伤;到期帧仅跳过 slow 刷新(避免删除后残留减速)。
    const expired = clock > z.until + 1e-9;
    const inR = enemies.filter(e => {
      if (!e.alive) return false;
      const dx = e.x - z.x, dy = e.y - z.y;
      return dx * dx + dy * dy <= z.r * z.r;
    });
    if (z.kind === 'dot') {
      const from = Math.floor(prevClock + 1e-9) + 1;
      const to = Math.min(Math.floor(clock + 1e-9), Math.floor(z.until + 1e-9));
      const zoneEl = skillById(z.skillId)?.el || 'fire'; // 冒字元素来源(6.5:zone.skillId→skillById)
      for (let s = from; s <= to; s++) {
        for (const e of inR) {
          const r = e.hurt(Math.round(z.dpsFloat));
          dotDamage += r.applied;
          // 灼烧区跳伤冒字(6.2a:每整秒每敌 `-N`,方向=区域中心→被击敌,importance 0)
          if (r.applied > 0 && ctx?.floatEvent) {
            ctx.floatEvent({ kind: 'dmg', x: e.x, y: e.y, n: r.applied, el: zoneEl, fromAngle: Math.atan2(e.y - z.y, e.x - z.x), importance: 0 });
          }
          if (r.killed && ctx?.registerKill) ctx.registerKill(e); // 击杀登记(F2)
        }
      }
    } else if (z.kind === 'slow' && !expired) {
      for (const e of inR) {
        e.slowT = Math.max(e.slowT || 0, 0.1); // 区内持续减速;离开后自然到期
        e.slowPct = z.slowPct;
        // 减速提示跃迁判定(6.2b):逐帧续时不冒字;首用/重入/增强/重放(zone.gen)才冒
        if (markSlow(e, z.skillId, z.slowPct, z.gen || 0) && ctx?.floatEvent) {
          ctx.floatEvent({ kind: 'slowMark', x: e.x, y: e.y, importance: 0 });
        }
        slowed++;
      }
    }
    if (expired) zones.splice(zi, 1); // 到期移除(F6:先跳后清,与 tickBind/tickAura 同口径)
  }
  return { dotDamage, slowed: zones.some(z => z.kind === 'slow') ? slowed : 0 };
}

// ---- 生机光环(wood_aura):主角光环,每秒回 maxHP×1%×档位倍率,持续 6s;重复释放刷新(4.4) ----
// skill_mult 接入(REQ-M6-04 F5):healFloat 一式乘入技能等级乘数,浮点入账逐跳 round
export function applyAura(ctx, skill, tier, mult = 1) {
  ctx.aura = {
    healFloat: ctx.maxHp * 0.01 * TM(tier) * mult, // 4.4 例:Lv12(265) tier1=2.65→3/s,tier5=12.19→12/s
    until: ctx.clock + skill.params.duration,
  };
  return ctx.aura;
}
export function tickAura(aura, prevClock, clock, ctx) {
  if (!aura) return 0;
  let heal = 0;
  const from = Math.floor(prevClock + 1e-9) + 1;
  const to = Math.min(Math.floor(clock + 1e-9), Math.floor(aura.until + 1e-9));
  for (let s = from; s <= to; s++) {
    const h = Math.round(aura.healFloat);
    const before = ctx.hp;
    ctx.hp = Math.min(ctx.maxHp, ctx.hp + h);
    const gained = ctx.hp - before;
    heal += gained;
    // 光环回血冒字(6.2a:每跳 `+N`,N=实际回复量,满血 0 不产;6.4 光环例 265 maxHP t5=+12/Lv3=+14)
    if (gained > 0 && ctx.floatEvent) ctx.floatEvent({ kind: 'aura', x: ctx.px ?? 110, y: 280, n: gained, importance: 0 });
  }
  if (clock > aura.until + 1e-9) ctx.aura = null;
  return heal;
}

// ---- 行为分发(cast.js 调用):kind → 内核;区域类中心=最近敌人(03 文档 5.3) ----
// mult=技能等级乘数(REQ-M6-04 F5):atk 基内核经 cast.withSkillMult 的 ctx.atk 生效;
// maxHp 基内核(光环)不读 atk,单独透传乘数。
export function dispatch(ctx, skill, tier, mult = 1) {
  switch (skill.kind) {
    case 'chain': return applyChain(ctx, skill, tier);
    case 'bind': return applyBind(ctx, skill, tier);
    case 'multi': return applyMulti(ctx, skill, tier);
    case 'shield': return applyShieldSpell(ctx, skill, tier);
    case 'pulse': return applyPulse(ctx, skill, tier);
    case 'dotzone': case 'field': {
      const center = ctx.nearestAlive();
      return center ? pushZone(ctx, skill, tier, center) : 0;
    }
    case 'aura': return applyAura(ctx, skill, tier, mult);
    default: return null;
  }
}
