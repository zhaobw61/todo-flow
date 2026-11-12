#!/usr/bin/env python3
"""工作流快照工具（docs/workflow-contract.md 第 2.2 节）。

只读取仓库；只写入仓库外的快照目录。不执行任何 Git 写入操作，不还原文件。
在仓库根目录运行，输出一行 JSON：

  python3 -I workflow-examples/tools/wf_snapshot.py take <快照目录> [探测路径 ...]
  python3 -I workflow-examples/tools/wf_snapshot.py diff <快照目录> [--lines 路径] [--checkbox 路径] [--prefix 路径] [--same 路径] ...

take：确认快照目录在仓库外且不存在 → 复制全部已跟踪和未跟踪文件（保持相对路径）→ 写 manifest.sha256。
diff：重新计算哈希并与 manifest 比较；可选附加检查：
  --lines    统计该文件相对快照的新增/删除行数
  --checkbox 比较 "- [ ] Tn" / "- [x] Tn" 的勾选状态和任务编号
  --prefix   快照内容是否为当前文件的前缀（只追加）
  --same     当前文件是否与快照完全相同

W5 审查用：
  fingerprint <输出 JSON 路径（仓库外）> <仓库内相对路径 ...>   审查输入指纹
  seal <codex 目录> <codex 可执行路径>                        Codex 结束后写 meta.json / output.sha256（不输出日志正文）
  reusecheck <输出路径> <期望 sha256> <meta.json> <当前指纹>   复用前核对
W6 用：
  refingerprint <scope.json> <输出 JSON 路径（仓库外）>         按审查范围重新计算指纹，判断审查后文件是否变化
  guarded-run <快照目录> <日志路径（仓库外）> [--allow 路径]... [--output-dir 目录]... -- <命令>
      在快照保护下执行检查命令；只恢复 --allow 列出、执行前与快照一致、且在本次执行中变化的文件；其余变化只记录
节点结果保存与续接（约定 2.6）：
  record <run.root> <节点> <次数> <结果 sha256> [--path 仓库内路径]... < 结果 JSON（标准输入，末尾一个换行会去掉）
      核对结果 JSON 的 sha256 后，连同相关文件指纹写入 <run.root>/results/<节点>-<次数>.json；已存在则拒绝覆盖
  resultcheck <结果记录路径> <期望的记录 sha256>
      核对记录本身未被改动，并按记录中的路径重新计算指纹，列出变化
  importorigin <工作流运行记录 JSON> <期望 sha256> <run.root>
      从已结束运行的记录中取出原 W4 结果，原样（含原 nextNode）保存为 <run.root>/results/imported-W4-<原 run.id>-<次数>.json，输出摘要
  prefixcheck <文件> <原内容 sha256> <原内容字节数>
      判断文件开头是否仍是原内容（只追加），输出追加部分
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, check=True).stdout


def repo_root():
    return os.path.realpath(git("rev-parse", "--show-toplevel").decode().strip())


def head():
    try:
        return git("rev-parse", "HEAD").decode().strip()
    except subprocess.CalledProcessError:
        return "无"


def list_files():
    raw = git("ls-files", "-z", "-c", "-o", "--exclude-standard")
    return sorted({p for p in raw.decode("utf-8", "surrogateescape").split("\0") if p and os.path.isfile(p)})


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def read_manifest(snap):
    out = {}
    with open(os.path.join(snap, "manifest.sha256"), encoding="utf-8", errors="surrogateescape") as f:
        for line in f:
            digest, _, path = line.rstrip("\n").partition("  ")
            out[path] = digest
    return out


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return None


CHECKBOX = re.compile(r"^\s*- \[( |x|X)\] (T\d+)\b", re.M)


def checkboxes(text):
    return {} if text is None else {m.group(2): m.group(1).lower() == "x" for m in CHECKBOX.finditer(text)}


def take(snap, probes):
    root = repo_root()
    snap_real = os.path.realpath(snap)
    result = {"snapshotDir": snap, "manifestPath": os.path.join(snap, "manifest.sha256"), "manifestSha256": "无",
              "fileCount": 0, "head": head(), "outsideRepo": not (snap_real + os.sep).startswith(root + os.sep),
              "probes": [], "error": "无"}
    if not result["outsideRepo"]:
        result["error"] = "快照目录在仓库内"
        return result
    if os.path.exists(snap):
        result["error"] = "快照目录已存在"
        return result
    os.makedirs(snap)
    files = list_files()
    lines = []
    for p in files:
        dst = os.path.join(snap, "files", p)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(p, dst)
        lines.append(f"{sha256_file(p)}  {p}\n")
    with open(result["manifestPath"], "w", encoding="utf-8", errors="surrogateescape") as f:
        f.writelines(lines)
    result["manifestSha256"] = sha256_file(result["manifestPath"])
    result["fileCount"] = len(files)
    for p in probes:
        exists = os.path.isfile(p)
        result["probes"].append({"path": p, "exists": exists, "sha256": sha256_file(p) if exists else "无"})
    return result


def diff(snap, opts):
    before = read_manifest(snap)
    now = {p: sha256_file(p) for p in list_files()}
    changed = []
    for p in sorted(set(before) | set(now)):
        if p not in now:
            changed.append({"path": p, "change": "删除", "sha256": "无"})
        elif p not in before:
            changed.append({"path": p, "change": "新增", "sha256": now[p]})
        elif before[p] != now[p]:
            changed.append({"path": p, "change": "修改", "sha256": now[p]})
    result = {"changed": changed, "headAfter": head(), "lines": {}, "checkbox": {}, "prefix": {}, "same": {}, "error": "无"}
    for kind, path in opts:
        old = read_text(os.path.join(snap, "files", path))
        cur = read_text(path)
        if kind == "--lines":
            a = (old or "").splitlines()
            b = (cur or "").splitlines()
            result["lines"][path] = {"removed": len([l for l in a if l not in b]), "added": len([l for l in b if l not in a])}
        elif kind == "--checkbox":
            ca, cb = checkboxes(old), checkboxes(cur)
            result["checkbox"][path] = {
                "missingIds": sorted(set(ca) - set(cb)),
                "stateChanged": sorted(t for t in ca if t in cb and ca[t] != cb[t]),
                "newIds": sorted(set(cb) - set(ca)),
                "checkedNow": sorted(t for t, v in cb.items() if v),
            }
        elif kind == "--prefix":
            result["prefix"][path] = old is None or (cur is not None and cur.startswith(old))
        elif kind == "--same":
            result["same"][path] = old == cur
    return result


def fingerprint(out_path, paths):
    """审查输入指纹：对仓库内相对路径逐个求哈希，再对"哈希  路径"清单求哈希。结果写入 out_path（仓库外）。"""
    root = repo_root()
    bad = [p for p in paths if os.path.isabs(p) or ".." in p.split("/")]
    if bad:
        return {"error": f"路径必须是仓库内相对路径：{bad}"}
    files, missing = [], []
    for p in sorted(set(paths)):
        (files.append({"path": p, "sha256": sha256_file(p)}) if os.path.isfile(p) else missing.append(p))
    listing = "".join(f"{f['sha256']}  {f['path']}\n" for f in files)
    res = {"files": files, "missing": missing, "fingerprint": hashlib.sha256(listing.encode()).hexdigest(),
           "head": head(), "scopePath": out_path, "error": "无"}
    if (os.path.realpath(out_path) + os.sep).startswith(root + os.sep):
        return {"error": "指纹文件必须写在仓库外"}
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    return res


def refingerprint(scope_path, out_path):
    """按已保存的审查范围（scope.json 中的文件清单）重新计算指纹，判断审查之后这些文件是否变化。"""
    scope = json.load(open(scope_path, encoding="utf-8"))
    res = fingerprint(out_path, [f["path"] for f in scope["files"]])
    if res.get("error", "无") != "无":
        return res
    before = {f["path"]: f["sha256"] for f in scope["files"]}
    now = {f["path"]: f["sha256"] for f in res["files"]}
    res["originalFingerprint"] = scope["fingerprint"]
    res["matches"] = res["fingerprint"] == scope["fingerprint"]
    res["changedSinceReview"] = sorted(p for p in before if now.get(p) != before[p])
    return res


def guarded_run(snap, log_path, allowed, output_dirs, command):
    """在快照保护下执行一条检查命令（构建、lint、测试）。

    只恢复同时满足以下条件的文件：在 allowed 中（由用户决定明确允许）；执行前的内容与快照一致（没有其他并发修改）；
    在本次执行期间发生变化；快照中有副本。恢复后核对哈希。其他变化一律只记录、不恢复，由调用方暂停。
    命令输出写入仓库外的 log_path，不回传正文。
    """
    root = repo_root()
    if (os.path.realpath(log_path) + os.sep).startswith(root + os.sep):
        return {"error": "日志文件必须写在仓库外"}
    manifest = read_manifest(snap)
    pre = {p: sha256_file(p) for p in list_files()}
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, "wb") as log:
        proc = subprocess.run(command, shell=True, stdout=log, stderr=subprocess.STDOUT)
    post = {p: sha256_file(p) for p in list_files()}
    changed = sorted(p for p in set(pre) | set(post) if pre.get(p) != post.get(p))
    in_outputs = lambda p: any(p.startswith(d.rstrip("/") + "/") for d in output_dirs)
    restored, not_restored, outputs = [], [], []
    for p in changed:
        if in_outputs(p):
            outputs.append(p)
        elif p not in allowed:
            not_restored.append({"path": p, "reason": "不在允许恢复的文件中"})
        elif p not in manifest:
            not_restored.append({"path": p, "reason": "快照中没有该文件"})
        elif pre.get(p) != manifest[p]:
            not_restored.append({"path": p, "reason": "执行前已与快照不同，可能有其他修改，不能确认变化只来自本次执行"})
        elif p not in post:
            not_restored.append({"path": p, "reason": "执行后文件被删除"})
        else:
            shutil.copy2(os.path.join(snap, "files", p), p)
            ok = sha256_file(p) == manifest[p]
            (restored if ok else not_restored).append(p if ok else {"path": p, "reason": "恢复后哈希与快照不一致"})
    return {"command": command, "exitCode": proc.returncode, "logPath": log_path,
            "logLines": (read_text(log_path) or "").count("\n"), "changedDuringRun": changed,
            "restored": restored, "notRestored": not_restored, "outputs": outputs, "error": "无"}


def seal(codex_dir, codex_bin):
    """Codex 执行结束后封存：读取 output.txt / exit_code.txt / command.txt / scope.json，写 output.sha256 和 meta.json。不输出日志正文。"""
    out_file = os.path.join(codex_dir, "output.txt")
    scope = json.load(open(os.path.join(codex_dir, "scope.json"), encoding="utf-8"))
    exit_code = int(open(os.path.join(codex_dir, "exit_code.txt")).read().strip() or "-1")
    text = read_text(out_file) or ""
    m = re.search(r"session id:\s*([0-9a-fA-F-]{8,})", text)
    try:
        version = subprocess.run([codex_bin, "--version"], capture_output=True, text=True, timeout=30).stdout.strip() or "未知"
    except Exception as e:
        version = f"未知（{type(e).__name__}）"
    out_sha = sha256_file(out_file) if os.path.isfile(out_file) else "无"
    meta = {
        "codexPath": codex_bin, "version": version,
        "command": (read_text(os.path.join(codex_dir, "command.txt")) or "").strip(),
        "exitCode": exit_code, "sessionId": m.group(1) if m else "无",
        "status": "已完成" if exit_code == 0 and out_sha != "无" else "失败",
        "reviewedFiles": scope["files"], "codeFingerprint": scope["fingerprint"], "head": scope["head"],
        "outputPath": out_file, "outputSha256": out_sha, "outputLines": text.count("\n"),
    }
    with open(os.path.join(codex_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    with open(os.path.join(codex_dir, "output.sha256"), "w") as f:
        f.write(f"{out_sha}  output.txt\n")
    return {k: meta[k] for k in ("outputPath", "outputSha256", "exitCode", "sessionId", "status", "codeFingerprint", "outputLines")} | {
        "metaPath": os.path.join(codex_dir, "meta.json"), "error": "无"}


def reusecheck(output_path, expected_sha, meta_path, current_fp):
    """复用前核对：输出文件哈希、meta 记录的指纹与执行状态是否与当前一致。"""
    res = {"outputExists": os.path.isfile(output_path), "outputSha256": "无", "shaMatches": False, "metaExists": os.path.isfile(meta_path),
           "metaFingerprint": "无", "fingerprintMatches": False, "metaExitCode": None, "metaStatus": "无", "metaOutputShaMatches": False,
           "reusable": False, "error": "无"}
    if res["outputExists"]:
        res["outputSha256"] = sha256_file(output_path)
        res["shaMatches"] = res["outputSha256"] == expected_sha
    if res["metaExists"]:
        meta = json.load(open(meta_path, encoding="utf-8"))
        res["metaFingerprint"] = meta.get("codeFingerprint", "无")
        res["fingerprintMatches"] = res["metaFingerprint"] == current_fp
        res["metaExitCode"] = meta.get("exitCode")
        res["metaStatus"] = meta.get("status", "无")
        res["metaOutputShaMatches"] = meta.get("outputSha256") == res["outputSha256"]
    res["reusable"] = all([res["shaMatches"], res["fingerprintMatches"], res["metaExitCode"] == 0,
                           res["metaStatus"] == "已完成", res["metaOutputShaMatches"]])
    return res


# ---------------------------------------------------------------------
# 节点结果保存与续接（约定 2.6）
# ---------------------------------------------------------------------
RESULT_FORMAT = "wf-result/1"
IMPORT_FORMAT = "wf-imported/1"


def _outside_repo(path):
    root = repo_root()
    return not (os.path.realpath(path) + os.sep).startswith(root + os.sep)


def path_fingerprints(paths):
    out = {}
    for p in sorted(set(paths)):
        if os.path.isabs(p) or ".." in p.split("/"):
            raise ValueError(f"路径必须是仓库内相对路径：{p}")
        out[p] = sha256_file(p) if os.path.isfile(p) else ("目录" if os.path.isdir(p) else "缺失")
    return out


def _write_new(path, obj):
    """只新建，不覆盖。返回写入后文件的 sha256。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "x", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    return sha256_file(path)


