// scripts/ui/render.js
// Canvas 渲染:M3 战斗区(视差三层+六类敌人序列帧+双方弹+血条+波次/Boss HUD+胜负弹层)
//             + 联动栏(档位条+装配槽)+ 三消棋盘
// 相对路径: scripts/ui/render.js
// M6 v0.2:养成面板(FR-10)+ 货币/材料 HUD;布局须与 main.handleGrowClick 命中区一致
// 素材: player/slime/fox/zombie/snake/tiger/boss 序列帧复用 godot-roguelike(04 文档第 6 节);宝石见 gems/LICENSE.md

import { BOARD_W, BOARD_H, BOARD_Y, CELL, ELEMENTS, isItem } from '../board/grid.js';
import { roundRect, GEM_COLORS as GEM_SRC } from './draw_util.js'; // 五行色单一定义源(弹道与冒字共用,REQ-M7-01 F6)
import { PLAYER_X, TIER_MULT } from '../skills/registry.js';
import { skillById, SKILL_LIBRARY } from '../skills/library.js';
import { levelUpCost, skillUpCost, SKILL_LEVEL_CAP } from '../meta/economy.js';
import { ENEMY_TYPES } from '../battle/wave.js';
import { PLAYER_Y, ENEMY_SPAWN_X } from '../battle/enemy.js';
import { BATTLE_H } from '../battle/parallax.js';

