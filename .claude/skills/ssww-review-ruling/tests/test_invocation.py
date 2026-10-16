#!/usr/bin/env python3
"""ssww-review-ruling 调用器的公开入口验证（无害进程夹具，不冒充真实审核）。

全部用例经 main() 产品入口驱动（本地 codex 替身 = cmd 包装层 + python 孙/重孙进程，
复现 codex.CMD → node 的多层进程树），另含同秒 receipt 决胜与 CODEX_HOME 哨兵的
单元正负例。夹具只验证传输与回收行为，不产生任何真实审核结论。
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
_spec = importlib.util.spec_from_file_location("invoke_ssww_review", SCRIPTS / "invoke_ssww_review.py")
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)

STUB_SRC = '''import json, os, subprocess, sys, time, uuid

# main() 在审核后会调 `codex --version` 记录 CLI 版本:替身必须立即响应且不碰 stdin
if "--version" in sys.argv:
    print("codex-cli 0.0.0-stub", flush=True)
    sys.exit(0)

mode = os.environ.get("STUB_MODE", "ok")
here = os.path.dirname(os.path.abspath(__file__))
prompt = sys.stdin.read()
fields = {}
for line in prompt.splitlines():
    for key in ("REVIEW_SKILL", "SKILL_SHA256", "REQUEST_ID"):
        if line.startswith(key + "=") and key not in fields:
            fields[key] = line[len(key) + 1:]
print(json.dumps({"type": "thread.started", "thread_id": str(uuid.uuid4())}), flush=True)
if mode == "orphan":
    # 夹具:包装层立刻退出,遗留一个沉睡的孙进程(复现 cmd 退出而 node 存活)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    with open(os.path.join(here, "grandchild_pid.txt"), "w") as fh:
        fh.write(str(child.pid))
with open(os.path.join(here, "argv.json"), "w", encoding="utf-8") as fh:
    json.dump(sys.argv[1:], fh, ensure_ascii=False)
if mode == "hang":
    with open(os.path.join(here, "stub_pid.txt"), "w") as fh:
        fh.write(str(os.getpid()))
    sys.stdout.flush()
    time.sleep(600)
out = sys.argv[sys.argv.index("--output-last-message") + 1]
lines = [
    "REVIEW_SKILL=" + fields.get("REVIEW_SKILL", "ssww-review-ruling"),
    "SKILL_SHA256=" + fields.get("SKILL_SHA256", ""),
    "REQUEST_ID=" + fields.get("REQUEST_ID", ""),
    "RULING=APPROVED", "DECISION=夹具通过", "AUTHORIZED_SCOPE=夹具",
    "PROHIBITED_ACTIONS=无", "EVIDENCE_ASSESSMENT=stub", "MODE_AND_ROI=stub",
    "NEXT_ACTION=无",
]
with open(out, "w", encoding="utf-8", newline="\\n") as fh:
    fh.write("\\n".join(lines) + "\\n")
'''


def pid_alive(pid: int) -> bool:
    # tasklist 中文输出是 GBK:只解析 PID 列,解码用 errors="replace" 容错;
    # 查询本身失败(returncode!=0)按存活处理——独立消亡检查不允许把查询失败当消亡
    result = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                            capture_output=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        return True
    for line in (result.stdout or "").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == str(pid):
            return True
    return False


def wait_pid_gone(pid: int, seconds: float = 15.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.3)
    return False


class InvocationMainTests(unittest.TestCase):
    """经 main() 产品入口的传输与回收行为（codex 替身 = cmd 包装 + python 进程树）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name).resolve()
        self.root = root
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "tester"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "t@t"], cwd=root, check=True)
        (root / "AGENTS.md").write_text("agents\n", encoding="utf-8")
        # 独立 CODEX_HOME:同时验证哨兵读取随 CODEX_HOME 漂移
        codex_home = root / "codex-home"
        codex_home.mkdir()
        (codex_home / "config.toml").write_text(
            'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n', encoding="utf-8")
        self._old_codex_home = os.environ.get("CODEX_HOME")
        os.environ["CODEX_HOME"] = str(codex_home)
        # codex 替身:cmd 包装层 + python stub(多层进程树)
        stub_dir = root / "stub"
        stub_dir.mkdir()
        (stub_dir / "stub_codex.py").write_text(STUB_SRC, encoding="utf-8")
        self.stub_dir = stub_dir
        cmd = stub_dir / "codex.cmd"
        cmd.write_text(f'@echo off\r\n"{sys.executable}" "%~dp0stub_codex.py" %*\r\n',
                       encoding="utf-8")
        self.stub_cmd = cmd
        self._which_patcher = mock.patch("shutil.which", return_value=str(cmd))
        self._which_patcher.start()
        self._old_mode = os.environ.pop("STUB_MODE", None)

    def tearDown(self) -> None:
        self._which_patcher.stop()
        if self._old_codex_home is None:
            os.environ.pop("CODEX_HOME", None)
        else:
            os.environ["CODEX_HOME"] = self._old_codex_home
        if self._old_mode is not None:
            os.environ["STUB_MODE"] = self._old_mode
        else:
            os.environ.pop("STUB_MODE", None)
        if os.environ.get("SSWW_TEST_KEEP_TMP") != "1":
            self._tmp.cleanup()

    def run_main(self, req_id: str, chain: str, extra_args: list[str] = (),
                 expected_exit: int = 0) -> dict:
        request = self.root / f"request-{req_id}.txt"
        request.write_text(
            f"REQUEST_KIND=RULING\nREQUEST_ID={req_id}\nTASK=夹具传输验证\n", encoding="utf-8")
        old_argv = sys.argv
        sys.argv = ["invoke_ssww_review.py", "--repo-root", str(self.root),
                    "--request-file", str(request), "--review-chain-id", chain,
                    "--source-executor", "CLAUDE_CLI", *extra_args]
        try:
            exit_code = mod.main()
        finally:
            sys.argv = old_argv
        if exit_code != 0:
            receipt_path = self.root / ".tmp" / "codex-rulings" / f"{req_id}.receipt.json"
            if receipt_path.exists():
                data = json.loads(receipt_path.read_text(encoding="utf-8"))
                print(f"\n[诊断] exit={exit_code} validation={data.get('validation')} "
                      f"errors={data.get('validation_errors')} "
                      f"failure={data.get('failure_reason')} cleanup={data.get('cleanup_complete')}")
            else:
                print(f"\n[诊断] exit={exit_code} receipt 未生成")
        self.assertEqual(exit_code, expected_exit)
        receipt_path = self.root / ".tmp" / "codex-rulings" / f"{req_id}.receipt.json"
        return json.loads(receipt_path.read_text(encoding="utf-8"))

    def test_transmission_pass_and_model_pin_in_argv(self) -> None:
        receipt = self.run_main("REQ-STUB-OK-01", "stub-chain-ok")
        self.assertEqual(receipt["validation"], "PASS")
        self.assertEqual(receipt["cli_exit_code"], 0)
        self.assertTrue(receipt["cleanup_complete"])
        self.assertTrue(receipt["session_id"])
        self.assertEqual(receipt["model_pin"]["model"], "gpt-6.1-sol")
        argv = json.loads((self.stub_dir / "argv.json").read_text(encoding="utf-8"))
        # 模型以命令行覆盖钉死(优先级高于项目级配置与 CODEX_HOME)
        self.assertIn("-c", argv)
        self.assertIn('model="gpt-6.1-sol"', argv)
        self.assertIn('model_reasoning_effort="xhigh"', argv)

    def test_wrapper_exit_orphan_grandchild_reclaimed(self) -> None:
        # 包装层立刻退出、孙进程沉睡 120 秒:Job Object 必须回收整棵树
        os.environ["STUB_MODE"] = "orphan"
        receipt = self.run_main("REQ-STUB-ORPHAN-01", "stub-chain-orphan")
        self.assertTrue(receipt["cleanup_complete"])
        pid_text = (self.stub_dir / "grandchild_pid.txt").read_text(encoding="utf-8").strip()
        self.assertTrue(wait_pid_gone(int(pid_text)),
                        f"孙进程 {pid_text} 在调用器返回后仍存活(回收失职)")

    def test_idle_timeout_reclaims_hung_tree(self) -> None:
        os.environ["STUB_MODE"] = "hang"
        # 超时路径 validation=FAIL(cli_exit_code=124),这是预期合同:回收已确认、锁可恢复
        receipt = self.run_main("REQ-STUB-HANG-01", "stub-chain-hang",
                                ["--idle-timeout-seconds", "2", "--timeout-seconds", "120"],
                                expected_exit=1)
        self.assertEqual(receipt["failure_reason"], "idle_timeout")
        self.assertTrue(receipt["cleanup_complete"])
        stub_pid = int((self.stub_dir / "stub_pid.txt").read_text(encoding="utf-8").strip())
        self.assertTrue(wait_pid_gone(stub_pid), "挂起的替身进程未被回收")

    def test_model_config_sentinel_rejects_wrong_model(self) -> None:
        # 哨兵读 CODEX_HOME 漂移后的配置:模型不符即拒绝发审
        config = Path(os.environ["CODEX_HOME"]) / "config.toml"
        config.write_text('model = "other-model"\nmodel_reasoning_effort = "xhigh"\n',
                          encoding="utf-8")
        with self.assertRaises(SystemExit):
            self.run_main("REQ-STUB-BADMODEL-01", "stub-chain-badmodel")

    def test_job_unavailable_aborts_before_launch(self) -> None:
        # Job 创建失败:必须禁止启动审核进程(fail-closed),不得遗留无法归属的进程
        with mock.patch.object(mod, "create_cleanup_job", return_value=None):
            receipt = self.run_main("REQ-STUB-NOJOB-01", "stub-chain-nojob", expected_exit=1)
        self.assertEqual(receipt["failure_reason"], "job_unavailable")
        self.assertTrue(receipt["cleanup_complete"])
        self.assertFalse(receipt["recovery_allowed"])
        self.assertFalse((self.stub_dir / "argv.json").exists(), "进程不应被启动")

    def test_job_assign_failure_terminates_suspended_root(self) -> None:
        # 入组失败:挂起根进程必须被终止并确认消亡,不得误报空 Job 清理成功
        with mock.patch.object(mod, "assign_process_to_job", return_value=False):
            receipt = self.run_main("REQ-STUB-NOASSIGN-01", "stub-chain-noassign",
                                    expected_exit=1)
        self.assertEqual(receipt["failure_reason"], "job_assignment_failed")
        self.assertTrue(receipt["cleanup_complete"])
        self.assertFalse(receipt["recovery_allowed"])

    def test_resume_failure_generates_failed_receipt(self) -> None:
        # 恢复接口缺失/失败:走 resume_failed 失败 receipt 路径,整树回收后锁可核查
        with mock.patch.object(mod, "resume_suspended_process", return_value=False):
            receipt = self.run_main("REQ-STUB-NORESUME-01", "stub-chain-noresume",
                                    expected_exit=1)
        self.assertEqual(receipt["failure_reason"], "resume_failed")
        self.assertTrue(receipt["cleanup_complete"])

    def test_cleanup_timeout_keeps_lock_unrecoverable(self) -> None:
        # 收尾验证超时(成员查询永不清空):cleanup_complete=False、recovery_allowed=False
        with mock.patch.object(mod, "job_process_ids", return_value=[999999]):
            receipt = self.run_main("REQ-STUB-CLEANUP-01", "stub-chain-cleanup",
                                    expected_exit=1)
        self.assertFalse(receipt["cleanup_complete"])
        self.assertFalse(receipt["recovery_allowed"])
        self.assertIn("process_cleanup_incomplete", receipt["validation_errors"])


