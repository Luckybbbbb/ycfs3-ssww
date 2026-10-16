// scripts/meta/levels.js
// 关卡解锁纯逻辑(FR-6,D14):每关 10 波、第 10 波 Boss;顺序解锁、已通关可重打(等级保留)。
// 相对路径: scripts/meta/levels.js

export const WAVES_PER_LEVEL = 10;

// 初始仅第 1 关
export function initialProgress() { return { unlockedLevel: 1, lastLevelCleared: 0 }; }

// 是否可玩(FR-6 验收:未通关第 N 关时第 N+1 关不可选)
export const canPlay = (progress, L) => L >= 1 && L <= progress.unlockedLevel;

// 通关结算:解锁 L+1(不回退;重复通关无额外奖励)。返回新 progress 与是否首次通关。
export function onVictory(progress, L) {
  const unlockedLevel = Math.max(progress.unlockedLevel, L + 1);
  return {
    progress: {
      unlockedLevel,
      lastLevelCleared: Math.max(progress.lastLevelCleared, L),
    },
    firstClear: L > progress.lastLevelCleared,
  };
}

// 难度映射(04 文档第 4 节):w_global = (L−1)×10 + w_local
export const wGlobal = (L, wLocal) => (L - 1) * WAVES_PER_LEVEL + wLocal;
