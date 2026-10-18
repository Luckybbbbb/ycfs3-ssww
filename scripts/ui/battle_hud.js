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
export const HUD_IMG = { avatarFrame: null, skillFrame: null, avatarImg: null };
export function bindHudImages(map) {
  if (!map || typeof map.get !== 'function') return 0;
  HUD_IMG.avatarFrame = map.get('ui:avatar_frame') || null;
  HUD_IMG.skillFrame = map.get('ui:skill_frame') || null;
  HUD_IMG.avatarImg = map.get('ui:hero_avatar') || null; // M13 专用头像(codex 生图)
  return (HUD_IMG.avatarFrame ? 1 : 0) + (HUD_IMG.skillFrame ? 1 : 0) + (HUD_IMG.avatarImg ? 1 : 0);
}

// 主题映射:关卡 1..5 → meadow/swamp/mist/snow/volcano(>5 循环)
export const LEVEL_THEMES = ['meadow', 'swamp', 'mist', 'snow', 'volcano'];
export const themeOf = (level) => LEVEL_THEMES[(Math.max(1, level) - 1) % LEVEL_THEMES.length];

// ---- 战斗区 HUD 视图 ----
export class BattleHudView {
  constructor() {
    this.hero = new HealthView({ main: '#6fba2c', ghost: '#b9da8c' });
    this.boss = new HealthView({ main: '#e05a5a', ghost: '#f4b4af' });
  }

  reset() { this.hero.reset(1); this.boss.reset(1); }

  // dt 累加入口(main 主循环逐帧调用);快照字段见 _snapshot
  update(dt, hud, fxEnabled = true) {
    const s = this._snapshot(hud);
    this.hero.update(dt, s.maxHp > 0 ? s.hp / s.maxHp : 1, fxEnabled);
    this.boss.update(dt, s.bossMax > 0 ? s.bossHp / s.bossMax : 1, fxEnabled);
  }

  // 实况快照:全部来自 hud 只读转发(battle/caster/levels),不写任何战斗状态
  _snapshot(hud) {
    const battle = hud.battle || {};
    const caster = hud.caster || {};
    const slots = (caster.loadout || []).slice(0, 4);
    const enemies = typeof battle.aliveEnemies === 'function' ? battle.aliveEnemies() : [];
    const boss = enemies.find(e => e.name === 'boss') || null;
    return {
      hp: battle.hp ?? 1, maxHp: battle.maxHp ?? 1,
      level: battle.level ?? 1, wave: Math.max(0, battle.wave ?? 0),
      wavesTotal: WAVES_PER_LEVEL,
      bossHp: boss ? boss.hp : 0, bossMax: boss ? boss.maxHp : 0,
      isBossWave: (battle.wave ?? 0) >= WAVES_PER_LEVEL,
      slots,
      skillCds: caster.skillCds || {},
    };
  }

