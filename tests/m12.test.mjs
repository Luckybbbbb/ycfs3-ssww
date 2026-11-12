// tests/m12.test.mjs — 技能喊话与战场背景
// 覆盖:manifest 喊话清单/bindCallImages 绑定入口/演出状态机(CD 门控+自动过期+清场)/
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
  const rec = { fillTexts: [], draws: [], strokes: 0, rects: [], gradStops: [], translations: [] };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === '__rec') return rec;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'fillText') return (text) => rec.fillTexts.push(String(text));
      if (prop === 'strokeText') return (text) => rec.strokeTexts ?? rec.fillTexts.push(`[stroke]${text}`);
      if (prop === 'drawImage') return (img, ...a) => rec.draws.push({ img: String(img?._src ?? img), a });
      if (prop === 'translate') return (...args) => rec.translations.push(args);
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
test('M12 manifest:立绘、气泡与五行背景各有对应素材', () => {
  const m = fullManifest();
  const call = m.filter(it => it.entity === 'skillcall');
  assert.equal(call.length, 12);
  const keys = new Set(call.map(it => it.key));
  assert.ok(keys.has('call:hero') && keys.has('call:bubble'));
  for (const el of ['fire', 'water', 'wood', 'metal', 'earth']) {
    assert.ok(keys.has(`call:bg:${el}:1`) && keys.has(`call:bg:${el}:2`), `五行 ${el} 两变体在清单`);
  }
  for (const it of call) {
    assert.ok(fs.existsSync(new URL(`../${it.url}`, import.meta.url)), `素材文件存在:${it.url}`);
  }
});

test('M12 bindCallImages:绑定立绘、气泡与五行背景，缺图安全回退', () => {
  const imgs = new Map();
  for (const it of fullManifest().filter(i => i.entity === 'skillcall')) imgs.set(it.key, { _src: it.url, naturalWidth: 640 });
  assert.equal(bindCallImages(imgs), 12);
  assert.equal(bindCallImages(new Map()), 0);
  assert.deepEqual(CALL_IMG.bg, {}, '切换素材包后清除旧背景');
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
  // M12M13-ACCEPT F3:skillCall 返回 true=已触发 / false=被忽略(调用方据此门控联动震屏)
  assert.equal(fx.skillCall('烈焰环', 'fire', 2), true, '首次触发返回 true');
  fx.update(0.2); // 演出中
  assert.equal(fx.skillCall('金刃风暴', 'metal', 2), false, '演出中再触发返回 false');
  assert.equal(fx.call.name, '烈焰环', '演出中再触发:忽略,原演出继续');
  assert.equal(fx.call.t, 0.2, '时间轴不被打断');
  fx.update(0.8); // 演出结束(累计 1.0s),CD 剩 1.0s
  assert.equal(fx.call, null);
  assert.equal(fx.skillCall('裂地脉冲', 'earth', 2), false, 'CD 期内(剩余 1.0s<2s)再触发返回 false');
  assert.equal(fx.call, null, 'CD 期内(剩余 1.0s<2s)再触发:忽略');
  fx.update(1.1); // CD 归零
  assert.equal(fx.skillCall('裂地脉冲', 'earth', 2), true, 'CD 结束后可再次演出');
  assert.equal(fx.call.name, '裂地脉冲', 'CD 结束后可再次演出');
  // clearCall 连 CD 一并清(重开/终局不带入)
  fx.clearCall();
  assert.equal(fx.callCdT, 0, 'clearCall 清 CD');
  assert.equal(fx.skillCall('石甲术', 'earth', 1), true, '清 CD 后立即可触发');
  assert.ok(fx.call, '清 CD 后立即可触发');
});

