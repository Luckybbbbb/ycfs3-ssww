// tests/m11.test.mjs — M11 批次:演出期全时可操作(render 层)/旧连锁提示移除/道具图标接入/UI 五屏
// 运行: node --test tests/m11.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

// 浏览器全局桩(同 m9/m10 口径:FakeImage 记录加载清单,可 setLoaded 标记已加载)
const instances = [];
globalThis.Image = class {
  constructor() { this._complete = false; instances.push(this); }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  get complete() { return this._complete && !!this.naturalWidth; }
  setLoaded(w = 144, h = 144) { this.naturalWidth = w; this.naturalHeight = h; this._complete = true; }
};
const { render, UI, resultSkip } = await import('../scripts/ui/render.js');
const { FxLayer } = await import('../scripts/ui/fx.js');
const { attachInput } = await import('../scripts/core/input.js');

// ---- 录制型 2D context 桩 ----
function mkCtx() {
  // -03 B1 整改:Proxy set 拦截记录 fillStyle/globalAlpha(按压色/淡入 alpha 可真断言,不再恒真)
  const rec = { fillTexts: [], draws: [], strokes: 0, rects: [], fillRects: [], gradients: 0, fillStyles: [], globals: [], strokeStyles: [], lineLimits: [] };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === '__rec') return rec;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'fillText') return (text) => rec.fillTexts.push(String(text));
      if (prop === 'drawImage') return (img, ...a) => rec.draws.push({ img: String(img?._src ?? img), a });
      if (prop === 'stroke') return () => { rec.strokes++; };
      if (prop === 'fillRect') return (x, y, w, h) => rec.fillRects.push({ x, y, w, h });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => { rec.gradients++; return { addColorStop() {} }; };
      return () => {};
    },
    set(_t, prop, v) {
      if (prop === 'fillStyle') rec.fillStyles.push(v);
      if (prop === 'globalAlpha') rec.globals.push(v);
      if (prop === 'strokeStyle') rec.strokeStyles.push(v);
      if (prop === 'lineWidth') rec.lineLimits.push(v);
      return true;
    },
  });
  return { ctx, rec };
}

function mkHud(over = {}) {
  return {
    battle: null,
    parallax: { transform: () => ({ ox: 0, oy: 0, scale: 1 }), draw() {} },
    charge: null, caster: null,
    fx: new FxLayer(),
    screen: () => 'playing',
    profile: () => ({ level: 3, coins: 120, materials: 8, expTotal: 80, ownedSkills: ['fire_bolt'], skillLevels: { fire_bolt: 2 }, loadout: ['fire_bolt', 'water_bolt', 'wood_bolt', 'earth_bolt'], settings: { effects: true } }),
    progress: () => ({ unlockedLevel: 3, lastLevelCleared: 2 }),
    cleared: () => 0,
    drag: () => ({ drag: null, bounces: [] }),
    growPanel: () => false,
    paused: () => false, panel: () => null,
    loadout: () => ({ selLevel: 2, selSlot: 1 }),
    maxChain: () => 4,
    sfxEnabled: () => true, fxEnabled: () => true,
    toast: null,
    ...over,
  };
}

const mkEngineStub = () => ({
  state: 'IDLE', chain: 0, paralyzed: false, fxEnabled: true,
  clearing: [], cellsForRender: () => [], swapBuffer: null, stageDur: null,
  parallelSwaps: [],
});

// ---- M11-1 旧连锁提示移除 ----
test('M11 连锁常显提示移除:render 源码无「连锁 ×」常显绘制;fx 飞字不再输出连锁文案(播报唯一化)', () => {
  const src = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(!src.includes('`连锁 ×${engine.chain}`'), 'render 常显「连锁 ×N」已移除(需求方 2026-10-17)');
  const fxSrc = fs.readFileSync(new URL('../scripts/ui/fx.js', import.meta.url), 'utf-8');
  assert.ok(!fxSrc.includes('`连锁 ×${ev.chain}`'), 'fx onMatchCleared 连锁飞字已移除');
  // 王者式播报保留(唯一链源)
  assert.ok(fxSrc.includes('chainAnnounce'), 'fx.chainAnnounce 播报保留');
  // 行为回归:render(chain=5) 不再画出「连锁 ×」文字
  const e = mkEngineStub();
  e.chain = 5;
  const r = mkCtx();
  render(r.ctx, e, mkHud());
  assert.ok(!r.rec.fillTexts.some(t => t.startsWith('连锁 ×')), '渲染输出无「连锁 ×」提示');
});

// ---- M11-2 道具图标接入 ----
test('M11 道具图标:ITEM_IMG 6 张(items/<item>[_premium].png);道具格实绘贴图+缺图回退 emoji', () => {
  const src = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(src.includes('assets/icons/items/'), 'render 映射 items 目录');
  assert.ok(src.includes('_premium'), 'premium 档后缀映射');
  // 并跑模式(--test-isolation=none)下 Image 全局可能被先导入文件的桩占位(不记录实例)——
  // 实例级行为断言仅在可记录桩下执行(单独运行本文件恒走完整分支)
  if (instances.length === 0) {
    assert.ok(src.includes('ITEM_IMG[cell.item'), '道具格按 item+premium 查表绘制');
    return;
  }
  const itemRefs = instances.map(i => i.src).filter(u => u.includes('/assets/icons/items/'));
  assert.equal(itemRefs.length, 6, 'ITEM_IMG 6 张(3 类型×2 档)');
  for (const k of ['heal', 'heal_premium', 'invincible', 'invincible_premium', 'cd', 'cd_premium']) {
    assert.ok(itemRefs.some(u => u.includes(`/${k}.png`)), `图标 ${k}.png 已映射`);
  }
  // 道具格实绘:贴图已加载 → drawImage;未加载 → emoji 回退
  const itemImgs = instances.filter(i => String(i.src).includes('/assets/icons/items/')); // 先捕获(清空 instances 不影响闭包内对象)
  const e = mkEngineStub();
  e.cellsForRender = () => [{ r: 0, c: 0, item: 'invincible', premium: true, expire: 7, alpha: 1, offsetX: 0, offsetY: 0 }];
  const r1 = mkCtx();
  instances.length = 0; // 屏蔽后续模块级新建
  render(r1.ctx, e, mkHud());
  assert.ok(r1.rec.fillTexts.includes('✦'), '缺图回退 emoji(✦=无敌占位)');
  assert.ok(!r1.rec.draws.some(d => d.img.includes('/assets/icons/items/')), '缺图不 drawImage');
  // 标记已加载后再绘:drawImage 命中 items 路径且无 emoji
  for (const img of itemImgs) img.setLoaded();
  e.cellsForRender = () => [{ r: 0, c: 0, item: 'invincible', premium: true, expire: 7, alpha: 1, offsetX: 0, offsetY: 0 }];
  const r2 = mkCtx();
  render(r2.ctx, e, mkHud());
  assert.ok(r2.rec.draws.some(d => d.img.includes('/assets/icons/items/invincible_premium.png')), '高级无敌贴图实绘(premium 后缀)');
  assert.ok(!r2.rec.fillTexts.includes('✦'), '贴图就绪后不再回退 emoji');
});

