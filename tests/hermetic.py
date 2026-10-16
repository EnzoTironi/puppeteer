"""Run the connector tests without the developer's MyPlow, Plow or Git environment.

Puppeteer's audience runs MyPlow, and a MyPlow coding session exports AGENT_ID,
BOSS_ID and MYPEOPLE_*. The connector deliberately refuses owner-only operations
when AGENT_ID is set, and it resolves MyPlow and pairing files from MYPEOPLE_*,
PUPPETEER_* and HOME. Without isolation, the suite failed inside any MyPlow
session and could resolve the developer's real configuration paths.
"""

import os
import shutil
import tempfile
from unittest import mock

AMBIENT = ("AGENT_", "BOSS_", "MYPEOPLE_", "PUPPETEER_", "PLOW_", "TMUX", "GIT_")
_active = []


def isolate():
    """Start a clean environment with a private temporary HOME."""
    home = tempfile.mkdtemp(prefix="puppeteer-test-home-")
    clean = {name: value for name, value in os.environ.items() if not name.startswith(AMBIENT)}
    clean["HOME"] = home
    patcher = mock.patch.dict(os.environ, clean, clear=True)
    patcher.start()
    _active.append((patcher, home))


def restore():
    patcher, home = _active.pop()
    patcher.stop()
    shutil.rmtree(home, ignore_errors=True)
