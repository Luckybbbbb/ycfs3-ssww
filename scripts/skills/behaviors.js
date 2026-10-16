// scripts/skills/behaviors.js
// 非子弹类技能行为实装(03 文档 5.2 八类行为内核中本项目用到的 6 类:dotzone/chain/bind/multi/shield/pulse/field/aura)
// 纯函数、以 ctx(battle 兼容接口:atk/maxHp/hp/shield/enemies/bolts/makeBolt/clock)操作;
// 区域(zones)/光环(aura)状态与逐秒 tick 以纯函数提供,battle 接线在 M4 集成时完成。
// 口径:非子弹类主数值 ×4.2 档位倍率(4.4);计算浮点、作用时 round;区域/光环重复释放=刷新时长按新档位,不叠加。
// 相对路径: scripts/skills/behaviors.js

import { TIER_MULT } from './registry.js';
import { tiered } from './library.js';

const TM = (tier) => TIER_MULT[tier - 1];

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
  for (const e of picked) e.hurt(dmg);
  return picked.length;
}

// ---- 藤蔓束缚(wood_bind):束缚最近敌 1.5s + 每秒 ATK×0.3×档位倍率(束缚期内逐整秒跳) ----
export function applyBind(ctx, skill, tier) {
  const e = ctx.nearestAlive();
  if (!e) return null;
  e.bindT = skill.params.bindTime;                 // 消费(停止移动/攻击)在 enemy 接线
  e.bindDps = ctx.atk * skill.params.dpsCoef * TM(tier);
  e.bindUntil = ctx.clock + skill.params.bindTime;
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
  for (let i = 0; i < skill.params.count; i++) {
    const e = ctx.nearestAlive(fired.map(b => b.target).filter(Boolean));
    if (!e) break;
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
  ctx.shield = Math.min(cap, ctx.shield + add);
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
      e.hurt(dmg);
      if (skill.params.stunTime) e.stunT = Math.max(e.stunT || 0, skill.params.stunTime);
      hits++;
    }
  }
  return hits;
}

// ---- 区域(dotzone/field)与光环(aura):状态为纯数据,由 battle 接线每帧 tick ----
// zones: [{kind:'dot'|'slow', x, y, r, dpsFloat?, slowPct?, until}](同种区域刷新不叠加,4.4)
export function pushZone(ctx, skill, tier, center) {
  ctx.zones = ctx.zones || [];
  const p = skill.params;
  const zone = skill.kind === 'dotzone'
    ? { kind: 'dot', x: center.x, y: center.y, r: p.r, dpsFloat: ctx.atk * p.dpsCoef * TM(tier), until: ctx.clock + p.duration, skillId: skill.id }
    : { kind: 'slow', x: center.x, y: center.y, r: p.r, slowPct: p.slowPct, until: ctx.clock + p.duration, skillId: skill.id };
  const old = ctx.zones.findIndex(z => z.skillId === skill.id);
  if (old >= 0) ctx.zones[old] = zone; // 刷新:时长/效果按新档位,不叠加
  else ctx.zones.push(zone);
  return zone;
}

// 区域逐帧 tick:dot 区对区内敌每整秒跳 round(dpsFloat);slow 区对区内敌刷新减速(幅度/时长)。
// 返回 {dotDamage, slowed}
export function tickZones(zones, prevClock, clock, enemies) {
  let dotDamage = 0;
  let slowed = 0;
  for (const z of zones) {
    const inR = enemies.filter(e => {
      if (!e.alive) return false;
      const dx = e.x - z.x, dy = e.y - z.y;
      return dx * dx + dy * dy <= z.r * z.r;
    });
    if (z.kind === 'dot') {
      const from = Math.floor(prevClock + 1e-9) + 1;
      const to = Math.min(Math.floor(clock + 1e-9), Math.floor(z.until + 1e-9));
      for (let s = from; s <= to; s++) {
        for (const e of inR) dotDamage += e.hurt(Math.round(z.dpsFloat)).applied;
      }
    } else if (z.kind === 'slow') {
      for (const e of inR) {
        e.slowT = Math.max(e.slowT || 0, 0.1); // 区内持续减速;离开后自然到期
        e.slowPct = z.slowPct;
        slowed++;
      }
    }
  }
  return { dotDamage, slowed: zones.some(z => z.kind === 'slow') ? slowed : 0 };
}

// ---- 生机光环(wood_aura):主角光环,每秒回 maxHP×1%×档位倍率,持续 6s;重复释放刷新(4.4) ----
export function applyAura(ctx, skill, tier) {
  ctx.aura = {
    healFloat: ctx.maxHp * 0.01 * TM(tier), // 4.4 例:Lv12(265) tier1=2.65→3/s,tier5=12.19→12/s
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
    heal += ctx.hp - before;
  }
  if (clock > aura.until + 1e-9) ctx.aura = null;
  return heal;
}

// ---- 行为分发(cast.js 调用):kind → 内核;区域类中心=最近敌人(03 文档 5.3) ----
export function dispatch(ctx, skill, tier) {
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
    case 'aura': return applyAura(ctx, skill, tier);
    default: return null;
  }
}
