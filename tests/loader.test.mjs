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

const { createAssetLoader, loadImage, preload } = await import('../scripts/assets/loader.js');
const { HOME_ASSETS, battleManifest, menuManifest } = await import('../scripts/assets/manifest.js');

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

test('不同画面共用在途和已下载素材，失败后可重试缺失项', async () => {
  const restore = installStub();
  try {
    const loader = createAssetLoader();
    const shared = { key: 'shared', url: 'shared.png' };
    const missing = { key: 'missing', url: 'late.png', entity: 'battle-ui' };
    failTimes = { 'late.png': 3 };
    requests.length = 0;
    const first = loader.load([shared, missing]);
    const progress = [];
    const second = await loader.load([shared], (...args) => progress.push(args));
    await assert.rejects(first, /缺 late\.png\(实体:battle-ui\)/);
    const recovered = await loader.load([shared, missing]);
    assert.deepEqual(progress, [[1, 1]]);
    assert.equal(recovered.get(shared.key), second.get(shared.key));
    assert.equal(requests.filter(url => url === 'shared.png').length, 1);
    assert.equal(requests.filter(url => url === 'late.png').length, 4);
  } finally {
    restore();
  }
});

test('首页和首关只请求相关素材，战斗清单包含本关首领及已拥有技能的喊话变体', () => {
  assert.deepEqual(new Set(HOME_ASSETS.map(item => item.key)),
    new Set(['ui:start_bg', 'ui:start_logo', 'ui:meadow_circle', 'player:walk:1']));
  assert.ok(menuManifest(1).some(item => item.key.startsWith('fox:')));
  assert.ok(!menuManifest(1).some(item => item.key.startsWith('boss:')));
  const first = battleManifest(1, ['fire_bolt']).map(item => item.key);
  assert.ok(first.includes('bg:meadow:near'));
  assert.ok(first.includes('player:battle_motion'));
  assert.ok(!first.some(key => key.startsWith('player:idle:') || key.startsWith('player:walk_start:')));
  assert.ok(first.includes('ui:board_surface'));
  assert.ok(first.includes('skill-fx:shots') && first.includes('skill-fx:hits'));
  assert.ok(!first.includes('skill-fx:fields'));
  assert.ok(!first.includes('call:bubble'));
  assert.ok(!HOME_ASSETS.some(item => item.key === 'ui:board_surface'));
  assert.ok(!menuManifest(1).some(item => item.key === 'ui:board_surface'));
  assert.ok(first.some(key => key.startsWith('slime:')));
  assert.ok(first.some(key => key.startsWith('fox:')));
  assert.ok(!first.some(key => key.startsWith('boss:') || key.startsWith('call:bg:')));
  const fifth = battleManifest(5, ['fire_dotzone', 'water_field']).map(item => item.key);
  assert.ok(fifth.includes('bg:volcano:near'));
  assert.ok(fifth.includes('skill-fx:fields'));
  assert.ok(fifth.includes('call:bubble'));
  assert.ok(fifth.some(key => key.startsWith('boss:')));
  assert.deepEqual(fifth.filter(key => key.startsWith('call:bg:')).sort(), ['call:bg:fire:1', 'call:bg:water:2']);
});
