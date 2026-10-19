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
import { ENEMY_TYPES, levelWeights, bossType } from '../battle/wave.js';
import { PLAYER_Y, ENEMY_SPAWN_X } from '../battle/enemy.js';
import { BATTLE_H } from '../battle/parallax.js';
import { HealthView } from './battle_hud.js';

// M13 敌人双血条(需求方 2026-10-18:二段扣除动效实装到敌人血条——主条立即扣,
// 淡红残影 punch→恒速追赶,与主角/BOSS HUD 条同一 HealthView 状态机)。
// 每敌一份视图,WeakMap 挂载:死亡敌人不再绘制即自然回收,无需手动清理。
// M12M13-ACCEPT 03轮 F9:计时推进与绘制分离——update 由 main 主循环按**实际 dt** 调用
// (暂停时不推进:主循环 paused 提前 return;此前在 render 内固定 1/60 按绘制次数计时,
// 帧率越高残影越快、暂停/低帧仍推进,违反时序契约),render 的 draw 只读当前状态。
const _enemyHv = new WeakMap();

// main 主循环每帧调用(与 hud.battleHud.update 同刻):按实际 dt 推进所有存活敌人血条残影
export function updateEnemyHealthViews(dt, battle, fxEnabled = true) {
  if (!battle || !Array.isArray(battle.enemies)) return 0;
  let n = 0;
  for (const e of battle.enemies) {
    if (!e || !e.alive) continue;
    let hv = _enemyHv.get(e);
    if (!hv) {
      hv = new HealthView({ main: '#e5484d', ghost: '#f4b4af' });
      hv.align(e.maxHp > 0 ? e.hp / e.maxHp : 1); // M12M13-ACCEPT 04轮 F10:align 直接初始化
      _enemyHv.set(e, hv);
    }
    hv.update(dt, e.maxHp > 0 ? e.hp / e.maxHp : 1, fxEnabled);
    n++;
  }
  return n;
}

// 只读查询(调试/单测):取敌人的血条视图(无则 null)——M12M13-ACCEPT 04轮 F10 行为回归用
export function enemyHealthViewOf(e) { return e ? _enemyHv.get(e) || null : null; }
import { LEVEL_META, WAVES_PER_LEVEL } from '../meta/levels.js'; // M11 UI 设计稿:关卡名/建议等级
import { expNeed, levelFromExp } from '../meta/exp.js'; // M11 选关/备战顶栏经验条

