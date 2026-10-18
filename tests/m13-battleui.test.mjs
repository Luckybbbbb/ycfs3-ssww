// tests/m13-battleui.test.mjs — M13 批次:战斗区 HUD 改版(头像+二段血条/关卡名/BOSS 条下移/
// 技能框右下/波次进度条/联动栏移除/棋盘上移 448/分关卡背景)
// 运行: node --test tests/m13-battleui.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { fullManifest } from '../scripts/assets/manifest.js';
import { HealthView, BattleHudView, bindHudImages, HUD_IMG, themeOf, GHOST_PUNCH, GHOST_RATE, GHOST_MAX } from '../scripts/ui/battle_hud.js';
import { BOARD_Y, CELL } from '../scripts/board/grid.js';

// ---- M13-1 图素清单 ----
test('M13 manifest:分关卡背景 5 主题×2 + 头像框/技能框/主角头像,共 13 项且文件存在', () => {
  const m = fullManifest().filter(it => it.entity === 'battle-ui');
  assert.equal(m.length, 13, `battle-ui 条目数=13,实际 ${m.length}`);
  const keys = new Set(m.map(it => it.key));
  for (const t of ['meadow', 'swamp', 'mist', 'snow', 'volcano']) {
    assert.ok(keys.has(`bg:${t}:far`) && keys.has(`bg:${t}:near`), `主题 ${t} 远近景在清单`);
  }
  assert.ok(keys.has('ui:avatar_frame') && keys.has('ui:skill_frame') && keys.has('ui:hero_avatar'), '两张边框+主角头像在清单');
  for (const it of m) {
    assert.ok(fs.existsSync(new URL(`../${it.url}`, import.meta.url)), `素材文件存在:${it.url}`);
    assert.ok(!/[^\x20-\x7e]/.test(it.url), `ASCII 路径:${it.url}`);
  }
});

// ---- M13-2 二段血条状态机 ----
test('M13 HealthView:受击主条立即扣+残影 punch→drain;连击重置且残影保持', () => {
  const v = new HealthView();
  v.update(1 / 60, 1); // 对齐满血
  v.update(1 / 60, 0.6); // 受击 −40%
  assert.equal(v.hp, 0.6, '主条立即扣');
  assert.equal(v.ghost, 1, '残影=旧血量');
  assert.equal(v.state, 'PUNCH');
  v.update(0.3, 0.6); // punch 计时 0.3s(<0.4)
  assert.equal(v.state, 'PUNCH', 'punch 停顿中');
  assert.equal(v.ghost, 1, 'punch 期残影不动');
  v.update(0.15, 0.6); // 累计 0.45s>0.4 → DRAIN
  assert.equal(v.state, 'DRAIN');
  const g0 = v.ghost;
  v.update(0.5, 0.6);
  assert.ok(v.ghost < g0, 'drain 期残影下降');
  assert.ok(Math.abs((g0 - v.ghost) / 0.5 - GHOST_RATE) < 0.01, `恒速 ${GHOST_RATE}/s(实际 ${(g0 - v.ghost) / 0.5})`);
  // 连击:punch 重置 + 残影保持(不回退)
  v.update(0.1, 0.4);
  assert.equal(v.ghost, Math.max(v.ghost, 0.6), '连击残影不回退');
  assert.equal(v.state, 'PUNCH', '连击重置为 punch');
  assert.equal(v.t, 0, 'punch 计时归零');
});

test('M13 HealthView:追平/兜底/治疗/关动效口径', () => {
  const v = new HealthView();
  v.update(1 / 60, 1);
  v.update(1 / 60, 0.9); // 小伤害
  v.update(GHOST_PUNCH + 1e-3, 0.9); // 进入 DRAIN
  v.update(10, 0.9); // 长时间:恒速追平(0.1/0.3≈0.33s 远小于兜底)
  assert.equal(v.state, 'IDLE', '追平归 IDLE');
  assert.equal(v.ghost, 0.9);
  // 兜底:大伤害(两步:先跨过 punch,再跨过 max)
  const v2 = new HealthView();
  v2.update(1 / 60, 1);
  v2.update(1 / 60, 0.05);
  v2.update(GHOST_PUNCH + 0.01, 0.05);
  v2.update(GHOST_MAX + 0.01, 0.05);
  assert.equal(v2.state, 'IDLE', '超过 GHOST_MAX 兜底收口');
  assert.ok(v2.ghost <= 0.05 + 1e-6, '兜底时残影=主条');
  // 治疗:立即对齐
  v2.update(1 / 60, 1);
  assert.equal(v2.ghost, 1, '治疗残影立即对齐');
  assert.equal(v2.state, 'IDLE');
  // 关动效:残影直接同步(无动画)
  const v3 = new HealthView();
  v3.update(1 / 60, 1);
  v3.update(1 / 60, 0.5, false);
  assert.equal(v3.ghost, 0.5, '关动效残影直接同步');
  assert.equal(v3.state, 'IDLE');
});

