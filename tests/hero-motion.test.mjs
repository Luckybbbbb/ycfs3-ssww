import test from 'node:test';
import assert from 'node:assert/strict';
import { BOLT_SPEED, PLAYER_X } from '../scripts/skills/registry.js';
import { SKILL_LIBRARY, skillById } from '../scripts/skills/library.js';
import { beginHeroCast, heroBoltView, heroMotionFrame, heroMotionMix, heroWindup, HERO_CAST_TIME } from '../scripts/ui/hero_motion.js';

const used = (id, tier=1, from='main') => {
  const skill = skillById(id);
  return { skill, kind: skill.kind, tier, from };
};

test('十五个技能都从实际释放帧开始，动作组可区分', () => {
  const poses = new Map();
  for (const skill of SKILL_LIBRARY) {
    const cast = beginHeroCast([used(skill.id)], { clock: 2, bolts: [] });
    const release = heroMotionFrame(2, HERO_CAST_TIME, null, cast);
    const recover = heroMotionFrame(2.14, 0.14, null, cast);
    assert.notEqual(release, recover, skill.id);
    assert.notEqual(heroMotionFrame(2.2, 0.08, null, cast), release, skill.id);
    assert.ok(heroMotionFrame(2.31, 0, null, cast) < 4, skill.id);
    const entry = heroMotionMix(2,cast,release);
    const steady = heroMotionMix(2.06,cast,release);
    const endClock = 2.25;
    const exit = heroMotionMix(endClock,cast,heroMotionFrame(endClock,0.03,null,cast));
    assert.ok(entry.under < 4 && entry.frame === release && entry.alpha > 0 && entry.alpha < 1);
    assert.equal(steady.alpha,1);
    assert.ok(exit.under >= 4 && exit.frame < 4 && exit.alpha > 0 && exit.alpha < 1);
    poses.set(skill.id, release);
  }
  assert.equal(poses.size, 15);
  assert.equal(new Set(poses.values()).size, 4);
  assert.deepEqual(['metal_bolt','fire_bolt','earth_pulse','earth_shield'].map(id => poses.get(id)), [6,13,17,21]);
});

test('同帧释放共用可见姿势的出手点，投射物平滑汇入原碰撞路径', () => {
  const a = { x: PLAYER_X, y: 220, t: 0, vx: BOLT_SPEED, vy: 0 };
  const b = { x: PLAYER_X, y: 290, t: 0, vx: BOLT_SPEED, vy: 0 };
  const before = structuredClone([a,b]);
  const cast = beginHeroCast([used('fire_bolt'), used('metal_multi',3,'elim')], { clock: 1, bolts: [a,b] });
  assert.equal(cast.element, 'metal');
  for (const bolt of [a,b]) {
    let lastX = -Infinity;
    for (let i=0; i<=24; i++) {
      bolt.t = i / 100;
      bolt.x = PLAYER_X + BOLT_SPEED * bolt.t;
      const view = heroBoltView(bolt);
      if (i===0) assert.deepEqual([view.x,view.y],[cast.action.origin.x,cast.action.origin.y]);
      assert.ok(view.x > lastX && view.vx > 0);
      lastX = view.x;
      if (i===24) assert.equal(view,bolt);
    }
    bolt.t=0; bolt.x=PLAYER_X;
  }
  assert.deepEqual([a,b],before);
  assert.equal(heroMotionFrame(1, HERO_CAST_TIME, 0.01, cast), 6, '同帧出手显示释放动作');
  assert.ok(heroMotionFrame(1.1, 0.18, 0.01, cast) >= 8 && heroMotionFrame(1.1, 0.18, 0.01, cast) < 12);
});

test('已预约释放可播短抬手帧，等待时点不参与实际结算', () => {
  const pending = [{ skillId: 'earth_shield', execFloor: 2, selT: 1.5 }];
  assert.equal(heroWindup(pending, 1.80),null);
  const windup = heroWindup(pending,1.95);
  assert.equal(heroMotionFrame(1.95,0,null,null,windup),20);
  assert.ok(heroMotionMix(1.95,null,20,windup).alpha > 0);
  assert.ok(heroWindup(pending,1.98).alpha > windup.alpha);
  assert.equal(heroWindup(pending,2),null);
});

test('飞行拖尾采样过去的出手曲线，连珠错开后汇到原弹道', () => {
  const bolt = { x: PLAYER_X, y: 246, t: 0, vx: BOLT_SPEED, vy: 0, visualLane: 2, target: { x: 560 } };
  const cast = beginHeroCast([used('metal_multi')], { clock: 2, bolts: [bolt] });
  bolt.t = 0.24;
  bolt.x = PLAYER_X + BOLT_SPEED * bolt.t;
  const head = heroBoltView(bolt);
  const tail = heroBoltView(bolt, 0);
  assert.deepEqual([tail.x,tail.y], [cast.action.origin.x,cast.action.origin.y]);
  assert.ok(head.x < bolt.x && head.y > bolt.y);
  bolt.t = 0.70;
  bolt.x = PLAYER_X + BOLT_SPEED * bolt.t;
  assert.deepEqual([heroBoltView(bolt).x,heroBoltView(bolt).y],[bolt.x,bolt.y]);
});
