// scripts/ui/audio.js
// Web Audio 合成音效：交换、消除、连锁、五行命中和界面反馈。
// M11:enabled 开关(设置面板「音效」切换;关时 tone 静默)
// M14 需求方 2026-10-18:局内战斗 BGM(godot-roguelike zhuayao.mp3 复用;循环播放,
// 仅 playing 屏出声;设置面板「音乐」开关默认开,入档 settings.bgm)
// 相对路径: scripts/ui/audio.js

let actx = null;
let mix = null;
let noiseBuffer = null;
let resumePending = false;
let lastImpact = -Infinity;
const voices = new Set();
const state = { enabled: true };
const MIX_LEVEL = 0.86;
const CHAIN_NOTES = [440, 493.88, 587.33, 659.25, 783.99, 880];
const MATCH_OVERTONE = { metal: 2.4, wood: 1.51, water: 2.0, fire: 1.78, earth: 1.26 };
const HIT_SOUNDS = {
  metal: {
    tones: [
      { freq: 1380, slide: -120, dur: 0.082, type: 'triangle', vol: 0.12 },
      { freq: 2360, slide: -90, dur: 0.115, vol: 0.050 },
    ],
  },
  wood: {
    tones: [{ freq: 360, slide: -165, dur: 0.095, vol: 0.14 }],
    noise: { freq: 1120, dur: 0.052, vol: 0.095, q: 1.2 },
  },
  water: {
    tones: [
      { freq: 760, slide: -405, dur: 0.112, vol: 0.135 },
      { freq: 1120, slide: -330, dur: 0.072, vol: 0.057, delay: 0.025 },
    ],
  },
  fire: {
    tones: [{ freq: 275, slide: -155, dur: 0.076, type: 'triangle', vol: 0.12 }],
    noise: { freq: 2180, dur: 0.104, vol: 0.24, q: 0.72 },
  },
  earth: {
    tones: [
      { freq: 153, slide: -84, dur: 0.132, vol: 0.14 },
      { freq: 308, slide: -155, dur: 0.087, type: 'triangle', vol: 0.061 },
    ],
    noise: { freq: 650, dur: 0.098, vol: 0.18, q: 0.7 },
  },
};

// ---- BGM(懒加载单例:首次 play 才 new Audio,不违反 M11-03 F1 顶层零加载口径——该口径约束图片渲染) ----
const bgmState = { enabled: true, audio: null, needsGesture: false };

function ensureBgmAudio() {
  if (typeof Audio === 'undefined') return null; // 无 DOM 环境(单测):静默早退(与 fx.js document 守卫同口径)
  if (!bgmState.audio) {
    const a = new Audio('assets/sounds/bgm/zhuayao.mp3');
    a.loop = true;
    a.volume = 0.35;
    bgmState.audio = a;
  }
  return bgmState.audio;
}

// 局内战斗播控(main 在 screen 变化/启动恢复时调用):inBattle=true 播放,否则暂停
function syncBgm(inBattle, gesture = false) {
  if (!bgmState.enabled || !inBattle) {
    const a = bgmState.audio;
    if (a && !a.paused) a.pause();
    return;
  }
  const a = ensureBgmAudio();
  if (a?.paused && (!bgmState.needsGesture || gesture)) {
    a.play().then(() => { bgmState.needsGesture = false; }).catch(error => {
      if (error.name === 'NotAllowedError') bgmState.needsGesture = true;
    });
  }
}

function ensureCtx() {
  if (!actx) {
    if (typeof window === 'undefined') return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
  }
  return actx;
}

function output(ac) {
  if (!mix) {
    mix = ac.createGain();
    mix.gain.setValueAtTime(MIX_LEVEL, ac.currentTime);
    const compressor = ac.createDynamicsCompressor?.();
    if (compressor) {
      compressor.threshold.value = -15;
      compressor.knee.value = 12;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.11;
      mix.connect(compressor).connect(ac.destination);
    } else {
      mix.connect(ac.destination);
    }
  }
  return mix;
}