def record(run_root, node, iteration, expected_sha, paths, payload):
    res = {"resultPath": "无", "resultSha256": "无", "envelopeSha256": "无", "fingerprints": {}, "head": head(), "error": "无"}
    if not os.path.isabs(run_root) or not _outside_repo(run_root):
        res["error"] = "run.root 必须是仓库外的绝对路径"
        return res
    text = payload.decode("utf-8")
    if text.endswith("\n"):
        text = text[:-1]
    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    res["envelopeSha256"] = sha
    if sha != expected_sha:
        res["error"] = "结果 JSON 的 sha256 与调度器给出的不一致（内容在传递中被改动），未保存"
        return res
    env = json.loads(text)
    if env.get("node") is None or str(iteration) != str(env.get("iteration")):
        res["error"] = "结果 JSON 缺少 node 或 iteration 与参数不一致，未保存"
        return res
    res["fingerprints"] = path_fingerprints(paths)
    out_path = os.path.join(run_root, "results", f"{node}-{iteration}.json")
    if os.path.exists(out_path):
        res["error"] = f"结果记录已存在，不覆盖：{out_path}"
        return res
    rec = {"format": RESULT_FORMAT, "runRoot": run_root, "nodeKey": node, "iteration": int(iteration),
           "envelopeSha256": sha, "envelopeJson": text, "fingerprints": res["fingerprints"], "head": res["head"]}
    res["resultPath"] = out_path
    res["resultSha256"] = _write_new(out_path, rec)
    return res


