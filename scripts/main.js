// scripts/main.js
// 入口：装配模块、启动主循环（M2：消除→档位充能→技能自动释放→敌人掉血）
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
import { BOARD_Y, CELL, ELEMENTS } from './board/grid.js';

const canvas = document.getElementById('game');
fitCanvas(canvas);
window.addEventListener('resize', () => fitCanvas(canvas));

const engine = new BoardEngine(20260601);
const charge = new Charge();
const caster = new Caster(charge);
// expPerKill = 2 + w_global(04 文档第 3 节);第 1 关第 1 波 w_global=1 → 3
const battle = new Battle({ atk: 10, maxHp: 100, expPerKill: 3 });
battle.spawnWave(6, 30); // 第 1 关第 1 波:6 只 slime,HP=30(04 文档数字例)
const hud = { toast: null, fx: new FxLayer(), charge, caster, battle };

function showToast(text) { hud.toast = { text, t: 1.2 }; }

// 联动栏装配槽点击换装(FR-3.3 最小入口:槽位轮换,立即生效)
const SLOT_HITBOX = (x) => {
  for (let i = 0; i < 4; i++) {
    const sx = 500 + i * 52;
    if (x >= sx && x <= sx + 44) return i;
  }
  return -1;
};

// 输入绑定（cellAt 由渲染坐标反查棋盘格）
attachInput(canvas, {
  cellAt: (x, y) => {
    if (y < BOARD_Y) return null;
    const c = Math.floor(x / CELL), r = Math.floor((y - BOARD_Y) / CELL);
    if (r < 0 || c < 0 || r >= 8 || c >= 8) return null;
    return { r, c };
  },
  onBlankDown: (p) => {
    if (p.y >= 448 && p.y <= 504) {
      const slot = SLOT_HITBOX(p.x);
      if (slot >= 0) {
        const next = caster.cycleSlot(slot);
        showToast(`槽位 ${slot + 1} 换装 → ${next}(立即生效)`);
        sfx.item();
      }
    }
  },
  onSwipe: (a, b) => {
    if (engine.trySwap(a, b)) { showToast('交换'); sfx.swap(); }
    else sfx.invalid();
  },
  onCellDown: () => {},
  onTap: (cell) => {
    const item = engine.tapItem(cell);
    if (item) { showToast('道具生效（效果待 M5 接入战斗）'); sfx.item(); }
  },
});

startLoop(
  (dt) => {
    engine.update(dt);
    caster.update(dt);
    battle.update(dt);   // 同刻顺序①②:命中→跳伤
    // 事件消费:充能(FR-3.1) + 表现层
    for (const e of engine.drainEvents()) {
      if (e.type === 'match_cleared') {
        const gain = charge.feed(e);   // 同刻顺序③的前置:消除充能
        showToast(`${e.element} ×${e.count} 连锁${e.chain} → ${e.element}档 +${gain}`);
        sfx.match(e.chain);
        hud.fx.onMatchCleared(e, e.chain);
      }
      if (e.type === 'board_paralyzed') showToast('棋盘瘫痪');
    }
    // 同刻顺序③:自动释放判定(命中/跳伤之后;目标存活才消耗)
    for (const el of caster.loadout) {
      const r = caster.tryCast(el, battle.aliveEnemies().length > 0);
      if (r) battle.launch(r);
    }
    hud.fx.update(dt);
    if (hud.toast) { hud.toast.t -= dt; if (hud.toast.t <= 0) hud.toast = null; }
    // M2 演示循环:一波杀完重置(M3 接完整波次编排)
    if (battle.aliveEnemies().length === 0 && battle.bolts.length === 0) {
      battle.spawnWave(6, 30);
    }
  },
  () => render(canvas.getContext('2d'), engine, hud),
);

// 调试/验证句柄(只读状态;CDP 验证与自动化测试用)
window.__ssww = { engine, charge, caster, battle };
void ELEMENTS;
