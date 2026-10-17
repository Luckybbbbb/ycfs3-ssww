// scripts/ui/draw_util.js
// 绘制工具:圆角路径;相对路径: scripts/ui/draw_util.js

// 五行元素颜色表(**单一定义源**:弹道弹体与伤害冒字共用,REQ-M7-01 F6;
// render.js GEM_SRC 与 fx.js FT_STYLE 均从本表引用,不得各自硬编码)
// 2026-10-17 M8 需求方配色整改:换用 animal-island-ui 主题 token(.tmp/animal-island-ui/src/styles/variables.less
// + demo/gradients.ts)——金=warning 明黄/木=success 草绿/水=island 渐变深蓝/火=error 珊瑚红/土=文字暖棕
export const GEM_COLORS = { metal: '#f5c31c', wood: '#6fba2c', water: '#4aa8cc', fire: '#e05a5a', earth: '#794f27' };

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
