import test from 'node:test';
import assert from 'node:assert/strict';

import { SKILL_FX_ART } from '../scripts/assets/skill_fx_art.js';
import { Battle } from '../scripts/battle/battle.js';
import { dispatch } from '../scripts/skills/behaviors.js';
import { skillById } from '../scripts/skills/library.js';
import { ImpactEffects } from '../scripts/ui/combat_fx.js';
import { drawCastRelease, drawShieldContact, drawSkillAura, drawSkillBolt, drawSkillImpact, drawSkillRoots, drawSkillZone, enemyEffectFoot } from '../scripts/ui/skill_effects.js';

function recorder() {
  const layers = [], arcs = [], sprites = [], fills = [];
  const ctx = {
    globalAlpha: 1,
    save() { layers.push({ alpha: this.globalAlpha, position: this.position, fill: this.fillStyle }); },
    restore() {
      const { alpha, position, fill } = layers.pop();
      this.globalAlpha = alpha;
      this.position = position;
      this.fillStyle = fill;
    },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {}, rotate() {},
    translate(x, y) { this.position = [x,y]; },
    ellipse(...geometry) { arcs.push(geometry); },
    fill() { fills.push(this.fillStyle); },
    drawImage(_image, ...args) {
      sprites.push({ frame: args.slice(0,4), position: this.position, alpha: this.globalAlpha });
    },
  };
  return { ctx, arcs, sprites, fills };
}

const page = () => ({ complete: true, naturalWidth: 2048 });
const caster = (target) => ({ clock: 41, atk: 10, maxHp: 100, nearestAlive: () => target, floatEvent() {} });

test('关闭动效后仍使用六种生图弹头，保留弹头大小并跳过拖尾', () => {
  const image = { complete: true, naturalWidth: 480, naturalHeight: 256 };
  for (const [i, el] of ['fire','water','wood','metal','earth','metal'].entries()) {
    const bolt = { el, x: 350, y: 238, vx: 600, vy: 0, t: 0.30, skillId: i === 5 ? 'metal_multi' : `${el}_bolt` };
    const frame = recorder();
    drawSkillBolt(frame.ctx,image,bolt,false);
    assert.deepEqual(frame.sprites,[{ frame:[i%3*160,Math.floor(i/3)*128,160,128], position:[350,238], alpha:1 }]);
    assert.equal(frame.fills.length,0);
  }
});

test('五行弹头和三发连珠从各自的固定高度水平飞行，拖尾沿速度反向延伸', () => {
  const image = page();
  for (const [el, lanes] of [['fire', [0]], ['water', [0]], ['wood', [0]], ['metal', [0]], ['earth', [0]], ['metal', [0, -64, 64]]]) {
    for (const [visualLane, offset] of lanes.entries()) {
      for (const t of [0, 0.04, 0.24, 0.67]) {
        const frame = recorder();
        const gradients = [];
        frame.ctx.createLinearGradient = (...points) => { gradients.push(points); return { addColorStop() {} }; };
        const bolt = { el, skillId: lanes.length === 3 ? 'metal_multi' : `${el}_bolt`,
          x: 110 + 600 * t, y: 238, vx: 600, vy: 0, t, visualLane };
        drawSkillBolt(frame.ctx, image, bolt);
        const y = bolt.y + offset;
        assert.deepEqual(frame.sprites[0].position, [bolt.x, y]);
        if (t === 0) assert.equal(gradients.length, 0);
        else {
          const [startX, startY, endX, endY] = gradients[0];
          assert.deepEqual([startX, startY, endY], [bolt.x, y, y]);
          assert.ok(endX < startX && endX >= 110 - 1e-9);
        }
      }
    }
  }
});

test('燎原弹从落点高度平飞，符尖的发光仍在出手位置', () => {
  const cast = { at: 0, skillId: 'fire_dotzone', element: 'fire', tier: 3, action: { origin: { x: 201, y: 280 } },
    target: { x: 540, y: 244, name: 'fox' } };
  for (const t of [0, 0.04, 0.08, 0.12, 0.159]) {
    const frame = recorder();
    const lines = [];
    frame.ctx.createLinearGradient = () => ({ addColorStop() {} });
    frame.ctx.lineTo = (...point) => lines.push(point);
    drawCastRelease(frame.ctx, page(), cast, t);
    const [x, y] = frame.sprites[0].position;
    assert.ok(Math.abs(x - (201 + 339 * t / 0.16)) < 1e-9);
    assert.equal(y, 302);
    assert.equal(lines[0][1], 302);
    assert.equal(frame.arcs.length, 1);
  }
});

test('范围冲击在首帧可见，冰链在技能名出现时仍有清晰轮廓', () => {
  const fx = new ImpactEffects();
  const { ctx } = recorder();
  const marks = [];
  ctx.stroke = () => marks.push({ color: ctx.strokeStyle, alpha: ctx.globalAlpha });
  for (const [id, color] of [['fire_pulse','#d54921'], ['metal_pulse','#d99e3e'], ['earth_pulse','#b16c35']]) {
    const skill = skillById(id);
    fx.note({ kind: 'dmg', n: 10, el: skill.el, skillId: id, x: 540, y: 240, targetName: 'fox',
      radius: skill.params.r, impact: { primary: true, tier: 1 } });
    drawSkillImpact(ctx, page, fx.active.at(-1));
    assert.ok(marks.some(mark => mark.color === color && mark.alpha >= .64));
  }
  fx.clear();
  fx.note({ kind: 'dmg', n: 10, el: 'water', skillId: 'water_chain', x: 540, y: 240,
    impact: { primary: true }, linkFrom: { x: 198, y: 242 } });
  fx.update(.36);
  drawSkillImpact(ctx, page, fx.active[0]);
  assert.ok(marks.some(mark => mark.color === '#2782b1' && mark.alpha > .7));
  fx.update(.17);
  assert.equal(fx.active.length, 0);
});

