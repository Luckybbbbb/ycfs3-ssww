// scripts/assets/loader.js
// 分批加载会话内复用同一图片和图集请求。逐帧失败重试，仍缺失时保留路径与实体诊断。

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

async function loadAtlasIndex() {
  if (typeof document === 'undefined') return new Map();
  try {
    const response = await fetch('assets/atlases/index.json', { cache: 'no-cache' });
    if (!response.ok) return new Map();
    const index = await response.json();
    const frames = new Map();
    for (const [file, group] of Object.entries(index)) {
      for (const [url, rect] of Object.entries(group.frames)) frames.set(url, { file, rect });
    }
    return frames;
  } catch {
    return new Map();
  }
}

async function sliceFrame(image, [x, y, w, h], item) {
  const frame = document.createElement('canvas');
  frame.width = w;
  frame.height = h;
  frame.getContext('2d').drawImage(image, x, y, w, h, 0, 0, w, h);
  const [, result] = await loadImage({ ...item, url: frame.toDataURL('image/png') }, 0);
  return result;
}

export function createAssetLoader() {
  const images = new Map();
  const pending = new Map();
  const atlases = new Map();
  const queue = [];
  let active = 0;
  let index;

  function pump() {
    while (active < LOAD_CONCURRENCY && queue.length) {
      const { item, resolve, reject } = queue.shift();
      active++;
      loadImage(item).then(resolve, reject).finally(() => {
        active--;
        pump();
      });
    }
  }

  function download(item) {
    return new Promise((resolve, reject) => {
      queue.push({ item, resolve, reject });
      pump();
    });
  }

  function atlasImage(file) {
    if (!atlases.has(file)) {
      const request = download({ key: file, url: `assets/atlases/${file}`, entity: 'atlas' })
        .catch(error => { atlases.delete(file); throw error; });
      atlases.set(file, request);
    }
    return atlases.get(file);
  }

  async function read(item, direct) {
    if (!direct) {
      index ??= loadAtlasIndex();
      const frame = (await index).get(item.url);
      if (frame) {
        try {
          const [, image] = await atlasImage(frame.file);
          return await sliceFrame(image, frame.rect, item);
        } catch { /* 图集缺失时按原路径重试本帧 */ }
      }
    }
    const [, image] = await download(item);
    return image;
  }

  function ensure(item, direct) {
    if (images.has(item.key)) return Promise.resolve(images.get(item.key));
    if (!pending.has(item.key)) {
      const request = read(item, direct).then(image => {
        images.set(item.key, image);
        return image;
      }).finally(() => pending.delete(item.key));
      pending.set(item.key, request);
    }
    return pending.get(item.key);
  }

  return {
    images,
    async load(manifest, onProgress, { direct = false } = {}) {
      let done = 0;
      const entries = await Promise.allSettled(manifest.map(async item => {
        const image = await ensure(item, direct);
        done++;
        onProgress?.(done, manifest.length);
        return [item.key, image];
      }));
      const failed = entries.find(entry => entry.status === 'rejected');
      if (failed) throw failed.reason;
      return new Map(entries.map(entry => entry.value));
    },
  };
}

export function preload(manifest, onProgress) {
  return createAssetLoader().load(manifest, onProgress);
}
