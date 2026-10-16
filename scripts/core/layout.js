// scripts/core/layout.js
// 720×1280 逻辑坐标 ↔ 物理像素缩放 + letterbox 居中
// 相对路径: scripts/core/layout.js

export const LOGICAL_W = 720;
export const LOGICAL_H = 1280;

export function fitCanvas(canvas) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(vw / LOGICAL_W, vh / LOGICAL_H);
  canvas.style.width = Math.round(LOGICAL_W * scale) + 'px';
  canvas.style.height = Math.round(LOGICAL_H * scale) + 'px';
  canvas.style.marginTop = Math.round((vh - LOGICAL_H * scale) / 2) + 'px';
  // DPR 渲染精度（上限 2 防止高分屏过载）
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(LOGICAL_W * scale * dpr);
  canvas.height = Math.round(LOGICAL_H * scale * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  return { scale, dpr };
}
