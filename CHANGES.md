# Changes on `plow-pattern-upgrade`

Puppeteer goes from a stage-demo relay to a coding teammate for a group chat:

- **Natural requests.** People write "Puppeteer, …"; `/prompt` still works.
- **Value in the first minute.** The owner tries it in their own DM before
  inviting anyone, and long results arrive on their own.
- **A loop the owner can come back to.** "What's waiting?" shows what the group
  changed, and "keep ID" saves one as a branch.
- **Safety and reliability fixes:**
  - a forgeable delimiter;
  - one guest able to fill the queue;
  - a lock race that dropped group replies;
  - tests that failed inside MyPlow;
  - CI that never ran on `main`.
- **No Docker needed for the image's tests.** They now run offline with
  `npm run test:image`, and pass.

Name, Agent Index id (`puppeteer`), 1-click install and run-locally are unchanged.
Existing pairings, ledgers and receipts keep working (see Compatibility).

## First principles: what we kept, what we changed, why

**Evidence** (Agent Index, 2026-10-16):

- **Puppeteer:** 1 user, 4.4M tokens, activity on two days (10-06 and 10-07).
  Deployable, not blessed, empty capabilities, tools and Latch, no stories.
- **Meetly, the bar:** daily use, from one sharp job, a proactive loop and
  owner decisions through runtime-gated tools.
- **MyPlow:** already has a `plow-chat` plugin (the owner texts their Boss over
  iMessage) and a `discord-chat` plugin. So "drive my own agents from my phone"
  is solved upstream.

**The job.** Puppeteer's unique job is multiplayer: *let people I trust a
little — a teammate, a client, a hackathon room — get real work from my coding
agents in the chat we already share, without giving them my Mac.* The audience
demo is one instance of that job. A small team asking for changes every day is
the one with daily demand. The owner's own phone access belongs to MyPlow's
`plow-chat`.

**What that job needs, and what it was missing:**

| Need | Before | Now |
|---|---|---|
| A natural way to ask, for people who aren't developers | `/prompt` only: developer jargon, and awkward on a phone keyboard | "Puppeteer, …", "Puppeteer: …", "@Puppeteer …", "Puppeteer?" (and `/prompt`). Still an explicit, start-anchored, deterministic gate on all three layers; mentions are ignored |
| First value without recruiting someone | Setup asked "Who should I add first?" and nothing worked until a group existed | The workspace is prepared for the owner's DM without questions; "Try it here: /prompt explain this project"; people come second |
| Long tasks finish after the turn | In the DM, the model polled up to 8 times, then said "check again" | The owner's DM `/prompt` uses the fixed router: receipt, then the result pushed |
| A reason for the owner to come back | Guests' edits stayed in worktrees under MyPlow's run directory; the owner got no word that they existed | "What's waiting?" lists who asked, what, and how big; "keep ID" saves a branch with plumbing (no hooks, checkout untouched). This is the owner decision, made through the runtime-gated owner tool, the Meetly pattern |
| A guest boundary that holds against a hostile room | Fixed markers (forgeable); one guest could fill the 256-task queue | Random per-dispatch fence; three waiting tasks per person per group |

**Kept, because it is proven good:**

- the fixed router before any model;
- double verification (HMAC-signed source in the cloud, re-checked on the Mac);
- per-request reply keys stored as hashes;
- uncertain sends never replayed;
- per-person worktrees;
- the owner question relay;
- the setup gate;
- preboot step parity with the base;
- the 100-person rehearsal.

**De-emphasized, not removed:**

