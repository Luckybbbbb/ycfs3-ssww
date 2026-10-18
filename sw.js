// sw.js — Service Worker(M14 需求方 2026-10-18:进站加载优化)
// 策略:同源 GET 请求 → cache-first + 后台 revalidate(stale-while-revalidate)——
//   二次进站资源全部本地秒开;后台静默拉新(下一次生效)。
// 调试/发版口径:URL 带 ?cb= / ?v= 强制 network-first(绕过缓存,与项目 cache-bust 惯例一致)。
// 版本升级:CACHE_NAME 递增即可,activate 时清理旧缓存全量重建。
// 相对路径: sw.js(仓库根,scope=部署目录;本地 dev 与 Pages 子路径均成立)

const CACHE_NAME = 'ssww-cache-v1';

self.addEventListener('install', (event) => {
  // 不做 install 预缓存(资源清单由运行时逐请求缓存,避免版本列表维护)
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 只管同源
  // 调试/发版:cache-bust URL 强制走网络(失败回落缓存,弱网下仍可用)
  const bust = /[?&](cb|v)=/.test(url.search);
  if (bust) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const hit = await caches.match(req);
        if (hit) return hit;
        throw new Error('network down and no cache');
      }
    })());
    return;
  }
  // 常规:cache-first + 后台 revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(req);
    const fetchAndPut = (async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch { return null; }
    })();
    if (hit) { event.waitUntil(fetchAndPut); return hit; }
    const fresh = await fetchAndPut;
    if (fresh) return fresh;
    throw new Error('network down and no cache');
  })());
});
