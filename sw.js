// sw.js — Service Worker(M14 需求方 2026-10-18:进站加载优化)
// 策略:同源 GET 请求 → cache-first + 后台 revalidate(stale-while-revalidate)——
//   二次进站资源全部本地秒开;后台静默拉新(下一次生效)。
// 调试/发版口径:URL 带 ?cb= / ?v= 强制 network-first(绕过缓存,与项目 cache-bust 惯例一致)。
// 版本升级:递增本站缓存版本，激活时只清理本站旧缓存。
// 相对路径: sw.js(仓库根,scope=部署目录;本地 dev 与 Pages 子路径均成立)

const CACHE_PREFIX = 'ssww-cache-';
const CACHE_VERSION = 'v8';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

function fetchCurrent(req) {
  if (req.mode === 'navigate') return fetch(req, { cache: 'reload' });
  const url = new URL(req.url);
  url.searchParams.set('_ssww_rev', CACHE_VERSION);
  // 以原请求为存储键，网络端按站点版本取资源，避免旧 HTTP 缓存写回新缓存。
  return fetch(url, { cache: 'no-cache', credentials: req.credentials, headers: req.headers, redirect: req.redirect });
}

self.addEventListener('install', (event) => {
  // 不做 install 预缓存(资源清单由运行时逐请求缓存,避免版本列表维护)
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!url.href.startsWith(self.registration.scope)) return; // 只缓存本游戏目录
  // 调试/发版:cache-bust URL 强制走网络(失败回落缓存,弱网下仍可用)
  const bust = /[?&](cb|v)=/.test(url.search);
  if (bust) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const fresh = await fetchCurrent(req);
        if (fresh.ok) await cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const hit = await cache.match(req);
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
        const fresh = await fetchCurrent(req);
        if (fresh.ok) await cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch { return null; }
    })();
    if (hit) { event.waitUntil(fetchAndPut); return hit; }
    const fresh = await fetchAndPut;
    if (fresh) return fresh;
    throw new Error('network down and no cache');
  })());
});