function playVoice(ac, source, node, t, { vol, dur, attack }) {
  const envelope = ac.createGain();
  envelope.gain.setValueAtTime(0.0001, t);
  envelope.gain.exponentialRampToValueAtTime(vol, t + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  node.connect(envelope).connect(output(ac));
  source.onended = () => {
    voices.delete(source);
    source.disconnect?.();
    if (node !== source) node.disconnect?.();
    envelope.disconnect?.();
  };
  voices.add(source);
  source.start(t);
  source.stop(t + dur + 0.02);
}

function tone({ freq = 440, slide = 0, dur = 0.1, type = 'sine', vol = 0.15, delay = 0, attack = 0.004 }) {
  if (!state.enabled) return;
  const ac = ensureCtx();
  if (!ac || ac.state !== 'running') return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  playVoice(ac, osc, osc, t0, { vol, dur, attack });
}

function filteredNoise(ac, { freq, dur, vol, q }) {
  if (!noiseBuffer) {
    noiseBuffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.25), ac.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    let seed = 0x1b9fa012;
    for (let i = 0; i < samples.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      samples[i] = (seed >>> 0) / 0x80000000 - 1;
    }
  }
  const source = ac.createBufferSource();
  source.buffer = noiseBuffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  source.connect(filter);
  playVoice(ac, source, filter, ac.currentTime, { vol, dur, attack: 0.003 });
}

function hitSound(events) {
  if (!state.enabled) return;
  let selected = null;
  let strongest = -1;
  for (const event of events) {
    const impact = event.impact;
    if (!impact || !(event.n > 0) || !HIT_SOUNDS[event.el]) continue;
    const score = Number(!!event.crit) * 8 + Number(!!impact.boss) * 3 +
      Number(!!impact.primary) * 2 + Number(impact.tier >= 4);
    if (score > strongest) {
      selected = event;
      strongest = score;
    }
  }
  if (!selected) return;
  const ac = ensureCtx();
  if (!ac || ac.state !== 'running') return;
  const interval = selected.crit ? 0.09 : 0.15;
  if (ac.currentTime - lastImpact < interval) return;
  lastImpact = ac.currentTime;
  const { tones, noise } = HIT_SOUNDS[selected.el];
  const strength = selected.crit ? 1.25 : selected.impact.primary ? 1 : 0.68;
  for (const voice of tones) tone({ ...voice, vol: voice.vol * strength });
  if (noise) filteredNoise(ac, { ...noise, vol: noise.vol * strength });
  if (selected.crit) tone({ freq: 622, slide: -35, dur: 0.14, type: 'triangle', vol: 0.074, delay: 0.012 });
}

