// scripts/main.js
// 入口：装配模块、启动主循环(M4:养成接线——经验升级/技能库装配/关卡解锁/存档 + M3 战斗闭环)
// 启动顺序(FR-9):资源预载全部成功后才绑定输入、开波、启动主循环;缺图停载并给诊断。
// 相对路径: scripts/main.js

import { startLoop } from './core/loop.js';
import { fitCanvas } from './core/layout.js';
import { attachInput } from './core/input.js';
import { BoardEngine } from './board/engine.js';
import { render, updateEnemyHealthViews } from './ui/render.js';
import { FxLayer, bindCallImages } from './ui/fx.js';
import { BattleHudView, bindHudImages } from './ui/battle_hud.js';
import { sfx, bgm } from './ui/audio.js';
import { Charge } from './skills/charge.js';
import { Caster } from './skills/cast.js';
import { Battle } from './battle/battle.js';
import { Parallax } from './battle/parallax.js';
import { makeRng, BOARD_Y, CELL, swapCreatesMatch, isItem } from './board/grid.js';
import { fullManifest } from './assets/manifest.js';
import { preload } from './assets/loader.js';
import { createApi } from './api/api.js';
import { maxHpAt, atkAt } from './meta/exp.js';
import { victoryReward, applyLevelUp, applySkillUp, gacha, levelUpCost, skillUpCost, COIN_PER_GACHA, SKILL_LEVEL_CAP } from './meta/economy.js';
import { canPlay, onVictory, mergeRunResult } from './meta/levels.js';
import { applyItem } from './board/items.js';
import { skillById, SKILL_LIBRARY } from './skills/library.js';
import { LEVEL_META } from './meta/levels.js';
import { GROW_LAYOUT, UI, uiCardBtn, uiSlotRect, uiLibRect, uiSlotSwapBtn, uiPickRows, bindImages } from './ui/render.js'; // M11:UI 命中区常量与派生 helper(与 render 布局单一来源)

const canvas = document.getElementById('game');
fitCanvas(canvas);
window.addEventListener('resize', () => fitCanvas(canvas));

// ---- M4 局外状态(FR-5/6/8):api 统一读写(本地后端回落 save.js),事件驱动写档 ----
const api = createApi();
const profile = await api.getProfile();
const levels0 = await api.getLevels();   // FR-8/整改 F5:进度统一经 API 读取(远端可替换)
let progress = { unlockedLevel: levels0.unlockedLevel, lastLevelCleared: levels0.lastLevelCleared, bestChains: 0 };
let screen = 'start';         // M11 五屏:'start'(01 开始)| 'menu'(02 选关)| 'loadout'(03 备战)| 'playing'(04 战斗/05 结算)
let selLevel = 1;             // 备战目标关(选关卡片 → 备战 → 出战)
let selSlot = 0;              // 备战界面选中装配槽(技能库换装目标)
let panel = null;             // 通用浮层:null | 'settings' | 'about'(开始/暂停共用)
                              // M11-06:+ 'skillPick'(换装列表)| 'skillTips'(槽位长按 tips)(备战专用)
let pickSlot = -1;            // M11-06:换装列表目标槽
let tipsSlot = -1;            // M11-06:tips 浮层对应槽
let paused = false;           // 战斗暂停(底栏 ⏸;M11)
let maxChain = 0;             // 本局最高连锁(结算展示,startLevel/retryLevel 归零)
let victoryHandled = false;
let coinsSeen = 0;            // 已入账的货币水位(M6 v0.2,每帧增量)
let matsSeen = 0;             // 已入账的材料水位
let clearedTotal = 0;         // 本局累计消除格数(FR-7 底栏"消除"计数,startLevel 归零)
let lastWave = 0;             // 上一帧波次(换波同步视差用)
let firstSel = null;          // M11-03 F9:点选交换的第一个选中格(02 文档 2.1;提升到模块级——
                              // 局界清理可见:startLevel/retryLevel 需清除,避免旧局点选状态带入新局)
let growPanel = false;        // 养成面板开关(FR-10/03 文档 2.6:角色升级/技能升级/抽卡)

const engine = new BoardEngine(20260601);
engine.fxEnabled = profile.settings.effects !== false; // 消除演出动效开关(02 文档 3.1:关→退化 0.20s 淡出)
const charge = new Charge();
const caster = new Caster(charge, profile.loadout, profile.level, profile.ownedSkills, profile.skillLevels); // v0.2:owned/skillLevels 由存档接入(批次 D)
// M11-02 F3 整改:Caster 构造把档内元素名转换为技能 ID(内存 caster.loadout ≠ profile.loadout),
// 备战界面 render 读 profile.loadout —— 启动即同步内存态(写档仍走事件驱动 persistProfile)
profile.loadout = [...caster.loadout];
const elimRng = makeRng(20260617); // 消除触发链均匀选技随机源(固定种子可复现,03 文档 6 自查)
const parallax = new Parallax({ effects: profile.settings.effects !== false });
const battle = new Battle({ atk: atkAt(profile.level), maxHp: maxHpAt(profile.level), rng: makeRng(20260601) });
const hud = { toast: null, fx: new FxLayer(), battleHud: new BattleHudView(), charge, caster, battle, parallax, screen: () => screen, profile: () => profile, progress: () => progress, cleared: () => clearedTotal, drag: null, growPanel: () => growPanel,
  // M11 五屏状态句柄(render 布局/UI 常量消费)
  paused: () => paused, panel: () => panel, loadout: () => ({ selLevel, selSlot, panel, pickSlot, tipsSlot }),
  maxChain: () => maxChain, sfxEnabled: () => sfx.enabled, fxEnabled: () => engine.fxEnabled,
  bgmEnabled: () => bgm.enabled }; // M14:BGM 开关状态(设置/暂停面板)