def record_from_output(output_path, run_root, run_id):
    """从工作流任务输出文件（harness 写出的 JSON）中取出调度脚本放入 result.pendingRecords 的节点结果原文，逐条保存。
    结果原文不经 agent 转写。来源必须一致：输出中的 context.run.root / run.id 等于参数；
    每条的 envelopeJson 必须与脚本计算的 envelopeSha256 一致，node / iteration 与原文一致；任一不满足则一条都不保存。
    实际写入复用 record()：仓库外、不覆盖，并按 paths 记录当前指纹。"""
    res = {"outputPath": output_path, "runRoot": run_root, "runId": run_id, "records": [], "error": "无"}
    try:
        doc = json.load(open(output_path, encoding="utf-8"))
    except Exception as e:  # noqa: BLE001
        res["error"] = f"无法读取工作流输出：{type(e).__name__}"
        return res
    result = doc.get("result") if isinstance(doc, dict) else None
    if not isinstance(result, dict):
        res["error"] = "工作流输出中没有 result"
        return res
    run = ((result.get("context") or {}).get("run") or {})
    if run.get("root") != run_root or run.get("id") != run_id:
        res["error"] = f"来源不符：输出中的运行为 {run.get('id')}（{run.get('root')}），不是 {run_id}（{run_root}）"
        return res
    pending = result.get("pendingRecords")
    if not isinstance(pending, list) or not pending:
        res["error"] = "工作流输出中没有待保存的结果（pendingRecords）"
        return res
    bad = []
    for i, p in enumerate(pending):
        text = p.get("envelopeJson") if isinstance(p, dict) else None
        if not isinstance(text, str) or not re.fullmatch(r"[0-9a-f]{64}", str(p.get("envelopeSha256", ""))):
            bad.append(f"第 {i + 1} 条缺少结果原文或 envelopeSha256")
            continue
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != p["envelopeSha256"]:
            bad.append(f"第 {i + 1} 条（{p.get('node')}-{p.get('iteration')}）：结果原文与 envelopeSha256 不一致")
            continue
        try:
            env = json.loads(text)
        except Exception:  # noqa: BLE001
            bad.append(f"第 {i + 1} 条：结果原文无法解析")
            continue
        if env.get("iteration") != p.get("iteration") or not p.get("node") or (env.get("node") != p.get("node") and p.get("node") != "UserRework"):
            bad.append(f"第 {i + 1} 条：node / iteration 与结果原文不一致")
        if not isinstance(p.get("paths"), list):
            bad.append(f"第 {i + 1} 条：缺少指纹路径")
    if bad:
        res["error"] = "；".join(bad) + "。未保存任何结果"
        return res
    for p in pending:
        r = record(run_root, p["node"], p["iteration"], p["envelopeSha256"], p["paths"], p["envelopeJson"].encode("utf-8"))
        res["records"].append({"node": p["node"], "iteration": p["iteration"], **r})
        if r.get("error") and r["error"] != "无":
            res["error"] = f"{p['node']}-{p['iteration']}：{r['error']}"
            return res
    return res


