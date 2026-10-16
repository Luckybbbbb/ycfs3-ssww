# ssww-review-ruling 更新历史

## 0.1.3（2026-10-16）

- 按 REQ-SSWW-REVIEWRULING-v0.1.0-03 审核（RULING=REJECTED，一 P1 + 两 P2）整改，调用器 `invoke_ssww_review.py`：
  1. [P1] 启动失败路径闭环：Job 创建失败（job_unavailable）时**禁止启动审核进程**（无归属保证的进程树不可被可验证地回收，fail-closed）；入组失败时不再依赖空 Job 清理——挂起根进程主线程从未运行、不可能有子孙，直接 `terminate_suspended_root`（TerminateProcess 自有 Popen 句柄）并以 poll 确认消亡，确认结果决定 cleanup_complete 与链锁/recovery_allowed。main 对发审前中止路径补空 events/stderr 产物，receipt 证据链完整且 validation 按缺会话/空输出判 FAIL。
  2. [P2] 恢复接口缺失纳入失败路径：NtResumeProcess 的 DLL 加载/符号查找/调用异常一律捕获返回 False → 走 resume_failed fail-closed（回收挂起树 + 失败 receipt），不再异常上抛；changelog 0.1.2"接口移除将走 resume_failed"的声明与源码恢复一致。
  3. [P2] 收尾进度回调接线：`cleanup_process_tree` 全部 6 处调用传入 `progress=emit_progress`，最长 30 秒收尾等待期间每 0.25 秒输出成员数/耗时进度。
- 测试扩充（`tests/test_invocation.py`，仍全部经 main() 产品入口）：新增 job_unavailable 禁止启动（argv.json 不存在佐证）、入组失败终止挂起根进程、恢复失败生成失败 receipt、收尾验证超时（cleanup_complete=False + recovery_allowed=False + process_cleanup_incomplete）四个负例，以及 tasklist 查询失败按存活处理的 pid_alive fail-closed 单元例。**12 例全部通过、单轮退出码 0**（约 44 秒，含 30 秒收尾超时负例），身份绑定日志：`.tmp/codex-rulings/test-logs/REQ-SSWW-REVIEWRULING-v0.1.0-04.unittest.log`（头部含四个候选文件 SHA-256）。


## 0.1.2（2026-10-16）

- 按 REQ-SSWW-REVIEWRULING-v0.1.0-02 审核（RULING=REJECTED，两 P1 + 一 P2）整改，调用器 `invoke_ssww_review.py`：
  1. [P1] 进程树回收改用 Windows Job Object 内核归属（`create_cleanup_job` KILL_ON_JOB_CLOSE + `AssignProcessToJobObject`）：归属与 PID/PPID 无关，中间包装进程退出不影响成员集合（修复 PPID 枚举断链漏杀），也不存在按 PID 强杀误伤他者的问题（修复归属校验缺失）。审核进程改为 CREATE_SUSPENDED 启动、入 Job 后经 `NtResumeProcess`（ntdll，psutil 同款路径）恢复——先入组后运行，杜绝"子孙先于入组诞生"竞态。收尾统一走 `cleanup_process_tree`：TerminateJobObject + `job_process_ids`（QueryInformationJobObject）验证成员清空，全程受统一 30 秒 deadline 约束并保持进度输出（修复无上限与单次查询越过 deadline）。任何不确定（job 创建/入组/恢复失败、超时、查询失败）→ cleanup_complete=False → 链锁保留、recovery_allowed 不置真（main 既有校验未放松）。POSIX 分支保留进程组语义。`stop_process_tree`/`pid_alive`/PPID 枚举整体移除；`select_latest_chain_receipt` 抽为独立函数（可单测）。
  2. [测试] 新增 `tests/test_invocation.py`（经 main() 产品入口，本地 codex 替身 = cmd 包装层 + python 进程树，无害夹具）：传输 PASS 与模型钉钉入 argv（`-c model=` / `-c model_reasoning_effort=`）、包装层即退孤儿孙进程被整树回收（tasklist 复核 PID 消亡）、空闲超时挂起树回收（failure_reason=idle_timeout、cleanup_complete=True）、CODEX_HOME 漂移后哨兵拒绝错模型（负例）、同秒 receipt 按 mtime_ns 决胜与跨链/无 session 忽略（单元 3 例）。**7 例全部通过、单轮退出码 0**，身份绑定日志：`.tmp/codex-rulings/test-logs/REQ-SSWW-REVIEWRULING-v0.1.0-03.unittest.log`（头部含四个候选文件 SHA-256，与本轮候选一致）。
  3. [文档] SKILL.md「调用进度与故障处理」更新为 Job Object 回收与模型双层闭合表述；0.1.1 条目中"进程枚举/验证逻辑经执行端实测"的表述撤回更正——当时仅为单次正常传输，未覆盖故障路径，本轮以夹具测试补足。
- 已知限制：`-c model=` 覆盖语义依赖 codex CLI 版本（本机 0.161.0），CLI 升级若语义变化由哨兵核对与 receipt.model_pin 审计兜底；NtResumeProcess 为 ntdll 未公开接口（psutil 生产在用），Windows 更新若移除将走 resume_failed fail-closed 路径。
