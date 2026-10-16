# Review instructions: puppeteer

## What this repo is

**One agent:** Puppeteer lets members of a Plow group send `/prompt` tasks to
the owner's existing MyPlow coding sessions through Latch. It has two halves:

- the cloud image: `prompt/`, `skills/`, `plugin/`, `boot/`,
  `scripts/customize-base.mjs`, built on a pinned `plow-pbc/plow-openclaw-agent` base;
- the Mac connector `puppeteer_bridge/`, which the owner's Latch installs from a
  pinned commit.

`README.md` owns the product prose. Flag drift between it and the code in
either direction.

**Stage:** pre-PMF, a handful of installs, live demos. Every group is
an audience of people the owner may not know, and every accepted task runs a
real coding agent with the owner's local permissions. Treat the guest boundary
the way you would treat a public API on the owner's machine.

## Blocking checks

- **Guests cannot widen what they reach.**
  - Group turns, including the owner's, get exactly `PLOW_GUEST_TOOLS` (four tools).
  - Setup, status, answer and raw Latch tools are owner-DM only, gated on runtime
    context (`senderIsOwner`, `sessionKey`, the bound source message), never on
    model arguments.
  - Block any change that lets a group turn reach another tool, or lets a tool
    accept a chat, message, path, command or replacement text from the model.
- **Requests are explicit and start-anchored.**
  - A request is one of `/prompt`, "Puppeteer,", "Puppeteer:", "@Puppeteer" or a
    bare "Puppeteer?" at the very start of a human message.
  - One grammar is shared by `plugin/replies.ts` and
    `puppeteer_bridge/triggers.py`, bound by `tests/fixtures/triggers.json`.
  - Block a looser trigger, such as a name anywhere in the text or a trigger
    without punctuation, and any change to one side without the other.
  - In the owner's DM only `/prompt` is a task.
- **Owner review never merges.**
  - `keep` writes one commit on a new `puppeteer/<id>` branch with plumbing.
  - Block hooks, checkout changes, pushes, or a keep that a group turn or a
    coding session (`AGENT_ID`) can trigger.
- **No shell from untrusted text.**
  - Participant text reaches the Mac only as a signed source record. It reaches
    `mp send` only on stdin, inside a random per-dispatch fence.
  - Latch commands use argv arrays with fixed verbs; IDs are pattern-checked on
    both sides.
  - Block string-built commands, `shell=True`, or a fence derived from anything
    a participant can see before sending.
- **Verification happens twice.**
  - The cloud checks the original message, sender membership and age.
  - The Mac re-checks the signature, conversation, sender type, age and the
    `/prompt` prefix.
  - Block a change that drops either side or trusts the other side's word.
- **Uncertain effects are never replayed.**
  - Receipts, group notifications and owner questions are recorded as sending
    before the network call, and become uncertain after a crash.
  - Block automatic retries of an uncertain send or native task.
- **Pins are the supply chain.**
  - `FROM` carries the base tag and the index digest.
  - `PUPPETEER_BRIDGE_COMMIT` is a full commit that every install command shares.
  - Base fixtures match the pinned commit. `tests/pins.test.mjs` enforces this.
  - A connector change without a pin bump does not ship. Say so in the PR.
- **Tests stay hermetic.**
  - Tests must pass inside a MyPlow session (`AGENT_ID`, `MYPEOPLE_*` set) and
    must not read `~/.config` or run `mp`.
  - Block a test that depends on the developer's environment.

## Contrast pairs

| Don't flag | Do flag |
|---|---|
| Behavior specific to relaying coding tasks for one owner. That is the product. | A change a sibling repo owns. Boot, identity and the Plow channel belong to `plow-pbc/plow-openclaw-agent`: `boot/preboot.ts` follows its `main.ts` step for step, and `customize-base.mjs` patches exact anchors. A fix to the base's behavior goes upstream. Mac access goes through Latch's tools, never a re-implementation. |
| English-only group replies. It is a deliberate product choice. | A free-form model reply replacing a verified tool result in a group. |
| Limits that are application limits (four workers, 256 queued, three per participant). | A limit that one guest can exhaust for everyone else. |

**Update cadence:** edit this when the stage changes.
