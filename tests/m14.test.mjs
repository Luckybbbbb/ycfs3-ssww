// tests/m14.test.mjs — M14 批次(需求方 2026-10-18):
// ①局内战斗 BGM(zhuayao.mp3 复用,循环,playing+FIGHTING 且非暂停出声;设置「音乐」开关默认开,入档 settings.bgm)
// ②toast 迁战斗区中上方+修复文字偏右(显式 textAlign)
// ③移除「元素 ×N → 档位」消除方块提示与「交换」提示(音效保留)
// 运行: node --test tests/m14.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('M14 audio:bgm 模块默认开;无 DOM 环境 set/安全早退不抛错;文件存在且 ASCII 路径', async () => {
  const { bgm } = await import('../scripts/ui/audio.js');
  assert.equal(bgm.enabled, true, 'BGM 默认开(需求方口径)');
  assert.doesNotThrow(() => { bgm.enabled = false; }, '关开关在无 DOM 环境不抛错(Audio 守卫)');
  assert.equal(bgm.enabled, false);
  assert.doesNotThrow(() => bgm.sync(true), 'sync 无 DOM 静默早退');
  bgm.enabled = true; // 还原默认
  assert.ok(fs.existsSync(new URL('../assets/sounds/bgm/zhuayao.mp3', import.meta.url)), 'BGM 文件已入库');
  assert.ok(!/[^\x20-\x7e]/.test('assets/sounds/bgm/zhuayao.mp3'), 'ASCII 路径');
  // 源码口径:懒加载单例+循环+音量
  const src = fs.readFileSync(new URL('../scripts/ui/audio.js', import.meta.url), 'utf-8');
  assert.ok(src.includes("new Audio('assets/sounds/bgm/zhuayao.mp3')"), 'BGM 源=复用 godot-roguelike zhuayao.mp3');
  assert.ok(src.includes('a.loop = true'), '循环播放');
  assert.ok(src.includes("a.volume = 0.35"), '音量 0.35');
  assert.ok(src.includes("typeof Audio === 'undefined'"), '无 DOM 守卫');
});

test('M14 save:settings 白名单含 bgm(缺省 true);main toggleBgm 写档+启动恢复+播控接线', () => {
  const saveSrc = fs.readFileSync(new URL('../scripts/meta/save.js', import.meta.url), 'utf-8');
  assert.ok(saveSrc.includes('settings: { effects: true, sfx: true, bgm: true }'), '默认档 bgm=true');
  assert.ok(saveSrc.includes('bgm: v.settings.bgm !== false'), '读档白名单 bgm(缺省 true)');
  const mainSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mainSrc.includes('profile.settings.bgm = bgm.enabled'), 'toggleBgm 写档');
  assert.ok(mainSrc.includes('bgm.enabled = profile.settings.bgm !== false'), '启动恢复(档案缺省 true)');
  assert.ok(mainSrc.includes("bgm.sync(screen === 'playing' && !paused && battle.phase === 'FIGHTING')"),
    '主循环播控:仅 playing+FIGHTING 且非暂停出声');
  assert.ok(mainSrc.includes("showToast(`音乐 ${bgm.enabled ? '开' : '关'}`)"), '切换 toast 反馈');
  assert.ok(mainSrc.includes("if (hit(p, UI.settings.bgmBtn)) { toggleBgm(); return; }"), '设置面板点击路由');
  assert.ok(mainSrc.includes("if (hit(p, UI.pause.bgmBtn)) { toggleBgm(); return; }"), '暂停面板点击路由');
});

test('M14 toast:移除「元素×N→档位」与「交换」提示;迁战斗区中上方且文字显式居中', () => {
  const mainSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(!mainSrc.includes('→ ${e.element}档 +${gain}`)'), '消除方块提示已移除(需求方 2026-10-18)');
  assert.ok(!mainSrc.includes("showToast('交换')"), '「交换」提示已移除(音效保留 sfx.swap)');
  assert.ok(!mainSrc.includes("'连锁中交换'"), '「连锁中交换」提示已移除');
  assert.ok(mainSrc.includes('sfx.swap()'), '交换音效保留');
  assert.ok(mainSrc.includes('sfx.match(e.chain)'), '消除音效保留');
  assert.ok(mainSrc.includes("showToast('棋盘瘫痪')"), '战斗信息 toast 保留(瘫痪)');
  const rSrc = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(rSrc.includes('roundRect(ctx, 180, 160, 360, 44, 12)'), 'toast 移战斗区中上方(y=160)');
  assert.ok(rSrc.includes("ctx.textAlign = 'center';\n    ctx.fillText(hud.toast.text, 360, 189)"), '文字显式居中(修复偏右)');
});

test('M14 UI:设置/暂停面板音乐按钮(布局+绘制);hud.bgmEnabled 句柄', () => {
  const rSrc = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(rSrc.includes('bgmBtn: { x: 160, y: 480, w: 400, h: 80 }'), '设置面板 bgmBtn 布局');
  assert.ok(rSrc.includes('bgmBtn: { x: 210, y: 580, w: 300, h: 60 }'), '暂停面板 bgmBtn 布局');
  assert.ok(rSrc.includes("drawBtn(ctx, UI.settings.bgmBtn, `音乐:${bgmOn ? '开' : '关'}`"), '设置面板绘制');
  assert.ok(rSrc.includes("drawBtn(ctx, UI.pause.bgmBtn, `音乐:${bgmOn ? '开' : '关'}`"), '暂停面板绘制');
  const mSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mSrc.includes('bgmEnabled: () => bgm.enabled'), 'hud.bgmEnabled 句柄');
});
