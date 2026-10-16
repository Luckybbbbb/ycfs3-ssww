#!/usr/bin/env bash
# ssww-create-skill 分阶段门禁脚本(fail-closed)
# 用法: bash ssww-skill-gate.sh <子命令> <参数...>(自工作区根执行)
# 每个门禁 exit 0 才允许进入下一阶段;非 0 必须整改后重跑,禁止跳门禁。
set -euo pipefail

# 路径自推导(脚本位于 <workspace>/.claude/skills/ssww-create-skill/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE_ROOT="$(cd "$SKILLS_ROOT/../.." && pwd)"
AGENTS_LINK_ROOT="$WORKSPACE_ROOT/.agents/skills"
RULINGS_DIR="$WORKSPACE_ROOT/.tmp/codex-rulings"
REVIEW_SKILL_NAME="ssww-review-ruling"

err() { echo "[门禁失败] $*" >&2; exit 1; }

# NAME/REQ_ID 字符集校验(防路径穿越与意外参数)
check_name() { [[ "$1" =~ ^[a-z][a-z0-9-]*$ ]] || err "skill 名只允许小写字母开头的字母/数字/连字符: [$1]"; }
check_req_id() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || err "REQ_ID 只允许字母/数字/点/下划线/连字符: [$1]"; }

usage() {
  cat <<'EOF'
用法: bash ssww-skill-gate.sh <子命令> <参数...>(自工作区根执行)
  doc-gate    <skill名>                            门禁1:结构/文档检查
  link        <skill名>                            门禁2:创建并校验 junction(类型+目标;普通目录镜像内容一致时自动重建)
  identity    <skill名> <REQ_ID>                   门禁3:候选 SHA 清单 + 快照与 blob 索引锚定(REQ_ID 必填)
  review-gate <skill名> <REQ_ID>                   门禁4:receipt 完整性+候选未漂移+RULING=APPROVED
  commit      <skill名> <message> <REQ_ID>         门禁5:内嵌门禁4全套复验+已审核身份锚定+提交信息格式+暂存夹带检查
  selftest                                         门禁脚本自测(清单闭合五场景+提交信息八例)
EOF
  exit 2
}

