// tests/audio.test.mjs
// Web Audio 调度契约。音色与浏览器播放另用真实 Web Audio 验证。

import test from 'node:test';
import assert from 'node:assert/strict';

function instrumentAudio() {
  const scheduled = { frequencies: [], stops: [], levels: [] };
  let now = 0;
  const param = list => ({
    setValueAtTime(value, time) { list.push({ value, time }); },
    exponentialRampToValueAtTime() {},
  });
  const node = { connect(target) { return target; } };
  const originalWindow = globalThis.window;
  globalThis.window = {
    AudioContext: class {
      state = 'running';
      destination = {};
      get currentTime() { return now; }
      createGain() { return { ...node, gain: param(scheduled.levels) }; }
      createOscillator() {
        return { ...node, frequency: param(scheduled.frequencies), start() {}, stop(time) { scheduled.stops.push(time); } };
      }
    },
  };
  return {
    scheduled,
    setTime(time) { now = time; },
    restore() {
      if (originalWindow === undefined) delete globalThis.window;
      else globalThis.window = originalWindow;
    },
  };
}

test('实际伤害驱动命中声，同帧首领暴击优先，短间隔普通命中合并', async () => {
  const audio = instrumentAudio();
  try {
    const { sfx } = await import('../scripts/ui/audio.js?impact-test');
    const { frequencies, stops, levels } = audio.scheduled;
    const normal = { el: 'metal', n: 12, impact: { tier: 1, primary: true } };
    const critical = { ...normal, crit: true, impact: { tier: 5, primary: true, boss: true } };
    sfx.impact([{ ...normal, n: 0 }, { el: 'metal', n: 5 }]);
    assert.deepEqual(frequencies, []);
    audio.setTime(1);
    sfx.impact([normal, critical]);
    assert.deepEqual(frequencies.map(note => note.value), [1380, 2360, 622]);
    audio.setTime(1.07);
    sfx.impact([critical]);
    audio.setTime(1.1);
    sfx.impact([normal]);
    assert.equal(frequencies.length, 3);
    sfx.impact([critical]);
    assert.equal(frequencies.length, 6);
    audio.setTime(1.12);
    sfx.enabled = false;
    assert.deepEqual(levels.at(-1), { value: 0, time: 1.12 });
    assert.equal(stops.filter(time => time === 1.12).length, 6);
    sfx.impact([critical]);
    assert.equal(frequencies.length, 6);
  } finally {
    audio.restore();
  }
});

test('连锁提高基音并增加延后的和音', async () => {
  const audio = instrumentAudio();
  try {
    const { sfx } = await import('../scripts/ui/audio.js?chain-test');
    sfx.match(1, 'wood');
    const single = audio.scheduled.frequencies.slice();
    audio.setTime(1);
    sfx.match(4, 'water', 5);
    const chain = audio.scheduled.frequencies.slice(single.length);
    assert.equal(single.length, 3);
    assert.equal(chain.length, 5);
    assert.ok(chain[0].value > single[0].value);
    assert.ok(chain.at(-1).time > chain[0].time + 0.1);
  } finally {
    audio.restore();
  }
});

test('治疗、无敌、冷却加速分别播放不同音效，静音时跳过', async () => {
  const audio = instrumentAudio();
  try {
    const { sfx } = await import('../scripts/ui/audio.js?item-test');
    sfx.consume('heal');
    audio.setTime(1);
    sfx.consume('invincible');
    audio.setTime(2);
    sfx.consume('cd');
    const notes = audio.scheduled.frequencies;
    assert.deepEqual(notes.map(note => note.value), [523, 784, 196, 1175, 880, 1320, 1760]);
    assert.ok(notes.at(-1).time > 2.08);
    sfx.enabled = false;
    sfx.consume('cd');
    assert.equal(notes.length, 7);
  } finally {
    audio.restore();
  }
});
