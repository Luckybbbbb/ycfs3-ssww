// scripts/ui/audio.js
// Web Audio 合成音效(零素材):swap/match/invalid/item,首次交互后自动 resume
// M11:enabled 开关(设置面板「音效」切换;关时 tone 静默)
// 相对路径: scripts/ui/audio.js

let actx = null;
const state = { enabled: true };

function ensureCtx() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    actx = new AC();
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

// 单音:freq→slide 频率滑动,dur 秒,type 波形,vol 音量
function tone({ freq = 440, slide = 0, dur = 0.1, type = 'sine', vol = 0.15, delay = 0 }) {
  if (!state.enabled) return; // M11 音效开关
  const ac = ensureCtx();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  get enabled() { return state.enabled; },
  set enabled(v) { state.enabled = !!v; }, // M11 设置面板切换
  swap() { tone({ freq: 320, slide: 160, dur: 0.07, type: 'triangle', vol: 0.12 }); },
  invalid() { tone({ freq: 140, slide: -60, dur: 0.12, type: 'square', vol: 0.08 }); },
  // 消除:chain 越深音调越高(每级 +60Hz 基频)
  match(chain = 1) {
    const base = 420 + Math.min(chain - 1, 6) * 60;
    tone({ freq: base, dur: 0.09, type: 'sine', vol: 0.14 });
    tone({ freq: base * 1.25, dur: 0.09, type: 'sine', vol: 0.12, delay: 0.06 });
    tone({ freq: base * 1.5, dur: 0.12, type: 'sine', vol: 0.1, delay: 0.12 });
  },
  item() {
    tone({ freq: 660, dur: 0.08, type: 'sine', vol: 0.14 });
    tone({ freq: 990, dur: 0.12, type: 'sine', vol: 0.12, delay: 0.07 });
  },
};