[ $# -ge 1 ] || usage
CMD="$1"; shift
NAME=""; SKILL_DIR=""; LINK_DIR=""
set_target() {
  check_name "$1"
  NAME="$1"; shift
  SKILL_DIR="$SKILLS_ROOT/$NAME"
  LINK_DIR="$AGENTS_LINK_ROOT/$NAME"
}

# ---------- 公共:候选清单(稳定排序,NUL 安全;不依赖调用方 cwd) ----------
# 失败传播:目录枚举/排序管道与逐文件哈希的退出状态都显式检查,
# 任何失败返回非 0——绝不以部分输出冒充完整清单。
identity_list() {
  local f h cur="$PWD" out="" list_tmp
  cd "$SKILLS_ROOT" || return 1
  list_tmp=$(mktemp) || { cd "$cur" || return 1; return 1; }
  if ! find "$NAME" ! -type d ! -path "*/.tmp/*" ! -path "*/__pycache__/*" ! -name "*.pyc" -print0 | LC_ALL=C sort -z > "$list_tmp"; then
    rm -f "$list_tmp"; cd "$cur" || return 1; return 1
  fi
  while IFS= read -r -d '' f; do
    h=$(sha256sum "$f" | sed 's/ \*/  /') || { rm -f "$list_tmp"; cd "$cur" || return 1; return 1; }
    out+="$h"$'\n'
  done < "$list_tmp"
  rm -f "$list_tmp"
  cd "$cur" || return 1
  [ -n "$out" ] || return 1
  printf '%s' "$out"
}

# ---------- 公共:链接类型与目标校验(须为 Junction 且指向候选真身) ----------
link_check() {
  local link_path="$1"
  local info
  info=$(powershell -NoProfile -Command "\$i=Get-Item -Force -LiteralPath '$(cygpath -w "$link_path")'; \$i.LinkType; \$i.Target" 2>/dev/null) || return 1
  [ -n "$info" ] || return 1
  echo "$info" | head -1 | grep -qi 'Junction' || return 1
  # 目标精确相等(整行规范化比较,防前缀/后缀误匹配)
  local want got
  want=$(cygpath -w "$SKILL_DIR")
  got=$(echo "$info" | tail -n +2 | tr -d '\r' | grep -v '^$' | head -1)
  [ "$got" = "$want" ] || return 1
  return 0
}

# ---------- 公共:request 候选清单与快照强制闭合(空/少/多/错一律失败) ----------
check_req_list_closure() {
  local req_file="$1" snap="$2"
  local req_list snap_list
  req_list=$(grep -E '^[0-9a-f]{64}  ' "$req_file" 2>/dev/null | grep "  $NAME/" || true)
  snap_list=$(grep "  $NAME/" "$snap" 2>/dev/null || true)
  [ -n "$snap_list" ] || return 1
  [ -n "$req_list" ] || return 1
  [ "$req_list" = "$snap_list" ] || return 1
  return 0
}

# ---------- 公共:receipt 完整性 + request/上下文/调用器身份 + 候选漂移 + RULING ----------
review_evidence_check() {
  local req_id="$1"
  check_req_id "$req_id"
  local receipt="$RULINGS_DIR/$req_id.receipt.json"
  local txt="$RULINGS_DIR/$req_id.txt"
  local snap="$RULINGS_DIR/$req_id.candidate.sha"
  local request_file="$SKILLS_ROOT/.tmp/review/request-$req_id.txt"
  [ -f "$receipt" ] || err "receipt 不存在: $receipt(审核是否真的完成?)"
  [ -f "$txt" ] || err "ruling 输出不存在: $txt"
  [ -f "$snap" ] || err "候选快照不存在: $snap(发起审核前须执行 identity $NAME $req_id)"
  local blobmap="$RULINGS_DIR/$req_id.candidate.blob"
  [ -f "$blobmap" ] || err "索引锚定缺失: $blobmap(发起审核前须执行 identity $NAME $req_id)"
  local blobmap_sha="$RULINGS_DIR/$req_id.candidate.blob.sha256"
  [ -f "$blobmap_sha" ] || err "索引锚定哈希缺失: $blobmap_sha(发起审核前须执行 identity $NAME $req_id)"
  # 锚定哈希绑定:request 必须声明 BLOB_ANCHOR_SHA256 且与锚定文件实际 SHA 一致,
  # 替换锚定中的 blob 值即在此被拒;锚定与快照的文件集合还必须闭合
  local declared_blob_sha actual_blob_sha
  declared_blob_sha=$(grep -oE '^BLOB_ANCHOR_SHA256=[0-9a-f]{64}' "$request_file" | head -1 | cut -d= -f2)
  actual_blob_sha=$(sha256sum "$blobmap" | awk '{print $1}')
  [ -n "$declared_blob_sha" ] || err "request 未声明 BLOB_ANCHOR_SHA256(索引锚定未绑定审核身份,重新 identity 后原样写入 request)"
  [ "$declared_blob_sha" = "$actual_blob_sha" ] || err "索引锚定哈希不符(request 声明与 .candidate.blob 实际不一致,锚定疑似被篡改;须换新 REQ_ID)"
  # 锚定映射与快照的文件集合必须闭合(空/少/多/序不一致一律失败;<blob>  <路径> 双空格格式,完整路径含空格不截断)
  if ! diff <(sed -E 's/^[0-9a-f]{40}  //' "$blobmap") <(sed -E 's/^[0-9a-f]{64}  //' "$snap") >/dev/null 2>&1; then
    err "索引锚定与候选快照文件集合不一致(须换新 REQ_ID 重新 identity 并 RESUBMIT)"
  fi
  [ -f "$request_file" ] || err "request 文件不存在: $request_file(约定命名 request-<REQ_ID>.txt)"
  local validation cli_exit rid skill_sha_receipt skill_sha_now out_sha_receipt out_sha_now
  validation=$(grep -o '"validation":"[A-Z]*"' "$receipt" | head -1 | cut -d'"' -f4)
  cli_exit=$(grep -o '"cli_exit_code":[0-9]*' "$receipt" | head -1 | cut -d: -f2)
  rid=$(grep -o '"request_id":"[^"]*"' "$receipt" | head -1 | cut -d'"' -f4)
  skill_sha_receipt=$(grep -o '"skill_sha256":"[a-f0-9]*"' "$receipt" | head -1 | cut -d'"' -f4)
  out_sha_receipt=$(grep -o '"output_sha256":"[a-f0-9]*"' "$receipt" | head -1 | cut -d'"' -f4)
  [ "$validation" = "PASS" ] || err "receipt validation=$validation(非 PASS 的输出不可作为裁决)"
  [ "$cli_exit" = "0" ] || err "receipt cli_exit_code=$cli_exit(非 0 不可作为裁决)"
  [ "$rid" = "$req_id" ] || err "receipt request_id=[$rid] 与本请求 [$req_id] 不匹配"
  # ruling 输出未被篡改(receipt 记录的输出 SHA 与当前文件一致)
  out_sha_now=$(sha256sum "$txt" | cut -d' ' -f1)
  [ "$out_sha_receipt" = "$out_sha_now" ] || err "ruling 输出与 receipt 的 output_sha256 不一致(疑似被篡改)"
  skill_sha_now=$(sha256sum "$SKILLS_ROOT/$REVIEW_SKILL_NAME/SKILL.md" | cut -d' ' -f1)
  [ "$skill_sha_receipt" = "$skill_sha_now" ] || err "审核 Skill 身份漂移($REVIEW_SKILL_NAME SKILL.md 已变化,旧 receipt 失效)"
  # request/调用器/上下文身份:统一用 python 做 JSON 解码与路径规范化比较
  # (Windows 路径与 Git Bash 路径表示不同,必须 resolve 后比较;缺失/空上下文一律失效)
  python - "$receipt" "$request_file" "$SKILLS_ROOT/$REVIEW_SKILL_NAME/scripts/invoke_ssww_review.py" <<'PY' || err "request/调用器/上下文身份校验失败(见上)"
import sys, json, hashlib, pathlib
receipt_path, request_path, launcher_path = sys.argv[1], sys.argv[2], sys.argv[3]
receipt = json.loads(pathlib.Path(receipt_path).read_text(encoding="utf-8"))
problems = []
req = pathlib.Path(request_path).resolve()
bound = pathlib.Path(receipt.get("request_file", "")).resolve()
if bound != req:
    problems.append(f"receipt 绑定 request 路径不符(疑似复用旧裁决): {bound}")
req_sha = hashlib.sha256(req.read_bytes()).hexdigest()
if req_sha != receipt.get("request_sha256"):
    problems.append("request 已漂移(与 receipt 绑定 SHA 不一致,须新 REQ_ID 重新送审)")
launcher = pathlib.Path(launcher_path)
if hashlib.sha256(launcher.read_bytes()).hexdigest() != receipt.get("launcher_sha256"):
    problems.append("调用器身份已漂移(invoke_ssww_review.py 已变化,旧裁决失效)")
ctx = receipt.get("context_files") or {}
if not ctx:
    problems.append("receipt 缺少 context_files,旧裁决失效")
else:
    for p, d in ctx.items():
        f = pathlib.Path(p)
        if not f.is_file():
            problems.append(f"上下文缺失: {p}")
        elif hashlib.sha256(f.read_bytes()).hexdigest() != d:
            problems.append(f"上下文变化: {p}")
    encoded = json.dumps(ctx, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if hashlib.sha256(encoded.encode("utf-8")).hexdigest() != receipt.get("context_sha256"):
        problems.append("context_sha256 复算不符")
    required = ["审核裁决协议.md", "TDD_Standard.md", "AGENTS.md", "ssww-review-ruling" + "/SKILL.md"]
    for suffix in required:
        # Windows receipt 存的是反斜杠路径,必须统一为正斜杠再比对
        if not any(str(p).replace("\\", "/").endswith(suffix) for p in ctx):
            problems.append(f"上下文缺少必需规则: {suffix}")
if problems:
    print("; ".join(problems))
    sys.exit(1)
PY
  # request 声明的候选清单必须与审核时快照闭合一致(强制比较:空/少/多/错一律失败)
  if ! check_req_list_closure "$request_file" "$snap"; then
    err "request 候选清单与审核时快照不闭合(缺失/为空/多文件/哈希不符;request 须含全部候选文件的 '<hash>  <path>' 行)"
  fi
  # 候选漂移校验:当前重算 vs 审核时快照
  local now_snap="$RULINGS_DIR/$req_id.candidate.now"
  identity_list > "$now_snap" || err "当前候选清单生成失败(候选目录不可读?)"
  if ! diff -q "$snap" "$now_snap" >/dev/null 2>&1; then
    rm -f "$now_snap"
    err "候选已漂移(当前 SHA 与审核时快照不一致;须用新 REQ_ID 重新 identity 并 RESUBMIT)"
  fi
  rm -f "$now_snap"
  local ruling
  ruling=$(grep -o '^RULING=[A-Z_]*' "$txt" | head -1 | cut -d= -f2 || true)
  if [ "$ruling" != "APPROVED" ]; then
    grep -A20 'NEXT_ACTION=' "$txt" | head -25 || true
    err "审核未通过(RULING=${ruling:-未知})"
  fi
}

# ---------- 公共:提交信息校验(中文动宾 + 无 AI 署名) ----------
msg_check() {
  local msg="$1"
  local first
  first=$(printf '%s\n' "$msg" | head -1)
  # 格式检查只作用于首行:正文中的合法格式行不得补足非法标题;AI 署名检查仍用完整消息
  if ! printf '%s\n' "$first" | grep -qE '^(feat|fix|chore|docs|refactor|perf|test|revert)\([a-zA-Z0-9_-]+\): [^ ]'; then
    err "提交信息不符合 '<type>(<scope>): <subject>' 格式(type 小写枚举,scope 非空且仅字母/数字/下划线/连字符,半角冒号+恰好一个空格)"
  fi
  local subject
  subject=$(printf '%s\n' "$first" | sed 's/^[^:]*: //')
  # 中文检测用 python(U+4E00-U+9FFF),grep -P 在 Git Bash 受 locale 限制不可靠
  if ! echo "$subject" | python -c "import sys; sys.exit(0 if any('一' <= c <= '鿿' for c in sys.stdin.read()) else 1)"; then
    err "subject 必须为中文动宾短语"
  fi
  local slen
  slen=$(echo -n "$subject" | wc -m)
  [ "$slen" -le 50 ] || err "subject 超过 50 字(当前 $slen)"
  if echo "$subject" | grep -qE '[。.]$'; then
    err "subject 结尾不加句号"
  fi
  if echo "$msg" | grep -qiE 'Co-Authored-By|Generated with|🤖'; then
    err "提交信息不得含 AI 署名(Co-Authored-By/Generated with 等)"
  fi
}

# ---------- 门禁1:结构/文档 ----------
doc_gate() {
  [ -d "$SKILL_DIR" ] || err "skill 目录不存在: $SKILL_DIR"
  local sk="$SKILL_DIR/SKILL.md"
  [ -f "$sk" ] || err "缺 SKILL.md"
  head -1 "$sk" | grep -q '^---' || err "SKILL.md 首行必须是 YAML frontmatter(---)"
  # frontmatter 结构化解析:字段唯一性、name 全等、version 非空、盘符路径,均在块内判定
  python - "$sk" "$NAME" <<'PY' || err "frontmatter 校验失败(见上)"
import sys, re
path, name = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
m = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
if not m:
    print("缺 frontmatter 块")
    sys.exit(1)
block = m.group(1)
# 控制字符门必须在任何清理(splitlines/strip)之前执行于原始块:
# U+000B/U+000C/U+001C-U+001E 会被 splitlines 当行分隔符移除,
# U+001C-U+001F 会被 strip 当空白剥掉,先清理后检查会让它们绕过校验。
# 仅放行 LF 与 CR(CRLF 换行布局);制表符在受限标量内须以转义书写。
ctrl_bad = [c for c in block if (ord(c) < 0x20 and c not in "\r\n") or ord(c) == 0x7F]
if ctrl_bad:
    print(f"frontmatter 含非法控制字符: {[hex(ord(c)) for c in ctrl_bad[:5]]}(仅允许 LF/CR 换行)")
    sys.exit(1)
# 用 (key, value) 对列表保留重复字段:先查重复,再取值(字典会覆盖重复,查不出)
# 受限 YAML 解析(支持范围明示):仅 name/description/metadata 三个顶层键;
# metadata 仅 version 一个子键;值为普通标量(引号标量/裸标量+注释),不支持流程集合([/{)。
class YamlError(Exception):
    pass


def yaml_scalar(raw):
    """解析受限 YAML 标量:返回 (基础值, 是否合法)。

    裸标量词法按封闭黑名单校验:控制字符(含 NUL、U+0001、U+007F 与裸
    制表符)一律非法;YAML 指示符开头的裸值(标签/锚点/别名/块标量头/
    保留指示符/集合结尾符等)一律拒绝;映射分隔符(冒号+空格、结尾冒号,
    冒号+制表符已被控制字符规则覆盖)拒绝。中文等非指示符字符的裸值
    仍然合法(本工程文档为中文,不加引号的 description 依赖此规则)。
    双引号标量仅支持四种转义:双引号、反斜杠、字母 n(换行)、字母 t(制表符),
    其余转义一律拒绝。本函数的文档字符串不含任何反斜杠示例,避免转义层级混乱。
    """
    v = raw.strip()
    if not v:
        return "", True
    # 控制字符一律非法(NUL/U+0001/U+007F/裸制表符等;制表符在引号标量内须用转义)
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in v):
        return v, False
    if v[0] in "[{":
        return v, False  # 流程集合
    if v[0] in "!&*|>%@`,]}?:":
        return v, False  # YAML 指示符开头的裸值(含块标量头),不支持即拒绝
    if v[0] in "\"'":
        quote = v[0]
        i = 1
        body_chars = []
        while i < len(v):
            c = v[i]
            if c == "\\" and quote == '"':
                # 转义仅四种:双引号、反斜杠、n、t;转义符不终止引号边界
                if i + 1 >= len(v):
                    return v, False
                nxt = v[i + 1]
                if nxt not in ('"', "\\", "n", "t"):
                    return v, False
                body_chars.append({"n": chr(10), "t": chr(9)}.get(nxt, nxt))
                i += 2
                continue
            if c == quote:
                rest = v[i + 1:].strip()
                if rest and not rest.startswith("#"):
                    return v, False
                return "".join(body_chars), True
            body_chars.append(c)
            i += 1
        return v, False  # 引号未闭合
    # 裸标量:拒绝映射分隔符(冒号+空格/结尾冒号;冒号+制表符已被控制字符规则覆盖)
    if ": " in v or v.endswith(":"):
        return v, False
    idx = v.find("#")
    if idx == 0:
        return "", True  # 纯注释 = 空值(如 metadata: # 块注释)
    if idx > 0 and v[idx - 1] not in " \t":
        return v, False  # 裸 # 非法
    if idx >= 0:
        v = v[:idx].strip()
    return v, True


pairs = []
try:
    current_top = None
    metadata_value_raw = None
    for line in block.splitlines():
        if not line.strip():
            continue
        top = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):(| .*)$", line)
        child = re.match(r"^  ([A-Za-z_][A-Za-z0-9_-]*):(| .*)$", line)
        if top:
            key, raw_value = top.group(1), top.group(2).strip()
            if key not in ("name", "description", "metadata"):
                raise YamlError(f"不支持的顶层键(受限格式仅 name/description/metadata): {key}")
            if key == "metadata":
                metadata_value_raw = raw_value
                pairs.append(("__metadata_seen__", ""))
            else:
                base, ok = yaml_scalar(raw_value)
                if not ok:
                    raise YamlError(f"{key} 的值非法: {raw_value!r}")
                pairs.append((key, base))
            current_top = key
        elif child:
            if current_top != "metadata":
                raise YamlError(f"缩进子键只允许出现在 metadata 下: {line!r}")
            if metadata_value_raw is None:
                raise YamlError("metadata 缺少块头")
            mv_raw = metadata_value_raw.strip()
            # 块样式 = 无值或纯注释;显式空字符串 "" 是行内标量,不是容器
            if not (mv_raw == "" or mv_raw.startswith("#")):
                raise YamlError(f"metadata 必须为块样式(无值/纯注释),不接受行内标量: {metadata_value_raw!r}")
            key, raw_value = child.group(1), child.group(2).strip()
            if key != "version":
                raise YamlError(f"metadata 不支持的子键(受限格式仅 version): {key}")
            base, ok = yaml_scalar(raw_value)
            if not ok:
                raise YamlError(f"metadata.version 的值非法: {raw_value!r}")
            pairs.append(("metadata." + key, base))
        else:
            raise YamlError(f"非法行(仅支持 'key: value' 与 2 空格缩进子键): {line!r}")
except YamlError as error:
    print(str(error))
    sys.exit(1)

problems = []
names = [v for k, v in pairs if k == "name"]
if len(names) != 1 or not names[0]:
    problems.append(f"name 必须恰好出现一次且非空,实际 {names!r}")
elif names[0] != name:
    problems.append(f"name 必须等于 {name},实际 {names[0]!r}")
versions = [v for k, v in pairs if k == "metadata.version"]
if len(versions) != 1:
    problems.append(f"metadata.version 必须恰好出现一次,实际 {len(versions)} 次")
elif versions[0].strip() in ("", "null", "Null", "NULL", "~"):
    problems.append(f"metadata.version 必须为非空有效值,实际 {versions[0]!r}")
if len([1 for k, _ in pairs if k == "__metadata_seen__"]) != 1:
    problems.append("metadata 容器必须恰好出现一次且为块样式")
descs = [v for k, v in pairs if k == "description"]
if len(descs) != 1:
    problems.append(f"description 必须恰好出现一次,实际 {len(descs)} 次")
elif len(descs[0]) < 20:
    problems.append("description 必须 >=20 字符")
if re.search(r"[A-Za-z]:(\|/[^/])", block):
    problems.append("frontmatter 含盘符路径")
if problems:
    print("; ".join(problems))
    sys.exit(1)
PY
  grep -q '自进化' "$sk" || err "SKILL.md 缺「自进化流程」章节"
  [ -f "$SKILL_DIR/references/changelog.md" ] || err "缺 references/changelog.md"
  # SKILL.md 引用的本地资源必须存在(跨 skill 引用如 <other>/scripts/x.py 不在本检查范围)
  local ref missing=0
  while IFS= read -r ref; do
    if [ ! -f "$SKILL_DIR/$ref" ] && ! ls "$SKILLS_ROOT"/*/"$ref" >/dev/null 2>&1; then
      echo "[缺失] $ref"; missing=1
    fi
  done < <(grep -oE '(references|scripts|assets)/[A-Za-z0-9_./-]+' "$sk" | sort -u)
  [ "$missing" -eq 0 ] || err "SKILL.md 引用的资源文件不存在(见上)"
  # 绝对路径检查:SKILL.md 不得含任何带盘符的 Windows 路径(排除 http:// 等 URL scheme:斜杠后不接斜杠才算盘符路径)
  if grep -nE '[A-Za-z]:(\\|/[^/])' "$sk" >/dev/null 2>&1; then
    grep -nE '[A-Za-z]:(\\|/[^/])' "$sk"
    err "SKILL.md 含本机绝对路径(见上),改为以工作区根为基准的相对路径"
  fi
  echo "[门禁1 通过] 结构/文档检查 OK: $NAME"
}

# ---------- 门禁2:junction(类型+目标;含新检出工作区的恢复流程) ----------
# git 把 junction 存成普通目录拷贝,重新检出后镜像退化为普通目录。
# 恢复策略(fail-closed):全量文件清单比对——清单生成或哈希计算任何一步失败
# (含镜像中不可读文件)一律拒绝,绝不"读取失败后恰好一致"地误删;
# 镜像中任何多出/差异文件(含 .tmp 等运行残留)一律拒绝自动覆盖,交人工处理;
# 类型查询失败与"普通目录"严格区分,查询失败拒绝恢复。
plain_copy_matches_candidate() {
  local left right
  left=$(cd "$LINK_DIR" && find . ! -type d -print0 | LC_ALL=C sort -z | xargs -0 sha256sum 2>/dev/null) \
    || return 1  # 清单生成/哈希计算失败(含不可读文件)→ 拒绝恢复,不进入删除
  right=$(cd "$SKILL_DIR" && find . ! -type d -print0 | LC_ALL=C sort -z | xargs -0 sha256sum 2>/dev/null) \
    || return 1
  [ -n "$right" ] || return 1
  [ "$left" = "$right" ] || return 1
  return 0
}

link_type_of() {
  # 输出 "OK|<LinkType>":OK| 后为空 = 普通目录;查询失败无输出(fail-closed)
  powershell -NoProfile -Command "\$i=Get-Item -Force -LiteralPath '$(cygpath -w "$1")' -ErrorAction Stop; Write-Output ('OK|' + \$i.LinkType)" 2>/dev/null | tr -d '\r'
}

link_gate() {
  [ -d "$SKILL_DIR" ] || err "skill 目录不存在: $SKILL_DIR"
  # mklink 不创建父目录,自动补齐
  mkdir -p "$AGENTS_LINK_ROOT" || err "镜像父目录创建失败: $AGENTS_LINK_ROOT"
  if [ -e "$LINK_DIR" ]; then
    if link_check "$LINK_DIR"; then
      :
    else
      local link_info
      link_info=$(link_type_of "$LINK_DIR")
      case "$link_info" in
        "OK|") : ;;  # 普通目录(LinkType 为空),进入恢复流程
        OK\|*) err "链接已存在且非普通目录/非 Junction,需人工处理: $LINK_DIR" ;;
        *) err "镜像类型查询失败,拒绝自动恢复: $LINK_DIR" ;;
      esac
      plain_copy_matches_candidate || err "已存在普通目录但内容与候选不一致(含多出/差异文件,疑似用户改动或运行残留),拒绝自动覆盖: $LINK_DIR"
      rm -rf "$LINK_DIR" || err "旧镜像目录删除失败: $LINK_DIR"
      MSYS_NO_PATHCONV=1 cmd /c "mklink /J $(cygpath -w "$LINK_DIR") $(cygpath -w "$SKILL_DIR")" >/dev/null \
        || err "junction 重建失败: $LINK_DIR"
      link_check "$LINK_DIR" || err "junction 重建后校验失败(类型/目标不符)"
      echo "[恢复] 普通目录镜像(内容与候选逐字节一致)已重建为 junction: $LINK_DIR"
    fi
  else
    MSYS_NO_PATHCONV=1 cmd /c "mklink /J $(cygpath -w "$LINK_DIR") $(cygpath -w "$SKILL_DIR")" >/dev/null \
      || err "junction 创建失败: $LINK_DIR"
    link_check "$LINK_DIR" || err "junction 创建后校验失败(类型/目标不符)"
  fi
  echo "[门禁2 通过] junction 就绪且校验通过: $LINK_DIR"
}

# ---------- 门禁3:候选身份(可选快照锚定) ----------
identity_gate() {
  [ -d "$SKILL_DIR" ] || err "skill 目录不存在: $SKILL_DIR"
  cd "$SKILLS_ROOT" || err "无法进入 $SKILLS_ROOT"
  local save_id="${1:-}"
  # 夹带提示(不阻断;硬阻断在 commit 门禁的暂存区检查)
  local dirty
  dirty=$(git -C "$WORKSPACE_ROOT" status --porcelain 2>/dev/null | grep -v '^.. \.tmp/' | grep -v '^?? \.tmp/' | grep -v '^.. \.claude/skills/' | grep -v '^?? \.claude/skills/' || true)
  echo "---- 工作区其它改动(不得进入候选) ----"
  if [ -n "$dirty" ]; then echo "$dirty"; else echo "(无)"; fi
  if [ -n "$save_id" ]; then
    check_req_id "$save_id"
    local snap="$RULINGS_DIR/$save_id.candidate.sha"
    # 该 REQ_ID 已有裁决时禁止补建快照(无法证明候选确实送过审)
    if [ -f "$RULINGS_DIR/$save_id.receipt.json" ]; then
      err "该 REQ_ID 已存在审核 receipt: $save_id(禁止为已送审请求补建快照;换新 REQ_ID)"
    fi
    # 快照禁覆盖:同 REQ_ID 重跑会绕过"候选漂移"检测,必须换新 REQ_ID
    if [ -e "$snap" ]; then
      err "候选快照已存在: $snap(禁止覆盖;候选已变化时必须换新 REQ_ID 重新 identity 并 RESUBMIT)"
    fi
    mkdir -p "$RULINGS_DIR" || err "无法创建快照目录: $RULINGS_DIR"
    # 三件套禁覆盖检查必须先于任何创建动作(否则本轮自己写的文件会触发本检查)
    local blobmap="$RULINGS_DIR/$save_id.candidate.blob"
    local blobmap_sha="$RULINGS_DIR/$save_id.candidate.blob.sha256"
    if [ -e "$snap" ] || [ -e "$blobmap" ] || [ -e "$blobmap_sha" ]; then
      err "候选身份已存在: $RULINGS_DIR/$save_id.*(禁止覆盖;候选已变化时必须换新 REQ_ID 重新 identity 并 RESUBMIT)"
    fi
    local list_file="$RULINGS_DIR/.list-$save_id.tmp"
    identity_list > "$list_file" || err "候选清单生成失败"
    # 冻结后同源生成:把候选按清单复制到临时冻结目录,SHA 快照与 blob 锚定都从
    # 同一组冻结字节计算——消除"两次读取工作区之间内容漂移"导致快照与锚定不一致
    # (或锚定指向从未被快照过的内容)的窗口。冻结/计算任一步失败即中止。
    local frozen
    frozen=$(mktemp -d "$RULINGS_DIR/frozen-XXXXXX") || err "冻结目录创建失败"
    local line rel fsha ghash
    # 失败统一清理:冻结目录 + 清单 + 本轮可能已写的部分三件套,再以非 0 退出
    cleanup_partial() {
      rm -rf "$frozen" "$list_file" "$snap" "$blobmap" "$blobmap_sha"
    }
    while IFS= read -r line; do
      rel="${line#*  }"
      mkdir -p "$frozen/$(dirname "$rel")"
      cp "$SKILLS_ROOT/$rel" "$frozen/$rel" || { cleanup_partial; err "候选冻结失败: $rel"; }
    done < "$list_file"
    : > "$snap"
    : > "$blobmap"
    while IFS= read -r line; do
      rel="${line#*  }"
      # 哈希先入变量并校验格式,再落盘——printf 的成功不代表哈希命令的成功
      fsha=$(sha256sum "$frozen/$rel") || { cleanup_partial; err "快照哈希计算失败: $rel"; }
      fsha=$(printf '%s' "$fsha" | awk '{print $1}')
      [[ "$fsha" =~ ^[0-9a-f]{64}$ ]] || { cleanup_partial; err "快照摘要格式异常: $rel"; }
      printf '%s  %s\n' "$fsha" "$rel" >> "$snap" || { cleanup_partial; err "快照写入失败: $rel"; }
      ghash=$(git -C "$WORKSPACE_ROOT" hash-object --path ".claude/skills/$rel" "$frozen/$rel") \
        || { cleanup_partial; err "锚定哈希计算失败: $rel"; }
      [[ "$ghash" =~ ^[0-9a-f]{40}$ ]] || { cleanup_partial; err "锚定摘要格式异常: $rel"; }
      printf '%s  %s\n' "$ghash" "$rel" >> "$blobmap" || { cleanup_partial; err "锚定写入失败: $rel"; }
    done < "$list_file"
    rm -rf "$frozen" "$list_file"
    sha256sum "$blobmap" | awk '{print $1}' > "$blobmap_sha"
    echo "---- 候选快照已存: .tmp/codex-rulings/$save_id.candidate.sha(仓库根) ----"
    echo "---- 索引锚定已存: .tmp/codex-rulings/$save_id.candidate.blob(仓库根) ----"
    echo "---- 锚定哈希已存: .tmp/codex-rulings/$save_id.candidate.blob.sha256(仓库根) ----"
    echo "BLOB_ANCHOR_SHA256=$(cat "$blobmap_sha")"
  fi
  echo "---- 候选文件 SHA-256(粘贴进 codex request) ----"
  identity_list
  echo "[门禁3 通过] 身份清单已生成"
}

# ---------- 门禁4:ruling 证据链校验 ----------
review_gate() {
  local req_id="${1:-}"
  [ -n "$req_id" ] || usage
  review_evidence_check "$req_id"
  echo "[门禁4 通过] $req_id = APPROVED(receipt/身份/候选快照全部校验通过)"
}

# ---------- 门禁5:提交 ----------
commit_gate() {
  local msg="${1:-}"; local req_id="${2:-}"
  [ -n "$msg" ] && [ -n "$req_id" ] || usage
  msg_check "$msg"
  # 全套复验:文档/链接状态也必须在提交时刻有效(防止过审后文档/junction 漂移)
  doc_gate
  link_gate
  review_evidence_check "$req_id"
  cd "$WORKSPACE_ROOT" || err "无法进入 $WORKSPACE_ROOT"
  git add ".claude/skills/$NAME" ".agents/skills/$NAME" || err "git add 失败"
  # 夹带检查:-z NUL 分隔(core.quotepath 会把中文路径转义成八进制,文本比较不可靠)
  local staged_outside
  staged_outside=$(git -c core.quotepath=off diff --cached --name-only -z | tr '\0' '\n' \
    | grep -v "^\.claude/skills/$NAME/" | grep -v "^\.agents/skills/$NAME/" || true)
  if [ -n "$staged_outside" ]; then
    # 只回滚候选目录自己的暂存,保留用户原有的其他暂存安排
    git reset -q HEAD -- ".claude/skills/$NAME" ".agents/skills/$NAME" || err "候选暂存回滚失败,请手工检查 index"
    err "暂存区存在候选目录外文件(已仅回滚候选目录,其他暂存保留):\n$staged_outside"
  fi
  # 提交集锚定校验:以已审核身份(identity 时的 blob 锚定)为唯一基准核对暂存树,
  # 不重新采信当前工作区——快照检查后改写的内容或新增/删除的路径一律拒绝。
  python - "$WORKSPACE_ROOT" "$NAME" "$RULINGS_DIR/$req_id.candidate.blob" <<'PY' || { git reset -q HEAD -- ".claude/skills/$NAME" ".agents/skills/$NAME" 2>/dev/null || true; err "提交集与已审核身份不闭合(已回滚候选暂存,见上)"; }
import subprocess, sys
workspace, name, blobmap_path = sys.argv[1], sys.argv[2], sys.argv[3]
anchored = {}
with open(blobmap_path, encoding="utf-8") as stream:
    for line in stream:
        line = line.rstrip("\n")
        if line:
            blob, rel = line.split("  ", 1)  # <blob>  <完整路径>:路径含空格不截断
            anchored[rel] = blob

def git(*args):
    return subprocess.run(
        ["git", "-C", workspace, "-c", "core.quotepath=off", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stdout

problems = []
# 状态检查(-z NUL 分隔,中文/特殊字符路径不转义):只感知删除与非法模式
tokens = git("diff", "--cached", "--raw", "--abbrev=40", "-z", "--",
             f".claude/skills/{name}", f".agents/skills/{name}").split("\0")
for i in range(0, len(tokens) - 1, 2):
    meta, path = tokens[i], tokens[i + 1]
    if not meta or not path:
        continue
    parts = meta[1:].split(" ")
    dst_mode, status = parts[1], parts[4] if len(parts) > 4 else ""
    if dst_mode not in ("100644", "100755"):
        problems.append(f"{path}: 非法模式 {dst_mode}(拒绝符号链接/子模块)")
    if status.startswith("D"):
        problems.append(f"{path}: 候选删除未经新身份链,拒绝")
# 索引态锚定核对:以 ls-files -s 为存在性与 blob 的唯一来源(未变更的已提交
# 文件不出现在 diff 里,但仍在索引中且 blob 应与锚定一致)
staged = {}
for entry in git("ls-files", "-s", "-z", "--",
                 f".claude/skills/{name}", f".agents/skills/{name}").split("\0"):
    if not entry:
        continue
    meta, path = entry.split("\t", 1)
    mode, blob, stage = meta.split()
    if stage != "0":
        problems.append(f"{path}: 未合并索引条目 stage={stage}")
        continue
    staged[path] = (mode, blob)
if not staged:
    problems.append("暂存索引无候选目录条目")
prefixes = (f".claude/skills/{name}/", f".agents/skills/{name}/")
# 正向:每条暂存必须命中已审核身份(相对路径 + blob 全等)
for path in sorted(staged):
    rel = None
    for prefix in prefixes:
        if path.startswith(prefix):
            rel = path[len(prefix):]
            break
    if rel is None:
        problems.append(f"{path}: 前缀不在候选目录")
        continue
    want = anchored.get(f"{name}/{rel}")
    if want is None:
        problems.append(f"{path}: 不在已审核清单(快照后新增/改名,须换新 REQ_ID 重新送审)")
    elif staged[path][1] != want:
        problems.append(f"{path}: 索引内容与已审核身份不一致(blob 漂移,须换新 REQ_ID 重新送审)")
# 反向:每个已审核文件在两个镜像都必须有暂存(防 .gitignore 静默吞掉已送审资源)
for rel in sorted(anchored):
    for base in (".claude/skills/", ".agents/skills/"):
        if base + rel not in staged:
            problems.append(f"{base + rel}: 不在暂存索引(缺失/被 .gitignore 忽略/镜像不全)")
if problems:
    print("\n".join(problems))
    sys.exit(1)
print(f"提交集锚定校验通过: 暂存 {len(staged)} 条 == 已审核身份 {len(anchored)} 文件 × 2 镜像")
PY
  if git diff --cached --quiet; then
    err "暂存区为空(无内容可提交)"
  fi
  git commit -m "$msg" || err "git commit 失败"
  echo "[门禁5 通过] 已提交: $(git log --oneline -1)"
}

# ---------- 自测(清单闭合五场景 + 提交信息四例) ----------
selftest() {
  local etmp="$SKILLS_ROOT/.tmp/gate-selftest-ev-$$"
  mkdir -p "$etmp"
  local snapf="$etmp/snap" reqf="$etmp/req"
  local h1="abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
  local h2="1111111111111111111111111111111111111111111111111111111111111111"
  local saved_name="$NAME"
  NAME="fakeskill"
  echo "$h1  fakeskill/SKILL.md" > "$snapf"
  echo "$h1  fakeskill/SKILL.md" > "$reqf"
  check_req_list_closure "$reqf" "$snapf" 2>/dev/null || { NAME="$saved_name"; rm -rf "$etmp"; err "selftest 清单闭合正例失败:一致清单未通过"; }
  echo "no list here" > "$reqf"
  if check_req_list_closure "$reqf" "$snapf" 2>/dev/null; then NAME="$saved_name"; rm -rf "$etmp"; err "selftest 清单闭合负例失败:空清单未拒绝"; fi
  { echo "$h1  fakeskill/SKILL.md"; echo "$h2  fakeskill/B"; } > "$snapf"
  echo "$h1  fakeskill/SKILL.md" > "$reqf"
  if check_req_list_closure "$reqf" "$snapf" 2>/dev/null; then NAME="$saved_name"; rm -rf "$etmp"; err "selftest 清单闭合负例失败:少文件未拒绝"; fi
  echo "$h1  fakeskill/SKILL.md" > "$snapf"
  { echo "$h1  fakeskill/SKILL.md"; echo "$h2  fakeskill/B"; } > "$reqf"
  if check_req_list_closure "$reqf" "$snapf" 2>/dev/null; then NAME="$saved_name"; rm -rf "$etmp"; err "selftest 清单闭合负例失败:多文件未拒绝"; fi
  echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead  fakeskill/SKILL.md" > "$reqf"
  if check_req_list_closure "$reqf" "$snapf" 2>/dev/null; then NAME="$saved_name"; rm -rf "$etmp"; err "selftest 清单闭合负例失败:错误哈希未拒绝"; fi
  NAME="$saved_name"
  rm -rf "$etmp"
  msg_check "docs(fakeskill): 完善项目skill门禁化交付流程" || err "selftest 提交信息正例失败:合法中文信息未通过"
  if ( msg_check "docs(fakeskill): english subject only" ) >/dev/null 2>&1; then err "selftest 提交信息负例失败:英文 subject 未拒绝"; fi
  if ( msg_check "docs(fakeskill): 中文主题带AI署名

Co-Authored-By: Test <t@t.com>" ) >/dev/null 2>&1; then err "selftest 提交信息负例失败:AI 署名未拒绝"; fi
  if ( msg_check "docs(fakeskill): 中文主题句号。" ) >/dev/null 2>&1; then err "selftest 提交信息负例失败:句号结尾未拒绝"; fi
  if ( msg_check "docs: 缺失scope的提交说明" ) >/dev/null 2>&1; then err "selftest 提交信息负例失败:缺失 scope 未拒绝"; fi
  if ( msg_check "feat(): 空scope的提交说明" ) >/dev/null 2>&1; then err "selftest 提交信息负例失败:空 scope 未拒绝"; fi
  if ( msg_check "更新门禁检查

docs(fakeskill): 完善门禁检查" ) >/dev/null 2>&1; then err "selftest 提交信息负例失败:正文补足非法标题未拒绝"; fi
  msg_check "docs(fakeskill): 首行合法带正文

正文补充说明,不影响首行检查。" || err "selftest 提交信息正例失败:合法首行带正文未通过"
  echo "[selftest 通过] 清单闭合五场景 + 提交信息八例"
}

case "$CMD" in
  selftest)    selftest ;;
  doc-gate)    [ $# -ge 1 ] || usage; set_target "$@"; doc_gate ;;
  link)        [ $# -ge 1 ] || usage; set_target "$@"; link_gate ;;
  identity)    [ $# -ge 2 ] || usage; set_target "$1"; identity_gate "$2" ;;
  review-gate) [ $# -ge 2 ] || usage; set_target "$1"; shift; review_gate "$1" ;;
  commit)      [ $# -ge 3 ] || usage; set_target "$1"; shift; MSG="$1"; shift; commit_gate "$MSG" "$1" ;;
  *)           usage ;;
esac
