// scripts/ui/battle_hud.js
// M13 战斗区 HUD:头像+二段血条 / 关卡名 / BOSS 血条(关卡名下方,仅 Boss 波) /
// 技能框+技能图标(战斗区右下,CD 扫描) / 波次进度条(战斗区最下方,当前波/总波)
// 二段血条口径(需求方 2026-10-18 冻结):主条立即扣;淡红残影 punch 0.4s 停顿 →
// 恒速 30%/s 追赶,最长 1.2s 兜底;连击重置 punch 且残影保持;纯显示层不反哺判定;
// 关动效(fxEnabled=false)残影直接同步(无动画)。参考:格斗游戏 lazy healthbar 惯例。
// 相对路径: scripts/ui/battle_hud.js

import { WAVES_PER_LEVEL } from '../meta/levels.js';

export const BATTLE_H = 448; // 战斗区高度(与 parallax BATTLE_H 同口径;本地常量避免循环依赖)

// ---- 二段血条(残影状态机;frac 全程 0..1) ----
export const GHOST_PUNCH = 0.4;    // punch 停顿(s)
export const GHOST_RATE = 0.30;    // 恒速追赶(/s)
export const GHOST_MAX = 1.2;      // 追赶最长兜底(s)

export class HealthView {
  constructor({ main = '#e05a5a', ghost = '#f4b4af' } = {}) {
    this.mainColor = main;
    this.ghostColor = ghost;
    this.reset(1);
  }

  reset(frac = 1) {
    this.hp = frac;        // 主条显示值(每帧对齐 battle 实况)
    this.ghost = frac;     // 残影显示值
    this.state = 'IDLE';   // IDLE | PUNCH | DRAIN
    this.t = 0;            // 当前态计时
  }

  // 每帧喂入实况血量占比;检测下降→触发残影,上升(治疗/升级回满)→立即对齐
  update(dt, frac, fxEnabled = true) {
    frac = Math.max(0, Math.min(1, frac));
    if (frac > this.hp) {            // 治疗/回满:主条残影立即对齐
      this.hp = frac; this.ghost = frac; this.state = 'IDLE'; this.t = 0;
      return;
    }
    if (frac < this.hp) {            // 受击:主条立即扣;残影=max(旧残影,旧主条),重置 punch
      this.ghost = Math.max(this.ghost, this.hp);
      this.hp = frac;
      this.state = fxEnabled ? 'PUNCH' : 'IDLE';
      this.t = 0;
      if (!fxEnabled) this.ghost = frac; // 关动效:残影直接同步(无动画)
      return;
    }
    if (this.state === 'PUNCH') {
      this.t += dt;
      if (this.t >= GHOST_PUNCH) { this.state = 'DRAIN'; this.t = 0; }
    } else if (this.state === 'DRAIN') {
      this.t += dt;
      this.ghost = Math.max(this.hp, this.ghost - GHOST_RATE * dt); // 恒速追赶
      if (this.ghost <= this.hp + 1e-4 || this.t >= GHOST_MAX) {    // 追平或兜底到点
        this.ghost = this.hp; this.state = 'IDLE'; this.t = 0;
      }
    }
    // 关动效兜底:M12M13-ACCEPT F2——动效关闭当帧,存量 PUNCH/DRAIN 残影也直接同步
    // (不只受击瞬间;中途关掉动效时残影无动画地追平)
    if (!fxEnabled) { this.ghost = this.hp; this.state = 'IDLE'; this.t = 0; }
  }

  // 快照对齐(M12M13-ACCEPT 04轮 F10):主条与残影**直接初始化**为 frac,状态归 IDLE——
  // 不走 update(0, frac)(那是受击路径,frac<hp 会保留满血假残影);用于敌人首见/测试对齐
  align(frac = 1) {
    frac = Math.max(0, Math.min(1, frac));
    this.hp = frac; this.ghost = frac; this.state = 'IDLE'; this.t = 0;
  }

  // 绘制(x,y,w,h;带 2px 圆角;残影在下层,主条在上层)
  draw(ctx, x, y, w, h) {
    const r = Math.min(4, h / 2);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    _rr(ctx, x - 2, y - 2, w + 4, h + 4, r + 2); ctx.fill();
    if (this.ghost > 0) { ctx.fillStyle = this.ghostColor; _rr(ctx, x, y, Math.max(0, w * this.ghost), h, r); ctx.fill(); }
    if (this.hp > 0) { ctx.fillStyle = this.mainColor; _rr(ctx, x, y, Math.max(0, w * this.hp), h, r); ctx.fill(); }
  }
}

