"""Real Git workspaces, with the native MyPlow spawn boundary simulated."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from puppeteer_bridge.bridge import Bridge, BridgeError


class OnboardingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.install = self.root / "myplow"
        (self.install / "run").mkdir(parents=True)
        self.roster_path = self.install / "run/roster.json"
        self.roster_path.write_text(json.dumps({"sam/main:Boss": {"is_master": True, "backend": "codex"}}))
        self.cfg = {"INSTALL_DIR": str(self.install), "HOST_ID": "sam", "DEFAULT_BACKEND": "codex"}
        self.bridge = Bridge(self.cfg, self.root / "bridge.json")
        self.run = subprocess.run
        self.commands = []
        self.native = patch("subprocess.run", side_effect=self.spawn)
        self.native.start()
        self.addCleanup(self.native.stop)

    def spawn(self, argv, **kwargs):
        if argv[0] != str(self.install / "bin/mp"):
            return self.run(argv, **kwargs)
        self.commands.append(argv)
        rows = json.loads(self.roster_path.read_text()) if self.roster_path.exists() else {}
        rows[argv[2]] = {"backend": argv[argv.index("--backend") + 1], "is_master": "--master" in argv,
                         "cwd": argv[argv.index("--cwd") + 1],
                         "boss_id": argv[argv.index("--boss") + 1] if "--boss" in argv else ""}
        self.roster_path.write_text(json.dumps(rows))
        return subprocess.CompletedProcess(argv, 0, "spawned", "")

    def path(self, group="cht_demo"):
        key = hashlib.sha256(group.encode()).hexdigest()[:16]
        return self.install / "run/eng/puppeteer-demos" / key

    def test_existing_boss_is_reused_and_fresh_project_has_a_passing_test(self):
        result = self.bridge.demo("cht_demo")
        self.assertTrue(result["demo_prepared"])
        self.assertFalse(result["boss_created"])
        self.assertEqual(result["target"], "sam/main:Boss")
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.commands[0][self.commands[0].index("--boss") + 1], "sam/main:Boss")
        head = self.run(["git", "-C", str(self.path()), "rev-parse", "--verify", "HEAD"], capture_output=True)
        self.assertEqual(head.returncode, 0)
        tested = self.run(["python3", "-B", "test_greeting.py"], cwd=self.path(), capture_output=True)
        self.assertEqual(tested.returncode, 0)
        self.assertFalse(self.bridge.config_path.exists(), "Preparing a group does not yet grant access")

    def test_missing_boss_creates_a_mounted_boss_and_child_for_the_group(self):
        self.roster_path.unlink()
        result = self.bridge.demo("cht_demo")
        self.assertTrue(result["boss_created"])
        self.assertNotEqual(result["target"], "sam/main:Boss")
        self.assertEqual(len(self.commands), 2)
        self.assertIn("--master", self.commands[0])
        self.assertEqual(self.commands[0][self.commands[0].index("--role") + 1], "boss")
        self.assertEqual(self.commands[1][self.commands[1].index("--boss") + 1], result["target"])
        self.assertEqual(self.commands[0][self.commands[0].index("--cwd") + 1], str(self.path()))

    def test_repeat_and_restart_preserve_edits_git_head_and_native_sessions(self):
        first = self.bridge.demo("cht_demo")
        original = self.run(["git", "-C", str(self.path()), "rev-parse", "HEAD"], capture_output=True).stdout
        (self.path() / "greeting.py").write_text("owner changes\n")
        (self.path() / "notes.txt").write_text("keep this\n")
        restarted = Bridge(self.cfg, self.root / "bridge.json")
        self.assertEqual(restarted.demo("cht_demo"), first)
        self.assertEqual(len(self.commands), 1)
        self.assertEqual((self.path() / "greeting.py").read_text(), "owner changes\n")
        self.assertTrue((self.path() / "notes.txt").exists())
        self.assertEqual(self.run(["git", "-C", str(self.path()), "rev-parse", "HEAD"], capture_output=True).stdout, original)

    def test_groups_have_distinct_workspaces_and_native_project_sessions(self):
        first = self.bridge.demo("cht_demo")
        second = self.bridge.demo("cht_second")
        self.assertNotEqual(first["project"], second["project"])
        self.assertNotEqual(self.path(), self.path("cht_second"))
        self.assertEqual(first["target"], second["target"])

    def test_default_boss_is_used_and_alternatives_need_a_readable_selection(self):
        rows = {"sam/main:Boss": {"is_master": True}, "sam/other:Boss": {"is_master": True}}
        self.roster_path.write_text(json.dumps(rows))
        self.assertEqual(self.bridge.demo("cht_demo")["target"], "sam/main:Boss")
        rows.pop("sam/main:Boss")
        rows["sam/third:Boss"] = {"is_master": True}
        self.roster_path.write_text(json.dumps(rows))
        with self.assertRaisesRegex(BridgeError, "choose_one_of_the_existing_bosses"):
            self.bridge.demo("cht_second")
        self.assertFalse(self.path("cht_second").exists())
        self.assertEqual(self.bridge.demo("cht_second", "sam/other:Boss")["target"], "sam/other:Boss")

    def test_guest_native_agents_bad_groups_and_foreign_targets_cannot_prepare_a_demo(self):
        with patch.dict(os.environ, {"AGENT_ID": "sam/main:worker"}):
            with self.assertRaisesRegex(BridgeError, "owner_onboarding_required"):
                self.bridge.demo("cht_demo")
        for group in ["../elsewhere", "not-a-chat", "cht_demo; touch nope"]:
            with self.subTest(group=group), self.assertRaisesRegex(BridgeError, "invalid_group_id"):
                self.bridge.demo(group)
        for target in ["other/main:Boss", "sam/missing:Boss", "sam/main:coder", "sam/main:Boss; touch nope"]:
            with self.subTest(target=target), self.assertRaisesRegex(BridgeError, "select_an_existing_myplow_boss"):
                self.bridge.demo("cht_demo", target)
        self.assertEqual(self.commands, [])

    def test_unowned_existing_folder_and_symlink_are_preserved(self):
        self.path().mkdir(parents=True)
        (self.path() / "keep.txt").write_text("owner file")
        with self.assertRaisesRegex(BridgeError, "demo_workspace_already_exists"):
            self.bridge.demo("cht_demo")
        self.assertEqual((self.path() / "keep.txt").read_text(), "owner file")
        other = self.path("cht_second")
        other.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(BridgeError, "demo_workspace_already_exists"):
            self.bridge.demo("cht_second")
        self.assertEqual(self.commands, [])

    def test_deliberately_retired_sessions_are_not_respawned(self):
        result = self.bridge.demo("cht_demo")
        rows = json.loads(self.roster_path.read_text())
        rows[result["project"]]["retired"] = True
        self.roster_path.write_text(json.dumps(rows))
        with self.assertRaisesRegex(BridgeError, "demo_native_session_unavailable"):
            self.bridge.demo("cht_demo")
        self.assertEqual(len(self.commands), 1)
        self.assertTrue(self.path().is_dir())

    def test_new_nested_workspace_does_not_adopt_or_change_an_installation_git_repo(self):
        self.run(["git", "init", "-q", str(self.root)], check=True, capture_output=True)
        (self.root / "parent.txt").write_text("unrelated project")
        self.run(["git", "-C", str(self.root), "add", "parent.txt"], check=True, capture_output=True)
        self.run(["git", "-C", str(self.root), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Parent"], check=True, capture_output=True)
        original = self.run(["git", "-C", str(self.root), "rev-parse", "HEAD"], capture_output=True).stdout
        self.assertTrue(self.bridge.demo("cht_demo")["demo_prepared"])
        child = self.run(["git", "-C", str(self.path()), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        self.assertEqual(Path(child.stdout.strip()).resolve(), self.path().resolve())
        self.assertEqual(self.run(["git", "-C", str(self.root), "rev-parse", "HEAD"], capture_output=True).stdout, original)

    def test_concurrent_setup_does_not_spawn_an_extra_native_session(self):
        entered, release = threading.Event(), threading.Event()
        def delayed(argv, **kwargs):
            if argv[0] == str(self.install / "bin/mp"):
                entered.set()
                self.assertTrue(release.wait(5))
            return self.spawn(argv, **kwargs)
        with patch("subprocess.run", side_effect=delayed), ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.bridge.demo, "cht_demo")
            self.assertTrue(entered.wait(5))
            try:
                with self.assertRaisesRegex(BridgeError, "demo_setup_in_progress"):
                    Bridge(self.cfg, self.root / "bridge.json").demo("cht_demo")
            finally:
                release.set()
            self.assertTrue(first.result()["demo_prepared"])
        self.assertEqual(len(self.commands), 1)

    def test_failed_spawn_never_claims_preparation_or_sharing(self):
        def failed(argv, **kwargs):
            if argv[0] == str(self.install / "bin/mp"):
                return subprocess.CompletedProcess(argv, 1, "", "native error")
            return self.run(argv, **kwargs)
        with patch("subprocess.run", side_effect=failed), self.assertRaisesRegex(BridgeError, "demo_native_spawn_failed"):
            self.bridge.demo("cht_demo")
        self.assertFalse(self.bridge.config_path.exists())
        self.assertTrue(self.path().is_dir(), "Keep partially prepared work for a safe retry")
        self.assertTrue(self.bridge.demo("cht_demo")["demo_prepared"])


if __name__ == "__main__":
    unittest.main()
