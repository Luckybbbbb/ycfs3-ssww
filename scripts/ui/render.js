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
import { ENEMY_TYPES, levelWeights } from '../battle/wave.js';
import { PLAYER_Y, ENEMY_SPAWN_X } from '../battle/enemy.js';
import { BATTLE_H } from '../battle/parallax.js';
import { LEVEL_META, WAVES_PER_LEVEL } from '../meta/levels.js'; // M11 UI 设计稿:关卡名/建议等级
import { expNeed, levelFromExp } from '../meta/exp.js'; // M11 选关/备战顶栏经验条

const ITEM_ICON = { heal: '❤', invincible: '✦', cd: '⏱' };
// 道具图标贴图(assets/icons/items/<item>[_premium].png 144×144;缺图回退 emoji 原样式;
// 预载校验见 assets/manifest.js iconList)
// ===== M11-03 F1 残留整改:生产导入路径零顶层加载 =====
// 历史(两轮裁决):本模块顶层循环创建 Image 并立即赋 src——在 main 调 preload **之前**就发生
// 119 次独立加载,绕过 loader 的 24 并发上限与重试(M11-01 F1)。「bindImages 兜底」注释与
// 执行事实不符(M11-02 F1 残留)。现改为:各表初始为空,生产路径**唯一填充入口=bindImages(map)**
// (main 预载成功后注入 preload 同一实例);ensureFallbackImages() 为显式兜底入口(幂等,仅
// 单测/无 main 的演示环境调用),生产代码永不调用——启动期全部图片加载只发生在 preload 内
// (24 并发/重试口径覆盖真实启动流程)。
const ITEM_IMG = {};
// ===== M11-02 F1 整改:渲染贴图消费预载同一资源集合 =====
// 历史缺陷:本模块在求值期自建全部 Image(上方与下方各表),绕过 loader 的重试/并发上限——
// 预载 125/125 成功后,渲染层自建实例仍可能加载失败(弱网下独立失败),高级图标回退 emoji 且
// main 丢弃 preload 返回 Map,预载成果没有被消费。
// 修复:保留懒加载自建为兜底(单测/未接 main 的演示环境),新增 bindImages(map)——main 预载
// 成功后以 **preload 返回的同一 Image 实例** 替换各表项,保证「预载成功 ⇒ 绘制资源就绪」。
export function bindImages(map) {
  if (!map || typeof map.get !== 'function') return 0;
  let n = 0;
  for (const it of ['heal', 'invincible', 'cd']) {
    for (const suffix of ['', '_premium']) {
      const img = map.get(`icon:items:${it}${suffix}`);
      if (img) { ITEM_IMG[it + suffix] = img; n++; }
    }
  }
  for (const el of ELEMENTS) {
    const img = map.get(`icon:elements:${el}`);
    if (img) { GEM_IMG[el] = img; n++; }
  }
  for (const s of SKILL_LIBRARY) {
    const img = map.get(`icon:skills:${s.id}`);
    if (img) { SKILL_IMG[s.id] = img; n++; }
  }
  // PLAYER idle 16 / walk_start 3:帧数按 manifest 固定口径(表初始为空,不能以 length 为界)
  for (let i = 0; i < 16; i++) {
    const img = map.get(`player:idle:${i + 1}`);
    if (img) { PLAYER_FRAMES[i] = img; n++; }
  }
  for (let i = 0; i < 3; i++) {
    const img = map.get(`player:walk_start:${i + 1}`);
    if (img) { PLAYER_ATK_FRAMES[i] = img; n++; }
  }
  for (const [type, t] of Object.entries(ENEMY_TYPES)) {
    ENEMY_FRAMES[type] = []; // M11-03 F1:先初始化行数组——ENEMY_FRAMES 初始 {},直接 [type][j]=img 抛 TypeError(黑屏根因)
    t.frames.forEach((fn, j) => {
      const img = map.get(`${type}:${fn}`);
      if (img) { ENEMY_FRAMES[type][j] = img; n++; }
    });
  }
  return n;
}
// 技能一句话说明(备战界面技能库行;03 文档 5.2 kind 口径)
const SKILL_BRIEF = {
  bolt: '单体弹', dotzone: '灼烧区域', chain: '连锁弹', bind: '束缚+持续伤害', multi: '多发弹',
  shield: '护盾', pulse: '脉冲环', field: '减速领域', aura: '回复光环',
};
// M11-03 F1:显式兜底入口(幂等)——把渲染消费的全部贴图按 manifest 同款路径自建加载。
// 仅限单测/无 main 的演示环境显式调用;生产路径唯一入口=bindImages(preload Map)。
export function ensureFallbackImages() {
  if (ensureFallbackImages._done) return ensureFallbackImages._done;
  const created = [];
  const mk = (url) => { const img = new Image(); img.src = url; created.push(img); return img; };
  for (const it of ['heal', 'invincible', 'cd']) {
    for (const suffix of ['', '_premium']) ITEM_IMG[it + suffix] = mk(new URL(`../../assets/icons/items/${it}${suffix}.png`, import.meta.url).href);
  }
  for (const el of ELEMENTS) GEM_IMG[el] = mk(new URL(`${el}.png`, GEM_DIR).href);
  for (const s of SKILL_LIBRARY) SKILL_IMG[s.id] = mk(new URL(`../../assets/icons/skills/${s.id}.png`, import.meta.url).href);
  for (let i = 1; i <= 16; i++) PLAYER_FRAMES.push(mk(new URL(`../../assets/sprites/player/idle_${String(i).padStart(2, '0')}.png`, import.meta.url).href));
  for (let i = 1; i <= 3; i++) PLAYER_ATK_FRAMES.push(mk(new URL(`../../assets/sprites/player/walk_start_${String(i).padStart(2, '0')}.png`, import.meta.url).href));
  for (const [type, t] of Object.entries(ENEMY_TYPES)) {
    ENEMY_FRAMES[type] = t.frames.map(n => mk(new URL(`../../assets/sprites/${t.dir}/${t.prefix}${String(n).padStart(3, '0')}_nobg.png`, import.meta.url).href));
  }
  ensureFallbackImages._done = created;
  return created;
}
// bindImages(map):生产唯一填充入口(main 预载成功后调用)——见下方定义。