function _rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- HUD 图片表(初始全空;生产唯一填充入口=bindHudImages——M11-03 F1 同口径) ----
// M13 需求方反馈整改:生图头像与立绘发色不符已弃用(ui:hero_avatar 移出清单),
// HUD 头像改走立绘裁头(battle_hud.draw 主路径,与喊话演出同一形象)
export const HUD_IMG = { avatarFrame: null, skillFrame: null };
export function bindHudImages(map) {
  if (!map || typeof map.get !== 'function') return 0;
  HUD_IMG.avatarFrame = map.get('ui:avatar_frame') || null;
  HUD_IMG.skillFrame = map.get('ui:skill_frame') || null;
  return (HUD_IMG.avatarFrame ? 1 : 0) + (HUD_IMG.skillFrame ? 1 : 0);
}

// 主题映射:关卡 1..5 → meadow/swamp/mist/snow/volcano(>5 循环)
export const LEVEL_THEMES = ['meadow', 'swamp', 'mist', 'snow', 'volcano'];
export const themeOf = (level) => LEVEL_THEMES[(Math.max(1, level) - 1) % LEVEL_THEMES.length];

// ---- 战斗区 HUD 视图 ----
export class BattleHudView {
  constructor() {
    this.hero = new HealthView({ main: '#6fba2c', ghost: '#b9da8c' });
    this.boss = new HealthView({ main: '#e05a5a', ghost: '#f4b4af' });
    // BEAUTIFY-01 F9:技能释放槽位短亮(160ms);-04 R3 整改:**墙钟计时**(_now 注入,与
    // 模拟 dt/帧率/暂停封顶解耦)+**noteCast 带当前装配定位**(main 传 caster.loadout——
    // 首局首帧/换装后开新局都按真实装配定位,不再依赖 update 顺序预热的缓存);
    // 固定四槽独立计时(同帧多技能各自亮);未装配的消除链技能忽略不覆盖;-03 B5:fx 关不绘制
    this.castAt = [0, 0, 0, 0]; // 各槽释放时刻(墙钟 ms;0=无释放)
    this._now = () => performance.now();
  }

  reset() { this.hero.reset(1); this.boss.reset(1); this.castAt = [0, 0, 0, 0]; }

  // BEAUTIFY-01 F9:实际释放时由 main(usedList 消费处)调用;loadout=当前真实装配(main 传入)
  noteCast(skillId, loadout) {
    const slots = Array.isArray(loadout) ? loadout : this._slotsCache || [];
    const i = slots.indexOf(skillId);
    if (i >= 0) this.castAt[i] = this._now();
  }

  // dt 累加入口(main 主循环逐帧调用);快照字段见 _snapshot
  update(dt, hud, fxEnabled = true) {
    const s = this._snapshot(hud);
    this.hero.update(dt, s.maxHp > 0 ? s.hp / s.maxHp : 1, fxEnabled);
    this.boss.update(dt, s.bossMax > 0 ? s.bossHp / s.bossMax : 1, fxEnabled);
    this._slotsCache = s.slots; // 备用定位(draw 主路径用实时快照 s.slots)
  }

  // 实况快照:全部来自 hud 只读转发(battle/caster/levels),不写任何战斗状态
  _snapshot(hud) {
    const battle = hud.battle || {};
    const caster = hud.caster || {};
    const slots = (caster.loadout || []).slice(0, 4);
    const enemies = typeof battle.aliveEnemies === 'function' ? battle.aliveEnemies() : [];
    const boss = enemies.find(e => e.isBoss || e.name === 'boss') || null; // -05 N1:Boss 身份走 isBoss(兼容旧类型名)
    return {
      hp: battle.hp ?? 1, maxHp: battle.maxHp ?? 1,
      // M13 需求方反馈:护盾条(蓝)=earth_shield 护盾值,口径同旧版 battle.shield/(maxHp×30% 封顶)
      shield: battle.shield ?? 0, shieldCap: Math.max(1, Math.round((battle.maxHp ?? 1) * 0.3)),
      level: battle.level ?? 1, wave: Math.max(0, battle.wave ?? 0),
      wavesTotal: WAVES_PER_LEVEL,
      bossHp: boss ? boss.hp : 0, bossMax: boss ? boss.maxHp : 0,
      isBossWave: (battle.wave ?? 0) >= WAVES_PER_LEVEL,
      // M12M13-ACCEPT F4:Lv 徽标显示**角色等级**(profile.level),不是关卡编号
      // (原先误用 battle.level:9 级角色进第 2 关被画成 Lv.2——显示回归)
      profileLv: (typeof hud.profile === 'function' ? (hud.profile()?.level ?? 1) : 1) || 1,
      slots,
      skillCds: caster.skillCds || {},
    };
  }

