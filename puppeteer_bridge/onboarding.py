"""Prepare a fixed, reusable coding workspace for an owner-approved group."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

from .errors import BridgeError


def roster(bridge):
    try:
        value = json.loads((bridge.install / "run/roster.json").read_text())
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise BridgeError("local_team_unavailable")


def workspace(path):
    if path.is_symlink() or path.parent.is_symlink() or (path / ".git").is_symlink():
        raise BridgeError("demo_workspace_unavailable")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)

    def git(*args):
        try:
            return subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            raise BridgeError("demo_workspace_preparation_failed")

    if not (path / ".git").exists() and git("init", "-q").returncode:
        raise BridgeError("demo_workspace_preparation_failed")
    if git("rev-parse", "--verify", "HEAD").returncode == 0:
        if Path(git("rev-parse", "--show-toplevel").stdout.strip()).resolve() != path.resolve():
            raise BridgeError("demo_workspace_unavailable")
        return
    files = {
        "README.md": "# Puppeteer group workspace\n\nA fresh coding project for your group. Ask Puppeteer to change it with /prompt.\n",
        "greeting.py": 'def greet(name):\n    return f"Hello, {name}!"\n',
        "test_greeting.py": 'import unittest\nfrom greeting import greet\n\n\nclass GreetingTest(unittest.TestCase):\n    def test_greeting(self):\n        self.assertEqual(greet("Sam"), "Hello, Sam!")\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
        ".gitignore": "__pycache__/\n.DS_Store\n.env\n",
    }
    for name, text in files.items():
        try:
            with (path / name).open("x") as stream:
                stream.write(text)
        except FileExistsError:
            pass
    for args in [("add", *files),
                 ("-c", "user.name=Puppeteer", "-c", "user.email=puppeteer@example.invalid",
                  "commit", "-qm", "Create group coding workspace")]:
        if git(*args).returncode:
            raise BridgeError("demo_workspace_preparation_failed")


def prepare_demo(bridge, group, target, save):
    if os.environ.get("AGENT_ID"):
        raise BridgeError("owner_onboarding_required")
    if not isinstance(group, str) or not re.fullmatch(r"cht_[A-Za-z0-9_-]+", group):
        raise BridgeError("invalid_group_id")
    prefix = bridge.cfg["HOST_ID"] + "/"
    key = hashlib.sha256(group.encode()).hexdigest()[:16]
    project = prefix + "puppeteer-demo-" + key + ":coder"
    new_boss = prefix + "puppeteer-demo-" + key + ":Boss"
    path = bridge.install / "run/eng/puppeteer-demos" / key
    state = bridge.state / "onboarding"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(state / (key + ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BridgeError("demo_setup_in_progress")
        manifest = state / (key + ".json")
        if manifest.is_symlink():
            raise BridgeError("demo_workspace_unavailable")
        try:
            data = json.loads(manifest.read_text())
        except FileNotFoundError:
            bosses = [row["target"] for row in bridge.discover()["local_agents"] if row.get("role") == "boss"]
            if target is not None and target not in bosses:
                raise BridgeError("select_an_existing_myplow_boss")
            if target is None:
                if prefix + "main:Boss" in bosses:
                    target = prefix + "main:Boss"
                elif len(bosses) == 1:
                    target = bosses[0]
                elif bosses:
                    raise BridgeError("choose_one_of_the_existing_bosses")
                else:
                    target = new_boss
            backend = (bridge.cfg.get("DEFAULT_AGENT_BACKEND") or bridge.cfg.get("DEFAULT_BACKEND", "claude")).strip().lower()
            if backend not in ("claude", "codex"):
                raise BridgeError("demo_requires_claude_or_codex")
            if path.exists() or path.is_symlink() or path.parent.is_symlink() or project in roster(bridge):
                raise BridgeError("demo_workspace_already_exists")
            data = {"group": group, "target": target, "project": project, "backend": backend,
                    "boss_created": target == new_boss}
            save(manifest, data)
        except (OSError, ValueError):
            raise BridgeError("demo_workspace_unavailable")
        if (not isinstance(data, dict) or data.get("group") != group or data.get("project") != project
                or not isinstance(data.get("target"), str)
                or not re.fullmatch(re.escape(prefix) + r"[A-Za-z0-9_-]+:[A-Za-z0-9_-]+", data["target"])
                or data.get("backend") not in ("claude", "codex") or type(data.get("boss_created")) is not bool):
            raise BridgeError("demo_workspace_unavailable")
        if target is not None and data["target"] != target:
            raise BridgeError("demo_already_uses_another_boss")
        target = data["target"]
        workspace(path)
        for agent, boss in [(target, True), (project, False)]:
            record = roster(bridge).get(agent)
            if record is None:
                if boss and (not data["boss_created"] or agent != new_boss):
                    raise BridgeError("local_agent_unavailable")
                args = [str(bridge.install / "bin/mp"), "spawn", agent, "--backend", data["backend"], "--cwd", str(path)]
                args += ["--master", "--role", "boss"] if boss else ["--boss", target]
                try:
                    result = subprocess.run(args, env=bridge.environment(), capture_output=True, text=True, timeout=45)
                except subprocess.TimeoutExpired:
                    raise BridgeError("demo_spawn_delivery_unknown")
                except OSError:
                    raise BridgeError("myplow_runtime_unavailable")
                if result.returncode:
                    raise BridgeError("demo_native_spawn_failed")
                record = roster(bridge).get(agent)
            if (not isinstance(record, dict) or record.get("retired") or bool(record.get("is_master")) != boss
                    or (not boss and (not isinstance(record.get("cwd"), str)
                        or record.get("backend") != data["backend"] or record.get("boss_id") != target
                        or Path(record.get("cwd", "")).resolve() != path.resolve()))):
                raise BridgeError("demo_native_session_unavailable")
        from .team import Team
        Team.validate(bridge, target, {"project": project, "workers": 4})
        return {"demo_prepared": True, "target": target, "project": project, "boss_created": data["boss_created"]}
