// scripts/ui/render.js
// Canvas 渲染:M3 战斗区(视差三层+六类敌人序列帧+双方弹+血条+波次/Boss HUD+胜负弹层)
//             + 联动栏(档位条+装配槽)+ 三消棋盘
// 相对路径: scripts/ui/render.js
// 素材: player/slime/fox/zombie/snake/tiger/boss 序列帧复用 godot-roguelike(04 文档第 6 节);宝石见 gems/LICENSE.md

import { BOARD_W, BOARD_H, BOARD_Y, CELL, ELEMENTS, isItem } from '../board/grid.js';
import { roundRect } from './draw_util.js';
import { PLAYER_X, TIER_MULT } from '../skills/registry.js';
import { skillById } from '../skills/library.js';
import { ENEMY_TYPES } from '../battle/wave.js';
import { PLAYER_Y, ENEMY_SPAWN_X } from '../battle/enemy.js';
import { BATTLE_H } from '../battle/parallax.js';

const ITEM_ICON = { heal: '❤', invincible: '✦', cd: '⏱' };
const GEM_SRC = { metal: '#ccccff', wood: '#44ff44', water: '#4488ff', fire: '#ff4444', earth: '#cc8844' };
const GEM_IMG = {};
const GEM_DIR = new URL('../../assets/sprites/gems/', import.meta.url);
for (const el of ELEMENTS) {
  const img = new Image();
  img.src = new URL(`${el}.png`, GEM_DIR).href;
  GEM_IMG[el] = img;
}

// 序列帧预载(帧清单见 scripts/assets/manifest.js;此处按同清单懒加载,缺图走矢量兜底)
const PLAYER_FRAMES = [];
for (let i = 1; i <= 16; i++) {
  const img = new Image();
  img.src = new URL(`../../assets/sprites/player/idle_${String(i).padStart(2, '0')}.png`, import.meta.url).href;
  PLAYER_FRAMES.push(img);
}
// 攻击动画:walk_start 3 帧单次播放(资源无独立攻击帧,对标 player.tscn startup 16.7fps)
const PLAYER_ATK_FRAMES = [];
for (let i = 1; i <= 3; i++) {
  const img = new Image();
  img.src = new URL(`../../assets/sprites/player/walk_start_${String(i).padStart(2, '0')}.png`, import.meta.url).href;
  PLAYER_ATK_FRAMES.push(img);
}
const ENEMY_FRAMES = {};
for (const [type, t] of Object.entries(ENEMY_TYPES)) {
  ENEMY_FRAMES[type] = t.frames.map(n => {
    const img = new Image();
    img.src = new URL(`../../assets/sprites/${t.dir}/${t.prefix}${String(n).padStart(3, '0')}_nobg.png`, import.meta.url).href;
    return img;
  });
}
const seqFrame = (frames, t, fps) => frames[Math.floor(t * fps) % frames.length];

let worldT = 0; // 表现层动画时钟

