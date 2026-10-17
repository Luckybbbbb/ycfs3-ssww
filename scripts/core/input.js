// scripts/core/input.js
// 触屏/鼠标统一输入：果冻拖拽(M6/v0.2)+ 点选交换 + 道具点击
// 果冻拖拽(02 文档 2.1~2.3):任意方块按下即可拖动;跟手位移=指针位移×0.5 钳 40px(渲染层消费);
// 拖过半格 45px 朝相邻格 → tryDragSwap 预判定(有效=交换流程,无效=继续跟手,松手回弹);
// 点选(A→相邻 B)并存。逻辑状态机不变——无效交换从不进入 SWAPPING,回弹是表现层行为。
// 事件坐标转换为 720×1280 逻辑坐标后回调
// 相对路径: scripts/core/input.js

export const DRAG_HALF_CELL = 45;  // 触发交换判定的位移阈值(半格)
export const BOUNCE_MS = 160;      // 回弹动画时长(表现层,02 文档 2.2)
export const LONGPRESS_MS = 500;   // 长按触发阈值(备战技能槽 tips;位移超 12px 视为拖拽取消)

export function attachInput(canvas, handlers) {
  let downCell = null;   // 按下时的格子 {r,c}（棋盘坐标）
  let downXY = null;     // 按下逻辑坐标
  let downT = 0;         // 按下时刻(长按计时)
  let longPressFired = false; // 本次手势长按已触发(触发后松手不再当 tap)
  let moved = false;
  let curXY = null;      // 当前指针逻辑坐标(拖拽跟手用)
  let bounces = [];      // 回弹状态数组 [{r, c, fromX, fromY, t}](表现层;**分别保存**——A 回弹不影响 B 拖拽,F7)
  let gestureVoid = false; // 手势期间进入忙态 → 作废(F7:忙态跨越后手势不得在松手/恢复 IDLE 后重新生效)

  function toLogical(e) {
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / 720;
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }

  function pos(e) { return e.touches ? e.touches[0] : e; }

  // 拖拽/回弹视觉状态(渲染层每帧读取):返回 {drag, bounces}——
  // drag=当前手势跟手信息;bounces=所有进行中的回弹(各自独立,REQ-M6-06 F7)
  function dragState() {
    const out = [];
    for (const b of bounces) {
      const p = 1 - Math.max(0, b.t) / BOUNCE_MS;
      // easeOutBack:过冲 ~10% 后归位(02 文档 2.2 回弹动画)
      const c1 = 1.70158, c3 = c1 + 1;
      const e = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
      out.push({ cell: { r: b.r, c: b.c }, dx: b.fromX * (1 - e), dy: b.fromY * (1 - e), progress: p });
    }
    let drag = null;
    if (downCell && curXY && moved) {
      // 跟手位移 = 指针位移 × 0.5,钳制 40px(果冻弹性绳,02 文档 2.2)
      let dx = (curXY.x - downXY.x) * 0.5;
      let dy = (curXY.y - downXY.y) * 0.5;
      const len = Math.hypot(dx, dy);
      if (len > 40) { dx *= 40 / len; dy *= 40 / len; }
      drag = { cell: downCell, dx, dy, phase: 'drag', progress: len / 40 };
    }
    return { drag, bounces: out };
  }

  function onDown(e) {
    const p = toLogical(pos(e));
    // 全屏弹层(胜负结算/选关)接管:所有按下都路由到 onBlankDown,不落到棋盘格
    if (handlers.interceptDown && handlers.interceptDown()) {
      downCell = null; downXY = p; downT = performance.now(); longPressFired = false;
      moved = false; curXY = p; gestureVoid = false;
      if (handlers.onBlankDown) handlers.onBlankDown(p);
      e.preventDefault();
      return;
    }
    const cell = handlers.cellAt ? handlers.cellAt(p.x, p.y) : null;
    // 回弹格锁定(F7 续审:只锁回弹中的那些格,其他格照常可按下/拖拽/点选)
    if (cell && bounces.some(b => b.r === cell.r && b.c === cell.c)) {
      e.preventDefault();
      return;
    }
    // 忙态丢弃整次手势(F7 续审:M9 修订——「演出期可操作」忙态(RESOLVING/FALLING 等,
    // canActInBusy()=true)放行手势,由引擎决定并行交换或预输入缓冲;仅「不可操作忙态」
    // (瘫痪等)仍丢弃。F7 的「跨忙态不复活」语义保留:跨越进不可操作忙态仍作废。
    if (handlers.busy && handlers.busy() && !(handlers.canActInBusy && handlers.canActInBusy())) {
      downCell = null; downXY = null; moved = false; curXY = null; gestureVoid = false;
      e.preventDefault();
      return;
    }
    downXY = p; curXY = p;
    downCell = cell;
    downT = performance.now();
    longPressFired = false;
    moved = false;
    gestureVoid = false;
    if (cell && handlers.onCellDown) handlers.onCellDown(cell, p);
    else if (handlers.onBlankDown) handlers.onBlankDown(p); // 非棋盘区(联动栏等)
    e.preventDefault();
  }

  function onMove(e) {
    if (!downXY) return;
    const p = toLogical(pos(e));
    curXY = p;
    if (Math.hypot(p.x - downXY.x, p.y - downXY.y) > 12) moved = true;
    // 手势进行中引擎进入「不可操作忙态」→ 作废本次手势的预判定(M9:演出期可操作忙态
    // 不作废——RESOLVING 并行交换/FALLING 预输入都由引擎 trySwap 分支承接)
    const busyBlocked = () => handlers.busy && handlers.busy() && !(handlers.canActInBusy && handlers.canActInBusy());
    if (busyBlocked()) gestureVoid = true;
    if (downCell && moved && !gestureVoid) {
      // 果冻拖拽:位移越过半格阈值(45px)且指向相邻格 → 预判定交换(02 文档 2.1)
      const dx = p.x - downXY.x, dy = p.y - downXY.y;
      if (Math.hypot(dx, dy) >= DRAG_HALF_CELL) {
        const c = downCell.c + (Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0);
        const r = downCell.r + (Math.abs(dy) > Math.abs(dx) ? Math.sign(dy) : 0);
        const target = (r >= 0 && r < 8 && c >= 0 && c < 8 &&
          Math.abs(r - downCell.r) + Math.abs(c - downCell.c) === 1) ? { r, c } : null;
        if (target && handlers.tryDragSwap) {
          const ok = handlers.tryDragSwap(downCell, target); // 有效→交换流程;无效→false 继续跟手
          if (ok) { downCell = null; downXY = null; curXY = null; e.preventDefault(); return; }
          // 无效:继续跟手(可拖向另一方向再试),松手时经 onDragBounce 启动回弹
        }
      }
    }
    e.preventDefault();
  }

  function onUp(e) {
    // REQ-M6-06 F7:作废手势(忙态跨越)不得在松手/恢复 IDLE 后以点选形式重新生效
    if (downCell && !moved && !gestureVoid && !longPressFired) {
      handlers.onTap(downCell);
    } else if (downCell && moved && curXY) {
      // 松手:无效拖拽回弹(表现层,160ms easeOutBack,渲染层经 dragState().bounces 消费);
      // 回弹起点取**本次手势**的偏移(不再取其他格回弹的残留偏移)
      const st = dragState().drag;
      if (st && Math.hypot(st.dx, st.dy) > 1 && !bounces.some(b => b.r === st.cell.r && b.c === st.cell.c)) {
        bounces.push({ r: st.cell.r, c: st.cell.c, fromX: st.dx, fromY: st.dy, t: BOUNCE_MS });
      }
    }
    downCell = null; downXY = null; curXY = null; gestureVoid = false;
    e.preventDefault();
  }

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onUp, { passive: false });

  return {
    dragState, // 渲染层每帧读取跟手/回弹状态({drag, bounces})
    update(dt) {
      // REQ-M6-07 F7 续审(M9 修订):忙态观察不依赖指针移动——手势存续期间引擎进入
      // **不可操作**忙态(瘫痪等)即作废手势;演出期可操作忙态不作废(由 trySwap 分支承接)
      if (downXY && handlers.busy && handlers.busy() && !(handlers.canActInBusy && handlers.canActInBusy())) gestureVoid = true;
      // 长按(备战技能槽 tips):按住不动 ≥500ms 触发一次;位移超阈/已触发不再发
      if (downXY && !moved && !gestureVoid && !longPressFired &&
          handlers.onLongPress && performance.now() - downT >= LONGPRESS_MS) {
        longPressFired = true;
        handlers.onLongPress(curXY || downXY);
      }
      for (const b of bounces) b.t -= dt * 1000;
      bounces = bounces.filter(b => b.t > 0);
    },
  };
}
