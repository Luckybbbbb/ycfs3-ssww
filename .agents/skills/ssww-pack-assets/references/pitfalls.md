# ssww-pack-assets 实战坑清单

## 装箱与尺寸

- **atlas 总高 >16384 静默失败**：浏览器 canvas 纹理上限，drawImage 不报错但贴图空白。首版 player 组（720×1280 帧 ×25）曾打出 2048×16640。对策：大图豁免清单在 `tools/pack_atlas.py` 的 `GROUPS` 注释，新增大图目录不要加入。
- **量化后 atlas 重新打包**：先量化源帧再打包（atlas 直接量化也可以，但源帧量化能让后续重打包继承收益）。
- **PNG 模式校验**：量化产物应为 P 模式且色数 ≤256；`PIL Image.open(f).mode` 快速核对。

## loader 双路径

- `assets/atlases/index.json` 缺失/损坏 → loader 自动回落逐帧（不报错）——这意味**漏跑打包不会被发现**，必须靠 verify_atlas.mjs 的「小图零单帧请求」断言兜住。
- 新增素材目录未加入 GROUPS → 该目录帧走逐帧 → 同上，verify_atlas 只断言已登记目录；新增目录后要人工确认 GROUPS 已更新（未来可在 verify 脚本加「目录覆盖率」断言）。
- dataURL 切帧的 Image 是异步解码：批量切帧后必须等 `complete`/onload 才能进渲染（loader 已守卫）。

## 验证脚本

- verify_atlas.mjs 依赖 Edge 9225 + dev-server 8932（启动方式见项目根 CHANGELOG 环境坑节）；连接（AbortController）与全部 CDP 调用（send 内 deadline）有界超时，全局 300s 硬超时先有界关闭 target 再退出。
- 单帧请求断言覆盖 sprites 与 icons 两个目录族，排除有意单帧的大图目录（player/skillcall），口径与 GROUPS 豁免清单同步维护；icons 目录漏加 GROUPS 时靠此断言抓回落。
- 敌人渲染断言是**双层判定**：①渲染差分层——移全部敌人出屏采背景基线,恢复后目标窗 vs 基线**同坐标**对比(彩色占比+档数+差分 ≥0.25+精确 #5fae5f 兜底绿 <0.6;参照窗必须与目标窗同坐标,不同位置背景不同会误判——二轮审核实测反例);②贴图源数据层——**全量帧**逐帧直接对 atlas 区域采 alpha,非透明占比 ≥0.05(渲染差分会受血条/敌方弹幕干扰,透明敌帧注入实测差分仍达 30%;抽前 3 帧只覆盖 21/108,四轮审核反例 boss 第 4 帧 b_049 漏检——必须全量)。负例自检:透明帧等价路径(敌移出时实时采=背景,真实判定路径差分 0%)+基线上叠兜底绿椭圆两条。
- verify 脚本从创建 target 起全路径清理（try/finally + 硬超时回调内也有界关闭），重复运行不积累页面。
- bindImages 内新加循环时避免用 `n` 作循环变量——它是绑定计数器，`const n of ...` 遮蔽后 `n++` 抛 TypeError，boot 即崩（M14 实测：页面黑屏、__ssww 不暴露、所有 CDP 断言 boot FAIL）。
- **退出码污染（Node 24.11.1 实测,已修复）**：页面 rAF 主循环活跃时若带着未关闭的 undici WebSocket 退出,触发 libuv「Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)」把退出码改写为 127(最小复现:页面 boot 完成并跑起游戏主循环后 closeTarget 直接退出即崩;页面未 boot 完成时不崩)。对策:cleanup 里**所有 return 路径都必须先 `ws.close()` 并 await onclose 落地**再返回——警惕「验证成功即提前 return 跳过 ws 关闭」的控制流(四轮审核离线复算抓到:ok:true 但 WebSocket 关闭调用数为 0)。修复后完整跑 exit=0 无断言。

## 流程顺序

- **先打包后量化，顺序不可反**：pack_atlas 从源帧重生成未量化 RGBA atlas，会覆盖上一次的量化产物；quantize_png 的 TARGETS 含 atlas 产物目录，打包后必须重跑量化。漏跑的实测代价：7 张 atlas RGBA 8.46MB vs 量化后 1.7MB（约 5 倍）。
