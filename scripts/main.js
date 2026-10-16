// scripts/main.js
// 入口：装配模块、启动主循环(M4:养成接线——经验升级/技能库装配/关卡解锁/存档 + M3 战斗闭环)
// 相对路径: scripts/main.js

import { startLoop } from './core/loop.js';
import { fitCanvas } from './core/layout.js';
import { attachInput } from './core/input.js';
import { BoardEngine } from './board/engine.js';
import { render } from './ui/render.js';
import { FxLayer } from './ui/fx.js';
import { sfx } from './ui/audio.js';
import { Charge } from './skills/charge.js';
import { Caster } from './skills/cast.js';
import { Battle } from './battle/battle.js';
import { Parallax } from './battle/parallax.js';
import { makeRng, BOARD_Y, CELL } from './board/grid.js';
import { fullManifest } from './assets/manifest.js';
import { preload } from './assets/loader.js';
import { createApi } from './api/api.js';
import { applyExp, maxHpAt, atkAt } from './meta/exp.js';
import { canPlay, onVictory } from './meta/levels.js';
import { loadProgress, saveProgress } from './meta/save.js';
import { applyItem } from './board/items.js';

const canvas = document.getElementById('game');
fitCanvas(canvas);
window.addEventListener('resize', () => fitCanvas(canvas));

// ---- M4 局外状态(FR-5/6/8):api 统一读写(本地后端回落 save.js),事件驱动写档 ----
const api = createApi();
const profile = await api.getProfile();
let progress = loadProgress();
let screen = 'menu';          // 'menu' | 'playing'(FR-6 选关入口)
let victoryHandled = false;
let expSeen = 0;              // 已计入 profile 的经验水位(每帧增量入账)
let clearedTotal = 0;         // 本局累计消除格数(FR-7 底栏"消除"计数,startLevel 归零)

const engine = new BoardEngine(20260601);
const charge = new Charge();
const caster = new Caster(charge, profile.loadout, profile.level);
const parallax = new Parallax({ effects: profile.settings.effects !== false });
const battle = new Battle({ atk: atkAt(profile.level), maxHp: maxHpAt(profile.level), rng: makeRng(20260601) });
const hud = { toast: null, fx: new FxLayer(), charge, caster, battle, parallax, screen: () => screen, profile: () => profile, progress: () => progress, cleared: () => clearedTotal };

function showToast(text) { hud.toast = { text, t: 1.2 }; }

function persistProfile() { api.saveProfile({ ...profile, loadout: [...caster.loadout] }); }

// FR-9:启动时按 manifest 校验资源,缺文件报「缺 <路径>(实体:<名>)」并停载
preload(fullManifest())
  .then(() => showToast('资源就绪'))
  .catch(err => {
    document.body.innerHTML = `<pre style="color:#f66;font-size:20px;padding:24px">资源缺失:${err.message}</pre>`;
    throw err;
  });

// 选关按钮命中区(FR-6:5 关横排)
const LEVEL_BUTTONS = Array.from({ length: 5 }, (_, i) => ({ level: i + 1, x: 75 + i * 118, y: 600, w: 100, h: 100 }));

// 联动栏装配槽点击换装(FR-3.3 最小入口:槽位轮换,立即生效;M4 起写档)
const SLOT_HITBOX = (x) => {
  for (let i = 0; i < 4; i++) {
    const sx = 500 + i * 52;
    if (x >= sx && x <= sx + 44) return i;
  }
  return -1;
};

function startLevel(L) {
  if (!canPlay(progress, L)) { showToast('关卡未解锁'); return; }
  battle.atk = atkAt(profile.level);
  battle.maxHp = maxHpAt(profile.level);
  battle.hp = battle.maxHp;
  battle.startLevel(L);
  battle.kills = 0;
  battle.expGained = 0;
  expSeen = 0;
  clearedTotal = 0;
  victoryHandled = false;
  screen = 'playing';
  lastWave = 0;
  parallax.setWave(1, false);
}

