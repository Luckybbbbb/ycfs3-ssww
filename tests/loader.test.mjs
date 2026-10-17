// tests/loader.test.mjs — M11a 预载器健壮性:瞬时失败重试/重试耗尽停载/并发分批全载
// 运行: node --test tests/loader.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

// Image 桩:按 URL 可编程失败次数(failTimes[url] 次error后成功);记录请求次数
const requests = [];
let failTimes = {};
// 可编程 Image 桩(按 URL 失败 N 次后成功;记录请求次数)。
// **用例内安装/还原**(并跑 --test-isolation=none 下其它测试文件会在模块求值期替换 globalThis.Image,
// 其桩不回调 onload 会令 preload 永久挂起——桩必须在本文件用例执行时生效)
class StubImage {
  set src(v) {
    this._src = v;
    requests.push(v);
    const url = String(v);
    if ((failTimes[url] || 0) > 0) {
      failTimes[url] -= 1;
      setTimeout(() => this.onerror && this.onerror(), 1);
    } else {
      this.complete = true; this.naturalWidth = 10;
      setTimeout(() => this.onload && this.onload(), 1);
    }
  }
  get src() { return this._src; }
}
const installStub = () => { const prev = globalThis.Image; globalThis.Image = StubImage; return () => { globalThis.Image = prev; }; };

const { loadImage, preload } = await import('../scripts/assets/loader.js');

test('M11a loadImage 瞬时失败重试:失败 1~2 次后成功(重试 2 次口径),成功返回 [key, img]', async () => {
  const restore = installStub();
  failTimes = { 'a.png': 2 };
  requests.length = 0;
  const [key, img] = await loadImage({ key: 'k1', url: 'a.png', entity: 'e1' });
  assert.equal(key, 'k1');
  assert.ok(img, 'img 返回');
  assert.equal(requests.filter(u => u === 'a.png').length, 3, '首次+重试 2 次=3 次请求');
  restore();
});

test('M11a loadImage 重试耗尽仍失败 → reject 停载诊断(缺 <路径>(实体:<名>))', async () => {
  const restore = installStub();
  failTimes = { 'gone.png': 999 };
  requests.length = 0;
  await assert.rejects(
    () => loadImage({ key: 'k2', url: 'gone.png', entity: 'player' }),
    /缺 gone\.png\(实体:player\)/,
  );
  assert.equal(requests.filter(u => u === 'gone.png').length, 3, '重试耗尽(共 3 次请求)');
  restore();
});

test('M11a preload 并发分批:125 项全部加载完成(错误信息只含真缺失项);瞬时失败不误停', async () => {
  const restore = installStub();
  const manifest = Array.from({ length: 125 }, (_, i) => ({ key: `k${i}`, url: `f${i}.png`, entity: 'e' }));
  failTimes = {};
  for (let i = 0; i < 125; i += 7) failTimes[`f${i}.png`] = 1; // 每 7 项注入 1 次瞬时失败
  const images = await preload(manifest);
  assert.equal(images.size, 125, '125 项全部就绪(瞬时失败被重试吸收)');
  assert.ok(images.get('k0') && images.get('k124'), '首尾项存在');
  // 真缺失仍停载
  failTimes = { 'missing.png': 999 };
  await assert.rejects(() => preload([{ key: 'x', url: 'missing.png', entity: 'boss' }]), /缺 missing\.png/);
  restore();
});
