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
  assert.ok(r.rec.fillTexts.includes('三消守卫'), '主标题');
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
  assert.ok(r.rec.fillTexts.some(t => t.includes('Lv6解锁')), '未解锁灰显标注');
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