class HelperUnitTests(unittest.TestCase):
    """同秒 receipt 决胜等辅助逻辑单元测试。"""

    def test_same_second_receipt_resolved_by_mtime_ns(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            base = time.time()
            for name, offset in (("a", 0.0), ("b", 0.5)):
                path = out_dir / f"{name}.receipt.json"
                path.write_text(json.dumps({
                    "review_chain_id": "chain-x", "session_id": str(uuid.uuid4()),
                    "finished_at": "2026-10-16T03:00:00Z",
                }), encoding="utf-8")
                stamp = (base + offset) * 1_000_000_000
                os.utime(path, ns=(int(stamp), int(stamp)))
            picked = mod.select_latest_chain_receipt(out_dir, "chain-x")
            self.assertEqual(picked[0].name, "b.receipt.json")

    def test_other_chain_receipts_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            (out_dir / "other.receipt.json").write_text(json.dumps({
                "review_chain_id": "chain-other", "session_id": str(uuid.uuid4()),
                "finished_at": "2026-10-16T03:00:00Z",
            }), encoding="utf-8")
            self.assertIsNone(mod.select_latest_chain_receipt(out_dir, "chain-x"))

    def test_no_session_receipt_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            (out_dir / "nosession.receipt.json").write_text(json.dumps({
                "review_chain_id": "chain-x", "session_id": "",
                "finished_at": "2026-10-16T03:00:00Z",
            }), encoding="utf-8")
            self.assertIsNone(mod.select_latest_chain_receipt(out_dir, "chain-x"))

    def test_pid_alive_fail_closed_on_query_failure(self) -> None:
        # tasklist 查询失败(returncode!=0)必须按存活处理,不得误判消亡
        failed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="")
        with mock.patch("test_invocation.subprocess.run", return_value=failed):
            self.assertTrue(pid_alive(12345))


if __name__ == "__main__":
    unittest.main()
