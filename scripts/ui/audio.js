// scripts/ui/audio.js
// Web Audio 合成音效(零素材):swap/match/invalid/item,首次交互后自动 resume
// M11:enabled 开关(设置面板「音效」切换;关时 tone 静默)
// M14 需求方 2026-10-18:局内战斗 BGM(godot-roguelike zhuayao.mp3 复用;循环播放,
// 仅 playing 屏出声;设置面板「音乐」开关默认开,入档 settings.bgm)
// 相对路径: scripts/ui/audio.js

let actx = null;
const state = { enabled: true };

// ---- BGM(懒加载单例:首次 play 才 new Audio,不违反 M11-03 F1 顶层零加载口径——该口径约束图片渲染) ----
const bgmState = { enabled: true, audio: null };

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
function syncBgm(inBattle) {
  const a = ensureBgmAudio();
  if (!a) return;
  if (!bgmState.enabled || !inBattle) {
    if (!a.paused) a.pause();
    return;
  }
  if (a.paused) a.play().catch(() => { /* 首次交互前浏览器拒绝自动播放:待用户点击后再 sync */ });
}

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
  // M14 手机端修复:AudioContext 必须在**真实手势事件处理器内同步**创建/resume——
  // 音效调用多经 rAF/延迟路径(iOS 判定非手势上下文→suspended 静音;BGM 走 Audio 元素在手势里
  // play 成功,故「BGM 好音效没声」)。main 在 pointerdown/touchstart 一次性调用本方法。
  unlock() { ensureCtx(); },
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
  // ===== M15 界面 v2 音效(养成/结算;口径=06/05 样板) =====
  deduct() { tone({ freq: 220, dur: 0.08, type: 'square', vol: 0.05 }); }, // 货币扣除「嗒」
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
