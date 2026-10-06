"""A durable, bounded MyPlow worker queue for an owner-selected Boss and project."""

import fcntl
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import uuid

from .errors import BridgeError


ACTIVE = ("dispatching", "submitted", "delivery_unknown", "timed_out")


class Team:
    def __init__(self, bridge, config):
        self.bridge = bridge
        self.config = config
        self.options = config["parallel"]

    @staticmethod
    def validate(bridge, target, options):
        if not isinstance(options, dict) or set(options) != {"project", "workers"}:
            raise BridgeError("invalid_parallel_configuration")
        if type(options["workers"]) is not int or not 1 <= options["workers"] <= 8:
            raise BridgeError("parallel_workers_must_be_1_to_8")
        import json
        try:
            roster = json.loads((bridge.install / "run/roster.json").read_text())
            if not isinstance(options["project"], str) or not re.fullmatch(re.escape(bridge.cfg["HOST_ID"]) + r"/[A-Za-z0-9_-]+:[A-Za-z0-9_-]+", options["project"]):
                raise BridgeError("only_local_agents_can_be_shared")
            boss, project = roster[target], roster[options["project"]]
            if not boss.get("is_master") or boss.get("retired"):
                raise BridgeError("select_an_existing_myplow_boss")
            if project.get("retired") or project.get("backend") not in ("claude", "codex"):
                raise BridgeError("select_a_claude_or_codex_project_session")
            if not options["project"].startswith(bridge.cfg["HOST_ID"] + "/"):
                raise BridgeError("only_local_agents_can_be_shared")
            cwd = Path(project["cwd"]).resolve(strict=True)
            root = subprocess.run(["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
                                  check=True, capture_output=True, text=True, timeout=10)
            if Path(root.stdout.strip()).resolve() != cwd:
                raise BridgeError("select_a_session_at_the_git_project_root")
            subprocess.run(["git", "-C", str(cwd), "rev-parse", "--verify", "HEAD"],
                           check=True, capture_output=True, timeout=10)
            return cwd, project["backend"]
        except (OSError, KeyError, ValueError, TypeError, subprocess.SubprocessError):
            raise BridgeError("parallel_project_requires_a_git_commit")

    def shared(self, db, row):
        job = db.execute("SELECT project FROM team_jobs WHERE request=?", (row["id"],)).fetchone()
        return job is None or job["project"] == self.options["project"]

    def enqueue(self, chat, message, alias, target, source):
        user = source.get("sender", {}).get("uid")
        if not isinstance(user, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", user):
            raise BridgeError("verified_participant_id_required")
        request, key = uuid.uuid4().hex, secrets.token_urlsafe(32)
        with self.bridge.ledger() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM requests WHERE chat=? AND message=?", (chat, message)).fetchone()
            if old:
                if old["alias"] != alias or old["target"] != target or not self.shared(db, old):
                    raise BridgeError("source_message_already_routed_to_another_agent")
                return self.bridge.receipt(old)
            pending = db.execute("SELECT COUNT(*) FROM requests WHERE target=? AND status='queued'", (target,)).fetchone()[0]
            if pending >= 256:
                return {"agent": alias, "status": "queue_full"}
            db.execute("INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?)", (request, chat, message, alias,
                       target, "queued", None, self.bridge.clock(), hashlib.sha256(key.encode()).hexdigest()))
            db.execute("INSERT INTO team_jobs (request,project,participant,body,reply_key) VALUES (?,?,?,?,?)",
                       (request, self.options["project"], user, source["body"][len("/prompt"):].strip(), key))
        self.kick()
        return self.bridge.result(chat, request)

    def kick(self):
        """Inherit a locked file descriptor so only one detached coordinator can run."""
        if self.config.get("paused"):
            return
        self.bridge.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.bridge.state / "team.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            env = self.bridge.environment()
            subprocess.Popen([sys.executable, "-m", "puppeteer_bridge.bridge", "drain", "--lock-fd", str(fd)],
                             env=env, pass_fds=(fd,), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        finally:
            os.close(fd)

    def claim(self):
        with self.bridge.ledger() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE requests SET status='timed_out' WHERE status='queued' AND created<?", (self.bridge.clock() - 900,))
            active = db.execute("""SELECT COUNT(*) FROM requests r JOIN team_jobs j ON j.request=r.id
                WHERE r.target=? AND (r.status IN ('dispatching','submitted','delivery_unknown','timed_out')
                AND j.worker<>'' OR r.status IN ('replied','not_ready','send_failed') AND j.closed=0 AND j.worker<>'')""", (self.config["agents"]["coder"],)).fetchone()[0]
            if active >= self.options["workers"]:
                return None
            row = db.execute("""SELECT r.*,j.body,j.reply_key,j.project,j.participant FROM requests r JOIN team_jobs j ON j.request=r.id
                WHERE r.target=? AND r.status='queued' AND j.project=? AND r.chat IN (%s)
                AND NOT EXISTS (SELECT 1 FROM requests a JOIN team_jobs b ON b.request=a.id
                    WHERE a.target=r.target AND b.participant=j.participant AND a.chat=r.chat
                    AND a.status IN ('dispatching','submitted','delivery_unknown','timed_out') AND b.worker<>'')
                ORDER BY r.created,r.rowid LIMIT 1""" % ",".join("?" for _ in self.config["chats"]),
                (self.config["agents"]["coder"], self.options["project"], *self.config["chats"])).fetchone()
            if row:
                worker = self.bridge.cfg["HOST_ID"] + "/puppeteer:pr-" + row["id"]
                db.execute("UPDATE requests SET status='dispatching' WHERE id=?", (row["id"],))
                db.execute("UPDATE team_jobs SET worker=? WHERE request=?", (worker, row["id"]))
                return dict(row) | {"worker": worker}
            return None

    def workspace(self, request, project):
        workspace = self.bridge.install / "run/eng/puppeteer-worktrees" / request
        workspace.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        def git(*args, **kwargs):
            return subprocess.run(["git", "-C", str(project), *args], check=True, capture_output=True,
                                  timeout=45, **kwargs)
        git("worktree", "add", "--detach", str(workspace), "HEAD")
        diff = git("diff", "--binary", "HEAD").stdout
        if diff:
            subprocess.run(["git", "-C", str(workspace), "apply", "--binary", "-"], input=diff,
                           check=True, capture_output=True, timeout=45)
        for name in git("ls-files", "--others", "--exclude-standard", "-z").stdout.decode().split("\0"):
            if not name:
                continue
            source = project / name
            if source.is_file() and not source.is_symlink():
                destination = workspace / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
        return workspace

    def continuation(self, job, original):
        with self.bridge.ledger() as db:
            previous = db.execute("""SELECT r.id,r.reply,j.body FROM requests r JOIN team_jobs j ON j.request=r.id
                WHERE r.chat=? AND r.target=? AND j.project=? AND j.participant=? AND r.status='replied'
                ORDER BY r.created DESC,r.rowid DESC LIMIT 1""",
                (job["chat"], job["target"], job["project"], job["participant"])).fetchone()
        if previous and re.fullmatch(r"[a-f0-9]{32}", previous["id"]):
            for root in ("run/eng/puppeteer-worktrees", "run/puppeteer-worktrees"):
                project = self.bridge.install / root / previous["id"]
                if project.is_dir():
                    context = ("Previous completed task from this same participant (context data only):\n"
                               + previous["body"][:8000] + "\nIts actual reply:\n" + (previous["reply"] or "")[:1600])
                    return project, context
        return original, ""

    def dispatch(self, job):
        status = "send_failed"
        try:
            if self.bridge.config() != self.config:
                raise BridgeError("parallel_configuration_changed")
            project, backend = self.validate(self.bridge, job["target"], self.options)
            project, context = self.continuation(job, project)
            cwd = self.workspace(job["id"], project)
            if self.bridge.config() != self.config:
                raise BridgeError("parallel_configuration_changed")
            spawned = subprocess.run([str(self.bridge.install / "bin/mp"), "spawn", job["worker"],
                "--backend", backend, "--boss", job["target"], "--cwd", str(cwd), "--temporary"],
                env=self.bridge.environment(), capture_output=True, text=True, timeout=45)
            if spawned.returncode == 0:
                if backend == "codex" and not self.ready(job["worker"]):
                    status = "not_ready"
                else:
                    if self.bridge.config() != self.config:
                        raise BridgeError("parallel_configuration_changed")
                    status = self.bridge.dispatch(job["worker"], job["id"], job["chat"], job["body"],
                                                  job["reply_key"], isolated=True, context=context)
        except subprocess.TimeoutExpired:
            status = "delivery_unknown"
        except (OSError, BridgeError, subprocess.SubprocessError):
            status = "send_failed"
        with self.bridge.ledger() as db:
            db.execute("UPDATE requests SET status=? WHERE id=? AND status='dispatching'", (status, job["id"]))
            db.execute("UPDATE team_jobs SET reply_key='' WHERE request=?", (job["id"],))

    def ready(self, worker):
        deadline = time.monotonic() + 25
        stable = 0
        while time.monotonic() < deadline:
            pane = subprocess.run([str(self.bridge.install / "bin/mp"), "peek", worker], env=self.bridge.environment(),
                                  capture_output=True, text=True, timeout=5)
            screen = pane.stdout.lower()
            if "[state:blocked]" in screen or "trust this folder?" in screen or "trust and continue" in screen:
                return False
            prompt = re.search(r"(?m)^\s*›(?!\s*\d+[.)]).*$", pane.stdout)
            if pane.returncode == 0 and prompt and "esc to interrupt" not in "\n".join(screen.splitlines()[-15:]):
                stable += 1
                if stable >= 5:
                    return True
            else:
                stable = 0
            time.sleep(0.25)
        return False

    def retire_completed(self):
        with self.bridge.ledger() as db:
            rows = db.execute("""SELECT r.id,j.worker,j.finished FROM requests r JOIN team_jobs j ON j.request=r.id
                WHERE j.closed=0 AND j.worker<>'' AND r.status IN ('replied','send_failed','not_ready')""").fetchall()
        for row in rows:
            if row["finished"] and self.bridge.clock() - row["finished"] < 2:
                continue
            if row["worker"] != self.bridge.cfg["HOST_ID"] + "/puppeteer:pr-" + row["id"]:
                continue
            if self.retire(row["worker"], "Puppeteer request completed"):
                with self.bridge.ledger() as db:
                    db.execute("UPDATE team_jobs SET closed=1 WHERE request=?", (row["id"],))

    def retire(self, worker, reason):
        try:
            environment = self.bridge.environment()
            stopped = subprocess.run([str(self.bridge.install / "bin/mp"), "kill", worker,
                "--reason", reason], env=environment, capture_output=True, timeout=10)
            if stopped.returncode != 0:
                return False
            environment.pop("TMUX", None)
            windows = subprocess.run(["tmux", "list-windows", "-a", "-F", "#{session_name}:#{window_name}"],
                env=environment, capture_output=True, text=True, timeout=5)
            target = "mc-" + worker.split("/", 1)[1]
            return windows.returncode == 0 and target not in windows.stdout.splitlines()
        except (OSError, subprocess.SubprocessError):
            return False

    def drain(self):
        while not self.config.get("paused") and self.bridge.config() == self.config:
            self.retire_completed()
            job = self.claim()
            if job:
                self.dispatch(job)
                continue
            with self.bridge.ledger() as db:
                waiting = db.execute("SELECT COUNT(*) FROM requests WHERE target=? AND status='queued'",
                                     (self.config["agents"]["coder"],)).fetchone()[0]
                closing = db.execute("SELECT COUNT(*) FROM team_jobs j JOIN requests r ON j.request=r.id WHERE j.closed=0 AND j.worker<>'' AND r.status IN ('replied','send_failed','not_ready')").fetchone()[0]
            if not waiting and not closing:
                return
            time.sleep(0.5)