// ---- M11-3 UI 五屏绘制 ----
test('M11 开始界面:标题/开始冒险按钮/设置/关于/存档条绘制(有档文案=开始冒险)', () => {
  const r = mkCtx();
  render(r.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  assert.ok(r.rec.fillTexts.includes('言出法随'), '主标题(M11-06:主标+副标两行)');
  assert.ok(r.rec.fillTexts.some(t => t.replace(/ /g, '') === '三生万物'), '副标题「三生万物」');
  assert.ok(r.rec.fillTexts.some(t => t.includes('开 始 冒 险')), '有档主按钮=开始冒险');
  assert.ok(r.rec.fillTexts.some(t => t.includes('设 置') || t.includes('设 置'.slice(0, 2))), '设置按钮');
  assert.ok(r.rec.fillTexts.some(t => t.includes('关 于')), '关于按钮');
  assert.ok(r.rec.fillTexts.some(t => t.includes('存档:Lv.3')), '存档信息条');
  // 无档分支:未通关+Lv1 → 开始游戏+无存档条
  const r2 = mkCtx();
  render(r2.ctx, mkEngineStub(), mkHud({
    screen: () => 'start',
    profile: () => ({ level: 1, coins: 0, materials: 0, expTotal: 0, loadout: [], ownedSkills: [], skillLevels: {}, settings: { effects: true } }),
    progress: () => ({ unlockedLevel: 1, lastLevelCleared: 0 }),
  }));
  assert.ok(r2.rec.fillTexts.some(t => t.includes('开 始 游 戏')), '无档主按钮=开始游戏');
  assert.ok(!r2.rec.fillTexts.some(t => t.includes('存档:')), '无档隐藏存档信息条');
});

test('M11 选关界面:顶栏/三态卡片(已通关重打/当前挑战/锁定)/养成入口绘制', () => {
  const r = mkCtx();
  render(r.ctx, mkEngineStub(), mkHud({ screen: () => 'menu' }));
  assert.ok(r.rec.fillTexts.includes('关卡选择'), '标题');
  assert.ok(r.rec.fillTexts.some(t => t.includes('第 1 关 · 青葱丘林')), '卡片名(LEVEL_META)');
  assert.ok(r.rec.fillTexts.some(t => t.includes('重打')), '已通关态按钮');
  assert.ok(r.rec.fillTexts.some(t => t.includes('挑战')), '当前态按钮');
  assert.ok(r.rec.fillTexts.some(t => t.includes('锁定')), '锁定态按钮');
  assert.ok(r.rec.fillTexts.some(t => t.includes('通关第 3 关后解锁')), '锁定解锁条件');
  assert.ok(r.rec.fillTexts.some(t => t.includes('当前进度')), '当前进度 chip');
  assert.ok(r.rec.fillTexts.some(t => t.includes('养成')), '养成入口(FR-10 保留)');
});

test('M11 备战界面:主角面板/出战信息/4 装配槽/技能库(解锁灰显+●标记)/出战按钮/低等级警告', () => {
  const r = mkCtx();
  render(r.ctx, mkEngineStub(), mkHud({ screen: () => 'loadout' }));
  assert.ok(r.rec.fillTexts.some(t => t.includes('备战 · 第 2 关')), '标题带目标关');
  assert.ok(r.rec.fillTexts.some(t => t.includes('Lv.3')), '主角面板(需求方 2026-10-19:常驻名「赤狐」移除,只留 Lv)');
  assert.ok(r.rec.fillTexts.some(t => t.includes('出战信息')), '出战信息卡');
  // v2:建议等级 chips 化(低等级=红色描边 chip,文字仍为「建议 Lv.X+」)
  assert.ok(r.rec.fillTexts.some(t => t.includes('建议 Lv.4+')), '建议等级 chip(LEVEL_META;Lv3<4 红色呈现)');
  assert.ok(r.rec.fillTexts.some(t => t.includes('技能装配')), '装配槽区');
  assert.ok(r.rec.fillTexts.some(t => t.includes('火弹')), '装配槽已装配技能');
  assert.ok(r.rec.fillTexts.some(t => t.includes('升级 / 技能升级 / 抽卡 → 养成面板')), 'v2 主角面板精简说明');
  assert.ok(r.rec.fillTexts.some(t => t.includes('点图标看说明 · 右上「更换」换技能')), 'v2 槽区说明');
  assert.ok(!r.rec.fillTexts.some(t => t.includes('技能库')), 'v2 技能库列表已移除(需求方 2026-10-19)');
  assert.ok(r.rec.fillTexts.some(t => t.includes('出 战')), '出战按钮');
  // 高等级:建议 chip 仍显示(颜色差由绘制样式承载,文字层两态一致)
  const r2 = mkCtx();
  render(r2.ctx, mkEngineStub(), mkHud({ screen: () => 'loadout', profile: () => ({ level: 10, coins: 0, materials: 0, expTotal: 500, ownedSkills: [], skillLevels: {}, loadout: [], settings: { effects: true } }) }));
  assert.ok(r2.rec.fillTexts.some(t => t.includes('建议 Lv.4+')), 'Lv10 建议 chip 常显(无红色警告语义由样式承载)');
});

test('M11 结算界面:胜利(通关横幅/统计行/解锁 chip/按钮组)与失败(战败横幅/鼓励文案/按钮组)', () => {
  const battle = { phase: 'VICTORY', level: 3, kills: 129, expGained: 4226, coinsGained: 240, matsGained: 20, victoryCoins: 150, victoryMats: 30, wave: 10, enemies: [], ebolts: [], bolts: [], zones: [] };
  resultSkip(); // M15 结算 v2:跳过=直达完整呈现(时间轴末态,数字显示终值)
  const r = mkCtx();
  render(r.ctx, mkEngineStub(), mkHud({ battle }));
  assert.ok(r.rec.fillTexts.includes('通 关 !'), '胜利横幅');
  assert.ok(r.rec.fillTexts.some(t => t.includes('129 只')), '击杀统计');
  assert.ok(r.rec.fillTexts.some(t => t.includes('×4')), '最高连锁(hud.maxChain)');
  assert.ok(r.rec.fillTexts.some(t => t.includes('4226 exp')), '经验累计');
  assert.ok(r.rec.fillTexts.some(t => t.includes('🎉 解锁第 4 关')), '解锁 chip(FR-6)');
  assert.ok(r.rec.fillTexts.some(t => t.includes('下一关 ▶')), '下一关按钮');
  assert.ok(r.rec.fillTexts.some(t => t.includes('重打本关')), '重打按钮');
  const battle2 = { phase: 'DEFEAT', level: 4, kills: 53, expGained: 1884, coinsGained: 90, matsGained: 6, wave: 6, victoryCoins: 0, victoryMats: 0, enemies: [], ebolts: [], bolts: [], zones: [] };
  const r2 = mkCtx();
  render(r2.ctx, mkEngineStub(), mkHud({ battle: battle2 }));
  assert.ok(r2.rec.fillTexts.includes('战 败'), '失败横幅');
  assert.ok(r2.rec.fillTexts.some(t => t.includes('第 4 关 · 第 6 波')), '败因定位(波次)');
  assert.ok(r2.rec.fillTexts.some(t => t.includes('练到 Lv.12 再来挑战!')), '鼓励文案(距建议差距)');
  assert.ok(r2.rec.fillTexts.some(t => t.includes('失败不扣任何进度')), '宽松取向说明(M15 v2 文案);');
  assert.ok(r2.rec.fillTexts.some(t => t.includes('再战一次')), '再战按钮');
  assert.ok(r2.rec.fillTexts.some(t => t.includes('去备战')), '去备战按钮');
});

test('M11 暂停与设置:⏸/⚙ 底栏按钮;暂停浮层(继续/音效/动效/放弃);设置面板开关文案', () => {
  const r = mkCtx();
  render(r.ctx, mkEngineStub(), mkHud({ paused: () => true, battle: { phase: 'FIGHTING', level: 2, kills: 0, wave: 1, enemies: [], ebolts: [], bolts: [], zones: [] } }));
  assert.ok(r.rec.fillTexts.some(t => t.includes('⏸')), '底栏暂停按钮');
  assert.ok(r.rec.fillTexts.some(t => t.includes('⚙')), '底栏设置按钮');
  assert.ok(r.rec.fillTexts.includes('已暂停'), '暂停标题');
  assert.ok(r.rec.fillTexts.some(t => t.includes('继 续')), '继续按钮');
  assert.ok(r.rec.fillTexts.some(t => t.includes('音效:开')), '音效开关');
  assert.ok(r.rec.fillTexts.some(t => t.includes('动效:开')), '动效开关');
  assert.ok(r.rec.fillTexts.some(t => t.includes('放弃本局')), '放弃按钮');
  const r2 = mkCtx();
  render(r2.ctx, mkEngineStub(), mkHud({ screen: () => 'start', panel: () => 'settings' }));
  assert.ok(r2.rec.fillTexts.includes('设 置'), '设置面板标题');
  assert.ok(r2.rec.fillTexts.some(t => t.includes('动效:开')), '动效开关(设置面板)'); // BEAUTIFY-01 F4:暂停/设置同一开关统一名称
  assert.ok(r2.rec.fillTexts.some(t => t.includes('关 闭')), '关闭按钮');
});

test('M11 UI 布局常量:五屏命中区齐备且不越 720×1280 界面(main 命中与 render 单一来源)', () => {
  const all = [
    UI.start.playBtn, UI.start.settingsBtn, UI.start.aboutBtn,
    UI.menu.backBtn, UI.menu.growBtn,
    UI.loadout.backBtn, UI.loadout.fightBtn,
    UI.battle.pauseBtn, UI.battle.settingsBtn,
    UI.result.victory.mainBtn, UI.result.victory.retryBtn, UI.result.victory.backBtn,
    UI.result.defeat.mainBtn, UI.result.defeat.loadoutBtn, UI.result.defeat.backBtn,
    UI.pause.resumeBtn, UI.pause.quitBtn,
    UI.settings.closeBtn, UI.about.closeBtn,
  ];
  for (const r of all) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 720 && r.y + r.h <= 1280, `命中区在界面内(${r.x},${r.y},${r.w},${r.h})`);
    assert.ok(r.w >= 44 && r.h >= 40, `可点面积(触屏 ≥44pt 口径;${r.w}×${r.h})`);
  }
});

