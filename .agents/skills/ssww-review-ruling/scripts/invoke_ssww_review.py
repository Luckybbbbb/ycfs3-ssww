#!/usr/bin/env python3
"""在全新只读 Codex 会话中调用 ssww-review-ruling Skill。

改编自 poe2-logic invoke_poe2_review.py（其上游为 JX3_UE jx3-review-ruling）：
- 审核 Skill 换为 ssww-review-ruling（含 .agents/skills 镜像字节一致性校验）；
- 标准根换为本工程 docs/standards/（审核裁决协议 + TDD 标准）；
- 其余传输协议（RESUME_PER_CHAIN、锁、receipt、身份校验）保持同构。
"""

from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import threading
from datetime import datetime, timezone


REQUEST_KINDS = {"RULING", "ACCEPTANCE", "RESUBMIT", "STATUS", "PRECOMMIT"}
SOURCE_EXECUTORS = {"CLAUDE_CLI", "CHATGPT", "CODEX_CLI", "OTHER"}
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
COMMIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
SESSION_ID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
REVIEW_SKILL_NAME = "ssww-review-ruling"
REVIEW_SESSION_POLICY = "RESUME_PER_CHAIN"
EXPECTED_CODEX_MODEL = "gpt-6.1-sol"
EXPECTED_CODEX_EFFORT = "xhigh"


def emit_progress(**fields: object) -> None:
    """进度写到 stderr，stdout 只保留最终 receipt。"""
    print(json.dumps({"review_progress": True, "at": utc_now(), **fields},
                     ensure_ascii=False), file=sys.stderr, flush=True)


# ---------- Windows Job Object:进程树的内核级归属 ----------
# 本机启动器是 codex.CMD 包装进程(cmd → codex/node 可能多层)。PPID 枚举在中间
# 进程退出后断链,PID 会复用——两者都会导致误杀或漏杀。Job Object 把"本次调用的
# 进程树"固化为内核对象归属:成员跨 CreateProcess 自动继承、与 PID/PPID 无关,
# TerminateJobObject 一次性回收整棵树,QueryInformationJobObject 可精确验证清空。
if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _kernel32 = ctypes.windll.kernel32
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _JobObjectExtendedLimitInformation = 9
    _JobObjectBasicProcessIdList = 3
    _CREATE_SUSPENDED = 0x00000004

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", _IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]


def create_cleanup_job():
    """创建 KILL_ON_JOB_CLOSE 任务对象;失败返回 None(调用方按回收不可确认处理)。"""
    if os.name != "nt":
        return None
    job = _kernel32.CreateJobObjectW(None, None)
    if not job:
        return None
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not _kernel32.SetInformationJobObject(
            job, _JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info)):
        _kernel32.CloseHandle(job)
        return None
    return job


def assign_process_to_job(job, process: subprocess.Popen) -> bool:
    if job is None or os.name != "nt":
        return False
    return bool(_kernel32.AssignProcessToJobObject(job, int(process._handle)))


def resume_suspended_process(process: subprocess.Popen) -> bool:
    """CREATE_SUSPENDED 启动后恢复整进程(消除"子孙先于入 Job 诞生"的竞态)。

    用 ntdll.NtResumeProcess(psutil 同款路径,恢复进程全部线程),不依赖
    Thread32First 枚举(实测 ERROR_BAD_LENGTH 假失败)。DLL 加载/符号查找/
    调用失败一律返回 False——由调用方走 resume_failed fail-closed 路径
    (回收挂起进程并生成失败 receipt),绝不带着未恢复的进程继续。
    """
    if os.name != "nt":
        return True
    try:
        ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
        ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
        ntdll.NtResumeProcess.restype = wintypes.LONG
        status = ntdll.NtResumeProcess(int(process._handle))
    except (OSError, AttributeError):
        return False
    return status == 0


def terminate_suspended_root(process: subprocess.Popen) -> bool:
    """安全终止仍未恢复的挂起根进程(入组失败时的未入组残留)。

    挂起进程不可能已派生子孙(主线程从未运行),直接 TerminateProcess 自己
    的 Popen 句柄即覆盖整棵"树";以 poll 确认消亡,未确认返回 False。
    """
    try:
        process.kill()
    except OSError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    return process.poll() is not None


def job_process_ids(job) -> list[int] | None:
    """任务对象当前成员 PID 列表;查询失败返回 None(fail-closed,不算已清空)。"""
    if os.name != "nt" or job is None:
        return None

    class _PID_LIST(ctypes.Structure):
        _fields_ = [
            ("NumberOfAssignedProcesses", wintypes.DWORD),
            ("NumberOfProcessIdsInList", wintypes.DWORD),
            ("ProcessIdList", ctypes.c_size_t * 1024),
        ]

    info = _PID_LIST()
    returned = wintypes.DWORD(0)
    if not _kernel32.QueryInformationJobObject(
            job, _JobObjectBasicProcessIdList,
            ctypes.byref(info), ctypes.sizeof(info), ctypes.byref(returned)):
        return None
    count = info.NumberOfProcessIdsInList
    if count > 1024:
        return None
    return [int(info.ProcessIdList[i]) for i in range(count)]


def cleanup_process_tree(job_holder: list, process: subprocess.Popen,
                         deadline_seconds: float = 30.0, progress=None) -> bool:
    """统一收尾:终止任务树并验证成员清空,全程受统一 deadline 约束。

    job_holder 是单元素列表(Windows: Job 句柄,收尾后置 None 防重复回收;
    POSIX: 进程组归属无句柄,保持 None)。
    Windows 归属来自 Job Object(与 PID/PPID 无关,中间进程退出不影响成员集合),
    验证以 QueryInformationJobObject 为准;超时、查询失败、终止失败一律返回 False。
    返回 False 时调用方保留链锁、禁止声明 recovery_allowed。
    """
    started = time.monotonic()
    if os.name != "nt":
        import signal
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass
        while time.monotonic() - started < deadline_seconds:
            if process.poll() is not None:
                return True
            if progress:
                progress(state="cleanup", elapsed_seconds=round(time.monotonic() - started, 1))
            time.sleep(0.25)
        return False
    job = job_holder[0]
    if job is None:
        return False
    try:
        terminate_ok = bool(_kernel32.TerminateJobObject(job, 0))
        while time.monotonic() - started < deadline_seconds:
            members = job_process_ids(job)
            if members == [] and terminate_ok:
                return True
            if progress:
                progress(state="cleanup", members=None if members is None else len(members),
                         elapsed_seconds=round(time.monotonic() - started, 1))
            time.sleep(0.25)
        return False
    finally:
        _kernel32.CloseHandle(job)
        job_holder[0] = None


