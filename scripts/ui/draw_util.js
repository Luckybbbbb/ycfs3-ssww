// scripts/ui/draw_util.js
// 绘制工具:圆角路径;相对路径: scripts/ui/draw_util.js

// 五行元素颜色表(**单一定义源**:弹道弹体与伤害冒字共用,REQ-M7-01 F6;
// render.js GEM_SRC 与 fx.js FT_STYLE 均从本表引用,不得各自硬编码)
export const GEM_COLORS = { metal: '#ccccff', wood: '#44ff44', water: '#4488ff', fire: '#ff4444', earth: '#cc8844' };

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