// 输入绑定（cellAt 由渲染坐标反查棋盘格）
attachInput(canvas, {
  // M4 路由拦截:选关界面/胜负弹层全屏接管(按钮在棋盘几何区之上)
  interceptDown: () => screen === 'menu' || battle.phase !== 'FIGHTING',
  cellAt: (x, y) => {
    if (y < BOARD_Y) return null;
    const c = Math.floor(x / CELL), r = Math.floor((y - BOARD_Y) / CELL);
    if (r < 0 || c < 0 || r >= 8 || c >= 8) return null;
    return { r, c };
  },
  onBlankDown: (p) => {
    // 选关界面:点击关卡按钮
    if (screen === 'menu') {
      for (const b of LEVEL_BUTTONS) {
        if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
          sfx.item();
          startLevel(b.level);
          return;
        }
      }
      return;
    }
    // 胜负结算弹层:DEFEAT → 重开本关;VICTORY → 返回选关(FR-1.4/FR-6)
    if (battle.phase !== 'FIGHTING') {
      if (battle.phase === 'DEFEAT') {
        battle.restart();
        parallax.setWave(1, false);
      } else {
        screen = 'menu';
      }
      return;
    }
    if (p.y >= 448 && p.y <= 504) {
      const slot = SLOT_HITBOX(p.x);
      if (slot >= 0) {
        const next = caster.cycleSlot(slot);
        persistProfile(); // 装配变更写档(D13)
        showToast(`槽位 ${slot + 1} 换装 → ${next}(立即生效)`);
        sfx.item();
      }
    }
  },
  onSwipe: (a, b) => {
    if (screen !== 'playing') return;
    if (engine.trySwap(a, b)) { showToast('交换'); sfx.swap(); }
    else sfx.invalid();
  },
  onCellDown: () => {},
  onTap: (cell) => {
    if (screen !== 'playing') return;
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
  },
});

let lastWave = 0;
startLoop(
  (dt) => {
    if (screen !== 'playing') { parallax.update(dt); return; } // 选关界面只推背景动效
    engine.update(dt);
    caster.update(dt);
    battle.update(dt);   // 同刻顺序①②③:命中→跳伤→敌方行动/主角受击
    // 事件消费:充能(FR-3.1) + 表现层
    for (const e of engine.drainEvents()) {
      if (e.type === 'match_cleared') {
        clearedTotal += e.count; // FR-7 底栏消除计数
        const gain = charge.feed(e);
        showToast(`${e.element} ×${e.count} 连锁${e.chain} → ${e.element}档 +${gain}`);
        sfx.match(e.chain);
        hud.fx.onMatchCleared(e, e.chain);
      }
      if (e.type === 'board_paralyzed') showToast('棋盘瘫痪');
    }
    // 同刻顺序④:自动释放判定(命中/跳伤之后;目标存活才消耗)
    for (const el of ['fire', 'water', 'wood', 'metal', 'earth']) {
      const r = caster.tryCast(el, battle.aliveEnemies().length > 0, battle);
      if (!r) continue;
      parallax.triggerPulse();
      if (r.kind === 'bolt') battle.launch(r); // 子弹类走弹道/形态(4.2);非子弹类已在 tryCast 内经 behaviors 生效
    }
    // M4 FR-5:经验入账 → 升级(即时回满/属性成长/写档)
    if (battle.expGained > expSeen) {
      const gained = battle.expGained - expSeen;
      expSeen = battle.expGained;
      const before = profile.level;
      const next = applyExp(profile, gained);
      profile.level = next.level; profile.expTotal = next.expTotal; profile.hp = next.hp;
      if (next.leveledUp) {
        battle.atk = atkAt(profile.level);
        battle.maxHp = maxHpAt(profile.level);
        battle.hp = next.hp; // 升级即时回满(FR-5)
        caster.setLevel(profile.level);
        showToast(`升级!Lv${before} → Lv${profile.level}(HP/ATK 成长)`);
        persistProfile();
      }
    }
    // M4 FR-6:通关结算(解锁 L+1/写进度档/submitRun);失败不扣任何档内字段(D14)
    if (battle.phase === 'VICTORY' && !victoryHandled) {
      victoryHandled = true;
      const { progress: p2 } = onVictory(progress, battle.level);
      progress = p2;
      saveProgress(localStorage, progress);
      api.submitRun({ level: battle.level, victory: true, expGained: battle.expGained, kills: battle.kills });
    } else if (battle.phase === 'DEFEAT' && !victoryHandled) {
      victoryHandled = true;
      api.submitRun({ level: battle.level, victory: false, expGained: battle.expGained, kills: battle.kills });
    }
    // 换波同步视差与受击 screenshake
    if (battle.wave !== lastWave) {
      lastWave = battle.wave;
      parallax.setWave(battle.wave, battle.wave === 10);
    }
    if (battle.shakeT > 0) parallax.triggerShake();
    parallax.update(dt);
    hud.fx.update(dt);
    if (hud.toast) { hud.toast.t -= dt; if (hud.toast.t <= 0) hud.toast = null; }
  },
  () => render(canvas.getContext('2d'), engine, hud),
);

// 调试/验证句柄(只读状态;CDP 验证与自动化测试用)
window.__ssww = { engine, charge, caster, battle, parallax, profile: () => profile, progress: () => progress, screen: () => screen, startLevel };
