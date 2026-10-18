// scripts/core/loop.js
// 主循环：requestAnimationFrame，update dt 上限 0.05s（对标 extraction-shooters game.js）；
// render 回调接收原始 rAF 时间戳 t（UIV2-01 F4-02 整改:表现层动效时钟与模拟 dt 上限分开——
// 10fps 低帧下 dt 被钳 0.05 会让 2s 动效放慢一倍,表现层动效时钟必须用真实墙钟）
// 相对路径: scripts/core/loop.js

export function startLoop(update, render) {
  let last = performance.now();
  function frame(t) {
    const dt = Math.min((t - last) / 1000, 0.05);
    last = t;
    update(dt);
    render(t);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