// ---- M11-03 F7 残留整改:编成 chips 与按钮区域互斥(矩形不相交) ----
test('M11-03 F7 编成/按钮区域互斥:五关 chips 矩形均不与卡片按钮相交(修复前第四/五关 tiger 被遮挡)', async () => {
  const { uiCardBtn, UI: UIC } = await import('../scripts/ui/render.js');
  const { levelWeights } = await import('../scripts/battle/wave.js');
  const btn = { x: 510, y: 0, w: UIC.menu.cardBtn.w, h: UIC.menu.cardBtn.h };
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (let L = 1; L <= 5; L++) {
    const btn = { x: 510, y: UIC.menu.cardTop + (L - 1) * (UIC.menu.cardH + UIC.menu.cardGap) + UIC.menu.cardBtnY, w: UIC.menu.cardBtn.w, h: UIC.menu.cardBtn.h };
    // 模拟 chips 逐个绘制,记录矩形;chipsX/chipsY/chipsMaxX/chipsRowGap 与 drawMenuScreen 一致
    let cx0 = UIC.menu.chipsX, cy0 = UIC.menu.cardTop + (L - 1) * (UIC.menu.cardH + UIC.menu.cardGap) + UIC.menu.chipsY;
    for (const k of Object.keys(levelWeights(L))) {
      const w = 18 + k.length * 11;
      if (cx0 + w > UIC.menu.chipsMaxX) { cx0 = UIC.menu.chipsX; cy0 += UIC.menu.chipsRowGap; }
      const chipRect = { x: cx0, y: cy0, w, h: 28 };
      assert.ok(!overlap(chipRect, btn), `L${L} chip[${k}] 不与按钮重叠(chips=[${chipRect.x},${chipRect.y},${chipRect.w},${chipRect.h}])`);
      cx0 += w + 8;
    }
  }
});

// ---- M11-4 接线源码断言 ----
test('M11 接线:main 五屏路由/暂停门控/道具图标;manifest 图标清单;levels 元数据', () => {
  const mainSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mainSrc.includes("screen = 'start'"), '初始屏=开始界面');
  assert.ok(mainSrc.includes("openLoadout"), '备战流转入口');
  assert.ok(mainSrc.includes('paused = true'), '底栏 ⏸ 暂停接线');
  assert.ok(mainSrc.includes('maxChain'), '最高连锁统计接线');
  assert.ok(mainSrc.includes('toggleSfx') && mainSrc.includes('toggleFx'), '设置开关接线');
  const manifestSrc = fs.readFileSync(new URL('../scripts/assets/manifest.js', import.meta.url), 'utf-8');
  assert.ok(manifestSrc.includes('icon:items'), 'manifest 道具图标清单');
  const levelsSrc = fs.readFileSync(new URL('../scripts/meta/levels.js', import.meta.url), 'utf-8');
  assert.ok(levelsSrc.includes('LEVEL_META'), '关卡名/建议等级元数据');
  const audioSrc = fs.readFileSync(new URL('../scripts/ui/audio.js', import.meta.url), 'utf-8');
  assert.ok(audioSrc.includes('state.enabled'), 'audio 音效开关');
});

// ---- M11-02 整改(REJECTED F1~F9)回归 ----
test('M11-02 F1 预载接线:bindImages 以预载实例替换渲染表;main 消费 preload Map(不再丢弃)', async () => {
  const src = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(src.includes('export function bindImages'), 'bindImages 导出(预载→渲染同一资源集合)');
  const mainSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mainSrc.includes('boot(images)'), 'main 把 preload Map 传入 boot(不再丢弃)');
  assert.ok(mainSrc.includes('bindImages(images)'), 'boot 内绑定预载实例');
  // 行为:注入 premium 道具实例 → 道具格实绘命中注入实例(而非自建懒加载)
  // 用普通对象冒充 Image:并跑(--test-isolation=none)下 globalThis.Image 可能被其他文件的
  // 桩(loader.test 的 StubImage 等)覆盖,不保证有 setLoaded——bindImages 只存引用,
  // render 按 complete/naturalWidth 判定,普通对象即可精确控制
  const { bindImages } = await import('../scripts/ui/render.js');
  const injected = { _src: 'stub://invincible_premium.png', src: 'stub://invincible_premium.png', complete: true, naturalWidth: 144, naturalHeight: 144 };
  const n = bindImages(new Map([['icon:items:invincible_premium', injected]]));
  assert.ok(n >= 1, '至少绑定 1 项');
  const e = mkEngineStub();
  e.cellsForRender = () => [{ r: 0, c: 0, item: 'invincible', premium: true, expire: 7, alpha: 1, offsetX: 0, offsetY: 0 }];
  const r = mkCtx();
  render(r.ctx, e, mkHud());
  assert.ok(r.rec.draws.some(d => d.img === 'stub://invincible_premium.png'), '道具格实绘=预载注入实例');
});

test('M15 v2 命中区同源:4 大槽步进 160(128 槽+面板 24px 边距)/换装抽屉两列坐标有限;卡片按钮在屏内', async () => {
  const { uiCardBtn, uiSlotRect, uiSlotSwapBtn, uiPickRows, UI: UIC } = await import('../scripts/ui/render.js');
  // 4 槽:x0=56 步进 160(128+32;面板 32..688 内左右各留 24px),全部在屏内
  for (let i = 0; i < 4; i++) {
    const s0 = uiSlotRect(i);
    assert.equal(s0.x, 56 + i * 160, `槽 ${i + 1} x 命中与绘制同源(v2)`);
    assert.ok(s0.x + s0.w <= 720 && s0.y + s0.h <= 1280, `槽 ${i + 1} 在屏内`);
  }
  // 换装抽屉两列 6 行:15 技能去已装配 ≤11 行,坐标全有限且在抽屉容器内
  const rows = uiPickRows(['fire_bolt', 'water_bolt', 'wood_bolt', 'earth_bolt'], [], 3);
  for (let i = 0; i < rows.length; i++) {
    const rc = rows[i].rect;
    assert.ok(Number.isFinite(rc.x) && Number.isFinite(rc.y), `抽屉行 ${i + 1} 坐标有限`);
    assert.ok(rc.x >= 32 && rc.x + rc.w <= 720 && rc.y >= UIC.loadout.pickTop && rc.y + rc.h <= 1280, `抽屉行 ${i + 1} 在容器内`);
  }
  for (let L = 1; L <= 5; L++) {
    const b = uiCardBtn(L);
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && b.y + b.h <= 1280, `L${L} 卡片按钮命中有限且在屏内`);
  }
  for (let i = 0; i < 4; i++) {
    const sb = uiSlotSwapBtn(i);
    assert.ok(Number.isFinite(sb.x) && Number.isFinite(sb.y), `槽 ${i + 1} 更换按钮有限`);
  }
});
test('M11-02 F3/F4/F5/F6 接线:persistProfile 同步装配;owned 门控;sfx 写档;toast 无连锁级数', () => {
  const mainSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mainSrc.includes('profile.loadout = [...caster.loadout]'), 'F3:persistProfile/boot 同步装配内存态(render 读 profile.loadout)');
  assert.ok(mainSrc.includes('profile.ownedSkills.includes(sk.id)'), 'F4:备战装配 ownedSkills 门控(与 cast.js 释放条件一致)');
  assert.ok(mainSrc.includes('profile.settings.sfx = sfx.enabled'), 'F5:音效开关写档');
  assert.ok(mainSrc.includes("sfx.enabled = profile.settings.sfx !== false"), 'F5:启动恢复音效开关');
  assert.ok(!mainSrc.includes('连锁${e.chain}'), 'F6:充能 toast 不再携带连锁级数(播报唯一化)');
  const saveSrc = fs.readFileSync(new URL('../scripts/meta/save.js', import.meta.url), 'utf-8');
  assert.ok(saveSrc.includes('sfx: v.settings.sfx !== false'), 'F5:loadProfile 恢复 sfx(缺省 true)');
  assert.ok(saveSrc.includes('settings: { effects: true, sfx: true, bgm: true }'), 'F5:默认档含 sfx;M14 补 bgm 默认开');
  const renderSrc = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(renderSrc.includes('Object.keys(levelWeights('), 'F7:编成 chips/出战信息读 wave.js 真权重表(内联表曾漏 slime)');
  assert.ok(!renderSrc.includes('levelWeightsSafe'), 'F7:内联权重键表移除');
  assert.ok(!renderSrc.includes('if (cx0 > 480) break;'), 'F7:编成 chips 不再提前截断(第三关起漏项)');
});

