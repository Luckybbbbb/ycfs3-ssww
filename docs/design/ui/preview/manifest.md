# 线稿截图清单（视觉证据绑定）

截图由无头 Edge（`--headless --disable-gpu --no-sandbox`，独立 user-data-dir，窗口尺寸见下表）于 2026-10-16 从对应 HTML 候选渲染生成。布局回归截图使用页面自带 `#fit=WxH` 锚点（各页底部脚本 + wireframe.css `.preview-mode` 规则）：body padding 归零、只保留第一个 .phone、隐藏侧边说明，按 scale=min(W/720,H/1280) **单次**等比缩放（min 视口 0.5、max 视口 2.0），无 iframe 二次缩放。

| 截图 | 源与参数 | 截图 SHA-256 |
|---|---|---|
| 01-start.png | 01-start.html，窗口 1600×1500 | `66824743f74136d596153d7bd0bdef5a54b29abebdd0943556a9312b604e608f` |
| 02-level-select.png | 02-level-select.html，窗口 1600×1500 | `024d0202cfc35388c6bd71a930f46aaa4178ddab9e6bb1ef67d874d5aa88e3ac` |
| 03-loadout.png | 03-loadout.html，窗口 1600×1500 | `37ae9d7fa2c57da7149b6a69bea8bc5a94ee40c94475baab26953f8112d0bbb6` |
| 04-battle.png | 04-battle.html，窗口 1600×1500 | `0614828d2afb5292ddb2a7f2afc945f62284740f5bed35677a2181806b180ea7` |
| 05-result.png | 05-result.html，窗口 1600×1500 | `3cc5b2b6430e76657db3f73b2ec1fa11900fe11fab3acf092cb65ce4ce275143` |
| 04-battle-min-360x640.png | 04-battle.html#fit=360x640（scale 0.5），窗口 360×640 | `c7596f2b20a32e3cf79c5b5ff72d8f35a1d7acfed3b44a6aaa4e3481e16dad6d` |
| 04-battle-max-1440x2560.png | 04-battle.html?v=max#fit=1440x2560（scale 2.0，URL 加 cache-bust 强制完整加载，规避同文档 fragment 导航不重新执行 fit 脚本），CDP 视口 1440×2560，DPR=1，phone/inner 实测 getBoundingClientRect=[0,0,1440,2560]、transform=translateX(-50%) scale(2)；棋盘 1440×1440，底栏 y2448~2560，棋子 148px | `2154f30a119301ca2192eb5168c7e05bc20cc43e51da0e2ed4927ffc2844db1e` |

fit 模式已核验（REQ-05 整改后重摄，CDP setDeviceMetricsOverride mobile:false 精确 360×640/1440×2560，规避 Edge 最小窗宽 clamp——此前 --window-size=360 被抬升致 66px 偏移与右列裁切）：min 图左缘 x=0 即棋盘底色（无偏移）、8 列棋子与底栏（视口 y612~640）完整、右缘 x=359 在画布内；max 图全视口渲染。DPR=1。主图（01~05）为窗口 1600×1500 正常浏览模式整页（含全部状态卡与说明栏）。

渲染输入绑定：wireframe.css `49b3676e8e6e8d1f4c79e9826e718a18f254cd4d4cee553549074427dd827815`、preview.html `a3c9f8644168cf3e90e2878b99d3ad6e79db312999cb5a76de155336793db05e`（用法说明页，不参与渲染）；五个线稿页 SHA 见送审 request 候选清单；源文件变更后截图须重摄并以 SHA 复核确认更新（写盘有时延，SHA 须在文件稳定后复算）。

布局回归说明：`#fit` 模式对应 TDD 第 17 条最小/最大视口检查的**线稿级**证据（正式回归对象是 M5 游戏实现）。