def export_records(out_path, pairs):
    """把已校验的结果记录正文导出为只读数据脚本，供调度脚本用 workflow({scriptPath}) 直接加载（正文不经 agent 转交）。
    每条记录：文件 sha256 必须等于调用方给出的值，envelopeJson 必须与记录中的 envelopeSha256 一致；任一不满足则不写文件。
    输出文件只新建、不覆盖，且必须在仓库外。"""
    res = {"outPath": out_path, "outSha256": "无", "records": [], "error": "无"}
    if len(pairs) == 0:
        res["error"] = "没有给出记录"
        return res
    if not os.path.isabs(out_path) or not _outside_repo(out_path):
        res["error"] = "输出文件必须是仓库外的绝对路径"
        return res
    if os.path.exists(out_path):
        res["error"] = "输出文件已存在，不覆盖"
        return res
    data, bad = [], []
    for path, expected in pairs:
        item = {"resultPath": path, "resultSha256": "无", "shaMatches": False, "envelopeSha256": "无", "envelopeIntact": False}
        if not os.path.isfile(path):
            bad.append(f"{path}：结果记录不存在")
        else:
            item["resultSha256"] = sha256_file(path)
            item["shaMatches"] = item["resultSha256"] == expected
            try:
                rec = json.load(open(path, encoding="utf-8"))
            except Exception as e:  # noqa: BLE001
                rec = None
                bad.append(f"{path}：无法解析（{type(e).__name__}）")
            if rec is not None:
                if rec.get("format") != RESULT_FORMAT:
                    bad.append(f"{path}：不是节点结果记录")
                env = rec.get("envelopeJson", "")
                item["envelopeSha256"] = rec.get("envelopeSha256", "无")
                item["envelopeIntact"] = isinstance(env, str) and hashlib.sha256(env.encode("utf-8")).hexdigest() == item["envelopeSha256"]
                if not item["shaMatches"]:
                    bad.append(f"{path}：记录文件的 sha256 与给出的不一致")
                elif not item["envelopeIntact"]:
                    bad.append(f"{path}：记录内容与其 envelopeSha256 不一致")
                else:
                    data.append({"resultPath": path, "resultSha256": item["resultSha256"], "envelopeSha256": item["envelopeSha256"], "envelopeJson": env})
        res["records"].append(item)
    if bad:
        res["error"] = "；".join(bad)
        return res
    payload = json.dumps({"format": "wf-records/1", "records": data}, ensure_ascii=True)
    module = ("export const meta = { name: 'bowen-resume-records', description: '续接记录正文（wf_snapshot.py export-records 生成的只读数据）' }\n"
              f"return {payload}\n")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "x", encoding="utf-8") as f:
        f.write(module)
    res["outSha256"] = sha256_file(out_path)
    return res