test('M11-02 F9 局界重置:resetBoard 清演出/缓冲/事件并重新生成棋盘;startLevel/retryLevel 接线', async () => {
  const { BoardEngine, STATE } = await import('../scripts/board/engine.js');
  const e = new BoardEngine(20260601);
  // 构造脏状态:演出中登记并行交换+预输入缓冲+事件+clearing
  e.chain = 3;
  e.events.push({ type: 'match_cleared', element: 'fire', count: 3, chain: 3 });
  e.parallelSwaps.push({ a: { r: 0, c: 0 }, b: { r: 0, c: 1 }, t: 0.1 });
  e.swapBuffer = { a: { r: 2, c: 2 }, b: { r: 2, c: 3 } };
  e.nudgeFx = { a: { r: 1, c: 1 }, b: { r: 1, c: 2 }, t: 0.1, total: 0.15 };
  e.clearing = [{ r: 0, c: 0, t: 0.5 }];
  e.resetBoard();
  assert.equal(e.state, STATE.IDLE, '状态回 IDLE');
  assert.equal(e.parallelSwaps.length, 0, '并行动画槽清空');
  assert.equal(e.swapBuffer, null, '预输入缓冲清空(放弃重开不自动执行旧操作)');
  assert.equal(e.events.length, 0, '未消费事件清空');
  assert.equal(e.clearing.length, 0, '演出格清空');
  assert.equal(e.nudgeFx, null, '弹回动画清空');
  assert.equal(e.chain, 0, '连锁归零');
  assert.ok(e.grid && e.grid.length === 8 && e.grid.every(row => row.every(c => c !== null)), '棋盘重新生成(双验证全满)');
  const mainSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mainSrc.includes('engine.resetBoard()'), 'startLevel/retryLevel 局界重置接线');
});

// ---- M11-06 主副标题+技能更换/长按 tips ----
test('M11-06 备战交互:槽位更换按钮命中区/换装列表过滤已装配/门控;tips 与选择面板绘制', async () => {
  const { uiSlotSwapBtn, uiSlotRect, uiPickRows, UI: UIC } = await import('../scripts/ui/render.js');
  // 更换按钮:位于槽右上角,完整落在槽矩形内
  for (let i = 0; i < 4; i++) {
    const sr = uiSlotRect(i), sb = uiSlotSwapBtn(i);
    assert.ok(sb.x >= sr.x && sb.x + sb.w <= sr.x + sr.w, `槽 ${i} 更换按钮横向在槽内`);
    assert.ok(sb.y >= sr.y && sb.y + sb.h <= sr.y + sr.h, `槽 ${i} 更换按钮纵向在槽内`);
    assert.ok(sb.x > sr.x + sr.w / 2 && sb.y < sr.y + sr.h / 2, `槽 ${i} 更换按钮在右上象限`);
  }
  // 换装列表:过滤已装配(4 装配 → 15-4=11 行);门控与技能库口径一致(unlockLevel+owned)
  const loadout = ['fire_bolt', 'water_bolt', 'wood_bolt', 'earth_bolt'];
  const rows = uiPickRows(loadout, ['fire_bolt', 'fire_dotzone'], 3);
  assert.equal(rows.length, 11, '已装配 4 项不显示');
  assert.ok(rows.every(r => !loadout.includes(r.sk.id)), '无已装配项');
  const firePulse = rows.find(r => r.sk.id === 'fire_pulse');
  assert.equal(firePulse.unlocked, false, 'Lv6 技能 Lv3 不可用');
  const fireDot = rows.find(r => r.sk.id === 'fire_dotzone');
  assert.equal(fireDot.unlocked, true, 'Lv3+已拥有 → 可用');
  const waterBolt = rows.find(r => r.sk.id === 'metal_bolt');
  assert.equal(waterBolt.unlocked, false, '未拥有 → 不可用');
  // 行矩形:v2 两列 6 行——同列逐行下移,第 7 行起换列(列距 310)
  for (let i = 1; i < rows.length; i++) {
    if (i % 6 === 0) {
      assert.equal(rows[i].rect.x, rows[i - 6].rect.x + 310, `行 ${i + 1} 换列(列距 310)`);
      assert.ok(rows[i].rect.y < rows[i - 1].rect.y, `行 ${i + 1} 回到抽屉行顶`);
    } else {
      assert.equal(rows[i].rect.y, rows[i - 1].rect.y + UIC.loadout.pickRowH, `行 ${i + 1} 逐行下移`);
    }
  }
  // 绘制:skillPick 面板(标题+行+关闭)+skillTips 浮层(名称+档位数值+关闭提示)
  // (自定义档:fire_dotzone 已拥有未装配 → 行小字=「Lv.2 · CD 6s」;其余未拥有行=灰显标注)
  const r1 = mkCtx();
  render(r1.ctx, mkEngineStub(), mkHud({ screen: () => 'loadout', loadout: () => ({ selLevel: 2, selSlot: 0, panel: 'skillPick', pickSlot: 1, tipsSlot: -1 }), profile: () => ({ level: 3, coins: 0, materials: 0, expTotal: 0, ownedSkills: ['fire_bolt', 'fire_dotzone'], skillLevels: { fire_dotzone: 2 }, loadout: ['fire_bolt', 'water_bolt', 'wood_bolt', 'earth_bolt'], settings: { effects: true } }) }));
  assert.ok(r1.rec.fillTexts.some(t => t.includes('选择技能 → 槽位 2')), 'pick 面板标题带目标槽位');
  assert.ok(r1.rec.fillTexts.some(t => t.includes('关 闭')), 'pick 关闭按钮');
  assert.ok(r1.rec.fillTexts.some(t => t.includes('未拥有')), '未拥有灰显标注');
  // 需求方 2026-10-19:抽屉行按 03 样板网格实装(图标+名+Lv/CD 小字)——长描述/数值列
  // 移入 tips 浮层承载(F13 数值口径由下方 r2 tips 断言守护),抽屉行只保留选择所需信息
  assert.ok(r1.rec.fillTexts.some(t => t.includes('Lv.2 · CD 6s')), '抽屉行小字=Lv/CD(样板网格口径)');
  const r2 = mkCtx();
  render(r2.ctx, mkEngineStub(), mkHud({ screen: () => 'loadout', loadout: () => ({ selLevel: 2, selSlot: 0, panel: 'skillTips', pickSlot: -1, tipsSlot: 0 }) }));
  assert.ok(r2.rec.fillTexts.some(t => t.includes('火弹')), 'tips 显示槽位技能名');
  // F13 整改:基础弹逐档数值(mkHud Lv3→ATK=12)——12×[1.0,1.6,2.4,3.4,4.6]=12/19/29/41/55(修复前全 0)
  assert.ok(r2.rec.fillTexts.includes('12 / 19 / 29 / 41 / 55'), '火弹 tips 逐档数值=ATK×TIER_MULT(F13)');
  assert.ok(r2.rec.fillTexts.some(t => t.includes('档位数值') || t.includes('伤害(ATK') || t.includes('伤害(')), 'tips 数值行标签');
  assert.ok(r2.rec.fillTexts.some(t => t.includes('点按任意处关闭')), 'tips 关闭提示');
});

test('M11-06 长按:input.update ≥500ms 触发一次 onLongPress;位移取消;触发后松手不再 tap', () => {
  // 本地 harness(input.test.mjs 的 mkHarness 在另一文件,不跨测试文件共享)
  const listeners = {};
  const canvas = {
    getBoundingClientRect: () => ({ width: 720, height: 1280, left: 0, top: 0 }),
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  const calls = { tap: [], longPress: [] };
  const input = attachInput(canvas, {
    cellAt: (x, y) => (y >= 504 && x >= 0 && x < 720 && y < 504 + 720) ? { r: Math.floor((y - 504) / 90), c: Math.floor(x / 90) } : null,
    onTap: (cell) => calls.tap.push(cell),
    onLongPress: (p) => calls.longPress.push(p),
  });
  const ev = (type, x, y) => listeners[type]({ clientX: x, clientY: y, preventDefault() {} });
  const realNow = performance.now.bind(performance);
  let fake = realNow();
  performance.now = () => fake; // 伪时钟(input 层长按计时用 performance.now)
  try {
    const px = 45, py = 504 + 225; // 格 (2,3) 中心
    ev('mousedown', px, py);
    input.update(0.016);
    assert.equal(calls.longPress.length, 0, '未到时长不触发');
    fake += 510;
    input.update(0.016);
    assert.equal(calls.longPress.length, 1, '≥500ms 触发');
    input.update(0.016);
    assert.equal(calls.longPress.length, 1, '同一手势不重复触发');
    ev('mouseup', px, py);
    assert.equal(calls.tap.length, 0, '长按后松手不触发点选');
    // 位移取消:移动超 12px 后即使到时也不触发
    calls.longPress.length = 0;
    ev('mousedown', px, py);
    ev('mousemove', px + 30, py); // moved
    fake += 1000;
    input.update(0.016);
    assert.equal(calls.longPress.length, 0, '位移后不触发长按');
  } finally {
    performance.now = realNow;
  }
});

// ---- UIV2-01 整改守护(codex REJECTED 八项 + 需求方 2026-10-19 实测反馈)----
test('UIV2-01 F1/F2 整改:养成技能列表滚动(15 技能全可升级)/抽卡浮层守卫导出', async () => {
  const { GROW_LAYOUT, render, growListScrollState, growListScrollTo, growGachaVisible, growGachaDismiss, growGachaFx } = await import('../scripts/ui/render.js');
  assert.equal(GROW_LAYOUT.btnOff, 183, '升级按钮右移(名字区留 83px,四字名不被覆盖)');
  const owned = ['fire_bolt', 'water_bolt', 'wood_bolt', 'metal_bolt', 'earth_bolt', 'fire_dotzone', 'water_chain', 'wood_bind', 'metal_multi', 'earth_shield', 'fire_pulse', 'water_field', 'wood_aura', 'metal_pulse', 'earth_pulse'];
  const r = mkCtx();
  render(r.ctx, mkEngineStub(), mkHud({ screen: () => 'menu', growPanel: () => true, profile: () => ({ level: 10, coins: 0, materials: 9999, expTotal: 0, ownedSkills: owned, skillLevels: {}, loadout: [], settings: { effects: true } }) }));
  assert.equal(growListScrollState().max, 424, '15 技能(8 行)溢出 424px=可滚动(F1:不再截断前 8;可见区=listBottom-listTop=440)');
  growListScrollTo(9999);
  assert.equal(growListScrollState().scroll, 424, '滚动钳制到上限');
  growListScrollTo(0); // 复位,避免残留影响后续渲染断言
  assert.equal(growGachaVisible(), false, '浮层初始不可见');
  growGachaFx('fire_bolt');
  assert.equal(growGachaVisible(), true, '抽卡后浮层可见(F2 守卫依据)');
  growGachaDismiss();
  assert.equal(growGachaVisible(), false, '关闭导出生效(main 点击路由先于背后按钮拦截)');
});

test('UIV2-01 F4 整改:跳过=完整终态(2.01s 末按钮入场完成)', async () => {
  const { resultRestart, resultSkip, resultReady } = await import('../scripts/ui/render.js');
  resultRestart();
  assert.equal(resultReady(), false, '起始未就绪');
  resultSkip();
  assert.equal(resultReady(), true, '跳过即达完整终态(不再有 1.85s 半程态)');
});

test('UIV2-01 F7 整改:失败音效调度末音收尾 <0.8s', async () => {
  const stops = [];
  globalThis.window = globalThis.window || globalThis;
  const mkOsc = () => ({ type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(o) { return o; }, start() {}, stop(t) { stops.push(t); } });
  const mkGain = () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(o) { return o; } });
  window.AudioContext = function () { this.currentTime = 0; this.state = 'running'; this.resume = () => {}; this.destination = {}; this.createOscillator = mkOsc; this.createGain = mkGain; };
  const { sfx } = await import('../scripts/ui/audio.js');
  sfx.enabled = true;
  sfx.resultLose();
  assert.ok(stops.length >= 2, '两音都已调度');
  assert.ok(Math.max(...stops) < 0.8, `末音收尾 ${Math.max(...stops).toFixed(2)}s < 0.8s(F7)`);
});

