# ssww-create-skill 更新历史

## 0.1.5（2026-10-19）

- 自进化（REQ-SSWW-PACKASSETS-v0.1.0 链 8 轮收口后回顾），`references/pitfalls.md` 追加三条：
  1. 调用器产物 append-only：同 REQUEST_ID 产物文件已存在时 `invoke_ssww_review.py` 拒发，必须换新 REQUEST_ID 重跑 identity。
  2. request 文件不可复用改写：每轮 request 以当轮新 REQ_ID 命名、一次写就，改写旧文件会被判「不再作为原始请求凭据」。
  3. 复用历史行为证据前先核对运行输入身份：日志头绑定的运行时文件 SHA 有漂移即被驳回，须以当前运行时重采、旧日志保留。
- 本轮仅改 `references/pitfalls.md` 与本 changelog，SKILL.md 与门禁脚本未动。

## 0.1.4（2026-10-16）

- 按 REQ-SSWW-CREATESKILL-v0.1.0-06 审核（RULING=REJECTED，一 P2）整改，门禁脚本 `ssww-skill-gate.sh`：
  1. [P2] identity 失败状态传播闭环：`identity_list` 弃用 mapfile 进程替换（管道失败被吞），改为临时文件承载枚举结果并显式检查 find|sort 管道与逐文件 sha256sum 的退出状态；快照/锚定的哈希命令先入变量并校验摘要格式（sha256 64 位、blob 40 位），再落盘——printf 的成功不再代替哈希命令的成功；新增 `cleanup_partial`：任一步失败统一清理冻结目录、清单与本轮可能已写的部分三件套后以非 0 退出，不输出"门禁3 通过"。
  2. [测试] 新增 identity 公开入口用例 4 组：正常生成（三件套齐全 + 独立 BLOB_ANCHOR 行）、目录枚举失败（icacls /deny Everyone:(RD) 注入 → "候选清单生成失败"）、冻结失败（cp shim 注入 → "候选冻结失败"）、blob 计算失败（git shim 注入 hash-object 失败 → "锚定哈希计算失败"），三个负例均断言无三件套残留，枚举失败用例另断言注入后访问恢复。harness 21→30 项（PASS=29 FAIL=0 SKIP=1，总退出码 0）。
  3. [测试环境] `find_git_bash` 优先 `usr/bin/bash.exe`：`bin/bash.exe` 是登录包装器、会重置 PATH，导致 shim 注入静默失效（本轮实测教训，已写入函数文档）。
  4. [测试环境] icacls 注入改用 `(RD)`（只拒数据读）：此前 `(RX)`/`(R)` 连 READ_CONTROL 一起拒绝，导致 icacls /reset 自身被拒、deny ACE 残留污染后续场景；枚举失败场景补访问恢复探针。
- 绑定日志：`.tmp/codex-rulings/test-logs/REQ-SSWW-CREATESKILL-v0.1.0-07.gate-verify.log`（头部含五个候选文件 SHA-256，与本轮候选一致）。


## 0.1.3（2026-10-16）

- 按 REQ-SSWW-CREATESKILL-v0.1.0-05 审核（RULING=REJECTED，一 P1 + 三 P2）整改，门禁脚本 `ssww-skill-gate.sh`：
  1. [P1] 恢复清单读取失败 fail-closed：`plain_copy_matches_candidate` 对清单生成与哈希计算两个管道显式检查退出状态（pipefail 传播），任何失败（含镜像中不可读文件）返回拒绝，绝不"读取失败后输出恰好一致"地进入删除；harness 新增"读取失败拒绝恢复"场景（icacls /deny Everyone:(R) 注入不可读文件，实测拒绝且文件完整保留——按字节数断言）。
  2. [P2] identity 输出独立可复制行：`BLOB_ANCHOR_SHA256=<值>` 单独成行（去除前后装饰），可整行原样粘贴进 request；SKILL.md 同步措辞，并明确**续审/恢复轮同样必须先重新 identity 再绑定**（上轮 TRANSPORT_FAILED 恢复时复用 -04 锚定属流程失误，已更正）。
  3. [P2] SHA 快照与 blob 锚定同源生成：identity 先把候选按清单冻结到临时目录，快照与锚定都从同一组冻结字节计算，消除两次读取工作区之间的漂移窗口；冻结/计算任一步失败即中止（不产生部分锚定）。
  4. [P2] 测试更正与补强：场景 13 注释更正为"验证索引 blob 与锚定不符时由最终索引身份检查拒绝"（不再声称覆盖改写窗口）；场景 15 恢复负例补用户文件存在性与逐字节内容断言；harness 18→21 项（PASS=20 FAIL=0 SKIP=1，总退出码 0）。
- 绑定日志：`.tmp/codex-rulings/test-logs/REQ-SSWW-CREATESKILL-v0.1.0-06.gate-verify.log`（头部含五个候选文件 SHA-256，与本轮候选一致）。


## 0.1.2（2026-10-16）