def run_review_process(command: list[str], prompt: str, environment: dict[str, str],
                       events_path: Path, stderr_path: Path, timeout_seconds: float,
                       idle_timeout_seconds: float, progress_seconds: float = 15) -> dict[str, object]:
    """定期报告活动量；总超时和日志无增长超时均终止自有进程树。

    Windows 以 Job Object 归属整棵进程树：CREATE_SUSPENDED 启动消除"子孙先于
    入组诞生"的竞态，归属与 PID/PPID 无关（codex.CMD 包装层中间退出也不影响）；
    挂起恢复或入组失败按回收不可确认处理（fail-closed）。POSIX 以进程组归属。
    """
    started = time.monotonic()
    last_activity = started
    last_sizes = (0, 0)
    job_holder: list = [create_cleanup_job()]
    if os.name == "nt" and job_holder[0] is None:
        # Job 归属不可建立时禁止启动审核进程:没有归属保证的进程树无法被
        # 可验证地回收,fail-closed 比遗留进程更安全。
        return {"exit_code": 127, "failure_reason": "job_unavailable",
                "cleanup_complete": True}
    with events_path.open("w", encoding="utf-8", newline="\n") as events_stream, \
            stderr_path.open("w", encoding="utf-8", newline="\n") as stderr_stream:
        try:
            process = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=events_stream, stderr=stderr_stream,
                text=True, encoding="utf-8", errors="replace", env=environment,
                start_new_session=os.name != "nt",
                creationflags=_CREATE_SUSPENDED if os.name == "nt" else 0,
            )
        except OSError as error:
            stderr_stream.write(f"无法启动审核进程：{error}\n")
            if job_holder[0] is not None:
                _kernel32.CloseHandle(job_holder[0])
                job_holder[0] = None
            return {"exit_code": 127, "failure_reason": "launch_failed", "cleanup_complete": True}
        # Popen 成功后任何异常（含线程启动失败）都必须先回收自有进程再上抛，
        # 严禁把孤儿进程和已释放的锁留给调用方。
        try:
            if os.name == "nt" and not assign_process_to_job(job_holder[0], process):
                # 进程仍是挂起态(未恢复、不可能有子孙):直接终止并确认消亡,
                # 空 Job 的清理结果不能代表这个未入组的根进程。
                stderr_stream.write("无法将审核进程归入 Job Object（回收归属不可建立）\n")
                root_gone = terminate_suspended_root(process)
                _kernel32.CloseHandle(job_holder[0])
                job_holder[0] = None
                return {"exit_code": 127, "failure_reason": "job_assignment_failed",
                        "cleanup_complete": root_gone}
            if os.name == "nt" and not resume_suspended_process(process):
                stderr_stream.write("挂起启动的审核进程恢复失败（已回收）\n")
                cleaned = cleanup_process_tree(job_holder, process, progress=emit_progress)
                return {"exit_code": 127, "failure_reason": "resume_failed",
                        "cleanup_complete": cleaned}
            emit_progress(state="started", pid=process.pid, events_file=str(events_path),
                          stderr_file=str(stderr_path))
            input_errors: list[str] = []

            def send_prompt() -> None:
                # Windows 的 communicate 可能在写满 stdin 时阻塞，监控线程不能跟着等待。
                try:
                    process.stdin.write(prompt)
                    process.stdin.close()
                except (OSError, ValueError) as error:
                    input_errors.append(str(error))

            writer = threading.Thread(target=send_prompt, daemon=True)
            writer.start()
        except BaseException:
            if job_holder[0] is not None:
                cleanup_process_tree(job_holder, process, progress=emit_progress)
            raise
        try:
            while True:
                now = time.monotonic()
                wait_seconds = max(0.01, min(progress_seconds,
                    timeout_seconds - (now - started),
                    idle_timeout_seconds - (now - last_activity)))
                try:
                    process.wait(timeout=wait_seconds)
                    writer.join(timeout=1)
                    input_failed = bool(input_errors) or writer.is_alive()
                    # 包装进程自然退出 ≠ 进程树已回收：整树消亡验证交给 cleanup，
                    # 未确认一律 cleanup_complete=False（锁保留、recovery_allowed 不置真）。
                    return {"exit_code": int(process.returncode or (1 if input_failed else 0)),
                            "failure_reason": "input_delivery_failed" if input_failed else "",
                            "cleanup_complete": cleanup_process_tree(job_holder, process, progress=emit_progress)}
                except subprocess.TimeoutExpired:
                    pass
                now = time.monotonic()
                sizes = (events_path.stat().st_size, stderr_path.stat().st_size)
                if sizes != last_sizes:
                    last_activity = now
                    last_sizes = sizes
                emit_progress(state="running", pid=process.pid,
                              elapsed_seconds=round(now - started),
                              idle_seconds=round(now - last_activity),
                              events_bytes=sizes[0], stderr_bytes=sizes[1])
                reason = "timeout" if now - started >= timeout_seconds else (
                    "idle_timeout" if now - last_activity >= idle_timeout_seconds else "")
                if reason:
                    cleaned = cleanup_process_tree(job_holder, process, progress=emit_progress)
                    emit_progress(state=reason, pid=process.pid, cleanup_complete=cleaned)
                    return {"exit_code": 124, "failure_reason": reason,
                            "cleanup_complete": cleaned}
        finally:
            # 异常路径兜底:句柄仍开启说明尚未收尾,统一回收一次(已收尾则 no-op)
            if job_holder[0] is not None:
                cleanup_process_tree(job_holder, process, progress=emit_progress)
            writer.join(timeout=1)


