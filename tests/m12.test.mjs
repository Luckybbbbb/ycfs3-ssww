// tests/m12.test.mjs — M12 批次:技能喊话演出(方案 B「冲击斜切」实装)
// 覆盖:manifest 喊话清单/bindCallImages 绑定入口/演出状态机(替换式+自动过期+清场)/
//       无 DOM 环境绘制不抛错(z 序双钩子)/parallax 可变震屏参数
// 运行: node --test tests/m12.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { fullManifest } from '../scripts/assets/manifest.js';
import { FxLayer, bindCallImages, CALL_IMG } from '../scripts/ui/fx.js';
import { Parallax } from '../scripts/battle/parallax.js';

// ---- 录制型 2D context 桩(同 m11 口径;document 未定义 → 离屏画布工厂返回 null,走守卫) ----
function mkCtx() {
  const rec = { fillTexts: [], draws: [], strokes: 0, rects: [], gradStops: [] };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === '__rec') return rec;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'fillText') return (text) => rec.fillTexts.push(String(text));
      if (prop === 'strokeText') return (text) => rec.strokeTexts ?? rec.fillTexts.push(`[stroke]${text}`);
      if (prop === 'drawImage') return (img, ...a) => rec.draws.push({ img: String(img?._src ?? img), a });
      if (prop === 'stroke') return () => { rec.strokes++; };
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set() { return true; },
  });
  return { ctx, rec };
}

// ---- M12-1 资源清单 ----
test('M12 manifest:技能喊话 12 项(立绘+气泡+五行背景×2 变体)入全量清单', () => {
  const m = fullManifest();
  const call = m.filter(it => it.entity === 'skillcall');
  assert.equal(call.length, 12, `喊话条目数=12,实际 ${call.length}`);
  const keys = new Set(call.map(it => it.key));
  assert.ok(keys.has('call:hero') && keys.has('call:bubble'), '立绘+气泡在清单');
  for (const el of ['fire', 'water', 'wood', 'metal', 'earth']) {
    assert.ok(keys.has(`call:bg:${el}:1`) && keys.has(`call:bg:${el}:2`), `五行 ${el} 两变体在清单`);
  }
  for (const it of call) {
    assert.ok(fs.existsSync(new URL(`../${it.url}`, import.meta.url)), `素材文件存在:${it.url}`);
  }
});

test('M12 bindCallImages:生产唯一填充入口,绑定数=12;Map 缺项不抛错', () => {
  const imgs = new Map();
  for (const it of fullManifest().filter(i => i.entity === 'skillcall')) imgs.set(it.key, { _src: it.url });
  assert.equal(bindCallImages(imgs), 12, '12 项全部绑定');
  assert.equal(bindCallImages(null), 0, '非 Map 入参返回 0(不抛错)');
  // 绑定后 fx 内部表就绪
  const fx = new FxLayer();
  fx.skillCall('烈焰环', 'fire', 2);
  assert.ok(fx.call, '喊话状态已建立');
});

// ---- M12-2 演出状态机 ----
test('M12 状态机:skillCall 建立→update 推进→0.85s 自动过期;clearCall 立即清场', () => {
  const fx = new FxLayer();
  fx.skillCall('寒冰锁链', 'water', 1);
  assert.equal(fx.call.name, '寒冰锁链');
  assert.equal(fx.call.el, 'water');
  assert.equal(fx.call.variant, 1);
  fx.update(0.4);
  assert.ok(fx.call && fx.call.t > 0.39, '推进中未过期');
  fx.update(0.4); // 累计 0.8s < 0.85s
  assert.ok(fx.call, '定格+退场期内不提前清');
  fx.update(0.1); // 累计 0.9s ≥ 0.85s
  assert.equal(fx.call, null, '总长(0.50 定格+0.35 退场)后自动过期');
  // clearCall
  fx.skillCall('石甲术', 'earth', 1);
  fx.clearCall();
  assert.equal(fx.call, null, 'clearCall 立即清场(重开/终局口径)');
});

test('M12 替换式→CD 门控(需求方 2026-10-18):2s 内最多 1 次——演出中/CD 期再触发直接忽略', () => {
  const fx = new FxLayer();
  fx.skillCall('烈焰环', 'fire', 2);
  fx.update(0.2); // 演出中
  fx.skillCall('金刃风暴', 'metal', 2);
  assert.equal(fx.call.name, '烈焰环', '演出中再触发:忽略,原演出继续');
  assert.equal(fx.call.t, 0.2, '时间轴不被打断');
  fx.update(0.8); // 演出结束(累计 1.0s),CD 剩 1.0s
  assert.equal(fx.call, null);
  fx.skillCall('裂地脉冲', 'earth', 2);
  assert.equal(fx.call, null, 'CD 期内(剩余 1.0s<2s)再触发:忽略');
  fx.update(1.1); // CD 归零
  fx.skillCall('裂地脉冲', 'earth', 2);
  assert.equal(fx.call.name, '裂地脉冲', 'CD 结束后可再次演出');
  // clearCall 连 CD 一并清(重开/终局不带入)
  fx.clearCall();
  assert.equal(fx.callCdT, 0, 'clearCall 清 CD');
  fx.skillCall('石甲术', 'earth', 1);
  assert.ok(fx.call, '清 CD 后立即可触发');
});

