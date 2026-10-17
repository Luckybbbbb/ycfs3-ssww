// scripts/skills/cast.js
// M6/v0.2 双链路释放(03 文档 4.0):
//   [主角链·养成] 4 装配槽技能各自 CD 就绪 → 按技能等级强度(skill_mult)自动释放(tier=1,无档位)
//   [消除触发链]  消除→档位充能(charge)→每帧判定:池≥1 且 候选池非空(已拥有∧CD就绪∧未预约)
//                 → 串行选技+原子建预约(池全部余额转 tier,池清零)→ 执行=max(t0+0.75, 选技时刻)
// 两阶段仲裁:主角链意图收集(无副作用)→消除链建预约→主角链合并(同技能消除链优先)→执行。
// CD 归属:每个技能一份 CD 两链共用;预约占执行权,CD 只在执行时写入。
// 兼容 M2 口径:tryCast(档位+装配门控)保留为演示 API(单测依赖);loadout 可传元素名。
// 相对路径: scripts/skills/cast.js

import { BOLT_CD } from './registry.js';
import { DEFAULT_LOADOUT } from './registry.js';
import { skillById, pickSkillForElement, SKILL_LIBRARY } from './library.js';
import { dispatch as dispatchBehavior } from './behaviors.js';

const FIVE = ['fire', 'water', 'wood', 'metal', 'earth'];
// 元素名 → 初始弹技能 ID;技能 ID 原样保留(M2 兼容入口)
const toSkillId = (v) => (skillById(v) ? v : `${v}_bolt`);

export class Caster {
  // loadout: 4 槽(元素名或技能 ID);charge: Charge 实例(释放后清零档位)
  constructor(charge, loadout = DEFAULT_LOADOUT, level = 1, owned = null, skillLevels = null) {
    this.charge = charge;
    this.loadout = loadout.map(toSkillId);
    this.level = level;
    this.cds = {};        // 元素键 CD 视图(M2 兼容:镜像该行初始弹)
    this.skillCds = {};   // 技能键 CD(唯一,两链共用——03 文档 4.0 CD 归属)
    for (const el of FIVE) { this.cds[el] = 0; this.skillCds[`${el}_bolt`] = 0; }
    this.cdBoostT = 0;      // M5 CD 加速剩余秒
    this.cdBoostRate = 1;
    // M6 v0.2:拥有制(初始 5 弹,抽卡扩充——03 文档 2.5)与技能等级(材料升级,03 文档 2.4)
    this.owned = owned ? [...owned] : FIVE.map(el => `${el}_bolt`);
    this.skillLevels = { ...(skillLevels || {}) };
    for (const id of this.owned) if (!(id in this.skillLevels)) this.skillLevels[id] = 1;
    this.pending = [];    // 消除触发链预约 [{id, skillId, el, tier, t0, selT}](执行权占用,CD 未写)
    this._seq = 0;        // 预约唯一序号(块认领幂等键 resKey 的来源,REQ-08 F8)
  }

  // 技能等级强度乘数(03 文档 2.4):skill_mult = 1 + 0.08×(lv−1),Lv10 上限 1.72
  skillMult(id) { return 1 + 0.08 * ((this.skillLevels[id] || 1) - 1); }

  // 技能等级乘数接入(03 文档 4.4:全程浮点,最终作用取整一次——atk 乘 mult 后下游一式算完)
  withSkillMult(ctx, skillId, fn) {
    const saved = ctx.atk;
    ctx.atk = saved * this.skillMult(skillId);
    try { return fn(); } finally { ctx.atk = saved; }
  }

  // 终局清空(REQ-05):预约/档位/两项记账累计同步归零(池在 charge.reset;CD 属局内进度同清)
  resetForNewLevel() {
    this.pending = [];
    this.charge.reset();
    for (const id in this.skillCds) this.skillCds[id] = 0;
    for (const el of FIVE) this.cds[el] = 0;
  }

  setLevel(level) { this.level = level; }

  // M5 CD 加速道具(02 文档第 6 节):期间技能 CD 流速 ×rate(默认 2),现实时间计时
  setCdBoost(seconds, rate = 2) { this.cdBoostT = seconds; this.cdBoostRate = rate; }

  // 跨局临时状态清理(REQ-M4-03 F7 续审):CD 加速不带入新局(档位/CD 保留,属局内正常进度)
  resetTempState() { this.cdBoostT = 0; this.cdBoostRate = 1; }

  update(dt) {
    const rate = this.cdBoostT > 0 ? this.cdBoostRate : 1;
    if (this.cdBoostT > 0) this.cdBoostT = Math.max(0, this.cdBoostT - dt);
    for (const id in this.skillCds) this.skillCds[id] = Math.max(0, this.skillCds[id] - dt * rate);
    for (const el of FIVE) this.cds[el] = this.skillCds[`${el}_bolt`];
  }

