// tests/m10.test.mjs — M10 批次:codex 生图图标接入(棋子五行宝石/技能图标贴图+manifest 预载)
// 运行: node --test tests/m10.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 浏览器全局桩(Image:可控制 complete/尺寸;M11-03 F1 后 render.js 零顶层加载,改用显式兜底入口)
// 桩安装/还原必须**在用例内**进行(--test-isolation=none 下模块求值顺序决定 globalThis.Image 归属,
// 最后求值的桩生效;桩必须在用例内安装/还原,否则跨文件挂起)
class FakeImage {
  constructor() { this.complete = false; this.naturalWidth = 0; this._src = ''; FakeImage.instances.push(this); }
  set src(v) { this._src = v; FakeImage.loaded.push(String(v)); }
  get src() { return this._src; }
}
FakeImage.loaded = [];
FakeImage.instances = [];
const setLoaded = (substr, on) => {
  for (const im of FakeImage.instances) {
    if (im.src.includes(substr)) { im.complete = on; im.naturalWidth = on ? 144 : 0; }
  }
};
const installImageStub = () => {
  const prev = globalThis.Image;
  globalThis.Image = FakeImage;
  return () => { globalThis.Image = prev; };
};

const { render, ensureFallbackImages } = await import('../scripts/ui/render.js');
const { BoardEngine } = await import('../scripts/board/engine.js');
const { FxLayer } = await import('../scripts/ui/fx.js');
const { fullManifest, iconList } = await import('../scripts/assets/manifest.js');

// ---- 清单与路径 ----
test('M10/M11/M14 manifest 图标清单:34 张(5 棋子+15 技能+6 道具+8 界面)纳入 fullManifest 预载(FR-9 缺图停载)', () => {
  const icons = iconList();
  assert.equal(icons.length, 34, '图标 34 张(M11 道具 6;M14 界面 8)');
  assert.equal(icons.filter(x => x.key.startsWith('icon:elements:')).length, 5, '五行棋子 5');
  assert.equal(icons.filter(x => x.key.startsWith('icon:skills:')).length, 15, '技能图标 15');
  assert.equal(icons.filter(x => x.key.startsWith('icon:items:')).length, 6, '道具图标 6(M11:heal/invincible/cd × 普通/premium)');
  assert.equal(icons.filter(x => x.key.startsWith('icon:ui:')).length, 8, '界面图标 8(M14:pause/settings/coin/pick/burn/slow/bind/stun)');
  assert.ok(fullManifest().some(x => x.key === 'icon:elements:metal'), '纳入全量清单');
  // 文件真实存在(FR-9:预载校验,缺图停载;M11 道具 6 张由生图批次落盘后入库)
  for (const it of icons) {
    const p = new URL('../' + it.url, import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
    assert.ok(fs.existsSync(p), `存在 ${it.url}`);
  }
});

test('M10 render 贴图映射:GEM_IMG 指向 icons/elements(替换原型期纯色圆 gems);SKILL_IMG 15 张 id 与 library 一致', () => {
  const restore = installImageStub(); // M11-03 F1:桩必须在用例内安装/还原(--test-isolation=none 下最后求值的桩生效,否则跨文件污染)
  ensureFallbackImages(); // M11-03 F1:零顶层加载后改用显式兜底入口(FakeImage.loaded 记录兜底 src 赋值)
  assert.ok(FakeImage.loaded.some(u => u.includes('/assets/icons/elements/metal.png')), '棋子贴图=新 icons 路径');
  assert.ok(!FakeImage.loaded.some(u => u.includes('sprites/gems')), '旧 gems 纯色圆路径已替换');
  const skillRefs = FakeImage.loaded.filter(u => u.includes('/assets/icons/skills/'));
  assert.equal(skillRefs.length, 15, '技能图标 15 张加载');
  assert.ok(skillRefs.some(u => u.includes('fire_bolt.png')) && skillRefs.some(u => u.includes('wood_aura.png')), 'id 与 library 一致(抽样)');
  restore(); // M11-03 F1:用例结束还原桩,避免跨文件污染(--test-isolation=none 下最后求值的桩生效)
});

// ---- 段③④图标贴图实际绘制(Image.complete=true 模拟已加载;录制 drawImage) ----
function mkRenderCtx() {
  const rec = { fillTexts: [], draws: [], strokes: 0 };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === '__rec') return rec;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'fillText') return (text) => rec.fillTexts.push(String(text));
      if (prop === 'drawImage') return (img, x, y, w, h) => rec.draws.push({ src: String(img && img.src || ''), x, y, w, h });
      if (prop === 'stroke') return () => { rec.strokes++; };
      return () => {};
    },
    set() { return true; },
  });
  return { ctx, rec };
}
function mkHudStub(engine, fxLayer) {
  return {
    battle: null,
    parallax: { transform: () => ({ ox: 0, oy: 0, scale: 1 }), draw() {} },
    charge: null, caster: null,
    fx: fxLayer,
    screen: () => 'playing',
    profile: () => ({ level: 1, coins: 0, materials: 0 }),
    progress: () => ({ unlockedLevel: 1, lastLevelCleared: 0 }),
    cleared: () => 0,
    drag: () => ({ drag: null, bounces: [] }),
    growPanel: () => false,
    toast: null,
  };
}
function inject(e) {
  e.grid = Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => ({ el: (r + c) % 5 })));
  e.grid[0][0].el = 0; e.grid[0][1].el = 0; e.grid[0][2].el = 0;
  return e;
}

