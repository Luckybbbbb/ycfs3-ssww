// scripts/assets/loader.js
// 序列帧加载器:按清单预载 Image,缺文件给出「缺 <路径>(实体:<名>)」诊断并停载(FR-9 验收)
// 相对路径: scripts/assets/loader.js

export function loadImage(item) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve([item.key, img]);
    img.onerror = () => reject(new Error(`缺 ${item.url}(实体:${item.entity})`));
    img.src = item.url;
  });
}

// 预载整份清单;任一缺失即 reject(首个缺失路径进错误信息),由 main 停载并提示
export async function preload(manifest) {
  const images = new Map();
  await Promise.all(manifest.map(item =>
    loadImage(item).then(([key, img]) => images.set(key, img))));
  return images;
}