const ITEM_ICON = { heal: '❤', invincible: '✦', cd: '⏱' };
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
      // 状态标记(03 文档 6.2b:4 种——灼烧🔥/减速❄/束缚🌿/眩晕💫;字段非零显示、清零消失;
      // M8 配色整改:颜色引用 GEM_SRC 单一定义源,与元素语义一致)
      if (e.burn) { ctx.fillStyle = GEM_SRC.fire; ctx.font = '16px sans-serif'; ctx.fillText('🔥', e.x + 30, e.y - t.srcH * t.scale / 2 - 24); }
      if (e.slowT > 0) { ctx.fillStyle = GEM_SRC.water; ctx.font = '16px sans-serif'; ctx.fillText('❄', e.x - 38, e.y - t.srcH * t.scale / 2 - 24); }
      if (e.bindT > 0) { ctx.fillStyle = GEM_SRC.wood; ctx.font = '16px sans-serif'; ctx.fillText('🌿', e.x - 57, e.y - t.srcH * t.scale / 2 - 24); }
      if (e.stunT > 0) { ctx.fillStyle = GEM_SRC.earth; ctx.font = '16px sans-serif'; ctx.fillText('💫', e.x - 19, e.y - t.srcH * t.scale / 2 - 24); }
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
    // M5 无敌道具:主角金圈
    if (battle.invincibleT > 0) {
      ctx.strokeStyle = `rgba(245,195,28,${Math.min(1, battle.invincibleT)})`;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(PLAYER_X, 300, 96, 0, Math.PI * 2); ctx.stroke();
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
    // 波次进度(FR-7:第 x/10 波)+ 等级
    const prof = hud.profile ? hud.profile() : null;
    ctx.fillText(`Lv${prof ? prof.level : 1} · 第 ${battle.wave}/10 波`, 24, 60);
    // (v0.2:经验条废弃——FR-7 改货币/材料 HUD,见右上角;局内不产出经验)
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
          // CD 转圈(FR-7:径向扫描覆盖,自 12 点方向顺时针消退)
          const frac = Math.min(1, cd / (sk ? sk.cd : 2.0));
          ctx.fillStyle = 'rgba(0,0,0,.45)';
          ctx.beginPath();
          ctx.moveTo(x + 22, 476);
          ctx.arc(x + 22, 476, 26, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
          ctx.closePath();
          ctx.fill();
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
  // 果冻拖拽/回弹状态(M6:v0.2 02 文档 2.2;hud.drag = input.dragState() 快照 {drag,bounces})
  // REQ-M6-06 F7:回弹与新拖动**分别保存**——A 回弹期间拖 B,B 正常跟手,A 继续回弹互不影响
  const ds = hud.drag ? hud.drag() : null;
  for (const cell of engine.cellsForRender()) {
    let jx = 0, jy = 0, sx = 1, sy = 1;
    if (ds) {
      if (ds.drag && ds.drag.cell.r === cell.r && ds.drag.cell.c === cell.c) {
        jx += ds.drag.dx; jy += ds.drag.dy;
        // 挤压形变:沿拖动方向拉伸、垂直压缩(体积感守恒);回弹时反向过冲由 easeOutBack 在 input 层给出
        const k = Math.min(1, Math.hypot(ds.drag.dx, ds.drag.dy) / 40) * 0.08;
        if (Math.abs(ds.drag.dx) >= Math.abs(ds.drag.dy)) { sx *= 1 + k; sy *= 1 - k; } else { sy *= 1 + k; sx *= 1 - k; }
      }
      for (const b of ds.bounces) {
        if (b.cell.r === cell.r && b.cell.c === cell.c) { jx += b.dx; jy += b.dy; }
      }
    }
    const x = cell.c * CELL + (cell.offsetX || 0) + jx;
    const y = BOARD_Y + cell.r * CELL + cell.offsetY + jy;
    if (isItem(cell)) {
      ctx.globalAlpha = cell.alpha;
      ctx.fillStyle = cell.premium ? '#ffe9b8' : '#ffe9c2';
      roundRect(ctx, x + 8, y + 8, CELL - 16, CELL - 16, 18);
      ctx.fill();
      ctx.strokeStyle = '#f5c31c';
      ctx.lineWidth = 3;
      roundRect(ctx, x + 8, y + 8, CELL - 16, CELL - 16, 18);
      ctx.stroke();
      // 道具格倒计时圈(FR-7/02 文档第 6 节:10s 环形倒计时,自 12 点方向顺时针)
      ctx.beginPath();
      ctx.arc(x + CELL / 2, y + CELL / 2, CELL / 2 - 4, -Math.PI / 2, -Math.PI / 2 + Math.max(0, Math.min(1, cell.expire / 10)) * Math.PI * 2);
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
    // 形变合成:拖拽挤压 × 演出段形变(段①吸收挤压等,cell.sx/sy 由 engine 提供)
    const jw = size * sx * (cell.sx ?? 1), jh = size * sy * (cell.sy ?? 1);
    ctx.globalAlpha = cell.alpha;
    if (img && img.complete && img.naturalWidth > 0) {
      if (cell.offsetY === 0) {
        ctx.fillStyle = 'rgba(90,70,40,.16)';
        ctx.beginPath(); ctx.ellipse(cx, y + CELL - 14, size * 0.38, 7, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.drawImage(img, cx - jw / 2, cy - jh / 2, jw, jh);
    } else {
      ctx.fillStyle = GEM_SRC[el];
      const es = 37 * (cell.scale ?? 1);
      ctx.beginPath(); ctx.ellipse(cx, cy, es * sx * (cell.sx ?? 1), es * sy * (cell.sy ?? 1), 0, 0, Math.PI * 2); ctx.fill();
    }
    if (cell.flash > 0) {
      ctx.globalAlpha = cell.flash * 0.8;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(cx, cy, 40, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 消除演出段②③④(02 文档 3.1):按**块键 bk**分组。
  // REQ-M6-07 F8 续审修复:组阶段由**块自身 elapsed** 推导(0.35/0.5/0.75 边界)——
  // 不再读 cl.stage(那只在 cellsForRender 输出对象上,clearing 原始数据没有,曾致段②③④全灭)。
  // 认领绑定已上移至 main(tick 后按执行记录/存续预约回写 setBlockFx)——渲染层**纯显示**:
  // stamp.reserved→技能名+档位星;未认领→「蓄能」+池内档位。
  if (engine.fxEnabled !== false && engine.clearing && engine.clearing.length) {
    const groups = new Map(); // bk -> {r, c, elName, count, elapsed}
    for (const cl of engine.clearing) {
      const key = cl.bk || `x${cl.r},${cl.c}`;
      if (!groups.has(key)) groups.set(key, { r: cl.cx, c: cl.cc, elName: null, count: 0, elapsed: 0 });
      const g = groups.get(key);
      g.count++;
      g.elapsed = Math.max(g.elapsed, engine.clearTotal - cl.t);
      if (g.elName === null && cl.el !== undefined) g.elName = ELEMENTS[cl.el];
    }
    for (const [key, g] of groups) {
      const gx = g.c * CELL + CELL / 2, gy = 504 + g.r * CELL + CELL / 2;
      const stage = g.elapsed >= 0.75 ? 4 : g.elapsed >= 0.5 ? 3 : g.elapsed >= 0.35 ? 2 : 1;
      // 段② 起点:合成闪光五行色粒子迸发 ≤8(一次性)
      if (stage >= 2) {
        if (!engine._flashShown) engine._flashShown = new Set();
        if (!engine._flashShown.has(key)) {
          engine._flashShown.add(key);
          if (hud.fx) hud.fx.burst(gx, gy, g.elName || 'fire', 2, 8);
        }
      }
      // 段③/④:强化技能图标(预约→技能名+档位星;未认领→元素蓄能+池内档位)
      if (stage >= 3 && stage <= 4 && (g.elName || engine.blockFx?.get(key))) {
        let label = `${g.elName || ''}蓄能`, stars = 0;
        const stamp = engine.blockFx?.get(key);
        if (stamp?.reserved) {
          label = skillById(stamp.skillId)?.name || stamp.skillId;
          stars = stamp.tier;
        } else {
          stars = hud.charge ? (hud.charge.tiers[stamp?.el || g.elName] || 0) : 0;
        }
        // ③上浮 20px(0.5~0.75);④放大 1.3 倍后碎裂淡出(0.75~0.9)
        const e3 = Math.min(0.25, Math.max(0, g.elapsed - 0.5));
        const p4 = Math.min(1, Math.max(0, (g.elapsed - 0.75) / 0.15));
        const iconAlpha = stage >= 4 ? 1 - p4 : Math.min(1, e3 / 0.1);
        const iconScale = stage >= 4 ? 1 + 0.3 * p4 : 0.8 + 0.2 * (e3 / 0.25);
        const yOff = stage >= 4 ? -20 : -20 * (e3 / 0.25);
        if (iconAlpha > 0.01) {
          ctx.save();
          ctx.translate(gx, gy + yOff);
          ctx.scale(iconScale, iconScale);
          ctx.globalAlpha = iconAlpha;
          ctx.fillStyle = '#ffb02e';
          ctx.font = "bold 24px 'Nunito','Noto Sans SC',sans-serif";
          ctx.textAlign = 'center';
          ctx.fillText(stars > 0 ? `${label} ${'★'.repeat(stars)}` : label, 0, 0);
          if (stage >= 4) {
            // 碎裂:4 片碎片沿对角方向飞散
            ctx.strokeStyle = '#ffb02e';
            ctx.lineWidth = 3;
            const frag = 8 + 26 * p4;
            for (const [fx2, fy2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
              ctx.beginPath();
              ctx.moveTo(fx2 * frag * 0.4, fy2 * frag * 0.4);
              ctx.lineTo(fx2 * frag, fy2 * frag);
              ctx.stroke();
            }
          }
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      }
      // 段④ 起点:径向光效(一次性)
      if (stage >= 4) {
        if (!engine._burstShown) engine._burstShown = new Set();
        if (!engine._burstShown.has(key)) {
          engine._burstShown.add(key);
          if (hud.fx) hud.fx.burst(gx, gy, g.elName || 'fire', g.count, 12);
        }
      }
    }
  } else if (engine._flashShown && !engine.clearing?.length) {
    engine._iconShown = new Set(); engine._burstShown = new Set(); engine._flashShown = new Set();
  }

  // 连锁提示(FR-7:连锁进行中右上角常显;单次消除由飞字提示)
  if (engine.chain >= 2) {
    ctx.fillStyle = 'rgba(224,102,46,.9)';
    ctx.font = "bold 26px 'Nunito','Noto Sans SC',sans-serif";
    ctx.textAlign = 'right';
    ctx.fillText(`连锁 ×${engine.chain}`, 704, BOARD_Y + 34);
    ctx.textAlign = 'center';
  }

  // ===== 底栏 =====
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 1224, 720, 56);
  ctx.fillStyle = '#9f927d';
  ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
  const st = engine.paralyzed ? '棋盘瘫痪 · 等待恢复'
    : `M3 · 第 ${battle ? battle.level : 1} 关 · 击杀 ${battle ? battle.kills : 0} · 消除 ${hud.cleared ? hud.cleared() : 0}`;
  ctx.fillText(st, 360, 1258);
  // 货币/材料 HUD(FR-7 v0.2:击杀/通关产出实时可见)
  const prof0 = hud.profile ? hud.profile() : null;
  if (prof0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffe9b8';
    ctx.font = "18px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(`💰 ${prof0.coins ?? 0}  ⛏ ${prof0.materials ?? 0}`, 700, 30);
    ctx.textAlign = 'center';
  }

  // 特效层(REQ-M7-01 F5:关动效 fxEnabled=false 时**停止绘制**存量粒子/冒字——
  // main 侧事件仍照常排空丢弃,6.1「冒字与粒子同步关闭」)
  if (hud.fx && engine.fxEnabled !== false) hud.fx.draw(ctx);

  // 事件提示浮层
  if (hud.toast && hud.toast.t > 0) {
    ctx.fillStyle = 'rgba(121,79,39,.85)';
    roundRect(ctx, 180, 516, 360, 44, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(hud.toast.text, 360, 545);
  }

  // ===== 胜负结算弹层(FR-1.4 验收;REQ-M6-05 F12:明细分行,不越弹层边界) =====
  if (battle && battle.phase === 'VICTORY') {
    const vc = battle.victoryCoins || 0, vm = battle.victoryMats || 0;
    overlay(ctx, '通关!', [
      `货币 +${battle.coinsGained + vc} 材料 +${battle.matsGained + vm}`,
      `含通关奖励 💰${vc} ⛏${vm}`,
      `击杀 ${battle.kills}`,
    ], '#3fae5c', '点击任意处返回选关');
  } else if (battle && battle.phase === 'DEFEAT') {
    overlay(ctx, '失败', [
      `本局击杀 ${battle.kills}`,
      `货币 +${battle.coinsGained} 材料 +${battle.matsGained}`,
      '收益不清退',
    ], '#c44', '点击任意处从第 1 波重来');
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
    // 货币/材料显示(FR-7 v0.2)
    ctx.fillStyle = '#ffe9b8';
    ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(`💰 ${prof.coins ?? 0}    ⛏ ${prof.materials ?? 0}`, 360, 500);
    // 养成入口(FR-10:角色升级/技能升级/抽卡)
    ctx.fillStyle = '#7ba86f';
    roundRect(ctx, 290, 800, 140, 60, 14); ctx.fill();
    ctx.fillStyle = '#fdf6e8';
    ctx.font = "24px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText('养成', 360, 840);
    ctx.fillStyle = '#9f927d';
    ctx.font = "16px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText('点击已解锁关卡开始', 360, 940);
    if (hud.growPanel && hud.growPanel()) drawGrowPanel(ctx, hud);
  }
}

// 养成面板(FR-10;布局与 main.handleGrowClick 一致)
// REQ-M6-04 F9 整改:技能行文字改深色(浅底 #fdf6e8 上原 #fdf6e8 不可见);
// 15 技能两列 8 行布局(行高 46,全部落在返回按钮 y=960 之上,可达可升级);
// 满池抽卡入口置灰(ownedSkills ≥ 技能库全量)。
// 布局常量:列 x0=[70,375]、行顶 y=506+r×46、升级按钮=列 x0+180 起 70×36
export const GROW_LAYOUT = { listY: 506, rowH: 46, cols: [70, 375], perCol: 8, btnOff: 180, btnW: 70, btnH: 36 };
function drawGrowPanel(ctx, hud) {
  const prof = hud.profile();
  ctx.fillStyle = 'rgba(20,22,15,.9)';
  ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = '#fdf6e8';
  roundRect(ctx, 40, 200, 640, 880, 24); ctx.fill();
  ctx.fillStyle = '#5a4a32';
  ctx.textAlign = 'center';
  ctx.font = "36px 'Nunito','Noto Sans SC',sans-serif";
  ctx.fillText('养 成', 360, 260);
  ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
  ctx.fillText(`💰 ${prof.coins}    ⛏ ${prof.materials}    Lv${prof.level}`, 360, 300);
  // 角色升级按钮
  const cost = levelUpCost(prof.level);
  ctx.fillStyle = '#7ba86f';
  roundRect(ctx, 80, 300, 560, 64, 12); ctx.fill();
  ctx.fillStyle = '#fdf6e8';
  ctx.font = "22px 'Nunito','Noto Sans SC',sans-serif";
  ctx.fillText(`角色升级 →Lv${prof.level + 1}(材料 ${cost})${prof.materials < cost ? ' — 不足' : ''}`, 360, 342);
  // 抽卡按钮(满池置灰:F9)
  const poolFull = prof.ownedSkills.length >= SKILL_LIBRARY.length;
  ctx.fillStyle = poolFull ? 'rgba(150,150,150,.45)' : '#c98a3d';
  roundRect(ctx, 80, 380, 560, 64, 12); ctx.fill();
  ctx.fillStyle = '#fdf6e8';
  ctx.fillText(poolFull ? '技能已集齐' : `抽卡(100 币/次,从未拥有中抽取)${prof.coins < 100 ? ' — 货币不足' : ''}`, 360, 422);
  // 技能升级列表(已拥有;两列 8 行,F9 可达性)
  ctx.fillStyle = '#9f927d';
  ctx.font = "18px 'Nunito','Noto Sans SC',sans-serif";
  ctx.fillText('— 技能升级(材料)—', 360, 492);
  ctx.textAlign = 'left';
  prof.ownedSkills.forEach((id, i) => {
    const col = Math.floor(i / GROW_LAYOUT.perCol), row = i % GROW_LAYOUT.perCol;
    const x0 = GROW_LAYOUT.cols[col], yTop = GROW_LAYOUT.listY + row * GROW_LAYOUT.rowH;
    const skill = skillById(id);
    const lv = prof.skillLevels[id] || 1;
    const sc = skillUpCost(lv);
    ctx.fillStyle = '#5a4a32'; // F9:浅底深字(原 #fdf6e8 同色不可见)
    ctx.font = "18px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(skill ? skill.name : id, x0 + 2, yTop + 30);
    ctx.font = "14px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillStyle = '#9f927d';
    ctx.fillText(`Lv${lv}${lv >= SKILL_LEVEL_CAP ? '(满)' : ''}`, x0 + 122, yTop + 30);
    if (lv < SKILL_LEVEL_CAP) {
      const bx = x0 + GROW_LAYOUT.btnOff, by = yTop + 5;
      ctx.fillStyle = prof.materials >= sc ? '#7ba86f' : 'rgba(150,150,150,.4)';
      roundRect(ctx, bx, by, GROW_LAYOUT.btnW, GROW_LAYOUT.btnH, 8); ctx.fill();
      ctx.fillStyle = '#fdf6e8';
      ctx.font = "16px 'Nunito','Noto Sans SC',sans-serif";
      ctx.fillText(`−${sc}`, bx + GROW_LAYOUT.btnW / 2, by + 24);
    }
  });
  ctx.textAlign = 'center';
  ctx.fillStyle = '#c98a3d';
  roundRect(ctx, 60, 960, 600, 60, 14); ctx.fill();
  ctx.fillStyle = '#fdf6e8';
  ctx.font = "24px 'Nunito','Noto Sans SC',sans-serif";
  ctx.fillText('返 回', 360, 1000);
}

function overlay(ctx, title, lines, color, hint) {
  // lines:字符串数组(F12:明细分行,每行独立绘制,不越 160~560 弹层边界)
  const arr = Array.isArray(lines) ? lines : [lines];
  ctx.fillStyle = 'rgba(10,10,20,.55)';
  ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = '#fdf6e8';
  roundRect(ctx, 160, 440, 400, 260, 20); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 4;
  roundRect(ctx, 160, 440, 400, 260, 20); ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "44px 'Nunito','Noto Sans SC',sans-serif";
  ctx.textAlign = 'center';
  ctx.fillText(title, 360, 520);
  ctx.fillStyle = '#5a4a32';
  ctx.font = "19px 'Nunito','Noto Sans SC',sans-serif";
  arr.forEach((line, i) => ctx.fillText(line, 360, 566 + i * 30));
  ctx.fillText(hint, 360, 566 + arr.length * 30 + 14);
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
    // M8-F1:待机帧用受击者自身动画时钟 e.animClock(enemy 构造初始化、update 非冻结帧累积,
    // 卡肉期不推进→待机帧定格;取代全局 worldT——REQ-M8-02 F1:构造即初始化,无回退分支)
    f = seqFrame(frames, e.animClock + e.y, t.fps);
  }
  const w = t.srcW * t.scale * scale, h = t.srcH * t.scale * scale;
  // M8 受击反馈(03 文档 6.7):白闪=贴图白色剪影(filter 亮度归零反相)+ 冻结期水平微抖(SF/DNF 口径)
  const flashing = e.hitFlashT > 0;
  const shake = e.hitStopT > 0 ? Math.sin((e.hitFlashT + e.hitStopT) * 90) * 3 : 0;
  const ex = e.x + shake;
  if (f && f.complete && f.naturalWidth > 0) {
    if (flashing) { ctx.save(); ctx.filter = 'brightness(0) invert(1)'; }
    ctx.drawImage(f, ex - w / 2, e.y - h / 2, w, h);
    if (flashing) ctx.restore();
  } else {
    ctx.fillStyle = flashing ? '#ffffff' : '#5fae5f';
    ctx.beginPath(); ctx.ellipse(ex, e.y, (t.radius || 45) * scale, (t.radius || 45) * 1.4 * scale, 0, 0, Math.PI * 2); ctx.fill();
  }
}

void TIER_MULT; void PLAYER_Y; void ENEMY_SPAWN_X;