- **Single-session mode** (sending everyone's tasks into one existing session)
  is weak for groups: busy refusals and shared state. It stays for existing
  configurations and manual setups, but onboarding never offers it.
- **The demo workspace** stays the default, because a fresh repository with a
  passing test makes the first result reliable and keeps a guest away from real
  code until the owner chooses a project.

**Proposals, argued but not built** (each needs evidence from real use or a
platform change):

1. **A morning digest** ("yesterday your group finished 3 tasks; 2 are waiting
   to keep").
   - This would be the daily return loop.
   - It can't be built safely today. A native automation turn has no bound
     inbound message, so Puppeteer's tools refuse it, and a command job would
     need Latch to run unattended.
   - It needs either a Plow-side scheduled owner turn that tools can trust, or a
     Mac-side digest the connector writes for the owner's first message of the
     day.
2. **Reply-to-continue.** Swipe-replying to a Puppeteer result would continue
   that task without the name. The base now parses `reply_to` (ddbaa6b), but the
   Mac would also have to verify the quoted message. It needs a signed field in
   the source proof.
3. **Discard.** Delete an unwanted worker's worktree from the DM. This is the
   missing cleanup path, scorecard item 9. It is destructive and should come
   with a preview.
4. **A cloud-side per-sender cap,** so a spammy group doesn't cost one Latch
   call per message before the Mac refuses. It needs the sender's Plow UID in
   the group job; today the record holds only the display name.
5. **Upstream a router hook to `plow-openclaw-agent`,** so Puppeteer stops
   patching 23 anchors of the base channel (scorecard item 2).

## Changes by area

- **Triggers** (`plugin/replies.ts`, `puppeteer_bridge/triggers.py`,
  `tests/fixtures/triggers.json`):
  - One grammar on both sides, bound by a 30-case table that both suites read.
  - The real-gateway ingress test routes "Puppeteer, …" and ignores "Puppeteer
    is wild" and "Hey Puppeteer, …".
  - An older connector rejects name tasks; the group is told to use `/prompt`
    or upgrade.
- **Owner DM**:
  - Files: `scripts/customize-base.mjs`, `plugin/groups.ts`, `plugin/plow.ts`.
  - DM `/prompt` goes to the fixed router. Before setup or while paused, it gets
    the next step and never reaches the Mac.
  - "Puppeteer, …" in the DM is conversation.
  - The fabrication guard keys on "a coding tool ran this turn", so the
    owner's name-form tasks still get verified finals.
- **Value-first setup** (`plugin/puppeteer.ts`, `plugin/requests.ts`,
  `plugin/setup.ts`, prompt, skills): `demo` without a group is keyed to the
  owner's DM. Sharing with a group later reuses the same workspace.
- **Review and keep**:
  - New `puppeteer_bridge/review.py`, plus `changes` and `keep` actions on the
    existing owner-only `puppeteer_setup` tool.
  - Each worktree's starting tree is recorded.
  - Keep uses a temporary index, `commit-tree`, and `update-ref` that only
    creates the branch.
  - A dirty start becomes a separate parent commit. `.env` and other ignored
    files are excluded.
  - The cloud parses rows strictly and names who asked from its own records.
  - New `puppeteer-review` skill.
- **Guest boundary** (`puppeteer_bridge/bridge.py`, `team.py`):
  - A random 16-hex fence around participant text and follow-up context.
  - A cap of 3 waiting tasks per participant per group (`participant_queue_full`).
- **Reliability** (`plugin/store.ts`):
  - On macOS a lock symlink mid-creation reads as EINVAL. That killed group
    watchers.
  - It is now retried. The 100-person group test failed 4 of 10 runs on `main`
    and now passes 35 of 35.
- **Tests and CI**:
  - Hermetic Python tests (`tests/hermetic.py`; 45 failed inside MyPlow before).
  - `npm run test:image`, the offline in-image runner.
  - New suites: `tests/pins.test.mjs`, `tests/triggers.test.mjs` and
    `tests/owner-dm.test.mjs` (in-image). `tests/prompt.test.mjs` grows from 5
    to 15 base sentences, plus tool-name and frontmatter checks.
  - CI runs on `main` (it watched a stale branch), uses a Python 3.9/3.12
    matrix, and repeats the suite with MyPlow variables set.
- **Image and docs**:
  - `FROM` pinned by tag and digest, with comments.
  - The README rewritten for the team job.
  - `REVIEW.md`, 18 live scenarios and the listing draft.

**Compatibility:**

- **Old pairings and receipts.** The cloud keeps reading old pairing files and
  receipts.
- **Old ledgers.** They gain the `base_tree` column in place, and review falls
  back to HEAD.
- **New cloud with an old connector.** It works: `/prompt` as before. Name tasks
  get the "upgrade" reply, and `changes`/`keep` report the connector's error.
- **New connector with an old cloud.** It works unchanged.

## Validation

### a. Plow pattern scorecard (PLOW-PATTERN.md §8)

| # | Item | Grade | Evidence |
|---|---|---|---|
| 1 | Base pinned by tag and digest, current; downloads pinned | PASS | `Dockerfile` FROM `base-ddbaa6b…@sha256:5b0ebf5e…` (the newest published OpenClaw base); `tests/pins.test.mjs` "the base is pinned by commit tag and index digest"; connector by commit, SDK by sha512 |
| 2 | Variant adds content only, or a fixture keeps the wrapper in step | PARTIAL | `tests/boot.test.mjs` plus `fixtures/base-main.ts.txt` keep preboot in step. But `scripts/customize-base.mjs` patches 23 anchors of the base channel: the build fails on drift, and `npm run test:image` covers it. Proposal 5 removes the patch |
| 3 | Identity and trust in the image, with reasons | PASS | `Dockerfile` ENV comments; `pins.test.mjs` "keeps guests on the declared tools" |
| 4 | Identity-first prompt, one-line first contact, base contract verbatim | PASS | `tests/prompt.test.mjs`: 15 base sentences checked against `fixtures/base-AGENTS.md` |
| 5 | One skill per turn type, frontmatter tested | PASS | `skills/puppeteer{,-setup,-owner,-recovery,-review}`; `prompt.test.mjs` "skills have valid frontmatter" |
| 6 | Deterministic scripts, atomic locked state, corrupt state throws | PASS | Connector CLI: one JSON line, non-zero on error. `store.test.mjs` "malformed state is never reset"; `withLock` |
| 7 | Untrusted text never on argv | PASS | Text comes only from the signed source and goes to `mp send` on stdin. `plugin.test.mjs` "shell-free argv"; `test_bridge.py` fence test |
| 8 | Owner gates from runtime context; approvals exact | PASS | `ownerMain` (`senderIsOwner`, `sessionKey`) plus Plow re-verification. `setup.test.mjs` "keep only with an exact request ID"; owner answers must quote the current message |
| 9 | No auto-resend; idempotency; bounded retries; cleanup paths | PARTIAL | `groups.test.mjs` "an uncertain phone send is never automatically repeated"; request IDs = hash(chat, message). Worktrees and branches have no cleanup command (proposal 3) |
| 10 | Latch: one install link, never pretend the container is the Mac | PASS | Setup gate gives `https://plow.co/download/latch`; read-only `status` check; prompt "Your own cloud terminal is not that Mac" |
| 11 | Offline hermetic tests and prompt contract, in CI | PASS | `npm test` 90; Python 82 with and without `AGENT_ID`; `tests/hermetic.py` plus `HermeticTest`; CI matrix |
| 12 | `checks/manual-scenarios.md` | PASS | 18 scenarios, including names, DM first run and keep |
| 13 | README in pattern order with limits; `REVIEW.md` | PASS | `README.md`; `REVIEW.md` (8 blocking checks) |
| 14 | No secrets or personal data; English; MIT | PASS | Diff secret scan clean; the prompt test bans phones, emails and chat IDs in prompt and skills; `LICENSE` is MIT |
| 15 | Listing complete and out of WIP | FAIL | The live record has empty capabilities, tools and Latch, 0 stories, and is not blessed. Draft in `docs/agent-index/listing.md` |

**Tally:** 12 PASS, 2 PARTIAL (2, 9), 1 FAIL (15).

**Tests that fail without their change.** Each was checked by reverting the
code or mutating a copy:

| Guard | Fails without the change, shown by |
|---|---|
| Fence | stash `puppeteer_bridge/` → `test_participant_text_cannot_forge_the_end_of_its_block` and `test_previous_context_is_fenced_as_participant_data` fail |
| Per-participant cap | stash → `test_one_participant_cannot_fill_the_shared_queue` fails. Plugin tests fail without the new status: it becomes `delivery_unknown` |
| EINVAL retry | stash `plugin/store.ts` → "a lock path that is briefly not a symlink…" fails (3 pass, 1 fail) |
| Hermetic env | drop the import from one module (with ambient `AGENT_ID`) → 2 failed; no-op helper in a clean env → `HermeticTest` fails |
| Pins | `FROM` without the tag; README pin drift; a guest given `puppeteer_setup` → each makes `pins.test.mjs` fail |
| CI wiring | drop a file from `npm test` → fails. Keep the mount but drop it from `node --test` → fails (this strengthened the test, `5142a25`) |
| Prompt contract | drop a base sentence; name an unregistered tool → `prompt.test.mjs` fails |
| Owner DM router | `owner-dm.test.mjs` on the previous commit → fails; passes after |
| Name triggers | in-image ingress needs `msg_7`/`msg_8` routed → fails with the old `isPrompt` |
| Review, keep, migration | `review` didn't exist before; the migration and CLI tests fail with `bridge.py` stashed |

### b. Agent Index publish requirements (§7, live record of 2026-10-16)

| Requirement | Status | What Enzo must do |
|---|---|---|
| MIT license | PASS: `LICENSE` is MIT | Nothing |
| Usage reporting | PASS: `ENV AGENT_ID=puppeteer` in the image; preboot keeps `startAgentIndex(300_000)` (`boot.test.mjs`); the live record shows 1 user and 4.43M tokens | Keep `AGENT_ID` when re-promoting |
| Blessed (out of WIP) | MISSING: `blessed_at` is empty | After merging and publishing, post the repo URL, commit and id `puppeteer` in the Discord verification thread |
| Video | PASS: YouTube `A6wRp-Ymw9U` | Optional: re-cut to show "Puppeteer," and keep |
| At least one image | PASS: 7 images | Optional: move them from user-attachments into the repo at a commit |
| Deployable | PASS: `deployable_at` 2026-10-06 | After merging, run `plow-agents image push ghcr.io/…/puppeteer-openclaw:vN --promote puppeteer` so 1-click gets this version |
| Exactly 4 capabilities | MISSING: null | `--does` ×4 from `docs/agent-index/listing.md` |
| Tools | MISSING: null | `--tool 'Plow Chat: …'` and `--tool 'Plow Latch: …'` |
| Latch | MISSING: empty | `--latch required` |
| Stories | MISSING: 0 | Fill the 3 drafts from a real session, then `--story ID --title … --body … --tag …` |

### c. Unverified, and how to verify

**What did run here, offline.** All 7 in-image test files run through `npm run
test:image` against the pinned base source and the real OpenClaw 2026.9.6:
discovery, group ingress, the new owner-DM ingress, the 100-person load, the
full-gateway stage rehearsal, identity and preboot. `customize-base.mjs`
applied all 23 anchors to the pinned base. These still need a real
environment:

| Check | Exact steps | Expected |
|---|---|---|
| Docker build plus the CI image job | `docker build -t puppeteer:check .`, then the image job's commands in `.github/workflows/publish.yml` (`docker run … node --test /tmp/*.test.mjs`, `node /tmp/gateway-stage.mjs`, `/opt/plow/probe`) | Build succeeds. All in-image tests pass, including `owner-dm.test.mjs`. The probe prints `PLOW_PROBE_OK` |
| Live line plus connector install on a Mac with MyPlow | `plow-agents mint LINE_UID && docker compose up --build -d`, then text "Set up Puppeteer on my Mac" and approve in Latch | Connector installed at `PUPPETEER_BRIDGE_COMMIT`. Reply: "Your coding workspace is ready. Try it here: /prompt explain this project…" with no other question |
| DM round trip | Text `/prompt explain this project` | A receipt, then the worker's reply arrives without asking |
| Group round trip | "Add NAME", then in the group "Puppeteer, make greet() say good morning" | A receipt with name and `#id`, then the reply. "Puppeteer is great" gets nothing. Then "What's waiting?" and "keep ID" in the DM create `puppeteer/ID`; the project's `git status` and HEAD are unchanged |
| Connector pin bump after push | Push this branch. Set `PUPPETEER_BRIDGE_COMMIT` and the README install line to the merged commit that contains `puppeteer_bridge/` changes; run `npm test` (the pins test keeps them equal); publish; text "Upgrade the Mac connector" | `puppeteer-bridge keep --help` exists on the Mac. Name triggers, fence, cap and review work live. Before the bump, name tasks get the "use /prompt or upgrade" reply |
| CI on GitHub | Open the PR | The bridge job is green on Python 3.9 and 3.12, including the "simulated MyPlow session" step. The image job is green |
| Latch write paths for `keep` in a project outside MyPlow's directory | Share an existing project, finish a task, "keep ID" | Either the branch is created, or Latch refuses and the reply names `PUPPETEER_MAC_WRITE_PATHS` |
| Manual scenarios | `checks/manual-scenarios.md` 1–18 | All boxes |

### d. Test inventory

| Suite | Command | `main` | Branch |
|---|---|---|---|
| Plugin, router, store, prompt, pins, triggers | `npm test` (Node 24.21) | 71 pass; `groups.test.mjs` failed 4/10 runs | 90 pass; `groups.test.mjs` 0/35 runs failed |
| Typecheck | `npm run typecheck` | pass | pass |
| Connector, inside MyPlow (`AGENT_ID` set) | `uv run --python 3.12 --with pytest python -m pytest -q tests` | 45 failed, 34 passed | 82 passed, 99 subtests |
| Connector, clean env | same, with `env -u AGENT_ID -u BOSS_ID -u MYPEOPLE_CONFIG_PATH -u MYPEOPLE_HOME` | 69 passed, 61 subtests | 82 passed, 99 subtests |
| Connector, Python 3.9 with CI's MyPlow env | `AGENT_ID=… MYPEOPLE_*=… python3.9 -m unittest discover -s tests` | not run (69 pass in a clean env) | 82 OK |
| In-image, offline | `npm run test:image` (the branch's runner, replayed on `main` by the same steps) | 9 tests in 6 files pass | 10 tests in 7 files pass |
| Image build and probe | CI image job | not run here | not run here (no Docker) |

## Needs Enzo's decision

1. **Ship the connector.** Name triggers, fence, cap and review live in
   `puppeteer_bridge/`. Macs get them only after `PUPPETEER_BRIDGE_COMMIT` points
   at a pushed commit that contains them and owners upgrade the connector. I left
   the pin at `6375e80`, because a commit from this branch isn't fetchable until
   you push, and a squash merge would change it.
2. **The job.** I positioned Puppeteer as "your group chat gets a coding
   teammate" (team first, demo as one use) and drafted the listing that way. If
   you want the stage demo to stay the headline, only the README lead and the
   listing copy need to change.
3. **English-only replies** are kept. The Plow pattern answers in the sender's
   language; the fixed router messages and the identity test assume English.
4. **The proposals above** (digest, reply-to-continue, discard, cloud-side cap,
   upstream router hook): pick what to build next.