def validate_prior_transport(receipt: dict[str, object], prior_ruling: str,
                             prior_output_text: str) -> None:
    """失败续审只复用上下文，不把迟到文本升级为裁决。

    顺序合同：先判 receipt 失败与恢复条件（失败轮的输出只是诊断，
    其中的 RULING/STATUS 字段不参与任何校验），PASS 轮才解析输出字段。
    """
    if receipt.get("validation") == "FAIL":
        if receipt.get("recovery_allowed") is not True or prior_ruling != "TRANSPORT_FAILED":
            raise RuntimeError("失败轮次只能在确认进程已回收后以 PRIOR_RULING=TRANSPORT_FAILED 续审")
        return
    if receipt.get("validation") != "PASS":
        raise RuntimeError("上一轮 receipt 的 validation 无效")
    prior_ruling_field = extract_optional_unique_field(prior_output_text, "RULING")
    prior_status_field = extract_optional_unique_field(prior_output_text, "STATUS")
    if prior_ruling_field and prior_status_field:
        raise RuntimeError("上一轮输出同时包含 RULING 与 STATUS，裁决身份不闭合")
    prior_result = prior_ruling_field or prior_status_field
    if not prior_result or prior_result not in prior_ruling:
        raise RuntimeError("PRIOR_RULING 未包含上一轮实际的 RULING/STATUS")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_unique_field(text: str, key: str) -> str:
    values = re.findall(rf"(?m)^{re.escape(key)}=(.+)$", text)
    if len(values) != 1:
        raise ValueError(f"请求必须恰含一条 {key}=，实际为 {len(values)} 条")
    return values[0].strip()


def extract_optional_unique_field(text: str, key: str) -> str:
    values = re.findall(rf"(?m)^{re.escape(key)}=(.+)$", text)
    if len(values) > 1:
        raise ValueError(f"请求至多包含一条 {key}=，实际为 {len(values)} 条")
    return values[0].strip() if values else ""


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def atomic_write_json(path: Path, value: dict[str, object]) -> None:
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temp_path, path)


def atomic_write_text(path: Path, value: str) -> None:
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(value, encoding="utf-8", newline="\n")
    os.replace(temp_path, path)


def parse_session_id(events_path: Path) -> str:
    if not events_path.exists():
        return ""
    for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "thread.started":
            return str(event.get("thread_id", ""))
    return ""


def parse_usage(events_path: Path) -> dict[str, int]:
    usage: dict[str, int] = {}
    if not events_path.exists():
        return usage
    for line in events_path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        candidate = event.get("usage") if event.get("type") == "turn.completed" else None
        if isinstance(candidate, dict):
            usage = {
                str(key): int(value)
                for key, value in candidate.items()
                if isinstance(value, int)
            }
    return usage