const ITEM_ICON = { heal: '❤', invincible: '✦', cd: '⏱' };
// M14 界面图标贴图(assets/icons/ui/*.png 替换 emoji;表初始空,生产唯一填充入口=bindImages;
// miss 时回退原 emoji 文字,不阻塞渲染)
const UI_IMG = {}; // M14 界面图标表(见上)
// M15 Task 51:开始界面生图产物表(初始空,生产唯一填充入口=bindImages)。
// 渲染回退仅覆盖「未绑定/未加载(complete=false)/解码失败(naturalWidth=0)」三种显示态→程序化兜底;
// 预载失败(文件缺失/持续网络失败)仍按 FR-9 在 main 停载,不进入开始界面——两口径勿混。
const START_IMG = { bg: null, logo: null };
// 需求方 2026-10-19:开始界面圆形可行走草地(主角站草圆顶原地行走,地形绕圆心自转=跑步机式)
// 贴图 1120×1120 显示 560×560(圆心 (360,1340) R=280);缺图回退程序化草圆(样板同款)
const MEADOW_IMG = { img: null };
// -07 Q4:草地圆几何常量提升模块级(原 drawStartScreen 每帧新建对象)+ 兜底渐变缓存
const MEADOW_CIRCLE = { x: 360, y: 1340, r: 280, spin: 0.12 };
let MEADOW_FALLBACK_GRAD = null; // 程序化兜底草面渐变(按目标 ctx 缓存,同 ctx 复用)
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
// 修复:模块求值期零加载(各表初始全空,自建加载仅发生在显式调用 ensureFallbackImages 时——
// 单测/未接 main 的演示环境);新增 bindImages(map)——main 预载
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
  for (let i = 0; i < 6; i++) {
    const img = map.get(`player:walk:${i + 1}`);
    if (img) { PLAYER_WALK_FRAMES[i] = img; n++; } // -07:开始界面原地跑步循环(walk 6 帧)
  }
  for (const [type, t] of Object.entries(ENEMY_TYPES)) {
    ENEMY_FRAMES[type] = []; // M11-03 F1:先初始化行数组——ENEMY_FRAMES 初始 {},直接 [type][j]=img 抛 TypeError(黑屏根因)
    t.frames.forEach((fn, j) => {
      const img = map.get(`${type}:${fn}`);
      if (img) { ENEMY_FRAMES[type][j] = img; n++; }
    });
  }
  for (const name of ['pause', 'settings', 'coin', 'pick', 'burn', 'slow', 'bind', 'stun']) {
    const img = map.get(`icon:ui:${name}`);
    if (img) { UI_IMG[name] = img; n++; } // M14:界面图标(替换 emoji)
  }
  // M15 Task 51:开始界面生图产物(全屏背景+定名 LOGO;缺图走程序化兜底)
  {
    const bg = map.get('ui:start_bg');
    if (bg) { START_IMG.bg = bg; n++; }
    const logo = map.get('ui:start_logo');
    if (logo) { START_IMG.logo = logo; n++; }
  }
  // 圆形可行走草地贴图(绕圆心自转;缺图程序化兜底)
  {
    const md = map.get('ui:meadow_circle');
    if (md) { MEADOW_IMG.img = md; n++; }
  }
  return n;
}
// 技能一句话说明(备战界面技能库行;03 文档 5.2 kind 口径)
const SKILL_BRIEF = {
  bolt: '单体弹', dotzone: '灼烧区域', chain: '连锁弹', bind: '束缚+持续伤害', multi: '多发弹',
  shield: '护盾', pulse: '脉冲环', field: '减速领域', aura: '回复光环',
};
// M11-06:元素中文名(tips/换装列表)
const ELEMENT_NAME = { fire: '火', water: '水', wood: '木', metal: '金', earth: '土' };
// M14:敌人中文名(关卡选择 chips 与备战信息卡敌人行;需求方口径 slime=幽灵)
const ENEMY_NAME = { slime: '幽灵', fox: '狐妖', zombie: '僵尸', snake: '蛇妖', tiger: '虎妖', boss: '妖王' };
// M11-03 F1:显式兜底入口(幂等)——把渲染消费的全部贴图按 manifest 同款路径自建加载。
// 仅限单测/无 main 的演示环境显式调用;生产路径唯一入口=bindImages(preload Map)。
export function ensureFallbackImages() {
  if (ensureFallbackImages._done) return ensureFallbackImages._done;
  const created = [];
  const mk = (url) => { const img = new Image(); img.src = url; created.push(img); return img; };
  for (const it of ['heal', 'invincible', 'cd']) {
    for (const suffix of ['', '_premium']) ITEM_IMG[it + suffix] = mk(new URL(`../../assets/icons/items/${it}${suffix}.png`, import.meta.url).href);
  }
  MEADOW_IMG.img = mk(new URL('../../assets/backgrounds/start/meadow_circle.png', import.meta.url).href);
  for (const el of ELEMENTS) GEM_IMG[el] = mk(new URL(`${el}.png`, GEM_DIR).href);
  for (const s of SKILL_LIBRARY) SKILL_IMG[s.id] = mk(new URL(`../../assets/icons/skills/${s.id}.png`, import.meta.url).href);
  for (let i = 1; i <= 16; i++) PLAYER_FRAMES.push(mk(new URL(`../../assets/sprites/player/idle_${String(i).padStart(2, '0')}.png`, import.meta.url).href));
  for (let i = 1; i <= 3; i++) PLAYER_ATK_FRAMES.push(mk(new URL(`../../assets/sprites/player/walk_start_${String(i).padStart(2, '0')}.png`, import.meta.url).href));
  for (let i = 1; i <= 6; i++) PLAYER_WALK_FRAMES.push(mk(new URL(`../../assets/sprites/player/walk_${String(i).padStart(2, '0')}.png`, import.meta.url).href));
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
const PLAYER_WALK_FRAMES = []; // 主角跑步循环 walk 6 帧(-07:开始界面原地跑;walk_start 差异微小视觉近似静止)
const ENEMY_FRAMES = {};       // 六类敌人序列帧(缺图椭圆兜底)
const seqFrame = (frames, t, fps) => frames[Math.floor(t * fps) % frames.length];

// M14:行内资产图标+数字(coin/pick 贴图;返回文字起点 x 供继续排布;miss 回退 emoji 文字)
// BEAUTIFY-01 F1(P1):y 语义=**图标顶边**(原按文字基线但调用处混传基线/顶部,战斗与养成
// 图标整体偏高 17~21px 出 chip);统一按 chip 中心对齐:顶边=chipY+(chipH-size)/2
function drawAssetIcon(ctx, key, emoji, x, y, size = 20) {
  const img = UI_IMG[key];
  if (img && img.complete && img.naturalWidth) {
    ctx.drawImage(img, x, y, size, size);
    return x + size + 6;
  }
  ctx.fillText(`${emoji} `, x, y + size - 3); // emoji 回退:基线≈顶边+size-3
  return x + ctx.measureText(`${emoji} `).width;
}


let worldT = 0; // 表现层动画时钟(按 render 回调实际 dt 推进,帧率无关;main 传 rAF 墙钟差 rdt)
// 只读探针(单测/CDP 验证时钟推进与帧率解耦)
export function animClock() { return worldT; }

// ===== BEAUTIFY-01 共享样式令牌(五屏同类组件单一来源;只收文字/材质色,命中区几何不变) =====
// 对比度(白底机械复算):ink 7.09 / primaryBtn 白字 5.20 / accentText 5.20 / sub 3.05(仅 20px+ 辅助说明)
const UI_STYLE = {
  ink: '#794f27',      // 正文深棕(全项目资产数字/标题统一)
  sub: '#9f927d',      // 次要说明
  dim: '#c4b89e',      // 弱化/禁用
  paper: '#f0e8d8',    // 纸面底(底栏/按钮 ghost)
  cardLine: '#dcd8d1', // 白卡描边
  chipLine: '#e8e2d6', // chip/浅卡描边
  primaryBtn: '#0e7a70', // 主按钮深青绿(白字对比 5.20:1;原 #19c8b9 白字仅 2.10:1)
  accentText: '#0e7a70', // 青绿文字(数值行;原 #19c8b9 文字同低对比)
};
// ===== BEAUTIFY -06 掉落表现(需求方 2026-10-19):怪物死亡掉落货币/材料 → 停留 →
// 二次贝塞尔曲线+拖尾飞向货币栏 chip → 图标 spring 放大回弹 + 数字滚动 + 金币音效 =====
// 表现与逻辑分离:真值先行入账(battle.coinsGained→profile 不变),显示值=已到账
// (dropBank disp 向「真值−在途」逼近);fx 关不生成且在途强制到账(终态收口)。
const dropBank = {
  coinDisp: null, matDisp: null,          // 显示值(向 base 滚动)
  coinBump: 0, matBump: 0,                // chip 图标 bump 计时(0.35s spring)
  coinAnchor: { x: 660, y: 12 }, matAnchor: { x: 700, y: 12 }, // chip 图标锚点(货币栏绘制每帧原地更新)
  coinArrive: 0, matArrive: 0,            // 到达计数器(main 轮询差值播金币音效)
  coinSfxPend: 0, matSfxPend: 0,          // -07 Q3:同帧多到达排队(每帧最多响一次,余量留到下帧)
};
const DROPS = Array.from({ length: 24 }, () => ({ active: false })); // 固定池(满则丢弃新掉落,不新建)
const TRAILS = Array.from({ length: 48 }, () => ({ active: false })); // 拖尾池
// 掉落物 value 登记表(-07 Q4:在途合计写模块级标量,不再每帧返回新对象)
let _infC = 0, _infM = 0;
function computeInflight() {
  _infC = 0; _infM = 0;
  for (const d of DROPS) if (d.active) { if (d.kind === 'coin') _infC += d.value; else _infM += d.value; }
}
// main 每帧喂真值:显示值向「真值−在途」滚动(时间常数型,帧率无关;与养成 chips 同机制)
// -07 Q3:dt=表现层实际经过时间(rdt)——暂停冻结;原误传模拟 dt(暂停期掉落继续飞)
export function syncDropBank(coins, mats, fxOn, dt) {
  computeInflight();
  const cBase = coins - _infC, mBase = mats - _infM;
  if (dropBank.coinDisp === null) { dropBank.coinDisp = cBase; dropBank.matDisp = mBase; }
  if (!fxOn) {
    resetDropPools();
    dropBank.coinDisp = coins; dropBank.matDisp = mats; // 关动效:清池强制到账(终态)
    dropBank.coinBump = 0; dropBank.matBump = 0; // -07 S1:回弹存量一并清零(否则 dt=0 时放大图标常驻)
  }
  else {
    dropBank.coinDisp = rollToward(dropBank.coinDisp, cBase, dt);
    dropBank.matDisp = rollToward(dropBank.matDisp, mBase, dt);
  }
  if (dropBank.coinBump > 0) dropBank.coinBump = Math.max(0, dropBank.coinBump - dt);
  if (dropBank.matBump > 0) dropBank.matBump = Math.max(0, dropBank.matBump - dt);
}
// -07 Q2:清池=清 DROPS/TRAILS/排队音效(跨局残留根因——原只清 disp/等飞行自然结束)
function resetDropPools() {
  for (const d of DROPS) d.active = false;
  for (const tr of TRAILS) tr.active = false;
  dropBank.coinSfxPend = 0; dropBank.matSfxPend = 0;
}
export function resetDropBank() {
  resetDropPools();
  dropBank.coinDisp = null; dropBank.matDisp = null;
  dropBank.coinBump = 0; dropBank.matBump = 0;
  dropBank.coinArrive = 0; dropBank.matArrive = 0;
}
// -07 Q4:到达计数改标量 getter(原返回新对象,main 每帧分配)
export function dropArriveCoin() { return dropBank.coinArrive; }
export function dropArriveMat() { return dropBank.matArrive; }
// 击杀掉落生成(kind 物携带 value;battle kill 事件→main 调用;-07 Q4 逐字段赋值不 Object.assign)
export function spawnCoinDrop(kind, value, x, y) {
  const slot = DROPS.find(d => !d.active);
  if (!slot) return; // 池满丢弃(表现层;数值已入账)
  slot.active = true; slot.kind = kind; slot.value = value; slot.x = x; slot.y = y - 20;
  slot.groundY = y + 24 + Math.random() * 18; // 落地点(敌心下方散布)
  slot.vx = (Math.random() - 0.5) * 140; slot.vy = -(150 + Math.random() * 90);
  slot.phase = 'drop'; slot.t = 0; slot.rest = 0.45 + Math.random() * 0.35; // 停留+错峰
  slot.sx = 0; slot.sy = 0; slot.cx = 0; slot.cy = 0; slot.tx = 0; slot.ty = 0; slot.trailT = 0;
}
// 每帧推进(表现层 dt;由 render 渲染路径在 fx 开且非暂停时调用——暂停冻结)
function updateCoinDrops(dt) {
  for (const d of DROPS) {
    if (!d.active) continue;
    if (d.phase === 'drop') { // 抛物线散落
      d.x += d.vx * dt; d.y += d.vy * dt; d.vy += 520 * dt;
      if (d.vy > 0 && d.y >= d.groundY) { d.y = d.groundY; d.phase = 'rest'; d.t = 0; }
    } else if (d.phase === 'rest') { // 地面停留+错峰
      d.t += dt;
      if (d.t >= d.rest) { // 起飞:锁定 chip 图标锚点为终点,二次贝塞尔控制点上拱
        const anc = d.kind === 'coin' ? dropBank.coinAnchor : dropBank.matAnchor;
        d.phase = 'fly'; d.t = 0;
        d.sx = d.x; d.sy = d.y;
        d.tx = anc.x + 10; d.ty = anc.y + 10;
        d.cx = (d.sx + d.tx) / 2 + (Math.random() - 0.5) * 120;
        d.cy = Math.min(d.sy, d.ty) - 130 - Math.random() * 70;
      }
    } else { // fly:ease-in-out 贝塞尔(调研口径 300~500ms→0.6s 屏内飞行)
      d.t += dt;
      const p = Math.min(1, d.t / 0.6);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const u = 1 - e;
      d.x = u * u * d.sx + 2 * u * e * d.cx + e * e * d.tx;
      d.y = u * u * d.sy + 2 * u * e * d.cy + e * e * d.ty;
      d.trailT += dt;
      if (d.trailT >= 0.03) { // 拖尾粒子(池 48;逐字段赋值不 Object.assign)
        d.trailT = 0;
        const tr = TRAILS.find(t2 => !t2.active);
        if (tr) { tr.active = true; tr.x = d.x; tr.y = d.y; tr.t = 0; tr.life = 0.25; tr.kind = d.kind; }
      }
      if (p >= 1) { // 到达:chip bump+到账计数+排队音效(main 每帧消费一次)+出池
        d.active = false;
        if (d.kind === 'coin') { dropBank.coinBump = 0.35; dropBank.coinArrive++; dropBank.coinSfxPend++; }
        else { dropBank.matBump = 0.35; dropBank.matArrive++; dropBank.matSfxPend++; }
      }
    }
  }
  for (const tr of TRAILS) {
    if (!tr.active) continue;
    tr.t += dt;
    if (tr.t >= tr.life) tr.active = false;
  }
}
// -07 Q3:音效排队消费(每帧最多取一个,同帧多到达逐帧补响=「每到达一次一响」;
// 返回常量字符串无分配:'coin'|'mat'|'none')
export function takeDropSfx() {
  if (dropBank.coinSfxPend > 0) { dropBank.coinSfxPend--; return 'coin'; }
  if (dropBank.matSfxPend > 0) { dropBank.matSfxPend--; return 'mat'; }
  return 'none';
}
function drawCoinDrops(ctx) {
  // 拖尾(渐隐小圆)
  for (const tr of TRAILS) {
    if (!tr.active || !_fxOn) continue;
    ctx.globalAlpha = (1 - tr.t / tr.life) * 0.5;
    ctx.fillStyle = tr.kind === 'coin' ? '#f5c31c' : '#b8b09e';
    ctx.beginPath(); ctx.arc(tr.x, tr.y, 5 * (1 - tr.t / tr.life) + 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // 掉落物本体(UI_IMG 贴图优先;miss 回退圆形)
  for (const d of DROPS) {
    if (!d.active) continue;
    const img = UI_IMG[d.kind === 'coin' ? 'coin' : 'pick'];
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, d.x - 9, d.y - 9, 18, 18);
    } else {
      ctx.fillStyle = d.kind === 'coin' ? '#f5c31c' : '#b8b09e';
      ctx.strokeStyle = '#794f27'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(d.x, d.y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
}
// 按钮按压反馈(BEAUTIFY -04 R2 整改):**归属在按下时确定**——setPressPoint 带 tag 仅在
// 按下时调用;移动跟随调 pressMove(只更新坐标,不重写 tag,跨屏移动不会在新界面重新绑定);
// 松手/取消/离开画布由 main 清除。tag 绑定「屏:浮层:养成页」身份——界面归属变化后作废;
// 关动效(fxEnabled=false)无按压视觉;固定单一状态,无每帧分配
let pressPt = null, pressTag = null;
let _ctxTag = '', _scrIn = 1; // render 入口每帧同步(当前「屏:浮层:养成页」tag 与入屏进度)
export function setPressPoint(p, tag) {
  pressPt = p ? { x: p.x, y: p.y } : null;
  pressTag = (p && tag) ? tag : null;
}
// 移动跟随:只更新坐标——tag 保持按下时的归属,不随当前界面重写(R2:导航后移动不得重新绑定)
export function pressMove(p) { if (pressPt && p) { pressPt.x = p.x; pressPt.y = p.y; } }
const isPressed = (r) => !!(_fxOn && pressPt && pressTag === _ctxTag
  && pressPt.x >= r.x && pressPt.x <= r.x + r.w && pressPt.y >= r.y && pressPt.y <= r.y + r.h);

// 浮层入场淡入(180ms;BEAUTIFY-01 F7;-03 B3 整改:render 每帧末尾检查——本帧无浮层绘制
// 即清空 ovFade.key,同一浮层**关闭后重开**会重新计时淡入,不再沿用旧起点直接终态;
// 关动效(fxEnabled=false)直接终态。退场不做:关闭=立即响应是既有验收口径(取舍记录于送审说明)
const ovFade = { key: null, t0: 0 };
let ovDrawnThisFrame = false;
let _fxOn = true; // render 入口每帧同步 engine.fxEnabled(fade/呼吸类动效关闭时直接终态)
function overlayIn(key) {
  if (ovFade.key !== key) { ovFade.key = key; ovFade.t0 = worldT; }
  ovDrawnThisFrame = true;
  return _fxOn ? Math.min(1, (worldT - ovFade.t0) / 0.18) : 1;
}
// 屏切换入屏层次(P3;BEAUTIFY-01 F12;-03 B3 整改:render 入口每帧调用(观察全部屏切换,
// 含 loadout 往返),进度存 _scrIn 供各屏绘制消费;0.3s 内 0→1;fx 关=直接 1
let scrFadeScr = null, scrFadeT0 = 0;
function screenIn(scr) {
  if (scrFadeScr !== scr) { scrFadeScr = scr; scrFadeT0 = worldT; }
  return _fxOn ? Math.min(1, Math.max(0, (worldT - scrFadeT0) / 0.3)) : 1;
}
let _ovA = 1; // 当前浮层 fade alpha(drawPickPanel 内层 alpha 需相乘)

export function render(ctx, engine, hud, dt = 1 / 60) {
  worldT += dt; // 需求方 2026-10-19:主角动画异常快——worldT 原按帧数固定 +1/60,高刷屏(120Hz+)下 2 倍速;改按渲染回调实际 dt 推进(帧率无关)
  ctx.clearRect(0, 0, 720, 1280);
  const battle = hud.battle;
  const px = hud.parallax;
  // BEAUTIFY-01 F3(P1):屏幕路由前置——开始/选关/备战/养成屏**不再绘制**被遮住的战斗区、
  // 棋盘与结算(此前先全绘再被覆盖;旧局结束后还会继续画被盖的结算与彩带)。
  // 只保留公共时钟 worldT 与置顶 toast;命中区几何零改动。
  const scr = hud.screen ? hud.screen() : 'playing';
  const inBattle = scr === 'playing';
  _fxOn = engine.fxEnabled !== false; // BEAUTIFY-01:动效开关同步(fade/呼吸/入屏直接终态)
  _scrIn = screenIn(scr); // BEAUTIFY -03 B3:每帧观察屏切换(含 loadout 往返),进度供各屏消费
  _ctxTag = `${scr}:${(hud.panel ? hud.panel() : '') ?? ''}:${hud.growPanel ? (hud.growPanel() ? 1 : 0) : 0}:${hud.paused ? (hud.paused() ? 1 : 0) : 0}`; // 按压态界面身份(屏:浮层:养成页:暂停;与 main tag 同源)

  if (inBattle) {
  // ===== 战斗区(FR-1.5 视差三层;screenshake/zoom pulse 变换) =====
  const tf = px ? px.transform() : { ox: 0, oy: 0, scale: 1 };
  ctx.save();
  ctx.translate(360 + tf.ox, 224 + tf.oy);
  ctx.scale(tf.scale, tf.scale);
  ctx.translate(-360, -224);
  if (px) px.draw(ctx);
  else drawFlatBackdrop(ctx);
  // M12 技能喊话背景层(z 序:场景 < 技能背景 < 敌人;战场变换内绘制,随 screenshake/pulse 联动)
  if (hud.fx && engine.fxEnabled !== false) hud.fx.drawCallBg(ctx);

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
      // 血条(Boss 另有 HUD 大血条,此处保留小血条)——M13 双血条:主条立即扣+淡红残影
      // 二段扣除(punch 0.4s→恒速 30%/s→1.2s 兜底,与 battle_hud 同一状态机;关动效直接同步)。
      // M12M13-ACCEPT 03轮 F9:推进在 updateEnemyHealthViews(main 按实际 dt),此处只绘制
      const bw = 80, bx = e.x - bw / 2, by = e.y - t.srcH * t.scale / 2 - 18;
      let hv = _enemyHv.get(e);
      if (!hv) {
        hv = new HealthView({ main: '#e5484d', ghost: '#f4b4af' });
        hv.align(e.maxHp > 0 ? e.hp / e.maxHp : 1); // F10:直接初始化(不走受击路径,无假残影)
        _enemyHv.set(e, hv);
      }
      hv.draw(ctx, bx, by, bw, 6);
      // 状态标记(03 文档 6.2b:4 种——灼烧🔥/减速❄/束缚🌿/眩晕💫;字段非零显示、清零消失;
      // M8 配色整改:颜色引用 GEM_SRC 单一定义源,与元素语义一致)
      // M14:状态标记改贴图(assets/icons/ui/;缺图回退 emoji 原样式)
      const markY = e.y - t.srcH * t.scale / 2 - 24;
      const drawMark = (cond, key, x, fallback, fill) => {
        if (!cond) return;
        const img = UI_IMG[key];
        if (img && img.complete && img.naturalWidth) ctx.drawImage(img, x - 11, markY - 11, 22, 22);
        else { ctx.fillStyle = fill; ctx.font = '16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(fallback, x, markY); ctx.textAlign = 'left'; }
      };
      drawMark(e.burn, 'burn', e.x + 30, '🔥', GEM_SRC.fire);
      drawMark(e.slowT > 0, 'slow', e.x - 38, '❄', GEM_SRC.water);
      drawMark(e.bindT > 0, 'bind', e.x - 57, '🌿', GEM_SRC.wood);
      drawMark(e.stunT > 0, 'stun', e.x - 19, '💫', GEM_SRC.earth);
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
  }
  ctx.restore(); // 视差/震动变换结束(联动栏与棋盘不参与 screenshake)
  // ===== 战斗区货币栏条带(需求方 2026-10-19:货币统一放在战斗区域更上一层,以货币栏
  // 形式显示货币/材料;底栏的第几关/击杀/货币行同步移除)=====
  // BEAUTIFY -06 掉落表现:chip 数字=**已到账值**(dropBank disp 向 base 滚动;真值先行入账,
  // 在途掉落不计数)——图标 bump 由掉落到达触发,数字滚动与到达同步。
  if (battle && battle.phase === 'FIGHTING' && hud.profile) {
    const prof = hud.profile();
    const TB = { x: 0, y: 0, w: 720, h: 44 };
    ctx.fillStyle = 'rgba(248,248,240,.96)';
    ctx.fillRect(TB.x, TB.y, TB.w, TB.h);
    ctx.strokeStyle = '#dac9a7'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(TB.x, TB.y + TB.h); ctx.lineTo(TB.x + TB.w, TB.y + TB.h); ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#794f27';
    ctx.font = FONT(21, 'bold');
    ctx.fillText('资产', 24, TB.y + 29);
    ctx.font = FONT(17); ctx.fillStyle = '#9f927d';
    ctx.fillText('战斗产出实时入账', 84, TB.y + 29);
    let cxr = 704; // 右缘
    for (const [val, icon, emoji, dispKey, bumpKey] of [[prof.materials, 'pick', '⛏', 'matDisp', 'matBump'], [prof.coins, 'coin', '💰', 'coinDisp', 'coinBump']]) {
      const bankV = dropBank[dispKey] === null ? val : dropBank[dispKey];
      const label = `${Math.round(bankV)}`;
      ctx.font = FONT(19, 'bold');
      const w = 64 + ctx.measureText(label).width;
      const x = cxr - w, y = TB.y + 4;
      ctx.fillStyle = '#fff';
      roundRect(ctx, x, y, w, 36, 16); ctx.fill();
      ctx.strokeStyle = '#dac9a7'; ctx.lineWidth = 2; roundRect(ctx, x, y, w, 36, 16); ctx.stroke();
      // 图标 bump(掉落到达:spring 放大→回弹,0.35s;-07 S1:关动效直接原尺寸,dt=0 不残留放大)
      const bp = dropBank[bumpKey];
      const iconScale = (_fxOn && bp > 0) ? 1 + 0.35 * Math.sin((1 - bp / 0.35) * Math.PI) : 1;
      drawAssetIcon(ctx, icon, emoji, x + 12 + (20 - 20 * iconScale) / 2, y + 8 + (20 - 20 * iconScale) / 2, 20 * iconScale);
      ctx.fillStyle = '#794f27';
      ctx.fillText(label, x + 40, y + 24);
      // 记录 chip 图标锚点(掉落飞行目标;每帧**原地更新**不新建,-07 Q4)
      const anch = dropBank[bumpKey === 'coinBump' ? 'coinAnchor' : 'matAnchor'];
      anch.x = x + 12; anch.y = y + 8;
      cxr = x - 10;
    }
    ctx.textAlign = 'left';
  }
  // 掉落表现推进与绘制(-07 Q3:表现层 rdt 推进[此处 dt 即渲染实际经过时间],fx 门控+
  // 暂停冻结[hud.paused 与 main 同源]——暂停掉落不再继续飞;关动效不推进,清池强制到账由
  // syncDropBank 处理。掉落物压在货币栏条带上)
  if (_fxOn && !(hud.paused && hud.paused() && battle && battle.phase === 'FIGHTING')) updateCoinDrops(dt);
  drawCoinDrops(ctx);
  // M13 战斗区 HUD(头像/二段血条/关卡名/BOSS 条/技能框/波次进度;draw 自带快照,只读;
  // 自 2026-10-19 起整体下移 44px,避让上方货币栏条带)
  if (hud.battleHud) hud.battleHud.draw(ctx, hud);

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
      const gx = g.c * CELL + CELL / 2, gy = BOARD_Y + g.r * CELL + CELL / 2; // M13
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
  // M12M13-ACCEPT F5:底栏范围=1168~1280(112px)全高铺底;此前只画 56px 致下半黑底
  ctx.fillStyle = '#f0e8d8';
  ctx.fillRect(0, 1168, 720, 112);
  ctx.strokeStyle = '#dcd8d1';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 1168); ctx.lineTo(720, 1168); ctx.stroke();
  // 需求方 2026-10-19:底栏的「第几关/击杀/消除」统计行与货币显示移除——关卡信息由战斗区
  // 顶部关卡名承载,资产由战斗区上方货币栏承载,底栏只保留 ⏸/⚙ 操作按钮
  // M11 底栏操作按钮(UI 设计稿 04:⏸ 暂停 / ⚙ 设置)
  drawIconBtn(ctx, UI.battle.pauseBtn, '⏸', 'pause');
  drawIconBtn(ctx, UI.battle.settingsBtn, '⚙', 'settings');

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

  // BEAUTIFY-01 F8:点选交换预选提示(main firstSel 只读转发;fx 关=静态框)
  // 细边框仅视觉,不改命中区;呼吸 alpha 随 worldT(帧率无关)
  {
    const fsel = hud.firstSel ? hud.firstSel() : null;
    if (fsel) {
      ctx.save();
      ctx.globalAlpha = _fxOn ? 0.55 + 0.3 * Math.sin(worldT * 5) : 0.85;
      ctx.strokeStyle = '#794f27';
      ctx.lineWidth = 3;
      roundRect(ctx, fsel.c * CELL + 4, BOARD_Y + fsel.r * CELL + 4, CELL - 8, CELL - 8, 12);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ===== 胜负结算(FR-1.4;UI 设计稿 05:横幅+统计卡+按钮组;M11 重做) =====
  if (battle && battle.phase === 'VICTORY') {
    drawResult(ctx, hud, battle, true, dt);
  } else if (battle && battle.phase === 'DEFEAT') {
    drawResult(ctx, hud, battle, false, dt);
  }
  } // ===== inBattle 结束(BEAUTIFY-01 F3:非战斗屏跳过战斗区/棋盘/结算绘制) =====

  // ===== M11 界面路由(UI 设计稿五屏;01 开始 / 02 选关 / 03 备战;scr 已在函数入口计算) =====
  if (scr === 'start') drawStartScreen(ctx, hud, dt);
  if (scr === 'menu') {
    drawMenuScreen(ctx, hud);
    if (hud.growPanel && hud.growPanel()) drawGrowPanel(ctx, hud, dt); // FR-10 养成面板(选关入口,保留)
  }
  if (scr === 'loadout') drawLoadoutScreen(ctx, hud);
  if (scr === 'playing' && hud.paused && hud.paused() && battle && battle.phase === 'FIGHTING') {
    drawPauseOverlay(ctx, hud); // M11 暂停
  }
  if (scr === 'start' || scr === 'menu' || scr === 'loadout' || (scr === 'playing' && hud.paused && hud.paused())) {
    // BEAUTIFY-01 F7:浮层入场 180ms 淡入(fx 关=直接终态;退场维持「点按即关」不延迟)
    if (hud.panel && hud.panel() === 'settings') { ctx.save(); ctx.globalAlpha = _ovA = overlayIn('settings'); drawSettingsPanel(ctx, hud); ctx.restore(); }
    if (hud.panel && hud.panel() === 'about') { ctx.save(); ctx.globalAlpha = _ovA = overlayIn('about'); drawAboutPanel(ctx, hud); ctx.restore(); }
  }

  // 事件提示浮层(需求方 2026-10-19:绘制移到所有界面/面板**之后**——toast 被养成/备战
  // 面板盖住导致「点了没提示」;现置顶可见。文字居中显式设置)
  // BEAUTIFY -03 B3:本帧无浮层绘制→清空 fade 键(下次打开重新计时淡入)
  if (!ovDrawnThisFrame) ovFade.key = null;
  ovDrawnThisFrame = false;
  if (hud.toast && hud.toast.t > 0) {
    ctx.fillStyle = 'rgba(121,79,39,.85)';
    roundRect(ctx, 180, 160, 360, 44, 12);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = "20px 'Nunito','Noto Sans SC',sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText(hud.toast.text, 360, 189);
    ctx.textAlign = 'left';
  }
}

// ===== 养成界面 v2(06-grow.html 样板实装;M15)=====
// 布局常量:货币栏 h96 / 角色卡 32,126,656×290 / 技能网格 32,446,656×520(两列 4 行,行高 108) /
// 抽卡 160,1000,400×110 / 返回按钮位置由 GROW_LAYOUT.closeBtn 定义——与 main.handleGrowClick 命中区单一来源
export const GROW_LAYOUT = {
  listY: 506, rowH: 108, cols: [56, 369], cardW: 295, cardH: 96,
  // 技能列表可见区(F1-03 整改:统一视口定义——绘制 clip/拖拽起手/点击点限制三处共用
  // listTop/listBottom 这对常量,命中与裁切同源;listTop=500/listBottom=940)
  listTop: 500, listBottom: 940,
  btnW: 96, btnH: 64, btnOff: 183, // 升级按钮=卡内右侧(x0+183, y+16);名字区留 83px(F6 整改:四字技能名不再被按钮覆盖)
  upBtn: { x: 436, y: 320, w: 230, h: 76 },
  gachaBtn: { x: 160, y: 1000, w: 400, h: 110 },
  closeBtn: { x: 24, y: 20, w: 80, h: 70 }, // 返回=顶部左上,与选关/备战同款(需求方 2026-10-19:风格统一)
};
// 养成动效状态(模块级;main 经 grow*Fx 触发,drawGrowPanel 每帧推进)
const growAnim = {
  coinDisp: null, matDisp: null,          // 货币显示值(向真实值逐步逼近=滚动)
  flash: { coin: 0, mat: 0 },             // 扣除横抖计时(红闪已按需求方 2026-10-19 口径移除)
  lvBounceT: 0,                            // Lv 徽章弹跳计时(0.6s overshoot)
  burstT: 0, sparks: [],                   // 升级光柱+金粒
  floats: [],                              // 属性冒字(+12HP 等)
  skillPop: {},                            // 技能按钮 pop 计时(key=col*8+row)
  gacha: null,                             // 抽卡浮层 {skillId, name, el, t}
  statGlowT: 0,                            // BEAUTIFY-01 F10:HP/ATK 数值行高光计时(0.6s;升级后金色渐隐)
  tipsId: null,                            // 技能说明浮层(需求方 2026-10-19:单击行卡图标看描述;点任意处关闭)
  listScroll: 0, listMax: 0,               // 技能列表滚动偏移/上限(drawGrowPanel 每帧按拥有数复算,F1 整改)
};
export function growDeductFx(kind) { if (growAnim.flash[kind] !== undefined) growAnim.flash[kind] = 0.45; }
export function growLevelUpFx() { growAnim.lvBounceT = 0.6; growAnim.burstT = 0.8; growAnim.statGlowT = 0.6; } // BEAUTIFY-01 F10:数值行同步高光
export function growSkillUpFx(col, row) { growAnim.skillPop[col * 8 + row] = 0.35; }
// 技能说明浮层(需求方 2026-10-19:养成技能行卡单击图标=看描述;点任意处关闭,与备战 tips 同口径)
export function growTipsShow(skillId) { growAnim.tipsId = skillId; }
export function growTipsVisible() { return !!growAnim.tipsId; }
export function growTipsDismiss() { growAnim.tipsId = null; }
export function growGachaFx(skillId) {
  const sk = skillById(skillId);
  growAnim.gacha = { skillId, name: sk ? sk.name : skillId, el: sk ? sk.el : 'metal', t: 0 };
}
// F2 整改:抽卡浮层可见性/关闭(main 命中路由先于此拦截,浮层期间点击不透传背后按钮)
export function growGachaVisible() { return !!growAnim.gacha; }
export function growGachaDismiss() { growAnim.gacha = null; }
// F1 整改:技能列表滚动状态(main 拖拽滚动经此读写;上限由 drawGrowPanel 每帧复算)
export function growListScrollState() { return { scroll: growAnim.listScroll, max: growAnim.listMax }; }
// M15 Task 51:开始界面生图产物绑定状态(只读;CDP 验证预载→绑定,缺图走程序化兜底)
export function startImagesBound() { return { bg: !!START_IMG.bg, logo: !!START_IMG.logo }; }
export function growListScrollTo(v) { growAnim.listScroll = Math.max(0, Math.min(growAnim.listMax, v)); }
export function growFloatText(text, x, y, color = '#3f9b0f') { growAnim.floats.push({ text, x, y, color, t: 0, life: 1.0 }); }

// 滚动纯函数(UIV2-02 F2 整改:时间常数型浮点逼近,帧率无关——同壁钟时间点的显示值相同,
// 不随帧率变化;内部值保留浮点,绘制时取整;收敛阈 0.5=取整显示已达目标值)
export function rollToward(cur, target, dt, k = 8.4) {
  const nv = cur + (target - cur) * (1 - Math.exp(-dt * k));
  return Math.abs(target - nv) < 0.5 ? target : nv;
}

function drawGrowPanel(ctx, hud, dt = 1 / 60) {
  const prof = hud.profile();
  // 背景与货币栏(v2 全屏化)
  ctx.fillStyle = '#f8f8f0'; ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = '#e6f9f6'; ctx.fillRect(0, 0, 720, 96);
  ctx.strokeStyle = '#e8e2d6'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, 96); ctx.lineTo(720, 96); ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#794f27'; ctx.font = FONT(38, 'bold');
  ctx.fillText('养 成', 124, 68); // 标题与 drawTopBar 同款(返回按钮让位左侧)
  // 货币 chips(显示值逐步逼近=滚动;需求方 2026-10-19:扣除不做红色数字/红底,
  // 正常数字滚动+轻横抖即可;F6 整改:右对齐排布,宽度随数字自适应不重叠不越缘)
  const chipY = 24, chipH = 48, chipRight = 692;
  const chips = [];
  for (const [kind, val, icon] of [['coin', prof.coins, 'coin'], ['mat', prof.materials, 'pick']]) {
    const dispKey = kind === 'coin' ? 'coinDisp' : 'matDisp';
    if (growAnim[dispKey] === null) growAnim[dispKey] = val;
    const cur = growAnim[dispKey];
    if (cur !== val) { // 滚动:时间常数型浮点逼近(rollToward 纯函数,UIV2-02 F2 整改:帧率无关)
      growAnim[dispKey] = rollToward(cur, val, dt);
    }
    const label = `${Math.round(growAnim[dispKey])}`;
    ctx.font = FONT(24, 'bold');
    chips.push({ kind, icon, label, w: 92 + ctx.measureText(label).width });
  }
  chips[chips.length - 1].x = chipRight - chips[chips.length - 1].w; // 材料 chip 贴右缘
  chips[0].x = chips[1].x - 12 - chips[0].w;                          // 金币 chip 在其左 12px
  for (const c of chips) {
    const fl = growAnim.flash[c.kind];
    const shake = fl > 0 ? Math.sin(fl * 60) * 3 : 0;
    ctx.fillStyle = '#fff';
    roundRect(ctx, c.x + shake, chipY, c.w, chipH, 22); ctx.fill();
    ctx.strokeStyle = '#e8e2d6'; ctx.lineWidth = 2; roundRect(ctx, c.x + shake, chipY, c.w, chipH, 22); ctx.stroke();
    drawAssetIcon(ctx, c.icon, c.kind === 'coin' ? '💰' : '⛏', c.x + shake + 14, chipY + 12, 24); // 顶边:图标中心=chip 中心(chipY+24)
    ctx.fillStyle = '#794f27';
    ctx.fillText(c.label, c.x + shake + 48, chipY + 32);
  }
  // 角色卡
  ctx.fillStyle = '#fff';
  roundRect(ctx, 32, 126, 656, 290, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, 32, 126, 656, 290, 24); ctx.stroke();
  // 升级光柱(卡内底层)+金粒
  if (growAnim.burstT > 0) {
    const p = 1 - growAnim.burstT / 0.8;
    ctx.save();
    ctx.globalAlpha = p < 0.5 ? 1 : (1 - p) * 2;
    const grd = ctx.createLinearGradient(0, 126, 0, 416);
    grd.addColorStop(0, 'rgba(255,215,110,0)');
    grd.addColorStop(1, 'rgba(255,215,110,0.55)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(511 - 40 * (0.3 + p), 126); ctx.lineTo(511 + 40 * (0.3 + p), 126);
    ctx.lineTo(511 + 90, 416); ctx.lineTo(511 - 90, 416);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  for (const sp of growAnim.sparks) {
    ctx.globalAlpha = Math.max(0, 1 - sp.t / sp.life);
    ctx.fillStyle = sp.color;
    ctx.beginPath(); ctx.arc(sp.x + sp.vx * sp.t, sp.y + sp.vy * sp.t - 60 * sp.t, sp.size, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  // 立绘框(idle 首帧,等比 contain 不变形;缺图灰底;需求方 2026-10-19:立绘变形整改)
  ctx.fillStyle = '#efe9db'; roundRect(ctx, 52, 146, 210, 250, 16); ctx.fill();
  const pf0 = PLAYER_FRAMES[0];
  if (pf0 && pf0.complete && pf0.naturalWidth > 0) {
    ctx.save(); roundRect(ctx, 52, 146, 210, 250, 16); ctx.clip();
    drawPortrait(ctx, pf0, 52, 146, 210, 250, true);
    ctx.restore();
  } else {
    ctx.fillStyle = '#9f927d'; ctx.font = FONT(20); ctx.textAlign = 'center';
    ctx.fillText('主角立绘', 157, 275); ctx.textAlign = 'left';
  }
  // Lv 文本(升级时弹跳 overshoot 保留在文字上;黄色圆形徽章已按需求方 2026-10-19 移除)
  {
    const bt = growAnim.lvBounceT > 0 ? 1 - growAnim.lvBounceT / 0.6 : 1;
    let sc = 1;
    if (bt < 1) { sc = bt < 0.35 ? 1 + (bt / 0.35) * 0.35 : bt < 0.7 ? 1.35 - ((bt - 0.35) / 0.35) * 0.43 : 0.92 + ((bt - 0.7) / 0.3) * 0.08; }
    ctx.save();
    ctx.translate(288, 190); ctx.scale(sc, sc);
    ctx.fillStyle = '#794f27'; ctx.font = FONT(34, 'bold');
    ctx.fillText(`Lv.${prof.level}`, 0, 0);
    ctx.restore();
  }
  // BEAUTIFY-01 F10:升级后 0.6s 内 HP/ATK 数值行金色高光渐隐(fx 关=直接终态无高光)
  const sg = _fxOn && growAnim.statGlowT > 0 ? growAnim.statGlowT / 0.6 : 0; // _fxOn 由 render 入口每帧同步(drawGrowPanel 无 engine 作用域)
  ctx.fillStyle = sg > 0 ? mixHex('#794f27', '#f5a623', sg) : '#794f27'; // F5 整改(UIV2-02):显式恢复深色(升级瞬间向金过渡)
  ctx.font = FONT(23);
  ctx.fillText(`HP ${maxHpText(prof.level)}`, 288, 232);
  ctx.fillStyle = sg > 0 ? mixHex('#794f27', '#f5a623', sg) : '#794f27'; // 血条移除(需求方 2026-10-19:与备战主角卡样式一致,数值保留)
  ctx.fillText(`ATK ${atkText(prof.level)}`, 288, 270);
  ctx.font = FONT(20); ctx.fillStyle = '#9f927d';
  ctx.fillText(`升级消耗材料:${levelUpCost(prof.level)}`, 288, 308);
  // 升级按钮(右下;材料不足灰;需求方 2026-10-19:黄色圆形等级徽章移除)
  const upCost = levelUpCost(prof.level);
  drawBtn(ctx, GROW_LAYOUT.upBtn, '升 级', prof.materials >= upCost ? 'primary' : 'disabled', 26);
  // 技能网格(白卡;标题行 F5 整改:标题居左,计数右对齐贴卡右缘,不再同行拥挤出框)
  ctx.fillStyle = '#fff'; roundRect(ctx, 32, 446, 656, 520, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, 32, 446, 656, 520, 24); ctx.stroke();
  ctx.fillStyle = '#794f27'; ctx.font = FONT(28, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText('技能升级', 56, 492);
  ctx.font = FONT(20); ctx.fillStyle = '#9f927d'; ctx.textAlign = 'right';
  ctx.fillText(`已拥有 ${prof.ownedSkills.length} / ${SKILL_LIBRARY.length}`, 664, 490);
  ctx.textAlign = 'left';
  const L = GROW_LAYOUT;
  // 纵向滚动(06 样板口径;UIV2-01 F1 整改:全部已拥有技能可见可升级,不再截断前 8)
  const totalRows = Math.ceil(prof.ownedSkills.length / 2);
  growAnim.listMax = Math.max(0, totalRows * L.rowH - (L.listBottom - L.listTop));
  growAnim.listScroll = Math.max(0, Math.min(growAnim.listMax, growAnim.listScroll));
  ctx.save();
  roundRect(ctx, 32, L.listTop, 656, L.listBottom - L.listTop, 16); ctx.clip(); // 列表可见区(F1-03:与拖拽/点击共用 listTop/listBottom)
  for (let idx = 0; idx < prof.ownedSkills.length; idx++) {
    const col = idx % 2, row = Math.floor(idx / 2);
    const y0 = L.listY + row * L.rowH - growAnim.listScroll;
    if (y0 + L.cardH < L.listTop || y0 > L.listBottom) continue; // 视口外不画(与拖拽/点击共用同一对常量)
    const id = prof.ownedSkills[idx];
    const skill = skillById(id);
    const lv = prof.skillLevels[id] || 1;
    const x0 = L.cols[col];
    ctx.fillStyle = '#fff';
    roundRect(ctx, x0, y0, L.cardW, L.cardH, 16); ctx.fill();
    ctx.strokeStyle = '#e8e2d6'; ctx.lineWidth = 2; roundRect(ctx, x0, y0, L.cardW, L.cardH, 16); ctx.stroke();
    // 图标:技能贴图优先(与备战槽同源;需求方 2026-10-19:不用元素色圆),缺图回退色圆
    const img = SKILL_IMG[id];
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, x0 + 14, y0 + 16, 64, 64);
    } else {
      ctx.fillStyle = GEM_SRC[skill && skill.el] || '#ccc'; // BEAUTIFY-01 F5:引用共享元素色表(原 WX 旧五色)
      ctx.beginPath(); ctx.arc(x0 + 46, y0 + 48, 32, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#333'; ctx.font = FONT(24, 'bold'); ctx.textAlign = 'center';
      ctx.fillText(ELEMENT_NAME[skill && skill.el] || '?', x0 + 46, y0 + 56);
      ctx.textAlign = 'left';
    }
    // 名+等级(F6 整改:名字区实宽 83px=到升级按钮左缘-8,四字名 20px 恰好放下)
    ctx.fillStyle = '#794f27'; ctx.font = FONT(20, 'bold');
    ctx.fillText(fitText(ctx, skill ? skill.name : id, L.btnOff - 92 - 8), x0 + 92, y0 + 38);
    ctx.font = FONT(18); ctx.fillStyle = '#9f927d';
    ctx.fillText(`Lv.${lv}${lv >= SKILL_LEVEL_CAP ? ' 满' : ''}`, x0 + 92, y0 + 66);
    // 升级按钮(pop 动效=放大)
    if (lv < SKILL_LEVEL_CAP) {
      const sc0 = growAnim.skillPop[col * 8 + row] || 0;
      const pop = sc0 > 0 ? 1 + Math.sin((1 - sc0 / 0.35) * Math.PI) * 0.15 : 1;
      const bx = x0 + L.btnOff + (L.btnW * (1 - pop)) / 2, by = y0 + 16 + (L.btnH * (1 - pop)) / 2;
      const afford = prof.materials >= skillUpCost(lv);
      ctx.fillStyle = afford ? '#7ba86f' : '#c4b89e';
      roundRect(ctx, bx, by, L.btnW * pop, L.btnH * pop, 14); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = FONT(21, 'bold'); ctx.textAlign = 'center';
      ctx.fillText(`-${skillUpCost(lv)}`, bx + (L.btnW * pop) / 2, by + (L.btnH * pop) / 2 + 8);
      ctx.textAlign = 'left';
    } else {
      ctx.fillStyle = '#c4b89e';
      roundRect(ctx, x0 + L.btnOff, y0 + 16, L.btnW, L.btnH, 14); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = FONT(19, 'bold'); ctx.textAlign = 'center';
      ctx.fillText('已满级', x0 + L.btnOff + L.btnW / 2, y0 + 16 + L.btnH / 2 + 7);
      ctx.textAlign = 'left';
    }
  }
  ctx.restore();
  // 滚动条(列表右缘;有溢出才显示)
  if (growAnim.listMax > 0) {
    const trackH = L.listBottom - L.listTop;
    const thumbH = Math.max(44, trackH * (trackH / (totalRows * L.rowH)));
    const thumbY = L.listTop + (trackH - thumbH) * (growAnim.listScroll / growAnim.listMax);
    ctx.fillStyle = '#c4b89e';
    roundRect(ctx, 668, thumbY, 8, thumbH, 4); ctx.fill();
  }
  // 抽卡+返回(返回=顶栏同款 ghost)
  const poolFull = prof.ownedSkills.length >= SKILL_LIBRARY.length;
  drawBtn(ctx, GROW_LAYOUT.gachaBtn, poolFull ? '技能已集齐' : '✦ 抽卡 · 100 币/次', poolFull ? 'disabled' : 'warn', 30);
  drawBtn(ctx, GROW_LAYOUT.closeBtn, '←', 'ghost', 30);
  // 属性冒字(+12HP 等);-04 R4:关动效不绘制存量冒字(与战斗侧「停止绘制存量粒子/冒字」同口径)
  if (_fxOn) for (const f of growAnim.floats) {
    const pr = f.t / f.life;
    ctx.globalAlpha = pr < 0.25 ? pr / 0.25 : 1 - (pr - 0.25) / 0.75;
    ctx.fillStyle = f.color; ctx.font = FONT(28, 'bold'); ctx.textAlign = 'center';
    ctx.fillText(f.text, f.x, f.y - pr * 56);
    ctx.textAlign = 'left';
  }
  ctx.globalAlpha = 1;
  // 抽卡浮层(新技能登场;2.4s 自动消失)
  // 技能说明浮层(需求方 2026-10-19:单击行卡图标打开;点任意处关闭;版式与备战 tips 同源)
  if (growAnim.tipsId) {
    const sk = skillById(growAnim.tipsId);
    if (sk) {
      ctx.save(); ctx.globalAlpha = _ovA = overlayIn(`growTips:${growAnim.tipsId}`); // BEAUTIFY-01 F7
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, 720, 1280);
      const lv = prof.skillLevels?.[sk.id] || 1;
      ctx.fillStyle = '#fff';
      roundRect(ctx, 90, 420, 540, 400, 24); ctx.fill();
      ctx.strokeStyle = '#19c8b9'; ctx.lineWidth = 4;
      roundRect(ctx, 90, 420, 540, 400, 24); ctx.stroke();
      const img = SKILL_IMG[sk.id];
      ctx.fillStyle = '#f0e8d8';
      roundRect(ctx, 118, 448, 110, 110, 16); ctx.fill();
      if (img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, 126, 456, 94, 94);
      else {
        ctx.fillStyle = GEM_SRC[sk.el];
        ctx.beginPath(); ctx.arc(173, 503, 42, 0, Math.PI * 2); ctx.fill();
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = '#794f27';
      ctx.font = FONT(34, 'bold');
      ctx.fillText(sk.name, 252, 492);
      ctx.font = FONT(22);
      ctx.fillStyle = '#9f927d';
      ctx.fillText(`Lv.${lv} · ${ELEMENT_NAME[sk.el] || sk.el} · CD ${sk.cd}s · 养成面板`, 252, 528);
      ctx.font = FONT(24);
      ctx.fillStyle = '#5a4a32';
      wrapText(ctx, skillDetailText(sk), 118, 606, 484, 34);
      const vline = skillValueLine(sk, atkText(prof.level), maxHpText(prof.level));
      ctx.font = FONT(20);
      ctx.fillStyle = '#9f927d';
      ctx.fillText(`${vline.label}(${vline.formula}):`, 118, 682);
      ctx.font = FONT(22, 'bold');
      ctx.fillStyle = UI_STYLE.accentText; // BEAUTIFY-01 F2:文字对比 2.10→5.20
      ctx.fillText(vline.text, 118, 716);
      ctx.font = FONT(19);
      ctx.fillStyle = '#c4b89e';
      ctx.textAlign = 'center';
      ctx.fillText('点按任意处关闭', 360, 796);
      ctx.restore(); // BEAUTIFY-01 F7 fade 结束
    }
  }
  if (growAnim.gacha) {
    const g = growAnim.gacha;
    g.t += dt; // F4 整改:真实经过时间(不再按 1/60 假设,帧率无关)
    if (g.t > 2.4) growAnim.gacha = null;
    else {
      const inP = Math.min(1, g.t / 0.4);
      const sc = 0.4 + 0.6 * (1 - Math.pow(1 - inP, 3)) + (inP >= 1 ? Math.sin((g.t - 0.4) * 6) * 0.03 : 0);
      ctx.save();
      ctx.fillStyle = 'rgba(20,22,15,.5)';
      ctx.fillRect(0, 0, 720, 1280);
      ctx.translate(360, 560); ctx.scale(sc, sc);
      ctx.fillStyle = '#fff';
      roundRect(ctx, -190, -220, 380, 440, 24); ctx.fill();
      ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, -190, -220, 380, 440, 24); ctx.stroke();
      ctx.fillStyle = '#f5c31c'; ctx.font = FONT(26, 'bold'); ctx.textAlign = 'center';
      ctx.fillText('✦ 获得新技能 ✦', 0, -160);
      // BEAUTIFY-01 F5:正式结果优先画技能图标(与技能库/备战同源);缺图回退元素色圆
      const gimg = SKILL_IMG[g.skillId];
      if (gimg && gimg.complete && gimg.naturalWidth > 0) {
        ctx.fillStyle = '#f0e8d8';
        ctx.beginPath(); ctx.arc(0, -40, 76, 0, Math.PI * 2); ctx.fill();
        ctx.drawImage(gimg, -62, -102, 124, 124);
      } else {
        ctx.fillStyle = GEM_SRC[g.el] || '#ccc';
        ctx.beginPath(); ctx.arc(0, -40, 70, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#333'; ctx.font = FONT(52, 'bold');
        ctx.fillText(ELEMENT_NAME[g.el] || '?', 0, -22);
      }
      ctx.fillStyle = '#794f27'; ctx.font = FONT(30, 'bold');
      ctx.fillText(g.name, 0, 80);
      ctx.font = FONT(20); ctx.fillStyle = '#9f927d';
      ctx.fillText('自动装配进技能库 · 消除链可随机选中', 0, 118);
      ctx.restore();
      ctx.textAlign = 'left';
    }
  }
  // 动效计时推进(真实 dt,帧率无关;面板不显示时不推进)
  for (const k of ['coin', 'mat']) if (growAnim.flash[k] > 0) growAnim.flash[k] = Math.max(0, growAnim.flash[k] - dt);
  if (growAnim.lvBounceT > 0) growAnim.lvBounceT = Math.max(0, growAnim.lvBounceT - dt);
  if (growAnim.statGlowT > 0) growAnim.statGlowT = Math.max(0, growAnim.statGlowT - dt); // BEAUTIFY-01 F10
  if (growAnim.burstT > 0) {
    growAnim.burstT = Math.max(0, growAnim.burstT - dt);
    if (growAnim.sparks.length < 24 && Math.random() < 0.5) {
      const colors = ['#ffd76e', '#fff3c4', '#f5a623'];
      growAnim.sparks.push({ x: 511 + (Math.random() - 0.5) * 320, y: 200 + Math.random() * 140, vx: (Math.random() - 0.5) * 120, vy: -60 - Math.random() * 80, t: 0, life: 0.7 + Math.random() * 0.4, size: 4 + Math.random() * 4, color: colors[Math.floor(Math.random() * 3)] });
    }
  }
  for (const sp of growAnim.sparks) sp.t += dt;
  growAnim.sparks = growAnim.sparks.filter(sp => sp.t < sp.life);
  for (const f of growAnim.floats) f.t += dt;
  growAnim.floats = growAnim.floats.filter(f => f.t < f.life);
  for (const k of Object.keys(growAnim.skillPop)) {
    growAnim.skillPop[k] -= dt;
    if (growAnim.skillPop[k] <= 0) delete growAnim.skillPop[k];
  }
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

// 立绘等比 contain 绘制(需求方 2026-10-19:直接拉伸填框导致主角变形——按原图比例
// 缩放到恰好放进 w×h 框内并居中;flip=水平镜像)
function drawPortrait(ctx, img, x, y, w, h, flip = false) {
  const iw = img.naturalWidth || 1, ih = img.naturalHeight || 1;
  const s = Math.min(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
  if (flip) drawFlipH(ctx, img, dx, dy, dw, dh);
  else ctx.drawImage(img, dx, dy, dw, dh);
}

// 文本超宽截断(换装列表行描述,给右侧数值列留宽)
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

function drawEnemy(ctx, e, t, scale) {
  // M11-04:表空(单测/兜底路径未 bindImages)→ 走椭圆兜底,不再让 seqFrame 吃 undefined
  const frames = ENEMY_FRAMES[e.name] || ENEMY_FRAMES.slime;
  const hasFrames = Array.isArray(frames) && frames.length > 0;
  // 攻击动画:开火后 animDur 内按 2×fps 单次正播;其余时间按原 fps 慢速循环(待机)
  let f = null;
  if (hasFrames) {
    if (e.attackAnimT > 0 && e.animDur > 0) {
      const p = 1 - e.attackAnimT / e.animDur;
      f = frames[Math.min(frames.length - 1, Math.floor(p * frames.length))];
    } else {
      // M8-F1:待机帧用受击者自身动画时钟 e.animClock(enemy 构造初始化、update 非冻结帧累积,
      // 卡肉期不推进→待机帧定格;取代全局 worldT——REQ-M8-02 F1:构造即初始化,无回退分支)
      f = seqFrame(frames, e.animClock + e.y, t.fps);
    }
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
    // 需求方 2026-10-19:下方为圆形可行走草地+主角原地行走(草顶 1060,主角 1064..1384→头 744),
    // 按钮上移到中部让位(命中区单一来源,main 同步)
    playBtn: { x: 160, y: 600, w: 400, h: 100 },
    settingsBtn: { x: 160, y: 724, w: 190, h: 86 },
    aboutBtn: { x: 370, y: 724, w: 190, h: 86 },
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
    // v2(03-loadout.html 样板):主角面板+出战信息窄卡+4 大槽(140)+底部换装抽屉;技能库列表移除
    heroCard: { x: 32, y: 140, w: 656, h: 300 },
    infoCard: { x: 32, y: 470, w: 656, h: 150 },
    panelY: 660, slotsY: 760, slotSize: 128, slotGap: 32, // 4 槽:x0=56,步进 160(4×128+3×32=608;面板 656 内左右各留 24px——需求方 2026-10-19:槽框不再贴面板两边)
    fightBtn: { x: 160, y: 1050, w: 400, h: 120 },
    // 换装抽屉(底部;两列 6 行;关闭按钮在面板内右上——需求方 2026-10-19:超框/居中整改)
    pickTop: 560, pickRowH: 84, pickCloseBtn: { x: 528, y: 584, w: 120, h: 64 },
  },
  battle: {
    pauseBtn: { x: 96, y: 134, w: 56, h: 44 },     // 需求方 2026-10-19:移到主角血条正下方(战斗区内;血条因货币栏条带下移 44px)
    settingsBtn: { x: 158, y: 134, w: 56, h: 44 }, // 同上(与 ⏸ 并排;原底栏位废弃)
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
    bgmBtn: { x: 210, y: 580, w: 300, h: 60 },   // M14:音乐开关(需求方 2026-10-18)
    sfxBtn: { x: 210, y: 650, w: 300, h: 60 },
    fxBtn: { x: 210, y: 720, w: 300, h: 60 },
    quitBtn: { x: 210, y: 790, w: 300, h: 80 },
  },
  settings: {
    panel: { x: 110, y: 400, w: 500, h: 460 },
    bgmBtn: { x: 160, y: 480, w: 400, h: 80 },   // M14:音乐开关
    sfxBtn: { x: 160, y: 570, w: 400, h: 80 },
    fxBtn: { x: 160, y: 660, w: 400, h: 80 },
    closeBtn: { x: 260, y: 770, w: 200, h: 60 },
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
  x: 56 + i * (UI.loadout.slotSize + UI.loadout.slotGap),
  y: UI.loadout.slotsY, w: UI.loadout.slotSize, h: UI.loadout.slotSize,
});
// M11-06:槽右上角「更换」按钮(双环形箭头)命中区——先于槽选中判定
export const uiSlotSwapBtn = (i) => {
  const sr = uiSlotRect(i);
  return { x: sr.x + UI.loadout.slotSize - 34, y: sr.y + 4, w: 30, h: 30 };
};
// M11-06:换装列表行(过滤已装配;渲染与 main 命中共用同一过滤与矩形)
// 返回 [{sk, idx(全表索引), rect, unlocked}];ownedSkills/unlockLevel 门控与技能库口径一致
export const uiPickRows = (loadout, ownedSkills, level) => {
  const rows = [];
  SKILL_LIBRARY.forEach((sk, idx) => {
    if ((loadout || []).includes(sk.id)) return; // 已装配:不显示(需求口径)
    const r = uiPickRowRect(rows.length);
    rows.push({ sk, idx, rect: r, unlocked: sk.unlockLevel <= (level || 1) && (ownedSkills || []).includes(sk.id) });
  });
  return rows;
};
const uiPickRowRect = (row) => {
  // v2 底部抽屉:两列 6 行(列 x=60/370,行起 664;15 技能去已装配 ≤11 行全可见)
  const col = Math.floor(row / 6), rr = row % 6;
  return { x: 60 + col * 310, y: UI.loadout.pickTop + 104 + rr * UI.loadout.pickRowH, w: 290, h: UI.loadout.pickRowH - 8 };
};
// 通用小按钮(底栏 ⏸/⚙ 等 ghost 风格;BEAUTIFY-01 F4/F6:材质走 UI_STYLE 令牌+按压态)
function drawIconBtn(ctx, r, glyph, iconKey) {
  const pressed = isPressed(r);
  ctx.fillStyle = pressed ? '#f3ece0' : '#fff';
  roundRect(ctx, r.x, r.y, r.w, r.h, 10); ctx.fill();
  ctx.strokeStyle = UI_STYLE.cardLine; ctx.lineWidth = 2;
  roundRect(ctx, r.x, r.y, r.w, r.h, 10); ctx.stroke();
  if (pressed) { ctx.strokeStyle = 'rgba(14,122,112,.45)'; ctx.lineWidth = 3; roundRect(ctx, r.x + 2, r.y + 2, r.w - 4, r.h - 4, 8); ctx.stroke(); }
  // M14:优先贴图(UI_IMG,替换 emoji);miss 回退原文字
  const icon = iconKey ? UI_IMG[iconKey] : null;
  if (icon && icon.complete && icon.naturalWidth) {
    ctx.drawImage(icon, r.x + r.w / 2 - 16, r.y + r.h / 2 - 16, 32, 32);
    return;
  }
  ctx.fillStyle = UI_STYLE.ink;
  ctx.font = FONT(22, 'bold');
  ctx.textAlign = 'center';
  ctx.fillText(glyph, r.x + r.w / 2, r.y + r.h / 2 + 8);
  ctx.textAlign = 'left';
}

// 通用 clay 按钮(kind: primary|ghost|warn|disabled)
// BEAUTIFY-01 F2(P1):primary 底 #19c8b9→UI_STYLE.primaryBtn #0e7a70(白字对比 2.10→5.20);
// BEAUTIFY-01 F6:按压态=底色加深+内亮边(无位移不改命中区;main setPressPoint 喂点)
function drawBtn(ctx, r, text, kind = 'primary', fontSize = 26) {
  const colors = {
    primary: [UI_STYLE.primaryBtn, '#fff'],
    ghost: [UI_STYLE.paper, UI_STYLE.ink],
    warn: ['#f5c31c', UI_STYLE.ink],
    disabled: ['#d8d2c4', UI_STYLE.dim],
  };
  const [bg, fg] = colors[kind] || colors.primary;
  const pressed = kind !== 'disabled' && isPressed(r);
  ctx.fillStyle = pressed ? shade(bg, 0.88) : bg;
  roundRect(ctx, r.x, r.y, r.w, r.h, Math.min(24, r.h / 2)); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 3;
  roundRect(ctx, r.x, r.y, r.w, r.h, Math.min(24, r.h / 2)); ctx.stroke();
  if (pressed) { ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2; roundRect(ctx, r.x + 3, r.y + 3, r.w - 6, r.h - 6, Math.max(4, Math.min(21, r.h / 2) - 3)); ctx.stroke(); }
  ctx.fillStyle = fg;
  ctx.font = FONT(fontSize, 'bold');
  ctx.textAlign = 'center';
  ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2 + fontSize * 0.36);
}
// 两色插值(高光渐隐;hex #rrggbb;位运算无数组/映射分配;-03 B6 整改)
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const c = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return '#' + ((r << 16) | (g << 8) | c).toString(16).padStart(6, '0');
}
// 颜色加深(按压态;hex #rrggbb ×系数;位运算无数组分配;-03 B6 整改)
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), c = Math.round((n & 255) * k);
  return '#' + ((r << 16) | (g << 8) | c).toString(16).padStart(6, '0');
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
// -07 Q2:草地自转/主角跑步接 fx 门控——关动效时静帧(专用表现时钟,不用 worldT 全局墙钟)
let meadowT = 0;
function drawStartScreen(ctx, hud, dt) {
  if (_fxOn) meadowT += dt || 0;
  // M15 Task 51:开始界面背景=生图产物(720×1280 全屏;缺图回退田园渐变+云/远山程序化兜底)
  const startBg = START_IMG.bg;
  if (startBg && startBg.complete && startBg.naturalWidth > 0) {
    ctx.drawImage(startBg, 0, 0, 720, 1280);
  } else {
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
  }
  // 标题(M15 Task 51:定名 LOGO 图=言出法随/三生万物,500×220 显示区随既有浮动动画;缺图回退程序化文字)
  const ty = 250 + Math.sin(worldT * 1.6) * 8;
  const startLogo = START_IMG.logo;
  if (startLogo && startLogo.complete && startLogo.naturalWidth > 0) {
    ctx.drawImage(startLogo, 110, ty - 120, 500, 220);
  } else {
  ctx.textAlign = 'center';
  ctx.font = FONT(104, 'bold');
  ctx.lineWidth = 16; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(121,79,39,.9)'; ctx.strokeText('言出法随', 360, ty);
  ctx.fillStyle = '#19c8b9'; ctx.fillText('言出法随', 360, ty);
  ctx.font = FONT(46, 'bold');
  ctx.lineWidth = 9;
  ctx.strokeText('三 生 万 物', 360, ty + 78);
  ctx.fillStyle = '#fff'; ctx.fillText('三 生 万 物', 360, ty + 78);
  ctx.font = FONT(28);
  ctx.lineWidth = 0;
  ctx.fillStyle = '#794f27';
  ctx.fillText('消除五行 · 合成技能 · 守卫到底', 360, ty + 140);
  }
  // ===== 圆形可行走草地+主角原地跑步(需求方 2026-10-19;样板 .tmp/start-circle-demo.html 口径) =====
  // 草地圆心 (360,1340) 显示半径 280(贴图 560×560);绕圆心自转 0.12rad/s(跑步机式行走错觉);
  // 主角站草圆**最上方贴地**:绘制底 y=1122(草圆顶 1060+62),逻辑可见底 ≈1068.25~1069.50
  // (逐帧 alpha 复算见 m15-beautify-r9/q1-alpha-recheck.md),原地循环跑动 walk 10fps,位置固定。
  const MC = MEADOW_CIRCLE; // -07 Q4:常量提升模块级(原每帧新建对象)
  const md = MEADOW_IMG.img;
  ctx.save();
  ctx.translate(MC.x, MC.y);
  ctx.rotate(meadowT * MC.spin);
  if (md && md.complete && md.naturalWidth > 0) {
    ctx.drawImage(md, -MC.r, -MC.r, MC.r * 2, MC.r * 2);
  } else {
    // 程序化兜底(样板同款:草面渐变+土层环+草丛/花/石子固定地面坐标随转;渐变按 ctx 缓存)
    if (!MEADOW_FALLBACK_GRAD || MEADOW_FALLBACK_GRAD.ctx !== ctx) {
      const g = ctx.createRadialGradient(0, -MC.r * 0.55, 30, 0, -MC.r * 0.55, MC.r);
      g.addColorStop(0, '#8ed05e'); g.addColorStop(0.8, '#7bc24d'); g.addColorStop(1, '#63a638');
      MEADOW_FALLBACK_GRAD = { ctx, g };
    }
    ctx.fillStyle = MEADOW_FALLBACK_GRAD.g;
    ctx.beginPath(); ctx.arc(0, 0, MC.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#9a6b3f'; ctx.lineWidth = 13;
    ctx.beginPath(); ctx.arc(0, 0, MC.r - 7, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 40; i++) {
      const a = i * 2.399963, rr = (0.35 + 0.6 * ((i * 37 % 100) / 100)) * MC.r;
      ctx.fillStyle = i % 3 ? 'rgba(74,148,44,.75)' : '#f5d95a';
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * rr, Math.sin(a) * rr, 7, 3, a, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  // 主角:草圆顶贴地原地跑步(-07:walk 6 帧循环 10fps,用户确认「用跑的动作」;面右镜像与战斗一致)
  // Q1 贴地口径(-10 逐帧 alpha 复算,绑定 m15-beautify-r9/q1-alpha-recheck.md):
  // 绘制底 y=1122(=草地贴图顶 1060+62),绘制顶 802,六帧原图 720×1280 按 1/4 缩放,
  // 非透明区域下边界(原图行 1065~1070)→ 逻辑可见底 ≈1068.25~1069.50,位于草面顶
  // (1075)上方 5.5~6.75px;接触观感以绑定截图复核为准。
  const heroFootY = MC.y - MC.r + 62;
  ctx.fillStyle = 'rgba(40,60,30,.28)';
  ctx.beginPath(); ctx.ellipse(360, heroFootY + 4, 54, 14, 0, 0, Math.PI * 2); ctx.fill();
  // 跑步动画:walk 6 帧循环 10fps(跑动步态帧差异明显;-07 前误用 walk_start 起手 3 帧,差异微小视觉近似静止)
  const pfw = PLAYER_WALK_FRAMES.length ? seqFrame(PLAYER_WALK_FRAMES, meadowT, 10) : (PLAYER_ATK_FRAMES[0] || PLAYER_FRAMES[0]);
  if (pfw && pfw.complete && pfw.naturalWidth > 0) {
    drawFlipH(ctx, pfw, 360 - 90, heroFootY - 320, 180, 320);
  } else {
    ctx.fillStyle = '#3f6fb5';
    roundRect(ctx, 360 - 45, heroFootY - 260, 90, 260, 24); ctx.fill();
  }
  // 主按钮(有存档「开始冒险」/无档「开始游戏」——存档信息条有无同步)
  const prof = hud.profile ? hud.profile() : null;
  const hasSave = !!(prof && ((prof.level > 1) || (prof.expTotal ?? 0) > 0 || (hud.progress ? hud.progress().lastLevelCleared : 0) > 0));
  drawBtn(ctx, UI.start.playBtn, hasSave ? '开 始 冒 险' : '开 始 游 戏', 'primary', 36);
  {
    const pIn = _scrIn; // BEAUTIFY-01 F12:首现轻高光(0.3s;-03 B3:进度由 render 入口每帧算)
    if (pIn < 1) {
      ctx.save();
      ctx.globalAlpha = (1 - pIn) * 0.7;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
      roundRect(ctx, UI.start.playBtn.x + 3, UI.start.playBtn.y + 3, UI.start.playBtn.w - 6, UI.start.playBtn.h - 6, Math.min(24, UI.start.playBtn.h / 2) - 3); ctx.stroke();
      ctx.restore();
    }
  }
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
  drawTopBar(ctx, '关卡选择'); // 需求方 2026-10-19 第三批:选关顶栏移除等级/经验 chip(不传 prof;备战本就不传)
  // 需求方 2026-10-19 第三批:选关顶部货币/材料行移除(资产在养成/战斗/结算有承载,选关不再重复)
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
    if (current) {
      const pIn = _scrIn; // BEAUTIFY-01 F12:当前挑战卡短亮边(0.3s;-03 B3:进度由 render 入口每帧算)
      if (pIn < 1) {
        ctx.save();
        ctx.globalAlpha = (1 - pIn) * 0.8;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
        roundRect(ctx, 36, y + 4, 648, UI.menu.cardH - 8, 20); ctx.stroke();
        ctx.restore();
      }
    }
    // Boss 缩略图(boss 序列帧首帧;缺图灰盒)
    const th = 126, tx = 56, tyy = y + 22;
    ctx.fillStyle = '#efe9db';
    roundRect(ctx, tx, tyy, th, th, 16); ctx.fill();
    // 需求方 2026-10-19 第三批:缩略图=该关 Boss 类型帧首帧(LEVEL_BOSS:fox/zombie/snake/tiger/boss)
    const bossImg = ENEMY_FRAMES[bossType(i)] && ENEMY_FRAMES[bossType(i)][0]; // 循环变量 i=关卡号
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
      // M14:敌人改中文名(需求方反馈不再显示英文);宽度按实测——修复前 fillText 在
      // textAlign=left 下从 cx0+w/2 起画,文字整体偏右(需求方实测反馈)
      const label = ENEMY_NAME[k] || k;
      ctx.font = FONT(16);
      const w = 24 + ctx.measureText(label).width;
      if (cx0 + w > UI.menu.chipsMaxX) { cx0 = UI.menu.chipsX; cy0 += UI.menu.chipsRowGap; } // 超出左列(≤300)换行到第二行
      ctx.fillStyle = '#fff';
      roundRect(ctx, cx0, cy0, w, 28, 14); ctx.fill();
      ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 2; roundRect(ctx, cx0, cy0, w, 28, 14); ctx.stroke();
      ctx.fillStyle = '#794f27'; ctx.font = FONT(16);
      ctx.textAlign = 'center';
      ctx.fillText(label, cx0 + w / 2, cy0 + 19);
      ctx.textAlign = 'left';
      cx0 += w + 8;
    }
    ctx.textAlign = 'center';
    // 状态 chip + 按钮(右列;M11-03 F7:按钮区 x≥510 与 chips 左列完全错开)
    if (cleared) {
      // M11-05 F7 整改:「已通关」chip 380/y+30 → 560/y-14(修复前压住关卡名称 30px 字尾 210~480);
      // 与「当前进度」chip 同位互斥(cleared/current 两态不同时绘制),按钮区 y+45 起不相碰
      chip(ctx, 560, y - 14, '已通关', '#e6f9f6', '#0e7a70');
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
  drawTopBar(ctx, `备战 · 第 ${L} 关`); // 等级/经验条只在选关顶栏(需求方 2026-10-19:备战与主角卡重复,移除)
  // 主角面板(立绘+等级/HP/ATK+升级缺口)
  // 主角面板(v2:全宽卡,只留 HP/ATK 概览;升级细节归养成面板)
  ctx.fillStyle = '#fff';
  roundRect(ctx, 32, 140, 656, 300, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, 32, 140, 656, 300, 24); ctx.stroke();
  const pf = PLAYER_FRAMES.length ? seqFrame(PLAYER_FRAMES, worldT, 8) : null;
  ctx.fillStyle = '#efe9db';
  roundRect(ctx, 52, 160, 200, 260, 16); ctx.fill();
  if (pf && pf.complete && pf.naturalWidth > 0) {
    ctx.save(); roundRect(ctx, 52, 160, 200, 260, 16); ctx.clip();
    drawPortrait(ctx, pf, 52, 160, 200, 260, true); // 等比 contain 不变形(需求方 2026-10-19)
    ctx.restore();
  } else {
    ctx.fillStyle = '#9f927d'; ctx.font = FONT(20); ctx.textAlign = 'center';
    ctx.fillText('主角立绘', 152, 295); ctx.textAlign = 'left';
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(32, 'bold');
  ctx.fillText(`Lv.${prof.level}`, 288, 208); // 名字常驻显示移除(需求方 2026-10-19)
  ctx.font = FONT(24);
  ctx.fillText(`HP ${maxHpText(prof.level)}`, 288, 252);
  ctx.fillStyle = '#794f27';
  ctx.fillText(`ATK ${atkText(prof.level)}`, 288, 300); // 绿色血条移除(此处无意义,数值保留)
  ctx.font = FONT(21);
  ctx.fillStyle = '#9f927d';
  ctx.fillText('升级 / 技能升级 / 抽卡 → 养成面板', 288, 348);
  ctx.textAlign = 'center';

  // 出战信息卡
  // 出战信息(v2:横向窄卡,chips 化;敌人中文名;F 出框整改:行距收紧,两行 chips 收进卡内)
  ctx.fillStyle = '#f0e8d8';
  roundRect(ctx, 32, 470, 656, 150, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; roundRect(ctx, 32, 470, 656, 150, 24); ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(28, 'bold');
  ctx.fillText('出战信息', 60, 514);
  ctx.font = FONT(21); ctx.fillStyle = '#9f927d';
  ctx.fillText(`第 ${L} 关 · ${meta.name}`, 200, 512);
  const chipV = [];
  {
    ctx.font = FONT(19);
    chipV.push({ t: `${WAVES_PER_LEVEL} 波 · 末波 Boss`, color: '#5a4a32' });
    const enames = Object.keys(levelWeights(L)).map(k => ENEMY_NAME[k] || k).join(' ');
    chipV.push({ t: `敌人:${enames}`, color: '#5a4a32' });
    const warnL = prof.level < meta.suggest;
    chipV.push({ t: `建议 Lv.${meta.suggest}+`, color: warnL ? '#e05a5a' : '#5a4a32' });
    let cy = 528;
    let cx = 60;
    for (const ch of chipV) {
      ctx.font = FONT(19);
      const w = 30 + ctx.measureText(ch.t).width;
      if (cx + w > 660) { cx = 60; cy += 48; }
      ctx.fillStyle = '#fff';
      roundRect(ctx, cx, cy, w, 36, 18); ctx.fill();
      ctx.strokeStyle = ch.color === '#e05a5a' ? '#e05a5a' : '#dcd8d1'; ctx.lineWidth = 2;
      roundRect(ctx, cx, cy, w, 36, 18); ctx.stroke();
      ctx.fillStyle = ch.color;
      ctx.fillText(ch.t, cx + 15, cy + 24);
      cx += w + 12;
    }
  }
  ctx.textAlign = 'center';

  // 技能装配 4 槽(M11 设计稿:120×120 图标+技能名;点击选中→技能库换装;
  // 技能装配 4 槽(v2:140 大槽;单击槽图标=tips,右上「更换」=换装抽屉,技能库列表已移除)
  ctx.fillStyle = '#fff';
  roundRect(ctx, 32, UI.loadout.panelY, 656, 330, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, 32, UI.loadout.panelY, 656, 330, 24); ctx.stroke();
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(26, 'bold');
  ctx.textAlign = 'left';
  ctx.fillText('技能装配', 56, UI.loadout.panelY + 42);
  ctx.font = FONT(19);
  ctx.fillStyle = '#9f927d';
  ctx.fillText(fitText(ctx, '点图标看说明 · 右上「更换」换技能', 440), 190, UI.loadout.panelY + 42);

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
        ctx.drawImage(img, sx + 28, sy + 16, 72, 72); // 需求方 2026-10-19:86×86 改为 72×72 槽内居中;128 槽左右留 28px(右缘 100 让开「更换」徽章命中区 94 起)
      } else {
        ctx.fillStyle = GEM_SRC[sk.el];
        ctx.beginPath(); ctx.arc(sx + 64, sy + 52, 30, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = ['fire', 'water', 'earth'].includes(sk.el) ? '#fff' : '#794f27';
        ctx.font = FONT(32, 'bold');
        ctx.fillText(sk.el[0].toUpperCase(), sx + 64, sy + 63);
      }
      ctx.fillStyle = '#794f27';
      ctx.font = FONT(21, 'bold');
      ctx.fillText(fitText(ctx, sk.name, 116), sx + 64, sy + 114);
      // M11-06:右上角「更换」双环形箭头(点击打开换装列表)
      drawSwapIcon(ctx, sx + UI.loadout.slotSize - 19, sy + 19);
    } else {
      ctx.fillStyle = '#c4b89e';
      ctx.font = FONT(22);
      ctx.fillText('空槽', sx + 64, sy + 70);
    }
  }
  ctx.textAlign = 'center';
  // 出战按钮
  drawBtn(ctx, UI.loadout.fightBtn, '出 战', 'primary', 38);
  // M11-06:换装面板/技能 tips 浮层(在主界面之上)
  // BEAUTIFY-01 F7:浮层入场淡入(键=面板类型;关闭后重开重新计时)
  if (lo.panel === 'skillPick') { ctx.save(); ctx.globalAlpha = _ovA = overlayIn('skillPick'); drawPickPanel(ctx, hud, prof, lo); ctx.restore(); }
  else if (lo.panel === 'skillTips') { ctx.save(); ctx.globalAlpha = _ovA = overlayIn(`skillTips:${lo.tipsSlot}`); drawSkillTips(ctx, prof, lo); ctx.restore(); } // 键含槽位(换槽重放淡入)
}

// M11-06:「更换」双环形箭头图标(两段弧+箭头,animal-island primary 色)
function drawSwapIcon(ctx, cx, cy) {
  ctx.save();
  ctx.fillStyle = 'rgba(230,249,246,.92)';
  ctx.beginPath(); ctx.arc(cx, cy, 15, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#19c8b9'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(cx, cy, 9, -Math.PI * 0.15, Math.PI * 0.75); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 9, Math.PI * 0.85, Math.PI * 1.75); ctx.stroke();
  // 两个箭头小三角(弧端切向)
  ctx.fillStyle = '#19c8b9';
  ctx.beginPath(); ctx.moveTo(cx + 8.6, cy + 3.6); ctx.lineTo(cx + 13.4, cy + 0.6); ctx.lineTo(cx + 10.4, cy + 8.4); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx - 8.6, cy - 3.6); ctx.lineTo(cx - 13.4, cy - 0.6); ctx.lineTo(cx - 10.4, cy - 8.4); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// M11-05(F13 残留整改):技能档位数值行——口径与 behaviors.js 各内核逐一同源:
//   伤害类(bolt/chain/multi/pulse/dotzone 直击)=ATK×(dmgCoef??1)×TIER_MULT(library.js tiered 同源);
//   bind(藤蔓束缚)=每秒 ATK×dpsCoef(0.3)×档(behaviors.js:63,修复前误按 dmgCoef=1 显示普通伤害);
//   shield=护盾值 ATK×dmgCoef×档;aura=每秒回复 maxHp×1%×档(behaviors.js:213,依据最大 HP);
//   field=减速固定值(behaviors.js:155 慢区不乘档)。formula 标签随类型生成,不再统一写「ATK×档位倍率」
function skillValueLine(sk, atk, maxHp) {
  if (sk.kind === 'bind') {
    const dps = sk.params.dpsCoef ?? 0.3;
    return { label: '每秒伤害', formula: `每秒 ATK ${atk} × ${dps} × 档位倍率`, text: TIER_MULT.map(m => Math.round(atk * dps * m)).join(' / ') };
  }
  if (sk.kind === 'aura') return { label: '每秒回复', formula: `每秒 最大HP ${maxHp} × 1% × 档位倍率`, text: TIER_MULT.map(m => Math.round(maxHp * 0.01 * m)).join(' / ') };
  if (sk.kind === 'field') return { label: '减速效果', formula: '固定效果 · 各档相同', text: `-${sk.params.slowPct}% · 持续 ${sk.params.duration}s` };
  const coef = sk.params?.dmgCoef ?? 1;
  const label = sk.kind === 'shield' ? '护盾值' : sk.kind === 'dotzone' ? '直击伤害' : '伤害';
  return { label, formula: `ATK ${atk} × ${coef === 1 ? '1' : coef} × 档位倍率`, text: TIER_MULT.map(m => Math.round(atk * coef * m)).join(' / ') };
}
function skillDetailText(sk) {
  const p = sk.params || {};
  switch (sk.kind) {
    case 'bolt': return '单体弹道直击,可暴击';
    case 'dotzone': return `命中生成灼烧区 r${p.r},每秒 ATK×${p.dpsCoef},持续 ${p.duration}s`;
    case 'chain': return `主目标+邻近敌人,各 ATK×${p.dmgCoef}`;
    case 'bind': return `束缚最近敌 ${p.bindTime}s,每秒 ATK×${p.dpsCoef}`;
    case 'multi': return `${p.count} 发弹各 ATK×${p.dmgCoef}`;
    case 'shield': return `护盾 ATK×${p.dmgCoef},上限 30% 最大 HP`;
    case 'pulse': return `脉冲环 r${p.r},ATK×${p.dmgCoef}${p.stunTime ? `+眩晕 ${p.stunTime}s` : ''}`;
    case 'field': return `减速领域 r${p.r},减速 ${p.slowPct}%,持续 ${p.duration}s`;
    case 'aura': return `每秒回复最大 HP 1%×档位倍率,持续 ${p.duration}s`;
    default: return SKILL_BRIEF[sk.kind] || sk.kind;
  }
}

// M11-06:技能 tips 浮层(长按槽位 500ms 触发)
function drawSkillTips(ctx, prof, lo) {
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, 720, 1280);
  const sk = skillById((prof.loadout || [])[lo.tipsSlot ?? 0]);
  if (!sk) return;
  const atk = atkText(prof.level);
  const lv = prof.skillLevels?.[sk.id] || 1;
  ctx.fillStyle = '#fff';
  roundRect(ctx, 90, 420, 540, 400, 24); ctx.fill();
  ctx.strokeStyle = '#19c8b9'; ctx.lineWidth = 4;
  roundRect(ctx, 90, 420, 540, 400, 24); ctx.stroke();
  // 图标+名称/等级
  const img = SKILL_IMG[sk.id];
  ctx.fillStyle = '#f0e8d8';
  roundRect(ctx, 118, 448, 110, 110, 16); ctx.fill();
  if (img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, 126, 456, 94, 94);
  else {
    ctx.fillStyle = GEM_SRC[sk.el];
    ctx.beginPath(); ctx.arc(173, 503, 42, 0, Math.PI * 2); ctx.fill();
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(34, 'bold');
  ctx.fillText(sk.name, 252, 492);
  ctx.font = FONT(22);
  ctx.fillStyle = '#9f927d';
  ctx.fillText(`Lv.${lv} · ${ELEMENT_NAME[sk.el] || sk.el} · CD ${sk.cd}s · 槽位 ${lo.tipsSlot + 1}`, 252, 528);
  // 效果描述
  ctx.font = FONT(24);
  ctx.fillStyle = '#5a4a32';
  wrapText(ctx, skillDetailText(sk), 118, 606, 484, 34);
  // 档位数值(T1~T5;F13 残留整改:公式标签随技能类型生成——伤害=ATK/束缚=每秒ATK×dps/光环=最大HP/领域=固定)
  const vline = skillValueLine(sk, atk, maxHpText(prof.level));
  ctx.font = FONT(20);
  ctx.fillStyle = '#9f927d';
  ctx.fillText(`${vline.label}(${vline.formula}):`, 118, 682);
  ctx.font = FONT(22, 'bold');
  ctx.fillStyle = UI_STYLE.accentText; // BEAUTIFY-01 F2:文字对比 2.10→5.20
  ctx.fillText(vline.text, 118, 716);
  ctx.font = FONT(19);
  ctx.fillStyle = '#c4b89e';
  ctx.textAlign = 'center';
  ctx.fillText('点按任意处关闭', 360, 796);
}

// 简单宽度换行(中文按字宽近似)
function wrapText(ctx, text, x, y, maxW, lineH) {
  let line = '', yy = y;
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW) {
      ctx.fillText(line, x, yy); line = ch; yy += lineH;
    } else line += ch;
  }
  if (line) ctx.fillText(line, x, yy);
}

// M11-06:换装列表面板(槽位「更换」按钮打开;已装配技能不显示)
// 需求方 2026-10-19 整改:按 03 样板抽屉网格实装(图标+名+Lv/CD 小字,不再塞长描述/数值列);
// 面板高度收进屏内(原 1088 高溢出屏底);关闭按钮收进面板右上;「灰=不可用」说明句移除
function drawPickPanel(ctx, hud, prof, lo) {
  const P = { x: 40, y: UI.loadout.pickTop, w: 640, h: 640 };
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, 720, 1280);
  ctx.fillStyle = '#f8f8f0';
  roundRect(ctx, P.x, P.y, P.w, P.h, 24); ctx.fill();
  ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3;
  roundRect(ctx, P.x, P.y, P.w, P.h, 24); ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#794f27';
  ctx.font = FONT(32, 'bold');
  ctx.fillText(`选择技能 → 槽位 ${(lo.pickSlot ?? 0) + 1}`, 64, UI.loadout.pickTop + 58);
  // 关闭按钮(面板内右上,与样板同款 ghost)
  const cb = UI.loadout.pickCloseBtn;
  drawBtn(ctx, cb, '关 闭', 'ghost', 26);
  const rows = uiPickRows(prof.loadout, prof.ownedSkills, prof.level);
  rows.forEach(({ sk, rect, unlocked }) => {
    ctx.fillStyle = unlocked ? '#fff' : '#f0ece2';
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 16); ctx.fill();
    ctx.strokeStyle = '#e8e2d6'; ctx.lineWidth = 2;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 16); ctx.stroke();
    const img = SKILL_IMG[sk.id];
    if (img && img.complete && img.naturalWidth > 0) {
      if (!unlocked) ctx.globalAlpha = 0.45 * _ovA; // BEAUTIFY-01 F7:内层 alpha 相乘外层 fade
      ctx.drawImage(img, rect.x + 12, rect.y + 12, 52, 52);
      ctx.globalAlpha = _ovA;
    } else {
      ctx.fillStyle = GEM_SRC[sk.el];
      ctx.beginPath(); ctx.arc(rect.x + 38, rect.y + 38, 24, 0, Math.PI * 2); ctx.fill();
    }
    ctx.textAlign = 'left';
    // 需求方 2026-10-19 第三批:换装行补技能描述(skillDetailText 一行 fitText;三行版式:名/描述/Lv·CD)
    ctx.fillStyle = unlocked ? '#794f27' : '#c4b89e';
    ctx.font = FONT(18, 'bold');
    ctx.fillText(fitText(ctx, sk.name, rect.w - 76 - 12), rect.x + 76, rect.y + 26);
    ctx.font = FONT(15);
    ctx.fillStyle = unlocked ? '#5a4a32' : '#c4b89e';
    ctx.fillText(fitText(ctx, skillDetailText(sk), rect.w - 76 - 12), rect.x + 76, rect.y + 47);
    ctx.font = FONT(14, 'bold');
    ctx.fillStyle = unlocked ? '#9f927d' : '#c4b89e';
    const sub = unlocked
      ? `Lv.${prof.skillLevels?.[sk.id] || 1} · CD ${sk.cd}s`
      : (prof.ownedSkills || []).includes(sk.id) ? `Lv.${sk.unlockLevel} 解锁` : '未拥有';
    ctx.fillText(fitText(ctx, sub, rect.w - 76 - 12), rect.x + 76, rect.y + 66);
  });
  ctx.textAlign = 'center';
}

// HP/ATK 面板值(与 meta/exp.js 公式同源:HP=100+15×(Lv−1)、ATK=10+(Lv−1);避免循环依赖内联)
function maxHpText(level) { return 100 + 15 * (level - 1); }
function atkText(level) { return 10 + (level - 1); }

// ===== 05 结算(胜利/失败;UI 设计稿 05) =====
function drawResult(ctx, hud, battle, victory, dt = 1 / 60) {
  // ===== 结算 v2(M15;05-result.html 样板实装)=====
  // 时间轴:0~0.25s 遮罩淡入 → 0.35s 横幅(胜利 spring 弹入/失败下沉淡入)→ 0.7s 起统计行
  // stagger(每行 +130ms)+数字滚动 → 1.55s 起按钮组逐个弹入;任意点按=跳过(main resultSkip)
  // 胜利专属:五行色彩带 ~120 粒顶部落下;失败:无彩带+横幅下沉不弹跳(不庆祝)
  // F4 整改:t 按真实经过时间推进(帧率无关,30/60/120fps 同一时长;与音效拍点对齐)
  const T = resultAnim;
  T.t += dt;
  const t = T.t;
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const stage = (d0, d1) => ease((t - d0) / (d1 - d0)); // 0→1 入场进度
  // 遮罩(0~0.25s 淡入)
  const mA = Math.min(1, t / 0.25);
  ctx.fillStyle = victory ? `rgba(232,246,224,${0.88 * mA})` : `rgba(243,226,224,${0.9 * mA})`;
  ctx.fillRect(0, 0, 720, 1280);
  // 彩带(胜利;0.8s 起生成,持续下落,落底循环;位移按真实 dt)
  // BEAUTIFY-01 F11:发射节奏按经过秒数(45 片/s,上限 120)——同壁钟时刻片数与帧率无关(原每帧 ≤6 片,120fps 密度翻倍)
  if (victory && t > 0.8) {
    const target = Math.min(120, Math.floor((t - 0.8) * 45));
    while (T.confetti.length < target) {
      T.confetti.push({ x: Math.random() * 720, y: -24, vy: 220 + Math.random() * 140, rot: Math.random() * 360, vr: 200 + Math.random() * 240, w: 9 + Math.random() * 6, h: 13 + Math.random() * 8, color: CONFETTI_COLORS[Math.floor(Math.random() * 6)] }); // 池上限 120,满后不再新建
    }
  }
  ctx.save();
  for (const c of T.confetti) {
    c.y += c.vy * dt; c.rot += c.vr * dt;
    if (c.y > 1310) { c.y = -24; c.x = Math.random() * 720; }
    ctx.save();
    ctx.translate(c.x, c.y); ctx.rotate((c.rot * Math.PI) / 180);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = c.color; ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.restore();
  }
  ctx.restore();
  // 横幅(0.35s 起;胜利 spring 0.6→1.1→1 / 失败缓慢下沉淡入,不弹跳)
  const R = victory ? UI.result.victory : UI.result.defeat;
  const bIn = stage(0.35, 0.9);
  if (bIn > 0) {
    ctx.save();
    ctx.textAlign = 'center';
    if (victory) {
      let sc;
      if (bIn < 0.6) sc = 0.6 + (bIn / 0.6) * 0.5;
      else if (bIn < 1) sc = 1.1 - ((bIn - 0.6) / 0.4) * 0.1;
      else sc = 1;
      ctx.translate(360, 205); ctx.scale(sc, sc);
      ctx.globalAlpha = Math.min(1, bIn * 2);
      ctx.translate(-360, -205);
    } else {
      ctx.globalAlpha = 0.92 * bIn;
      ctx.translate(0, (1 - bIn) * -24);
    }
    ctx.fillStyle = victory ? '#6fba2c' : '#e05a5a';
    roundRect(ctx, 90, 130, 540, 150, 24); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 4;
    roundRect(ctx, 90, 130, 540, 150, 24); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = FONT(64, 'bold');
    ctx.fillText(victory ? '通 关 !' : '战 败', 360, 228);
    ctx.restore();
  }
  // 统计卡(0.6s 起淡入)+ 统计行 stagger(0.7s 起每行 +130ms)+ 数字滚动
  const cIn = stage(0.6, 0.9);
  if (cIn > 0) {
    const cardH = victory ? 580 : 430;
    ctx.globalAlpha = cIn;
    ctx.fillStyle = '#fff';
    roundRect(ctx, 60, 340, 600, cardH, 24); ctx.fill();
    ctx.strokeStyle = '#dcd8d1'; ctx.lineWidth = 3; roundRect(ctx, 60, 340, 600, cardH, 24); ctx.stroke();
    ctx.fillStyle = '#794f27';
    ctx.font = FONT(30, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText(victory ? `第 ${battle.level} 关 · 结算` : `第 ${battle.level} 关 · 第 ${battle.wave} 波`, 360, 390);
    ctx.font = FONT(25);
    ctx.textAlign = 'left';
    // 统计行定义(与样板同序;数字滚动:显示值每帧向真值逼近 18%)
    const rows = [
      { key: 'kills', label: '击杀敌人', target: battle.kills, fmt: (v) => `${v} 只` },
      { key: 'chain', label: '最高连锁', target: hud.maxChain ? hud.maxChain() : 0, fmt: (v) => `×${v}` },
      { key: 'exp', label: '击杀经验累计', target: battle.expGained, fmt: (v) => `+${v} exp` },
    ];
    if (victory) {
      rows.push({ key: 'vcoin', label: '通关奖励', target: battle.victoryCoins || 0, fmt: (v) => `${v}`, mats: battle.victoryMats || 0, color: '#5a4a32' });
      rows.push({ key: 'coin', label: '本局产出', target: battle.coinsGained, fmt: (v) => `${v}`, mats: battle.matsGained, color: '#b06f1f' });
    } else {
      rows.push({ key: 'gain', label: '本局获得', target: battle.coinsGained, mats: battle.matsGained, color: '#b06f1f' }); // BEAUTIFY-01 F5:与胜利奖励行同构(图标+两数字,不再 emoji)
      rows.push({ key: 'hp', label: '剩余主角 HP', target: 0, fmt: () => '0', color: '#e05a5a' });
    }
    // 数字滚动逼近系数(时间常数型,帧率无关;60fps 时 ≈0.18 与原手感一致)
    const rollK = 1 - Math.exp(-dt * 12);
    const imgC = UI_IMG.coin, imgP = UI_IMG.pick;
    const hasIcons = !!(imgC && imgC.complete && imgC.naturalWidth && imgP && imgP.complete && imgP.naturalWidth);
    let ry = 440;
    rows.forEach((r0, i) => {
      const d0 = 0.7 + i * 0.13;
      const rin = stage(d0, d0 + 0.32);
      if (rin <= 0) { ry += 42; return; }
      ctx.save();
      ctx.globalAlpha = cIn * rin;
      ctx.translate((1 - rin) * -28, 0);
      ctx.fillStyle = '#9f927d'; ctx.fillText(r0.label, 92, ry);
      if (r0.mats !== undefined) {
        // 奖励行:金币与材料两个数字都显示(UIV2-01 F3/需求方 2026-10-19:
        // 数值与图标组合右对齐,不再固定图标位与右对齐数字脱节重叠)
        if (t >= RESULT_READY_T) { T.rolls[r0.key] = r0.target; T.rolls[r0.key + '_m'] = r0.mats; }
        else {
          if (T.rolls[r0.key] === undefined) T.rolls[r0.key] = 0;
          if (T.rolls[r0.key + '_m'] === undefined) T.rolls[r0.key + '_m'] = 0;
          T.rolls[r0.key] += (r0.target - T.rolls[r0.key]) * rollK;
          T.rolls[r0.key + '_m'] += (r0.mats - T.rolls[r0.key + '_m']) * rollK;
          if (Math.abs(r0.target - T.rolls[r0.key]) < 1) T.rolls[r0.key] = r0.target;
          if (Math.abs(r0.mats - T.rolls[r0.key + '_m']) < 1) T.rolls[r0.key + '_m'] = r0.mats;
        }
        const vn = Math.round(T.rolls[r0.key]), vm = Math.round(T.rolls[r0.key + '_m']);
        ctx.font = FONT(25);
        ctx.fillStyle = r0.color || '#5a4a32';
        ctx.textAlign = 'right';
        const sM = `${vm}`, sN = `${vn}`;
        let x = 628;
        ctx.fillText(sM, x, ry); x -= ctx.measureText(sM).width + (hasIcons ? 24 : 6);
        if (hasIcons) { ctx.drawImage(imgP, x - 18, ry - 17, 18, 18); x -= 28; }
        ctx.fillText(sN, x, ry); x -= ctx.measureText(sN).width + (hasIcons ? 24 : 6);
        if (hasIcons) ctx.drawImage(imgC, x - 18, ry - 17, 18, 18);
        ctx.textAlign = 'left';
      } else {
        // 数字滚动状态(键控;跳过后=显示终值)
        if (t >= RESULT_READY_T) T.rolls[r0.key] = r0.target;
        else {
          if (T.rolls[r0.key] === undefined) T.rolls[r0.key] = 0;
          T.rolls[r0.key] += (r0.target - T.rolls[r0.key]) * rollK;
          if (Math.abs(r0.target - T.rolls[r0.key]) < 1) T.rolls[r0.key] = r0.target;
        }
        const shown = Math.round(T.rolls[r0.key]);
        ctx.fillStyle = r0.color || '#5a4a32'; ctx.textAlign = 'right';
        ctx.fillText(r0.fmt(shown), 628, ry);
        ctx.textAlign = 'left';
      }
      ctx.restore();
      ry += 42;
    });
    // 升级/资产段(胜利)或鼓励文案(失败):1.2s 起
    const lateIn = stage(1.2, 1.5);
    if (lateIn > 0) {
      ctx.save();
      ctx.globalAlpha = cIn * lateIn;
      if (victory) {
        ry += 8;
        ctx.strokeStyle = '#dcd8d1'; ctx.setLineDash([8, 6]);
        ctx.beginPath(); ctx.moveTo(92, ry - 24); ctx.lineTo(628, ry - 24); ctx.stroke();
        ctx.setLineDash([]);
        const prof = hud.profile ? hud.profile() : { level: 1, coins: 0, materials: 0 };
        ctx.fillStyle = '#5a4a32';
        ctx.font = FONT(28, 'bold');
        ctx.fillText(`当前 Lv.${prof.level}`, 92, ry + 20);
        // 总资产行(UIV2-02 F3 整改:金币/材料两个数字都显示,图标+数字组合右对齐——
        // 与奖励行同一排布逻辑;原「先算总宽再向右排」致 890/10029 数字与图标挤压)
        {
          const imgC = UI_IMG.coin, imgP = UI_IMG.pick;
          const hasIcons = !!(imgC && imgC.complete && imgC.naturalWidth && imgP && imgP.complete && imgP.naturalWidth);
          ctx.font = FONT(25);
          ctx.fillStyle = UI_STYLE.ink; // BEAUTIFY-01 F2:金色数字白底对比仅 1.65,改深棕(7.09,与资产数字全项目统一)
          ctx.textAlign = 'right';
          const sN = `${prof.coins ?? 0}`, sM = `${prof.materials ?? 0}`;
          let ix = 628;
          ctx.fillText(sM, ix, ry + 20); ix -= ctx.measureText(sM).width + (hasIcons ? 24 : 6);
          if (hasIcons) { ctx.drawImage(imgP, ix - 18, ry + 3, 18, 18); ix -= 28; }
          ctx.fillText(sN, ix, ry + 20); ix -= ctx.measureText(sN).width + (hasIcons ? 24 : 6);
          if (hasIcons) ctx.drawImage(imgC, ix - 18, ry + 3, 18, 18);
          ctx.textAlign = 'left';
        }
        ctx.fillStyle = '#9f927d';
        ctx.font = FONT(19);
        ctx.fillText('养成面板可用材料升级/技能升级/抽卡', 92, ry + 56);
        if (battle.level < 5) {
          const meta = LEVEL_META[battle.level] || { name: `第 ${battle.level + 1} 关` };
          ctx.textAlign = 'center';
          chip(ctx, 210, 946, `🎉 解锁第 ${battle.level + 1} 关 · ${meta.name}`, '#fff', '#0e7a70');
          ctx.textAlign = 'left';
        }
      } else {
        const meta = LEVEL_META[battle.level - 1] || { suggest: battle.level };
        ctx.fillStyle = '#efe9db';
        roundRect(ctx, 92, ry - 10, 536, 96, 14); ctx.fill();
        ctx.fillStyle = '#794f27';
        ctx.font = FONT(22);
        ctx.textAlign = 'center';
        ctx.fillText(`练到 Lv.${meta.suggest} 再来挑战!失败不扣任何进度`, 360, ry + 30);
        ctx.font = FONT(19); ctx.fillStyle = '#9f927d';
        ctx.fillText('等级/经验/解锁全部保留', 360, ry + 60);
        ctx.textAlign = 'left';
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  // BEAUTIFY-01 F11:点按跳过提示(就绪前显示;终态空串不占视觉)
  {
    ctx.font = FONT(17);
    ctx.fillStyle = '#9f927d';
    ctx.textAlign = 'center';
    ctx.fillText(t < RESULT_READY_T ? '点按任意处跳过' : '', 360, 1258);
    ctx.textAlign = 'left';
  }
  // 按钮组(1.55s 起弹入;动效期内点按=跳过由 main 处理,按钮在 resultReady 前不接点击)
  // F8 整改:最后一关(第 5 关)主按钮文案=「完 成」(点击返回选关,与 main 路由一致)
  const btnIn = stage(1.55, 1.85);
  if (btnIn > 0) {
    const mainLabel = victory ? (battle.level >= 5 ? '完 成' : '下一关 ▶') : '再战一次';
    const list = victory
      ? [[R.mainBtn, mainLabel, 'primary', 36], [R.retryBtn, '重打本关', 'ghost', 28], [R.backBtn, '返回选关', 'ghost', 28]]
      : [[R.mainBtn, '再战一次', 'primary', 36], [R.loadoutBtn, '去备战', 'ghost', 28], [R.backBtn, '返回选关', 'ghost', 28]];
    list.forEach(([r0, label, kind, fs], i) => {
      const d0 = 1.55 + i * 0.08;
      const bin = stage(d0, d0 + 0.3);
      if (bin <= 0) return;
      ctx.save();
      ctx.globalAlpha = bin;
      const sc = 0.85 + 0.15 * bin;
      ctx.translate(r0.x + r0.w / 2, r0.y + r0.h / 2); ctx.scale(sc, sc); ctx.translate(-(r0.x + r0.w / 2), -(r0.y + r0.h / 2));
      drawBtn(ctx, r0, label, kind, fs);
      ctx.restore();
    });
  }
}

// 结算动效状态(模块级;main 在终局帧调 resultRestart 归零并触发音效;结算屏点按调 resultSkip)
const resultAnim = { t: 0, confetti: [], rolls: {} };
// 按钮可点时刻=时间轴完整终态(F4 整改:末按钮 1.55+2×0.08+0.30=2.01s 全部入场完成;
// 跳过直达此刻,与「完整终态」同帧,不再有 1.85s 半程态)
const RESULT_READY_T = 2.01;
const CONFETTI_COLORS = [GEM_SRC.fire, GEM_SRC.water, GEM_SRC.wood, GEM_SRC.metal, GEM_SRC.earth, '#f5c31c']; // BEAUTIFY -03 B6:静态色表(不再每帧建数组)
export function resultRestart() { resultAnim.t = 0; resultAnim.confetti = []; resultAnim.rolls = {}; }
export function resultSkip() { resultAnim.t = Math.max(resultAnim.t, RESULT_READY_T); }
export function resultReady() { return resultAnim.t >= RESULT_READY_T; }

// ===== 暂停浮层(底栏 ⏸;M11) =====
function drawPauseOverlay(ctx, hud) {
  ctx.fillStyle = 'rgba(20,22,15,.6)';
  ctx.fillRect(0, 0, 720, 1280);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fdf6e8';
  ctx.font = FONT(44, 'bold');
  ctx.fillText('已暂停', 360, 400);
  drawBtn(ctx, UI.pause.resumeBtn, '继 续', 'primary', 32);
  const bgmOn = hud.bgmEnabled ? hud.bgmEnabled() : true;
  const sfxOn = hud.sfxEnabled ? hud.sfxEnabled() : true;
  const fxOn = hud.fxEnabled ? hud.fxEnabled() : true;
  drawBtn(ctx, UI.pause.bgmBtn, `音乐:${bgmOn ? '开' : '关'}`, 'ghost', 24);
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
  const bgmOn = hud.bgmEnabled ? hud.bgmEnabled() : true;
  const sfxOn = hud.sfxEnabled ? hud.sfxEnabled() : true;
  const fxOn = hud.fxEnabled ? hud.fxEnabled() : true;
  drawBtn(ctx, UI.settings.bgmBtn, `音乐:${bgmOn ? '开' : '关'}`, 'ghost', 26);
  drawBtn(ctx, UI.settings.sfxBtn, `音效:${sfxOn ? '开' : '关'}`, 'ghost', 26);
  drawBtn(ctx, UI.settings.fxBtn, `动效:${fxOn ? '开' : '关'}`, 'ghost', 26); // BEAUTIFY-01 F4:与暂停面板同名称(同一开关)
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
