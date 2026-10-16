# 线稿截图清单（视觉证据绑定）

截图由无头 Edge（`--headless --disable-gpu --no-sandbox`，独立 user-data-dir，窗口尺寸见下表）于 2026-10-16 从对应 HTML 候选渲染生成。布局回归截图使用页面自带 `#fit=WxH` 锚点（各页底部脚本 + wireframe.css `.preview-mode` 规则）：body padding 归零、只保留第一个 .phone、隐藏侧边说明，按 scale=min(W/720,H/1280) **单次**等比缩放（min 视口 0.5、max 视口 2.0），无 iframe 二次缩放。

| 截图 | 源与参数 | 截图 SHA-256 |
|---|---|---|
| 01-start.png | 01-start.html，窗口 1600×1500 | `66824743f74136d596153d7bd0bdef5a54b29abebdd0943556a9312b604e608f` |
| 02-level-select.png | 02-level-select.html，窗口 1600×1500 | `024d0202cfc35388c6bd71a930f46aaa4178ddab9e6bb1ef67d874d5aa88e3ac` |
| 03-loadout.png | 03-loadout.html，窗口 1600×1500 | `df62a97e5ba2c572d316164655ca50dd5d76a0f25ac331226155d5da027ede50` |
| 04-battle.png | 04-battle.html，窗口 1600×1500 | `0614828d2afb5292ddb2a7f2afc945f62284740f5bed35677a2181806b180ea7` |
| 05-result.png | 05-result.html，窗口 1600×1500 | `6c3a79d6d0294e251254c35edd56db4ec2a4fd24b76ac0ebbb081c58ecefde36` |
| 04-battle-min-360x640.png | 04-battle.html#fit=360x640（scale 0.5），窗口 360×640 | `65fcbfd105b02f4c03c560748ab4a84a61bd503fbc65bbd1a410e82a79081d7b` |
| 04-battle-max-1440x2560.png | 04-battle.html#fit=1440x2560（scale 2.0），窗口 1440×2560 | `2154f30a119301ca2192eb5168c7e05bc20cc43e51da0e2ed4927ffc2844db1e` |

fit 模式已核验：min 图底栏（视口 y612~640）与棋盘右缘完整可见；max 图全视口渲染。DPR=1（headless 默认）。

渲染输入绑定：wireframe.css `49b3676e8e6e8d1f4c79e9826e718a18f254cd4d4cee553549074427dd827815`、preview.html `a3c9f8644168cf3e90e2878b99d3ad6e79db312999cb5a76de155336793db05e`（用法说明页，不参与渲染）；五个线稿页 SHA 见送审 request 候选清单；源文件变更后截图须重摄并以 SHA 复核确认更新（写盘有时延，SHA 须在文件稳定后复算）。

布局回归说明：`#fit` 模式对应 TDD 第 17 条最小/最大视口检查的**线稿级**证据（正式回归对象是 M5 游戏实现）。