def normalized_path(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


def context_hashes(paths: list[Path]) -> dict[str, str]:
    return {str(path): sha256_file(path) for path in paths}


def bundle_sha256(values: dict[str, str]) -> str:
    encoded = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def unique_paths(paths: list[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        key = normalized_path(path)
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result


def applicable_agent_paths(repo_root: Path, workspace_root: Path) -> list[Path]:
    """返回从候选仓库到工作区根的全部生效 AGENTS.md。"""
    result: list[Path] = []
    current = repo_root
    workspace_key = normalized_path(workspace_root)
    while True:
        candidate = current / "AGENTS.md"
        if candidate.is_file():
            result.append(candidate)
        if normalized_path(current) == workspace_key or current.parent == current:
            break
        current = current.parent
    workspace_agents = workspace_root / "AGENTS.md"
    if workspace_agents.is_file():
        result.append(workspace_agents)
    return unique_paths(result)


def validate_candidate_identity(
    request_text: str, expected_repo_root: Path | None = None
) -> dict[str, object]:
    """校验精确 MR/门禁请求声明的候选仓库身份。"""
    required = extract_optional_unique_field(request_text, "CANDIDATE_IDENTITY_REQUIRED")
    if not required:
        return {}
    if required != "1":
        raise ValueError("CANDIDATE_IDENTITY_REQUIRED 只能为 1")

    values = {
        key: extract_unique_field(request_text, key)
        for key in (
            "CANDIDATE_REPO_ROOT",
            "CANDIDATE_BASE_COMMIT",
            "DELIVERY_BASE_COMMIT",
            "CANDIDATE_COMMIT",
            "CANDIDATE_ORIGIN_MAIN",
        )
    }
    for key in (
        "CANDIDATE_BASE_COMMIT",
        "DELIVERY_BASE_COMMIT",
        "CANDIDATE_COMMIT",
        "CANDIDATE_ORIGIN_MAIN",
    ):
        if not COMMIT_SHA_RE.fullmatch(values[key]):
            raise ValueError(f"{key} 必须是完整 40 位 commit SHA")

    candidate_root = Path(values["CANDIDATE_REPO_ROOT"]).resolve()
    if not candidate_root.is_dir():
        raise ValueError(f"CANDIDATE_REPO_ROOT 不是目录：{candidate_root}")
    if expected_repo_root is not None and normalized_path(candidate_root) != normalized_path(
        expected_repo_root
    ):
        raise RuntimeError(
            "CANDIDATE_REPO_ROOT 与 --repo-root 不一致："
            f"candidate={candidate_root}; invocation={expected_repo_root.resolve()}"
        )

    top_level_result = subprocess.run(
        ["git", "-C", str(candidate_root), "rev-parse", "--show-toplevel"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if top_level_result.returncode != 0:
        raise RuntimeError(
            "无法解析 CANDIDATE_REPO_ROOT 的 Git 根："
            f"{top_level_result.stderr.strip()}"
        )
    top_level = Path(top_level_result.stdout.strip()).resolve()
    if normalized_path(top_level) != normalized_path(candidate_root):
        raise RuntimeError(
            "CANDIDATE_REPO_ROOT 不是精确 Git 根："
            f"期望={candidate_root}; 实际={top_level}"
        )

    def resolve_commit(ref: str, field: str) -> str:
        result = subprocess.run(
            ["git", "-C", str(candidate_root), "rev-parse", "--verify", "--quiet", ref],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"无法解析候选仓库 {field}={ref}：{result.stderr.strip()}"
            )
        value = result.stdout.strip().lower()
        if not COMMIT_SHA_RE.fullmatch(value):
            raise RuntimeError(f"候选仓库 {field} 不是完整 commit SHA：{value}")
        return value

    candidate_head = resolve_commit("HEAD", "CANDIDATE_COMMIT")
    candidate_origin_main = resolve_commit(
        "refs/remotes/origin/main", "CANDIDATE_ORIGIN_MAIN"
    )
    candidate_base = values["CANDIDATE_BASE_COMMIT"].lower()
    delivery_base = values["DELIVERY_BASE_COMMIT"].lower()
    candidate_commit = values["CANDIDATE_COMMIT"].lower()
    if candidate_base != delivery_base:
        raise RuntimeError(
            "候选与交付基线不一致："
            f"CANDIDATE_BASE_COMMIT={candidate_base}; DELIVERY_BASE_COMMIT={delivery_base}"
        )
    if candidate_origin_main != candidate_base:
        raise RuntimeError(
            "候选仓库 origin/main 不是请求声明的主线基线："
            f"origin/main={candidate_origin_main}; base={candidate_base}"
        )
    if candidate_head != candidate_commit:
        raise RuntimeError(
            "候选仓库 HEAD 与请求声明不一致："
            f"HEAD={candidate_head}; CANDIDATE_COMMIT={candidate_commit}"
        )

    merge_base_result = subprocess.run(
        [
            "git",
            "-C",
            str(candidate_root),
            "merge-base",
            "--is-ancestor",
            candidate_base,
            candidate_commit,
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if merge_base_result.returncode != 0:
        raise RuntimeError(
            "候选提交不是主线基线的后代："
            f"merge-base_exit_code={merge_base_result.returncode}"
        )
    return {
        "required": True,
        "candidate_repo_root": str(candidate_root),
        "candidate_base_commit": candidate_base,
        "delivery_base_commit": delivery_base,
        "candidate_commit": candidate_commit,
        "candidate_origin_main": candidate_origin_main,
        "candidate_head": candidate_head,
        "merge_base_exit_code": merge_base_result.returncode,
    }


def select_latest_chain_receipt(output_dir: Path, review_chain_id: str):
    """同链最新 receipt:(finished_at, mtime_ns) 排序——秒级时间戳同秒时由
    mtime_ns 决胜,不依赖文件枚举顺序。无同链 receipt 返回 None。"""
    chain_receipts = []
    for candidate_path in output_dir.glob("*.receipt.json"):
        try:
            candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if candidate.get("review_chain_id") == review_chain_id and candidate.get("session_id"):
            chain_receipts.append((candidate_path, candidate))
    chain_receipts.sort(key=lambda item: (str(item[1].get("finished_at", "")),
                                          item[0].stat().st_mtime_ns))
    return chain_receipts[-1] if chain_receipts else None


def load_codex_model_config(config_path: Path) -> tuple[str, str]:
    """tomllib 真解析 codex 配置，只认顶层作用域的 model/model_reasoning_effort。"""
    import tomllib

    if not config_path.exists():
        raise SystemExit(
            "ERROR: 找不到 ~/.codex/config.toml，无法核对审核模型，拒绝发审。"
        )
    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise SystemExit(f"ERROR: 无法解析 {config_path}：{error}") from error
    model = config.get("model")
    effort = config.get("model_reasoning_effort")
    if not isinstance(model, str) or not isinstance(effort, str):
        raise SystemExit(
            "ERROR: config.toml 顶层缺少 model 或 model_reasoning_effort（字符串），"
            "无法确认全局审核模型，拒绝发审。"
        )
    return model, effort


def check_codex_model_config() -> None:
    """发审前核对 codex 全局模型与推理力度（fail-closed，防模型漂移拉低审核质量）。

    config 核对只是前置哨兵：config.toml（含项目级 .codex/config.toml 与 CODEX_HOME
    指向的目录）可能覆盖用户全局配置，单靠读文件不保证实际模型。实际约束由下方
    common_options 的 `-c model=` 命令行覆盖实现（优先级高于一切配置文件），
    两层合起来才构成模型身份闭合。期望值变化时只需修改下面两个常量。
    """
    expected_model = EXPECTED_CODEX_MODEL
    expected_effort = EXPECTED_CODEX_EFFORT
    model, effort = load_codex_model_config(_codex_config_path())
    if model != expected_model or effort != expected_effort:
        raise SystemExit(
            f"ERROR: codex 全局模型不符预期：model={model!r} "
            f"model_reasoning_effort={effort!r}；"
            f"期望 {expected_model!r} + {expected_effort!r}。"
            "请在 codex CLI 切换全局模型后再发起审核。"
        )


def _codex_config_path() -> Path:
    """codex 配置目录随 CODEX_HOME 漂移；哨兵核对必须看实际生效的那份。"""
    home = os.environ.get("CODEX_HOME")
    if home:
        return Path(home) / "config.toml"
    return Path.home() / ".codex" / "config.toml"


def validate_transport_lines(raw_output_text: str, expected_skill: str,
                             skill_sha: str, request_id: str) -> list[str]:
    """清洗输出前校验全部传输字段：候选自报字段必须唯一且值正确，注入字段不得出现。

    矛盾或重复字段（如同轮出现两个不同 REQUEST_ID）直接判失败，
    不允许矛盾身份被后续清洗步骤洗成"看起来有效"的输出。
    """
    errors: list[str] = []
    lines = [line.strip() for line in raw_output_text.splitlines()]
    expected_single = {
        "REVIEW_SKILL": expected_skill,
        "SKILL_SHA256": skill_sha,
        "REQUEST_ID": request_id,
    }
    for field, expected in expected_single.items():
        occurrences = [line for line in lines if line.startswith(f"{field}=")]
        if len(occurrences) != 1:
            errors.append(f"transport_field_count_invalid:{field}:{len(occurrences)}")
        elif occurrences[0] != f"{field}={expected}":
            errors.append(f"transport_field_value_invalid:{field}")
    for field in ("REVIEW_SESSION_POLICY", "REVIEW_CHAIN_ID", "REVIEW_SESSION_ID", "SESSION_MODE"):
        occurrences = [line for line in lines if line.startswith(f"{field}=")]
        if occurrences:
            errors.append(f"transport_field_injected_in_raw:{field}:{len(occurrences)}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="使用可续审的只读 Codex 审核链执行 ycfs3-ssww 审核裁决"
    )
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--request-file", required=True, type=Path)
    parser.add_argument("--source-executor", required=True, choices=sorted(SOURCE_EXECUTORS))
    parser.add_argument("--review-chain-id", required=True)
    parser.add_argument("--resume-session-id")
    parser.add_argument("--timeout-seconds", type=int, default=1200)
    parser.add_argument("--idle-timeout-seconds", type=int, default=300)
    args = parser.parse_args()

    check_codex_model_config()

    script_path = Path(__file__).resolve()
    skill_root = script_path.parents[1]
    skill_file = skill_root / "SKILL.md"
    workspace_root = skill_root.parents[2]
    visible_skill_file = workspace_root / ".agents" / "skills" / REVIEW_SKILL_NAME / "SKILL.md"
    standard_root = workspace_root / "docs" / "standards"
    repo_root = args.repo_root.resolve()
    request_file = args.request_file.resolve()
    output_dir = (repo_root / ".tmp" / "codex-rulings").resolve()
    review_chain_id = args.review_chain_id.strip()
    resume_session_id = (args.resume_session_id or "").strip()

    if not REQUEST_ID_RE.fullmatch(review_chain_id):
        raise ValueError("review-chain-id 只允许字母、数字、点、下划线和连字符")
    if resume_session_id and not SESSION_ID_RE.fullmatch(resume_session_id):
        raise ValueError("resume-session-id 必须是 Codex 返回的 UUID session ID")
    if args.timeout_seconds <= 0 or args.idle_timeout_seconds <= 0:
        raise ValueError("timeout-seconds 和 idle-timeout-seconds 必须大于 0")

    agent_paths = applicable_agent_paths(repo_root, workspace_root)
    required_paths = [
        skill_file,
        visible_skill_file,
        *agent_paths,
        standard_root / "审核裁决协议.md",
        standard_root / "TDD_Standard.md",
        request_file,
    ]
    missing = [str(path) for path in required_paths if not path.is_file()]
    if missing:
        raise FileNotFoundError("缺少必需文件：" + "; ".join(missing))
    if sha256_file(skill_file) != sha256_file(visible_skill_file):
        raise RuntimeError(".claude 与 .agents 看到的 ssww-review-ruling Skill 字节不一致")

    top_level = subprocess.run(
        ["git", "-C", str(repo_root), "rev-parse", "--show-toplevel"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()
    if normalized_path(Path(top_level)) != normalized_path(repo_root):
        raise RuntimeError(f"repo-root 不是精确 Git 根：期望 {repo_root}，实际 {top_level}")

    request_text = request_file.read_text(encoding="utf-8")
    request_kind = extract_unique_field(request_text, "REQUEST_KIND")
    request_id = extract_unique_field(request_text, "REQUEST_ID")
    task_name = extract_unique_field(request_text, "TASK")
    prior_request_id = extract_optional_unique_field(request_text, "PRIOR_REQUEST_ID")
    prior_ruling = extract_optional_unique_field(request_text, "PRIOR_RULING")
    if request_kind not in REQUEST_KINDS:
        raise ValueError(f"不支持的 REQUEST_KIND：{request_kind}")
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ValueError("REQUEST_ID 只允许字母、数字、点、下划线和连字符")
    if prior_request_id and not REQUEST_ID_RE.fullmatch(prior_request_id):
        raise ValueError("PRIOR_REQUEST_ID 只允许字母、数字、点、下划线和连字符")
    if prior_request_id == request_id:
        raise ValueError("PRIOR_REQUEST_ID 不能等于本轮 REQUEST_ID")
    if resume_session_id and not prior_request_id:
        raise ValueError("resume 调用必须在请求正文提供 PRIOR_REQUEST_ID")
    if resume_session_id and not prior_ruling:
        raise ValueError("resume 调用必须在请求正文提供 PRIOR_RULING")
    if not resume_session_id and prior_request_id:
        raise ValueError("请求包含 PRIOR_REQUEST_ID 时必须同时传入 --resume-session-id")
    if not resume_session_id and prior_ruling:
        raise ValueError("请求包含 PRIOR_RULING 时必须同时传入 --resume-session-id")
    if request_kind == "RESUBMIT" and not resume_session_id:
        raise ValueError("RESUBMIT 必须 resume 原审核会话")
    if request_kind == "PRECOMMIT":
        for key in ("COMMIT_MESSAGE", "MR_TITLE", "MR_DESCRIPTION"):
            extract_unique_field(request_text, key)
    for reserved in (
        "REVIEW_SKILL",
        "REVIEW_SESSION_POLICY",
        "REVIEW_CHAIN_ID",
        "REVIEW_SESSION_ID",
        "SESSION_MODE",
        "SOURCE_EXECUTOR",
        "SKILL_SHA256",
        "CONTEXT_SHA256",
        "CONTEXT_CHANGED",
        "REPO_ROOT",
        "STANDARD_ROOT",
    ):
        if re.search(rf"(?m)^{reserved}=", request_text):
            raise ValueError(f"请求正文不得自行声明保留字段 {reserved}=")

    candidate_identity = validate_candidate_identity(request_text, repo_root)

    output_dir.mkdir(parents=True, exist_ok=True)
    # 链锁先于一切产物存在性与连续性检查：并发调用必须串行化在锁之后，
    # 禁止两个调用基于过期检查结果覆盖旧证据、跳过最新轮次或重复 NEW。
    lock_key = f"chain-{review_chain_id}"
    lock_path = output_dir / f".{lock_key}.lock"
    try:
        lock_descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise RuntimeError(f"审核链已有在途调用或遗留锁：{lock_path}") from error
    with os.fdopen(lock_descriptor, "w", encoding="utf-8", newline="\n") as lock_stream:
        lock_stream.write(f"REQUEST_ID={request_id}\nPID={os.getpid()}\nSTARTED_AT={utc_now()}\n")

    # 锁保护范围从现在开始；仅当确认"无运行中进程"时才允许释放。
    lock_releasable = True

    def cleanup_lock() -> None:
        if lock_releasable:
            lock_path.unlink(missing_ok=True)

    atexit.register(cleanup_lock)

    # 请求级独占锁（跨链共享）：不同审核链的同名 REQUEST_ID 也只允许一个进入产物写入阶段。
    request_lock_path = output_dir / f".req-{request_id}.lock"
    try:
        request_lock_descriptor = os.open(
            request_lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY
        )
    except FileExistsError as error:
        raise RuntimeError(
            f"同名请求已有在途调用或遗留锁（跨链独占保护）：{request_lock_path}"
        ) from error
    with os.fdopen(request_lock_descriptor, "w", encoding="utf-8", newline="\n") as request_lock_stream:
        request_lock_stream.write(
            f"REQUEST_ID={request_id}\nCHAIN={review_chain_id}\nPID={os.getpid()}\nSTARTED_AT={utc_now()}\n"
        )

    request_lock_releasable = True

    def cleanup_request_lock() -> None:
        if request_lock_releasable:
            request_lock_path.unlink(missing_ok=True)

    atexit.register(cleanup_request_lock)

    output_path = output_dir / f"{request_id}.txt"
    raw_output_path = output_dir / f"{request_id}.raw.txt"
    events_path = output_dir / f"{request_id}.events.jsonl"
    stderr_path = output_dir / f"{request_id}.stderr.txt"
    receipt_path = output_dir / f"{request_id}.receipt.json"
    artifact_paths = [output_path, raw_output_path, events_path, stderr_path, receipt_path]
    existing = [str(path) for path in artifact_paths if path.exists()]
    if existing:
        raise FileExistsError("本轮产物已存在，必须换新 REQUEST_ID：" + "; ".join(existing))

    chain_receipts_latest = select_latest_chain_receipt(output_dir, review_chain_id)
    if not resume_session_id and chain_receipts_latest:
        latest_path, latest_data = chain_receipts_latest
        raise RuntimeError(
            "该 REVIEW_CHAIN_ID 已存在审核会话，必须 resume 或先核查失败 receipt："
            f"session={latest_data.get('session_id')}; receipt={latest_path}"
        )
    if resume_session_id and chain_receipts_latest:
        latest_path, latest_data = chain_receipts_latest
        if latest_data.get("request_id") != prior_request_id:
            raise RuntimeError(
                "PRIOR_REQUEST_ID 不是该审核链最新完成轮次："
                f"expected={latest_data.get('request_id')}; actual={prior_request_id}; receipt={latest_path}"
            )

    skill_sha = sha256_file(skill_file)
    launcher_sha = sha256_file(script_path)
    request_sha = sha256_file(request_file)
    context_paths = [
        skill_file,
        *agent_paths,
        standard_root / "审核裁决协议.md",
        standard_root / "TDD_Standard.md",
    ]
    context_paths = unique_paths(context_paths)
    current_context_hashes = context_hashes(context_paths)
    context_sha = bundle_sha256(current_context_hashes)

    session_mode = "RESUME" if resume_session_id else "NEW"
    previous_receipt: dict[str, object] = {}
    context_changed: list[str] = []
    if resume_session_id:
        prior_receipt_path = output_dir / f"{prior_request_id}.receipt.json"
        if not prior_receipt_path.is_file():
            raise FileNotFoundError(f"找不到上一轮 receipt：{prior_receipt_path}")
        previous_receipt = json.loads(prior_receipt_path.read_text(encoding="utf-8"))
        expected_prior = {
            "request_id": prior_request_id,
            "review_chain_id": review_chain_id,
            "session_id": resume_session_id,
            "review_skill": REVIEW_SKILL_NAME,
            "session_policy": REVIEW_SESSION_POLICY,
            "repo_root": str(repo_root),
            "task": task_name,
        }
        mismatches = [
            f"{key}:expected={value!r},actual={previous_receipt.get(key)!r}"
            for key, value in expected_prior.items()
            if previous_receipt.get(key) != value
        ]
        if mismatches:
            raise RuntimeError("上一轮 receipt 与本审核链不匹配：" + "; ".join(mismatches))
        prior_output_path = output_dir / f"{prior_request_id}.txt"
        if not prior_output_path.is_file():
            raise FileNotFoundError(f"找不到上一轮输出：{prior_output_path}")
        prior_output_text = prior_output_path.read_text(encoding="utf-8", errors="replace")
        if sha256_file(prior_output_path) != previous_receipt.get("output_sha256"):
            raise RuntimeError("上一轮输出 SHA 与 receipt 不一致")
        validate_prior_transport(previous_receipt, prior_ruling, prior_output_text)
        previous_context_hashes = previous_receipt.get("context_files")
        if not isinstance(previous_context_hashes, dict):
            raise RuntimeError("上一轮 receipt 缺少 context_files，不能安全 resume")
        context_changed = [
            path
            for path, digest in current_context_hashes.items()
            if previous_context_hashes.get(path) != digest
        ]
        context_changed.extend(
            path for path in previous_context_hashes if path not in current_context_hashes
        )
        context_instruction = (
            "这是同一审核链的续审。沿用会话中已经建立的任务背景以节省读取，但裁决必须从零：对所有即将合并的改动重做全量审核（多维缺一不可），"
            "已通过项和旧裁决不豁免本轮重审；未变化的 Skill、标准不必重新展开，但其适用结论须独立重申。"
        )
        if previous_receipt.get("validation") == "FAIL":
            context_instruction = (
                "这是传输失败后的同链重试。上一轮没有有效裁决，部分或迟到输出不能当作已通过项。"
                "仅复用已读取的背景，本轮重新完成审核并输出裁决。"
            )
    else:
        context_changed = list(current_context_hashes)
        context_instruction = (
            f"[$ssww-review-ruling]({visible_skill_file})\n"
            "这是本审核链首次审核。必须完整读取 ssww-review-ruling Skill、适用 AGENTS.md 与必读标准"
            "（审核裁决协议.md、TDD_Standard.md），再由当前主会话亲自完成只读审核。"
        )

    changed_text = "NONE" if not context_changed else " | ".join(context_changed)
    prompt = f"""{context_instruction}
不要 spawn 自定义 agent，不要启动嵌套 Codex，不要修改文件。平台跨会话记忆禁用，但本审核链允许使用当前 resumed 会话内的既有上下文。

REVIEW_SKILL={REVIEW_SKILL_NAME}
REVIEW_SESSION_POLICY={REVIEW_SESSION_POLICY}
REVIEW_CHAIN_ID={review_chain_id}
SESSION_MODE={session_mode}
SOURCE_EXECUTOR={args.source_executor}
SKILL_SHA256={skill_sha}
CONTEXT_SHA256={context_sha}
CONTEXT_CHANGED={changed_text}
REPO_ROOT={repo_root}
STANDARD_ROOT={standard_root}

{request_text.rstrip()}

调用脚本会把 REVIEW_CHAIN_ID、REVIEW_SESSION_ID 与 SESSION_MODE 注入最终输出，你不要在原始回复中输出这三个传输字段。当前会话中出现的同名 raw/events/stderr 文件是本次调用正在写入的预期产物，不是旧请求残留。
"""
    prompt_sha = hashlib.sha256(prompt.encode("utf-8")).hexdigest()

    codex_path = shutil.which("codex")
    if not codex_path:
        raise FileNotFoundError("PATH 中找不到 codex")
    common_options = [
        "--strict-config",
        "-c",
        f'model="{EXPECTED_CODEX_MODEL}"',
        "-c",
        'sandbox_mode="read-only"',
        "-c",
        'approval_policy="never"',
        "-c",
        "features.memories=false",
        "-c",
        f'model_reasoning_effort="{EXPECTED_CODEX_EFFORT}"',
        "--skip-git-repo-check",
        "--json",
        "--output-last-message",
        str(raw_output_path),
    ]
    if resume_session_id:
        command = [
            codex_path,
            "--no-daemon",
            "exec",
            "resume",
            *common_options,
            resume_session_id,
            "-",
        ]
    else:
        command = [
            codex_path,
            "--no-daemon",
            "exec",
            *common_options,
            "--cd",
            str(workspace_root),
            "-",
        ]

    # 进入审核运行：进程回收未确认前保留锁（人工核查后处理），防止孤儿进程占用链。
    lock_releasable = False
    started_at = utc_now()
    environment = os.environ.copy()
    environment.pop("CODEX_REVIEW_THREAD", None)
    environment["GIT_CONFIG_COUNT"] = "1"
    environment["GIT_CONFIG_KEY_0"] = "safe.directory"
    environment["GIT_CONFIG_VALUE_0"] = repo_root.as_posix()
    run_result = run_review_process(command, prompt, environment, events_path, stderr_path,
                                    args.timeout_seconds, args.idle_timeout_seconds)
    cli_exit_code = int(run_result["exit_code"])
    # 发审前中止路径(如 job_unavailable)不产生 events/stderr:补空文件使 receipt
    # 证据链完整——validation 仍按缺会话/空输出判 FAIL,不会误报成功。
    for artifact_path in (events_path, stderr_path):
        if not artifact_path.exists():
            artifact_path.write_text("", encoding="utf-8", newline="\n")
    lock_releasable = bool(run_result["cleanup_complete"])
    finished_at = utc_now()

    observed_session_id = parse_session_id(events_path)
    validation_errors: list[str] = []
    # 会话身份闭合（两个独立判断）：
    # a) 本轮身份验证——RESUME 轮也必须有会话事件证据且与原 ID 一致；
    # b) 恢复身份保留——receipt.session_id 记录原 ID，供失败后恢复链路使用。
    if resume_session_id:
        session_id = resume_session_id
        if not observed_session_id:
            validation_errors.append("missing_session_observation")
        elif observed_session_id != resume_session_id:
            validation_errors.append(
                f"resumed_session_mismatch:expected={resume_session_id},actual={observed_session_id}"
            )
    elif observed_session_id:
        if SESSION_ID_RE.fullmatch(observed_session_id):
            session_id = observed_session_id
        else:
            session_id = ""
            validation_errors.append(f"invalid_session_id_format:{observed_session_id}")
    else:
        session_id = ""
    if not session_id:
        validation_errors.append("missing_session_id")
    raw_output_text = (
        raw_output_path.read_text(encoding="utf-8", errors="replace")
        if raw_output_path.exists()
        else ""
    )
    raw_output_lines = [line.strip() for line in raw_output_text.splitlines()]
    required_raw_lines = {
        f"REVIEW_SKILL={REVIEW_SKILL_NAME}",
        f"SKILL_SHA256={skill_sha}",
        f"REQUEST_ID={request_id}",
    }
    if cli_exit_code != 0:
        validation_errors.append(f"cli_exit_code={cli_exit_code}")
    if run_result["failure_reason"]:
        validation_errors.append(str(run_result["failure_reason"]))
    if not run_result["cleanup_complete"]:
        validation_errors.append("process_cleanup_incomplete")
    if not raw_output_text.strip():
        validation_errors.append("empty_raw_output")
    validation_errors.extend(
        validate_transport_lines(raw_output_text, REVIEW_SKILL_NAME, skill_sha, request_id)
    )
    for line in sorted(required_raw_lines):
        if raw_output_lines.count(line) != 1:
            validation_errors.append(f"marker_count_invalid:{line}")

    transport_prefixes = (
        "REVIEW_SKILL=",
        "SKILL_SHA256=",
        "REVIEW_SESSION_POLICY=",
        "REVIEW_CHAIN_ID=",
        "REVIEW_SESSION_ID=",
        "SESSION_MODE=",
        "REQUEST_ID=",
    )
    body_lines = [
        line.rstrip()
        for line in raw_output_text.splitlines()
        if not line.strip().startswith(transport_prefixes)
    ]
    output_text = "\n".join(
        [
            f"REVIEW_SKILL={REVIEW_SKILL_NAME}",
            f"SKILL_SHA256={skill_sha}",
            f"REVIEW_SESSION_POLICY={REVIEW_SESSION_POLICY}",
            f"REVIEW_CHAIN_ID={review_chain_id}",
            f"REVIEW_SESSION_ID={session_id}",
            f"SESSION_MODE={session_mode}",
            f"REQUEST_ID={request_id}",
            *body_lines,
        ]
    ).rstrip() + "\n"
    atomic_write_text(output_path, output_text)
    output_lines = [line.strip() for line in output_text.splitlines()]

    required_final_lines = {
        f"REVIEW_SKILL={REVIEW_SKILL_NAME}",
        f"SKILL_SHA256={skill_sha}",
        f"REVIEW_SESSION_POLICY={REVIEW_SESSION_POLICY}",
        f"REVIEW_CHAIN_ID={review_chain_id}",
        f"REVIEW_SESSION_ID={session_id}",
        f"SESSION_MODE={session_mode}",
        f"REQUEST_ID={request_id}",
    }
    for line in sorted(required_final_lines):
        if output_lines.count(line) != 1:
            validation_errors.append(f"final_marker_count_invalid:{line}")
    if request_kind == "STATUS":
        required_output_fields = (
            "STATUS",
            "EVIDENCE_ASSESSMENT",
            "MODE_AND_ROI",
            "NEXT_ACTION",
        )
    else:
        required_output_fields = (
            "RULING",
            "DECISION",
            "AUTHORIZED_SCOPE",
            "PROHIBITED_ACTIONS",
            "EVIDENCE_ASSESSMENT",
            "MODE_AND_ROI",
            "NEXT_ACTION",
        )
    for field in required_output_fields:
        if sum(line.startswith(f"{field}=") for line in output_lines) != 1:
            validation_errors.append(f"missing_or_duplicate_{field}")
    if request_kind == "STATUS":
        # STATUS 只回答只读状态，不得夹带审批裁决字段（防"状态"伪装成"审批"）。
        for forbidden in ("RULING", "DECISION", "AUTHORIZED_SCOPE", "PROHIBITED_ACTIONS"):
            if any(line.startswith(f"{forbidden}=") for line in output_lines):
                validation_errors.append(f"status_must_not_carry_{forbidden.lower()}")
    else:
        # 双向互斥：RULING 类请求也不得夹带 STATUS 字段，否则该输出的下一轮续审会被拒绝。
        if any(line.startswith("STATUS=") for line in output_lines):
            validation_errors.append("ruling_must_not_carry_status")
    if request_kind != "STATUS":
        ruling_values = [
            line.removeprefix("RULING=")
            for line in output_lines
            if line.startswith("RULING=")
        ]
        if len(ruling_values) == 1 and ruling_values[0] not in {
            "APPROVED",
            "REJECTED",
            "BLOCKED",
            "USER_DECISION_REQUIRED",
        }:
            validation_errors.append(f"invalid_RULING:{ruling_values[0]}")

    validation = "PASS" if not validation_errors else "FAIL"
    try:
        cli_version = subprocess.run(
            [codex_path, "--version"], capture_output=True, text=True, encoding="utf-8",
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        cli_version = "UNKNOWN"
    receipt = {
        "request_id": request_id,
        "request_kind": request_kind,
        "task": task_name,
        "source_executor": args.source_executor,
        "session_policy": REVIEW_SESSION_POLICY,
        "review_chain_id": review_chain_id,
        "session_mode": session_mode,
        "session_id": session_id,
        "resumed_from_session_id": resume_session_id,
        "prior_request_id": prior_request_id,
        "prior_ruling": prior_ruling,
        "prior_receipt_file": (
            str(output_dir / f"{prior_request_id}.receipt.json") if prior_request_id else ""
        ),
        "review_skill": REVIEW_SKILL_NAME,
        "skill_sha256": skill_sha,
        "launcher_sha256": launcher_sha,
        "model_pin": {
            "model": EXPECTED_CODEX_MODEL,
            "model_reasoning_effort": EXPECTED_CODEX_EFFORT,
            "enforcement": "cli_config_override",
        },
        "memory_policy": "DISABLED_PLATFORM_MEMORY_SESSION_CONTEXT_ALLOWED",
        "git_safe_directory_policy": "PROCESS_LOCAL_ENV",
        "cli_version": cli_version,
        "failure_reason": run_result["failure_reason"],
        "cleanup_complete": run_result["cleanup_complete"],
        "recovery_allowed": bool(validation == "FAIL" and session_id
                                 and run_result["cleanup_complete"]),
        "timeout_seconds": args.timeout_seconds,
        "idle_timeout_seconds": args.idle_timeout_seconds,
        "request_file": str(request_file),
        "request_sha256": request_sha,
        "prompt_sha256": prompt_sha,
        "context_sha256": context_sha,
        "context_files": current_context_hashes,
        "context_changed": context_changed,
        "candidate_identity": candidate_identity,
        "repo_root": str(repo_root),
        "standard_root": str(standard_root),
        "started_at": started_at,
        "finished_at": finished_at,
        "cli_exit_code": cli_exit_code,
        "usage": parse_usage(events_path),
        "validation": validation,
        "validation_errors": validation_errors,
        "output_file": str(output_path),
        "output_sha256": sha256_file(output_path),
        "raw_output_file": str(raw_output_path),
        "raw_output_sha256": sha256_file(raw_output_path) if raw_output_path.exists() else "",
        "events_file": str(events_path),
        "events_sha256": sha256_file(events_path),
        "stderr_file": str(stderr_path),
        "stderr_sha256": sha256_file(stderr_path),
    }
    atomic_write_json(receipt_path, receipt)

    cleanup_lock()
    cleanup_request_lock()
    atexit.unregister(cleanup_lock)
    atexit.unregister(cleanup_request_lock)

    print(json.dumps(receipt, ensure_ascii=False, indent=2))
    return 0 if validation == "PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, FileExistsError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2)