def resultcheck(result_path, expected_sha, meta_only=False):
    res = resultcheck_full(result_path, expected_sha)
    if meta_only:
        # 不输出正文（正文由 export-records 导出为数据脚本、由调度脚本直接加载），只给出正文字节数
        res["envelopeBytes"] = len(res.get("envelopeJson", "").encode("utf-8"))
        res["envelopeJson"] = ""
    return res


def resultcheck_full(result_path, expected_sha):
    res = {"resultPath": result_path, "resultSha256": "无", "shaMatches": False, "format": "无", "nodeKey": "无",
           "envelopeSha256": "无", "envelopeIntact": False, "envelopeJson": "", "fingerprints": [], "changed": [],
           "headRecorded": "无", "headNow": head(), "error": "无"}
    if not os.path.isfile(result_path):
        res["error"] = "结果记录不存在"
        return res
    res["resultSha256"] = sha256_file(result_path)
    res["shaMatches"] = res["resultSha256"] == expected_sha
    rec = json.load(open(result_path, encoding="utf-8"))
    res["format"] = rec.get("format", "无")
    if res["format"] != RESULT_FORMAT:
        res["error"] = f"不是节点结果记录（format={res['format']}）"
        return res
    res["nodeKey"] = rec.get("nodeKey", "无")
    res["envelopeSha256"] = rec.get("envelopeSha256", "无")
    res["envelopeJson"] = rec.get("envelopeJson", "")
    res["envelopeIntact"] = hashlib.sha256(res["envelopeJson"].encode("utf-8")).hexdigest() == res["envelopeSha256"]
    res["headRecorded"] = rec.get("head", "无")
    recorded = rec.get("fingerprints", {})
    now = path_fingerprints(list(recorded))
    res["fingerprints"] = [{"path": p, "recorded": recorded[p], "now": now[p], "same": recorded[p] == now[p]} for p in sorted(recorded)]
    res["changed"] = [f["path"] for f in res["fingerprints"] if not f["same"]]
    return res