test('需求方 2026-10-19:换装抽屉关闭按钮收进面板内;战斗区货币栏存在', async () => {
  const { UI: UIC } = await import('../scripts/ui/render.js');
  const cb = UIC.loadout.pickCloseBtn;
  assert.ok(cb.x >= 40 && cb.x + cb.w <= 680, `关闭按钮在面板 x 带内(${cb.x}..${cb.x + cb.w})`);
  assert.ok(cb.y >= UIC.loadout.pickTop && cb.y + cb.h <= 1200, '关闭按钮在面板 y 带内(面板高已收进屏)');
  const rSrc = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(rSrc.includes('战斗区货币栏条带'), '货币/材料以货币栏形式显示在战斗区上方条带(需求方 2026-10-19)');
});

test('UIV2-02 F2 整改:滚动纯函数帧率无关(同壁钟时间点显示值相同,扣 5/100 轨迹)', async () => {
  const { rollToward } = await import('../scripts/ui/render.js');
  // 可控时间戳:同壁钟总时长 1.0s,三种帧率(30/60/120fps)的 dt 序列
  const seqs = [
    { fps: 30, dts: Array(30).fill(1 / 30) },
    { fps: 60, dts: Array(60).fill(1 / 60) },
    { fps: 120, dts: Array(120).fill(1 / 120) },
  ];
  for (const [target, name] of [[5, '扣 5'], [100, '扣 100']]) {
    const tracks = seqs.map(({ dts }) => {
      let cur = 0; const track = [];
      for (const dt of dts) { cur = rollToward(cur, target, dt); track.push(Math.round(cur)); }
      return track;
    });
    // 同壁钟时间点(每 0.1s 取样)显示值三种帧率相同(容差 1:取整相位差)
    for (let k = 1; k <= 10; k++) {
      const idx30 = Math.min(29, Math.round(k * 3) - 1);
      const idx60 = Math.min(59, Math.round(k * 6) - 1);
      const idx120 = Math.min(119, Math.round(k * 12) - 1);
      const vs = [tracks[0][idx30], tracks[1][idx60], tracks[2][idx120]];
      const spread = Math.max(...vs) - Math.min(...vs);
      assert.ok(spread <= 1, `${name} 帧率无关:@${(k / 10).toFixed(1)}s 显示值轨迹 30/60/120fps=${vs} 差 ${spread} ≤1`);
    }
    // 终值=目标
    for (const tr of tracks) assert.equal(tr[tr.length - 1], target, `${name} 终值=${target}`);
  }
});