// ---- M12-3 绘制钩子(无 DOM:离屏画布 null 守卫,不抛错;贴图缺省静默跳过) ----
test('M12 绘制:drawCallBg/_drawCallTop 全时间轴采样不抛错;无贴图时零 drawImage', () => {
  const fx = new FxLayer();
  const { ctx, rec } = mkCtx();
  fx.skillCall('烈焰焚天', 'fire', 1);
  // CALL_IMG 为模块级共享单例(前序用例可能已绑定):显式清空保证「未绑定」分支,finally 还原
  const saved = { ...CALL_IMG };
  CALL_IMG.hero = null; CALL_IMG.bubble = null; CALL_IMG.bg = {};
  try {
    for (let t = 0; t <= 0.9; t += 0.05) { // 全时间轴采样(含入场/定格/退场边界)
      fx.call.t = t;
      fx.drawCallBg(ctx);
      fx.draw(ctx);
    }
    assert.equal(rec.draws.length, 0, '贴图未绑定时不产生 drawImage(静默跳过)');
    assert.ok(rec.fillTexts.includes('烈焰焚天'), '缺图时仍绘制技能名');
  } finally {
    Object.assign(CALL_IMG, saved);
  }
  // Node 环境跳过离屏背景，仍绘制立绘和喊话气泡。
  const imgs = new Map();
  for (const it of fullManifest().filter(i => i.entity === 'skillcall')) {
    const isBubble = it.key === 'call:bubble';
    imgs.set(it.key, { _src: it.url, naturalWidth: isBubble ? 768 : 640, naturalHeight: isBubble ? 512 : 853 });
  }
  bindCallImages(imgs);
  const rec2 = mkCtx();
  fx.call.t = 0.4; // 定格段:各元素可见
  fx.drawCallBg(rec2.ctx);
  fx.draw(rec2.ctx);
  assert.equal(rec2.rec.draws.length, 2);
  assert.ok(rec2.rec.draws.some(draw => draw.img.endsWith('/bubble.png')));
  const [portrait, bubble] = fx.callBounds();
  for (const box of [portrait, bubble]) {
    assert.ok(box.left >= 0 && box.right <= 720 && box.top >= 44 && box.bottom <= 448);
  }
  assert.equal(portrait.left, 0);
  assert.ok(bubble.left >= 285 && bubble.right > 680);

  function sample(t) {
    fx.call.t = t;
    const { ctx, rec } = mkCtx();
    fx.draw(ctx);
    return rec;
  }
  assert.equal(sample(0.10).draws.length, 0);
  const arrival = sample(0.12);
  assert.equal(arrival.draws.length, 1);
  assert.ok(arrival.draws[0].img.endsWith('/hero.png'));
  assert.ok(arrival.draws[0].a[3] > 448, '立绘高于战斗区，底边贴战斗区');
  assert.ok(arrival.translations[0][0] < -200, '立绘从左侧大幅滑入');
  const preName = sample(0.30);
  assert.equal(preName.draws.length, 2, '立绘之后弹出气泡');
  assert.equal(preName.fillTexts.length, 0, '气泡先于技能名');
  const hold = sample(0.49);
  assert.equal(hold.translations[0][0], 0, '立绘停在画面左缘');
  assert.ok(hold.fillTexts.includes('烈焰焚天'));
  assert.ok(sample(0.78).translations[0][0] < -200, '立绘向左滑出');
  assert.equal(sample(0.81).draws.length, 0);
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
test('M12 parallax:triggerShake(6.5,0.28) 覆盖幅度/时长;缺省保持受击 4px/0.12s 原口径', () => {
  const px = new Parallax({ effects: true });
  assert.equal(px.shakeAmp, 4);
  assert.equal(px.shakeDur, 0.12);
  px.triggerShake(6.5, 0.28);
  assert.equal(px.shakeAmp, 6.5, '喊话冲击幅度 6.5px');
  assert.equal(px.shakeDur, 0.28, '喊话震动时长 0.28s');
  assert.ok(px.shakeT > 0, '震屏已激活');
  px.update(0.4);
  assert.ok(px.shakeT <= 0, '震屏按时长衰减归零');
  // 关动效口径:不激活
  const pxOff = new Parallax({ effects: false });
  pxOff.triggerShake(6.5, 0.28);
  assert.equal(pxOff.shakeT, 0, 'effects=false 震屏不激活(6.1 同步关闭口径)');
});

// ---- M12-5 接线面:main 触发条件(非普攻弹)与变体映射(源码级口径冻结) ----
test('M12 main 接线:kind!=="bolt" 触发喊话;震屏仅在 skillCall 返回 true 时执行;变体按 unlockLevel 取用', () => {
  const src = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(src.includes("used.skill.kind !== 'bolt'"), '触发门控=非普攻属性弹');
  assert.ok(src.includes('if (hud.fx.skillCall('), 'M12M13-ACCEPT F3:skillCall 返回值门控');
  // 震屏必须在 skillCall 返回值分支内(CD 期被忽略时**不震屏**)
  assert.ok(
    /if \(hud\.fx\.skillCall\([^\n]*\)\) \{\s*\n\s*parallax\.triggerShake\(6\.5, 0\.28\);/.test(src),
    '震屏在 skillCall 返回 true 分支内(F3:CD 期整体忽略)',
  );
  assert.ok(src.includes('used.skill.unlockLevel >= 6 ? 2 : 1'), '变体映射:Lv6→2,Lv3→1');
  assert.ok(src.includes('hud.fx.clearCall()'), '重开/终局清喊话演出');
  const rSrc = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(rSrc.includes('hud.fx.drawCallBg(ctx)'), 'render 在战场变换内挂背景层钩子(z 序:场景<背景<敌人)');
});
