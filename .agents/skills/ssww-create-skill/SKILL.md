---
name: ssww-create-skill
description: 本 skill 用于在 ycfs3-ssww 工程（竖屏三消+自动战斗 Godot 项目）创建新项目 skill 并走完交付全链。当用户要求"创建项目 skill"、"封装一个 skill"、"新建 ssww-xxx skill"、"把本次流程沉淀成 skill"、"做一个项目级 skill"时使用。覆盖门禁驱动的六阶段交付:规范加载→结构规划→编写(必含自进化)→文档门禁→软链门禁→codex 审核门禁(RESUBMIT 循环)→git 提交门禁,所有可程序化检查点由 scripts/ssww-skill-gate.sh 强制执行(fail-closed,禁止跳门禁)。
metadata:
  version: 0.1.4
---

# ycfs3-ssww 项目 Skill 创建（ssww-create-skill）

> 本 skill 把"创建项目 skill"固化为**门禁驱动**的稳定流程：每个可程序化的检查点都是脚本门禁，`exit 0` 才能进入下一阶段，禁止跳过。
> 文档写作规范以本节第 1 阶段所列为准（本工程无外部 plugin-dev 规范，本 skill 即权威）。

## 0. 一句话总纲

**真身落 `.claude/skills/` → 文档门禁 → junction 软链门禁（镜像到 `.agents/skills/`）→ codex 审核门禁（不过审循环整改）→ 提交门禁（内嵌过审复验）。脚本门禁检查可机械验证的项目，人工确认用法和结构，机器做全部机械检查。**

## 1. 权威规范（阶段 0，必读）

创建任何项目 skill 必须遵守：

- SKILL.md 必带 YAML frontmatter：`name`（与目录同名）、`description`（第三人称 + 具体触发词，≥20 字符）、`metadata.version`。**缺 frontmatter 是 codex 审核必拒项。**
- 正文祈使语气、1,500–2,000 字、渐进披露（细节进 `references/`）。
- 结构：`SKILL.md` + 可选 `references/`、`scripts/`、`assets/`；创建不需要的目录不要建。
- SKILL.md 禁止本机绝对路径（doc-gate 拦截带盘符的路径），一律以工作区根为基准的相对路径。
- 审核类 skill 的输出格式、只读边界、会话策略必须与 `docs/standards/审核裁决协议.md` 一致。

## 2. 六阶段流程（阶段 N 完成后必须过门禁 N；以下命令均自工作区根执行）

```bash
GATE=".claude/skills/ssww-create-skill/scripts/ssww-skill-gate.sh"
```

| 阶段 | 工作 | 门禁（必须 exit 0） |
|---|---|---|
| 1 用法澄清 | 触发词、与既有 skill 的边界分工 | （人工判断） |
| 2 结构规划 | 分析可复用资源取舍 | （人工判断） |
| 3 编写 | SKILL.md（必含「自进化流程」章节）+ references/changelog.md（必建，首条 v0.1.0）+ 其它资源 | `bash "$GATE" doc-gate <name>` |
| 4 软链接 | （脚本自动创建镜像父目录并校验 Junction 类型与指向 `.claude/skills/<name>`；新检出工作区的普通目录镜像在**全量文件清单**与候选逐字节一致时自动重建 junction——清单生成/哈希计算任何一步失败（含不可读文件）或任何多出/差异文件一律拒绝自动覆盖，类型查询失败同样拒绝） | `bash "$GATE" link <name>` |
| 5 codex 审核 | 发起 `ssww-review-ruling` 审核链（见第 3 节），REJECTED 则整改后 RESUBMIT 循环 | `bash "$GATE" review-gate <name> <REQ_ID>` |
| 6 提交 | （脚本自动，内嵌过审复验 + 已审核身份锚定 + 提交信息格式检查） | `bash "$GATE" commit <name> "<message>" <REQ_ID>` |

门禁失败即停，按输出整改后**重跑同一门禁**；严禁修改门禁脚本绕过。

前置条件（工作区级，缺一门禁会失败）：仓库根有 `AGENTS.md`；`docs/standards/审核裁决协议.md` 与 `docs/standards/TDD_Standard.md` 存在；工作区已完成 `git init`（阶段 6 提交门禁依赖 git）。

## 3. codex 审核链（阶段 5 详细）

