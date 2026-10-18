// tests/m13-battleui.test.mjs — M13 批次:战斗区 HUD 改版(头像+二段血条/关卡名/BOSS 条下移/
// 技能框右下/波次进度条/联动栏移除/棋盘上移 448/分关卡背景)
// 运行: node --test tests/m13-battleui.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import { fullManifest } from '../scripts/assets/manifest.js';
import { HealthView, BattleHudView, bindHudImages, HUD_IMG, themeOf, GHOST_PUNCH, GHOST_RATE, GHOST_MAX } from '../scripts/ui/battle_hud.js';
import { updateEnemyHealthViews, enemyHealthViewOf } from '../scripts/ui/render.js';
import { BOARD_Y, CELL } from '../scripts/board/grid.js';

// ---- M13-1 图素清单 ----
test('M13 manifest:分关卡背景 5 主题×2 + 头像框/技能框,共 12 项且文件存在(生图头像已弃用移出)', () => {
  const m = fullManifest().filter(it => it.entity === 'battle-ui');
  assert.equal(m.length, 12, `battle-ui 条目数=12,实际 ${m.length}`);
  const keys = new Set(m.map(it => it.key));
  for (const t of ['meadow', 'swamp', 'mist', 'snow', 'volcano']) {
    assert.ok(keys.has(`bg:${t}:far`) && keys.has(`bg:${t}:near`), `主题 ${t} 远近景在清单`);
  }
  assert.ok(keys.has('ui:avatar_frame') && keys.has('ui:skill_frame'), '两张边框在清单');
  assert.ok(!keys.has('ui:hero_avatar'), '生图头像已移出清单(需求方反馈发色不符,改立绘裁头)');
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

// M12M13-ACCEPT F2 回归:动效关闭当帧,**存量** PUNCH/DRAIN 残影也直接同步
// (此前只在受击瞬间处理 fxEnabled=false,内存复算复现:受击后关动效 ghost 滞留旧值)
test('M13 HealthView:受击/追平中途关动效,存量残影当帧同步(无动画)', () => {
  // 场景 1:已进入 PUNCH 后关动效 → 当帧 ghost=hp、归 IDLE
  const v = new HealthView();
  v.update(1 / 60, 1);
  v.update(1 / 60, 0.6);            // 受击 → PUNCH,ghost=1
  assert.equal(v.state, 'PUNCH');
  v.update(1 / 60, 0.6, false);     // 动效开关翻 false(存量状态)
  assert.equal(v.ghost, 0.6, 'PUNCH 中关动效:残影当帧追平');
  assert.equal(v.state, 'IDLE', '状态归 IDLE');
  // 场景 2:DRAIN 中途关动效 → 残影不再缓慢追赶,当帧同步
  const v2 = new HealthView();
  v2.update(1 / 60, 1);
  v2.update(1 / 60, 0.5);
  v2.update(GHOST_PUNCH + 1e-3, 0.5); // 进入 DRAIN,ghost 开始追赶
  assert.equal(v2.state, 'DRAIN');
  v2.update(0.1, 0.5, false);
  assert.equal(v2.ghost, 0.5, 'DRAIN 中关动效:残影当帧追平');
  assert.equal(v2.state, 'IDLE');
  // 场景 3:关动效后再受击 → 保持同步语义(主条=残影)
  v2.update(1 / 60, 0.2, false);
  assert.equal(v2.ghost, 0.2, '关动效后续受击仍直接同步');
});

// ---- M13-3 绑定入口与主题映射 ----
test('M13 bindHudImages:绑定数=2;空 Map 复位;themeOf 循环映射', () => {
  const imgs = new Map(fullManifest().filter(it => it.entity === 'battle-ui').map(it => [it.key, { _src: it.url }]));
  assert.equal(bindHudImages(imgs), 2, '头像框/技能框绑定 2(生图头像已弃用)');
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

// M12M13-ACCEPT 03轮 F9 回归:updateEnemyHealthViews 入口契约——纯显示层(不写战斗状态)、
// 首见对齐当前血量(无入场假残影)、返回推进数;dt 由 main 实际传入(帧率等价性由
// HealthView 状态机单测覆盖:恒速 0.30/s 只与累计 dt 相关,与调用次数无关)。
test('M13 敌人双血条入口:纯显示层/首见对齐/存活计数;死亡与空 battle 安全', () => {
  const battle = { enemies: [
    { alive: true, hp: 50, maxHp: 100 },
    { alive: true, hp: 30, maxHp: 60 },
    { alive: false, hp: 0, maxHp: 100 },
  ] };
  assert.equal(updateEnemyHealthViews(1 / 60, battle, true), 2, '只推进存活敌人(2 只)');
  assert.equal(battle.enemies[0].hp, 50, '推进不写战斗状态(纯显示层)');
  assert.equal(battle.enemies[1].hp, 30, '推进不写战斗状态(纯显示层)');
  assert.equal(updateEnemyHealthViews(1 / 60, null, true), 0, '空 battle 安全');
  assert.equal(updateEnemyHealthViews(1 / 60, {}, true), 0, '无 enemies 安全');
  // 治疗上升立即对齐(残影不高于主条)
  battle.enemies[0].hp = 80;
  updateEnemyHealthViews(1 / 60, battle, true);
  assert.equal(battle.enemies[0].hp, 80, '治疗对齐不写战斗状态');
});

// M12M13-ACCEPT 04轮 F10 回归:首见初始化**无假残影**(量视图值=绘制宽度,非仅源码)
// 首见 50/100:主条与残影均应为 40px(80×0.5);随后降至 30/100:主条 24px、残影保留 40px
test('M13 敌人双血条首见对齐:50/100 两条均 40px;再受击主条 24px 残影保留 40px', () => {
  const e = { alive: true, hp: 50, maxHp: 100 };
  updateEnemyHealthViews(1 / 60, { enemies: [e] }, true);
  const hv = enemyHealthViewOf(e);
  assert.ok(hv, '首见后可取视图');
  assert.equal(hv.hp, 0.5, '首见主条=0.5(绘制 40px)');
  assert.equal(hv.ghost, 0.5, '首见残影=0.5(绘制 40px,无满血假残影)');
  assert.equal(hv.state, 'IDLE', '首见无受击状态');
  // 随后真实受击:主条立即扣,残影保留旧值(二段动画正常)
  e.hp = 30;
  updateEnemyHealthViews(1 / 60, { enemies: [e] }, true);
  assert.equal(hv.hp, 0.3, '受击主条=0.3(绘制 24px)');
  assert.equal(hv.ghost, 0.5, '残影保留 0.5(绘制 40px,punch 二段)');
  assert.equal(hv.state, 'PUNCH', '受击进入 punch');
  // 高血量首见(满血)同样对齐
  const e2 = { alive: true, hp: 100, maxHp: 100 };
  updateEnemyHealthViews(1 / 60, { enemies: [e2] }, true);
  const hv2 = enemyHealthViewOf(e2);
  assert.equal(hv2.hp, 1, '满血首见主条=1');
  assert.equal(hv2.ghost, 1, '满血首见残影=1');
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
      : p === 'createRadialGradient' || p === 'createLinearGradient' ? () => ({ width: 10 })
      : () => {},
    set: () => true,
  });
  v.draw(ctx, hud); // 不抛错
  // 快照只读:连续 update 不改战斗状态
  assert.equal(battle.hp, 120);
  // BOSS 条负例(M12M13-ACCEPT F1):非 Boss 波 hud 绘制时也传非 Boss hud——
  // wave=3 无存活敌人 → isBossWave=false,快照 bossMax=0,BOSS 条分支不进入
  v.reset();
  const battle2 = { ...battle, wave: 3, aliveEnemies: () => [] };
  const hud2 = { ...hud, battle: battle2 };
  v.update(1 / 60, hud2, true);
  assert.equal(v._snapshot(hud2).isBossWave, false, '非 Boss 波 isBossWave=false');
  assert.equal(v._snapshot(hud2).bossMax, 0, '非 Boss 波无 boss 快照');
  v.draw(ctx, hud2); // 用**同一份**非 Boss hud 绘制(负例:此前误传 Boss hud)
  // Boss 波正例对照
  assert.equal(v._snapshot(hud).isBossWave, true, 'Boss 波(wave=10) isBossWave=true');
  // F4 回归:Lv 徽标用角色等级(profile.level),与关卡编号不同时不串
  const hud3 = { ...hud, profile: () => ({ level: 9 }) };
  assert.equal(v._snapshot(hud3).profileLv, 9, 'profileLv=角色等级 9');
  assert.equal(v._snapshot({ ...hud3, battle: { ...battle, level: 2 } }).profileLv, 9,
    '第 2 关时 Lv 徽标仍显示角色等级 9(不串成关卡号)');
  // 需求方 2026-10-18:护盾条快照口径(battle.shield/(maxHp×30% 封顶),旧版同源)
  const sh = v._snapshot({ ...hud, battle: { ...battle, shield: 24, maxHp: 175 } });
  assert.equal(sh.shield, 24, '护盾快照:shield 直读 battle.shield');
  assert.equal(sh.shieldCap, Math.round(175 * 0.3), '护盾 cap=maxHp×30%(旧版同源)');
  assert.equal(v._snapshot({ ...hud, battle: { ...battle, shield: 0 } }).shield, 0, '无盾 shield=0(条不画)');
});

test('M13 布局迁移:BOARD_Y=448;底栏 1168~1280 全高;底栏按钮 y=1176;旧血条/联动栏已移除', async () => {
  assert.equal(BOARD_Y, 448, '棋盘上移(联动栏移除)');
  assert.equal(448 + 8 * CELL, 1168, '棋盘底=底栏顶');
  const rSrc = fs.readFileSync(new URL('../scripts/ui/render.js', import.meta.url), 'utf-8');
  // M12M13-ACCEPT F5:底栏 1168~1280 全高铺底(112px),不再只画 56px
  assert.ok(rSrc.includes('ctx.fillRect(0, 1168, 720, 112)'), '底栏画满 1168~1280(112px)');
  assert.ok(!rSrc.includes('ctx.fillRect(0, 1168, 720, 56)'), '半截底栏(56px)已废弃');
  // 需求方 2026-10-19:⏸/⚙ 迁至战斗区主角血条正下方(原底栏位废弃);战斗区 HUD 因顶部
  // 货币栏条带整体下移 44px,按钮随之落到 y=134
  assert.ok(rSrc.includes('pauseBtn: { x: 96, y: 134, w: 56, h: 44 }'), '⏸ 按钮移至血条下方 y=134');
  assert.ok(rSrc.includes('settingsBtn: { x: 158, y: 134, w: 56, h: 44 }'), '⚙ 按钮移至血条下方 y=134');
  // 需求方 2026-10-19:底栏「第几关/击杀/货币」行移除;货币移至战斗区上方货币栏条带
  assert.ok(!rSrc.includes('· 击杀 ${battle ? battle.kills : 0} · 消除'), '底栏击杀/消除统计行已移除');
  assert.ok(!rSrc.includes('prof0.coins'), '底栏货币显示已移除');
  assert.ok(rSrc.includes('战斗区货币栏条带'), '战斗区上方货币栏条带已实装');
  assert.ok(!rSrc.includes('ctx.fillRect(0, 448, 720, 56)'), '联动栏底色已移除');
  assert.ok(!rSrc.includes('HP ${battle.hp}/${battle.maxHp}'), '旧文字血条已移除');
  assert.ok(!rSrc.includes('5 行档位条'), '档位条已移除');
  assert.ok(rSrc.includes('hud.battleHud.draw(ctx, hud)'), 'render 接入 battleHud');
  // 需求方 2026-10-18 反馈整改(源码口径)
  assert.ok(rSrc.includes('const _enemyHv = new WeakMap()'), '敌人双血条:HealthView WeakMap 挂载');
  // M12M13-ACCEPT 03轮 F9:推进与绘制分离(render 内禁止固定 1/60 计时)
  assert.ok(!rSrc.includes('hv.update(1 / 60,'), 'render 内不再固定 1/60 推进(帧率/暂停回归已修)');
  assert.ok(rSrc.includes('export function updateEnemyHealthViews'), '导出 updateEnemyHealthViews(main 按实际 dt 驱动)');
  assert.ok(rSrc.includes('hv.draw(ctx, bx, by, bw, 6)'), '敌人血条走 HealthView.draw(二段绘制)');
  const mSrc2 = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mSrc2.includes('updateEnemyHealthViews(dt, battle,'), 'main 主循环按实际 dt 推进敌人血条(与 battleHud.update 同刻,paused 提前 return 不达)');
  const bhSrc = fs.readFileSync(new URL('../scripts/ui/battle_hud.js', import.meta.url), 'utf-8');
  assert.ok(bhSrc.includes('_rr(ctx, 16, 414, 688, 28, 12)'), '波次条奶油药丸底(样板一致,文字可读)');
  assert.ok(bhSrc.includes("fillText('BOSS', 679, 432)"), 'Boss 标记 BOSS 字样(样板一致,明显标识)');
  assert.ok(bhSrc.includes('ctx.drawImage(hero, 160, 40, 320, 320, 16, 16 + TOPBAR_H, 72, 72)'), '头像=立绘裁头部(发色一致;随货币栏条带下移)');
  assert.ok(bhSrc.includes("#8fd3e8"), '护盾条蓝 #8fd3e8(需求方反馈:血条下蓝条补回)');
  const mSrc = fs.readFileSync(new URL('../scripts/main.js', import.meta.url), 'utf-8');
  assert.ok(mSrc.includes('hud.battleHud.update(dt, hud,'), '主循环推进 battleHud');
  assert.ok(mSrc.includes('parallax.setLevel(battle.level)'), 'startLevel 切换主题');
  assert.ok(!mSrc.includes('SLOT_HITBOX'), '联动栏换装入口已退役');
  const fSrc = fs.readFileSync(new URL('../scripts/ui/fx.js', import.meta.url), 'utf-8');
  assert.ok(!fSrc.includes('const cy = 504 +'), 'fx 飞字 y 不再硬编码 504');
});