export function render(ctx, engine, hud) {
  worldT += 1 / 60;
  ctx.clearRect(0, 0, 720, 1280);
  const battle = hud.battle;
  const px = hud.parallax;

  // ===== 战斗区(FR-1.5 视差三层;screenshake/zoom pulse 变换) =====
  const tf = px ? px.transform() : { ox: 0, oy: 0, scale: 1 };
  ctx.save();
  ctx.translate(360 + tf.ox, 224 + tf.oy);
  ctx.scale(tf.scale, tf.scale);
  ctx.translate(-360, -224);
  if (px) px.draw(ctx);
  else drawFlatBackdrop(ctx);

  if (battle) {
    // ===== 敌人(六类序列帧,尺寸=贴图×scale;死亡淡出放大) =====
    for (const e of battle.enemies) {
      const t = ENEMY_TYPES[e.name] || ENEMY_TYPES.slime;
      const dying = !e.alive;
      if (dying) {
        ctx.globalAlpha = Math.max(0, 1 - e.deathT / 0.4);
        drawEnemy(ctx, e, t, 1 + e.deathT * 2);
        ctx.globalAlpha = 1;
        continue;
      }
      drawEnemy(ctx, e, t, 1);
      // 血条(Boss 另有顶部大血条,此处保留小血条)
      const bw = 80, bx = e.x - bw / 2, by = e.y - t.srcH * t.scale / 2 - 18;
      ctx.fillStyle = 'rgba(0,0,0,.4)';
      roundRect(ctx, bx - 2, by - 2, bw + 4, 10, 5); ctx.fill();
      ctx.fillStyle = '#e5484d';
      roundRect(ctx, bx, by, Math.max(0, bw * e.hp / e.maxHp), 6, 3); ctx.fill();
      // 灼烧/减速标记
      if (e.burn) { ctx.fillStyle = '#ff7744'; ctx.font = '16px sans-serif'; ctx.fillText('🔥', e.x + 30, e.y - t.srcH * t.scale / 2 - 24); }
      if (e.slowT > 0) { ctx.fillStyle = '#88ccff'; ctx.font = '16px sans-serif'; ctx.fillText('❄', e.x - 38, e.y - t.srcH * t.scale / 2 - 24); }
    }
    // ===== 敌方弹幕(暗红光点,FR-1.2) =====
    for (const b of battle.ebolts) {
      ctx.fillStyle = '#ff5566';
      ctx.shadowColor = '#ff5566';
      ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(b.x, b.y, 7, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    // ===== 技能弹(五行色光点) =====
    for (const b of battle.bolts) {
      ctx.fillStyle = GEM_SRC[b.el];
      ctx.shadowColor = GEM_SRC[b.el];
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(b.x, b.y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    // ===== M4 行为视觉:区域(dot=灼烧橙 / field=寒霜蓝)+ 生机光环(木绿圈) =====
    for (const z of battle.zones || []) {
      ctx.fillStyle = z.kind === 'dot' ? 'rgba(255,120,50,.18)' : 'rgba(120,190,255,.18)';
      ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = z.kind === 'dot' ? 'rgba(255,120,50,.5)' : 'rgba(120,190,255,.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (battle.aura) {
      ctx.strokeStyle = 'rgba(90,220,130,.5)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(PLAYER_X, 300, 110, 0, Math.PI * 2); ctx.stroke();
    }
    // ===== 主角:战斗待机=idle 8fps 循环;释放技能时 walk_start 3 帧单次(攻击动画) =====
    let pf;
    if (battle.playerAttackT > 0) {
      const p = 1 - Math.max(0, battle.playerAttackT) / 0.18;
      pf = PLAYER_ATK_FRAMES[Math.min(2, Math.floor(p * 3))];
    } else {
      pf = seqFrame(PLAYER_FRAMES, worldT, 8);
    }
    if (pf && pf.complete && pf.naturalWidth > 0) {
      ctx.drawImage(pf, PLAYER_X - 90, 448 - 320, 180, 320);
    } else {
      ctx.fillStyle = '#3f6fb5';
      roundRect(ctx, PLAYER_X - 40, 448 - 220, 80, 220, 24); ctx.fill();
    }
    // 受击闪白反馈(FR-1.1 验收)
    if (battle.hurtT > 0) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.6, battle.hurtT * 3)})`;
      ctx.fillRect(0, 0, 720, BATTLE_H);
    }
    // 主角 HP/护盾条(战斗区左上)
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    roundRect(ctx, 16, 16, 200, 34, 10); ctx.fill();
    ctx.fillStyle = '#3fae5c';
    roundRect(ctx, 20, 20, Math.max(0, 192 * battle.hp / battle.maxHp), 16, 6); ctx.fill();
    if (battle.shield > 0) {
      ctx.fillStyle = '#8fd3e8';
      roundRect(ctx, 20, 38, Math.max(0, 192 * battle.shield / Math.round(battle.maxHp * 0.3)), 8, 4); ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = "12px 'Nunito','Noto Sans SC',sans-serif";
    ctx.textAlign = 'left';
    ctx.fillText(`HP ${battle.hp}/${battle.maxHp}`, 24, 33);
    // 波次进度(FR-7 最小:第 x/10 波)+ 等级/经验(M4)
    const prof = hud.profile ? hud.profile() : null;
    ctx.fillText(`Lv${prof ? prof.level : 1} · 第 ${battle.wave}/10 波 · EXP ${battle.expGained}`, 24, 60);
    // Boss 血条(顶部居中,FR-7)
    const boss = battle.enemies.find(e => e.alive && e.isBoss);
    if (boss) {
      const bw2 = 320, bx2 = (720 - bw2) / 2;
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      roundRect(ctx, bx2 - 3, 17, bw2 + 6, 20, 8); ctx.fill();
      ctx.fillStyle = '#a13a44';
      roundRect(ctx, bx2, 20, Math.max(0, bw2 * boss.hp / boss.maxHp), 14, 6); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(`BOSS ${boss.hp}/${boss.maxHp}`, 360, 31);
      ctx.textAlign = 'left';
    }
    ctx.textAlign = 'center';
  }
  ctx.restore(); // 视差/震动变换结束(联动栏与棋盘不参与 screenshake)

  // ===== 联动栏(M2:5 行档位条 + 4 装配槽) =====
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 448, 720, 56);
  ctx.strokeStyle = '#dcd8d1';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 449, 718, 54);
  if (hud.charge) {
    // 5 行档位条(每行 90px 宽:小色块 ×5 表示档位)
    for (let i = 0; i < 5; i++) {
      const el = ELEMENTS[i];
      const x0 = 12 + i * 92;
      const t = hud.charge.tiers[el];
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = k < t ? GEM_SRC[el] : 'rgba(0,0,0,.10)';
        roundRect(ctx, x0 + k * 15, 460 + (i % 2) * 12, 12, 14, 3); ctx.fill();
      }
    }
    // 4 装配槽(宝石图 + CD 扫描;M4 起槽位存技能 ID,按技能行取元素色,CD 按技能)
    if (hud.caster) {
      hud.caster.loadout.forEach((id, i) => {
        const x = 500 + i * 52;
        const sk = skillById(id);
        const el = sk ? sk.el : id;
        const cd = sk ? (hud.caster.skillCds[sk.id] || 0) : 0;
        ctx.fillStyle = '#fff';
        roundRect(ctx, x, 458, 44, 36, 8); ctx.fill();
        const img = GEM_IMG[el];
        if (img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, x + 6, 462, 32, 28);
        else { ctx.fillStyle = GEM_SRC[el]; roundRect(ctx, x + 6, 462, 32, 28, 6); ctx.fill(); }
        if (cd > 0) {
          ctx.fillStyle = 'rgba(0,0,0,.45)';
          roundRect(ctx, x, 458, 44 * (cd / (sk ? sk.cd : 2.0)), 36, 8); ctx.fill();
        }
        // 非初始弹标记(技能库技能:右上小点)
        if (sk && sk.unlockLevel > 1) {
          ctx.fillStyle = '#f5c31c';
          ctx.beginPath(); ctx.arc(x + 38, 463, 3, 0, Math.PI * 2); ctx.fill();
        }
      });
    }
  }

  // ===== 三消棋盘 =====
  ctx.fillStyle = '#f8f8f0';
  ctx.fillRect(0, BOARD_Y, BOARD_W, BOARD_H);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? '#f4f3ea' : '#fbfaf4';
      ctx.fillRect(c * CELL, BOARD_Y + r * CELL, CELL, CELL);
    }
  }
  for (const cell of engine.cellsForRender()) {
    const x = cell.c * CELL + (cell.offsetX || 0);
    const y = BOARD_Y + cell.r * CELL + cell.offsetY;
    if (isItem(cell)) {
      ctx.globalAlpha = cell.alpha;
      ctx.fillStyle = cell.premium ? '#ffe9b8' : '#ffe9c2';
      roundRect(ctx, x + 8, y + 8, CELL - 16, CELL - 16, 18);
      ctx.fill();
      ctx.strokeStyle = '#f5c31c';
      ctx.lineWidth = 3;
      roundRect(ctx, x + 8, y + 8, CELL - 16, CELL - 16, 18);
      ctx.stroke();
      ctx.fillStyle = '#794f27';
      ctx.font = "30px 'Nunito','Noto Sans SC',sans-serif";
      ctx.fillText(ITEM_ICON[cell.item] || '?', x + CELL / 2, y + CELL / 2 - 2);
      ctx.font = "14px 'Nunito','Noto Sans SC',sans-serif";
      ctx.fillText(Math.ceil(cell.expire) + 's', x + CELL / 2, y + CELL / 2 + 22);
      ctx.globalAlpha = 1;
      continue;
    }
    const el = ELEMENTS[cell.el];
    const img = GEM_IMG[el];
    const cx = x + CELL / 2, cy = y + CELL / 2;
    const size = 74 * (cell.scale ?? 1);
    ctx.globalAlpha = cell.alpha;
    if (img && img.complete && img.naturalWidth > 0) {
      if (cell.offsetY === 0) {
        ctx.fillStyle = 'rgba(90,70,40,.16)';
        ctx.beginPath(); ctx.ellipse(cx, y + CELL - 14, size * 0.38, 7, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    } else {
      ctx.fillStyle = GEM_SRC[el];
      ctx.beginPath(); ctx.arc(cx, cy, 37 * (cell.scale ?? 1), 0, Math.PI * 2); ctx.fill();
    }
    if (cell.flash > 0) {
      ctx.globalAlpha = cell.flash * 0.8;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(cx, cy, 40, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ===== 底栏 =====
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 1224, 720, 56);
  ctx.fillStyle = '#9f927d';
  ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
  const st = engine.paralyzed ? '棋盘瘫痪 · 等待恢复'
    : `M3 · 第 ${battle ? battle.level : 1} 关 · 击杀 ${battle ? battle.kills : 0}`;
  ctx.fillText(st, 360, 1258);

  // 特效层
  if (hud.fx) hud.fx.draw(ctx);

  // 事件提示浮层
  if (hud.toast && hud.toast.t > 0) {
    ctx.fillStyle = 'rgba(121,79,39,.85)';
    roundRect(ctx, 180, 516, 360, 44, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(hud.toast.text, 360, 545);
  }

  // ===== 胜负结算弹层(FR-1.4 验收:失败/通关各触发对应弹层) =====
  if (battle && battle.phase === 'VICTORY') {
    overlay(ctx, '通关!', `本关经验 +${battle.expGained} · 击杀 ${battle.kills}`, '#3fae5c', '点击任意处返回选关');
  } else if (battle && battle.phase === 'DEFEAT') {
    overlay(ctx, '失败', `本局击杀 ${battle.kills} · 已获经验 ${battle.expGained}(不清退)`, '#c44', '点击任意处从第 1 波重来');
  }

  // ===== M4 选关界面(FR-6:顺序解锁,锁定灰置) =====
  if (hud.screen && hud.screen() === 'menu') {
    ctx.fillStyle = 'rgba(20,22,15,.82)';
    ctx.fillRect(0, 0, 720, 1280);
    ctx.fillStyle = '#fdf6e8';
    ctx.font = "52px 'Nunito','Noto Sans SC',sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('三消守卫', 360, 340);
    ctx.font = "22px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText('消除五行 · 合成技能 · 守卫到底', 360, 390);
    const prof = hud.profile ? hud.profile() : { level: 1 };
    const prog = hud.progress ? hud.progress() : { unlockedLevel: 1 };
    ctx.fillText(`Lv${prof.level} · 通关进度 ${prog.lastLevelCleared}/5`, 360, 460);
    for (let i = 1; i <= 5; i++) {
      const bx = 75 + (i - 1) * 118, by = 600, unlocked = i <= prog.unlockedLevel;
      ctx.fillStyle = unlocked ? '#fdf6e8' : 'rgba(200,200,200,.25)';
      roundRect(ctx, bx, by, 100, 100, 16); ctx.fill();
      if (unlocked) { ctx.strokeStyle = '#7ba86f'; ctx.lineWidth = 3; roundRect(ctx, bx, by, 100, 100, 16); ctx.stroke(); }
      ctx.fillStyle = unlocked ? '#5a4a32' : 'rgba(120,120,120,.6)';
      ctx.font = "40px 'Nunito','Noto Sans SC',sans-serif";
      ctx.fillText(i, bx + 50, by + 52);
      ctx.font = "14px 'Nunito','Noto Sans SC',sans-serif";
      ctx.fillText(unlocked ? (i <= prog.lastLevelCleared ? '可重打' : '可挑战') : '未解锁', bx + 50, by + 82);
    }
    ctx.fillStyle = '#9f927d';
    ctx.font = "16px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText('点击已解锁关卡开始', 360, 760);
  }
}

function overlay(ctx, title, line, color, hint) {
  ctx.fillStyle = 'rgba(10,10,20,.55)';
  ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = '#fdf6e8';
  roundRect(ctx, 160, 460, 400, 220, 20); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 4;
  roundRect(ctx, 160, 460, 400, 220, 20); ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "44px 'Nunito','Noto Sans SC',sans-serif";
  ctx.textAlign = 'center';
  ctx.fillText(title, 360, 550);
  ctx.fillStyle = '#5a4a32';
  ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
  ctx.fillText(line, 360, 600);
  ctx.fillText(hint, 360, 645);
  ctx.textAlign = 'center';
}

// 视差未就绪时的静态兜底(与 M2 版面一致)
function drawFlatBackdrop(ctx) {
  const sky = ctx.createLinearGradient(0, 0, 0, 448);
  sky.addColorStop(0, '#7ec8e3');
  sky.addColorStop(1, '#c9ecf5');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 720, 448);
  ctx.fillStyle = '#a8cfa8';
  ctx.beginPath();
  ctx.moveTo(0, 330); ctx.lineTo(140, 210); ctx.lineTo(260, 330);
  ctx.lineTo(420, 180); ctx.lineTo(560, 330);
  ctx.lineTo(660, 240); ctx.lineTo(720, 330);
  ctx.lineTo(720, 448); ctx.lineTo(0, 448);
  ctx.fill();
  const grass = ctx.createLinearGradient(0, 390, 0, 448);
  grass.addColorStop(0, '#6cae57');
  grass.addColorStop(1, '#4f9040');
  ctx.fillStyle = grass;
  ctx.fillRect(0, 396, 720, 52);
}

function drawEnemy(ctx, e, t, scale) {
  const frames = ENEMY_FRAMES[e.name] || ENEMY_FRAMES.slime;
  // 攻击动画:开火后 animDur 内按 2×fps 单次正播;其余时间按原 fps 慢速循环(待机)
  let f;
  if (e.attackAnimT > 0 && e.animDur > 0) {
    const p = 1 - e.attackAnimT / e.animDur;
    f = frames[Math.min(frames.length - 1, Math.floor(p * frames.length))];
  } else {
    f = seqFrame(frames, worldT + e.y, t.fps);
  }
  const w = t.srcW * t.scale * scale, h = t.srcH * t.scale * scale;
  if (f && f.complete && f.naturalWidth > 0) {
    ctx.drawImage(f, e.x - w / 2, e.y - h / 2, w, h);
  } else {
    ctx.fillStyle = '#5fae5f';
    ctx.beginPath(); ctx.ellipse(e.x, e.y, (t.radius || 45) * scale, (t.radius || 45) * 1.4 * scale, 0, 0, Math.PI * 2); ctx.fill();
  }
}

void TIER_MULT; void PLAYER_Y; void ENEMY_SPAWN_X;
