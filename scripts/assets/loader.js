// scripts/assets/loader.js
// 序列帧加载器:按清单预载 Image,缺文件给出「缺 <路径>(实体:<名>)」诊断并停载(FR-9 验收)
// M11a 增强(2026-10-17 线上实测:Pages 并发 125 请求弱网/代理下随机个别 404/重置,
// 每次刷新缺失文件不同——瞬时网络失败而非文件缺失):单图失败**重试 2 次**(300ms 退避),
// 重试仍失败才 reject 停载——FR-9「缺图停载」语义不变(真缺失必停),只消除瞬时抖动误停。
// M14 需求方 2026-10-18:雪碧图(atlas)优先加载——assets/atlases/index.json 存在时,小尺寸
// 序列帧/图标按组加载 atlas(150 项 → 7 张),离屏切帧生成 dataURL Image(key/尺寸与逐帧
// 完全一致,绘制代码零改动);index.json 或某组缺失(开发新增素材未重打包)自动回落逐帧原路径。
// 无 DOM 环境(单测)直接走逐帧。断点续传评估结论:小文件重试已覆盖,不实现 Range(见 changelog)。
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

// ---- M14:atlas 切帧(离屏 canvas → dataURL Image;key/尺寸语义与逐帧一致) ----
function sliceAtlas(atlasImg, frames) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const out = new Map(); // rel(url) → Image
  for (const [rel, [x, y, w, h]] of Object.entries(frames)) {
    const fc = document.createElement('canvas');
    fc.width = w; fc.height = h;
    const fctx = fc.getContext('2d');
    fctx.drawImage(atlasImg, x, y, w, h, 0, 0, w, h);
    const img = new Image();
    img.src = fc.toDataURL('image/png');
    out.set(rel, img);
  }
  void cv; void ctx;
  return out;
}

// 原逐帧路径(回退/无 DOM)
async function preloadPerFrame(manifest, onProgress) {
  const images = new Map();
  const queue = [...manifest];
  const total = queue.length;
  let done = 0;
  const tick = () => { done++; if (onProgress) onProgress(done, total); };
  const workers = Array.from({ length: Math.min(LOAD_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const [key, img] = await loadImage(item);
      images.set(key, img);
      tick();
    }
  });
  await Promise.all(workers);
  return images;
}

// 预载整份清单;任一缺失(重试后仍失败)即 reject(首个缺失路径进错误信息),由 main 停载并提示。
// M14:onProgress(done, total) 完成数回调(main 用于画加载进度条)。
// atlas 路径:total=atlas 组数+非打包清单项数;每完成一组/一项计 1。
export async function preload(manifest, onProgress) {
  // 无 DOM(单测)或 atlas 索引缺失 → 回落逐帧
  if (typeof document === 'undefined') return preloadPerFrame(manifest, onProgress);
  let atlasIndex = null;
  try {
    const res = await fetch('assets/atlases/index.json', { cache: 'no-cache' });
    if (res.ok) atlasIndex = await res.json();
  } catch { /* 回落逐帧 */ }
  if (!atlasIndex || !Object.keys(atlasIndex).length) return preloadPerFrame(manifest, onProgress);

  // 清单分桶:可从 atlas 切的 / 需逐帧的(大图与新素材)
  const urlToItem = new Map(manifest.map(it => [it.url, it]));
  const perFrame = [];
  const covered = new Set();
  for (const it of manifest) {
    const inAtlas = Object.values(atlasIndex).some(g => g.frames[it.url]);
    if (!inAtlas) perFrame.push(it);
    else covered.add(it.url);
  }

  // 进度口径:atlas 组数+逐帧项数
  const groups = Object.entries(atlasIndex);
  const total = groups.length + perFrame.length;
  let done = 0;
  const tick = () => { done++; if (onProgress) onProgress(done, total); };

  const images = new Map();
  // 1) 逐帧项(并发 workers,复用重试)
  let fi = 0;
  const frameWorkers = Array.from({ length: Math.min(LOAD_CONCURRENCY, Math.max(1, perFrame.length)) }, async () => {
    while (fi < perFrame.length) {
      const item = perFrame[fi++];
      const [key, img] = await loadImage(item);
      images.set(key, img);
      tick();
    }
  });
  // 2) atlas 组(并发加载;单组失败→该组帧回落逐帧,不让整个停载——atlas 属优化路径)
  const atlasWorkers = groups.map(async ([atlasFile, group]) => {
    try {
      const [, atlasImg] = await loadImage({ key: atlasFile, url: `assets/atlases/${atlasFile}` });
      const sliced = sliceAtlas(atlasImg, group.frames);
      for (const it of manifest) {
        const img = sliced.get(it.url);
        if (img) images.set(it.key, img);
      }
      // dataURL 解码是异步的:等待全部 complete(onload 同步完成后 naturalWidth 可用;守卫一轮)
      await Promise.all([...sliced.values()].map(img => img.complete ? Promise.resolve() :
        new Promise(res => { img.onload = res; img.onerror = res; })));
      tick();
    } catch {
      // atlas 缺失/损坏:该组帧回落逐帧(重试口径一致)
      for (const it of manifest) {
        if (covered.has(it.url) && !images.has(it.key)) {
          const [key, img] = await loadImage(it);
          images.set(key, img);
        }
      }
      tick();
    }
  });
  await Promise.all([...frameWorkers, ...atlasWorkers]);
  // 终检:清单全覆盖(防 atlas 帧索引与清单不同步漏帧)
  const missing = manifest.filter(it => !images.has(it.key));
  if (missing.length) {
    // 少量漏帧(索引陈旧)→ 逐帧补齐
    for (const it of missing) {
      const [key, img] = await loadImage(it);
      images.set(key, img);
    }
  }
  return images;
}
