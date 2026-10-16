// scripts/main.js
// 入口：装配模块、启动主循环（M1：三消棋盘可玩）
// 相对路径: scripts/main.js

import { startLoop } from './core/loop.js';
import { fitCanvas } from './core/layout.js';
import { attachInput } from './core/input.js';
import { BoardEngine } from './board/engine.js';
import { render } from './ui/render.js';
import { FxLayer } from './ui/fx.js';
import { sfx } from './ui/audio.js';
import { BOARD_Y, CELL } from './board/grid.js';

const canvas = document.getElementById('game');
fitCanvas(canvas);
window.addEventListener('resize', () => fitCanvas(canvas));

const engine = new BoardEngine(20260601);
const hud = { toast: null, fx: new FxLayer() };

function showToast(text) { hud.toast = { text, t: 1.2 }; }

// 输入绑定（cellAt 由渲染坐标反查棋盘格）
attachInput(canvas, {
  cellAt: (x, y) => {
    if (y < BOARD_Y) return null;
    const c = Math.floor(x / CELL), r = Math.floor((y - BOARD_Y) / CELL);
    if (r < 0 || c < 0 || r >= 8 || c >= 8) return null;
    return { r, c };
  },
  onSwipe: (a, b) => {
    if (engine.trySwap(a, b)) { showToast('交换'); sfx.swap(); }
    else sfx.invalid();
  },
  onCellDown: () => {},
  onTap: (cell) => {
    const item = engine.tapItem(cell);
    if (item) { showToast('道具生效（效果待 M2/M3 接入战斗）'); sfx.item(); }
  },
});

startLoop(
  (dt) => {
    engine.update(dt);
    hud.fx.update(dt);
    if (hud.toast) { hud.toast.t -= dt; if (hud.toast.t <= 0) hud.toast = null; }
    // 事件消费示例（M2 接 charge.js；M1 仅提示 + 表现层）
    for (const e of engine.drainEvents()) {
      if (e.type === 'match_cleared') {
        showToast(`${e.element} ×${e.count} 连锁${e.chain}`);
        sfx.match(e.chain);
        hud.fx.onMatchCleared(e, e.chain);
      }
      if (e.type === 'board_paralyzed') showToast('棋盘瘫痪');
    }
  },
  () => render(canvas.getContext('2d'), engine, hud),
);
