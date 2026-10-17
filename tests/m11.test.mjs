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
const { render, UI } = await import('../scripts/ui/render.js');
const { FxLayer } = await import('../scripts/ui/fx.js');
const { attachInput } = await import('../scripts/core/input.js');

// ---- 录制型 2D context 桩 ----
function mkCtx() {
  const rec = { fillTexts: [], draws: [], strokes: 0, rects: [] };
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === '__rec') return rec;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'fillText') return (text) => rec.fillTexts.push(String(text));
      if (prop === 'drawImage') return (img, ...a) => rec.draws.push({ img: String(img?._src ?? img), a });
      if (prop === 'stroke') return () => { rec.strokes++; };
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set() { return true; },
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
  assert.ok(r.rec.fillTexts.some(t => t.includes('赤狐 · Lv.3')), '主角面板');
  assert.ok(r.rec.fillTexts.some(t => t.includes('出战信息')), '出战信息卡');
  assert.ok(r.rec.fillTexts.some(t => t.includes('建议等级:Lv.4+')), '建议等级(LEVEL_META)');
  assert.ok(r.rec.fillTexts.some(t => t.includes('⚠ 等级低于建议')), '低等级警告 chip(Lv3<建议4)');
  assert.ok(r.rec.fillTexts.some(t => t.includes('技能装配')), '装配槽区');
  assert.ok(r.rec.fillTexts.some(t => t.includes('火弹')), '技能库行(已装配)');
  assert.ok(r.rec.fillTexts.some(t => t.includes('烈焰环')), 'Lv6 技能行存在');
  // M11-02 F4:等级够但未拥有 → 「未拥有」灰显(装配门控与 cast.js 释放条件一致)
  assert.ok(r.rec.fillTexts.some(t => t.includes('未拥有')), '未拥有技能灰显标注');
  assert.ok(r.rec.fillTexts.some(t => t.includes('●')), '已装配●标记');
  assert.ok(r.rec.fillTexts.some(t => t.includes('出 战')), '出战按钮');
  // 高等级无警告
  const r2 = mkCtx();
  render(r2.ctx, mkEngineStub(), mkHud({ screen: () => 'loadout', profile: () => ({ level: 10, coins: 0, materials: 0, expTotal: 500, ownedSkills: [], skillLevels: {}, loadout: [], settings: { effects: true } }) }));
  assert.ok(!r2.rec.fillTexts.some(t => t.includes('⚠ 等级低于建议')), 'Lv10≥建议4 无警告');
});

test('M11 结算界面:胜利(通关横幅/统计行/解锁 chip/按钮组)与失败(战败横幅/鼓励文案/按钮组)', () => {
  const battle = { phase: 'VICTORY', level: 3, kills: 129, expGained: 4226, coinsGained: 240, matsGained: 20, victoryCoins: 150, victoryMats: 30, wave: 10, enemies: [], ebolts: [], bolts: [], zones: [] };
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
  assert.ok(r2.rec.fillTexts.some(t => t.includes('失败无惩罚')), '宽松取向说明');
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
  assert.ok(r2.rec.fillTexts.some(t => t.includes('消除动效:开')), '动效开关(设置面板)');
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
test('M11 接线:main 五屏路由/暂停门控/道具图标;manifest 26 张;levels 元数据', () => {
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

test('M11-02 F2 技能库布局:两列 8 行(15 技能坐标全有限);命中区 ui* helper 与绘制同源', async () => {
  const { uiCardBtn, uiSlotRect, uiLibRect } = await import('../scripts/ui/render.js');
  // 15 技能库坐标全部有限且在界面内(修复前第 15 个 col=2 → x=undefined NaN)
  for (let i = 0; i < 15; i++) {
    const r = uiLibRect(i);
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y), `技能 ${i + 1} 坐标有限`);
    assert.ok(r.x >= 0 && r.x + r.w <= 720 && r.y >= 0 && r.y + r.h <= 1280, `技能 ${i + 1} 行在界面内`);
  }
  const r15 = uiLibRect(14);
  assert.equal(r15.x, uiLibRect(13).x, '第 15 项与第 14 项同列(两列装下)');
  for (let L = 1; L <= 5; L++) {
    const b = uiCardBtn(L);
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && b.y + b.h <= 1280, `L${L} 卡片按钮命中有限且在屏内`);
  }
  for (let i = 0; i < 4; i++) {
    const s = uiSlotRect(i);
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `槽 ${i + 1} 命中有限`);
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
  assert.ok(saveSrc.includes('settings: { effects: true, sfx: true }'), 'F5:默认档含 sfx');
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
  // 行矩形:逐行下移、宽 600、在面板内
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].rect.y, rows[i - 1].rect.y + UIC.loadout.pickRowH, `行 ${i} 逐行下移`);
  }
  // 绘制:skillPick 面板(标题+行+关闭)+skillTips 浮层(名称+档位数值+关闭提示)
  const r1 = mkCtx();
  render(r1.ctx, mkEngineStub(), mkHud({ screen: () => 'loadout', loadout: () => ({ selLevel: 2, selSlot: 0, panel: 'skillPick', pickSlot: 1, tipsSlot: -1 }) }));
  assert.ok(r1.rec.fillTexts.some(t => t.includes('选择技能 → 槽位 2')), 'pick 面板标题带目标槽位');
  assert.ok(r1.rec.fillTexts.some(t => t.includes('关 闭')), 'pick 关闭按钮');
  assert.ok(r1.rec.fillTexts.some(t => t.includes('未拥有')), '未拥有灰显标注');
  // F13 整改:数值列按技能类型口径——ATK=10/Lv3(mkHud 档):基础弹(伤害)T1=10、盾 20、火弹已装配不在列
  assert.equal(r1.rec.fillTexts.filter(t => ['伤害', '护盾值', '直击伤害', '每秒回复', '减速效果', '每秒伤害'].includes(t)).length, 11, '列表 11 行(已装配 4 项过滤后)各带类型化数值标签(F13)');
  assert.ok(r1.rec.fillTexts.includes('12'), '基础弹 T1 伤害=ATK12×1.0=12(F13 修复前 dmgCoef 缺省按 0 显示 0)');
  // F13 残留整改:bind(藤蔓束缚)=每秒 ATK×0.3×档(ATK=12)——首档 4(修复前误按 dmgCoef=1 显示 12)
  assert.ok(r1.rec.fillTexts.includes('每秒伤害'), 'bind 行类型化标签=每秒伤害');
  assert.ok(r1.rec.fillTexts.includes('4'), '藤蔓束缚 T1 每秒伤害=12×0.3×1.0→4(F13 残留修复前显示 12)');
  assert.ok(r1.rec.fillTexts.some(t => t.includes('每秒 ATK×0.3')), 'bind 描述含每秒系数');
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