  draw(ctx, hud) {
    const s = this._snapshot(hud);
    // ===== 左上角:头像+头像框 =====
    const avImg = HUD_IMG.avatarImg;
    const hero = hud.heroImg; // 兜底:立绘裁头部(专用头像未绑定/单测)
    if (avImg && avImg.complete && avImg.naturalWidth) {
      ctx.save();
      ctx.beginPath(); ctx.arc(52, 52, 36, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(avImg, 16, 16, 72, 72); // 128×128 头像缩至框孔径
      ctx.restore();
    } else if (hero && hero.complete && hero.naturalWidth) {
      ctx.save();
      ctx.beginPath(); ctx.arc(52, 52, 36, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(hero, 160, 40, 320, 320, 16, 16, 72, 72);
      ctx.restore();
    }
    const av = HUD_IMG.avatarFrame;
    if (av && av.complete && av.naturalWidth) ctx.drawImage(av, 16, 16, 72, 72);
    else { ctx.strokeStyle = '#f0e8d8'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(52, 52, 34, 0, Math.PI * 2); ctx.stroke(); }
    // 血条(主条+残影)+ 数值
    this.hero.draw(ctx, 96, 46, 128, 22);
    ctx.fillStyle = '#fff';
    ctx.font = "13px 'Nunito','Noto Sans SC',sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.max(0, Math.ceil(s.hp))}/${s.maxHp}`, 160, 62);
    ctx.textAlign = 'left';
    // 等级标识(头像右上角小徽标,替代 demo 的 Lv.6 文字条)
    ctx.fillStyle = 'rgba(248,248,240,.94)';
    _rr(ctx, 96, 18, 64, 22, 8); ctx.fill();
    ctx.fillStyle = '#794f27';
    ctx.font = "13px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(`Lv.${s.level}`, 104, 34);

    // ===== 顶部中央:关卡名 =====
    ctx.fillStyle = 'rgba(248,248,240,.94)';
    _rr(ctx, 236, 16, 248, 40, 14); ctx.fill();
    ctx.fillStyle = '#794f27';
    ctx.font = "17px 'Nunito','Noto Sans SC',sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText(`第 ${s.level} 关 ${hud.levelName ? hud.levelName() : ''}`, 360, 42);
    ctx.textAlign = 'left';

    // ===== BOSS 血条:关卡名下方,仅 Boss 波(需求方 2026-10-18:非 Boss 波不显示) =====
    if (s.isBossWave && s.bossMax > 0) {
      this.boss.draw(ctx, 220, 80, 280, 26);
      ctx.fillStyle = '#fff';
      ctx.font = "14px 'Nunito','Noto Sans SC',sans-serif";
      ctx.textAlign = 'center';
      ctx.fillText(`BOSS  ${Math.max(0, Math.ceil(s.bossHp))}/${s.bossMax}`, 360, 99);
      ctx.textAlign = 'left';
    }

    // ===== 技能框×4:战斗区右下(72px 框+56px 图标+CD 扫描) =====
    ctx.fillStyle = 'rgba(255,246,228,.9)';
    ctx.font = "13px 'Nunito','Noto Sans SC',sans-serif";
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
      // CD 扫描(就绪 frac=0;深色扇形自 12 点顺时针)
      const cd = s.skillCds[id] || 0;
      if (cd > 0) {
        const meta = hud.skillMeta ? hud.skillMeta(id) : null;
        const frac = meta ? Math.min(1, cd / meta.cd) : 1;
        ctx.fillStyle = 'rgba(40,32,40,.55)';
        ctx.beginPath();
        ctx.moveTo(x + 36, y + 36);
        ctx.arc(x + 36, y + 36, 38, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.closePath(); ctx.fill();
      }
    });

    // ===== 波次进度条:战斗区最下方(文字+刻度点+Boss 旗标) =====
    ctx.fillStyle = '#794f27';
    ctx.font = "16px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(`第 ${s.wave}/${s.wavesTotal} 波`, 28, 434);
    const N = s.wavesTotal, x = 158, w = 494, step = w / N;
    ctx.fillStyle = '#d9d3c4';
    _rr(ctx, x, 425, w, 7, 3); ctx.fill();
    if (s.wave > 0) { ctx.fillStyle = '#6fba2c'; _rr(ctx, x, 425, w * ((s.wave - 1) / N), 7, 3); ctx.fill(); }
    for (let i = 1; i <= N; i++) {
      const xx = x + i * step;
      if (i === N) { // Boss 旗标(菱形)
        ctx.beginPath();
        ctx.moveTo(xx, 417); ctx.lineTo(xx + 9, 428); ctx.lineTo(xx, 439); ctx.lineTo(xx - 9, 428);
        ctx.closePath();
        ctx.fillStyle = s.isBossWave ? '#e05a5a' : '#a28c77';
        ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(xx, 428, i <= s.wave ? 6 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = i < s.wave ? '#6fba2c' : i === s.wave ? '#19c8b9' : '#bdb29e';
        ctx.fill();
      }
    }
  }
}