  // 换装(FR-3.3:换装立即生效):直接替换槽位集合(元素名或技能 ID);档位/CD 均保留
  setLoadout(loadout) {
    this.loadout = loadout.map(toSkillId);
  }

  // 槽位换装(FR-3.3 真实装配入口;M6 v0.2 拥有制:轮换候选=**已拥有**技能,03 文档 5.1/2.5)
  // 库序环回,同技能不可重复装配;抽卡获得的新技能立即可入槽,立即生效并写档(main 持久化)。
  cycleSlot(slotIndex) {
    const cur = this.loadout[slotIndex];
    const unlocked = SKILL_LIBRARY.filter(s => this.owned.includes(s.id));
    const start = Math.max(0, unlocked.findIndex(s => s.id === cur));
    for (let k = 1; k <= unlocked.length; k++) {
      const cand = unlocked[(start + k) % unlocked.length];
      if (!this.loadout.includes(cand.id)) {
        this.loadout[slotIndex] = cand.id;
        return cand.id;
      }
    }
    return cur; // 无可换(已解锁技能全部在槽)→ 保持
  }

  // 判定并执行一次释放:返回 {element, tier, skill, kind, result?} 或 null
  // hasTarget=false(场上无存活敌人)时完全不消耗(03 文档 5.3);
  // 非子弹类需要 ctx(battle)执行行为内核;ctx 缺省时非子弹类不释放(档位保留)。
  tryCast(el, hasTarget, ctx = null) {
    const tier = this.charge.tiers[el];
    if (tier < 1) return null;                       // 档位门控(4.6:档位 0 → 不发射)
    if (!hasTarget) return null;                     // 无敌人不消耗 CD/档位
    const pick = pickSkillForElement(el, this.loadout, this.level, this.skillCds);
    if (!pick) return null;                          // 未装配/全 CD 中:档位保留继续累积
    const { skill } = pick;
    this.skillCds[skill.id] = skill.cd;              // 先占 CD(03 文档 5.2)
    if (skill.kind !== 'bolt' && !ctx) return null;  // 无 ctx 不执行非子弹类(CD 已占,下轮重试)
    const used = { element: el, tier: this.charge.drain(el), skill, kind: skill.kind };
    if (skill.kind === 'bolt') {
      this.cds[el] = skill.cd;
      return used;                                   // 子弹类由 battle.launch 结算(4.2 形态)
    }
    used.result = dispatchBehavior(ctx, skill, tier); // 非子弹类行为内核(4.2 同倍率表)
    return used;
  }

  // ===== 消除事件入口(REQ-M6-04 F2 整改):选技+原子建预约(唯一提交位置)=====
  // main 在事件循环内对每个 match_cleared 单独调用(先 charge.feed 再本方法),
  // 同轮多事件逐条建预约(单候选场景=1 个 tier1 预约+余档留池),绝不在池层合并;
  // tick 阶段 2 也复用本方法做「CD 就绪后余档」的逐帧判定回落(REQ-04 F1)。
  // 候选池 = 已拥有 ∧ CD 就绪 ∧ 未预约;t0 取被占用档位最早可用时刻(charge.earliestT)。
  // M9-F2:execFloor=t0+floor 随档位留池保存(charge.earliestFloor)——延迟选技/跨轮留池的预约
  // 仍继承**最早被占用档位所属轮**的执行下限(新事件不重设旧留池档位的等待时间);
  // floor 缺失(无 floor 的历史事件)回退 0.75s 口径=rush1 的段④起点。
  reserveFor(el, rng, now) {
    if ((this.charge.tiers[el] || 0) < 1) return null;
    const pool = this.owned.filter(id => {
      const s = skillById(id);
      return s && s.el === el && (this.skillCds[id] || 0) <= 0 && !this.pending.some(p => p.skillId === id);
    });
    if (!pool.length) return null; // 候选空:档位留池蓄能(下轮事件/CD 就绪帧再判)
    const skillId = pool[Math.floor(rng() * pool.length)];
    const { tier, t0, floor } = this.charge.drainAll(el); // 原子:池全部余额转入预约并清池
    const base = t0 ?? now;
    const p = { id: `r${++this._seq}`, skillId, el, tier, t0: base, selT: now, execFloor: base + (floor ?? 0.75) };
    this.pending.push(p);
    return p;
  }