// 渲染贴图表(初始全空;填充入口二选一:生产=bindImages,单测/演示=ensureFallbackImages;
// miss 时绘制层已有矢量/emoji 兜底)
const GEM_DIR = new URL('../../assets/icons/elements/', import.meta.url);
const GEM_IMG = {};      // 棋子贴图(M10:assets/icons/elements/<el>.png;缺图矢量兜底)
const SKILL_IMG = {};    // 技能图标(M10:assets/icons/skills/<id>.png;缺图文字兜底)
const PLAYER_FRAMES = [];      // 主角 idle 16 帧(缺图人形色块兜底)
const PLAYER_ATK_FRAMES = [];  // 主角攻击 walk_start 3 帧
const ENEMY_FRAMES = {};       // 六类敌人序列帧(缺图椭圆兜底)
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
      // M11-05:待机 idle 帧水平镜像(素材面左);攻击帧 walk_start 朝向正确,保持原样不翻
      if (battle.playerAttackT > 0) ctx.drawImage(pf, PLAYER_X - 90, 448 - 320, 180, 320);
      else drawFlipH(ctx, pf, PLAYER_X - 90, 448 - 320, 180, 320);
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
  // M9:播报棋盘微震(chain≥4 播报附带 ±2px 衰减;覆盖棋盘+演出+特效层,底栏/弹层不参与)
  const bShake = hud.fx && hud.fx.boardShake ? hud.fx.boardShake() : { dx: 0, dy: 0 };
  ctx.save();
  ctx.translate(bShake.dx, bShake.dy);
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
      // M11:道具图标贴图(高级版用 _premium;缺图回退 emoji 原样式)
      const itemImg = ITEM_IMG[cell.item + (cell.premium ? '_premium' : '')];
      if (itemImg && itemImg.complete && itemImg.naturalWidth > 0) {
        ctx.drawImage(itemImg, x + 19, y + 12, CELL - 38, CELL - 38);
      } else {
        ctx.fillStyle = '#794f27';
        ctx.font = "30px 'Nunito','Noto Sans SC',sans-serif";
        ctx.fillText(ITEM_ICON[cell.item] || '?', x + CELL / 2, y + CELL / 2 - 2);
      }
      ctx.fillStyle = '#794f27';
      ctx.font = "14px 'Nunito','Noto Sans SC',sans-serif";
      ctx.fillText(Math.ceil(cell.expire) + 's', x + CELL / 2, y + CELL / 2 + 30);
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
  // REQ-M6-07 F8 续审修复:组阶段由**块自身 elapsed** 推导——
  // 不再读 cl.stage(那只在 cellsForRender 输出对象上,clearing 原始数据没有,曾致段②③④全灭)。
  // M9-F1:段边界/段③上浮/段④碎裂补间全部读本轮 engine.stageDur(随连锁 RUSH 缩放;
  // 修复前固定 0.35/0.50/0.75/0.9——chain3 缺少段④,chain≥4 缺少段③④)。
  // 认领绑定已上移至 main(tick 后按执行记录/存续预约回写 setBlockFx)——渲染层**纯显示**:
  // stamp.reserved→技能名+档位星;未认领→「蓄能」+池内档位。
  if (engine.fxEnabled !== false && engine.clearing && engine.clearing.length) {
    const sd = engine.stageDur || { absorb: 0.35, flash: 0.15, icon: 0.25, burst: 0.15 };
    const t2 = sd.absorb, t3 = sd.absorb + sd.flash, t4 = sd.absorb + sd.flash + sd.icon, tEnd = t4 + sd.burst;
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
      const stage = g.elapsed >= t4 ? 4 : g.elapsed >= t3 ? 3 : g.elapsed >= t2 ? 2 : 1;
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
        // ③上浮 20px(段③时长=sd.icon);④放大 1.3 倍后碎裂淡出(段④时长=sd.burst;M9-F1 随 RUSH 缩放)
        const e3 = Math.min(sd.icon, Math.max(0, g.elapsed - t3));
        const p4 = Math.min(1, Math.max(0, (g.elapsed - t4) / sd.burst));
        const iconAlpha = stage >= 4 ? 1 - p4 : Math.min(1, e3 / (sd.icon * 0.4));
        const iconScale = stage >= 4 ? 1 + 0.3 * p4 : 0.8 + 0.2 * (e3 / sd.icon);
        const yOff = stage >= 4 ? -20 : -20 * (e3 / sd.icon);
        if (iconAlpha > 0.01) {
          ctx.save();
          ctx.translate(gx, gy + yOff);
          ctx.scale(iconScale, iconScale);
          ctx.globalAlpha = iconAlpha;
          // M10:技能图标贴图(56px 居中偏上)+下方技能名+档位星;缺图回退纯文字(原样式)
          const skillImg = SKILL_IMG[stamp?.skillId || ''];
          if (skillImg && skillImg.complete && skillImg.naturalWidth > 0) {
            ctx.drawImage(skillImg, -28, -46, 56, 56);
            ctx.fillStyle = '#7a4f27';
            ctx.font = "bold 18px 'Nunito','Noto Sans SC',sans-serif";
            ctx.textAlign = 'center';
            ctx.fillText(stars > 0 ? `${label} ${'★'.repeat(stars)}` : label, 0, 28);
          } else {
            ctx.fillStyle = '#ffb02e';
            ctx.font = "bold 24px 'Nunito','Noto Sans SC',sans-serif";
            ctx.textAlign = 'center';
            ctx.fillText(stars > 0 ? `${label} ${'★'.repeat(stars)}` : label, 0, 0);
          }
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

  // M11:连锁常显提示已移除(需求方 2026-10-17——中间右侧「连锁 ×N」旧提示与新播报重复;
  // 连锁信息唯一来源=fx.chainAnnounce 王者式定版播报)

  // ===== 底栏 =====
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 1224, 720, 56);
  ctx.strokeStyle = '#dcd8d1';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 1224); ctx.lineTo(720, 1224); ctx.stroke();
  ctx.fillStyle = '#9f927d';
  ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
  const st = engine.paralyzed ? '棋盘瘫痪 · 等待恢复'
    : `第 ${battle ? battle.level : 1} 关 ${LEVEL_META[(battle ? battle.level : 1) - 1]?.name || ''} · 击杀 ${battle ? battle.kills : 0} · 消除 ${hud.cleared ? hud.cleared() : 0}`;
  ctx.fillText(st, 360, 1258);
  // M11 底栏操作按钮(UI 设计稿 04:⏸ 暂停 / ⚙ 设置)
  drawIconBtn(ctx, UI.battle.pauseBtn, '⏸');
  drawIconBtn(ctx, UI.battle.settingsBtn, '⚙');
  // 货币/材料 HUD(FR-7 v0.2:击杀/通关产出实时可见)
  const prof0 = hud.profile ? hud.profile() : null;
  if (prof0) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffe9b8';
    ctx.font = "18px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(`💰 ${prof0.coins ?? 0}  ⛏ ${prof0.materials ?? 0}`, 620, 1258);
    ctx.textAlign = 'center';
  }

  // 特效层(REQ-M7-01 F5:关动效 fxEnabled=false 时**停止绘制**存量粒子/冒字——
  // main 侧事件仍照常排空丢弃,6.1「冒字与粒子同步关闭」)
  if (hud.fx && engine.fxEnabled !== false) hud.fx.draw(ctx);
  ctx.restore(); // M9 棋盘微震变换结束(播报光带/文字随棋盘震,底栏不参与)

  // M9:预输入缓冲预选提示(FALLING 等忙时滑动被记住——两格金色虚线框+「落定执行」微标)
  if (engine.swapBuffer) {
    ctx.save();
    ctx.strokeStyle = '#f5c31c';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    for (const s of [engine.swapBuffer.a, engine.swapBuffer.b]) {
      roundRect(ctx, s.c * CELL + 4, BOARD_Y + s.r * CELL + 4, CELL - 8, CELL - 8, 12);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 事件提示浮层
  if (hud.toast && hud.toast.t > 0) {
    ctx.fillStyle = 'rgba(121,79,39,.85)';
    roundRect(ctx, 180, 516, 360, 44, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
    ctx.fillText(hud.toast.text, 360, 545);
  }

  // ===== 胜负结算(FR-1.4;UI 设计稿 05:横幅+统计卡+按钮组;M11 重做) =====
  if (battle && battle.phase === 'VICTORY') {
    drawResult(ctx, hud, battle, true);
  } else if (battle && battle.phase === 'DEFEAT') {
    drawResult(ctx, hud, battle, false);
  }

  // ===== M11 界面路由(UI 设计稿五屏;01 开始 / 02 选关 / 03 备战;战斗与结算见上) =====
  const scr = hud.screen ? hud.screen() : 'playing';
  if (scr === 'start') drawStartScreen(ctx, hud);
  if (scr === 'menu') {
    drawMenuScreen(ctx, hud);
    if (hud.growPanel && hud.growPanel()) drawGrowPanel(ctx, hud); // FR-10 养成面板(选关入口,保留)
  }
  if (scr === 'loadout') drawLoadoutScreen(ctx, hud);
  if (scr === 'playing' && hud.paused && hud.paused() && battle && battle.phase === 'FIGHTING') {
    drawPauseOverlay(ctx, hud); // M11 暂停
  }
  if (scr === 'start' || scr === 'menu' || scr === 'loadout' || (scr === 'playing' && hud.paused && hud.paused())) {
    if (hud.panel && hud.panel() === 'settings') drawSettingsPanel(ctx, hud); // M11 设置(开始/暂停共用)
    if (hud.panel && hud.panel() === 'about') drawAboutPanel(ctx, hud);
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

// (M11:原型期胜负 overlay 已由 drawResult 五屏结算界面替代,原函数移除)

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

// M11-05 朝向整改:素材帧默认朝向与站位需求相反——主角 idle 面左(需面右)、敌人面右(需面左),
// 仅攻击帧 walk_start 朝向正确;统一用水平镜像绘制修正
function drawFlipH(ctx, img, x, y, w, h) {
  ctx.save();
  ctx.translate(x + w / 2, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(img, -w / 2, y, w, h);
  ctx.restore();
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
    drawFlipH(ctx, f, ex - w / 2, e.y - h / 2, w, h); // M11-05:敌人帧整体水平镜像(面左向主角)
    if (flashing) ctx.restore();
  } else {
    ctx.fillStyle = flashing ? '#ffffff' : '#5fae5f';
    ctx.beginPath(); ctx.ellipse(ex, e.y, (t.radius || 45) * scale, (t.radius || 45) * 1.4 * scale, 0, 0, Math.PI * 2); ctx.fill();
  }
}

void TIER_MULT; void PLAYER_Y; void ENEMY_SPAWN_X;

// ==================== M11 界面(UI 设计稿 docs/design/ui/ 五屏) ====================
// 布局常量导出:main.js 命中区与测试共用(单一来源,与 draw* 逐字一致)
export const UI = {
  start: {
    playBtn: { x: 160, y: 900, w: 400, h: 110 },
    settingsBtn: { x: 160, y: 1030, w: 190, h: 90 },
    aboutBtn: { x: 370, y: 1030, w: 190, h: 90 },
  },
  menu: {
    backBtn: { x: 24, y: 20, w: 80, h: 70 },
    growBtn: { x: 566, y: 1140, w: 130, h: 80 },
    cardTop: 200, cardH: 170, cardGap: 14, // F7 整改:首卡下移(货币 HUD 不再被卡覆盖),卡高压缩给 HUD 行让位
    cardBtn: { w: 150, h: 80 }, cardBtnY: 45, // 卡内右侧:x=510, y=cardY+cardBtnY
    chipsX: 210, chipsY: 100, chipsMaxX: 505, chipsRowGap: 34, // M11-03 F7:chips 左列两行、限宽 ≤300(x<505),与按钮区 x≥510 完全错开
  },
  loadout: {
    backBtn: { x: 24, y: 20, w: 80, h: 70 },
    panelY: 490, slotsY: 560, slotSize: 120, slotGap: 24, // 4 槽:x0=44,步进 144
    libY: 715, libRowH: 38, libCols: [56, 376], libPerCol: 8, // F2 整改:两列 8 行(15 技能全可见;原 7 行漏第 15 个 NaN)
    libRowW: 288,
    fightBtn: { x: 160, y: 1115, w: 400, h: 100 },
  },
  battle: {
    pauseBtn: { x: 24, y: 1232, w: 70, h: 40 },
    settingsBtn: { x: 626, y: 1232, w: 70, h: 40 },
  },
  result: {
    victory: {
      mainBtn: { x: 110, y: 1010, w: 500, h: 110 },  // 下一关
      retryBtn: { x: 110, y: 1140, w: 240, h: 90 },  // 重打本关
      backBtn: { x: 370, y: 1140, w: 240, h: 90 },   // 返回选关
    },
    defeat: {
      mainBtn: { x: 110, y: 870, w: 500, h: 110 },   // 再战一次
      loadoutBtn: { x: 110, y: 1000, w: 240, h: 90 },// 去备战
      backBtn: { x: 370, y: 1000, w: 240, h: 90 },   // 返回选关
    },
  },
  pause: {
    resumeBtn: { x: 210, y: 470, w: 300, h: 90 },
    sfxBtn: { x: 210, y: 590, w: 300, h: 70 },
    fxBtn: { x: 210, y: 680, w: 300, h: 70 },
    quitBtn: { x: 210, y: 780, w: 300, h: 90 },
  },
  settings: {
    panel: { x: 110, y: 440, w: 500, h: 400 },
    sfxBtn: { x: 160, y: 540, w: 400, h: 80 },
    fxBtn: { x: 160, y: 650, w: 400, h: 80 },
    closeBtn: { x: 260, y: 760, w: 200, h: 60 },
  },
  about: {
    panel: { x: 110, y: 440, w: 500, h: 400 },
    closeBtn: { x: 260, y: 760, w: 200, h: 60 },
  },
};

const FONT = (s, w = '') => `${w ? w + ' ' : ''}${s}px 'Nunito','Noto Sans SC',sans-serif`;

// ===== M11-02 F2/F7 整改:命中区单一来源 =====
// 选关卡片按钮 / 备战槽位 / 技能库行的命中区此前在 main 硬编码(与 render 布局双源易漂移,
// libRectOf 甚至按旧 7 行计算)——统一由 UI 常量派生,main 与测试共用。
export const uiCardBtn = (L) => ({
  x: 510,
  y: UI.menu.cardTop + (L - 1) * (UI.menu.cardH + UI.menu.cardGap) + UI.menu.cardBtnY,
  w: UI.menu.cardBtn.w, h: UI.menu.cardBtn.h,
});
export const uiSlotRect = (i) => ({
  x: 44 + i * (UI.loadout.slotSize + UI.loadout.slotGap),
  y: UI.loadout.slotsY, w: UI.loadout.slotSize, h: UI.loadout.slotSize,
});
export const uiLibRect = (i) => {
  const col = Math.floor(i / UI.loadout.libPerCol), row = i % UI.loadout.libPerCol;
  return {
    x: UI.loadout.libCols[col],
    y: UI.loadout.libY + 56 + row * UI.loadout.libRowH,
    w: UI.loadout.libRowW, h: UI.loadout.libRowH - 4,
  };
};

// 通用小按钮(底栏 ⏸/⚙ 等 ghost 风格)
function drawIconBtn(ctx, r, glyph) {
  ctx.fillStyle = '#fff';
  roundRect(ctx, r.x, r.y, r.w, r.h, 10); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 2;
  roundRect(ctx, r.x, r.y, r.w, r.h, 10); ctx.stroke();
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(22, 'bold');
  ctx.textAlign = 'center';
  ctx.fillText(glyph, r.x + r.w / 2, r.y + r.h / 2 + 8);
}

// 通用 clay 按钮(kind: primary|ghost|warn|disabled)
function drawBtn(ctx, r, text, kind = 'primary', fontSize = 26) {
  const colors = {
    primary: ['#19c8b9', '#fff'],
    ghost: ['#f0e8d8', '#794f27'],
    warn: ['#f5c31c', '#794f27'],
    disabled: ['#d8d2c4', '#c4b89e'],
  };
  const [bg, fg] = colors[kind] || colors.primary;
  ctx.fillStyle = bg;
  roundRect(ctx, r.x, r.y, r.w, r.h, Math.min(24, r.h / 2)); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 3;
  roundRect(ctx, r.x, r.y, r.w, r.h, Math.min(24, r.h / 2)); ctx.stroke();
  ctx.fillStyle = fg;
  ctx.font = FONT(fontSize, 'bold');
  ctx.textAlign = 'center';
  ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2 + fontSize * 0.36);
}

// 顶栏(选关/备战共用;UI 设计稿 02/03:h=110 青绿浅底)
function drawTopBar(ctx, title, prof) {
  ctx.fillStyle = '#e6f9f6';
  ctx.fillRect(0, 0, 720, 110);
  ctx.strokeStyle = '#e8e2d6'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, 110); ctx.lineTo(720, 110); ctx.stroke();
  drawBtn(ctx, UI.menu.backBtn, '←', 'ghost', 30);
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(38, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText(title, 124, 68);
  ctx.textAlign = 'center';
  if (prof) {
    // 等级 chip + 经验条(读 profile 累计经验;M11 设计稿 02)
    ctx.fillStyle = '#fff';
    roundRect(ctx, 470, 25, 96, 56, 28); ctx.fill();
    ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 2; roundRect(ctx, 470, 25, 96, 56, 28); ctx.stroke();
    ctx.fillStyle = '#794f27'; ctx.font = FONT(24, 'bold');
    ctx.fillText(`Lv.${prof.level}`, 518, 60);
    const { surplus } = levelFromExp(prof.expTotal ?? 0);
    const need = expNeed(prof.level);
    ctx.fillStyle = '#fff';
    roundRect(ctx, 586, 40, 110, 26, 13); ctx.fill();
    ctx.strokeStyle = '#dcd8d1'; roundRect(ctx, 586, 40, 110, 26, 13); ctx.stroke();
    ctx.fillStyle = '#f5c31c';
    roundRect(ctx, 588, 42, Math.max(4, 106 * Math.min(1, surplus / need)), 22, 11); ctx.fill();
  }
}

// ===== 01 开始界面 =====
function drawStartScreen(ctx, hud) {
  // 田园渐变背景(上青绿天→米白地)
  const sky = ctx.createLinearGradient(0, 0, 0, 1280);
  sky.addColorStop(0, '#d8f3ef'); sky.addColorStop(0.46, '#d8f3ef'); sky.addColorStop(0.46, '#f8f8f0'); sky.addColorStop(1, '#f8f8f0');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 720, 1280);
  // 远景装饰:云(低饱和,浮动动画)
  ctx.fillStyle = 'rgba(255,255,255,.8)';
  const drift = (worldT * 12) % 800 - 80;
  for (const [cx0, cy0, s] of [[drift, 90, 1], [drift + 320, 150, 0.7], [drift + 560, 70, 0.85]]) {
    ctx.beginPath();
    ctx.ellipse(cx0, cy0, 55 * s, 20 * s, 0, 0, Math.PI * 2);
    ctx.ellipse(cx0 + 40 * s, cy0 - 10 * s, 35 * s, 16 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 远山剪影
  ctx.fillStyle = '#bfe3d0';
  ctx.beginPath();
  ctx.moveTo(0, 584); ctx.lineTo(160, 470); ctx.lineTo(330, 584);
  ctx.lineTo(500, 455); ctx.lineTo(720, 584); ctx.lineTo(720, 620); ctx.lineTo(0, 620);
  ctx.fill();
  // 标题(Claymorphism 厚描边字,浮动动画)
  const ty = 250 + Math.sin(worldT * 1.6) * 8;
  ctx.textAlign = 'center';
  ctx.font = FONT(84, 'bold');
  ctx.lineWidth = 14; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(121,79,39,.9)'; ctx.strokeText('言出法随之三生万物', 360, ty);
  ctx.fillStyle = '#19c8b9'; ctx.fillText('言出法随之三生万物', 360, ty);
  ctx.font = FONT(28);
  ctx.fillStyle = '#794f27';
  ctx.fillText('消除五行 · 合成技能 · 守卫到底', 360, ty + 56);
  // 主角立绘(player idle 序列帧,绘制 210×374)
  const pf = PLAYER_FRAMES.length ? seqFrame(PLAYER_FRAMES, worldT, 8) : null;
  if (pf && pf.complete && pf.naturalWidth > 0) {
    drawFlipH(ctx, pf, 255, 420, 210, 374); // M11-05:idle 立绘水平镜像(面右)
  } else {
    ctx.fillStyle = '#3f6fb5';
    roundRect(ctx, 285, 440, 150, 340, 30); ctx.fill();
  }
  // 主按钮(有存档「开始冒险」/无档「开始游戏」——存档信息条有无同步)
  const prof = hud.profile ? hud.profile() : null;
  const hasSave = !!(prof && ((prof.level > 1) || (prof.expTotal ?? 0) > 0 || (hud.progress ? hud.progress().lastLevelCleared : 0) > 0));
  drawBtn(ctx, UI.start.playBtn, hasSave ? '开 始 冒 险' : '开 始 游 戏', 'primary', 36);
  drawBtn(ctx, UI.start.settingsBtn, '设 置', 'ghost', 28);
  drawBtn(ctx, UI.start.aboutBtn, '关 于', 'ghost', 28);
  // 存档信息条
  ctx.font = FONT(22);
  const prog = hud.progress ? hud.progress() : { lastLevelCleared: 0 };
  if (hasSave) {
    ctx.fillStyle = '#fff';
    roundRect(ctx, 128, 1152, 330, 52, 26); ctx.fill();
    ctx.strokeStyle = '#dcd8d1'; roundRect(ctx, 128, 1152, 330, 52, 26); ctx.stroke();
    ctx.fillStyle = '#794f27';
    ctx.fillText(`存档:Lv.${prof.level} · 已通关第 ${prog.lastLevelCleared} 关`, 293, 1185);
  }
  ctx.fillStyle = '#9f927d';
  ctx.fillText('v0.1 原型', 560, 1185);
}

// ===== 02 关卡选择 =====
function drawMenuScreen(ctx, hud) {
  ctx.fillStyle = '#f8f8f0'; ctx.fillRect(0, 0, 720, 1280);
  const prof = hud.profile ? hud.profile() : { level: 1, coins: 0, materials: 0 };
  const prog = hud.progress ? hud.progress() : { unlockedLevel: 1, lastLevelCleared: 0 };
  drawTopBar(ctx, '关卡选择', prof);
  // 货币/材料(FR-7 v0.2;F7 整改:卡顶 200 下移,HUD 行不再被首卡覆盖)
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(24, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText(`💰 ${prof.coins ?? 0}  ⛏ ${prof.materials ?? 0}`, 124, 178);
  ctx.textAlign = 'center';
  // 关卡卡片 ×5(三态:已通关重打 / 当前高亮挑战 / 锁定)
  for (let i = 1; i <= 5; i++) {
    const meta = LEVEL_META[i - 1] || { name: `第 ${i} 关`, suggest: i };
    const y = UI.menu.cardTop + (i - 1) * (UI.menu.cardH + UI.menu.cardGap);
    const cleared = i <= prog.lastLevelCleared;
    const unlocked = i <= prog.unlockedLevel;
    const current = unlocked && !cleared;
    // 卡片底
    ctx.fillStyle = !unlocked ? '#f0e8d8' : current ? '#e6f9f6' : '#fff';
    roundRect(ctx, 32, y, 656, UI.menu.cardH, 24); ctx.fill();
    ctx.strokeStyle = current ? '#19c8b9' : cleared ? '#dcd8d1' : '#e8e2d6';
    ctx.lineWidth = current ? 4 : 3;
    roundRect(ctx, 32, y, 656, UI.menu.cardH, 24); ctx.stroke();
    // Boss 缩略图(boss 序列帧首帧;缺图灰盒)
    const th = 126, tx = 56, tyy = y + 22;
    ctx.fillStyle = '#efe9db';
    roundRect(ctx, tx, tyy, th, th, 16); ctx.fill();
    const bossImg = ENEMY_FRAMES.boss && ENEMY_FRAMES.boss[0];
    if (!unlocked) {
      ctx.fillStyle = '#c4b89e'; ctx.font = FONT(34);
      ctx.fillText('🔒', tx + th / 2, tyy + th / 2 + 4);
      ctx.font = FONT(18); ctx.fillText('未解锁', tx + th / 2, tyy + th / 2 + 40);
    } else if (bossImg && bossImg.complete && bossImg.naturalWidth > 0) {
      ctx.save();
      roundRect(ctx, tx, tyy, th, th, 16); ctx.clip();
      drawFlipH(ctx, bossImg, tx + 5, tyy + 5, th - 10, th - 10); // M11-05:与战斗中敌人朝向一致(面左)
      ctx.restore();
    } else {
      ctx.fillStyle = '#9f927d'; ctx.font = FONT(20);
      ctx.fillText('Boss', tx + th / 2, tyy + th / 2 + 7);
    }
    // 文案区
    ctx.textAlign = 'left';
    ctx.fillStyle = unlocked ? '#794f27' : '#9f927d';
    ctx.font = FONT(30, 'bold');
    ctx.fillText(`第 ${i} 关 · ${meta.name}`, 210, y + 52);
    ctx.font = FONT(21);
    ctx.fillStyle = '#9f927d';
    // M11-03 F7 整改:锁定态文案并入副标行(解锁条件),chips 区域不再被锁定文案占用
    const subtitle = unlocked
      ? `建议 Lv.${meta.suggest}+ · Boss×1 · ${WAVES_PER_LEVEL} 波`
      : `通关第 ${i - 1} 关后解锁 · ${WAVES_PER_LEVEL} 波`;
    ctx.fillText(subtitle, 210, y + 84);
    // 敌人编成 chips(M11-03 F7 残留整改:键序=wave.js LEVEL_WEIGHTS 真表;左列两行、
    // 限宽 ≤300(chipsMaxX=505)——与按钮区 x≥510 完全错开,修复前单行铺开被按钮遮挡
    // (第四/五关 tiger 区域 x523~596 与按钮区 x510~660/y45~125 相交,基线 y=121 被盖))
    let cx0 = UI.menu.chipsX, cy0 = y + UI.menu.chipsY;
    for (const k of Object.keys(levelWeights(i))) {
      const w = 18 + k.length * 11;
      if (cx0 + w > UI.menu.chipsMaxX) { cx0 = UI.menu.chipsX; cy0 += UI.menu.chipsRowGap; } // 超出左列(≤300)换行到第二行
      ctx.fillStyle = '#fff';
      roundRect(ctx, cx0, cy0, w, 28, 14); ctx.fill();
      ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 2; roundRect(ctx, cx0, cy0, w, 28, 14); ctx.stroke();
      ctx.fillStyle = '#794f27'; ctx.font = FONT(16);
      ctx.fillText(k, cx0 + w / 2, cy0 + 19);
      cx0 += w + 8;
    }
    ctx.textAlign = 'center';
    // 状态 chip + 按钮(右列;M11-03 F7:按钮区 x≥510 与 chips 左列完全错开)
    if (cleared) {
      chip(ctx, 370, y + 30, '已通关', '#e6f9f6', '#0e7a70');
      drawBtn(ctx, uiCardBtn(i), '重打', 'ghost', 26);
    } else if (current) {
      chip(ctx, 560, y - 14, '当前进度', '#fff', '#794f27');
      drawBtn(ctx, uiCardBtn(i), '挑战', 'primary', 26);
    } else {
      drawBtn(ctx, uiCardBtn(i), '锁定', 'disabled', 26);
    }
  }
  // 养成入口(FR-10 保留)
  drawBtn(ctx, UI.menu.growBtn, '养成', 'ghost', 28);
}

function chip(ctx, x, y, text, bg, fg) {
  ctx.font = FONT(20);
  const w = 28 + ctx.measureText(text).width;
  ctx.fillStyle = bg;
  roundRect(ctx, x, y, w, 40, 20); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 2; roundRect(ctx, x, y, w, 40, 20); ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 14, y + 27);
  ctx.textAlign = 'center';
  return w;
}

// ===== 03 备战界面 =====
function drawLoadoutScreen(ctx, hud) {
  ctx.fillStyle = '#f8f8f0'; ctx.fillRect(0, 0, 720, 1280);
  const prof = hud.profile ? hud.profile() : { level: 1, coins: 0, materials: 0, ownedSkills: [], skillLevels: {}, loadout: [] };
  const lo = hud.loadout ? hud.loadout() : { selLevel: 1, selSlot: 0 };
  const L = lo.selLevel || 1;
  const meta = LEVEL_META[L - 1] || { name: `第 ${L} 关`, suggest: L };
  drawTopBar(ctx, `备战 · 第 ${L} 关`, prof);
  // 主角面板(立绘+等级/HP/ATK+升级缺口)
  ctx.fillStyle = '#fff';
  roundRect(ctx, 32, 140, 400, 330, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, 32, 140, 400, 330, 24); ctx.stroke();
  const pf = PLAYER_FRAMES.length ? seqFrame(PLAYER_FRAMES, worldT, 8) : null;
  ctx.fillStyle = '#efe9db';
  roundRect(ctx, 52, 160, 160, 290, 16); ctx.fill();
  if (pf && pf.complete && pf.naturalWidth > 0) {
    ctx.save(); roundRect(ctx, 52, 160, 160, 290, 16); ctx.clip();
    drawFlipH(ctx, pf, 72, 170, 120, 214); // M11-05:idle 立绘水平镜像(面右)
    ctx.restore();
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(30, 'bold');
  ctx.fillText(`赤狐 · Lv.${prof.level}`, 232, 200);
  ctx.font = FONT(24);
  ctx.fillText(`HP ${maxHpText(prof.level)}`, 232, 240);
  ctx.fillStyle = '#fff'; roundRect(ctx, 232, 252, 176, 18, 9); ctx.fill();
  ctx.fillStyle = '#6fba2c'; roundRect(ctx, 234, 254, 172, 14, 7); ctx.fill();
  ctx.fillStyle = '#794f27';
  ctx.fillText(`ATK ${atkText(prof.level)}`, 232, 310);
  ctx.font = FONT(21);
  ctx.fillStyle = '#9f927d';
  const cost = levelUpCost(prof.level);
  ctx.fillText(`升级:Lv.${prof.level} → ${prof.level + 1}`, 232, 356);
  ctx.fillText(`材料 ${cost}(养成面板升级)`, 232, 386);
  ctx.textAlign = 'center';
  // 出战信息卡
  ctx.fillStyle = '#f0e8d8';
  roundRect(ctx, 460, 140, 228, 330, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; roundRect(ctx, 460, 140, 228, 330, 24); ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(26, 'bold');
  ctx.fillText('出战信息', 482, 184);
  ctx.font = FONT(19);
  ctx.fillStyle = '#5a4a32';
  // M11-03 F7 残留整改:wave.js 真权重表+按宽度换行(信息卡内区宽 ~190px,一行放不下高关卡 5 键)
  const enemiesAll = Object.keys(levelWeights(L));
  const enemiesL1 = enemiesAll.slice(0, 3).join(' / ');
  const enemiesL2 = enemiesAll.slice(3).join(' / ');
  ctx.fillText(`关卡:第 ${L} 关 ${meta.name}`, 482, 222);
  ctx.fillText(`波次:${WAVES_PER_LEVEL} 波`, 482, 252);
  ctx.fillText(`第 ${WAVES_PER_LEVEL} 波为关底 Boss`, 482, 278);
  if (enemiesL2) {
    ctx.fillText(`敌人:${enemiesL1} /`, 482, 308);
    ctx.fillText(enemiesL2, 500, 334);
    ctx.fillText(`建议等级:Lv.${meta.suggest}+`, 482, 364);
  } else {
    ctx.fillText(`敌人:${enemiesL1}`, 482, 308);
    ctx.fillText(`建议等级:Lv.${meta.suggest}+`, 482, 338);
  }
  const warnY = enemiesL2 ? 392 : 366;
  if (prof.level < meta.suggest) {
    ctx.fillStyle = '#fff';
    roundRect(ctx, 482, warnY - 26, 184, 40, 20); ctx.fill();
    ctx.strokeStyle = '#e05a5a'; ctx.lineWidth = 2; roundRect(ctx, 482, warnY - 26, 184, 40, 20); ctx.stroke();
    ctx.fillStyle = '#e05a5a'; ctx.font = FONT(19, 'bold');
    ctx.fillText('⚠ 等级低于建议', 574, warnY);
  }
  ctx.textAlign = 'center';
  // 技能装配 4 槽(M11 设计稿:120×120 图标+技能名;点击选中→技能库换装;
  // F2/F7 整改:槽区上移 panelY=490/slotsY=560,库区扩为两列 8 行)
  ctx.fillStyle = '#fff';
  roundRect(ctx, 32, UI.loadout.panelY, 656, 210, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, 32, UI.loadout.panelY, 656, 210, 24); ctx.stroke();
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(26, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText('技能装配', 56, UI.loadout.panelY + 40);
  ctx.font = FONT(19);
  ctx.fillStyle = '#9f927d';
  ctx.fillText('点击槽位选中 → 在下方技能库点技能换装(立即生效)', 150, UI.loadout.panelY + 40);
  ctx.textAlign = 'center';
  for (let i = 0; i < 4; i++) {
    const sr = uiSlotRect(i);
    const sx = sr.x, sy = sr.y;
    const id = prof.loadout[i];
    const sk = skillById(id);
    const sel = (lo.selSlot || 0) === i;
    ctx.fillStyle = sel ? 'rgba(25,200,185,.15)' : '#f8f8f0';
    roundRect(ctx, sx, sy, UI.loadout.slotSize, UI.loadout.slotSize, 20); ctx.fill();
    ctx.strokeStyle = sel ? '#19c8b9' : 'rgba(121,79,39,.35)';
    ctx.lineWidth = sel ? 5 : 3;
    roundRect(ctx, sx, sy, UI.loadout.slotSize, UI.loadout.slotSize, 20); ctx.stroke();
    if (sk) {
      const img = SKILL_IMG[sk.id];
      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, sx + 22, sy + 14, 76, 76);
      } else {
        ctx.fillStyle = GEM_SRC[sk.el];
        ctx.beginPath(); ctx.arc(sx + 60, sy + 52, 38, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = ['fire', 'water', 'earth'].includes(sk.el) ? '#fff' : '#794f27';
        ctx.font = FONT(30, 'bold');
        ctx.fillText(sk.el[0].toUpperCase(), sx + 60, sy + 63);
      }
      ctx.fillStyle = '#794f27';
      ctx.font = FONT(20, 'bold');
      ctx.fillText(sk.name, sx + 60, sy + 108);
    } else {
      ctx.fillStyle = '#c4b89e';
      ctx.font = FONT(22);
      ctx.fillText('空槽', sx + 60, sy + 66);
    }
  }
  // 技能库(F2 整改:两列 8 行——15 技能全部可见可点,原 7 行第 15 个 earth_pulse
  // col=2 → x=undefined/NaN 溢出屏外;F7 整改:行内改两行文本,名字与简介不再重叠)
  ctx.fillStyle = '#fff';
  roundRect(ctx, 32, UI.loadout.libY, 656, 380, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, 32, UI.loadout.libY, 656, 380, 24); ctx.stroke();
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(24, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText('技能库', 56, UI.loadout.libY + 36);
  ctx.font = FONT(18);
  ctx.fillStyle = '#9f927d';
  ctx.fillText('(Lv 解锁 · 灰=未解锁 · ●=已装配 · 点击换到选中槽)', 150, UI.loadout.libY + 36);
  SKILL_LIBRARY.forEach((sk, i) => {
    const r = uiLibRect(i);
    const x0 = r.x, y0 = r.y;
    // M11-02 F4:拥有制灰显与装配门控一致(等级够但未拥有 → 灰+「未拥有」,养成抽卡获取)
    const ownedNow = (prof.ownedSkills || []).includes(sk.id);
    const unlockedNow = sk.unlockLevel <= prof.level && ownedNow;
    const equipped = (prof.loadout || []).includes(sk.id);
    ctx.fillStyle = unlockedNow ? 'rgba(232,226,214,.5)' : 'rgba(232,226,214,.85)';
    roundRect(ctx, x0, y0, r.w, r.h, 10); ctx.fill();
    const img = SKILL_IMG[sk.id];
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, x0 + 4, y0 + 3, 28, 28);
    } else {
      ctx.fillStyle = GEM_SRC[sk.el];
      ctx.beginPath(); ctx.arc(x0 + 18, y0 + 17, 13, 0, Math.PI * 2); ctx.fill();
    }
    // 行 1:技能名(+已装配 ●);行 2:简介|CD|等级(13px,F7 整改:单行 18px 名+15px 简介同 x 轴曾重叠)
    ctx.fillStyle = unlockedNow ? '#5a4a32' : '#c4b89e';
    ctx.font = FONT(17, 'bold');
    ctx.fillText(sk.name + (equipped ? ' ●' : ''), x0 + 38, y0 + 15);
    ctx.font = FONT(13);
    ctx.fillStyle = unlockedNow ? '#9f927d' : '#c4b89e';
    ctx.fillText(`${SKILL_BRIEF[sk.kind] || sk.kind}｜CD ${sk.cd}s｜${unlockedNow ? 'Lv' + (prof.skillLevels[sk.id] || 1) : !ownedNow ? '未拥有' : 'Lv' + sk.unlockLevel + '解锁'}`, x0 + 38, y0 + 31);
  });
  ctx.textAlign = 'center';
  // 出战按钮
  drawBtn(ctx, UI.loadout.fightBtn, '出 战', 'primary', 38);
}

// HP/ATK 面板值(与 meta/exp.js 公式同源:HP=100+15×(Lv−1)、ATK=10+(Lv−1);避免循环依赖内联)
function maxHpText(level) { return 100 + 15 * (level - 1); }
function atkText(level) { return 10 + (level - 1); }

// ===== 05 结算(胜利/失败;UI 设计稿 05) =====
function drawResult(ctx, hud, battle, victory) {
  ctx.fillStyle = victory ? 'rgba(232,246,224,.88)' : 'rgba(243,226,224,.9)';
  ctx.fillRect(0, 0, 720, 1280);
  const R = victory ? UI.result.victory : UI.result.defeat;
  // 横幅
  ctx.fillStyle = victory ? '#6fba2c' : '#e05a5a';
  roundRect(ctx, 90, 130, 540, 150, 24); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 4;
  roundRect(ctx, 90, 130, 540, 150, 24); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = FONT(64, 'bold');
  ctx.textAlign = 'center';
  ctx.fillText(victory ? '通 关 !' : '战 败', 360, 228);
  // 统计卡
  const cardH = victory ? 580 : 430;
  ctx.fillStyle = '#fff';
  roundRect(ctx, 60, 340, 600, cardH, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, 60, 340, 600, cardH, 24); ctx.stroke();
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(30, 'bold');
  ctx.fillText(victory ? `第 ${battle.level} 关 · 结算` : `第 ${battle.level} 关 · 第 ${battle.wave} 波`, 360, 390);
  ctx.font = FONT(25);
  ctx.textAlign = 'left';
  let ry = 440;
  const row = (label, value, color = '#5a4a32') => {
    ctx.fillStyle = '#9f927d'; ctx.fillText(label, 92, ry);
    ctx.fillStyle = color; ctx.textAlign = 'right'; ctx.fillText(value, 628, ry); ctx.textAlign = 'left';
    ry += 42;
  };
  row('击杀敌人', `${battle.kills} 只`);
  row('最高连锁', `×${hud.maxChain ? hud.maxChain() : 0}`);
  row('击杀经验累计', `+${battle.expGained} exp`);
  if (victory) {
    row('通关奖励', `💰${battle.victoryCoins || 0} ⛏${battle.victoryMats || 0}`);
    row('本局产出', `💰${battle.coinsGained} ⛏${battle.matsGained}`, '#b06f1f');
    // 升级/资产段(经验与材料收益已入档;养成面板消费)
    ry += 8;
    ctx.strokeStyle = '#dcd8d1'; ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(92, ry - 24); ctx.lineTo(628, ry - 24); ctx.stroke();
    ctx.setLineDash([]);
    const prof = hud.profile ? hud.profile() : { level: 1, coins: 0, materials: 0 };
    ctx.fillStyle = '#5a4a32';
    ctx.font = FONT(28, 'bold');
    ctx.fillText(`当前 Lv.${prof.level}`, 92, ry + 20);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f5c31c';
    ctx.fillText(`💰${prof.coins ?? 0} ⛏${prof.materials ?? 0}`, 628, ry + 20);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#9f927d';
    ctx.font = FONT(19);
    ctx.fillText('养成面板可用材料升级/技能升级/抽卡', 92, ry + 56);
    // 解锁提示 chip(通关 L → 解锁 L+1,FR-6)
    if (battle.level < 5) {
      const meta = LEVEL_META[battle.level] || { name: `第 ${battle.level + 1} 关` };
      ctx.textAlign = 'center';
      chip(ctx, 210, 946, `🎉 解锁第 ${battle.level + 1} 关 · ${meta.name}`, '#fff', '#0e7a70');
      ctx.textAlign = 'left';
    }
  } else {
    row('本局获得', `💰${battle.coinsGained} ⛏${battle.matsGained}`, '#b06f1f');
    row('剩余主角 HP', '0', '#e05a5a');
    // 鼓励文案(距建议等级差距动态生成)
    const meta = LEVEL_META[battle.level - 1] || { suggest: battle.level };
    ctx.fillStyle = '#efe9db';
    roundRect(ctx, 92, ry - 10, 536, 96, 14); ctx.fill();
    ctx.fillStyle = '#794f27';
    ctx.font = FONT(22);
    ctx.textAlign = 'center';
    const lv = hud.profile ? (hud.profile().level || 1) : 1;
    ctx.fillText(lv < meta.suggest ? `练到 Lv.${meta.suggest} 再来挑战!` : '差一点!调整装配再战一次。', 360, ry + 22);
    ctx.font = FONT(18);
    ctx.fillStyle = '#9f927d';
    ctx.fillText('失败无惩罚:等级/收益/解锁全部保留', 360, ry + 64);
    ctx.textAlign = 'left';
  }
  ctx.textAlign = 'center';
  // 按钮组
  if (victory) {
    drawBtn(ctx, R.mainBtn, battle.level >= 5 ? '完 成' : '下一关 ▶', 'primary', 36);
    drawBtn(ctx, R.retryBtn, '重打本关', 'ghost', 28);
    drawBtn(ctx, R.backBtn, '返回选关', 'ghost', 28);
  } else {
    drawBtn(ctx, R.mainBtn, '再战一次', 'primary', 36);
    drawBtn(ctx, R.loadoutBtn, '去备战', 'ghost', 28);
    drawBtn(ctx, R.backBtn, '返回选关', 'ghost', 28);
  }
}

// ===== 暂停浮层(底栏 ⏸;M11) =====
function drawPauseOverlay(ctx, hud) {
  ctx.fillStyle = 'rgba(20,22,15,.6)';
  ctx.fillRect(0, 0, 720, 1280);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fdf6e8';
  ctx.font = FONT(44, 'bold');
  ctx.fillText('已暂停', 360, 400);
  drawBtn(ctx, UI.pause.resumeBtn, '继 续', 'primary', 32);
  const sfxOn = hud.sfxEnabled ? hud.sfxEnabled() : true;
  const fxOn = hud.fxEnabled ? hud.fxEnabled() : true;
  drawBtn(ctx, UI.pause.sfxBtn, `音效:${sfxOn ? '开' : '关'}`, 'ghost', 24);
  drawBtn(ctx, UI.pause.fxBtn, `动效:${fxOn ? '开' : '关'}`, 'ghost', 24);
  drawBtn(ctx, UI.pause.quitBtn, '放弃本局 · 返回选关', 'warn', 24);
}

// ===== 设置面板(开始界面「设置」/暂停面板共用;M11) =====
function drawSettingsPanel(ctx, hud) {
  ctx.fillStyle = 'rgba(20,22,15,.6)';
  ctx.fillRect(0, 0, 720, 1280);
  const P = UI.settings.panel;
  ctx.fillStyle = '#fdf6e8';
  roundRect(ctx, P.x, P.y, P.w, P.h, 24); ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#5a4a32';
  ctx.font = FONT(34, 'bold');
  ctx.fillText('设 置', 360, P.y + 60);
  const sfxOn = hud.sfxEnabled ? hud.sfxEnabled() : true;
  const fxOn = hud.fxEnabled ? hud.fxEnabled() : true;
  drawBtn(ctx, UI.settings.sfxBtn, `音效:${sfxOn ? '开' : '关'}`, 'ghost', 26);
  drawBtn(ctx, UI.settings.fxBtn, `消除动效:${fxOn ? '开' : '关'}`, 'ghost', 26);
  drawBtn(ctx, UI.settings.closeBtn, '关 闭', 'primary', 24);
}

// ===== 关于面板(M11) =====
function drawAboutPanel(ctx, hud) {
  ctx.fillStyle = 'rgba(20,22,15,.6)';
  ctx.fillRect(0, 0, 720, 1280);
  const P = UI.about.panel;
  ctx.fillStyle = '#fdf6e8';
  roundRect(ctx, P.x, P.y, P.w, P.h, 24); ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#5a4a32';
  ctx.font = FONT(34, 'bold');
  ctx.fillText('关 于', 360, P.y + 60);
  ctx.font = FONT(21);
  ctx.fillStyle = '#794f27';
  ctx.fillText('言出法随之三生万物 v0.1 原型', 360, P.y + 130);
  ctx.fillStyle = '#9f927d';
  ctx.fillText('上半横版放置自动战斗 × 下半 8×8 五行三消', 360, P.y + 176);
  ctx.fillText('消除合成技能,主角自动释放,挑战五关', 360, P.y + 208);
  ctx.fillText('纯 HTML5 Canvas 2D · 720×1280', 360, P.y + 240);
  drawBtn(ctx, UI.about.closeBtn, '关 闭', 'primary', 24);
}