test('M10 段③技能图标贴图经 render 实绘(drawImage 56px)+技能名文字下移;缺图回退纯文字', () => {
  const restore = installImageStub(); // M11-03 F1:桩必须在用例内安装/还原(--test-isolation=none 下最后求值的桩生效,否则跨文件污染)
  ensureFallbackImages(); // M11-03 F1:显式兜底入口(SKILL_IMG 实例存在后 setLoaded 才有效)
  setLoaded('/assets/icons/skills/', true); // 模拟贴图已加载(SKILL_IMG 实例)
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound();
  const bk = [...e.blockFx.keys()][0];
  e.setBlockFx(bk, { el: 'metal', reserved: true, skillId: 'metal_bolt', tier: 2, resKey: 'rk1' });
  e.clearing.forEach(cl => { cl.t = e.clearTotal - 0.6; }); // 段③(elapsed=0.6 ∈ 0.5~0.75,rush=1)
  const fx = new FxLayer();
  const { ctx, rec } = mkRenderCtx();
  render(ctx, e, mkHudStub(e, fx));
  const draws = rec.draws.filter(d => d.src.includes('/assets/icons/skills/metal_bolt.png'));
  assert.ok(draws.length > 0, `段③技能图标贴图经 render 实绘(draws=${rec.draws.length})`);
  assert.ok(draws.every(d => d.w === 56 && d.h === 56), `图标 56px(实得 ${draws[0] && draws[0].w})`);
  assert.ok(rec.fillTexts.some(t => t.includes('金弹')), '技能名文字仍在(图标下方)');
  restore(); // M11-03 F1:用例结束还原桩,避免跨文件污染(--test-isolation=none 下最后求值的桩生效)
});

test('M10 缺图回退:Image 未加载(complete=false)时段③回退纯文字样式(不绘制图标)', () => {
  const restore = installImageStub(); // M11-03 F1:桩必须在用例内安装/还原(--test-isolation=none 下最后求值的桩生效,否则跨文件污染)
  ensureFallbackImages(); // M11-03 F1:兜底实例先建,缺图(complete=false)回退分支才有 SKILL_IMG 实例可标
  setLoaded('/assets/icons/skills/', false); // 模拟缺图(complete=false,回退分支)
  const e = inject(new BoardEngine(7));
  e.chain = 1;
  e._beginRound();
  const bk = [...e.blockFx.keys()][0];
  e.setBlockFx(bk, { el: 'metal', reserved: true, skillId: 'metal_bolt', tier: 2, resKey: 'rk2' });
  e.clearing.forEach(cl => { cl.t = e.clearTotal - 0.6; }); // 段③(elapsed=0.6 ∈ 0.5~0.75;缺图→回退纯文字)
  const fx = new FxLayer();
  const { ctx, rec } = mkRenderCtx();
  render(ctx, e, mkHudStub(e, fx));
  const draws = rec.draws.filter(d => d.src.includes('/assets/icons/skills/'));
  assert.equal(draws.length, 0, '未加载贴图不绘制(回退)');
  assert.ok(rec.fillTexts.some(t => t.includes('金弹')), '回退纯文字仍显示技能名');
  restore(); // M11-03 F1:用例结束还原桩,避免跨文件污染(--test-isolation=none 下最后求值的桩生效)
});