  // ===== M6/v0.2 双链路主 tick(仲裁与执行;事件入口选技已前移至 reserveFor,REQ-M6-04 F2)=====
  // ctx: battle 兼容接口(clock/atk/enemies/…);hasTarget: 存活敌;rng: 消除链随机源(逐帧判定回落用)
  // 返回本帧执行列表 [{element, tier, skill, kind, from, result?}](子弹类在 _execute 内发射,返回成功执行记录)
  tick(ctx, hasTarget, rng) {
    const now = ctx.clock;
    const out = [];
    // 阶段 1:主角链意图收集(无副作用:CD 就绪 ∧ 未预约 ∧ 已拥有;不写 CD)
    const mainCands = [];
    for (const id of this.loadout) {
      const skill = skillById(id);
      if (!skill || !this.owned.includes(id)) continue;
      if ((this.skillCds[id] || 0) > 0) continue;
      if (this.pending.some(p => p.skillId === id)) continue;
      mainCands.push(skill);
    }
    // 阶段 2:池余档逐帧判定回落(REQ-04 F1 每帧判定;REQ-M6-04 F2 不合并)——
    // 事件已在 reserveFor 即时建预约,此处只捡「CD 就绪后候选池变非空」的留池档位
    // (单候选场景:事件2 因同技能已预约而留池,候选空 → 此处也不建预约,绝不在池层合并)
    for (const el of FIVE) this.reserveFor(el, rng, now);
    // 阶段 3:仲裁+主角链执行(同技能被消除链预约 → 主角链合并移除;不同技能并发)
    // REQ-M6-06 F14:**每个技能执行前复检存活目标**——前槽非子弹技能(如烈焰环)杀死末敌后,
    // 后槽技能不得以「入口 hasTarget」的过期判断继续执行(效果 0 仍写 CD);无目标即停止。
    if (hasTarget) {
      for (const skill of mainCands) {
        if (this.pending.some(p => p.skillId === skill.id)) continue; // 消除链优先(同技能合并)
        if ((this.skillCds[skill.id] || 0) > 0) continue;
        if (typeof ctx.nearestAlive === 'function' && !ctx.nearestAlive()) break;
        const used = this._execute(skill, 1, ctx, 'main'); // 主角链无档位(tier=1,03 文档 4.0)
        if (used) out.push(used);
      }
    }
    // 阶段 4:消除链到期预约执行(执行 = max(execFloor, 选技时刻);执行时刻**复检**存活敌——
    // REQ-M6-04 F6:主角链脉冲同帧杀死最后目标时,到期预约不得被消费,须挂起待敌人出现)。
    // M9-F2:execFloor=t0+floor 随档位留池保存(charge.earliestFloor),reserveFor 统一组装——
    // 事件入口与延迟选技/跨轮留池的回落预约都继承最早被占用档位所属轮的段④起点;
    // 历史无 floor 预约回退 0.75s 口径(rush1 的段④起点)
    for (const p of [...this.pending]) {
      const exec = Math.max(p.execFloor ?? p.t0 + 0.75, p.selT);
      if (now < exec) continue;
      if (typeof ctx.nearestAlive === 'function' && !ctx.nearestAlive()) continue;
      const skill = skillById(p.skillId);
      // 同一提交(REQ-M6-05 F6):发射/生效成功才消费预约;失败(发射 null)预约保留挂起
      const used = this._execute(skill, p.tier, ctx, 'elim');
      if (!used) continue;
      this.pending.splice(this.pending.indexOf(p), 1);
      used.resKey = p.id; // 执行记录携带预约身份(main 按其认领块,与入口/存续回写幂等互认,REQ-08 F8)
      used.resRound = p.round; // 预约所属轮(main 盖章;undefined=本帧阶段2新建即执行,视为当前轮)
      out.push(used);
    }
    return out;
  }

  // 执行动作(03 文档 4.0 第 3 条):实际发射/生效与 CD 写入、预约消费**同一提交**。
  // REQ-M6-05 F6 续审:子弹类不再交 main 延后发射(反例:同帧火弹+寒冰锁链,锁链击杀末敌后
  // main 再 launch 返回 null,CD/预约已白耗)——本方法内直接 ctx.launch,发射成功才写 CD/消费;
  // 非子弹类行为内核同步生效(dispatch 即执行),同样先launch语义生效后才提交。
  // skill_mult 烘焙(REQ-M6-04 F5):子弹类乘数随 used.mult 交 battle.launch(命中时刻的
  // 灼烧/土盾同乘,见 battle.applyHit);非子弹类经 withSkillMult 包裹 dispatchBehavior。
  _execute(skill, tier, ctx, from) {
    const mult = this.skillMult(skill.id);
    const used = { element: skill.el, tier, skill, kind: skill.kind, from, mult };
    if (skill.kind === 'bolt') {
      // 同一提交(F6):发射成功 → 写共享 CD + 返回 used(预约已由调用方消费);
      // 发射失败(无存活目标/无 launch 通道)→ 返回 null,不写 CD、不消费。
      if (!ctx || typeof ctx.launch !== 'function') return null;
      if (!ctx.launch(used)) return null;
      this.skillCds[skill.id] = skill.cd;
      this.cds[skill.el] = skill.cd;
      return used;
    }
    this.skillCds[skill.id] = skill.cd; // 非子弹类:行为内核同步生效,执行即提交
    used.result = this.withSkillMult(ctx, skill.id, () => dispatchBehavior(ctx, skill, tier, mult));
    return used;
  }
}
