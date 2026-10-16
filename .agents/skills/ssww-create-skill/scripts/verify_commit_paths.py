#!/usr/bin/env python3
"""在隔离临时 git 仓库中验证 ssww-skill-gate.sh 提交门禁的完整路径。

正例:新增交付、局部更新、中文文件名交付。
负例:夹带保护(保留用户暂存)、忽略文件遗漏、request 改写、REJECTED 裁决、
快照后改写拒绝、符号链接(无特权时 SKIP)。
receipt/快照/索引锚定为测试夹具(仅在隔离仓库内自洽),不冒充真实审核证据。
负例必须以预期原因失败(断言诊断文本),不允许"错因通过"。
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

GATE_SRC = Path(__file__).resolve().parents[1] / "scripts" / "ssww-skill-gate.sh"


def find_git_bash() -> str:
    """从 git.exe 位置推导 Git Bash,避免 subprocess 解析到 WSL 的 System32\\bash.exe。

    优先 usr/bin/bash.exe:bin/bash.exe 是登录包装器,会重置 PATH,导致
    PATH 注入(git/cp 失败注入等)失效(REQ-SSWW-CREATESKILL-07 轮实测教训)。
    """
    git = shutil.which("git")
    if git:
        for ancestor in Path(git).resolve().parents:
            for candidate in (ancestor / "usr" / "bin" / "bash.exe", ancestor / "bin" / "bash.exe"):
                if candidate.is_file():
                    return str(candidate)
    fallback = shutil.which("bash")
    if not fallback:
        raise SystemExit("找不到 bash")
    return fallback


BASH = find_git_bash()
RESULTS: list[tuple[str, str, str]] = []  # (名称, PASS/FAIL/SKIP, 说明)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_text_lf(path: Path, text: str) -> None:
    """夹具一律 LF:Python 默认在 Windows 写 CRLF,会使门禁 diff 漂移误报(实测教训)。"""
    path.write_text(text, encoding="utf-8", newline="\n")


def run(cmd: list[str], cwd: Path, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    # errors="replace":UTF-8 中文输出在 GBK 默认解码下会使读取线程崩溃、stderr 变 None(实测教训)
    # 门禁内嵌 python 默认按 locale(GBK)打印,而本 harness 固定按 UTF-8 解码,
    # 故向子进程注入 UTF-8 模式,消除对调用环境变量(PYTHONUTF8)的隐式依赖(REQ-11 轮实测教训)
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    if env_extra:
        env.update(env_extra)
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=env)


def write_skill(root: Path) -> None:
    skill = root / ".claude" / "skills" / "fakeskill"
    (skill / "references").mkdir(parents=True, exist_ok=True)
    write_text_lf(skill / "SKILL.md",
                  "---\nname: fakeskill\n"
                  "description: 隔离仓库验证用假skill的描述,长度超过二十字符\n"
                  "metadata:\n  version: 0.1.0\n---\n\n# t\n自进化流程\n")
    write_text_lf(skill / "references" / "changelog.md", "# c\n")
    # 审核技能替身(供 review_evidence_check 校验 skill_sha/launcher_sha)
    rev = root / ".claude" / "skills" / "ssww-review-ruling" / "scripts"
    rev.mkdir(parents=True, exist_ok=True)
    write_text_lf(root / ".claude" / "skills" / "ssww-review-ruling" / "SKILL.md",
                  "fake review skill\n")
    write_text_lf(rev / "invoke_ssww_review.py", "# fake launcher\n")
    # 镜像:fakeskill 用 Junction(生产形态);审核技能替身用真实拷贝
    import _winapi
    dst = root / ".agents" / "skills" / "fakeskill"
    dst.parent.mkdir(parents=True, exist_ok=True)
    _winapi.CreateJunction(str(root / ".claude" / "skills" / "fakeskill"), str(dst))
    rev_src = root / ".claude" / "skills" / "ssww-review-ruling"
    rev_dst = root / ".agents" / "skills" / "ssww-review-ruling"
    rev_dst.mkdir(parents=True, exist_ok=True)
    for f in rev_src.rglob("*"):
        if f.is_file():
            target = rev_dst / f.relative_to(rev_src)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, target)
    write_text_lf(root / "AGENTS.md", "agents\n")
    std = root / "docs" / "standards"
    std.mkdir(parents=True, exist_ok=True)
    write_text_lf(std / "审核裁决协议.md", "protocol\n")
    write_text_lf(std / "TDD_Standard.md", "tdd\n")


def candidate_files(skills_root: Path, name: str) -> list[str]:
    return sorted(
        str(p.relative_to(skills_root)).replace("\\", "/")
        for p in (skills_root / name).rglob("*")
        if p.is_file() and ".tmp" not in p.parts and "__pycache__" not in p.parts
        and not p.name.endswith(".pyc"))


def write_blob_map(root: Path, req_id: str, blob_override: str | None = None) -> str:
    """索引锚定夹具:与门禁 identity 同法(git hash-object --path 走 clean 过滤),
    格式 `<blob>  <完整路径>`,并写绑定哈希 .candidate.blob.sha256。
    blob_override 注入错误锚定值(其余身份自洽),用于验证最终索引身份检查。"""
    lines = []
    skills_root = root / ".claude" / "skills"
    for rel in candidate_files(skills_root, "fakeskill"):
        result = run(["git", "-C", str(root), "hash-object", "--path",
                      f".claude/skills/{rel}", str(skills_root / rel)], root)
        if result.returncode != 0:
            raise SystemExit(f"夹具 blob 锚定失败: {rel}: {result.stderr}")
        blob = result.stdout.strip()
        if blob_override:
            blob = blob_override
        lines.append(f"{blob}  {rel}")
    blobmap = root / ".tmp" / "codex-rulings" / f"{req_id}.candidate.blob"
    write_text_lf(blobmap, "\n".join(lines) + "\n")
    blob_sha = sha(blobmap)
    write_text_lf(root / ".tmp" / "codex-rulings" / f"{req_id}.candidate.blob.sha256",
                  blob_sha + "\n")
    return blob_sha


def write_request(root: Path, req_id: str, blob_sha: str) -> Path:
    request = root / ".claude" / "skills" / ".tmp" / "review" / f"request-{req_id}.txt"
    request.parent.mkdir(parents=True, exist_ok=True)
    skills_root = root / ".claude" / "skills"
    cand_lines = "\n".join(
        f"{sha(skills_root / rel)}  {rel}" for rel in candidate_files(skills_root, "fakeskill"))
    write_text_lf(request,
                  f"REQUEST_KIND=RULING\nREQUEST_ID={req_id}\nTASK=夹具\n"
                  f"BLOB_ANCHOR_SHA256={blob_sha}\n\n## 候选身份\n\n{cand_lines}\n")
    return request


def fabricate_receipt(root: Path, req_id: str, ruling: str = "APPROVED",
                      blob_override: str | None = None) -> None:
    """在隔离仓库内构造身份自洽的证据链(仅测试夹具)。"""
    rulings = root / ".tmp" / "codex-rulings"
    rulings.mkdir(parents=True, exist_ok=True)
    skill_md = root / ".claude" / "skills" / "ssww-review-ruling" / "SKILL.md"
    launcher = root / ".claude" / "skills" / "ssww-review-ruling" / "scripts" / "invoke_ssww_review.py"
    blob_sha = write_blob_map(root, req_id, blob_override)
    request = write_request(root, req_id, blob_sha)
    write_text_lf(rulings / f"{req_id}.txt",
                  f"REVIEW_SKILL=ssww-review-ruling\nSKILL_SHA256={sha(skill_md)}\n"
                  f"REQUEST_ID={req_id}\nRULING={ruling}\nDECISION=夹具\nNEXT_ACTION=无\n")
    # 上下文与基准夹具(REQ-CARRY-01)一致:复算 bundle 用同一构造
    ctx_files = {
        str(root / "AGENTS.md"): sha(root / "AGENTS.md"),
        str(root / "docs" / "standards" / "审核裁决协议.md"): sha(root / "docs" / "standards" / "审核裁决协议.md"),
        str(root / "docs" / "standards" / "TDD_Standard.md"): sha(root / "docs" / "standards" / "TDD_Standard.md"),
        str(skill_md): sha(skill_md),
    }
    bundle = hashlib.sha256(json.dumps(
        ctx_files, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    receipt = {
        "request_id": req_id, "validation": "PASS", "cli_exit_code": 0,
        "request_file": str(request), "request_sha256": sha(request),
        "skill_sha256": sha(skill_md), "launcher_sha256": sha(launcher),
        "output_sha256": sha(rulings / f"{req_id}.txt"),
        "context_files": ctx_files, "context_sha256": bundle,
    }
    # 紧凑 JSON:与真实调用器 receipt 格式一致(门禁按无空格形式 grep)
    write_text_lf(rulings / f"{req_id}.receipt.json",
                  json.dumps(receipt, ensure_ascii=False, separators=(",", ":")) + "\n")
    skills_root = root / ".claude" / "skills"
    lines = [f"{sha(skills_root / rel)}  {rel}" for rel in candidate_files(skills_root, "fakeskill")]
    write_text_lf(rulings / f"{req_id}.candidate.sha", "\n".join(lines) + "\n")


def gate(root: Path, *args: str, env_extra: dict | None = None) -> subprocess.CompletedProcess:
    # 必须调用临时仓库内的 gate 副本:脚本按自身位置推导 SKILLS_ROOT/WORKSPACE_ROOT
    gate_copy = root / ".claude" / "skills" / "ssww-create-skill" / "scripts" / "ssww-skill-gate.sh"
    return run([BASH, gate_copy.as_posix(), *args], cwd=root, env_extra=env_extra)


def scenario(name: str, expect_ok: bool, result: subprocess.CompletedProcess,
             expected_reason: str | None = None) -> None:
    """负例必须以预期原因失败(断言诊断文本),不能错因通过。"""
    output = (result.stdout or "") + (result.stderr or "")
    code_ok = (result.returncode == 0) == expect_ok
    reason_ok = expected_reason is None or expected_reason in output
    status = "PASS" if (code_ok and reason_ok) else "FAIL"
    RESULTS.append((name, status, f"exit={result.returncode}"))
    print(f"[{status}] {name}: exit={result.returncode} "
          f"code_ok={code_ok} reason_ok={reason_ok}")
    print("---- 完整输出 ----")
    print(output.strip() if output.strip() else "(空)")
    print("---- 输出结束 ----")


def main(selftest_fail: bool = False) -> int:
    print("== 提交门禁隔离验证 ==")
    print(f"命令: python {Path(__file__).name}{' --selftest-fail' if selftest_fail else ''}")
    print(f"工作目录: {Path.cwd()}")
    print(f"门禁脚本 SHA-256: {sha(GATE_SRC)}")
    print(f"harness SHA-256: {sha(Path(__file__).resolve())}")
    print()
    if selftest_fail:
        # 失败注入必须经 main 的统计与 return 路径(不能旁路,否则验证不出"丢失 return"回归)
        RESULTS.append(("selftest 注入失败", "FAIL", "selftest"))
        return _finalize()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory).resolve()
        run(["git", "init", "-q"], root)
        run(["git", "config", "user.name", "tester"], root)
        run(["git", "config", "user.email", "t@t"], root)
        gate_scripts = root / ".claude" / "skills" / "ssww-create-skill" / "scripts"
        gate_scripts.mkdir(parents=True, exist_ok=True)
        shutil.copy2(GATE_SRC, gate_scripts / "ssww-skill-gate.sh")
        # 与主仓库一致的 .gitignore 形态(build/ 用于忽略文件场景)
        write_text_lf(root / ".gitignore", "build/\n.tmp/\n__pycache__/\n")
        write_skill(root)
        # 基线只含上下文与审核技能替身;候选 skill 是未提交的新文件(模拟真实交付)
        run(["git", "add", "AGENTS.md", "docs", ".gitignore", ".claude/skills/ssww-review-ruling",
             ".agents/skills/ssww-review-ruling", ".claude/skills/ssww-create-skill"], root)
        run(["git", "commit", "-q", "-m", "chore(test): 基线"], root)

        # 场景1:新增交付(正)
        fabricate_receipt(root, "REQ-NEW-01")
        r = gate(root, "commit", "fakeskill", "feat(fakeskill): 新增交付路径验证", "REQ-NEW-01")
        scenario("新增交付", True, r)

        # 场景2:局部更新(正)
        skill_md = root / ".claude" / "skills" / "fakeskill" / "SKILL.md"
        write_text_lf(skill_md, skill_md.read_text(encoding="utf-8").replace("0.1.0", "0.2.0"))
        mirror = root / ".agents" / "skills" / "fakeskill" / "SKILL.md"
        write_text_lf(mirror, skill_md.read_text(encoding="utf-8"))
        fabricate_receipt(root, "REQ-PARTIAL-01")
        r = gate(root, "commit", "fakeskill", "feat(fakeskill): 局部更新路径验证", "REQ-PARTIAL-01")
        scenario("局部更新", True, r)

        # 场景3:夹带保护(负,且必须保留用户其他暂存)
        outside = root / "outside-file.txt"
        write_text_lf(outside, "user staged\n")
        run(["git", "add", "outside-file.txt"], root)
        fabricate_receipt(root, "REQ-CARRY-01")
        r = gate(root, "commit", "fakeskill", "feat(fakeskill): 夹带拒绝验证", "REQ-CARRY-01")
        still_staged = "outside-file.txt" in run(
            ["git", "diff", "--cached", "--name-only"], root).stdout
        scenario("夹带拒绝", False, r, expected_reason="暂存区存在候选目录外文件")
        RESULTS.append(("夹带拒绝保留用户暂存", "PASS" if still_staged else "FAIL", "still_staged"))
        print(f"[{'PASS' if still_staged else 'FAIL'}] 夹带拒绝保留用户暂存: still_staged={still_staged}")
        run(["git", "reset", "-q", "HEAD", "outside-file.txt"], root)

        # 场景4:符号链接拒绝(负)。只在真身创建一次(junction 是同一文件的另一视图);
        # 仅权限不足(1314)记 SKIP,其他异常直接失败。
        try:
            link = root / ".claude" / "skills" / "fakeskill" / "linked.md"
            os.symlink(root / ".claude" / "skills" / "fakeskill" / "SKILL.md", link)
        except OSError as error:
            if getattr(error, "winerror", None) == 1314:
                RESULTS.append(("符号链接拒绝", "SKIP", "无 Symlink 特权"))
                print(f"[SKIP] 符号链接拒绝: {error}")
                link = None
            else:
                raise
        if link is not None:
            fabricate_receipt(root, "REQ-SYMLINK-01")
            r = gate(root, "commit", "fakeskill", "feat(fakeskill): 符号链接拒绝验证", "REQ-SYMLINK-01")
            scenario("符号链接拒绝", False, r, expected_reason="非法模式")
            # 夹具清理:拒绝对象不得滞留污染后续场景(有权限分支)
            link.unlink(missing_ok=True)

        # 场景5:被 .gitignore 忽略的候选文件必须拒绝(防静默遗漏已送审资源)
        ignored_file = root / ".claude" / "skills" / "fakeskill" / "assets" / "build" / "required.json"
        ignored_file.parent.mkdir(parents=True, exist_ok=True)
        write_text_lf(ignored_file, "{}\n")
        mirror_ignored = root / ".agents" / "skills" / "fakeskill" / "assets" / "build" / "required.json"
        mirror_ignored.parent.mkdir(parents=True, exist_ok=True)
        write_text_lf(mirror_ignored, "{}\n")
        fabricate_receipt(root, "REQ-IGNORED-01")
        r = gate(root, "commit", "fakeskill", "feat(fakeskill): 忽略文件遗漏拒绝验证", "REQ-IGNORED-01")
        scenario("忽略文件遗漏拒绝", False, r, expected_reason="被 .gitignore 忽略")
        run(["git", "reset", "-q", "HEAD", "--", ".claude/skills/fakeskill", ".agents/skills/fakeskill"], root)
        shutil.rmtree(root / ".claude" / "skills" / "fakeskill" / "assets")
        shutil.rmtree(root / ".agents" / "skills" / "fakeskill" / "assets", ignore_errors=True)

        # 场景6:request 改写后过 review-gate 必须拒绝
        request_file = root / ".claude" / "skills" / ".tmp" / "review" / "request-REQ-CARRY-01.txt"
        original = request_file.read_text(encoding="utf-8")
        write_text_lf(request_file, original + "## 被篡改的追加内容\n")
        r = gate(root, "review-gate", "fakeskill", "REQ-CARRY-01")
        scenario("request 改写拒绝", False, r, expected_reason="request 已漂移")
        write_text_lf(request_file, original)

        # 场景7:REJECTED 裁决过 review-gate 必须拒绝(身份自洽夹具)
        fabricate_receipt(root, "REQ-REJ-01", ruling="REJECTED")
        r = gate(root, "review-gate", "fakeskill", "REQ-REJ-01")
        scenario("REJECTED 裁决拒绝", False, r, expected_reason="RULING=REJECTED")

        # 场景8:提交信息格式只查首行(负:正文中的合法格式行不得补足非法标题)
        write_text_lf(skill_md, skill_md.read_text(encoding="utf-8").replace("0.2.0", "0.3.0"))
        mirror_skill = root / ".agents" / "skills" / "fakeskill" / "SKILL.md"
        write_text_lf(mirror_skill, skill_md.read_text(encoding="utf-8"))
        fabricate_receipt(root, "REQ-MSG-01")
        r = gate(root, "commit", "fakeskill",
                 "更新门禁检查\n\ndocs(fakeskill): 完善门禁检查", "REQ-MSG-01")
        scenario("非法首行正文补足拒绝", False, r, expected_reason="提交信息不符合")

        # 场景9:合法首行+正文通过(msg_check 失败发生在暂存之前,工作树改动仍在)
        fabricate_receipt(root, "REQ-MSG-02")
        r = gate(root, "commit", "fakeskill",
                 "feat(fakeskill): 首行合法带正文\n\n正文补充说明,不影响首行检查。", "REQ-MSG-02")
        scenario("合法首行带正文", True, r)

        # 场景10:中文文件名交付(正;-z NUL 分隔 + quotepath=off,不误判夹带)
        chinese_real = root / ".claude" / "skills" / "fakeskill" / "references" / "中文说明.md"
        write_text_lf(chinese_real, "中文文件名交付正例\n")
        chinese_mirror = root / ".agents" / "skills" / "fakeskill" / "references" / "中文说明.md"
        chinese_mirror.parent.mkdir(parents=True, exist_ok=True)
        write_text_lf(chinese_mirror, "中文文件名交付正例\n")
        fabricate_receipt(root, "REQ-CHINESE-01")
        r = gate(root, "commit", "fakeskill", "feat(fakeskill): 中文文件名交付验证", "REQ-CHINESE-01")
        scenario("中文文件名交付", True, r)

        # 场景10b:含空格资源名交付(正;锚定按双空格分隔解析,完整路径不截断)
        space_real = root / ".claude" / "skills" / "fakeskill" / "references" / "a b.md"
        write_text_lf(space_real, "含空格资源名交付正例\n")
        space_mirror = root / ".agents" / "skills" / "fakeskill" / "references" / "a b.md"
        write_text_lf(space_mirror, "含空格资源名交付正例\n")
        fabricate_receipt(root, "REQ-SPACE-01")
        r = gate(root, "commit", "fakeskill", "feat(fakeskill): 含空格资源名交付验证", "REQ-SPACE-01")
        scenario("含空格资源名交付", True, r)

        # 场景11:快照后改写拒绝(负;提交校验以已审核身份为基准,不重新采信当前工作区)
        write_text_lf(skill_md, skill_md.read_text(encoding="utf-8").replace("0.3.0", "0.9.9"))
        write_text_lf(mirror_skill, mirror_skill.read_text(encoding="utf-8").replace("0.3.0", "0.9.9"))
        fabricate_receipt(root, "REQ-DRIFT-01")
        write_text_lf(skill_md, skill_md.read_text(encoding="utf-8").replace("0.9.9", "0.8.8"))
        write_text_lf(mirror_skill, mirror_skill.read_text(encoding="utf-8").replace("0.9.9", "0.8.8"))
        r = gate(root, "commit", "fakeskill", "feat(fakeskill): 快照后改写拒绝验证", "REQ-DRIFT-01")
        scenario("快照后改写拒绝", False, r, expected_reason="候选已漂移")

        # 场景12:锚定值被替换拒绝(负;.candidate.blob 被篡改 → 绑定哈希不符)
        blobmap = root / ".tmp" / "codex-rulings" / "REQ-CHINESE-01.candidate.blob"
        original_blob = blobmap.read_text(encoding="utf-8")
        first_blob = original_blob.split("  ", 1)[0]
        write_text_lf(blobmap, original_blob.replace(first_blob, "f" * 40, 1))
        r = gate(root, "commit", "fakeskill", "feat(fakeskill): 锚定替换拒绝验证", "REQ-CHINESE-01")
        scenario("锚定替换拒绝", False, r, expected_reason="索引锚定哈希不符")
        write_text_lf(blobmap, original_blob)

        # 场景13:索引身份拒绝(负;锚定值连同绑定哈希一起注入错误值,SHA 检查全部
        # 自洽通过,验证索引 blob 与锚定不符时由最终索引身份检查拒绝)
        fabricate_receipt(root, "REQ-DOCTOR-01", blob_override="f" * 40)
        r = gate(root, "commit", "fakeskill", "feat(fakeskill): 索引身份拒绝验证", "REQ-DOCTOR-01")
        scenario("索引身份拒绝", False, r, expected_reason="blob 漂移")

        # 场景14:普通目录镜像恢复(正;新检出形态,内容与候选逐字节一致时自动重建 junction)
        import _winapi
        mirror_dir = root / ".agents" / "skills" / "fakeskill"
        os.rmdir(mirror_dir)  # 只移除 junction 本身,不递归目标
        shutil.copytree(root / ".claude" / "skills" / "fakeskill", mirror_dir)
        r = gate(root, "link", "fakeskill")
        scenario("普通目录镜像恢复", True, r)
        restore_marked = "[恢复]" in (r.stdout or "") + (r.stderr or "")
        RESULTS.append(("恢复输出含重建标记", "PASS" if restore_marked else "FAIL", "marker"))
        print(f"[{'PASS' if restore_marked else 'FAIL'}] 恢复输出含重建标记: marker={restore_marked}")

        # 场景15:恢复拒绝差异文件(负;镜像多出用户文件 → 拒绝自动覆盖,不删除用户数据)
        os.rmdir(mirror_dir)
        shutil.copytree(root / ".claude" / "skills" / "fakeskill", mirror_dir)
        user_file = mirror_dir / "用户证据.txt"
        user_content = "用户数据\n"
        write_text_lf(user_file, user_content)
        r = gate(root, "link", "fakeskill")
        scenario("恢复拒绝差异文件", False, r, expected_reason="拒绝自动覆盖")
        # 完整性断言:用户文件必须存在且内容逐字节未变
        intact = user_file.exists() and user_file.read_bytes() == user_content.encode("utf-8")
        RESULTS.append(("差异文件完整保留", "PASS" if intact else "FAIL", "intact"))
        print(f"[{'PASS' if intact else 'FAIL'}] 差异文件完整保留: intact={intact}")
        shutil.rmtree(mirror_dir)  # 清理差异镜像(测试夹具,内容已知)
        _winapi.CreateJunction(str(root / ".claude" / "skills" / "fakeskill"), str(mirror_dir))

        # 场景16:恢复清单读取失败注入(负;镜像含不可读文件 → 清单生成失败必须拒绝,
        # 不得"读取失败后恰好一致"地进入删除)
        os.rmdir(mirror_dir)
        shutil.copytree(root / ".claude" / "skills" / "fakeskill", mirror_dir)
        locked = mirror_dir / "锁定文件.txt"
        locked_bytes = "不可读的用户数据\n".encode("utf-8")
        locked.write_bytes(locked_bytes)
        # 只拒数据读(RD),不拒 READ_CONTROL——否则 icacls /reset 自身也被拒,deny 残留
        deny = run(["icacls", str(locked), "/deny", "Everyone:(RD)"], root)
        if deny.returncode != 0:
            RESULTS.append(("读取失败注入", "SKIP", f"icacls 不可用: rc={deny.returncode}"))
            print(f"[SKIP] 读取失败注入: icacls rc={deny.returncode}")
        else:
            r = gate(root, "link", "fakeskill")
            scenario("读取失败拒绝恢复", False, r, expected_reason="拒绝自动覆盖")
            intact = locked.exists() and locked.stat().st_size == len(locked_bytes)
            RESULTS.append(("不可读文件完整保留", "PASS" if intact else "FAIL", "intact"))
            print(f"[{'PASS' if intact else 'FAIL'}] 不可读文件完整保留: intact={intact}")
            run(["icacls", str(locked), "/reset"], root)
        shutil.rmtree(mirror_dir, ignore_errors=True)
        _winapi.CreateJunction(str(root / ".claude" / "skills" / "fakeskill"), str(mirror_dir))

        # identity 公开入口场景(17-20):正常生成与三条失败路径,负例均断言无三件套残留
        rulings_dir = root / ".tmp" / "codex-rulings"
        trio = (".candidate.sha", ".candidate.blob", ".candidate.blob.sha256")

        def trio_absent(req_id: str) -> bool:
            return not any((rulings_dir / f"{req_id}{suffix}").exists() for suffix in trio)

        # 场景17:identity 正常生成(正;三件套齐全 + 独立 BLOB_ANCHOR 行)
        r = gate(root, "identity", "fakeskill", "REQ-ID-NORMAL-01")
        scenario("identity 正常生成", True, r)
        id_out = (r.stdout or "") + (r.stderr or "")
        anchor_lines = [ln for ln in id_out.splitlines() if ln.startswith("BLOB_ANCHOR_SHA256=")]
        id_ok = (len(anchor_lines) == 1
                 and all((rulings_dir / f"REQ-ID-NORMAL-01{s}").is_file() for s in trio))
        RESULTS.append(("identity三件套与独立锚定行", "PASS" if id_ok else "FAIL", "identity"))
        print(f"[{'PASS' if id_ok else 'FAIL'}] identity三件套与独立锚定行")

        # 场景18:目录枚举失败拒绝(负;references 不可列 → 清单生成失败,无残留)
        # 只拒 RD(列目录):保留 READ_CONTROL,确保 /reset 可执行、deny 不残留污染
        refs_dir = root / ".claude" / "skills" / "fakeskill" / "references"
        run(["icacls", str(refs_dir), "/deny", "Everyone:(RD)"], root)
        r = gate(root, "identity", "fakeskill", "REQ-ID-ENUM-FAIL-01")
        scenario("identity 枚举失败拒绝", False, r, expected_reason="候选清单生成失败")
        RESULTS.append(("枚举失败无三件套残留", "PASS" if trio_absent("REQ-ID-ENUM-FAIL-01") else "FAIL", "cleanup"))
        print(f"[{'PASS' if trio_absent('REQ-ID-ENUM-FAIL-01') else 'FAIL'}] 枚举失败无三件套残留")
        run(["icacls", str(refs_dir), "/reset"], root)
        run(["icacls", str(refs_dir), "/remove:d", "Everyone"], root)
        acl_ok = True
        try:
            os.listdir(refs_dir)
        except OSError:
            acl_ok = False
        RESULTS.append(("枚举失败注入后访问恢复", "PASS" if acl_ok else "FAIL", "acl"))
        print(f"[{'PASS' if acl_ok else 'FAIL'}] 枚举失败注入后访问恢复")

        # 场景19:冻结失败拒绝(负;cp 注入失败 → 冻结阶段中止,无残留)
        shim_dir = root / "shim"
        shim_dir.mkdir(exist_ok=True)
        (shim_dir / "cp").write_text(
            '#!/bin/sh\nif [ "$FAIL_CP" = "1" ]; then exit 1; fi\nexec /usr/bin/cp "$@"\n',
            encoding="utf-8", newline="\n")
        r = gate(root, "identity", "fakeskill", "REQ-ID-FREEZE-FAIL-01",
                 env_extra={"PATH": f"{shim_dir}{os.pathsep}{os.environ['PATH']}",
                            "FAIL_CP": "1"})
        scenario("identity 冻结失败拒绝", False, r, expected_reason="候选冻结失败")
        RESULTS.append(("冻结失败无三件套残留", "PASS" if trio_absent("REQ-ID-FREEZE-FAIL-01") else "FAIL", "cleanup"))
        print(f"[{'PASS' if trio_absent('REQ-ID-FREEZE-FAIL-01') else 'FAIL'}] 冻结失败无三件套残留")

        # 场景20:blob 计算失败拒绝(负;git hash-object 注入失败,无残留)
        real_git = (shutil.which("git") or "git").replace("\\", "/")
        (shim_dir / "git").write_text(
            '#!/bin/sh\nfor a in "$@"; do\n'
            '  if [ "$a" = "hash-object" ] && [ "$FAIL_HASH" = "1" ]; then exit 1; fi\ndone\n'
            f'exec "{real_git}" "$@"\n', encoding="utf-8", newline="\n")
        r = gate(root, "identity", "fakeskill", "REQ-ID-HASH-FAIL-01",
                 env_extra={"PATH": f"{shim_dir}{os.pathsep}{os.environ['PATH']}",
                            "FAIL_HASH": "1"})
        scenario("identity blob 失败拒绝", False, r, expected_reason="锚定哈希计算失败")
        RESULTS.append(("blob失败无三件套残留", "PASS" if trio_absent("REQ-ID-HASH-FAIL-01") else "FAIL", "cleanup"))
        print(f"[{'PASS' if trio_absent('REQ-ID-HASH-FAIL-01') else 'FAIL'}] blob失败无三件套残留")

    return _finalize()


def _finalize() -> int:
    """共用统计与返回路径:selftest 注入与完整运行都必须经过这里。"""
    passed = sum(1 for _, s, _ in RESULTS if s == "PASS")
    failed = [n for n, s, _ in RESULTS if s == "FAIL"]
    skipped = sum(1 for _, s, _ in RESULTS if s == "SKIP")
    assert passed + len(failed) + skipped == len(RESULTS), "计数必须互斥且完备"
    print("")
    print("== 统计 == PASS=%d FAIL=%d SKIP=%d 总计=%d (互斥校验: %d==%d)" % (
        passed, len(failed), skipped, len(RESULTS),
        passed + len(failed) + skipped, len(RESULTS)))
    print("总退出码: %s" % ("0" if not failed else "1"))
    if failed:
        print("失败项: %s" % failed)
    # 打印的"总退出码"不能代替进程退出状态:有 FAIL 必须真实返回非零
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(selftest_fail="--selftest-fail" in sys.argv))
