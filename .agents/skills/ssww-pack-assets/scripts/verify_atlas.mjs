// .claude/skills/ssww-pack-assets/scripts/verify_atlas.mjs
// 雪碧图打包 CDP 冒烟:atlas 索引与组齐全/小图零单帧请求(sprites+icons 双覆盖)/
// 敌人序列帧渲染(与真实战场背景差分+单色椭圆检测,透明帧与兜底椭圆均判 FAIL)/
// 内置负例自检(背景参照区/叠椭圆)/连接与全部 CDP 调用有界超时/全路径关闭自建 target。
// 前提:headless Edge 9225 + dev-server 8932(启动方式见仓库 docs/changelog.md 环境坑节)。
// 用法: node .claude/skills/ssww-pack-assets/scripts/verify_atlas.mjs
// 输出: PASS/FAIL 逐项;任何 FAIL → exit 1(禁止带病提交)。
import fs from 'node:fs';

const fails = [];
const ok = (c, l) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) fails.push(l); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 期望集合:与 tools/pack_atlas.py 的 GROUPS 同步维护(七组齐全,icons 覆盖四个子目录)
const EXPECT_GROUPS = ['slime', 'fox_anim', 'zombie', 'snake', 'tiger', 'boss', 'icons'];

// —— 有界超时:连接/全部 CDP 调用统一走 deadline,不依赖调用方各自包装 ——
const TIMEOUT_MS = { fetch: 5000, call: 10000 };
const deadlineFetch = async (url, ms) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { signal: ac.signal }); } finally { clearTimeout(t); }
};

let ws = null, sessionId = null, targetId = null, cleanupResult = null;
// 关闭自有 target(所有路径——正常/断言失败/异常/硬超时——都经此清理;幂等=复用首次清理结果)
// 返回 {ok, detail}:closeTarget 超时/success:false/连接断开/ws 关闭未完成(非 CLOSED)/
// 复核 3 次仍在,均视为失败,由调用方记 FAIL
async function cleanup() {
  if (cleanupResult) return cleanupResult; // 幂等:复用首次清理结果(等待其完成),不直接报成功
  cleanupResult = doCleanup();
  return cleanupResult;
}
async function doCleanup() {
  const detail = [];
  let okFlag = true;
  try {
    if (targetId && ws && ws.readyState === 1) {
      let res = null;
      try {
        res = await Promise.race([
          send('Target.closeTarget', { targetId }),
          sleep(2000).then(() => { throw new Error('closeTarget 超时'); }),
        ]);
      } catch (e) { okFlag = false; detail.push(`closeTarget 失败(${e.message})`); }
      if (res && res.success === false) { okFlag = false; detail.push('closeTarget success:false'); }
    } else if (targetId) {
      okFlag = false; detail.push(`连接已断(ws.readyState=${ws && ws.readyState}),无法确认 target 关闭`);
    }
  } catch (e) { okFlag = false; detail.push(`cleanup 异常(${e.message})`); }
  // 独立验证:不经 CDP,直接查 /json/list 确认自有 target 已消失(关闭异步生效,重试 3 次)
  // 复核结果只记账、提前命中只跳出循环——任何路径都必须先走完下方 ws 关闭再 return:
  // 页面 rAF 主循环活跃时带着未关闭的 undici WebSocket 退出,会触发 libuv
  // 「Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)」把退出码污染为 127(四轮审核实测)
  if (targetId) {
    for (let i = 0; i < 3; i++) {
      await sleep(500);
      try {
        const list = await Promise.race([
          deadlineFetch('http://127.0.0.1:9225/json/list', 3000).then(x => x.json()),
          sleep(3000).then(() => { throw new Error('list 解析超时'); }),
        ]);
        if (!list.some(t => t.id === targetId)) { detail.push('target 已关闭并经 /json/list 复核'); break; }
        if (i === 2) { okFlag = false; detail.push('3 次复查 target 仍在'); }
        else detail.push(`第${i + 1}次复查 target 仍在`);
      } catch (e) { detail.push(`/json/list 验证失败(${e.message})`); okFlag = false; }
    }
  }
  // ws 彻底关闭(所有路径必经)——关闭确认覆盖所有入口状态:
  // OPEN→主动 close 并等 onclose;CLOSING/CONNECTING→只等;最终非 CLOSED 一律记失败
  if (ws) {
    if (ws.readyState === 1) {
      ws.close();
      await Promise.race([
        new Promise(r => { ws.onclose = r; }),
        sleep(2000),
      ]);
    }
    if (ws.readyState !== 3) {
      // 给 CLOSING 状态最后的落地窗口,仍未 CLOSED 则记失败
      await Promise.race([
        new Promise(r => { ws.onclose = r; }),
        sleep(2000),
      ]);
    }
    if (ws.readyState !== 3) { okFlag = false; detail.push(`ws 关闭未完成(readyState=${ws.readyState})`); }
    await sleep(500);
  }
  return { ok: okFlag, detail: detail.join('; ') || 'target 已关闭、ws 已 CLOSED 并经 /json/list 复核' };
}
// 硬超时兜底:写入失败状态(timedOut)再走统一收口——正常收尾若先完成,hardTimer 触发时直接跳过;
// 若 hardTimer 先完成,正常收尾的 finish() 因 finished 标志成为空操作,退出码恒反映超时失败
let timedOut = false, finished = false;
const hardTimer = setTimeout(() => {
  if (finished) return;
  timedOut = true;
  console.log('FAIL  全局超时(300s,环境未就绪或页面卡死)');
  cleanup().finally(() => finish(2));
}, 300000);
// 统一收口:RESULT 与退出码在此唯一产生(timedOut 计入 fails,保证超时不可能输出 PASS/exit 0)
function finish(exitCode) {
  if (finished) return;
  finished = true;
  if (timedOut && !fails.some(f => f.includes('全局超时'))) fails.push('全局超时(300s,环境未就绪或页面卡死)');
  clearTimeout(hardTimer);
  console.log(fails.length ? `RESULT=FAIL(${fails.length})` : 'RESULT=PASS');
  process.exit(exitCode ?? (fails.length ? 1 : 0));
}