function showToast(text) { hud.toast = { text, t: 1.2 }; }

function persistProfile() {
  // M11-02 F3 整改:装配内存态同步(caster.loadout=技能 ID 转换结果,profile.loadout 若不同步,
  // 备战界面 render 读到旧档元素名显示「空槽」、换装后槽位图标/● 标记不更新)
  profile.loadout = [...caster.loadout];
  api.saveProfile({ ...profile, loadout: [...caster.loadout] });
}

// FR-9:先预载资源;缺文件报「缺 <路径>(实体:<名>)」并停载(不绑定输入、不启动主循环、无未处理拒绝)
let loadError = null;
let images = null;
try {
  images = await preload(fullManifest());
} catch (err) {
  loadError = err;
}
if (loadError) {
  document.body.innerHTML = `<pre style="color:#f66;font-size:20px;padding:24px">资源缺失:${loadError.message}</pre>`;
} else {
  boot(images);
}

function startLevel(L) {
  if (!canPlay(progress, L)) { showToast('关卡未解锁'); return; }
  engine.resetBoard(); // M11-03 F9:局界重置(放弃后重开不带旧局 clearing/falls/缓冲/事件)
  firstSel = null; // M11-03 F9:输入态局界清除(旧局点选状态不带入新局)
  battle.atk = atkAt(profile.level);
  battle.maxHp = maxHpAt(profile.level);
  battle.hp = battle.maxHp;
  battle.startLevel(L);
  caster.resetForNewLevel(); // REQ-05:终局清预约/档位/两项累计归零;CD 属局内进度同清
  hud.fx.clearCall(); // M12:旧局喊话演出不残留
  parallax.setLevel(battle.level); parallax.bindImages(images); // M13:分关卡背景切换
  hud.battleHud.reset(); // M13:二段血条/BOSS 条复位
  caster.resetTempState(); // F7 续审:CD 加速等道具临时状态不带入新局
  battle.kills = 0;
  battle.expGained = 0;
  battle.coinsGained = 0; battle.matsGained = 0;
  battle.victoryCoins = 0; battle.victoryMats = 0; // 通关奖励展示口径(结算弹层,REQ-M6-04 F4)
  coinsSeen = 0; matsSeen = 0; // REQ-M6-04 F3:入账水位同步归零(重试新局收益从零累计)
  clearedTotal = 0;
  maxChain = 0; // M11:最高连锁统计归零
  paused = false; panel = null;
  victoryHandled = false;
  screen = 'playing';
  lastWave = 0;
  parallax.setWave(1, false);
}

// 失败重试统一入口(REQ-M6-04 F3):与 startLevel 同一套局界初始化——
// 产出累计/入账水位/消除计数/池/预约/临时状态全部清空,不再只 battle.restart()
function retryLevel() {
  engine.resetBoard(); // M11-02 F9:同 startLevel(终局快进只到 IDLE,swapBuffer 等仍可能残留)
  firstSel = null; // M11-03 F9:输入态局界清除(旧局点选状态不带入新局)
  battle.atk = atkAt(profile.level);
  battle.maxHp = maxHpAt(profile.level);
  battle.hp = battle.maxHp;
  battle.restart();
  caster.resetForNewLevel();
  caster.resetTempState();
  hud.fx.clearCall(); // M12:旧局喊话演出不残留
  hud.battleHud.reset(); // M13:二段血条/BOSS 条复位
  battle.kills = 0;
  battle.expGained = 0;
  battle.coinsGained = 0; battle.matsGained = 0;
  battle.victoryCoins = 0; battle.victoryMats = 0;
  coinsSeen = 0; matsSeen = 0;
  clearedTotal = 0;
  maxChain = 0;
  paused = false; panel = null;
  victoryHandled = false;
  lastWave = 0;
  parallax.setWave(1, false);
}

// M11:选关卡片 → 备战界面(03)
function openLoadout(L) {
  if (!canPlay(progress, L)) { showToast('关卡未解锁'); return; }
  selLevel = L; selSlot = 0; panel = null; growPanel = false;
  pickSlot = -1; tipsSlot = -1; // M11-06:浮层状态随入口重置
  firstSel = null; // M11-03 F9:换装入口也清输入态(旧局点选不带入备战/新局)
  screen = 'loadout';
}