- 按 REQ-SSWW-CREATESKILL-v0.1.0-03 审核（RULING=REJECTED，两 P1 + 两 P2）整改，门禁脚本 `ssww-skill-gate.sh`：
  1. [P1] 锚定升级三件套并绑定审核身份：新增 `<REQ_ID>.candidate.blob.sha256`（锚定文件自身的 SHA-256），request 必须以 `BLOB_ANCHOR_SHA256=` 声明同一值，review-gate/commit 消费时复算比对——替换锚定中的 blob 值即绑定哈希不符被拒；identity 输出该值提示原样写入；blob 锚定与 SHA 快照在同一 identity 运行中从同一组候选内容生成。
  2. [P1] 镜像恢复安全化：全量文件清单比对（不再排除 .tmp/__pycache__/*.pyc——镜像中任何多出/差异文件一律拒绝自动覆盖，杜绝 rm -rf 误删用户数据）；类型查询改哨兵格式（`OK|<LinkType>`），查询失败与普通目录严格区分，查询失败拒绝恢复。
  3. [P2] 锚定格式改 `<blob>  <完整路径>` 双空格分隔，含空格资源名不截断（harness 新增"含空格资源名交付"正例）。
  4. [P2] 测试补齐改写窗口与恢复分支：新增"锚定替换拒绝"（绑定哈希拦截）、"索引身份拒绝"（锚定连同绑定哈希一起注入错误值、SHA 检查全自洽通过后由最终索引身份检查拒绝，覆盖 SHA 检查通过后/暂存前改写窗口）、"普通目录镜像恢复"（正例+重建标记断言）、"恢复拒绝差异文件"（负例，用户文件不被删除）四场景；harness 12→18 项（PASS=17 FAIL=0 SKIP=1，总退出码 0）。
  5. [文档] SKILL.md 同步三件套、BLOB_ANCHOR_SHA256、恢复安全化表述。
- 绑定日志：`.tmp/codex-rulings/test-logs/REQ-SSWW-CREATESKILL-v0.1.0-04.gate-verify.log`（头部含五个候选文件 SHA-256，与本轮候选一致）。


## 0.1.1（2026-10-16）

- 按 REQ-SSWW-CREATESKILL-v0.1.0-01 审核（RULING=REJECTED，一 P1 + 四 P2）整改，门禁脚本 `ssww-skill-gate.sh`：
  1. [P1] 提交集改绑已审核身份：identity 门禁在 SHA 快照旁新增 git blob 索引锚定（`<REQ_ID>.candidate.blob`，`git hash-object --path` 走 clean 过滤，与 git add 产物一致）；commit 门禁以锚定 blob 为唯一基准核对暂存树（正向：路径+blob 全等，反向：锚定文件 ×2 镜像必须齐），不再以当前工作区作基准——快照检查后改写内容/新增路径一律拒绝；review-gate 补锚定与快照的文件集合闭合检查。
  2. [P2] 提交信息 scope 必填：正则去掉 `(scope)` 可选，缺失/空 scope 拒绝；selftest 扩为提交信息八例（新增两条 scope 负例）。
  3. [P2] junction 恢复流程：link 门禁自动创建镜像父目录；已存在的普通目录镜像（git 新检出形态）在 LinkType 为空且内容与候选逐字节一致时自动重建 junction，有差异即拒绝自动覆盖。
  4. [P2] 中文路径：夹带检查与暂存树解析全部改 `-z` NUL 分隔 + `core.quotepath=off`，中文文件名不再被八进制转义误判；harness 新增"中文文件名交付"正例。
  5. [P2] harness 符号链接夹具用后即清（有权限分支），不再污染后续场景；新增"快照后改写拒绝"负例；harness 场景 9→11 项。
  6. [文档] SKILL.md 总纲表述修正（"脚本检查可机械验证的项目，人工确认用法和结构"）；identity 用法帮助与实现的必填 REQ_ID 统一；双锚定/恢复流程/scope 必填写入 SKILL.md 与 pitfalls。


## 0.1.0（2026-10-16）

- 首版。自 poe2-logic `poe2-create-skill` v0.1.14 改编：
  - 保留五道门禁（doc-gate/link/identity/review-gate/commit）与 fail-closed 纪律；
  - 门禁脚本改名 `ssww-skill-gate.sh`，审核链从 `poe2-review-ruling` 换为 `ssww-review-ruling`（调用器 `invoke_ssww_review.py`）；
  - 标准引用沿用 `docs/standards/审核裁决协议.md` 与 `TDD_Standard.md`（本项目已同步适配创建）；
  - 代理说明沿用本机 `http://127.0.0.1:1080`；
  - SKILL.md 补充工作区前置条件一节（AGENTS.md、标准文档、git 仓库）。
- 已知限制：本 skill 为引导技能（bootstrap），其自身未经 codex 审核即先行存在；后续与 `ssww-review-ruling` 一起送审补足。poe2-logic 上游的 tests/ 测试套件（test_invocation.py 等 30 例）未随迁，验证依赖 `scripts/verify_commit_paths.py` 隔离仓库 harness 与门禁 selftest。