1. **生成候选身份 + 三件套锚定**：`bash "$GATE" identity <name> <REQ_ID>`（REQ_ID 必填）— 把候选按清单**冻结到临时目录**后，从同一组冻结字节生成三类锚定并存到仓库根 `.tmp/codex-rulings/`（与调用器 receipt 同目录；脚本自动建目录，该 REQ_ID 已有 receipt 时拒绝补建；全部禁覆盖）：
   - `<REQ_ID>.candidate.sha`：SHA-256 快照，review-gate/commit 用它校验候选未漂移；
   - `<REQ_ID>.candidate.blob`：git blob 索引锚定（`<blob>  <完整路径>` 双空格格式），commit 门禁用它直接校验暂存索引——**提交校验以已审核身份为唯一基准，不重新采信当前工作区**，快照检查后改写的内容无法过审提交；
   - `<REQ_ID>.candidate.blob.sha256`：锚定文件自身的哈希，消费时与 request 声明复算比对，锚定值被替换即被拒。
   identity 末尾输出**独立一行** `BLOB_ANCHOR_SHA256=<值>`，原样整行复制进 request（续审/恢复轮同样必须先重新 identity 再绑定）。
2. **写 request 文件**：放 `.claude/skills/.tmp/review/request-<REQ_ID>.txt`（**必须以 REQ_ID 命名**），正文含：`TASK=`、`REQUEST_KIND=RULING`、`REQUEST_ID=`（如 `REQ-<NAME>-v0.1.0-01`）、`BLOB_ANCHOR_SHA256=<identity 输出值>`（索引锚定绑定）、目标/候选身份/证据/风险自述/中文表达自查，并附候选文件全部 `<sha256>  <path>` 行。**不得写保留字段**（REVIEW_SKILL、SESSION_MODE、SKILL_SHA256 等，脚本注入）。
3. **发起**（首轮 NEW，先设代理）：
   ```bash
   export HTTP_PROXY=http://127.0.0.1:1080 HTTPS_PROXY=http://127.0.0.1:1080
   python .claude/skills/ssww-review-ruling/scripts/invoke_ssww_review.py \
     --repo-root . \
     --request-file ".claude/skills/.tmp/review/request-<REQ_ID>.txt" \
     --review-chain-id <chain-id> \
     --source-executor CLAUDE_CLI
   ```
   记下输出中的 `session_id`。
4. **整改循环**：RULING=REJECTED 时，按 `NEXT_ACTION` 逐项整改 → 重跑 `identity <name> <新REQ_ID>`（SHA 已变，快照重建）→ 写新 request（`REQUEST_KIND=RESUBMIT`、**新 REQUEST_ID**、`PRIOR_REQUEST_ID=` 上轮 ID、`PRIOR_RULING=` 上轮 RULING 值、`TASK=` 与首轮字节一致）→ 带 `--resume-session-id <session_id>` 重发 → 重跑 `review-gate`。
5. **读取结果**：裁决固定读 `.tmp/codex-rulings/<REQ_ID>.txt`（stdout 可能有编码问题，不要依赖管道解析）。

## 4. 提交纪律（阶段 6）

- `commit` 门禁**内嵌全套复验**：receipt 完整性（validation=PASS / cli_exit_code=0 / request_id 匹配 / 审核 Skill 身份未漂移）+ 候选未漂移（当前 SHA 与审核时快照 diff）+ 锚定哈希绑定（request 声明的 BLOB_ANCHOR_SHA256 与锚定文件复算一致，防锚定篡改）+ 提交集已审核身份锚定（暂存索引逐文件核对 blob 锚定，正向防篡改、反向防 .gitignore 吞文件）+ RULING=APPROVED + 提交信息格式（scope 必填）+ 暂存夹带（NUL 分隔，中文/空格路径不误判），任一不过即拒绝。
- 提交信息：`<type>(<scope>): <中文动宾 subject>`，type 小写枚举（feat/fix/chore/docs/refactor/perf/test/revert），subject ≤50 字无句号；**不加任何 AI 署名**（门禁拦截 Co-Authored-By/Generated with 等）。
- 暂存夹带由脚本硬阻断：暂存区出现候选目录外文件时自动 `git reset` 并报错。
- `.tmp/`（request/ruling 产物）永不提交。

## 5. 自进化流程（每次使用本 skill 后强制执行）

1. **门禁有效性**：本次哪个门禁拦住了真实问题？哪个问题漏过了门禁（补检查项）？
2. **流程坑**：junction/编码/调用参数等环境坑是否有新增？补 `references/pitfalls.md`。
3. **表述纪律**：SKILL.md 是否存在"必然/一律"类过强表述（审核高频拒绝项）？

有发现 → 更新文件 + `references/changelog.md` 追加 + 用 `commit` 门禁提交；无发现 → 明确回复"已检查，本次无需更新"。

## Additional Resources

### Reference Files

- **`references/pitfalls.md`** — 实战坑清单：RESUBMIT 的 TASK 字节一致、junction 建链参数、frontmatter 必带、表述过强模式、编码问题
- **`references/changelog.md`** — 本 skill 更新历史

### Scripts

- **`scripts/ssww-skill-gate.sh`** — 五道门禁（doc-gate/link/identity/review-gate/commit），fail-closed，子命令用法见脚本头部注释
- **`scripts/verify_commit_paths.py`** — 提交门禁的隔离仓库完整路径验证（夹带/忽略文件/request 改写/REJECTED 等场景）