// M11:设置开关(音效/动效;开始界面与暂停面板共用,写档)
function toggleSfx() {
  sfx.enabled = !sfx.enabled;
  profile.settings.sfx = sfx.enabled; // M11-02 F5:音效开关入档(修复前只改内存,刷新后重开)
  persistProfile();
  showToast(`音效 ${sfx.enabled ? '开' : '关'}`);
  sfx.item();
}
// M14 需求方 2026-10-18:BGM 开关(设置面板「音乐」,默认开;入档 settings.bgm)
function toggleBgm() {
  bgm.enabled = !bgm.enabled;
  profile.settings.bgm = bgm.enabled;
  persistProfile();
  showToast(`音乐 ${bgm.enabled ? '开' : '关'}`);
  if (bgm.enabled) bgm.sync(screen === 'playing'); // 开=按当前屏恢复
  sfx.item();
}
function toggleFx() {
  profile.settings.effects = profile.settings.effects === false; // false→true,其余→false
  engine.fxEnabled = profile.settings.effects;
  persistProfile();
  showToast(`消除动效 ${profile.settings.effects ? '开' : '关'}`);
  sfx.item();
}

function boot(images) {
  // M11-02 F1 整改:渲染消费预载同一资源集合(render 各表以 preload 返回实例替换自建懒加载,
  // 「预载成功 ⇒ 绘制资源就绪」;返回绑定数,CDP/测试校验)
  window.__sswwImagesBound = bindImages(images);
  window.__sswwCallImagesBound = bindCallImages(images); // M12 技能喊话贴图(同一预载集合,缺图停载口径不变)
  window.__sswwHudImagesBound = bindHudImages(images); // M13 头像框/技能框
  window.__sswwParallaxImagesBound = parallax.bindImages(images); // M13 分关卡背景(初始主题)
  // M13 HUD 上下文(只读转发:battle_hud._snapshot 消费)
  hud.heroImg = images.get('call:hero') || null; // 头像复用技能喊话立绘裁头部
  hud.levelName = () => LEVEL_META[(battle.level - 1) % LEVEL_META.length].name;
  hud.skillImg = (id) => images.get(`icon:skills:${id}`) || null; // 技能图标(预载 Map 直取)
  hud.skillMeta = (id) => skillById(id);
  // M11-02 F5:音效开关启动恢复(档内 settings.sfx;与 effects 同一套写档)
  sfx.enabled = profile.settings.sfx !== false;
  bgm.enabled = profile.settings.bgm !== false; // M14:BGM 默认开(档案缺省 true)
  showToast('资源就绪');

  // 命中区工具
  const hit = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const inRect = (p, x, y, w, h) => hit(p, { x, y, w, h });

  // M11:选关卡片「挑战/重打」按钮 / 备战槽位 / 技能库行命中区
  // (M11-02 F2 整改:统一由 render.ui* helper 从 UI 常量派生,与绘制同源——
  // 修复前 main 硬编码 libRectOf 按旧 7 行计算,与 render 布局漂移)
  const cardBtnOf = uiCardBtn;
  const slotRectOf = uiSlotRect;
  const libRectOf = uiLibRect;

  // 输入绑定（cellAt 由渲染坐标反查棋盘格);返回拖拽状态句柄(果冻拖拽,M6)
  // nudgeLock(F7 续审):点选无效弹回期间仅锁 a/b 两格,其他格照常可操作
  const nudgeLock = (cell) => {
    const nf = engine.nudgeFx;
    return !!nf && ((cell.r === nf.a.r && cell.c === nf.a.c) || (cell.r === nf.b.r && cell.c === nf.b.c));
  };
  const input = attachInput(canvas, {
    // 忙态丢弃整次手势(F7 续审;M9 修订):演出期可操作忙态放行(RESOLVING/FALLING 并行交换
    // 由 engine.trySwap 即时受理),仅瘫痪/暂停等不可操作忙态仍丢弃
    // M11-04 F14 整改:忙态门控仅在战斗屏生效——修复前旧局棋盘 PARALYZED(战败未重置)残留,
    // input.update 在备战屏把手势作废 → 长按 tips 永不触发;非战斗屏 busy=false(局外输入不受
    // 已结束战斗的棋盘状态控制),战斗屏口径不变
    busy: () => screen === 'playing' && (engine.state !== 'IDLE' || engine.paralyzed),
    canActInBusy: () => screen === 'playing' && !engine.paralyzed && engine.state !== 'IDLE',
    // 果冻拖拽预判定(02 文档 2.3;REQ-M6-04 F7;M9 修订):仅 IDLE 预判成消(RESOLVING/FALLING
    // 交给引擎——M11 任意相邻非空对即时受理,槽满转预输入缓冲;无效 IDLE 拖拽仍预判拒绝跟手);
    // 含道具格走引擎换位分支
    tryDragSwap: (a, b) => {
      if (screen !== 'playing' || battle.phase !== 'FIGHTING' || paused) return false;
      if (nudgeLock(a) || nudgeLock(b)) return false;
      if (!engine.grid[a.r]?.[a.c] || !engine.grid[b.r]?.[b.c]) return false;
      const st = engine.state;
      const itemInvolved = isItem(engine.grid[a.r][a.c]) || isItem(engine.grid[b.r][b.c]);
      if (st === 'IDLE' && !itemInvolved && !swapCreatesMatch(engine.grid, a.r, a.c, b.r, b.c)) return false;
      if (!engine.trySwap(a, b)) return false;
      sfx.swap(); // 需求方 2026-10-18:「交换」提示移除(含连锁中交换)
      return true;
    },
    // M11 五屏路由拦截:非战斗屏/胜负结算/暂停全屏接管
    interceptDown: () => screen !== 'playing' || battle.phase !== 'FIGHTING' || paused,
    // M11-06:长按(≥500ms,位移取消)→ 备战技能槽 tips 浮层
    onLongPress: (p) => {
      if (screen !== 'loadout' || panel) return;
      for (let i = 0; i < 4; i++) {
        if (hit(p, slotRectOf(i))) {
          if (!profile.loadout[i]) return; // 空槽无 tips
          tipsSlot = i; panel = 'skillTips'; sfx.item();
          return;
        }
      }
    },
    cellAt: (x, y) => {
      if (y < BOARD_Y) return null;
      const c = Math.floor(x / CELL), r = Math.floor((y - BOARD_Y) / CELL);
      if (r < 0 || c < 0 || r >= 8 || c >= 8) return null;
      return { r, c };
    },
    onBlankDown: (p) => {
      // ---- M11 通用浮层(设置/关于;开始/暂停共用) ----
      if (panel === 'settings') {
        if (hit(p, UI.settings.bgmBtn)) { toggleBgm(); return; }
        if (hit(p, UI.settings.sfxBtn)) { toggleSfx(); return; }
        if (hit(p, UI.settings.fxBtn)) { toggleFx(); return; }
        if (hit(p, UI.settings.closeBtn)) { panel = null; sfx.item(); return; }
        return;
      }
      if (panel === 'about') {
        if (hit(p, UI.about.closeBtn)) { panel = null; sfx.item(); return; }
        return;
      }
      // ---- 01 开始界面 ----
      if (screen === 'start') {
        if (hit(p, UI.start.playBtn)) { screen = 'menu'; sfx.item(); return; }
        if (hit(p, UI.start.settingsBtn)) { panel = 'settings'; sfx.item(); return; }
        if (hit(p, UI.start.aboutBtn)) { panel = 'about'; sfx.item(); return; }
        return;
      }
      // ---- 02 选关界面 ----
      if (screen === 'menu') {
        if (growPanel) { handleGrowClick(p); return; }
        if (hit(p, UI.menu.backBtn)) { screen = 'start'; sfx.item(); return; }
        if (hit(p, UI.menu.growBtn)) { growPanel = true; sfx.item(); return; }
        for (let L = 1; L <= 5; L++) {
          if (hit(p, cardBtnOf(L))) {
            if (!canPlay(progress, L)) { showToast('关卡未解锁'); sfx.invalid(); return; }
            openLoadout(L); sfx.item();
            return;
          }
        }
        return;
      }
      // ---- 03 备战界面 ----
      if (screen === 'loadout') {
        // M11-06:换装列表面板(槽位「更换」打开)——命中优先于主界面
        if (panel === 'skillPick') {
          if (hit(p, UI.loadout.pickCloseBtn)) { panel = null; sfx.item(); return; }
          const rows = uiPickRows(profile.loadout, profile.ownedSkills, profile.level);
          for (const { sk, rect, unlocked } of rows) {
            if (!hit(p, rect)) continue;
            if (!unlocked) {
              showToast(profile.ownedSkills.includes(sk.id) ? `Lv.${sk.unlockLevel} 解锁` : '未拥有该技能(养成抽卡获取)');
              sfx.invalid(); return;
            }
            caster.loadout[pickSlot] = sk.id;
            persistProfile(); // 装配变更写档(D13)
            panel = null;
            selSlot = pickSlot;
            showToast(`槽位 ${pickSlot + 1} 换装 → ${sk.name}(立即生效)`);
            sfx.item();
            return;
          }
          return; // 面板外点击不穿透
        }
        // M11-06:技能 tips 浮层(长按槽位打开)——点按任意处关闭
        if (panel === 'skillTips') { panel = null; sfx.item(); return; }
        if (hit(p, UI.loadout.backBtn)) { screen = 'menu'; sfx.item(); return; }
        // M11-06:槽右上角「更换」按钮 → 打开换装列表(先于槽选中判定)
        for (let i = 0; i < 4; i++) {
          if (hit(p, uiSlotSwapBtn(i)) && profile.loadout[i]) {
            pickSlot = i; panel = 'skillPick'; sfx.item(); return;
          }
        }
        for (let i = 0; i < 4; i++) {
          if (hit(p, slotRectOf(i))) { selSlot = i; sfx.item(); return; }
        }
        for (let i = 0; i < SKILL_LIBRARY.length; i++) {
          if (!hit(p, libRectOf(i))) continue;
          const sk = SKILL_LIBRARY[i];
          if (sk.unlockLevel > profile.level) { showToast(`Lv.${sk.unlockLevel} 解锁`); sfx.invalid(); return; }
          // M11-02 F4:拥有制门控(与 cast.js 释放条件一致——未拥有的技能装槽后该槽无输出;
          // 战斗联动栏 cycleSlot 已按 owned 过滤,此处补备战入口)
          if (!profile.ownedSkills.includes(sk.id)) { showToast('未拥有该技能(养成抽卡获取)'); sfx.invalid(); return; }
          if (caster.loadout.includes(sk.id) && caster.loadout[selSlot] !== sk.id) { showToast('该技能已装配'); sfx.invalid(); return; }
          caster.loadout[selSlot] = sk.id;
          persistProfile(); // 装配变更写档(D13)
          showToast(`槽位 ${selSlot + 1} 换装 → ${sk.name}(立即生效)`);
          sfx.item();
          return;
        }
        if (hit(p, UI.loadout.fightBtn)) { startLevel(selLevel); sfx.item(); return; }
        return;
      }
      // ---- 战斗中:暂停面板 ----
      if (paused) {
        if (hit(p, UI.pause.resumeBtn)) { paused = false; sfx.item(); return; }
        if (hit(p, UI.pause.bgmBtn)) { toggleBgm(); return; }
        if (hit(p, UI.pause.sfxBtn)) { toggleSfx(); return; }
        if (hit(p, UI.pause.fxBtn)) { toggleFx(); return; }
        if (hit(p, UI.pause.quitBtn)) { paused = false; panel = null; screen = 'menu'; sfx.item(); return; }
        return;
      }
      // ---- 05 结算(胜利/失败按钮组;M11 重做) ----
      if (battle.phase !== 'FIGHTING') {
        if (battle.phase === 'VICTORY') {
          const R = UI.result.victory;
          if (hit(p, R.mainBtn)) {
            if (battle.level >= 5) { screen = 'menu'; } // 第 5 关通关:完成返回
            else startLevel(battle.level + 1); // 下一关(通关已解锁 L+1)
            sfx.item(); return;
          }
          if (hit(p, R.retryBtn)) { retryLevel(); sfx.item(); return; }
          if (hit(p, R.backBtn)) { screen = 'menu'; sfx.item(); return; }
        } else {
          const R = UI.result.defeat;
          if (hit(p, R.mainBtn)) { retryLevel(); sfx.item(); return; } // 再战一次(第 1 波重来)
          if (hit(p, R.loadoutBtn)) { openLoadout(battle.level); sfx.item(); return; } // 去备战
          if (hit(p, R.backBtn)) { screen = 'menu'; sfx.item(); return; }
        }
        return;
      }
      // ---- 战斗中:底栏 ⏸/⚙ + 联动栏换装(FR-3.3) ----
      // ⚙ 设置=暂停+设置面板(render 路由:playing 屏设置面板随 paused 绘制;关闭→暂停浮层→继续)
      if (hit(p, UI.battle.pauseBtn)) { paused = true; sfx.item(); return; }
      if (hit(p, UI.battle.settingsBtn)) { paused = true; panel = 'settings'; sfx.item(); return; }
      // M13:联动栏(448~504)已移除——装配槽迁至战斗区右下技能框(纯展示,CD 自动释放);
      // 换装唯一入口=备战界面换装列表面板(M11-06)
    },
    onSwipe: (a, b) => {
      if (screen !== 'playing' || battle.phase !== 'FIGHTING' || paused) return; // 非战斗/暂停期间棋盘输入冻结
      if (engine.trySwap(a, b)) { sfx.swap(); } // 需求方 2026-10-18:「交换」提示移除
      else sfx.invalid();
    },
    onCellDown: () => {},
    onTap: (cell) => {
      if (screen !== 'playing' || battle.phase !== 'FIGHTING' || paused) return;
      // M9/M11 修订:忙态放行点选(RESOLVING/FALLING 任意交换/道具点击由 engine 承接);
      // 瘫痪仍丢弃
      if (engine.paralyzed) return;
      // 弹回中的 a/b 两格锁定(F7 续审:只锁回弹格,其他格照常)
      if (nudgeLock(cell)) return;
      // 道具点击优先(道具格不参与点选交换;M11 演出期也可点,engine.tapItem 自拦瘫痪)
      const it = engine.grid[cell.r]?.[cell.c];
      if (it && it.item !== undefined) {
        const item = engine.tapItem(cell);
        if (!item) return;
        // M5:道具效果接入战斗(02 文档第 6 节;数值由 items.applyItem 统一口径)
        const fx = applyItem(item, { maxHP: battle.maxHp });
        if (fx.kind === 'heal') {
          const before = battle.hp;
          battle.hp = Math.min(battle.maxHp, battle.hp + fx.amount);
          showToast(`回血 +${battle.hp - before}`);
        } else if (fx.kind === 'invincible') {
          battle.invincibleT = fx.seconds;
          showToast(`无敌 ${fx.seconds}s`);
        } else if (fx.kind === 'cd') {
          caster.setCdBoost(fx.seconds, fx.rate);
          showToast(`CD 加速 ×${fx.rate}(${fx.seconds}s)`);
        }
        sfx.item();
        return;
      }
      // 点选交换(02 文档 2.1 两种输入并存):点 A 再点相邻 B → 尝试交换;
      // 无效 → A/B 原位弹回动画(engine.nudge,REQ-M6-04 F7 续审)+ 音效,棋盘状态不变
      if (firstSel) {
        const a = firstSel;
        firstSel = null;
        if (Math.abs(a.r - cell.r) + Math.abs(a.c - cell.c) === 1) {
          if (engine.trySwap(a, cell)) {
            sfx.swap(); // 需求方 2026-10-18:「交换」提示移除
          } else {
            engine.nudge(a, cell); // 表现层往返回弹(逻辑状态保持 IDLE,F7 续审)
            sfx.invalid(); // 无效交换:棋盘状态不变(02 文档 2.3)
          }
          return;
        }
        // 非相邻格:重新选中该格
      }
      if (it && it.el !== undefined) firstSel = cell;
    },
  });

  // 养成面板点击处理(FR-10;布局与 render.drawGrowPanel/GROW_LAYOUT 一致,F9 两列 8 行)
  function handleGrowClick(p) {
    const inRect = (x, y, w, h) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
    if (inRect(60, 960, 600, 60)) { growPanel = false; sfx.item(); return; } // 关闭
    if (inRect(80, 300, 560, 64)) { // 角色升级
      const r = applyLevelUp(profile);
      if (r) { persistProfile(); showToast(`角色升级 →Lv${r.level}(材料 −${r.cost})`); sfx.item(); }
      else showToast('材料不足');
      return;
    }
    if (inRect(80, 380, 560, 64)) { // 抽卡(满池由 gacha 返回 null 拒绝)
      const r = gacha(profile, elimRng);
      if (r === null) { showToast('技能已全部拥有'); return; }
      if (r.error) { showToast('货币不足(100 币/抽)'); return; }
      caster.owned = [...r.owned]; // 抽到技能立即入拥有表(消除链即可随机选中)
      persistProfile();
      showToast(`抽得 ${skillById(r.skillId)?.name || r.skillId}!`); sfx.item();
      return;
    }
    // 技能升级列表(两列 8 行:列 x0=70/375,行顶 506+r×46,升级按钮=列 x0+180 起 70×36)
    const L = GROW_LAYOUT;
    for (let col = 0; col < 2; col++) {
      for (let row = 0; row < L.perCol; row++) {
        const idx = col * L.perCol + row;
        if (idx >= profile.ownedSkills.length) break;
        const bx = L.cols[col] + L.btnOff, by = L.listY + row * L.rowH + 5;
        if (!inRect(bx, by, L.btnW, L.btnH)) continue;
        const id = profile.ownedSkills[idx];
        if (!id) return;
        const r = applySkillUp(profile, id);
        if (r) { persistProfile(); caster.skillLevels[id] = r.level; showToast(`${skillById(id)?.name || id} →Lv${r.level}(材料 −${r.cost})`); sfx.item(); }
        else showToast(skillById(id) && (profile.skillLevels[id] || 1) >= SKILL_LEVEL_CAP ? '已达满级' : '材料不足');
        return;
      }
    }
  }

  let prevShakeT = 0; // 上一帧 battle.shakeT(边沿触发,避免每帧重置震动延长时长)
  // firstSel 已提升到模块顶层(M11-03 F9:startLevel/retryLevel 需清除输入态,避免旧局点选带入新局)
  startLoop(
    (dt) => {
      // M11:暂停门控(底栏 ⏸)——冻结模拟推进,仅保留输入(继续/设置按钮)与渲染
      if (screen === 'playing' && paused) {
        input.update(dt);
        return;
      }
      // M11-06:非战斗屏也推输入层(备战技能槽长按计时;手势作废观察无害)
      if (screen !== 'playing') { input.update(dt); parallax.update(dt); return; } // 非战斗屏只推背景动效
      // FR-3.3 局界契约(REQ-M6-05 F3):引擎推进/事件入池/技能释放以 FIGHTING 为门控;
      // **帧内终局**(battle.update 本帧转 DEFEAT/VICTORY)后不再消费事件/建预约/释放——
      // 以 battle.update 之后的实时相位为准;终局即时清空与棋盘收口见下方结算分支
      caster.update(dt);
      battle.update(dt);   // 同刻顺序①②③:命中→跳伤→敌方行动/主角受击(每帧仅此一次,F15)
      if (battle.phase === 'FIGHTING') {
        engine.update(dt);
        // 事件消费(REQ-M6-04 F2):**逐事件**充能+选技建预约(reserveFor),
        // 同轮多事件绝不合并;全部事件处理完后下方统一 caster.tick 仲裁执行
        for (const e of engine.drainEvents()) {
          if (e.type === 'match_cleared') {
            clearedTotal += e.count; // FR-7 底栏消除计数
            if (e.chain > maxChain) maxChain = e.chain; // M11:最高连锁统计(结算展示)
            charge.feed({ ...e, t: battle.clock }); // 消除充能(t0=演出起点,03 文档 4.0;档位提示已按需求方口径移除,不再展示 gain)
            // 逐事件选技+原子建预约(F2);回填本块实际预约结果供段③图标按块显示(F8)
            // resKey=预约唯一 id(REQ-08 F8):入口/存续回写/执行记录三路幂等互认,不重复认领
            const p = caster.reserveFor(e.element, elimRng, battle.clock);
            if (p) {
              p.round = engine.roundSeq; // 盖章所属轮(跨轮存续预约不得认领新轮块)
              // M9-F2:execFloor 已在 reserveFor 内组装(t0+floor 随档位留池保存——最早被占用
              // 档位所属轮的段④起点,延迟选技/跨轮留池不丢失;main 不再按当前事件补写)
              engine.setBlockFx(e.bk, { el: e.element, reserved: true, skillId: p.skillId, tier: p.tier, resKey: p.id });
            }
            // 需求方 2026-10-18:「元素 ×N → 档位」消除方块提示不再显示(档位信息由技能框/播报承载)
            sfx.match(e.chain);
            if (engine.fxEnabled) hud.fx.onMatchCleared(e, e.chain); // REQ-M6-04 F8:关动效不触发粒子
          }
          if (e.type === 'board_paralyzed') showToast('棋盘瘫痪');
          if (e.type === 'chain_announce' && engine.fxEnabled) hud.fx.chainAnnounce(e.chain); // M9 连锁播报(与 6.1 同步关闭口径:fx 关不播报)
        }
        // 同刻顺序④(M6 双链路,03 文档 4.0):caster.tick 仲裁(主角链合并/并发→消除链到期执行)
        // 子弹类已在 caster 内经 ctx.launch 同一提交发射(F6);无存活敌人执行挂起(预约保留)
        const usedList = caster.tick(battle, battle.aliveEnemies().length > 0, elimRng);
        // 表现绑定(REQ-M6-07/08 F8,engine.claimBlockFx 幂等认领):消除链执行记录与
        // 存续预约回写 blockFx——含「预约建立后同帧即执行移除」的场景(0.80s CD 就绪,
        // 渲染层查不到 pending,必须按 tick 的执行记录认领);同一 resKey 重复回写不扩散。
        for (const used of usedList) {
          parallax.triggerPulse();
          // M12 技能喊话(方案 B「冲击斜切」):非普攻属性弹技能执行即触发纯表现演出(~0.9s,
          // 不阻塞逻辑);背景变体按解锁档位取用(Lv3→1,Lv6→2);震屏走 parallax 可变参数。
          // M12M13-ACCEPT F3:skillCall 返回 false(演出中/CD 期被忽略)时**不震屏**——
          // CD 期整体忽略,不是只忽略画面。
          if (used.skill.kind !== 'bolt' && engine.fxEnabled !== false) {
            if (hud.fx.skillCall(used.skill.name, used.skill.el, used.skill.unlockLevel >= 6 ? 2 : 1)) {
              parallax.triggerShake(5, 0.35);
            }
          }
          // 执行记录认领(幂等 resKey)仅限预约所属轮=当前轮(轮次关系,REQ-08 F8);
          // resRound undefined=预约本帧阶段2新建即执行(未经 pending 回写盖章)→ 视为本轮
          if (used.from === 'elim' && (used.resRound === undefined || used.resRound === engine.roundSeq)) {
            engine.claimBlockFx(used.skill.el, used.skill.id, used.tier, used.resKey);
          }
        }
        for (const p of caster.pending) {
          if (p.round === undefined) p.round = engine.roundSeq; // tick 阶段2新建预约首见盖章
          if (p.round === engine.roundSeq) engine.claimBlockFx(p.el, p.skillId, p.tier, p.id); // 跨轮预约不认领新块
        }
      }
      // M6 v0.2 经济入账(03 文档 2.2;REQ-M6-06 F13):**相位无关**——
      // 终局帧(最后一杀使本帧转 VICTORY/DEFEAT)的击杀收益也必须结清入档,
      // 再进入下方结算持久化(否则首关 Boss 同帧通关少记 240 币/20 材料)
      if (battle.coinsGained > coinsSeen) { profile.coins += battle.coinsGained - coinsSeen; coinsSeen = battle.coinsGained; }
      if (battle.matsGained > matsSeen) { profile.materials += battle.matsGained - matsSeen; matsSeen = battle.matsGained; }
      // v0.3 伤害冒字(03 文档 6.5):**相位无关**转发(终局帧击杀/受击的冒字照常)——
      // battle 事件队列→fx 层;fxEnabled=false 时事件照样排空仅不绘制(6.1 同步关闭口径)
      for (const ev of battle.drainFloatTexts()) {
        if (engine.fxEnabled) hud.fx.combatFloat(ev);
      }
      // M4 FR-6:通关结算(解锁 L+1/写进度档/submitRun);失败不扣任何档内字段(D14)
      if ((battle.phase === 'VICTORY' || battle.phase === 'DEFEAT') && !victoryHandled) {
        // 终局即时清空(REQ-M6-05 F3,03 文档 4.0):池/预约/CD/临时状态立即归零,
        // 未消费事件丢弃(终局后不再充能),棋盘未完成轮次快进收口到 IDLE(重试不留旧局残轮)
        caster.resetForNewLevel();
        hud.fx.clearCall(); // M12:旧局喊话演出不残留
        caster.resetTempState();
        engine.drainEvents();
        let ffGuard = 0;
        while (engine.state !== 'IDLE' && !engine.paralyzed && ffGuard++ < 3600) {
          engine.update(1 / 60);
          engine.drainEvents(); // 快进期间的消除事件一律丢弃
        }
        persistProfile(); // 整改 F4:未升级的经验也写入档案,重载不丢收益
      }
      if (battle.phase === 'VICTORY' && !victoryHandled) {
        victoryHandled = true;
        const vr = victoryReward(battle.level); // M6 v0.2 通关产出(货币 50×L/材料 10×L,03 文档 2.2)
        // REQ-M6-04 F4:通关奖励**先入档再持久化**——persistProfile(下帧触发)须含 vr,
        // 刷新后不丢 50×L/10×L;弹层展示含通关奖励(见 render)
        profile.coins += vr.coins; profile.materials += vr.mats;
        battle.victoryCoins = vr.coins; battle.victoryMats = vr.mats;
        persistProfile();
        const { progress: p2 } = onVictory(progress, battle.level);
        progress = p2;
        api.submitRun({ level: battle.level, victory: true, coins: battle.coinsGained + vr.coins, mats: battle.matsGained + vr.mats, kills: battle.kills })
          .then(res => { // 只回写 lastLevelCleared 且只增不减(F5 异步回归:乱序迟到回包不覆盖较新记录)
            progress = mergeRunResult(progress, res);
          });
      } else if (battle.phase === 'DEFEAT' && !victoryHandled) {
        victoryHandled = true;
        api.submitRun({ level: battle.level, victory: false, coins: battle.coinsGained, mats: battle.matsGained, kills: battle.kills });
      }
      // 失败/通关重试后允许再次结算(F3:victoryHandled 必须复位)
      if (battle.phase === 'FIGHTING') victoryHandled = false;
      // 换波同步视差与受击 screenshake
      if (battle.wave !== lastWave) {
        lastWave = battle.wave;
        parallax.setWave(battle.wave, battle.wave === 10);
      }
      // screenshake 边沿触发:battle.shakeT 从 0 变正(新一次受击)才 triggerShake,
      // 不再每帧重置(REQ-M3-03 整改 7:此前震动被反复续时,150ms 仍有偏移)
      if (battle.shakeT > 0 && prevShakeT <= 0) parallax.triggerShake();
      prevShakeT = battle.shakeT;
      if (screen === 'playing') input.update(dt); // 果冻拖拽回弹计时(表现层)
      hud.drag = () => input.dragState();
      parallax.update(dt);
      hud.fx.update(dt);
      hud.battleHud.update(dt, hud, engine.fxEnabled !== false); // M13 二段血条/波次进度推进
      updateEnemyHealthViews(dt, battle, engine.fxEnabled !== false); // M13 03轮 F9:敌人双血条按实际 dt 推进(与 battleHud 同刻;paused 时主循环提前 return 不达此处)
      // M14:BGM 局内战斗播控(playing 且非暂停/终局出声;幂等调用,screen 变化即生效)
      bgm.sync(screen === 'playing' && !paused && battle.phase === 'FIGHTING');
      if (hud.toast) { hud.toast.t -= dt; if (hud.toast.t <= 0) hud.toast = null; }
    },
    () => render(canvas.getContext('2d'), engine, hud),
  );
}

// 调试/验证句柄(只读状态;CDP 验证与自动化测试用)
window.__ssww = {
  engine, charge, caster, battle, parallax,
  profile: () => profile, progress: () => progress, screen: () => screen,
  startLevel, toast: () => (hud.toast ? hud.toast.text : null), swapCreatesMatch,
  // M11 五屏导航与状态(CDP 驱动;仅改 UI 态,不写档)
  nav: (s) => { if (['start', 'menu', 'loadout', 'playing'].includes(s)) screen = s; },
  fx: () => hud.fx, // M12 调试句柄(CDP 触发喊话演出验证;只读转发)
  battleHud: () => hud.battleHud, // M13 调试句柄(CDP 读快照验证 Boss 显隐/Lv 徽标;只读转发)
  openLoadout, uiState: () => ({ screen, selLevel, selSlot, panel, paused, maxChain }),
  imagesBound: () => window.__sswwImagesBound ?? 0, // M11-02 F1:预载→渲染绑定数(CDP 校验)
  sfxEnabled: () => sfx.enabled, // M11-02 F5:音效开关实时态(CDP 验证刷新恢复)
  toggleSfx, toggleFx, setPaused: (v) => { paused = !!v; },
};
