# ssww-create-skill 实战坑清单

持续积累。每条注明发现日期与场景，重复踩的坑前移。

## 环境与调用

1. **codex 出网必须走本机代理**（自 poe2-logic 实证继承）：调用 `invoke_ssww_review.py` 前必须 `export HTTP_PROXY=http://127.0.0.1:1080 HTTPS_PROXY=http://127.0.0.1:1080`。症状：反复 403、validation=FAIL、输出只有封套头。403 连续三次即停手查代理。
2. **裁决输出从 `.tmp/codex-rulings/<REQ_ID>.txt` 读**，不从 stdout 管道解析（Windows 编码问题）。
3. **候选快照禁覆盖**：同 REQ_ID 重跑 `identity` 会绕过候选漂移检测；候选变化必须换新 REQ_ID。
4. **RESUBMIT 的 TASK 行必须与首轮逐字节一致**（含空格标点）；改 TASK 等于换了审核对象，必须新链。
5. **request 禁写保留字段**（poe2-logic 首轮实证）：`SOURCE_EXECUTOR=`、`SESSION_MODE=`、`SKILL_SHA256=` 等由脚本注入，request 里出现即被调用器拒绝（报错是 GBK 乱码，需看 stderr 日志文件）。
6. **快照/receipt 路径统一在仓库根 `.tmp/codex-rulings/`**（poe2-logic 两次实证）：脚本自动 `mkdir -p`；已送审（有 receipt）的 REQ_ID 禁止补建快照。
7. **调用器 stderr 报错在 GBK 控制台显示为乱码**：统一重定向到日志文件再用 UTF-8 读。
8. **Codex 审核能抓到真实的代码缺陷**（poe2-logic 首轮实证：3 个 P1 真 bug——正则末段位数、锁序竞态、异常路径孤儿进程）：不要预设"改编自已验收代码就没问题"，送审前先自查这几类点。
9. **夹具一律 LF 写入**（poe2-logic 实测教训）：Python 在 Windows 默认写 CRLF，会使门禁 diff 漂移误报；verify_commit_paths.py 已内置 `write_text_lf`。

## 文档与结构

10. **frontmatter 三件套缺一必拒**：name（与目录同名）/ description（≥20 字符、含触发词）/ metadata.version。
11. **SKILL.md 禁止本机绝对路径**（`E:/`、`C:/`），doc-gate 拦截；引用一律相对工作区根。
12. **「自进化流程」章节名必须出现**在 SKILL.md 正文中，doc-gate 按"自进化"字样检查。
13. 表述避免"必然/一律/所有"类过强断言——审核高频拒绝项；用"默认/除非/例外时"限定。

## Windows 特有

14. **junction 创建**用 `cmd /c mklink /J`，Git Bash 下注意路径转换（`cygpath -w`）；校验用 PowerShell `Get-Item` 的 LinkType/Target。**mklink 不会自动创建父目录**（2026-10-16 本项目首跑实证）：`.agents/skills/` 不存在时报"系统找不到指定的路径"，门禁报 junction 创建失败——link 门禁现已自动 `mkdir -p` 父目录。
15. **git 新检出后 junction 退化为普通目录拷贝**（2026-10-16 codex 审核实证）：git 把 junction 存成普通目录；link 门禁现在对该形态做内容逐字节一致校验后自动重建 junction，有差异拒绝覆盖。
16. **git 文本输出会把中文路径转义成带引号八进制**（2026-10-16 codex 审核实证，`core.quotepath` 默认开启）：文本比较会误判夹带/对不上清单——所有 git 路径枚举一律 `-z` NUL 分隔 + `-c core.quotepath=off`。
17. 中文正则检测用 python（U+4E00–U+9FFF），Git Bash 的 `grep -P` 受 locale 限制不可靠。
18. Python subprocess 解析 bash 时可能命中 WSL 的 `System32\bash.exe`：从 git.exe 位置推导 Git Bash（verify_commit_paths.py 的 `find_git_bash` 已内置）。
19. harness 输出在 GBK 控制台是乱码但结果可判读：看每行末尾 `code_ok=/reason_ok=` 与尾部统计 `PASS=x FAIL=y SKIP=z` 及总退出码。
20. **提交门禁的校验基准必须是已审核身份而非当前工作区**（2026-10-16 codex 审核判 P1）：快照检查与 git add 之间存在改写窗口；现由 identity 时的 git blob 索引锚定闭合。
