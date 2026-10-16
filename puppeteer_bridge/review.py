"""Owner review: what the group's workers changed, and keeping a change as a branch.

Workers never merge, push or publish. Their worktrees stay on the Mac, and the
owner decides from their private chat what to keep. Keeping writes one commit
on a new branch, puppeteer/<request>, with Git plumbing: no hooks run, and the
project's checkout, index and HEAD are untouched.
"""

import os
from pathlib import Path
import re
import subprocess
import uuid

from .errors import BridgeError

ROOTS = ("run/eng/puppeteer-worktrees", "run/puppeteer-worktrees")
AUTHOR = {"GIT_AUTHOR_NAME": "Puppeteer", "GIT_AUTHOR_EMAIL": "puppeteer@example.invalid",
          "GIT_COMMITTER_NAME": "Puppeteer", "GIT_COMMITTER_EMAIL": "puppeteer@example.invalid"}


def git(path, *args, env=None):
    try:
        result = subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True,
                                timeout=45, env={**os.environ, **(env or {})})
    except (OSError, subprocess.TimeoutExpired):
        raise BridgeError("review_git_unavailable")
    if result.returncode:
        raise BridgeError("review_git_failed")
    return result.stdout.strip()


def snapshot_tree(path, scratch):
    """The tree of everything Git would track in a worktree, read without touching its index."""
    scratch = Path(scratch)
    scratch.mkdir(parents=True, exist_ok=True, mode=0o700)
    index = scratch / ("index-" + uuid.uuid4().hex)
    env = {"GIT_INDEX_FILE": str(index)}
    try:
        git(path, "read-tree", "HEAD", env=env)
        git(path, "add", "-A", env=env)
        return git(path, "write-tree", env=env)
    finally:
        try:
            index.unlink()
        except FileNotFoundError:
            pass


def worktree(bridge, request):
    for root in ROOTS:
        path = bridge.install / root / request
        if path.is_dir() and not path.is_symlink():
            return path
    return None


def branch(request):
    return "puppeteer/" + request[:8]


def branch_commit(path, name):
    result = subprocess.run(["git", "-C", str(path), "rev-parse", "--verify", "--quiet", "refs/heads/" + name],
                            capture_output=True, text=True, timeout=15)
    return result.stdout.strip() if result.returncode == 0 else None


def summary(body):
    line = next((part.strip() for part in body.splitlines() if part.strip()), "Puppeteer task")
    line = re.sub(r"[\x00-\x1f\x7f]", " ", line)
    return line[:69] + "..." if len(line) > 72 else line


def diffstat(path, base, work):
    files = insertions = deletions = 0
    for row in git(path, "diff", "--numstat", base, work).splitlines():
        added, removed, _ = row.split("\t", 2)
        files += 1
        insertions += int(added) if added.isdigit() else 0
        deletions += int(removed) if removed.isdigit() else 0
    return {"files": files, "insertions": insertions, "deletions": deletions}


def finished(bridge, config, prefix=None):
    """Replied requests for the configured project, newest first."""
    if "parallel" not in config:
        raise BridgeError("parallel_mode_not_configured")
    query = """SELECT r.id, j.body, j.base_tree FROM requests r JOIN team_jobs j ON j.request=r.id
        WHERE r.target=? AND j.project=? AND r.status='replied'"""
    args = [config["agents"]["coder"], config["parallel"]["project"]]
    if prefix is not None:
        query += " AND substr(r.id, 1, ?)=?"
        args += [len(prefix), prefix]
    with bridge.ledger() as db:
        return db.execute(query + " ORDER BY r.created DESC, r.rowid DESC LIMIT 50", args).fetchall()


def changes(bridge, limit=10):
    found = []
    for row in finished(bridge, bridge.config()):
        path = worktree(bridge, row["id"])
        if path is None:
            continue
        kept = branch_commit(path, branch(row["id"]))
        if kept:
            found.append({"request": row["id"], "task": summary(row["body"]), "kept": True, "branch": branch(row["id"])})
        else:
            base = row["base_tree"] or git(path, "rev-parse", "HEAD^{tree}")
            work = snapshot_tree(path, bridge.state / "review")
            if work == base:
                continue
            found.append({"request": row["id"], "task": summary(row["body"]), "kept": False, **diffstat(path, base, work)})
        if len(found) >= limit:
            break
    return {"changes": found}


def keep(bridge, request):
    if os.environ.get("AGENT_ID"):
        raise BridgeError("owner_onboarding_required")
    if not isinstance(request, str) or not re.fullmatch(r"[a-f0-9]{8}|[a-f0-9]{32}", request):
        raise BridgeError("invalid_request_id")
    rows = finished(bridge, bridge.config(), request)
    if len(rows) != 1:
        raise BridgeError("ambiguous_request_id" if rows else "request_not_finished")
    row = rows[0]
    path = worktree(bridge, row["id"])
    if path is None:
        raise BridgeError("worktree_unavailable")
    name = branch(row["id"])
    existing = branch_commit(path, name)
    if existing:
        return {"kept": True, "branch": name, "commit": existing[:12]}
    head = git(path, "rev-parse", "HEAD")
    base = row["base_tree"] or git(path, "rev-parse", "HEAD^{tree}")
    work = snapshot_tree(path, bridge.state / "review")
    if work == base:
        raise BridgeError("no_changes_to_keep")
    short = row["id"][:8]
    parent = head
    if base != git(path, "rev-parse", "HEAD^{tree}"):
        # Uncommitted project work was copied into the worktree when the task started.
        parent = git(path, "commit-tree", base, "-p", head, "-m",
                     "Puppeteer #" + short + ": starting state\n\nUncommitted project work present when this task started.", env=AUTHOR)
    commit = git(path, "commit-tree", work, "-p", parent, "-m",
                 "Puppeteer #" + short + ": " + summary(row["body"])
                 + "\n\nRequested in a Plow group through Puppeteer. Review before merging.", env=AUTHOR)
    # An empty old value creates the branch only if it does not exist yet.
    git(path, "update-ref", "refs/heads/" + name, commit, "")
    return {"kept": True, "branch": name, "commit": commit[:12], **diffstat(path, base, work)}
