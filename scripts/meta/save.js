// scripts/meta/save.js
// localStorage 存档(D13/FR-8):ssww.profile = {level, expTotal, unlockedLevel, loadout[4], settings};
// ssww.progress = {lastLevelCleared, bestChains}。写入时机=事件驱动(升级/通关/装配/设置),非每帧。
// storage 注入(默认 localStorage,单测传内存桩);损坏数据回落默认档,不抛错。
// 相对路径: scripts/meta/save.js

import { DEFAULT_LOADOUT } from '../skills/registry.js';

const KEY_PROFILE = 'ssww.profile';
const KEY_PROGRESS = 'ssww.progress';

export function defaultProfile() {
  return {
    level: 1,
    expTotal: 0,
    unlockedLevel: 1,
    loadout: [...DEFAULT_LOADOUT],
    settings: { effects: true },
  };
}

export function defaultProgress() {
  return { unlockedLevel: 1, lastLevelCleared: 0, bestChains: 0 }; // 初始仅第 1 关(FR-6)
}

function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback();
    const v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : fallback();
  } catch {
    return fallback(); // 损坏/不可解析 → 新档流程(FR-8 验收:清 localStorage 重开走新档)
  }
}

function writeJson(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式等写失败静默保留内存态 */ }
}

export function loadProfile(storage = globalThis.localStorage) {
  const d = defaultProfile();
  const v = readJson(storage, KEY_PROFILE, defaultProfile);
  return {
    ...d,
    ...v,
    loadout: Array.isArray(v.loadout) && v.loadout.length === 4 ? v.loadout : d.loadout,
  };
}

export function saveProfile(storage, profile) { writeJson(storage, KEY_PROFILE, profile); }

export function loadProgress(storage = globalThis.localStorage) {
  return { ...defaultProgress(), ...readJson(storage, KEY_PROGRESS, defaultProgress) };
}

export function saveProgress(storage, progress) { writeJson(storage, KEY_PROGRESS, progress); }

// 清档(FR-8 验收入口)
export function clearAll(storage) {
  try { storage.removeItem(KEY_PROFILE); storage.removeItem(KEY_PROGRESS); } catch { /* 同上 */ }
}