// ---- M15 Task 51:开始界面生图产物绑定/缺图回退(START-02 F1/F2 整改) ----
test('M15 开始界面生图:仅背景/仅 LOGO 绑定、未加载与解码失败均经 render 入口回退程序化绘制', async () => {
  const { bindImages, startImagesBound } = await import('../scripts/ui/render.js');
  // 前置:本文件此前用例从未绑定开始界面图 → 两图未绑定=纯程序化(既有过审行为)
  const r0 = mkCtx();
  render(r0.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  assert.ok(r0.rec.fillTexts.includes('言出法随'), '两图未绑定:程序化文字标题');
  assert.ok(!r0.rec.draws.some(d => d.img.includes('assets/backgrounds/start/')), '两图未绑定:无背景 drawImage');
  assert.ok(!r0.rec.draws.some(d => d.img.includes('assets/ui/start/')), '两图未绑定:无 LOGO drawImage');

  // 仅绑定 LOGO(背景未绑定):背景程序化渐变实际输出(全屏 fillRect),LOGO 未加载→文字标题
  const fakeLogo = { _src: 'assets/ui/start/logo.png', complete: false, naturalWidth: 0 };
  bindImages({ get: (k) => (k === 'ui:start_logo' ? fakeLogo : undefined) });
  const rl0 = mkCtx();
  render(rl0.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  assert.ok(rl0.rec.gradients > 0, '仅 LOGO 未加载:背景程序化渐变实际创建');
  assert.ok(rl0.rec.fillRects.some(f => f.w === 720 && f.h === 1280), '仅 LOGO 未加载:背景全屏填充实际输出(非空白)');
  assert.ok(!rl0.rec.draws.some(d => d.img.includes('assets/backgrounds/start/')), '仅 LOGO:无背景 drawImage');
  assert.ok(rl0.rec.fillTexts.includes('言出法随'), '仅 LOGO 未加载:文字标题回退');
  fakeLogo.complete = true; fakeLogo.naturalWidth = 1000;
  const rl1 = mkCtx();
  render(rl1.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  const logoDraw = rl1.rec.draws.find(d => d.img.includes('assets/ui/start/logo.png'));
  assert.ok(logoDraw, '仅 LOGO 加载后绘制(find 谓词判别力对照:下条几何断言同源)');
  assert.equal(logoDraw.a[2], 500, 'LOGO 显示区宽 500');
  assert.equal(logoDraw.a[3], 220, 'LOGO 显示区高 220');
  assert.equal(logoDraw.a[0], 110, 'LOGO 显示区 x=110');
  assert.ok(logoDraw.a[1] >= 122 && logoDraw.a[1] <= 138, 'LOGO y=ty-120 ∈[122,138](浮动 ±8)');
  assert.ok(rl1.rec.fillRects.some(f => f.w === 720 && f.h === 1280), '仅 LOGO 加载:背景仍程序化渐变填充');
  assert.ok(!rl1.rec.fillTexts.includes('言出法随'), '仅 LOGO 加载:不再程序化文字标题');

  // 追加绑定背景(LOGO 仍处上一段绑定态——bindImages 只填充不清空):背景未加载→渐变兜底实际输出;加载后 drawImage 且不再全屏填充
  const fakeBg = { _src: 'assets/backgrounds/start/start_bg.png', complete: false, naturalWidth: 0 };
  bindImages({ get: (k) => (k === 'ui:start_bg' ? fakeBg : undefined) });
  const rb0 = mkCtx();
  render(rb0.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  assert.ok(!rb0.rec.draws.some(d => d.img.includes('assets/backgrounds/start/start_bg.png')), '背景未解码完成不 drawImage');
  assert.ok(rb0.rec.fillRects.some(f => f.w === 720 && f.h === 1280), '背景未加载:渐变全屏兜底实际输出');
  assert.ok(rb0.rec.draws.some(d => d.img.includes('assets/ui/start/logo.png')), '标题由仍处绑定态的 LOGO 图承担(未加载回退由 r0 段覆盖)');
  fakeBg.complete = true; fakeBg.naturalWidth = 720;
  const rb1 = mkCtx();
  render(rb1.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  assert.ok(rb1.rec.draws.some(d => d.img.includes('assets/backgrounds/start/start_bg.png')), '背景加载后全屏 drawImage(1:1)');
  assert.ok(!rb1.rec.fillRects.some(f => f.w === 720 && f.h === 1280), '背景贴图就绪后不再程序化全屏填充');
  assert.ok(rb1.rec.draws.some(d => d.img.includes('assets/ui/start/logo.png')), 'LOGO 仍处绑定态正常绘制');
  assert.ok(rb1.rec.draws.some(d => d.img.includes('assets/ui/start/logo.png')), '标题由仍处绑定态的 LOGO 图承担');

  // 背景解码失败(complete=true 但 naturalWidth=0)而 LOGO 正常:渐变兜底+LOGO 保持绘制
  fakeBg.complete = true; fakeBg.naturalWidth = 0;
  bindImages({ get: (k) => (k === 'ui:start_bg' ? fakeBg : (k === 'ui:start_logo' ? fakeLogo : undefined)) });
  const rbg = mkCtx();
  render(rbg.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  assert.ok(!rbg.rec.draws.some(d => d.img.includes('assets/backgrounds/start/start_bg.png')), '背景解码失败不 drawImage');
  assert.ok(rbg.rec.fillRects.some(f => f.w === 720 && f.h === 1280), '背景解码失败:渐变全屏兜底实际输出');
  assert.ok(rbg.rec.draws.some(d => d.img.includes('assets/ui/start/logo.png')), '背景解码失败:LOGO 保持正常绘制');

  // LOGO 解码失败(背景已加载):LOGO 不绘制+文字回退,背景贴图保持
  fakeBg.naturalWidth = 720;
  fakeLogo.naturalWidth = 0;
  const r3 = mkCtx();
  render(r3.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  assert.ok(!r3.rec.draws.some(d => d.img.includes('assets/ui/start/logo.png')), 'LOGO 解码失败不 drawImage');
  assert.ok(r3.rec.fillTexts.includes('言出法随'), 'LOGO 解码失败:文字标题回退');
  assert.ok(r3.rec.draws.some(d => d.img.includes('assets/backgrounds/start/start_bg.png')), '背景贴图保持绘制');
  // 探针只表示引用已绑定(两图均仍在绑定态)
  assert.deepEqual(startImagesBound(), { bg: true, logo: true }, '图片仍已绑定,解码失败时回退程序化绘制');
});

// ---- 需求方 2026-10-19:开始界面主角动画异常快(worldT 按帧数推进→高刷屏 2 倍速) ----
test('M15 表现层时钟:worldT 按 render 实际 dt 推进(同壁钟时长下推进量与帧数无关)', async () => {
  const { animClock } = await import('../scripts/ui/render.js');
  const t0 = animClock();
  // 同样 0.5s 壁钟:低帧 4fps(2 帧×0.25s)与 12fps(6 帧×1/12s)推进量相同——推进量与帧数解耦
  render(mkCtx().ctx, mkEngineStub(), mkHud({ screen: () => 'start' }), 0.25);
  render(mkCtx().ctx, mkEngineStub(), mkHud({ screen: () => 'start' }), 0.25);
  const after30 = animClock() - t0;
  const t1 = animClock();
  for (let i = 0; i < 6; i++) render(mkCtx().ctx, mkEngineStub(), mkHud({ screen: () => 'start' }), 1 / 12);
  const afterVar = animClock() - t1;
  assert.ok(Math.abs(after30 - 0.5) < 1e-9, `4fps 口径(2 帧×0.25s)0.5s 壁钟推进 ${after30}`);
  assert.ok(Math.abs(afterVar - 0.5) < 1e-9, `12fps 口径(6 帧×1/12s)推进 ${afterVar}(与帧数解耦)`);
});

// ---- BEAUTIFY-01 整改守护(12 项建议中的可机械断言子集) ----
test('BEAUTIFY F3 屏幕路由:非战斗屏不再绘制战斗区敌人/棋盘/结算', async () => {
  const { BattleHudView } = await import('../scripts/ui/battle_hud.js');
  const mkBattleHud = () => ({
    battle: {
      phase: 'FIGHTING', hp: 100, maxHp: 100, shield: 0, level: 1, wave: 1,
      enemies: [], ebolts: [], bolts: [], zones: [], aliveEnemies: () => [],
      playerAttackT: 0, hurtT: 0, coinsGained: 0, matsGained: 0, expGained: 0, kills: 0,
    },
    battleHud: new BattleHudView(),
    parallax: { transform: () => ({ ox: 0, oy: 0, scale: 1 }), draw() {} },
  });
  // start 屏:battle 存在(旧局残留)也不绘战斗区与棋盘
  const rs = mkCtx();
  render(rs.ctx, mkEngineStub(), Object.assign(mkHud({ screen: () => 'start' }), mkBattleHud()));
  assert.ok(!rs.rec.fillRects.some(f => f.w === 720 && f.h === 448), 'start 屏不绘战斗区底');
  assert.ok(!rs.rec.fillRects.some(f => f.w === 720 && f.h === 112 && f.y === 1168), 'start 屏不绘底栏');
  // playing 屏:照常绘制(回归)
  const rp = mkCtx();
  render(rp.ctx, mkEngineStub(), Object.assign(mkHud({ screen: () => 'playing' }), mkBattleHud()));
  assert.ok(rp.rec.fillRects.some(f => f.w === 720 && f.h === 44 && f.y === 0), 'playing 屏战斗区货币栏条带照常(parallax 桩无渐变底,以 44px 条带为准)');
});

test('BEAUTIFY F2/F6 按钮:primary 深青绿底(白字对比 5.20)+按压态(-04 R2 归属按下时确定)', async () => {
  const { setPressPoint, pressMove, UI } = await import('../scripts/ui/render.js');
  const src = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(src.includes("primaryBtn: '#0e7a70'"), 'primary 按钮底 #0e7a70(对比 5.20:1)');
  const downP = { x: UI.start.playBtn.x + 10, y: UI.start.playBtn.y + 10 };
  // 按压态:底色加深 #0c6b63(shade 0.88 位运算实值);tag 三段=屏:浮层:养成页(与 main 同源)
  setPressPoint({ ...downP }, 'start::0:0');
  const rp = mkCtx();
  render(rp.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  assert.ok(rp.rec.fillStyles.includes('#0c6b63'), `按压底色 #0c6b63 实际出现(实得 ${JSON.stringify(rp.rec.fillStyles.slice(0, 6))})`);
  // R2/N3:移动跟随只更新坐标、不重写 tag——导航后移动到 menu 屏**真按钮**(养成入口
  // growBtn 中心,该处确有可变色按钮)也不重新获得按压色(有效反例:目标点在按钮内)。
  // -07 S2:目标按钮是 ghost——错误继承会产生 ghost 按压色 #d3ccbe,两种按压色都必须不出现
  pressMove({ x: 631, y: 1180 }); // UI.menu.growBtn 中心
  const rx = mkCtx();
  render(rx.ctx, mkEngineStub(), mkHud({ screen: () => 'menu' }));
  assert.ok(!rx.rec.fillStyles.includes('#0c6b63'), '导航后移动不重绑:menu 屏 growBtn(真按钮)上无 primary 按压色');
  assert.ok(!rx.rec.fillStyles.includes('#d3ccbe'), '导航后移动不重绑:growBtn 是 ghost 按钮,错误继承会画出 ghost 按压色 #d3ccbe——也不得出现');
  // 松手清除
  setPressPoint(null);
  const ru = mkCtx();
  render(ru.ctx, mkEngineStub(), mkHud({ screen: () => 'start' }));
  assert.ok(ru.rec.fillStyles.includes('#0e7a70') && !ru.rec.fillStyles.includes('#0c6b63'), '松手恢复常态无残留');
  // R5:fx 关无按压视觉
  setPressPoint({ ...downP }, 'start::0:0');
  const rf = mkCtx();
  render(rf.ctx, { ...mkEngineStub(), fxEnabled: false }, mkHud({ screen: () => 'start' }));
  assert.ok(!rf.rec.fillStyles.includes('#0c6b63'), 'fx 关闭无按压视觉');
  setPressPoint(null);
});

test('BEAUTIFY F11 彩带:同壁钟时刻片数与帧率无关(-03 B1/B6 整改:真跑 drawResult 统计)', async () => {
  const { resultRestart } = await import('../scripts/ui/render.js');
  // 胜利 battle 桩:VICTORY → render 走 drawResult;彩带片 fillRect 特征 w 9..15 且 h 13..21
  const victoryHud = () => mkHud({
    screen: () => 'playing',
    battle: { phase: 'VICTORY', hp: 1, maxHp: 1, shield: 0, level: 1, wave: 1, kills: 3, coinsGained: 5, matsGained: 2, expGained: 9, victoryCoins: 10, victoryMats: 5, enemies: [], ebolts: [], bolts: [], zones: [], aliveEnemies: () => [], playerAttackT: 0, hurtT: 0 },
  });
  const lastFrameConfetti = (dts) => {
    resultRestart();
    let n = -1;
    for (const d of dts) {
      const r = mkCtx();
      render(r.ctx, mkEngineStub(), victoryHud(), d);
      n = r.rec.fillRects.filter(f => f.w >= 9 && f.w <= 15 && f.h >= 13 && f.h <= 21).length; // 末帧活跃片数
    }
    return n;
  };
  // t=1.0s 壁钟:target=Math.floor((1.0-0.8)*45)=8(浮点口径 1.0-0.8=0.19999999999999996,机械复算同式)——
  // 4fps(4×0.25s)与 24fps(24×1/24s)片数相同=帧率无关
  const low = lastFrameConfetti([0.25, 0.25, 0.25, 0.25]);
  const high = lastFrameConfetti(Array.from({ length: 24 }, () => 1 / 24));
  const expect = Math.floor((1.0 - 0.8) * 45); // 与实现同式机械复算(浮点透明)
  assert.equal(low, expect, `4fps 下 t=1.0s 彩带 ${expect} 片(实得 ${low})`);
  assert.equal(high, expect, `24fps 下 t=1.0s 彩带 ${expect} 片(实得 ${high},与帧率无关)`);
  // 上限 120:t=3.2s target=min(120,108)=108;t 足够后不再超 120
  const src = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(src.includes('CONFETTI_COLORS'), '彩带色表为模块级常量(不再每帧建数组)');
});

test('BEAUTIFY F9 释放反馈:带参定位不依赖预热缓存,墙钟 160ms(-04 R3 整改)', async () => {
  const { BattleHudView } = await import('../scripts/ui/battle_hud.js');
  const v = new BattleHudView();
  const loadout = ['fire_bolt', 'water_bolt', 'wood_bolt', 'earth_bolt'];
  // R3:不预热缓存(update 不调),直接按产品顺序 noteCast——首局首帧可亮
  let clock = 1000;
  v._now = () => clock;
  v.noteCast('fire_bolt', loadout);
  v.noteCast('water_bolt', loadout);
  assert.equal(v.castAt[0], 1000, '槽 0 记录释放时刻(构造后缓存为空也能定位)');
  assert.equal(v.castAt[1], 1000, '同帧双技能两槽均记');
  assert.equal(v.castAt[2], 0, '未释放槽不亮');
  const before = [...v.castAt];
  v.noteCast('metal_pulse', loadout); // 未装配:忽略不覆盖
  assert.deepEqual(v.castAt, before, '未装配技能被忽略');
  // R3:墙钟口径——160ms 内有效、超过即过期(与模拟 dt 封顶解耦)
  const hudStub = { battle: {}, caster: { loadout, skillCds: {} }, fxEnabled: () => true };
  // 亮边特征=save 后设置 0<globalAlpha<1(Boss 菱形白描边恒画,strokeStyle 特征不唯一)
  clock = 1100; // +100ms < 160
  {
    const r = mkCtx();
    v.draw(r.ctx, hudStub);
    assert.ok(r.rec.globals.some(a => a > 0 && a < 1), `100ms 时亮边在画(alpha=${1 - 100 / 160},实得 ${JSON.stringify(r.rec.globals)})`);
  }
  clock = 1200; // +200ms ≥ 160 过期
  {
    const r = mkCtx();
    v.draw(r.ctx, hudStub);
    assert.ok(!r.rec.globals.some(a => a > 0 && a < 1), '200ms 后亮边停止');
  }
  // R4:draw 读实时开关——暂停期(update 不跑)关动效立即隐藏
  clock = 1050;
  const rOff = mkCtx();
  v.draw(rOff.ctx, { ...hudStub, fxEnabled: () => false });
  assert.ok(!rOff.rec.globals.some(a => a > 0 && a < 1), 'fx 关(实时读)不画亮边');
  v.reset();
  assert.deepEqual(v.castAt, [0, 0, 0, 0], 'reset 清全部');
});

test('BEAUTIFY F10/R4 存量冒字:关动效不绘制未结束的 HP/ATK 冒字(-04 R4)', async () => {
  const { growFloatText } = await import('../scripts/ui/render.js');
  growFloatText('HP +15', 320, 232, '#6fba2c');
  growFloatText('ATK +1', 320, 270, '#6fba2c');
  // fx 关:存量冒字不绘制(与战斗侧「停止绘制存量粒子/冒字」同口径)
  const rOff = mkCtx();
  render(rOff.ctx, { ...mkEngineStub(), fxEnabled: false }, mkHud({ screen: () => 'menu', growPanel: () => true }));
  assert.ok(!rOff.rec.fillTexts.includes('HP +15'), 'fx 关:HP 冒字不绘制');
  assert.ok(!rOff.rec.fillTexts.includes('ATK +1'), 'fx 关:ATK 冒字不绘制');
});

test('BEAUTIFY F7 浮层:关闭后重开重新淡入;skillTips 换槽重放(-03 B3 整改)', async () => {
  // 首次打开:globalAlpha<1(淡入进行)
  const r1 = mkCtx();
  render(r1.ctx, mkEngineStub(), mkHud({ screen: () => 'start', panel: () => 'settings' }));
  assert.ok(r1.rec.globals.some(a => a < 1), `首次打开 alpha<1(实得 ${JSON.stringify(r1.rec.globals.slice(0, 4))})`);
  // 推进 0.5s(多帧)→ 终态 alpha=1
  const hud2 = mkHud({ screen: () => 'start', panel: () => 'settings' });
  render(mkCtx().ctx, mkEngineStub(), hud2, 0.05);
  const r2 = mkCtx();
  render(r2.ctx, mkEngineStub(), hud2, 0.5);
  assert.ok(r2.rec.globals.every(a => a === 1), `淡入完成后 alpha=1(实得 ${JSON.stringify(r2.rec.globals)})`);
  // 关闭(无浮层帧)→ 同一浮层重开:重新淡入(B3:不再沿用旧起点直接终态)
  render(mkCtx().ctx, mkEngineStub(), mkHud({ screen: () => 'start', panel: () => null }), 0.1);
  const r3 = mkCtx();
  render(r3.ctx, mkEngineStub(), mkHud({ screen: () => 'start', panel: () => 'settings' }));
  assert.ok(r3.rec.globals.some(a => a < 1), `重开后重新淡入 alpha<1(实得 ${JSON.stringify(r3.rec.globals.slice(0, 4))})`);
  // 源码:skillTips 键含槽位(换槽重放)
  const src = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(src.includes('overlayIn(`skillTips:${lo.tipsSlot}`)'), 'skillTips 键含槽位');
});

test('BEAUTIFY F3 路由:menu/loadout 屏不绘棋盘与底栏,playing 照常(-03 复验补充)', () => {
  const boardish = (rec) => rec.fillRects.some(f => f.y === 448 && f.h === 720); // 棋盘底(BOARD_Y=448,8×90=720)
  const bottomBar = (rec) => rec.fillRects.some(f => f.y === 1168 && f.h === 112);
  for (const scr of ['menu', 'loadout']) {
    const r = mkCtx();
    render(r.ctx, mkEngineStub(), mkHud({ screen: () => scr }));
    assert.ok(!boardish(r.rec) && !bottomBar(r.rec), `${scr} 屏不绘棋盘底与底栏`);
  }
  const rp = mkCtx();
  render(rp.ctx, mkEngineStub(), mkHud({ screen: () => 'playing' }));
  assert.ok(boardish(rp.rec) && bottomBar(rp.rec), 'playing 屏棋盘与底栏照常');
});

test('BEAUTIFY 需求方第三批:换装行含技能描述;选关顶栏无等级 chip;缩略图按关卡 Boss 表', async () => {
  // 换装抽屉(skillPick):行内出现 skillDetailText 描述文本
  const rp = mkCtx();
  render(rp.ctx, mkEngineStub(), mkHud({
    screen: () => 'loadout',
    loadout: () => ({ selLevel: 1, selSlot: 0, panel: 'skillPick', pickSlot: 0, tipsSlot: -1 }),
    profile: () => ({ level: 3, coins: 120, materials: 8, expTotal: 80, ownedSkills: ['fire_bolt', 'water_bolt', 'wood_bolt'], skillLevels: { fire_bolt: 2 }, loadout: ['fire_bolt'], settings: { effects: true } }),
  }));
  assert.ok(rp.rec.fillTexts.some(t => t.includes('单体弹道直击')), `换装行出现技能描述(实得样例 ${rp.rec.fillTexts.slice(0, 8).join('|')})`);
  // 选关:顶栏无「Lv.」chip 文本(第三批:等级/经验移除)
  const rm = mkCtx();
  render(rm.ctx, mkEngineStub(), mkHud({ screen: () => 'menu' }));
  assert.ok(!rm.rec.fillTexts.some(t => t.startsWith('Lv.')), '选关顶栏无 Lv chip');
  // 源码:缩略图走 bossType(i)(每关 Boss 表)
  const src = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(src.includes('ENEMY_FRAMES[bossType(i)]'), '选关缩略图=该关 Boss 类型帧');
});

// ---- BEAUTIFY -07 整改守护(Q5 ghost 按压 / Q2 Q3 掉落生命周期) ----
test('BEAUTIFY F6 ghost 按压正例:menu 屏养成按钮按压色 #d3ccbe(shade 0.88),不产生 primary 按压色', async () => {
  const { setPressPoint, UI } = await import('../scripts/ui/render.js');
  setPressPoint({ x: UI.menu.growBtn.x + 10, y: UI.menu.growBtn.y + 10 }, 'menu::0:0');
  const r = mkCtx();
  render(r.ctx, mkEngineStub(), mkHud({ screen: () => 'menu' }));
  assert.ok(r.rec.fillStyles.includes('#d3ccbe'), `ghost 按压底色 #d3ccbe 实际出现(实得 ${JSON.stringify(r.rec.fillStyles.slice(0, 8))})`);
  assert.ok(!r.rec.fillStyles.includes('#0c6b63'), 'ghost 按钮按压不产生 primary 按压色(材质归属正确)');
  setPressPoint(null);
});

test('BEAUTIFY -07 掉落系统:到达到账/收益守恒/池满丢弃/fx 关清池/reset 清池/到达音效排队', async () => {
  const R = await import('../scripts/ui/render.js');
  const { spawnCoinDrop, syncDropBank, resetDropBank, takeDropSfx, dropArriveCoin, dropArriveMat } = R;
  const battleStub = () => ({ phase: 'FIGHTING', hp: 100, maxHp: 100, shield: 0, level: 1, wave: 1, enemies: [], ebolts: [], bolts: [], zones: [], aliveEnemies: () => [], playerAttackT: 0, hurtT: 0, coinsGained: 0, matsGained: 0, expGained: 0, kills: 0 });
  const playingHud = () => mkHud({ screen: () => 'playing', battle: battleStub() });
  const fxOffHud = () => mkHud({ screen: () => 'playing', battle: battleStub() });
  const step = (n, eng = mkEngineStub(), dt = 0.1) => {
    let last = null;
    for (let i = 0; i < n; i++) { const c = mkCtx(); render(c.ctx, eng, playingHud(), dt); last = c; }
    return last;
  };
  // ① 正常到达+收益守恒:杀怪 +5 币(真值 120→125),显示从「真值−在途」滚到真值
  resetDropBank();
  spawnCoinDrop('coin', 5, 360, 300);
  syncDropBank(125, 8, true, 0.016); // base=125−5=120(在途未到账)
  let r0 = step(1);
  assert.ok(r0.rec.fillTexts.includes('120'), `在途未到账显示 120(实得 ${JSON.stringify(r0.rec.fillTexts.filter(t => t === '120' || t === '125'))})`);
  step(30, mkEngineStub(), 0.1); // 3s:抛物线落地 ~0.8 + 停留 ≤0.8 + 飞行 0.6 必到达
  assert.equal(dropArriveCoin(), 1, '到达计数器 +1(产品路径 render 推进)');
  assert.equal(takeDropSfx(), 'coin', '到达进入音效队列');
  assert.equal(takeDropSfx(), 'none', '队列消费后清空');
  for (let i = 0; i < 80; i++) syncDropBank(125, 8, true, 0.05); // 显示值滚动收敛(4s)
  const r1 = step(1);
  assert.ok(r1.rec.fillTexts.includes('125'), `到达后显示滚动到真值 125(收益守恒,实得 ${JSON.stringify(r1.rec.fillTexts.filter(t => t === '120' || t === '125'))})`);
  // ② 池满丢弃:24 池满后再 spawn 丢弃(表现层);30 个 value 均已入账(真值=120+30=150)——
  // 在途仅 24 个,base=150−24=126,到达后显示收敛到真值 150;-07 S2:断言到达次数恰好 24
  resetDropBank();
  for (let i = 0; i < 30; i++) spawnCoinDrop('coin', 1, 360, 300); // 30>24:6 个被丢弃
  syncDropBank(150, 8, true, 0.016); // 真值 150 全部入账;在途 24 → base 126
  let r2 = step(1);
  assert.ok(r2.rec.fillTexts.includes('126'), `在途 24 个未到账显示 126(实得 ${JSON.stringify(r2.rec.fillTexts.filter(t => t === '126' || t === '150'))})`);
  const arriveBefore = dropArriveCoin();
  step(30, mkEngineStub(), 0.1);
  assert.equal(dropArriveCoin() - arriveBefore, 24, '池满丢弃:恰好 24 个到达(30 注入中 6 个表现层丢弃,不产生到达)');
  for (let i = 0; i < 80; i++) syncDropBank(150, 8, true, 0.05);
  r2 = step(1);
  assert.ok(r2.rec.fillTexts.includes('150'), `池满丢弃不影响数值口径:到达后显示=真值 150(收益守恒,实得 ${JSON.stringify(r2.rec.fillTexts.filter(t => t === '126' || t === '150'))})`);
  // ③ fx 关清池强制到账:显示立即=真值,池清空(后续无到达)
  resetDropBank();
  spawnCoinDrop('coin', 9, 360, 300);
  syncDropBank(129, 8, false, 0.016); // fx 关:清池+显示=真值 129
  const r3 = step(1, { ...mkEngineStub(), fxEnabled: false });
  assert.ok(r3.rec.fillTexts.includes('129'), `fx 关显示立即=真值 129(在途强制到账,实得 ${JSON.stringify(r3.rec.fillTexts.filter(t => t === '120' || t === '129'))})`);
  const arrivedBefore = dropArriveCoin();
  step(30, { ...mkEngineStub(), fxEnabled: false }, 0.1);
  assert.equal(dropArriveCoin(), arrivedBefore, 'fx 关池已清:无掉落继续飞行到达');
  // ④ reset 清池:跨局不残留(新局显示从当前真值起步,旧在途物不再扣减)
  resetDropBank();
  spawnCoinDrop('coin', 7, 360, 300);
  resetDropBank();
  syncDropBank(125, 8, true, 0.016); // 池已清:base=125(无在途扣减)
  const r4 = step(1);
  assert.ok(r4.rec.fillTexts.includes('125'), `reset 后显示=真值 125(旧在途不扣减,实得 ${JSON.stringify(r4.rec.fillTexts.filter(t => t === '118' || t === '125'))})`);
  const arr5 = dropArriveCoin();
  step(30, mkEngineStub(), 0.1);
  assert.equal(dropArriveCoin(), arr5, 'reset 清池后无旧物到达');
  // ⑤ 同帧多到达排队:每帧消费一个逐帧补响(每到达一次一响)
  resetDropBank();
  for (let i = 0; i < 3; i++) spawnCoinDrop('coin', 1, 660, 40); // 芯片锚点旁:立即起飞快速到达
  step(30, mkEngineStub(), 0.1);
  const burst = [takeDropSfx(), takeDropSfx(), takeDropSfx(), takeDropSfx()];
  assert.equal(burst.filter(s => s === 'coin').length, 3, `3 个到达排队,逐帧各消费一个(实得 ${JSON.stringify(burst)})`);
  // ⑥ -07 S1 关动效清回弹存量:到达当帧 bump 计时中切 fx 关,chip 图标立即恢复原尺寸(dt=0 不残留放大)
  // 注入伪造 coin/pick 贴图(与 M11-02 F1 同法)——drawAssetIcon 走 drawImage 分支,尺寸可断言
  const fakeIcon = { complete: true, naturalWidth: 18, naturalHeight: 18 };
  const { bindImages } = await import('../scripts/ui/render.js');
  bindImages({ get: (k) => (k === 'icon:ui:coin' || k === 'icon:ui:pick' ? fakeIcon : undefined) });
  resetDropBank();
  spawnCoinDrop('coin', 5, 660, 40);
  syncDropBank(125, 8, true, 0.016);
  for (let i = 0; i < 30; i++) {
    step(1, mkEngineStub(), 0.1);
    syncDropBank(125, 8, true, 0.1);
    if (dropArriveCoin() > 0) break; // 第一到达当帧(bump=0.35 刚置位)
  }
  syncDropBank(125, 8, false, 0.016); // 关动效:清池+bump 清零+显示=真值
  const r6 = step(1, { ...mkEngineStub(), fxEnabled: false }, 0.016);
  const chipSizes = r6.rec.draws.filter(d => d.a && d.a.length === 4 && d.a[2] >= 15 && d.a[2] <= 30).map(d => d.a[2]);
  assert.ok(chipSizes.length > 0 && chipSizes.every(sz => sz === 20), `关动效后 chip 图标全部原尺寸 20(bump 存量已清,实得 ${JSON.stringify(chipSizes)})`);
  resetDropBank();
});