def importorigin(wf_record, expected_sha, run_root):
    res = {"sourcePath": wf_record, "sourceSha256": "无", "error": "无"}
    if not os.path.isfile(wf_record):
        res["error"] = "运行记录不存在"
        return res
    res["sourceSha256"] = sha256_file(wf_record)
    if res["sourceSha256"] != expected_sha:
        res["error"] = "运行记录的 sha256 与给出的不一致"
        return res
    if not os.path.isabs(run_root) or not _outside_repo(run_root):
        res["error"] = "run.root 必须是仓库外的绝对路径"
        return res
    d = json.load(open(wf_record, encoding="utf-8"))
    results = (d.get("result") or {}).get("results") or []
    w4 = [e for e in results if e.get("node") == "W4"]
    if not w4:
        res["error"] = "运行记录中没有 W4 结果"
        return res
    env = w4[-1]
    orig_run = ((d.get("args") or {}).get("run") or {}).get("id", "无")
    env_json = json.dumps(env, ensure_ascii=False)
    out_path = os.path.join(run_root, "results", f"imported-W4-{orig_run}-{env.get('iteration')}.json")
    rec = {"format": IMPORT_FORMAT, "sourcePath": wf_record, "sourceSha256": res["sourceSha256"],
           "workflowRunId": d.get("runId", "无"), "originalRunId": orig_run,
           "note": "原样导入，保留原 nextNode；不是新的节点结果，不能直接续接",
           "envelopeSha256": hashlib.sha256(env_json.encode("utf-8")).hexdigest(), "envelopeJson": env_json}
    if os.path.exists(out_path):
        old = json.load(open(out_path, encoding="utf-8"))
        if old != rec:
            res["error"] = f"导入记录已存在且内容不同，不覆盖：{out_path}"
            return res
        res["importedState"] = "已存在且一致"
        res["importedSha256"] = sha256_file(out_path)
    else:
        res["importedState"] = "新建"
        res["importedSha256"] = _write_new(out_path, rec)
    data = env.get("data") or {}
    deferred = data.get("deferred") or []
    deferred_texts = {x.get("text") for x in deferred}
    blocking = []
    for r in data.get("results") or []:
        for x in r.get("issues") or []:
            k = x.get("kind")
            if k == "本批变化导致的过时表述" or (k == "后续任务负责" and x.get("text") in deferred_texts):
                continue
            blocking.append({"taskId": r.get("taskId"), "kind": k, "basis": x.get("basis"), "text": x.get("text")})
    snap = next((a for a in env.get("artifacts") or [] if a.get("kind") == "snapshot"), {})
    res.update({
        "workflowRunId": d.get("runId", "无"), "originalRunId": orig_run, "importedPath": out_path,
        "envelopeSha256": rec["envelopeSha256"], "node": env.get("node"), "iteration": env.get("iteration"),
        "nextNode": env.get("nextNode"), "stoppedAt": env.get("stoppedAt"), "reason": env.get("reason"),
        "batchId": env.get("batchId"), "reportPath": data.get("reportPath", "无"),
        "tasks": [{"id": t.get("id"), "kind": t.get("kind"), "allowedFiles": t.get("allowedFiles") or []} for t in data.get("tasks") or []],
        "results": [{"taskId": r.get("taskId"), "outcome": r.get("outcome")} for r in data.get("results") or []],
        "pending": data.get("pending") or [],
        "originalResume": (d.get("args") or {}).get("resume") or "无",
        "deferred": [{"id": x.get("id"), "ownerTaskId": x.get("ownerTaskId"), "resolved": x.get("resolved")} for x in deferred],
        "blockingIssues": blocking,
        "preexistingChanges": [{"path": c.get("path")} for c in data.get("preexistingChanges") or []],
        "writes": env.get("writes") or [],
        "snapshotPath": snap.get("path", "无"), "snapshotSha256": snap.get("sha256", "无"),
    })
    return res


