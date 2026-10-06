import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from puppeteer_bridge.bridge import Bridge, load_myplow_config, main, myplow_config_path


class StandaloneTest(unittest.TestCase):
    def test_connector_runs_without_importing_myplow(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = main(["agents", "--chat", "cht_demo"], cfg={})
        self.assertEqual(code, 1)
        self.assertIn("local_team_not_configured", json.loads(output.getvalue())["error"])

    def test_native_config_paths_match_myplow(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(myplow_config_path(), Path.home() / ".config/mypeople/queue.env")
        with patch.dict(os.environ, {"MYPEOPLE_HOME": "/tmp/demo-home"}, clear=True):
            self.assertEqual(myplow_config_path(), Path("/tmp/demo-home/config/queue.env"))
        with patch.dict(os.environ, {"MYPEOPLE_CONFIG_PATH": "/tmp/custom.env", "MYPEOPLE_HOME": "/tmp/demo-home"}):
            self.assertEqual(myplow_config_path(), Path("/tmp/custom.env"))

    def test_config_is_parsed_as_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "queue.env"
            path.write_text('''# comment
export INSTALL_DIR="/tmp/demo with spaces"
HOST_ID='sam'
VALUE=$(touch /tmp/never-execute-puppeteer-config)
not a variable
''')
            with patch.dict(os.environ, {"MYPEOPLE_CONFIG_PATH": str(path)}):
                self.assertEqual(load_myplow_config(), {"INSTALL_DIR": "/tmp/demo with spaces", "HOST_ID": "sam",
                                                       "VALUE": "$(touch /tmp/never-execute-puppeteer-config)"})

    def test_custom_team_config_is_remembered_for_latch_and_callback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            local = root / "custom.env"
            local.write_text(f'INSTALL_DIR={root}\nHOST_ID=sam\n')
            bridge_config = root / "bridge.json"
            (root / "run").mkdir()
            (root / "run/roster.json").write_text('{"sam/demo:coder":{"backend":"codex"}}')
            with patch.dict(os.environ, {"PUPPETEER_CONFIG": str(bridge_config), "MYPEOPLE_CONFIG_PATH": str(local)}, clear=True):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(main(["configure", "--agent", "coder=sam/demo:coder", "--chat", "cht_demo"]), 0)
            output = io.StringIO()
            with patch.dict(os.environ, {"PUPPETEER_CONFIG": str(bridge_config)}, clear=True), contextlib.redirect_stdout(output):
                self.assertEqual(main(["agents", "--chat", "cht_demo"]), 0)
            self.assertEqual(json.loads(output.getvalue())["agents"][0]["alias"], "coder")
            self.assertEqual(json.loads(bridge_config.read_text())["myplow_config"], str(local))
