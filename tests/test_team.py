"""Real Git worktrees and ledger; native MyPlow processes are simulated."""
from concurrent.futures import ThreadPoolExecutor
import base64
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from puppeteer_bridge.bridge import Bridge, BridgeError
from puppeteer_bridge.team import Team


class TeamTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "project"
        self.project.mkdir()
        self.run = subprocess.run
        for args in (["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"]):
            self.git(*args)
        (self.project / "answer.txt").write_text("base\n")
        (self.project / ".gitignore").write_text(".env\n")
        self.git("add", ".")
        self.git("commit", "-qm", "Fixture")
        (self.project / "answer.txt").write_text("dirty source\n")
        (self.project / "notes.txt").write_text("untracked context\n")
        (self.project / ".env").write_text("private ignored fixture\n")
        self.install = self.root / "myplow"
        (self.install / "run").mkdir(parents=True)
        (self.install / "run/roster.json").write_text(json.dumps({
            "sam/main:Boss": {"is_master": True, "backend": "codex", "cwd": str(self.install / "run/boss")},
            "sam/demo:coder": {"backend": "codex", "cwd": str(self.project)},
        }))
        self.now = datetime.datetime.now(datetime.timezone.utc).timestamp()
        self.bridge = Bridge({"INSTALL_DIR": str(self.install), "HOST_ID": "sam"}, self.root / "bridge.json", clock=lambda: self.now)
        self.key = "c" * 64
        self.pair(workers=4)
        self.jobs = {}
        self.commands = []
        def native(argv, **kwargs):
            if argv[0] == "tmux":
                return subprocess.CompletedProcess(argv, 0, "mc-main:Boss\n", "")
            if argv[0] != str(self.install / "bin/mp"):
                return self.run(argv, **kwargs)
            self.commands.append(argv)
            if argv[1] == "peek":
                return subprocess.CompletedProcess(argv, 0, "[state:IDLE]\n› Ask a question\n", "")
            if argv[1] == "send":
                body = kwargs["input"]
                command = shlex.split(next(line for line in body.splitlines() if line.startswith("env ")))
                request = command[command.index("reply") + 1]
                self.jobs[request] = {"worker": argv[2], "key": command[command.index("--key") + 1], "body": body}
            return subprocess.CompletedProcess(argv, 0, "sent", "")
        self.native = patch("subprocess.run", side_effect=native)
        self.native.start()
        self.addCleanup(self.native.stop)
        self.kick = patch.object(Team, "kick")
        self.kick.start()
        self.addCleanup(self.kick.stop)

    def git(self, *args):
        return self.run(["git", "-C", str(self.project), *args], check=True, capture_output=True)

    def pair(self, workers=4, project="sam/demo:coder", target="sam/main:Boss"):
        request = "b" * 32
        self.bridge.prepare(request)
        self.bridge.pairing_path(request).write_text(json.dumps({"target": target, "chats": ["cht_group"], "source_key": self.key,
            "parallel": {"project": project, "workers": workers}}))
        self.bridge.pair(request)
        self.team = Team(self.bridge, self.bridge.config())

    def ask(self, i, user=None):
        source = {"uid": "msg_" + str(i), "chat_uid": "cht_group", "direction": "inbound",
            "created_at": datetime.datetime.fromtimestamp(self.now, datetime.timezone.utc).isoformat(),
            "sender": {"type": "member", "uid": user or "participant_" + str(i)},
            "body": "/prompt Explain the entry point for participant " + str(i)}
        proof = base64.urlsafe_b64encode(json.dumps(source).encode()).decode().rstrip("=")
        signature = hmac.new(bytes.fromhex(self.key), proof.encode(), hashlib.sha256).hexdigest()
        return self.bridge.ask("cht_group", source["uid"], "coder", proof, signature)

    def complete(self, request, answer):
        return self.bridge.reply(request, answer, self.jobs[request]["key"])

    def test_100_people_have_separate_workers_worktrees_and_correlated_out_of_order_results(self):
        with ThreadPoolExecutor(max_workers=24) as pool:
            receipts = list(pool.map(self.ask, range(100)))
        self.assertEqual(len({r["request"] for r in receipts}), 100)
        self.assertTrue(all(r["status"] == "queued" for r in receipts))
        peak, handled = 0, 0
        while handled < 100:
            batch = []
            for _ in range(8):
                job = self.team.claim()
                if job is None:
                    break
                with patch.object(self.team, "ready", return_value=True):
                    self.team.dispatch(job)
                batch.append(job)
            peak = max(peak, len(batch))
            self.assertEqual(len(batch), 4)
            self.assertIsNone(self.team.claim())
            for job in reversed(batch):
                workspace = self.install / "run/puppeteer-worktrees" / job["id"]
                self.assertEqual((workspace / "answer.txt").read_text(), "dirty source\n")
                self.assertEqual((workspace / "notes.txt").read_text(), "untracked context\n")
                self.assertFalse((workspace / ".env").exists())
                (workspace / "answer.txt").write_text(job["participant"] if "participant" in job else job["id"])
                self.complete(job["id"], "Actual answer for " + job["message"])
            self.now += 3
            self.team.retire_completed()
            handled += len(batch)
        self.assertEqual(peak, 4)
        self.assertEqual(len(self.jobs), 100)
        self.assertEqual(len({j["worker"] for j in self.jobs.values()}), 100)
        self.assertEqual(len([cmd for cmd in self.commands if cmd[1] == "send"]), 100)
        self.assertEqual(len([cmd for cmd in self.commands if cmd[1] == "kill"]), 100)
        self.assertTrue(all(cmd[cmd.index("--boss") + 1] == "sam/main:Boss" for cmd in self.commands if cmd[1] == "spawn"))
        for i, receipt in enumerate(receipts):
            self.assertEqual(self.bridge.result("cht_group", receipt["request"])["reply"], "Actual answer for msg_" + str(i))
        self.assertEqual((self.project / "answer.txt").read_text(), "dirty source\n")

    def test_same_person_waits_while_other_people_can_work(self):
        first, second, other = self.ask(1, "alice"), self.ask(2, "alice"), self.ask(3, "bob")
        claimed = [self.team.claim(), self.team.claim()]
        self.assertEqual([j["id"] for j in claimed], [first["request"], other["request"]])
        self.assertIsNone(self.team.claim())
        self.assertEqual(self.bridge.result("cht_group", second["request"])["status"], "queued")

    def test_followups_continue_only_the_same_participants_completed_work(self):
        first, other = self.ask(1, "alice"), self.ask(2, "bob")
        alice, bob = self.team.claim(), self.team.claim()
        with patch.object(self.team, "ready", return_value=True):
            self.team.dispatch(alice)
            self.team.dispatch(bob)
        alice_work = self.install / "run/puppeteer-worktrees" / first["request"]
        bob_work = self.install / "run/puppeteer-worktrees" / other["request"]
        (alice_work / "answer.txt").write_text("Alice's completed edit\n")
        (alice_work / "alice.txt").write_text("Alice's new file\n")
        (bob_work / "bob.txt").write_text("Bob's new file\n")
        self.complete(first["request"], "Alice's actual completed answer")
        self.complete(other["request"], "Bob's actual completed answer")
        self.now += 3
        self.team.retire_completed()
        followup = self.ask(3, "alice")
        job = self.team.claim()
        with patch.object(self.team, "ready", return_value=True):
            self.team.dispatch(job)
        continued = self.install / "run/puppeteer-worktrees" / followup["request"]
        self.assertEqual((continued / "answer.txt").read_text(), "Alice's completed edit\n")
        self.assertEqual((continued / "alice.txt").read_text(), "Alice's new file\n")
        self.assertFalse((continued / "bob.txt").exists())
        self.assertFalse((continued / ".env").exists())
        self.assertIn("Alice's actual completed answer", self.jobs[job["id"]]["body"])
        self.assertNotIn("Bob's actual completed answer", self.jobs[job["id"]]["body"])
        self.assertNotEqual(self.jobs[job["id"]]["worker"], self.jobs[first["request"]]["worker"])
        self.assertEqual((self.project / "answer.txt").read_text(), "dirty source\n")
        self.assertFalse((self.project / "alice.txt").exists())

    def test_duplicates_queue_only_once_and_restart_does_not_redispatch_claimed_work(self):
        with ThreadPoolExecutor(max_workers=16) as pool:
            receipts = list(pool.map(lambda _: self.ask(1), range(32)))
        self.assertEqual(len({r["request"] for r in receipts}), 1)
        job = self.team.claim()
        with patch.object(self.team, "ready", return_value=True):
            self.team.dispatch(job)
        restored = Team(Bridge(self.bridge.cfg, self.bridge.config_path), self.bridge.config())
        self.assertIsNone(restored.claim())
        self.assertEqual(len(self.jobs), 1)

    def test_queue_capacity_and_expiry_are_explicit(self):
        for i in range(256):
            self.assertEqual(self.ask(i)["status"], "queued")
        self.assertEqual(self.ask(256), {"agent": "coder", "status": "queue_full"})
        self.now += 901
        self.assertIsNone(self.team.claim())
        with self.bridge.ledger() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM requests WHERE status='timed_out'").fetchone()[0], 256)

    def test_owner_must_select_a_real_boss_and_git_project(self):
        for workers in (0, 9, True):
            with self.assertRaisesRegex(BridgeError, "workers"):
                self.pair(workers=workers)
        with self.assertRaisesRegex(BridgeError, "existing_myplow_boss"):
            self.pair(target="sam/demo:coder")
        with self.assertRaises(BridgeError):
            self.pair(project="another/demo:coder")

    def test_revoking_project_or_chat_stops_queued_work_and_hides_old_results(self):
        receipt = self.ask(1)
        job = self.team.claim()
        value = self.bridge.config()
        value["chats"] = ["cht_private"]
        self.bridge.config_path.write_text(json.dumps(value))
        self.team.dispatch(job)
        self.assertEqual(self.commands, [])
        with self.assertRaisesRegex(BridgeError, "chat_not_shared"):
            self.bridge.result("cht_group", receipt["request"])

    def test_dispatch_failure_and_uncertain_delivery_are_retained_without_replay(self):
        receipt = self.ask(1)
        job = self.team.claim()
        with patch.object(self.team, "workspace", side_effect=subprocess.TimeoutExpired("git", 45)):
            self.team.dispatch(job)
        self.assertEqual(self.bridge.result("cht_group", receipt["request"])["status"], "delivery_unknown")
        self.assertIsNone(self.team.claim())
        self.assertEqual(self.ask(1)["request"], receipt["request"])

    def test_owner_stop_cancels_only_this_demo_and_preserves_worktrees(self):
        first, second = self.ask(1), self.ask(2)
        job = self.team.claim()
        with patch.object(self.team, "ready", return_value=True):
            self.team.dispatch(job)
        self.assertEqual(self.bridge.stop(), {"paused": True, "cancelled": 2, "uncertain": 0})
        for receipt in (first, second):
            self.assertEqual(self.bridge.result("cht_group", receipt["request"])["status"], "cancelled")
        self.assertTrue((self.install / "run/puppeteer-worktrees" / job["id"]).is_dir())
        self.assertEqual([cmd[2] for cmd in self.commands if cmd[1] == "kill"], [job["worker"]])
        with self.assertRaisesRegex(BridgeError, "demo_paused"):
            self.ask(3)
        with self.assertRaisesRegex(BridgeError, "request_not_awaiting_reply"):
            self.complete(job["id"], "late answer")

    def test_uncertain_stop_is_reported_and_agent_context_cannot_stop(self):
        receipt = self.ask(1)
        job = self.team.claim()
        with patch.object(self.team, "ready", return_value=True):
            self.team.dispatch(job)
        with patch.dict(os.environ, {"AGENT_ID": "sam/puppeteer:pr-worker"}):
            with self.assertRaisesRegex(BridgeError, "owner_onboarding_required"):
                self.bridge.stop()
        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 1, "", "failed")):
            self.assertEqual(self.bridge.stop(), {"paused": True, "cancelled": 0, "uncertain": 1})
        self.assertEqual(self.bridge.result("cht_group", receipt["request"])["status"], "submitted")

    def test_successful_kill_without_confirmed_pane_removal_remains_uncertain(self):
        receipt = self.ask(1)
        job = self.team.claim()
        with patch.object(self.team, "ready", return_value=True):
            self.team.dispatch(job)
        window = "mc-" + job["worker"].split("/", 1)[1]
        def response(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 0, window + "\n" if argv[0] == "tmux" else "killed", "")
        with patch("subprocess.run", side_effect=response):
            self.assertEqual(self.bridge.stop(), {"paused": True, "cancelled": 0, "uncertain": 1})
        self.assertEqual(self.bridge.result("cht_group", receipt["request"])["status"], "submitted")


class ReadinessTest(unittest.TestCase):
    def test_trust_screen_is_not_a_composer_and_never_receives_a_task(self):
        from types import SimpleNamespace
        team=Team(SimpleNamespace(install=Path('/fixture'), environment=lambda:{}), {'parallel':{}})
        with patch('subprocess.run', return_value=subprocess.CompletedProcess([],0,'Trust this folder?\n› 1. Trust and continue\n  2. Quit','')):
            self.assertFalse(team.ready('sam/puppeteer:pr-fixture'))


if __name__ == "__main__":
    unittest.main()