def prefixcheck(path, expected_sha, nbytes):
    res = {"path": path, "bytes": 0, "originalBytes": int(nbytes), "prefixMatches": False, "appended": "", "currentSha256": "无", "error": "无"}
    if not os.path.isfile(path):
        res["error"] = "文件不存在"
        return res
    data = open(path, "rb").read()
    res["bytes"] = len(data)
    res["currentSha256"] = hashlib.sha256(data).hexdigest()
    n = int(nbytes)
    res["prefixMatches"] = len(data) >= n and hashlib.sha256(data[:n]).hexdigest() == expected_sha
    if res["prefixMatches"]:
        res["appended"] = data[n:].decode("utf-8", errors="replace")
    return res


def citecheck(path, expected_sha, needles):
    """只读：确认文件当前内容的 sha256 等于历史记录中的值，并返回同时包含全部 needles 的行号。
    哈希不一致时不搜索（内容已不是被记录的那一版，不能作为历史证明）。"""
    res = {"path": path, "expectedSha256": expected_sha, "currentSha256": "无", "shaMatches": False, "lines": [], "error": "无"}
    if not needles:
        res["error"] = "缺少要查找的内容"
        return res
    if not os.path.isfile(path):
        res["error"] = "文件不存在"
        return res
    data = open(path, "rb").read()
    res["currentSha256"] = hashlib.sha256(data).hexdigest()
    res["shaMatches"] = res["currentSha256"] == expected_sha
    if res["shaMatches"]:
        text = data.decode("utf-8", errors="replace")
        res["lines"] = [i for i, line in enumerate(text.split("\n"), 1) if all(n in line for n in needles)]
    return res