let id = 0; const pending = new Map();
function send(m, p = {}, s) {
  return new Promise((res, rej) => {
    const mid = ++id; const t = setTimeout(() => { pending.delete(mid); rej(new Error(`CDP 超时 ${m}(${TIMEOUT_MS.call}ms)`)); }, TIMEOUT_MS.call);
    pending.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    try { ws.send(JSON.stringify({ id: mid, method: m, params: p, sessionId: s })); } catch (e) { clearTimeout(t); rej(e); }
  });
}
// 成对采样:目标窗口 + 同尺寸背景参照窗口;refSnap 为「全部敌人移出屏幕后」的真实背景基线
// colored=非近白像素数;distinct=颜色档数;diffRatio=目标区与参照区档级不同占比(透明帧露背景→≈0);
// ellipseRatio=精确兜底绿 #5fae5f 占比(兜底椭圆→≈1)
// 判定:非空白 + 多色档 + 与背景差分显著 + 非兜底绿单色
// (真实贴图:diffRatio 高、ellipseRatio≈0;透明敌帧露背景:diffRatio≈0;兜底椭圆:ellipseRatio≈1)
const passPix = (p) => !!p && !p.none
  && p.colored >= p.total * 0.4
  && p.distinct >= 3
  && p.diffRatio >= 0.25
  && p.ellipseRatio < 0.6;

