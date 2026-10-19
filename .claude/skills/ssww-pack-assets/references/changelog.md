## v0.1.1 (2026-10-19)

- verify_atlas 负例判定整改(UIV2 链 REQ-SSWW-UIV2-v0.1-06/07/08 审核发现):透明敌帧与兜底椭圆两负例原先用 `!passPix(x)` 判定,采样为 null/none 时取反恒真→假 PASS(实测两负例返回 {none:'no enemy'},从未真正执行)。改为采样有效性前置断言(非空+指标存在),无效采样记 FAIL 并输出原因;负例采样前重建敌人存活态(alpha 全帧检查耗时可能跨越敌人存活期)。重采负例:透明差分 0%、兜底绿 100%,均被正确拒绝。

# ssww-pack-assets 变更历史

## v0.1.0 (2026-10-19, 整改轮 08)

- 七轮审核 REQ-SSWW-PACKASSETS-v0.1.0-07 REJECTED，仅一项 P2：SKILL.md 步骤 4 残留旧句「每组抽帧采 alpha，透明/坏帧必 FAIL」未删（上轮 replace 目标失配静默未生效）。本轮删除残留并合并为单一表述;脚本与其余三文件无变化(代码整改六轮已通过)。

## v0.1.0 (2026-10-19, 整改轮 07)

- 六轮审核 REQ-SSWW-PACKASSETS-v0.1.0-06 REJECTED，三 P2 整改：
  - ws 关闭确认覆盖所有入口状态：OPEN→主动 close 等 onclose；复核期间已 CLOSING→补等落地窗口；最终非 CLOSED 一律记失败（原只在 OPEN 入口检查，CLOSING 入口跳过整个关闭段返回成功）。
  - tests 证据恢复并扩展输入身份：tests/ 全部 16 文件逐一列出 SHA（上轮误删只留文件名）。
  - SKILL.md 措辞矛盾修正：统一「全量帧逐帧 alpha」，并如实标注 alpha 检查只覆盖透明类故障、不覆盖内容错误（撤「透明/坏帧必 FAIL」过强表述）。

## v0.1.0 (2026-10-19, 整改轮 06)

- 五轮审核 REQ-SSWW-PACKASSETS-v0.1.0-05 REJECTED，两 P2 整改：
  - cleanup 幂等与关闭等待：重复调用改为复用首次清理 Promise（原 closed 标志直接报成功、未等待原清理完成）；ws 关闭等待超时后检查 readyState，非 CLOSED 记失败（原超时分支静默按成功返回）。
  - 全局超时写入失败状态：hardTimer/正常收尾统一走 finish() 收口（finished 标志防重复；timedOut 计入 fails）——超时后不可能再输出 RESULT=PASS/exit 0（原 FAIL 后仍可被正常收尾覆盖为 PASS exit 0）。

## v0.1.0 (2026-10-19, 整改轮 05)

- 四轮审核 REQ-SSWW-PACKASSETS-v0.1.0-04 REJECTED，四项整改：
  - P1 退出码污染**真修**（撤掉「RESULT= 行放行退出码 127」的放宽口径）：最小复现矩阵定位根因=页面 rAF 主循环活跃时带着未关闭的 undici WebSocket 退出；修复=cleanup 所有 return 路径先 ws.close() 并 await onclose 落地（四轮审核离线复算抓到的正是「验证成功提前 return 跳过 ws 关闭」）；修复后完整跑 exit=0 无断言，/json/list 复核的 r.json() 也补 Promise.race 超时。
  - P2 帧抽检改全量帧（前 3 帧只覆盖 21/108，四轮反例 boss 第 4 帧 b_049 漏检）。
  - P2 证据补渲染输入身份（main/render/parallax/layout/loader/manifest SHA）与四条注入的完整可复跑命令（含恢复步骤与前后 SHA）。

## v0.1.0 (2026-10-19, 整改轮 04)

- 三轮审核 REQ-SSWW-PACKASSETS-v0.1.0-03 REJECTED，四项整改：
  - verify_atlas：差分参照改**同坐标基线**（三审反例：不同位置背景不同，透明帧仍得 98.6% 差分）；新增**贴图源数据断言**（每组抽前 3 帧直接对 atlas 区域采 alpha，非透明占比 ≥0.05——渲染差分受血条/弹幕干扰，透明敌帧注入实测差分仍达 30%，只有帧数据层可靠抓透明帧）；透明帧负例改走真实判定路径（敌移出时实时采=背景 vs 基线同坐标，差分 0%）；cleanup 记账（closeTarget 超时/success:false/连接断开均 FAIL）+ 不经 CDP 的 /json/list 独立复核（重试 3 次）。
  - 实测记录 Node 24.11.1 退出码污染坑（libuv assertion 改写退出码为 127，--trace-exit 证实 reallyExit 已成功执行），判定口径改为输出末行 RESULT= 行，SKILL.md/pitfalls 同步。
  - 行为证据补齐：正例身份头（node/Edge UA/dev-server/工具/loader SHA）、透明敌帧**真实渲染路径注入**（slime.png 涂透明→帧数据断言 FAIL→SHA 绑定恢复）、重复运行 8932 页面数 0→0 零积累、停服 boot FAIL。

## v0.1.0 (2026-10-18, 整改轮 03)

- 二轮审核 REQ-SSWW-PACKASSETS-v0.1.0-02 REJECTED，四项整改：
  - verify_atlas：敌人渲染断言改为与真实战场背景差分（移敌采基线→成对采样）+精确 #5fae5f 兜底绿占比检测——背景参照区（对应透明敌帧）与背景上叠椭圆两负例均判 FAIL；连接与全部 CDP 调用统一有界超时（fetch AbortController/send 内 deadline），从创建 target 起全路径清理，硬超时先关 target 再退出。
  - SKILL.md：流程顺序改为**先打包后量化**（打包产物是未量化 RGBA，会覆盖量化产物；实测 8.46MB vs 1.7MB），量化后核对模式/尺寸/字节数/截图。
  - pitfalls.md：补流程顺序节与差分判定口径。

## v0.1.0 (2026-10-18, 整改轮 02)

- 首轮审核 REQ-SSWW-PACKASSETS-v0.1.0-01 REJECTED，四项整改：
  - verify_atlas：单帧断言扩为 sprites+icons 双覆盖；atlas 组按 GROUPS 期望集合核对（七组齐全+帧数）；敌人渲染改颜色档数断言并内置椭圆/空帧负例自检；连接与 CDP 调用加界超时+全局 300s 兜底；异常路径关闭自建 target。
  - SKILL.md：量化说明对齐 TARGETS 实际清单，移除不存在的排除清单机制，修正「视觉无损」表述，补量化不可逆与备份口径。
  - pitfalls.md：补验证脚本覆盖范围、颜色档判定、循环变量遮蔽崩 boot 三条实测坑。

## v0.1.0 (2026-10-18)

- 首版：固化 M14 批次的雪碧图打包（tools/pack_atlas.py）+ PNG 量化（tools/quantize_png.py）+ CDP 冒烟验证（scripts/verify_atlas.mjs）三步流程；记录大图豁免与 atlas 高度上限口径。