def main(argv):
    cmds = ("take", "diff", "fingerprint", "refingerprint", "seal", "reusecheck", "guarded-run", "record", "resultcheck", "export-records", "record-from-output", "importorigin", "prefixcheck", "citecheck")
    if len(argv) < 3 or argv[1] not in cmds:
        print(json.dumps({"error": f"用法：{'|'.join(cmds)} ..."}, ensure_ascii=False))
        return 2
    try:
        if argv[1] == "take":
            out = take(argv[2], argv[3:])
        elif argv[1] == "fingerprint":
            out = fingerprint(argv[2], argv[3:])
        elif argv[1] == "guarded-run":
            if "--" not in argv:
                raise ValueError("guarded-run 需要用 -- 分隔命令")
            sep = argv.index("--")
            head_args, command = argv[4:sep], " ".join(argv[sep + 1:])
            allowed, dirs = [], []
            while head_args:
                if head_args[0] not in ("--allow", "--output-dir") or len(head_args) < 2:
                    raise ValueError(f"无法识别的参数：{head_args[0]}")
                (allowed if head_args[0] == "--allow" else dirs).append(head_args[1])
                head_args = head_args[2:]
            out = guarded_run(argv[2], argv[3], allowed, dirs, command)
        elif argv[1] == "refingerprint":
            out = refingerprint(argv[2], argv[3])
        elif argv[1] == "seal":
            out = seal(argv[2], argv[3])
        elif argv[1] == "reusecheck":
            out = reusecheck(argv[2], argv[3], argv[4], argv[5])
        elif argv[1] == "record":
            rest, paths = argv[6:], []
            while rest:
                if rest[0] != "--path" or len(rest) < 2:
                    raise ValueError(f"无法识别的参数：{rest[0]}")
                paths.append(rest[1])
                rest = rest[2:]
            out = record(argv[2], argv[3], argv[4], argv[5], paths, sys.stdin.buffer.read())
        elif argv[1] == "resultcheck":
            if len(argv) not in (4, 5) or (len(argv) == 5 and argv[4] != "--meta"):
                raise ValueError("用法：resultcheck <结果记录> <sha256> [--meta]")
            out = resultcheck(argv[2], argv[3], len(argv) == 5)
        elif argv[1] == "record-from-output":
            if len(argv) != 5:
                raise ValueError("用法：record-from-output <工作流输出文件> <run.root> <run.id>")
            out = record_from_output(argv[2], argv[3], argv[4])
        elif argv[1] == "export-records":
            rest = argv[3:]
            if not rest or len(rest) % 2:
                raise ValueError("用法：export-records <输出文件> <结果记录> <sha256> [<结果记录> <sha256> ...]")
            out = export_records(argv[2], [(rest[i], rest[i + 1]) for i in range(0, len(rest), 2)])
        elif argv[1] == "importorigin":
            out = importorigin(argv[2], argv[3], argv[4])
        elif argv[1] == "prefixcheck":
            out = prefixcheck(argv[2], argv[3], argv[4])
        elif argv[1] == "citecheck":
            out = citecheck(argv[2], argv[3], argv[4:])
        else:
            rest, opts = argv[3:], []
            while rest:
                if rest[0] not in ("--lines", "--checkbox", "--prefix", "--same") or len(rest) < 2:
                    raise ValueError(f"无法识别的参数：{rest[0]}")
                opts.append((rest[0], rest[1]))
                rest = rest[2:]
            out = diff(argv[2], opts)
    except Exception as e:  # 失败时也输出 JSON，由脚本判断
        out = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
