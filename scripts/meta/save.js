// scripts/meta/save.js
// localStorage 存档(M6/v0.2,00 文档 7 节):ssww.profile = {schemaVer:2, level, coins, materials,
// ownedSkills[], skillLevels{id:lv}, unlockedLevel, loadout[4], settings};ssww.progress = {lastLevelCleared, bestChains}。
// 旧档切换(裁决 F6):schemaVer 缺失或 ≠2(含 v0.1 exp 体系档)→ 删除两键回落新档,不迁移。
// 写入时机=事件驱动(升级/抽卡/技能升级/胜负结算含失败/装配/设置),非每帧。
// storage 注入(默认 localStorage,单测传内存桩);损坏数据回落默认档,不抛错。
// 相对路径: scripts/meta/save.js

import { DEFAULT_LOADOUT } from '../skills/registry.js';
import { defaultEconomy } from './economy.js';

const KEY_PROFILE = 'ssww.profile';
const KEY_PROGRESS = 'ssww.progress';
const SCHEMA_VER = 2;

export function defaultProfile() {
  const eco = defaultEconomy();
  return {
    schemaVer: SCHEMA_VER,
    level: 1,
    coins: eco.coins,
    materials: eco.materials,
    ownedSkills: [...eco.ownedSkills],
    skillLevels: { ...eco.skillLevels },
    unlockedLevel: 1,
    loadout: [...DEFAULT_LOADOUT],
    settings: { effects: true, sfx: true }, // M11-02 F5:音效开关入档(原只存 effects,刷新后音效开关丢失)
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

// 数值字段边界校验(REQ-M4-03 F9 续审):须为有限整数且在 [min,max] 内,
// 否则回落默认——Infinity(如 1e309)、NaN、负数、字符串数字均不进入游戏逻辑。
function pickInt(v, key, min, max, d) {
  const x = v ? v[key] : undefined;
  if (Number.isInteger(x) && x >= min && x <= max) return x;
  return d[key];
}

export function loadProfile(storage = globalThis.localStorage) {
  const d = defaultProfile();
  // REQ-M6-04 F10:getItem 也须在异常回落内(隐私模式/被拒的存储读取抛错时
  // 不得沿 api.getProfile() 阻断启动——本轮回归修复,与 readJson 同口径)
  let raw = null;
  try { raw = storage.getItem(KEY_PROFILE); } catch { raw = null; }
  // 旧档切换(裁决 F6):无 schemaVer 或 ≠2 的档(含 v0.1 exp 体系档)不兼容——删除两键回落新档
  let v = null;
  try { v = raw ? JSON.parse(raw) : null; } catch { v = null; }
  if (!v || typeof v !== 'object' || v.schemaVer !== SCHEMA_VER) {
    clearAll(storage); // 旧档作废,回落新档默认(等级/装配/进度不迁移,产品取舍见 changelog)
    return d;
  }
  const settings = (v.settings && typeof v.settings === 'object' && !Array.isArray(v.settings))
    ? { effects: v.settings.effects !== false, sfx: v.settings.sfx !== false } : d.settings;
  // 拥有/技能等级校验:ownedSkills 须含 5 初始弹(拥有制基线);skillLevels 仅接受已拥有的正整数等级
  const owned = Array.isArray(v.ownedSkills) && v.ownedSkills.every(x => typeof x === 'string')
    ? [...new Set([...d.ownedSkills, ...v.ownedSkills])] : d.ownedSkills;
  const skillLevels = {};
  for (const id of owned) {
    const lv = v.skillLevels?.[id];
    skillLevels[id] = (Number.isInteger(lv) && lv >= 1 && lv <= 10) ? lv : 1;
  }
  return {
    schemaVer: SCHEMA_VER,
    level: pickInt(v, 'level', 1, 999, d),
    coins: pickInt(v, 'coins', 0, 1e9, d),
    materials: pickInt(v, 'materials', 0, 1e9, d),
    ownedSkills: owned,
    skillLevels,
    unlockedLevel: pickInt(v, 'unlockedLevel', 1, 999, d),
    loadout: Array.isArray(v.loadout) && v.loadout.length === 4 && v.loadout.every(x => typeof x === 'string')
      ? v.loadout : d.loadout,
    settings,
  };
}

export function saveProfile(storage, profile) { writeJson(storage, KEY_PROFILE, { ...profile, schemaVer: SCHEMA_VER }); }

// progress 逐字段校验(F9 续审):{"lastLevelCleared":"bad"} 之类不得混入,
// 否则 getLevels/canPlay 得到 NaN 解锁等级,连第 1 关都进不去。
export function loadProgress(storage = globalThis.localStorage) {
  const d = defaultProgress();
  const v = readJson(storage, KEY_PROGRESS, defaultProgress);
  return {
    unlockedLevel: pickInt(v, 'unlockedLevel', 1, 999, d),
    lastLevelCleared: pickInt(v, 'lastLevelCleared', 0, 999, d),
    bestChains: pickInt(v, 'bestChains', 0, 1e9, d),
  };
}

export function saveProgress(storage, progress) { writeJson(storage, KEY_PROGRESS, progress); }

// 清档(FR-8 验收入口)
export function clearAll(storage) {
  try { storage.removeItem(KEY_PROFILE); storage.removeItem(KEY_PROGRESS); } catch { /* 同上 */ }
}