// ---- M12-3 绘制钩子(无 DOM:离屏画布 null 守卫,不抛错;贴图缺省静默跳过) ----
test('M12 绘制:drawCallBg/_drawCallTop 全时间轴采样不抛错;无贴图时零 drawImage', () => {
  const fx = new FxLayer();
  const { ctx, rec } = mkCtx();
  fx.skillCall('烈焰焚天', 'fire', 1);
  // CALL_IMG 为模块级共享单例(前序用例可能已绑定):显式清空保证「未绑定」分支,finally 还原
  const saved = { hero: CALL_IMG.hero, bubble: CALL_IMG.bubble, bg: CALL_IMG.bg };
  CALL_IMG.hero = null; CALL_IMG.bubble = null; CALL_IMG.bg = {};
  try {
    for (let t = 0; t <= 0.9; t += 0.05) { // 全时间轴采样(含入场/定格/退场边界)
      fx.call.t = t;
      fx.drawCallBg(ctx);
      fx.draw(ctx);
    }
    assert.equal(rec.draws.length, 0, '贴图未绑定时不产生 drawImage(静默跳过)');
  } finally {
    CALL_IMG.hero = saved.hero; CALL_IMG.bubble = saved.bubble; CALL_IMG.bg = saved.bg;
  }
  // 绑定贴图后再采样:背景与立绘/气泡按 z 序分别产出
  const imgs = new Map();
  for (const it of fullManifest().filter(i => i.entity === 'skillcall')) imgs.set(it.key, { _src: it.url });
  bindCallImages(imgs);
  const rec2 = mkCtx();
  fx.call.t = 0.4; // 定格段:各元素可见
  fx.drawCallBg(rec2.ctx);
  fx.draw(rec2.ctx);
  assert.ok(rec2.rec.draws.length >= 2, '背景层+顶层(立绘/气泡)均有绘制输出');
});

test('M12 演出不阻塞逻辑:fx.update/draw 不写任何战斗状态(纯表现,技能名/元素/变体只读)', () => {
  const fx = new FxLayer();
  fx.skillCall('裂地脉冲', 'earth', 2);
  const snapshot = JSON.stringify(fx.call);
  const { ctx } = mkCtx();
  fx.update(1 / 60);
  fx.drawCallBg(ctx);
  fx.draw(ctx);
  assert.equal(fx.call.name, '裂地脉冲', '演出推进不篡改喊话载荷');
  assert.notEqual(JSON.stringify(fx.call), snapshot, '仅时间轴推进');
});

// ---- M12-4 parallax 可变震屏 ----
test('M12 parallax:triggerShake(5,0.35) 覆盖幅度/时长;缺省保持受击 4px/0.12s 原口径', () => {
  const px = new Parallax({ effects: true });
  assert.equal(px.shakeAmp, 4);
  assert.equal(px.shakeDur, 0.12);
  px.triggerShake(5, 0.35);
  assert.equal(px.shakeAmp, 5, '喊话砸入幅度 5px');
  assert.equal(px.shakeDur, 0.35, '喊话砸入时长 0.35s');
  assert.ok(px.shakeT > 0, '震屏已激活');
  px.update(0.4);
  assert.ok(px.shakeT <= 0, '震屏按时长衰减归零');
  // 关动效口径:不激活
  const pxOff = new Parallax({ effects: false });
  pxOff.triggerShake(5, 0.35);
  assert.equal(pxOff.shakeT, 0, 'effects=false 震屏不激活(6.1 同步关闭口径)');
});

// ---- M12-5 接线面:main 触发条件(非普攻弹)与变体映射(源码级口径冻结) ----
test('M12 main 接线:usedList 消费环内 kind!=="bolt" 触发喊话+震屏;变体按 unlockLevel 取用', () => {
  const src = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(src.includes("used.skill.kind !== 'bolt'"), '触发门控=非普攻属性弹');
  assert.ok(src.includes('hud.fx.skillCall('), 'main 桥接 fx.skillCall');
  assert.ok(src.includes('parallax.triggerShake(5, 0.35)'), '砸入震屏参数 5px/0.35s');
  assert.ok(src.includes('used.skill.unlockLevel >= 6 ? 2 : 1'), '变体映射:Lv6→2,Lv3→1');
  assert.ok(src.includes('hud.fx.clearCall()'), '重开/终局清喊话演出');
  const rSrc = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(rSrc.includes('hud.fx.drawCallBg(ctx)'), 'render 在战场变换内挂背景层钩子(z 序:场景<背景<敌人)');
});
