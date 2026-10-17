// scripts/assets/loader.js
// 序列帧加载器:按清单预载 Image,缺文件给出「缺 <路径>(实体:<名>)」诊断并停载(FR-9 验收)
// M11a 增强(2026-10-17 线上实测:Pages 并发 125 请求弱网/代理下随机个别 404/重置,
// 每次刷新缺失文件不同——瞬时网络失败而非文件缺失):单图失败**重试 2 次**(300ms 退避),
// 重试仍失败才 reject 停载——FR-9「缺图停载」语义不变(真缺失必停),只消除瞬时抖动误停。
// 相对路径: scripts/assets/loader.js

const LOAD_RETRIES = 2;     // 单图重试次数(首次 + 2 = 至多 3 次请求)
const RETRY_DELAY_MS = 300; // 重试退避(固定;瞬时失败场景够用,不引入指数复杂度)
const LOAD_CONCURRENCY = 24; // 并发上限(125 项一次性并发在弱网/代理下易触发连接重置;分批 workers)

export function loadImage(item, retriesLeft = LOAD_RETRIES) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve([item.key, img]);
    img.onerror = () => {
      // 瞬时网络失败 → 退避后重试;重试耗尽仍失败 → 停载诊断(路径+实体不变)
      if (retriesLeft > 0) {
        setTimeout(() => {
          loadImage(item, retriesLeft - 1).then(resolve, reject);
        }, RETRY_DELAY_MS);
        return;
      }
      reject(new Error(`缺 ${item.url}(实体:${item.entity})`));
    };
    img.src = item.url;
  });
}

// 预载整份清单;任一缺失(重试后仍失败)即 reject(首个缺失路径进错误信息),由 main 停载并提示。
// 并发按 LOAD_CONCURRENCY 分批 workers(全部完成后统一返回;单图失败重试在 loadImage 内)
export async function preload(manifest) {
  const images = new Map();
  const queue = [...manifest];
  const workers = Array.from({ length: Math.min(LOAD_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const [key, img] = await loadImage(item);
      images.set(key, img);
    }
  });
  await Promise.all(workers);
  return images;
}
