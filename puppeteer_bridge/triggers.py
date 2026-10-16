"""Explicit request triggers, shared with the cloud plugin."""

import re

# The only ways a message asks Puppeteer for something. Mirrors plugin/replies.ts
# requestText; tests/fixtures/triggers.json binds both implementations.
SLASH_TRIGGER = re.compile(r"/prompt(?=[ \t\r\n]|\Z)")
NAME_TRIGGER = re.compile(r"(?:@puppeteer(?=[ \t\r\n,:]|\Z)[,:]?|puppeteer[,:]|puppeteer\?\Z)", re.IGNORECASE)


def request_text(body):
    """The request text after an explicit trigger, or None for ordinary chat."""
    if not isinstance(body, str):
        return None
    match = SLASH_TRIGGER.match(body) or NAME_TRIGGER.match(body)
    return body[match.end():].strip() if match else None