export const sfx = {
  get enabled() { return state.enabled; },
  set enabled(v) {
    const enabled = !!v;
    if (enabled === state.enabled) return;
    state.enabled = enabled;
    if (mix) mix.gain.setValueAtTime(enabled ? MIX_LEVEL : 0, actx.currentTime);
    if (!enabled) {
      for (const voice of voices) voice.stop(actx.currentTime);
      voices.clear();
    }
  },
  // M14 手机端修复:AudioContext 必须在**真实手势事件处理器内同步**创建/resume——
  // 音效调用多经 rAF/延迟路径(iOS 判定非手势上下文→suspended 静音;BGM 走 Audio 元素在手势里
  // play 成功,故「BGM 好音效没声」)。main 在指针和触屏手势中解锁或恢复。
  unlock() {
    if (!state.enabled || resumePending) return;
    const ac = ensureCtx();
    if (ac?.state === 'suspended' || ac?.state === 'interrupted') {
      resumePending = true;
      ac.resume().catch(() => {}).finally(() => { resumePending = false; });
    }
  },
  swap() { tone({ freq: 320, slide: -75, dur: 0.055, type: 'triangle', vol: 0.096 }); },
  invalid() { tone({ freq: 194, slide: -70, dur: 0.09, type: 'triangle', vol: 0.104 }); },
  match(chain = 1, el, count = 3) {
    const index = Math.max(0, Math.min(CHAIN_NOTES.length - 1, chain - 1));
    const base = CHAIN_NOTES[index];
    const accent = Math.min(1.22, 1 + (count - 3) * 0.045);
    tone({ freq: base, slide: -12, dur: 0.135, type: 'triangle', vol: 0.14 * accent });
    tone({ freq: base * (MATCH_OVERTONE[el] || 2), dur: 0.084, vol: 0.062 * accent, delay: 0.018 });
    tone({ freq: base * 1.5, dur: 0.15, vol: 0.092 * accent, delay: 0.052 });
    if (chain >= 2) tone({ freq: base * 2, dur: 0.16, vol: 0.077, delay: 0.102 });
    if (chain >= 4) tone({ freq: base * 3, dur: 0.18, vol: 0.052, delay: 0.142 });
  },
  impact: hitSound,
  item() {
    tone({ freq: 660, dur: 0.08, type: 'sine', vol: 0.14 });
    tone({ freq: 990, dur: 0.12, type: 'sine', vol: 0.12, delay: 0.07 });
  },
  bossArrival() {
    tone({ freq: 164, slide: -79, dur: 0.30, type: 'triangle', vol: 0.16 });
    tone({ freq: 123, slide: -55, dur: 0.32, type: 'triangle', vol: 0.14, delay: 0.17 });
    tone({ freq: 494, slide: -69, dur: 0.30, type: 'sine', vol: 0.08, delay: 0.18 });
  },
  // ===== M15 界面 v2 音效(养成/结算;口径=06/05 样板) =====
  deduct() { tone({ freq: 220, dur: 0.08, type: 'square', vol: 0.05 }); }, // 货币扣除「嗒」
  // -06 掉落到达「叮铃」(金币落袋;双高音短促衰减,与 item 同族但更高频)
  coin() {
    tone({ freq: 1568, dur: 0.09, type: 'sine', vol: 0.12 });
    tone({ freq: 2093, dur: 0.14, type: 'sine', vol: 0.1, delay: 0.05 });
  },
  skillUp() {
    tone({ freq: 880, dur: 0.15, type: 'triangle', vol: 0.1 });
    tone({ freq: 1174, dur: 0.2, type: 'triangle', vol: 0.1, delay: 0.08 });
  },
  levelUp() { // 上行琶音+shimmer(角色升级)
    [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: 0.25, type: 'triangle', vol: 0.1, delay: i * 0.09 }));
    tone({ freq: 2093, dur: 0.5, type: 'sine', vol: 0.05, delay: 0.4 });
  },
  gachaOpen() {
    tone({ freq: 660, dur: 0.1, type: 'triangle', vol: 0.1 });
    tone({ freq: 880, dur: 0.12, type: 'triangle', vol: 0.1, delay: 0.1 });
    tone({ freq: 1318, dur: 0.4, type: 'triangle', vol: 0.12, delay: 0.25 });
  },
  resultWin() { // 结算胜利:上行号角琶音 C5-E5-G5-C6+低音 thump(0.35s 起对齐横幅落地)
    [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: i === 3 ? 0.5 : 0.22, type: 'triangle', vol: 0.12, delay: 0.35 + i * 0.17 }));
    tone({ freq: 131, dur: 0.3, type: 'sine', vol: 0.2, delay: 0.35 });
  },
  resultLose() { // 结算失败:下行两音 A3→G3 低沉短促(UIV2-01 F7 整改:末音 0.55s 起 0.2s,
    // osc 收尾 0.77s<0.8s,快速给「再战」路径)
    tone({ freq: 220, dur: 0.3, type: 'sawtooth', vol: 0.07, delay: 0.35 });
    tone({ freq: 196, dur: 0.2, type: 'sawtooth', vol: 0.07, delay: 0.55 });
  },
};

// BGM 调试视图(只读;CDP 验证播放状态——Audio 元素不入 DOM,querySelector 不可见;
// 需求方 2026-10-18 口径:Audio 元素在手势里 play,此处转发内部态)
export function bgmDebug() {
  return {
    enabled: bgmState.enabled,
    has: !!bgmState.audio,
    paused: bgmState.audio ? bgmState.audio.paused : null,
    ready: bgmState.audio ? bgmState.audio.readyState : null,
    err: bgmState.audio && bgmState.audio.error ? bgmState.audio.error.code : 'none',
  };
}

// M14:BGM 控制面(设置面板「音乐」开关默认开;局内战斗播控)
export const bgm = {
  get enabled() { return bgmState.enabled; },
  set enabled(v) {
    bgmState.enabled = !!v;
    if (!bgmState.enabled) syncBgm(false); // 关=立即静音
  },
  sync: syncBgm,
};