try {
  let ver;
  try {
    const r = await deadlineFetch('http://127.0.0.1:9225/json/version', TIMEOUT_MS.fetch);
    ver = await Promise.race([r.json(), sleep(TIMEOUT_MS.fetch).then(() => { throw new Error('json 解析超时'); })]);
  } catch (e) {
    console.log(`FAIL  连接 Edge 9225(${e.message};先启动 headless Edge 9225 + dev-server 8932)`);
    console.log('RESULT=FAIL(1)');
    process.exit(1);
  }
  ws = new WebSocket(ver.webSocketDebuggerUrl);
ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } };
ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error('CDP 连接断开')); pending.clear(); };
  await Promise.race([new Promise(r => { ws.onopen = r; }), sleep(TIMEOUT_MS.fetch).then(() => { throw new Error('ws 握手超时'); })]);
  // 从创建 target 起全部纳入清理范围
  ({ targetId } = await send('Target.createTarget', { url: 'about:blank' }));
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Page.enable', {}, sessionId);
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result.value;

  await send('Page.navigate', { url: 'http://127.0.0.1:8932/?cb=' + Date.now() }, sessionId);
  await send('Page.bringToFront', {}, sessionId);
  // boot 等待放宽到 90s(no-store 头下每次全量拉资源,冷启可能超 40s)
  let booted = false;
  for (let i = 0; i < 450; i++) { if (await ev(`!!window.__ssww`)) { booted = true; break; } await sleep(200); }
  ok(booted, 'boot 完成');

  const stats = await ev(`(() => {
    const res = performance.getEntriesByType('resource').map(r => r.name.replace(location.origin, ''));
    return {
      atlas: res.filter(n => n.includes('/atlases/') && n.endsWith('.png')),
      json: res.filter(n => n.includes('atlases/index.json')),
      smallSingle: res.filter(n => (n.includes('/sprites/') || n.includes('/icons/'))
        && !n.includes('/atlases/')
        && !n.includes('/sprites/player/') && !n.includes('/sprites/skillcall/')),
    };
  })()`);
  ok(stats.json.length === 1, `atlas 索引已加载(${stats.json.length})`);
  ok(stats.atlas.length >= 1, `atlas 已加载(${stats.atlas.length} 张)`);

  // 期望集合核对:GROUPS 七组齐全、每组帧数>0、icons 覆盖四子目录(单帧断言只认目录,组核对在此兜住)
  // index.json 结构: { "<group>.png": { frames: { "<url>": [x,y,w,h] } } }
  const groups = await ev(`fetch('assets/atlases/index.json?cb=' + Date.now()).then(r => r.json()).then(j => {
    const out = {};
    for (const [file, v] of Object.entries(j)) out[file.replace(/\\.png$/, '')] = v && v.frames ? Object.keys(v.frames).length : 0;
    return out;
  }).catch(() => null)`);
  let groupsOk = !!groups;
  if (groupsOk) for (const g of EXPECT_GROUPS) if (!(groups[g] > 0)) groupsOk = false;
  ok(groupsOk, `atlas 组齐全(GROUPS 七组: ${groups ? EXPECT_GROUPS.map(g => `${g}=${groups[g] ?? 0}`).join(' ') : '索引不可读'})`);

  ok(stats.smallSingle.length === 0, `小图零单帧请求(sprites+icons 双覆盖;残留 ${stats.smallSingle.length})`);
  // 负例自检:构造含单帧 icon/sprite URL 的合成资源列表,断言同款过滤器能抓到
  const negSingle = await ev(`(() => {
    const fake = ['/assets/icons/ui/pause.png', '/assets/sprites/slime/slime_001_nobg.png'];
    return fake.filter(n => (n.includes('/sprites/') || n.includes('/icons/'))
      && !n.includes('/atlases/')
      && !n.includes('/sprites/player/') && !n.includes('/sprites/skillcall/')).length;
  })()`);
  ok(negSingle === 2, `单帧过滤器负例自检(合成回落列表应全数命中,得 ${negSingle}/2)`);

  if (booted) {
    // 敌人序列帧渲染(atlas 切帧正确性;与真实战场背景差分+单色椭圆检测)
    await ev(`window.__ssww.nav('playing'); window.__ssww.startLevel(1); 'ok'`);
    for (let i = 0; i < 100; i++) { if ((await ev(`window.__ssww.battle && window.__ssww.battle.phase`)) === 'FIGHTING') break; await sleep(100); }
    for (let i = 0; i < 60; i++) {
      const x = await ev(`(window.__ssww.battle && window.__ssww.battle.aliveEnemies()[0] || {}).x || 999`);
      if (x <= 620) break;
      await sleep(200);
    }
    await sleep(500);
    // 敌人序列帧渲染(atlas 切帧正确性)——三模式共用同一判定路径:
    // 每次都「移全部敌人出屏→两帧→截全屏背景基线 refSnap」,目标窗与参照窗取**同一坐标 (e.x,e.y)**:
    //   enemy       恢复敌人后实时采 vs 基线同坐标(真实贴图 → 差分高、兜底绿≈0)
    //   transparent 敌保持移出时实时采 vs 基线同坐标(实时画布该处=背景,等价「透明敌帧露背景」真实路径 → 差分≈0 FAIL)
    //   ellipse     离屏画布 putImageData(基线)+叠 #5fae5f 实心椭圆 vs 基线同坐标(差分高但兜底绿≈1 → FAIL)
    const PIX_FN = `async (mode) => {
      const cv = document.querySelector('canvas'); if (!cv) return { none: true, why: 'no canvas' };
      const ctx = cv.getContext('2d');
      const sx = cv.width / 720, sy = cv.height / 1280;
      const battle = window.__ssww && window.__ssww.battle;
      const enemies = battle && battle.aliveEnemies();
      if (!enemies || !enemies.length) return { none: true, why: 'no enemy' };
      const e = enemies[0];
      const saved = enemies.map(x => x.x);
      const raf2 = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      enemies.forEach(x => { x.x = 2000; });
      await raf2();
      const refSnap = ctx.getImageData(0, 0, cv.width, cv.height);
      let tgt = null;
      if (mode === 'transparent') {
        tgt = ctx.getImageData(0, 0, cv.width, cv.height); // 敌仍移出:实时画布该处=背景
      } else {
        enemies.forEach((x, j) => { x.x = saved[j]; });
        await raf2();
        if (mode === 'enemy') tgt = ctx.getImageData(0, 0, cv.width, cv.height);
        if (mode === 'ellipse') {
          const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
          const octx = off.getContext('2d');
          octx.putImageData(refSnap, 0, 0);
          octx.fillStyle = '#5fae5f'; // 兜底椭圆(覆盖整个采样窗,同 render.js 兜底色)
          octx.beginPath(); octx.ellipse(e.x * sx, e.y * sy, 62 * sx, 88 * sy, 0, 0, Math.PI * 2); octx.fill();
          tgt = octx.getImageData(0, 0, cv.width, cv.height);
        }
      }
      enemies.forEach((x, j) => { x.x = saved[j]; }); // 兜底恢复(幂等)
      // 同坐标窗口对比(tgt vs refSnap)
      const cx = e.x * sx, cy = e.y * sy;
      const grab = (d) => {
        const out = [];
        for (let dx = -13; dx <= 13; dx += 4) for (let dy = -19; dy <= 19; dy += 4) {
          const X = Math.round(cx + dx), Y = Math.round(cy + dy);
          const k = (Y * d.width + X) * 4;
          out.push([d.data[k], d.data[k + 1], d.data[k + 2]]);
        }
        return out;
      };
      const A = grab(tgt), B = grab(refSnap);
      const refKeys = B.map(([r, g2, b2]) => (r >> 4) + ',' + (g2 >> 4) + ',' + (b2 >> 4));
      let colored = 0, ellipse = 0, diff = 0; const seen = new Set();
      for (let i = 0; i < A.length; i++) {
        const [r, g2, b2] = A[i];
        if (!(r > 220 && g2 > 215)) colored++;
        if (r === 0x5f && g2 === 0xae && b2 === 0x5f) ellipse++;
        seen.add((r >> 4) + ',' + (g2 >> 4) + ',' + (b2 >> 4));
        if (((r >> 4) + ',' + (g2 >> 4) + ',' + (b2 >> 4)) !== refKeys[i]) diff++;
      }
      return { none: false, colored, total: A.length, distinct: seen.size, diffRatio: diff / A.length, ellipseRatio: ellipse / A.length };
    }`;
    let enemyPix = null;
    for (let i = 0; i < 3; i++) {
      enemyPix = await ev(`(${PIX_FN})('enemy')`);
      if (passPix(enemyPix)) break;
      await sleep(1000);
    }
    ok(passPix(enemyPix),
      `敌人序列帧渲染正常(atlas 切帧;${enemyPix && !enemyPix.none
        ? `彩色 ${enemyPix.colored}/${enemyPix.total} 档 ${enemyPix.distinct} 差分 ${(enemyPix.diffRatio * 100).toFixed(0)}% 兜底绿 ${(enemyPix.ellipseRatio * 100).toFixed(0)}%`
        : '未采样到敌人'})`);

    // 贴图源数据断言(第二层,直接对 atlas 帧区域采 alpha——不受血条/弹幕/背景干扰):
    // 全量帧逐帧画到离屏,统计不透明像素占比;任一帧全透明(坏帧/量化事故/涂改)→ 占比≈0 → FAIL
    const frameAlpha = await ev(`(async () => {
      const j = await (await fetch('assets/atlases/index.json?cb=' + Date.now())).json();
      const out = {};
      for (const [file, v] of Object.entries(j)) {
        const img = new Image(); img.src = 'assets/atlases/' + file + '?cb=' + Date.now();
        await img.decode();
        let minRatio = 1;
        const frames = Object.entries(v.frames); // 全量帧逐帧检查(抽前 3 帧会漏 87/108 帧——四轮审核实测反例 b_049)
        for (const [, [x, y, w, h]] of frames) {
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const cctx = cv.getContext('2d', { willReadFrequently: true });
          cctx.drawImage(img, x, y, w, h, 0, 0, w, h);
          const d = cctx.getImageData(0, 0, w, h).data;
          let opaque = 0, total = 0;
          for (let k = 3; k < d.length; k += 16) { total++; if (d[k] > 16) opaque++; }
          minRatio = Math.min(minRatio, opaque / Math.max(1, total));
        }
        out[file.replace(/\\.png$/, '')] = { frames: Object.keys(v.frames).length, minAlphaRatio: +minRatio.toFixed(3) };
      }
      return out;
    })()`);
    let alphaOk = !!frameAlpha;
    let alphaDetail = '';
    if (frameAlpha) {
      for (const g of EXPECT_GROUPS) {
        const f = frameAlpha[g];
        if (!f || f.frames <= 0) { alphaOk = false; alphaDetail += ` ${g}:无帧`; continue; }
        if (f.minAlphaRatio < 0.05) { alphaOk = false; alphaDetail += ` ${g}:透明${f.minAlphaRatio}`; }
      }
      alphaDetail = alphaDetail || EXPECT_GROUPS.map(g => `${g}=${frameAlpha[g] ? frameAlpha[g].minAlphaRatio : '?'}`).join(' ');
    }
    ok(alphaOk, `atlas 帧数据非全透明(全量帧 alpha 占比;${frameAlpha ? alphaDetail : '索引不可读'})`);

    // 负例 a:透明敌帧等价路径(敌移出时实时采=背景 vs 基线同坐标)→ 差分≈0 应 FAIL
    // (UIV2 -06 F3 整改:采样无效[空/none]时记 FAIL,不得因取反判 null 恒真而记 PASS;
    //  有效采样须先断言非空,再记录差分率/兜底色比例。alpha 全帧检查耗时可能跨越敌人存活期,
    //  采样前重建敌人存活态——否则 PIX_FN 返回 {none:true,'no enemy'},负例从未真正执行)
    const reArm = await ev(`(() => { const w = window.__ssww; if (!w || !w.battle) return -1;
      const b = w.battle; b.phase = 'FIGHTING';
      b.enemies.forEach(e => { e.alive = true; e.deathT = 0; });
      return b.enemies.filter(e => e.alive).length; })()`);
    await sleep(600);
    const negBg = await ev(`(${PIX_FN})('transparent')`);
    const negBgValid = !!negBg && !negBg.none && typeof negBg.diffRatio === 'number';
    ok(negBgValid && !passPix(negBg) && negBg.diffRatio < 0.1,
      `透明敌帧负例自检(采样有效[${reArm} 敌存活]且差分<10% 应 FAIL;${negBgValid ? `差分 ${(negBg.diffRatio * 100).toFixed(0)}%` : '采样无效(' + (negBg && negBg.why || '空') + ')→FAIL'})`);

    // 负例 b:背景基线上叠兜底绿椭圆(离屏=putImageData(基线)+椭圆,参照=基线同坐标)→ 兜底绿≈1 应 FAIL
    const negEllipse = await ev(`(${PIX_FN})('ellipse')`);
    const negElValid = !!negEllipse && !negEllipse.none && typeof negEllipse.ellipseRatio === 'number';
    ok(negElValid && !passPix(negEllipse) && negEllipse.ellipseRatio > 0.6,
      `兜底椭圆负例自检(采样有效且兜底绿>60% 应 FAIL;${negElValid ? `兜底绿 ${(negEllipse.ellipseRatio * 100).toFixed(0)}%` : '采样无效(' + (negEllipse && negEllipse.why || '空') + ')→FAIL'})`);
  }
} catch (e) {
  console.log(`FAIL  执行异常(${e.message})`);
  fails.push(e.message);
} finally {
  const c = await cleanup();
  if (!c.ok) { console.log(`FAIL  自有 target 清理失败(${c.detail})`); fails.push(`target 清理失败(${c.detail})`); }
  finish(); // 统一收口:RESULT 与退出码唯一产生处
}