  draw(ctx, hud) {
    const s = this._snapshot(hud);
    // 需求方 2026-10-19:战斗区顶部新增货币栏条带(0~TOPBAR_H),战斗区 HUD 整体下移,
    // 与该条带不再重叠。TOPBAR_H 与 render.js 中的战斗区货币栏条带高度保持一致。
    const TOPBAR_H = 44;
    // ===== 左上角:头像+头像框 =====
    // 需求方 2026-10-18 反馈:专用生图头像与主角立绘发色不符「不太像」——
    // 改为立绘裁头部(与喊话演出同一形象,发色/帽饰完全一致);ui:hero_avatar 已移出清单
    const hero = hud.heroImg;
    if (hero && hero.complete && hero.naturalWidth) {
      ctx.save();
      ctx.beginPath(); ctx.arc(52, 52 + TOPBAR_H, 36, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(hero, 160, 40, 320, 320, 16, 16 + TOPBAR_H, 72, 72);
      ctx.restore();
    }
    const av = HUD_IMG.avatarFrame;
    if (av && av.complete && av.naturalWidth) ctx.drawImage(av, 16, 16 + TOPBAR_H, 72, 72);
    else { ctx.strokeStyle = '#f0e8d8'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(52, 52 + TOPBAR_H, 34, 0, Math.PI * 2); ctx.stroke(); }
    // 血条(主条+残影)+ 数值
    this.hero.draw(ctx, 96, 46 + TOPBAR_H, 128, 22);
    ctx.fillStyle = '#fff';
    ctx.font = "bold 15px 'Nunito','Noto Sans SC',sans-serif"; // BEAUTIFY-01 F2:13px→15px bold(条内可读)
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.max(0, Math.ceil(s.hp))}/${s.maxHp}`, 160, 62 + TOPBAR_H);
    ctx.textAlign = 'left';
    // 护盾条(需求方 2026-10-18:原血条下蓝条=earth_shield 护盾值,补回;有盾才画)
    if (s.shield > 0) {
      ctx.fillStyle = 'rgba(0,0,0,.25)';
      _rr(ctx, 94, 71 + TOPBAR_H, 132, 12, 5); ctx.fill();
      ctx.fillStyle = '#8fd3e8';
      _rr(ctx, 96, 73 + TOPBAR_H, Math.max(0, 128 * Math.min(1, s.shield / s.shieldCap)), 8, 4); ctx.fill();
    }
    // 等级标识(头像右上角小徽标,替代 demo 的 Lv.6 文字条)
    ctx.fillStyle = 'rgba(248,248,240,.94)';
    _rr(ctx, 96, 18 + TOPBAR_H, 64, 22, 8); ctx.fill();
    ctx.fillStyle = '#794f27';
    ctx.font = "bold 15px 'Nunito','Noto Sans SC',sans-serif"; // BEAUTIFY-01 F2
    ctx.fillText(`Lv.${s.profileLv}`, 104, 34 + TOPBAR_H);

    // ===== 顶部中央:关卡名 =====
    ctx.fillStyle = 'rgba(248,248,240,.94)';
    _rr(ctx, 236, 16 + TOPBAR_H, 248, 40, 14); ctx.fill();
    ctx.fillStyle = '#794f27';
    ctx.font = "17px 'Nunito','Noto Sans SC',sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText(`第 ${s.level} 关 ${hud.levelName ? hud.levelName() : ''}`, 360, 42 + TOPBAR_H);
    ctx.textAlign = 'left';

    // ===== BOSS 血条:关卡名下方,仅 Boss 波(需求方 2026-10-18:非 Boss 波不显示) =====
    if (s.isBossWave && s.bossMax > 0) {
      this.boss.draw(ctx, 220, 80 + TOPBAR_H, 280, 26);
      ctx.fillStyle = '#fff';
      ctx.font = "bold 16px 'Nunito','Noto Sans SC',sans-serif"; // BEAUTIFY-01 F2
      ctx.textAlign = 'center';
      ctx.fillText(`BOSS  ${Math.max(0, Math.ceil(s.bossHp))}/${s.bossMax}`, 360, 99 + TOPBAR_H);
      ctx.textAlign = 'left';
    }

    // ===== 技能框×4:战斗区右下(72px 框+56px 图标+CD 扫描) =====
    ctx.fillStyle = 'rgba(255,246,228,.9)';
    ctx.font = "bold 15px 'Nunito','Noto Sans SC',sans-serif"; // BEAUTIFY-01 F2:13px→15px bold
    ctx.textAlign = 'right';
    ctx.fillText('装配技能 · 自动释放', 698, 321);
    ctx.textAlign = 'left';
    s.slots.forEach((id, i) => {
      const x = 392 + i * 78, y = 330;
      const fr = HUD_IMG.skillFrame;
      if (fr && fr.complete && fr.naturalWidth) ctx.drawImage(fr, x, y, 72, 72);
      else { ctx.fillStyle = '#f0e8d8'; _rr(ctx, x, y, 72, 72, 18); ctx.fill(); }
      const img = hud.skillImg ? hud.skillImg(id) : null;
      if (img && img.complete && img.naturalWidth) ctx.drawImage(img, x + 8, y + 8, 56, 56);
      // BEAUTIFY-01 F9:实际释放槽位短亮 160ms(白亮边);-04 R3:墙钟计时(低帧也兑现 160ms);
      // -04 R4:draw 读实时开关(hud.fxEnabled()——暂停期主循环不 update,缓存会过期)
      const gi = s.slots.indexOf(id);
      const fxOn = hud.fxEnabled ? hud.fxEnabled() : true;
      const elapsed = this._now() - this.castAt[gi];
      if (fxOn && gi >= 0 && this.castAt[gi] > 0 && elapsed < 160) {
        ctx.save();
        ctx.globalAlpha = 1 - elapsed / 160;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 4;
        _rr(ctx, x + 2, y + 2, 68, 68, 16); ctx.stroke();
        ctx.restore();
      }
      // CD 扫描(就绪 frac=0;深色扇形自 12 点顺时针)
      // BEAUTIFY-01 F9:扇形半径 38 略超 72px 框(内切圆 36)——裁剪到框内,不再盖到框外
      const cd = s.skillCds[id] || 0;
      if (cd > 0) {
        const meta = hud.skillMeta ? hud.skillMeta(id) : null;
        const frac = meta ? Math.min(1, cd / meta.cd) : 1;
        ctx.save();
        _rr(ctx, x, y, 72, 72, 18); ctx.clip();
        ctx.fillStyle = 'rgba(40,32,40,.55)';
        ctx.beginPath();
        ctx.moveTo(x + 36, y + 36);
        ctx.arc(x + 36, y + 36, 38, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    });

    // ===== 波次进度条:战斗区最下方(药丸底+文字+刻度点+Boss 标记) =====
    // 需求方 2026-10-18 反馈:实装缺样板中的奶油药丸底,「第 N 波」文字直接压在背景图上看不清;
    // Boss 菱形不明显 → 药丸底按样板 .tmp/m13-battle-ui-demo.html progressHud 补齐,
    // Boss 标记加大菱形+白描边+'BOSS' 字样(样板右侧文字同步实装)
    ctx.fillStyle = 'rgba(248,248,240,.94)';
    _rr(ctx, 16, 414, 688, 28, 12); ctx.fill();
    ctx.strokeStyle = '#dac9a7';
    ctx.lineWidth = 2;
    _rr(ctx, 16, 414, 688, 28, 12); ctx.stroke();
    ctx.fillStyle = '#794f27';
    ctx.font = "16px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(`第 ${s.wave}/${s.wavesTotal} 波`, 28, 434);
    const N = s.wavesTotal, x = 158, w = 494, step = w / N;
    ctx.fillStyle = '#d9d3c4';
    _rr(ctx, x, 425, w, 7, 3); ctx.fill();
    if (s.wave > 0) { ctx.fillStyle = '#6fba2c'; _rr(ctx, x, 425, w * ((s.wave - 1) / N), 7, 3); ctx.fill(); }
    for (let i = 1; i <= N; i++) {
      const xx = x + i * step;
      if (i === N) { // Boss 标记(加大菱形+白描边;Boss 波红色点亮)
        ctx.beginPath();
        ctx.moveTo(xx, 415); ctx.lineTo(xx + 12, 428); ctx.lineTo(xx, 441); ctx.lineTo(xx - 12, 428);
        ctx.closePath();
        ctx.fillStyle = s.isBossWave ? '#e05a5a' : '#a28c77';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(xx, 428, i <= s.wave ? 6 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = i < s.wave ? '#6fba2c' : i === s.wave ? '#19c8b9' : '#bdb29e';
        ctx.fill();
      }
    }
    ctx.fillStyle = s.isBossWave ? '#c44747' : '#806a51';
    ctx.font = "bold 13px 'Nunito','Noto Sans SC',sans-serif"; // BEAUTIFY-01 F2:11px→13px
    ctx.textAlign = 'center';
    ctx.fillText('BOSS', 679, 432);
    ctx.textAlign = 'left';
  }
}