// ---- M13-3 绑定入口与主题映射 ----
test('M13 bindHudImages:绑定数=2;空 Map 复位;themeOf 循环映射', () => {
  const imgs = new Map(fullManifest().filter(it => it.entity === 'battle-ui').map(it => [it.key, { _src: it.url }]));
  assert.equal(bindHudImages(imgs), 3);
  assert.ok(HUD_IMG.avatarFrame && HUD_IMG.skillFrame);
  assert.equal(bindHudImages(new Map()), 0, '空 Map 复位(表全空语义)');
  assert.equal(themeOf(1), 'meadow');
  assert.equal(themeOf(5), 'volcano');
  assert.equal(themeOf(6), 'meadow', '第 6 关循环回 meadow');
  assert.equal(themeOf(0), 'meadow', '非法关卡兜底 meadow');
});

// ---- M13-4 parallax 分关卡背景 ----
test('M13 parallax:setLevel 切主题;bindImages 按主题取图;程序化兜底不抛错', async () => {
  const { Parallax } = await import('../scripts/battle/parallax.js');
  const px = new Parallax({ effects: true });
  px.setLevel(1);
  const m = new Map(fullManifest().filter(it => it.entity === 'battle-ui').map(it => [it.key, { _src: it.url }]));
  assert.equal(px.bindImages(m), 2, 'meadow 远近景绑定 2 张');
  px.setLevel(5); // volcano:主题变化 → 图待重绑
  assert.equal(px.imgs.far, null, '主题切换后待重绑');
  assert.equal(px.bindImages(m), 2, 'volcano 重绑 2 张');
  px.setLevel(3); // mist
  px.bindImages(m);
  // draw 冒烟(图未 complete → complete 检查走程序化兜底,不抛错)
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  px.update(1 / 60);
  px.draw(ctx);
  px.setWave(10, true);
});

// ---- M13-5 战斗区 HUD 绘制冒烟 + 布局迁移 ----
test('M13 BattleHudView:draw 冒烟不抛错;快照只读;BOSS 条仅 Boss 波', () => {
  const v = new BattleHudView();
  const battle = { hp: 120, maxHp: 175, level: 1, wave: 10, aliveEnemies: () => [{ name: 'boss', hp: 66, maxHp: 100, alive: true }] };
  const caster = { loadout: ['fire_bolt', 'water_chain'], skillCds: { fire_bolt: 1.2 } };
  const hud = { battle, caster, levelName: () => '青葱丘林', skillImg: () => null, skillMeta: (id) => ({ cd: 2 }) };
  v.update(1 / 60, hud, true);
  const ctx = new Proxy({}, {
    get: (t, p) => p === 'measureText' ? () => ({ width: 10 })
      : p === 'createRadialGradient' || p === 'createLinearGradient' ? () => ({ addColorStop() {} })
      : () => {},
    set: () => true,
  });
  v.draw(ctx, hud); // 不抛错
  // 快照只读:连续 update 不改战斗状态
  assert.equal(battle.hp, 120);
  // BOSS 条快照:wave=10 → isBossWave
  v.reset();
  const battle2 = { ...battle, wave: 3, aliveEnemies: () => [] };
  v.update(1 / 60, { ...hud, battle: battle2 }, true);
  v.draw(ctx, hud);
});

test('M13 布局迁移:BOARD_Y=448;底栏 1168;底栏按钮 y=1176;旧血条/联动栏已移除', async () => {
  assert.equal(BOARD_Y, 448, '棋盘上移(联动栏移除)');
  assert.equal(448 + 8 * CELL, 1168, '棋盘底=底栏顶');
  const rSrc = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  assert.ok(rSrc.includes('ctx.fillRect(0, 1168, 720, 56)'), '底栏画在 1168');
  assert.ok(rSrc.includes("pauseBtn: { x: 24, y: 1176, w: 70, h: 40 }"), '⏸ 按钮 y=1176');
  assert.ok(!rSrc.includes('ctx.fillRect(0, 448, 720, 56)'), '联动栏底色已移除');
  assert.ok(!rSrc.includes('HP ${battle.hp}/${battle.maxHp}'), '旧文字血条已移除');
  assert.ok(!rSrc.includes('5 行档位条'), '档位条已移除');
  assert.ok(rSrc.includes('hud.battleHud.draw(ctx, hud)'), 'render 接入 battleHud');
  const mSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mSrc.includes('hud.battleHud.update(dt, hud,'), '主循环推进 battleHud');
  assert.ok(mSrc.includes('parallax.setLevel(battle.level)'), 'startLevel 切换主题');
  assert.ok(!mSrc.includes('SLOT_HITBOX'), '联动栏换装入口已退役');
  const fSrc = fs.readFileSync(new URL('../scripts/ui/fx.js', import.meta.url), 'utf-8');
  assert.ok(!fSrc.includes('const cy = 504 +'), 'fx 飞字 y 不再硬编码 504');
});
