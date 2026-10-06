"""Exercise the Plow -> local mp -> correlated reply boundary without credentials."""
from concurrent.futures import ThreadPoolExecutor
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import threading
import unittest
import urllib.parse
import urllib.error
from unittest.mock import patch

from puppeteer_bridge.bridge import Bridge, BridgeError


class BridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.messages = []

        class Plow(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.headers.get("Authorization") != "Bearer test-token":
                    self.send_error(401)
                    return
                route = urllib.parse.urlsplit(self.path)
                if route.path != "/v1/chats/cht_shared/messages":
                    self.send_error(404)
                    return
                if cls.http_status != 200:
                    self.send_error(cls.http_status)
                    return
                page = urllib.parse.parse_qs(route.query).get("starting_after", [None])[0]
                value = cls.pages.get(page, {"data": cls.messages, "has_more": False}) if cls.pages else cls.payload
                body = value if isinstance(value, bytes) else json.dumps(value if value is not None else {"data": cls.messages, "has_more": False}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Plow)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        type(self).http_status = 200
        type(self).payload = None
        type(self).pages = {}
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cfg = {"INSTALL_DIR": str(self.root), "HOST_ID": "sam"}
        self.bridge = Bridge(self.cfg, self.root / "config" / "bridge.json")
        (self.root / "run").mkdir()
        (self.root / "run" / "roster.json").write_text(json.dumps({
            "sam/main:coder": {"backend": "codex", "cwd": "/private-project"},
            "sam/main:private": {"backend": "claude", "summary": "secret"}}))
        (self.root / "token").write_text("test-token\n")
        with patch.dict(os.environ, {}, clear=True):
            self.bridge.configure(["coder=sam/main:coder"], ["cht_shared"], self.root / "token",
                                  "http://127.0.0.1:" + str(self.server.server_port))
        self.messages[:] = [{"uid": "msg_original", "chat_uid": "cht_shared", "direction": "inbound",
                             "sender": {"type": "member", "display_name": "Guest"},
                             "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                             "body": "/prompt Explain this project's entry point. `touch /tmp/never` $(echo no)"}]
        self.send = patch("puppeteer_bridge.bridge.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "sent", ""))
        self.dispatch = self.send.start()
        self.addCleanup(self.send.stop)

    def ask(self):
        return self.bridge.ask("cht_shared", "msg_original", "coder")

    def reply_key(self):
        command = next(line for line in self.dispatch.call_args.kwargs["input"].splitlines() if line.startswith("env "))
        args = shlex.split(command)
        return args[args.index("--key") + 1]

    def test_roundtrip_survives_restart_and_replies_only_to_source_chat(self):
        receipt = self.ask()
        self.assertEqual(receipt["status"], "submitted")
        with patch.dict(os.environ, {"AGENT_ID": "sam/main:coder"}):
            self.bridge.reply(receipt["request"], "The entry point is cli.main.", self.reply_key())
        restarted = Bridge(self.cfg, self.bridge.config_path)
        self.assertEqual(restarted.result("cht_shared", receipt["request"])["reply"], "The entry point is cli.main.")
        with self.assertRaisesRegex(BridgeError, "chat_not_shared"):
            restarted.result("cht_other", receipt["request"])
        self.assertEqual((self.bridge.state / "requests.sqlite3").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.bridge.config_path.stat().st_mode & 0o777, 0o600)

    def test_guest_cannot_select_private_agent_or_unshared_chat(self):
        with self.assertRaisesRegex(BridgeError, "chat_not_shared"):
            self.bridge.ask("cht_other", "msg_original", "coder")
        with self.assertRaisesRegex(BridgeError, "agent_not_shared"):
            self.bridge.ask("cht_shared", "msg_original", "private")
        self.dispatch.assert_not_called()
        self.assertEqual(self.bridge.agents("cht_shared")["agents"], [{"alias": "coder", "backend": "codex", "status": "unknown"}])

    def test_only_prompt_at_the_start_can_dispatch(self):
        original = self.messages[0]["body"]
        for body in ["hello", "please /prompt fix it", "/promptfoo fix it", " /prompt fix it",
                     "/PROMPT fix it", "/prompt: fix it", "/prompt\u200b fix it"]:
            with self.subTest(body=body), self.assertRaisesRegex(BridgeError, "prompt_prefix_required"):
                self.messages[0]["body"] = body
                self.ask()
        self.dispatch.assert_not_called()
        self.messages[0]["body"] = original

    def test_empty_prompt_does_not_dispatch(self):
        for body in ["/prompt", "/prompt ", "/prompt\n\t"]:
            with self.subTest(body=body), self.assertRaisesRegex(BridgeError, "prompt_text_required"):
                self.messages[0]["body"] = body
                self.ask()
        self.dispatch.assert_not_called()

    def test_multiline_prompt_removes_only_the_first_prefix(self):
        self.messages[0]["body"] = "/prompt\nFix it.\nKeep this literal: /prompt in an example."
        self.ask()
        self.assertIn("Fix it.\nKeep this literal: /prompt in an example.", self.dispatch.call_args.kwargs["input"])

    def test_prompt_is_verified_at_plow_and_never_a_shell_argument(self):
        receipt = self.ask()
        call = self.dispatch.call_args
        self.assertEqual(call.args[0], [str(self.root / "bin" / "mp"), "send", "sam/main:coder"])
        self.assertIn(self.messages[0]["body"][len("/prompt"):].strip(), call.kwargs["input"])
        self.assertNotIn("/prompt", call.kwargs["input"])
        self.assertNotIn("shell", call.kwargs)
        self.assertIn(receipt["request"], call.kwargs["input"])
        self.assertNotIn("test-token", call.kwargs["input"])
        self.assertNotIn("AGENT_ID", call.kwargs["env"])
        self.assertIn("MYPEOPLE_CONFIG_PATH=", call.kwargs["input"])
        self.assertNotIn(self.reply_key(), json.dumps(receipt))
        with self.bridge.ledger() as db:
            self.assertNotEqual(db.execute("SELECT reply_key_hash FROM requests").fetchone()[0], self.reply_key())

    def test_concurrent_retries_send_once(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            receipts = list(executor.map(lambda _: self.ask(), range(4)))
        self.assertEqual(len({r["request"] for r in receipts}), 1)
        self.assertEqual(self.dispatch.call_count, 1)

    def test_outbound_peer_agent_stale_and_foreign_messages_are_refused(self):
        original = dict(self.messages[0])
        variants = [{"direction": "outbound"}, {"sender": {"type": "agent"}},
                    {"chat_uid": "cht_foreign"}, {"created_at": "2020-01-01T00:00:00Z"},
                    {"created_at": "invalid"}, {"body": ""}, {"sender": []}]
        for change in variants:
            with self.subTest(change=change):
                self.messages[:] = [dict(original, **change)]
                with self.assertRaises(BridgeError):
                    self.ask()
        self.messages[:] = []
        with self.assertRaises(BridgeError):
            self.ask()
        self.dispatch.assert_not_called()

    def test_unready_agent_and_uncertain_delivery_do_not_replay(self):
        self.dispatch.return_value = subprocess.CompletedProcess([], 3, "not_ready", "")
        receipt = self.ask()
        self.assertEqual(receipt["status"], "not_ready")
        self.assertEqual(self.ask(), receipt)
        self.assertEqual(self.dispatch.call_count, 1)
        self.messages[0]["uid"] = "msg_timeout"
        self.dispatch.side_effect = subprocess.TimeoutExpired("mp", 45)
        receipt = self.bridge.ask("cht_shared", "msg_timeout", "coder")
        self.assertEqual(receipt["status"], "delivery_unknown")
        self.assertEqual(self.bridge.ask("cht_shared", "msg_timeout", "coder"), receipt)
        self.assertEqual(self.dispatch.call_count, 2)

    def test_only_request_key_can_reply_and_reply_cannot_change(self):
        receipt = self.ask()
        with patch.dict(os.environ, {"AGENT_ID": "sam/main:coder"}):
            with self.assertRaisesRegex(BridgeError, "invalid_reply_key"):
                self.bridge.reply(receipt["request"], "no", "wrong-key")
        with patch.dict(os.environ, {}, clear=True):
            self.bridge.reply(receipt["request"], "yes", self.reply_key())
            self.bridge.reply(receipt["request"], "yes", self.reply_key())
            with self.assertRaisesRegex(BridgeError, "already_replied"):
                self.bridge.reply(receipt["request"], "different", self.reply_key())

    def test_revoking_chat_or_agent_revokes_existing_requests(self):
        receipt = self.ask()
        config = self.bridge.config()
        config["chats"] = []
        self.bridge.config_path.write_text(json.dumps(config))
        with self.assertRaisesRegex(BridgeError, "chat_not_shared"):
            self.bridge.result("cht_shared", receipt["request"])
        config["chats"] = ["cht_shared"]
        config["agents"] = {}
        self.bridge.config_path.write_text(json.dumps(config))
        with self.assertRaisesRegex(BridgeError, "request_not_shared"):
            self.bridge.result("cht_shared", receipt["request"])
        with patch.dict(os.environ, {"AGENT_ID": "sam/main:coder"}):
            with self.assertRaisesRegex(BridgeError, "agent_not_shared"):
                self.bridge.reply(receipt["request"], "no", self.reply_key())

    def test_changing_alias_target_revokes_old_receipts_and_retries(self):
        receipt = self.ask()
        config = self.bridge.config()
        config["agents"]["coder"] = "sam/main:private"
        self.bridge.config_path.write_text(json.dumps(config))
        with self.assertRaisesRegex(BridgeError, "request_not_shared"):
            self.ask()
        with self.assertRaisesRegex(BridgeError, "request_not_shared"):
            self.bridge.result("cht_shared", receipt["request"])
        self.assertEqual(self.dispatch.call_count, 1)

    def test_reply_key_is_bound_to_its_request_and_expires(self):
        first = self.ask()
        first_key = self.reply_key()
        self.messages[0]["uid"] = "msg_second"
        second = self.bridge.ask("cht_shared", "msg_second", "coder")
        second_key = self.reply_key()
        with self.assertRaisesRegex(BridgeError, "invalid_reply_key"):
            self.bridge.reply(second["request"], "wrong request", first_key)
        self.bridge.reply(first["request"], "first reply", first_key)
        self.bridge.clock = lambda: __import__("time").time() + 901
        with self.assertRaisesRegex(BridgeError, "not_awaiting_reply"):
            self.bridge.reply(second["request"], "late reply", second_key)

    def test_request_times_out_without_inventing_an_answer(self):
        receipt = self.ask()
        self.bridge.clock = lambda: __import__("time").time() + 901
        result = self.bridge.result("cht_shared", receipt["request"])
        self.assertEqual(result["status"], "timed_out")
        self.assertNotIn("reply", result)

    def test_configuration_refuses_remote_agents_and_agent_initiated_grants(self):
        with self.assertRaisesRegex(BridgeError, "only_local"):
            self.bridge.configure(["coder=other/main:coder"], ["cht_shared"], self.root / "token", "https://api.plow.co")
        with patch.dict(os.environ, {"AGENT_ID": "sam/main:coder"}):
            with self.assertRaisesRegex(BridgeError, "owner_terminal"):
                self.bridge.configure(["coder=sam/main:coder"], ["cht_shared"], self.root / "token", "https://api.plow.co")

    def test_plow_data_list_and_legacy_envelopes_are_accepted(self):
        for payload in ({"data": self.messages, "has_more": False}, self.messages, {"messages": self.messages}):
            with self.subTest(payload=type(payload).__name__):
                type(self).payload = payload
                self.assertEqual(self.bridge.source_message(self.bridge.config(), "cht_shared", "msg_original"), self.messages[0]["body"][len("/prompt"):].strip())

    def test_burst_message_is_verified_from_older_page(self):
        type(self).pages = {None: {"data": [{"uid": "msg_newer"}], "has_more": True},
                            "msg_newer": {"data": self.messages, "has_more": False}}
        self.assertEqual(self.ask()["status"], "submitted")
        self.dispatch.assert_called_once()

    def test_malformed_http_and_server_failures_never_dispatch(self):
        for payload in (b"not json", {"data": {}}, None):
            with self.subTest(payload=payload):
                type(self).payload = payload
                type(self).http_status = 503 if payload is None else 200
                with self.assertRaisesRegex(BridgeError, "cannot_verify"):
                    self.ask()
        self.dispatch.assert_not_called()

    def test_network_timeout_is_a_verification_failure(self):
        with patch("puppeteer_bridge.bridge.urllib.request.urlopen", side_effect=TimeoutError()):
            with self.assertRaisesRegex(BridgeError, "cannot_verify"):
                self.ask()
        self.dispatch.assert_not_called()

    def test_login_missing_empty_or_invalid_never_dispatches(self):
        for token in ("", "wrong-token", None):
            with self.subTest(token=token):
                path = self.root / "token"
                if token is None:
                    path.unlink()
                else:
                    path.write_text(token)
                with self.assertRaises(BridgeError):
                    self.ask()
        self.dispatch.assert_not_called()

    def test_local_runtime_missing_or_malformed_never_dispatches(self):
        for roster in ([], {}, None):
            with self.subTest(roster=roster):
                path = self.root / "run/roster.json"
                if roster is None:
                    path.unlink()
                else:
                    path.write_text(json.dumps(roster))
                with self.assertRaisesRegex(BridgeError, "local_(team|agent)_unavailable"):
                    self.ask()
        self.dispatch.assert_not_called()

    def test_send_failure_is_retained_without_replay(self):
        self.dispatch.return_value = subprocess.CompletedProcess([], 1, "", "failed")
        receipt = self.ask()
        self.assertEqual(receipt["status"], "send_failed")
        self.assertEqual(self.ask(), receipt)
        self.dispatch.assert_called_once()
        with self.assertRaisesRegex(BridgeError, "not_awaiting_reply"):
            self.bridge.reply(receipt["request"], "late reply", self.reply_key())

    def test_future_long_and_unknown_sender_messages_are_refused(self):
        original = dict(self.messages[0])
        variants = [{"created_at": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=2)).isoformat()},
                    {"created_at": datetime.datetime.now().isoformat()}, {"body": "x" * 8001},
                    {"sender": {"type": "unknown"}}, {"body": "   "}]
        for change in variants:
            with self.subTest(change=list(change)):
                self.messages[:] = [dict(original, **change)]
                with self.assertRaises(BridgeError):
                    self.ask()
        self.dispatch.assert_not_called()

    def test_same_source_cannot_be_redirected_to_another_shared_agent(self):
        with patch.dict(os.environ, {}, clear=True):
            self.bridge.configure(["coder=sam/main:coder", "other=sam/main:private"], ["cht_shared"], self.root / "token",
                                  "http://127.0.0.1:" + str(self.server.server_port))
        self.ask()
        with self.assertRaisesRegex(BridgeError, "already_routed"):
            self.bridge.ask("cht_shared", "msg_original", "other")
        self.dispatch.assert_called_once()

    def test_concurrent_identical_replies_are_idempotent(self):
        receipt = self.ask()
        key = self.reply_key()
        with ThreadPoolExecutor(max_workers=4) as executor:
            replies = list(executor.map(lambda _: self.bridge.reply(receipt["request"], "answer", key), range(4)))
        self.assertEqual(len({json.dumps(r) for r in replies}), 1)
        self.assertEqual(self.bridge.result("cht_shared", receipt["request"])["reply"], "answer")

    def test_bad_configuration_and_unsafe_endpoint_are_refused(self):
        for endpoint in ("http://example.com", "https://user:pass@example.com", "https://api.plow.co?token=x"):
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(BridgeError, "https"):
                self.bridge.configure(["coder=sam/main:coder"], ["cht_shared"], self.root / "token", endpoint)
        self.bridge.config_path.write_text("not json")
        with self.assertRaisesRegex(BridgeError, "not_configured"):
            self.ask()
        self.dispatch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
