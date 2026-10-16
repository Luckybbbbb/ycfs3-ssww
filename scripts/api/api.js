// scripts/api/api.js
// 后端预留接口(D2/FR-8):getProfile / saveProfile / getLevels / submitRun——签名与未来 REST 一致(全 Promise);
// 本地实现直连 save.js(levels 数据由存档派生);换远端实现时仅替换本文件,其余模块不动。
// 相对路径: scripts/api/api.js

import { loadProfile, saveProfile, loadProgress, saveProgress } from '../meta/save.js';

export function createApi(storage = globalThis.localStorage) {
  return {
    // 读取玩家档案(等级/经验/解锁/装配/设置)
    async getProfile() { return loadProfile(storage); },
    // 写回玩家档案(事件驱动调用:升级/通关/装配变更/设置变更)
    async saveProfile(profile) { saveProfile(storage, profile); return profile; },
    // 关卡数据:本地实现由档案/进度派生;远端实现可返回服务端关卡表
    async getLevels() {
      const progress = loadProgress(storage);
      const profile = loadProfile(storage);
      return {
        unlockedLevel: Math.max(progress.lastLevelCleared + 1, profile.unlockedLevel),
        lastLevelCleared: progress.lastLevelCleared,
      };
    },
    // 提交一局结果(通关/失败):本地写进度档;远端实现为 POST
    async submitRun(run) {
      // run: {level, victory, expGained, kills}
      const progress = loadProgress(storage);
      if (run.victory) {
        progress.lastLevelCleared = Math.max(progress.lastLevelCleared, run.level);
      }
      saveProgress(storage, progress);
      return { ok: true, progress };
    },
  };
}
