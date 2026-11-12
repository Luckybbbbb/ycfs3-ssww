import test from 'node:test';
import assert from 'node:assert/strict';
import { SKILL_LIBRARY, skillById } from '../scripts/skills/library.js';
import { beginHeroCast, heroMotionFrame, heroMotionMix, heroWindup, HERO_CAST_TIME } from '../scripts/ui/hero_motion.js';

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

test('同帧释放优先显示消除技能姿势，受击动作可以在命中后接续', () => {
  const cast = beginHeroCast([used('fire_bolt'), used('metal_multi',3,'elim')], { clock: 1 });
  assert.equal(cast.element, 'metal');
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
  assert.equal(heroWindup(pending,1.95,2.30),null);
  assert.equal(heroWindup(pending,2.25,2.30)?.frame,20);
});
