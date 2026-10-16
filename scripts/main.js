// scripts/main.js
// 入口：装配模块、启动主循环(M3:波次/敌人推进/敌方弹幕/胜负结算 + 视差)
// 启动顺序(FR-9):资源预载全部成功后才绑定输入、开波、启动主循环;缺图停载并给诊断。
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

const canvas = document.getElementById('game');
fitCanvas(canvas);
window.addEventListener('resize', () => fitCanvas(canvas));

const engine = new BoardEngine(20260601);
const charge = new Charge();
const caster = new Caster(charge);
const parallax = new Parallax({ effects: true });
// M3:波次经验动态(2+w_global,Boss ×20,05 文档第 5 节);第 1 关开局
const battle = new Battle({ atk: 10, maxHp: 100, level: 1, rng: makeRng(20260601) });
const hud = { toast: null, fx: new FxLayer(), charge, caster, battle, parallax };

function showToast(text) { hud.toast = { text, t: 1.2 }; }

// FR-9:先预载资源;缺文件报「缺 <路径>(实体:<名>)」并停载(不绑定输入、不启动主循环、无未处理拒绝)
let loadError = null;
try {
  await preload(fullManifest());
} catch (err) {
  loadError = err;
}
if (loadError) {
  document.body.innerHTML = `<pre style="color:#f66;font-size:20px;padding:24px">资源缺失:${loadError.message}</pre>`;
} else {
  boot();
}

function boot() {
  showToast('资源就绪');

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
    // 胜负结算弹层全屏接管:所有按下都走 onBlankDown,不落到棋盘(FR-1.4 验收)
    interceptDown: () => battle.phase !== 'FIGHTING',
    cellAt: (x, y) => {
      if (y < BOARD_Y) return null;
      const c = Math.floor(x / CELL), r = Math.floor((y - BOARD_Y) / CELL);
      if (r < 0 || c < 0 || r >= 8 || c >= 8) return null;
      return { r, c };
    },
    onBlankDown: (p) => {
      // 胜负结算弹层:点击任意处重开(FR-1.4:失败从第 1 波重来;05 文档第 6 节)
      if (battle.phase !== 'FIGHTING') { battle.restart(); parallax.setWave(1, false); return; }
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
      if (battle.phase !== 'FIGHTING') return; // 结算弹层期间棋盘输入冻结
      if (engine.trySwap(a, b)) { showToast('交换'); sfx.swap(); }
      else sfx.invalid();
    },
    onCellDown: () => {},
    onTap: (cell) => {
      if (battle.phase !== 'FIGHTING') return;
      const item = engine.tapItem(cell);
      if (item) { showToast('道具生效（效果待 M5 接入战斗）'); sfx.item(); }
    },
  });

  parallax.setWave(1, false);
  battle.startLevel(1);

  let lastWave = 0;
  let prevShakeT = 0; // 上一帧 battle.shakeT(边沿触发,避免每帧重置震动延长时长)
  startLoop(
    (dt) => {
      engine.update(dt);
      caster.update(dt);
      battle.update(dt);   // 同刻顺序①②③:命中→跳伤→敌方行动/主角受击
      // 事件消费:充能(FR-3.1) + 表现层
      for (const e of engine.drainEvents()) {
        if (e.type === 'match_cleared') {
          const gain = charge.feed(e);   // 同刻顺序④的前置:消除充能
          showToast(`${e.element} ×${e.count} 连锁${e.chain} → ${e.element}档 +${gain}`);
          sfx.match(e.chain);
          hud.fx.onMatchCleared(e, e.chain);
        }
        if (e.type === 'board_paralyzed') showToast('棋盘瘫痪');
      }
      // 同刻顺序④:自动释放判定(命中/跳伤之后;目标存活才消耗;结算后不再消耗档位/新增弹)
      if (battle.phase === 'FIGHTING') {
        for (const el of caster.loadout) {
          const r = caster.tryCast(el, battle.aliveEnemies().length > 0);
          if (r) { battle.launch(r); parallax.triggerPulse(); } // 技能释放 zoom pulse(00 文档 3.1)
        }
      }
      // 换波同步视差(晨→昏推移;Boss 波压暗)与受击 screenshake
      if (battle.wave !== lastWave) {
        lastWave = battle.wave;
        parallax.setWave(battle.wave, battle.wave === 10);
      }
      // screenshake 边沿触发:battle.shakeT 从 0 变正(新一次受击)才 triggerShake,
      // 不再每帧重置(REQ-M3-03 整改 7:此前震动被反复续时,150ms 仍有偏移)
      if (battle.shakeT > 0 && prevShakeT <= 0) parallax.triggerShake();
      prevShakeT = battle.shakeT;
      parallax.update(dt);
      hud.fx.update(dt);
      if (hud.toast) { hud.toast.t -= dt; if (hud.toast.t <= 0) hud.toast = null; }
    },
    () => render(canvas.getContext('2d'), engine, hud),
  );
}

// 调试/验证句柄(只读状态;CDP 验证与自动化测试用)
window.__ssww = { engine, charge, caster, battle, parallax };
