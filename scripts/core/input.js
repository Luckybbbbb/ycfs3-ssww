// scripts/core/input.js
// 触屏/鼠标统一输入：拖动交换（按下→滑过相邻格）+ 点选交换 + 道具点击
// 事件坐标转换为 720×1280 逻辑坐标后回调
// 相对路径: scripts/core/input.js

export function attachInput(canvas, handlers) {
  let downCell = null;   // 按下时的格子 {r,c}（棋盘坐标）
  let downXY = null;     // 按下逻辑坐标
  let moved = false;

  function toLogical(e) {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / 720;
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  function cellAt(x, y, origin, cell) {
    const c = Math.floor((x - origin.x) / cell);
    const r = Math.floor((y - origin.y) / cell);
    if (r < 0 || c < 0 || r >= 8 || c >= 8) return null;
    return { r, c };
  }

  function pos(e) { return e.touches ? e.touches[0] : e; }

  function onDown(e) {
    const p = toLogical(pos(e));
    const cell = handlers.cellAt ? handlers.cellAt(p.x, p.y) : null;
    downXY = p;
    downCell = cell;
    moved = false;
    if (cell) handlers.onCellDown(cell, p);
    e.preventDefault();
  }
  function onMove(e) {
    if (!downXY) return;
    const p = toLogical(pos(e));
    if (Math.hypot(p.x - downXY.x, p.y - downXY.y) > 12) moved = true;
    if (downCell && moved) {
      const cell = handlers.cellAt ? handlers.cellAt(p.x, p.y) : null;
      // 滑到相邻格 → 触发拖动交换并结束本次手势
      if (cell && Math.abs(cell.r - downCell.r) + Math.abs(cell.c - downCell.c) === 1) {
        handlers.onSwipe(downCell, cell);
        downCell = null; downXY = null;
      }
    }
    e.preventDefault();
  }
  function onUp(e) {
    if (downCell && !moved) handlers.onTap(downCell);
    downCell = null; downXY = null;
    e.preventDefault();
  }

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onUp, { passive: false });
}
