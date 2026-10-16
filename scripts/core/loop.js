// scripts/core/loop.js
// 主循环：requestAnimationFrame，dt 上限 0.05s（对标 extraction-shooters game.js）
// 相对路径: scripts/core/loop.js

export function startLoop(update, render) {
  let last = performance.now();
  function frame(t) {
    const dt = Math.min((t - last) / 1000, 0.05);
    last = t;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
