---
name: ssww-pack-assets
description: ycfs3-ssww 资源打包与体积优化流程。触发词：新增图素、素材打包、雪碧图、atlas、PNG 量化、进站体积、资源加载优化。新增或更换 assets 下素材后、或需要压缩首次进站体积时使用。
metadata:
  version: 0.1.0
---

# ycfs3-ssww 资源打包与体积优化

## 定位

把「新增/更换素材」到「线上进站体积达标」固化为可重复流程。核心事实：渲染层加载器优先读 atlas 索引(仓库 assets 目录下 `atlases/index.json`)把小图打包成 atlas 切帧使用（key 与逐帧一致），索引缺失的帧自动回落逐帧加载——所以**打包是优化而非正确性依赖**，漏跑不报错，只是进站变慢。

## 何时执行

1. 新增或更换了 sprites、icons 等 assets 子目录下的**小图**（序列帧、图标）。
2. 新增或更换了**大图**（立绘/背景/喊话图，`GROUPS` 清单外）——只需量化，不需重打包。
3. 首次进站总体积（对仓库 assets 目录逐项 `du -sk` 合计）超过 ~10MB 时做一轮体检。

## 流程（按序执行，每步可验证；顺序有依赖——先打包后量化）

1. **重打包 atlas**：`python tools/pack_atlas.py`——按脚本内 `GROUPS` 清单把小图目录装箱为 ≤2048 宽的 atlas 并重建 atlas 索引(assets 目录下 `atlases/index.json`)。**新增小图目录时要编辑 GROUPS**（脚本头注释有大图豁免清单）。完成后核对 stdout 的帧数与尺寸。**打包产物是未量化的 RGBA**——必须接着跑第 2 步，否则 atlas 体积翻数倍。
2. **量化**：`python tools/quantize_png.py`——对脚本内 `TARGETS` 固定清单（主角立绘、skillcall、战斗背景、**atlas 产物**四个目录）中 >80KB 的 PNG 做 256 色 FASTOCTREE 量化，**原地覆盖、不可逆**。打包后必须重跑本步让 atlas 产物继承量化收益。完成后逐张核对最终产物：模式 P（≤256 色）、宽 ≤2048、atlas 总高 ≤16384、字节数与上次比无异常膨胀，并目检一张截图确认观感可接受；体积收益以本次运行结果为准。新素材若尚未提交 git，量化前先把原图复制到 `.tmp/` 备份（或保留生图来源），否则无法还原。AI 生图素材这一步必做。
3. **全量单测**：`node --test tests/*.test.mjs` 必须 0 fail（loader 有逐帧/atlas 双路径与 DOM 守卫的回归）。
4. **CDP 冒烟**：`node <本skill目录>/scripts/verify_atlas.mjs`（skill 自带验证脚本）——断言 index.json 加载、GROUPS 组齐全、小图零单帧请求（sprites 与 icons 双覆盖）、敌人序列帧渲染正常（与真实战场背景差分+兜底绿检测，负例自检=透明帧等价路径与兜底绿椭圆）、atlas 全量帧逐帧 alpha 检查（帧数据层专抓整帧透明——渲染差分层会被血条/弹幕干扰；alpha 检查只覆盖透明类故障，不覆盖内容错误）。断言任一 FAIL → 退出码 1，禁止带病提交。
5. **提交**：新素材+atlas 产物目录（assets 下 `atlases/` 整目录）+改动脚本一并入库；提交信息 `<type>(<scope>): <中文动宾>`。

## 红线与口径

- **大图永不打包**：`player`（720×1280 全屏帧）、`skillcall`、`backgrounds` 合并无收益，`GROUPS` 不得加入。
- **atlas 尺寸上限**：宽 2048；**总高不得超过 16384**（浏览器 canvas 纹理上限，超出 drawImage 静默失败）。分片超限组。
- **量化边界**：仅处理 `TARGETS` 清单四个目录、仅 >80KB 文件；脚本没有排除清单机制——某张图不适合量化（带 alpha 渐变出现色带断裂）就不要让它进 TARGETS 覆盖范围，从原图重新出图替换。
- **`.tmp/` 永不提交**；验证脚本产生的截图留在 `.tmp/`。

## 自进化流程（每次使用后执行）

1. 装箱/量化脚本是否报错或产物异常（超尺寸、体积不降反升）？有则把根因与修法补进 `references/pitfalls.md`。
2. verify_atlas 断言是否漏检（如新增资源目录未入 GROUPS 导致静默逐帧）？有则补断言。
3. 本 SKILL.md 是否存在「必然/一律」类过强表述？有则弱化为实测口径。
4. 有更新 → 改文件 + `references/changelog.md` 追加条目 + 走 `ssww-create-skill` 提交门禁；无更新 → 明确回复「已检查，本次无需更新」。

## 细节索引

- 装箱算法/豁免清单/已知坑：`references/pitfalls.md`
- 本 skill 变更历史：`references/changelog.md`