test('火区与霜区按本次释放重启，投影固定在原落点并提示实际剩余时间', () => {
  assert.equal(enemyEffectFoot('slime',240),272);
  assert.equal(enemyEffectFoot('fox',240),298);
  const enemy = { x: 570, y: 226, name: 'fox' };
  const battle = caster(enemy);
  for (const [id, key] of [['fire_dotzone','fireZone'], ['water_field','frostField']]) {
    const skill = skillById(id);
    const start = battle.clock;
    const zone = dispatch(battle, skill, 1);
    const first = recorder();
    drawSkillZone(first.ctx,page,zone,start,true);
    assert.deepEqual(first.sprites[0].frame, SKILL_FX_ART[key].frames[0]);
    assert.deepEqual(first.sprites[0].position,[zone.x,enemyEffectFoot('fox',zone.y)]);
    assert.equal(first.arcs[0][2],skill.params.r);
    assert.equal(first.arcs[1].at(-1),Math.PI*1.5);
    enemy.x += 25;
    battle.clock += 0.62;
    const moved = recorder();
    drawSkillZone(moved.ctx,page,zone,battle.clock,true);
    assert.deepEqual(moved.sprites[0].position,first.sprites[0].position);
    assert.notDeepEqual(moved.sprites[0].frame,first.sprites[0].frame);
    assert.ok(moved.arcs[1].at(-1) < first.arcs[1].at(-1));
    const refreshed = dispatch(battle,skill,1);
    assert.equal(battle.zones.filter(z=>z.skillId===id).length,1);
    const refreshedFx = recorder();
    drawSkillZone(refreshedFx.ctx,page,refreshed,battle.clock,true);
    assert.deepEqual(refreshedFx.sprites[0].frame,first.sprites[0].frame);
    assert.equal(refreshedFx.sprites[0].position[0],enemy.x);
    const fading = recorder();
    drawSkillZone(fading.ctx,page,refreshed,refreshed.until-0.04,true);
    assert.ok(fading.sprites[0].alpha < first.sprites[0].alpha);
    const still = recorder();
    drawSkillZone(still.ctx,page,refreshed,battle.clock,false);
    assert.equal(still.arcs.length,1);
    assert.equal(still.sprites.length,0);
  }
});

test('藤蔓在束缚将结束时仍保留合拢形态，光环从施法帧开始并淡出', () => {
  const target = { x: 540, y: 232, name: 'tiger' };
  const battle = caster(target);
  dispatch(battle,skillById('wood_bind'),1);
  const root = recorder();
  drawSkillRoots(root.ctx,page,target,target.bindUntil-0.04);
  const frames = SKILL_FX_ART.rootSnare.frames;
  const heldIndex = frames.findIndex(f=>String(f)===String(root.sprites[0].frame));
  assert.ok(heldIndex>=6 && heldIndex<=13);
  assert.ok(root.sprites[0].alpha>0 && root.sprites[0].alpha<0.3);
  const expired = recorder();
  drawSkillRoots(expired.ctx,page,target,target.bindUntil);
  assert.equal(expired.sprites.length,0);
  const aura = dispatch(battle,skillById('wood_aura'),1);
  const created = recorder();
  drawSkillAura(created.ctx,page,110,395,aura,battle.clock,true);
  assert.deepEqual(created.sprites[0].frame,SKILL_FX_ART.lifeAura.frames[0]);
  const ending = recorder();
  drawSkillAura(ending.ctx,page,110,395,aura,aura.until-0.04,true);
  assert.ok(ending.sprites[0].alpha < created.sprites[0].alpha);
});

test('护盾吸收与碎盾使用实际剩余量，免疫不触发护盾反馈', () => {
  const battle = new Battle({ level: 1, atk: 10, maxHp: 100 });
  const impacts = new ImpactEffects();
  dispatch(battle,skillById('earth_shield'),1);
  battle.drainFloatTexts().forEach(e=>impacts.note(e));
  assert.deepEqual(impacts.shieldRaised,{t:0});
  assert.equal(battle.shield,20);
  battle.hurtPlayer(7,Math.PI);
  battle.drainFloatTexts().forEach(e=>impacts.note(e));
  assert.equal(battle.shield,13);
  assert.equal(battle.hp,100);
  assert.deepEqual(impacts.shieldContact,{t:0,broken:false,angle:Math.PI});
  const block = recorder();
  drawShieldContact(block.ctx,110,306,impacts.shieldContact);
  assert.equal(block.fills.length,4);
  battle.hurtPlayer(13,Math.PI);
  battle.drainFloatTexts().forEach(e=>impacts.note(e));
  assert.equal(battle.shield,0);
  assert.equal(battle.hp,100);
  assert.equal(impacts.shieldRaised,null);
  assert.equal(impacts.shieldContact.broken,true);
  const broke = recorder();
  drawShieldContact(broke.ctx,110,306,impacts.shieldContact);
  assert.equal(broke.fills.length,9);
  impacts.update(0.4);
  battle.invincibleT = 2;
  battle.hurtPlayer(12);
  battle.drainFloatTexts().forEach(e=>impacts.note(e));
  assert.equal(impacts.shieldContact,null);
});
