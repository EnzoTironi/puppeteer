# Changes on `plow-pattern-upgrade`

Puppeteer was already close to the Plow pattern: a digest-pinned base, a
boot that follows the base step for step, runtime-gated owner tools, durable
receipts and recorded uncertain sends. This branch fixes what kept it from
being dependable:

- tests that failed inside MyPlow sessions;
- a flaky lock that delayed group replies;
- two guest-boundary gaps;
- a CI trigger that never ran on `main`;
- a README that opened with a footnote.

It also drafts the missing Agent Index listing.

## Guest boundary

- **Fenced participant text.** The coding session used to receive the
  participant's message between fixed markers, so a guest could type
  `--- end participant message ---` and continue with text that looked like
  bridge instructions.
  - Every dispatch now generates a random 16-hex fence, regenerated if it
    appears in the text.
  - The session is told that only lines carrying that fence delimit participant
    data. Follow-up context (previous task and reply) is fenced the same way.
  - Files: `puppeteer_bridge/bridge.py`, `puppeteer_bridge/team.py`.
- **Per-participant queue cap.** One guest could fill the shared 256-task queue
  and lock everyone else out.
  - In parallel mode, a participant now has at most three waiting tasks per
    group. The fourth gets `participant_queue_full` and a plain refusal.
  - The plugin accepts the new status, and older connectors never emit it, so
    either side can be upgraded first.
  - Files: `puppeteer_bridge/team.py`, `plugin/requests.ts`, `plugin/replies.ts`.
- **Reviewed and unchanged** (already correct):
  - tool binding to the current run and source message;
  - the group ingress filter and guest-tool override for owner turns;
  - argv-only Latch commands with fixed verbs;
  - double verification (HMAC-signed source in the cloud, signature, conversation,
    age and prefix on the Mac);
  - private reply keys stored only as hashes;
  - owner answers that must quote the current message.

## Reliability

- **Lock race that dropped group replies.**
  - On macOS, `readlink` can report EINVAL for a lock symlink another contender
    is still creating. `withLock` rethrew it, and the group watcher stopped
    silently, leaving the reply to the five-minute recovery job.
  - The 100-person group test failed 4 of 10 runs on `main`; it now passes
    25 of 25.
  - EINVAL is treated like a missing holder and retried within the existing
    30-second deadline.
  - Files: `plugin/store.ts`, `tests/store.test.mjs`.

## Tests and CI

- **Hermetic connector tests.** Python tests now start from a scrubbed
  environment with a temporary HOME. This covers `AGENT_*`, `BOSS_*`,
  `MYPEOPLE_*`, `PUPPETEER_*`, `PLOW_*`, `TMUX*` and `GIT_*` (`tests/hermetic.py`).
  - Before, 45 tests failed whenever `AGENT_ID` was set, as in every MyPlow
    pane: the connector deliberately refuses owner operations there.
  - That production behavior is correct and unchanged. It stops a coding agent
    from re-pairing or widening its own grants.
- **Prompt contract** (`tests/prompt.test.mjs`):
  - 15 applicable base sentences are checked word for word against the pinned
    base prompt (5 before). This adds the base first-contact rule and the
    judgement bullets to `prompt/AGENTS.md`.
  - Every `puppeteer_*` and `plow_*` name in the prompt and skills must be
    registered.
  - Skill frontmatter is valid, and there are no phone numbers, emails or
    chat/line IDs.
- **Pins** (`tests/pins.test.mjs`):
  - `FROM` must carry both the base tag and the digest.
  - The boot fixture's commit, `THIRD_PARTY.md` and every connector install
    command must agree.
  - Every test file must run either in `npm test` or in the image job.
- **CI** (`.github/workflows/publish.yml`):
  - Runs on pushes to `main` instead of a stale feature branch.
  - Tests the connector on Python 3.9 (the macOS system Python) and 3.12.
  - Repeats the suite with MyPlow variables set.

## Image and docs

- **Dockerfile:** `FROM …:base-ddbaa6b…@sha256:5b0ebf5e…`. This is the same digest
  as before, now with its tag, the bump steps, and the reason for each
  `PLOW_THREAD_TRUST` / `PLOW_GUEST_TOOLS` / `PUPPETEER_BRIDGE_COMMIT` setting.
- **README:** reordered to the Plow pattern:
  1. what it does, with a real exchange;
  2. what it will and won't do;
  3. one-tap install;
  4. group commands and limits;
  5. run locally with `plow-agents mint` and compose;
  6. deploy;
  7. manual connector;
  8. how it works;
  9. known limitations;
  10. development, with base-bump and connector-release steps.

  The old instruction to add `AGENT_ID` to `plow-credentials` is gone, since
  the image already sets it. Personal demo naming is neutral.
- **New `REVIEW.md`:** stage, six blocking checks, contrast pairs.
- **`checks/manual-scenarios.md`:** three new live checks (participant cap,
  forged marker, connector upgrade).
- **New `docs/agent-index/listing.md`:**
  - blurb, exactly four capabilities, tools, `latch: required`, media notes;
  - three Rundown-style story drafts with bracketed details to fill from a real
    session.

## Test results

| Suite | Before (`main`) | After |
|---|---|---|
| `npm test` (Node 24.21) | 71/71, but `groups.test.mjs` failed 4/10 runs | 80/80, `groups.test.mjs` 25/25 runs |
| `npm run typecheck` | pass | pass |
| Python connector, `AGENT_ID` set (MyPlow pane) | 45 failed | 72 passed |
| Python connector, clean env, 3.12 | 69 passed | 72 passed |
| Python connector, 3.9 with CI's MyPlow env | not run | 72 passed |

## Not verified here

- **Image build and in-image tests.** This Mac has no Docker. That covers the
  image build, real OpenClaw tool discovery, group ingress, the 100-person
  gateway rehearsal, identity and preboot. The changed TypeScript files pass
  typecheck and offline tests, and `customize-base.mjs` anchors were not touched.
- **No live Plow line, Latch or iMessage group was used.**
  `checks/manual-scenarios.md` items 1 to 15 are still to run.
- **The edited workflow has not run on GitHub Actions.** Its YAML parses.

## Needs Enzo's decision

1. **Ship the connector hardening.** The fence and the per-participant cap live
   in `puppeteer_bridge/`. Macs get them only when `PUPPETEER_BRIDGE_COMMIT`
   (Dockerfile and README) points at a pushed commit that contains them, and the
   owner asks to "Upgrade the Mac connector". I left the pin at `6375e80`,
   because a commit SHA from this branch isn't fetchable until you push it, and
   a squash merge would change it. After merging, set the pin to the merge
   commit; `tests/pins.test.mjs` keeps every reference equal.
2. **English-only replies.** The Plow pattern answers in the person's language,
   and Puppeteer is English-only on purpose: fixed router messages, plus the
   gateway identity test. Keep it, or localize the owner DM only.
3. **Cloud-side rate limit.** Every group `/prompt` costs one Latch call before
   the Mac applies its limits. If owners' Latch policies ask per command, a
   spammy group means many prompts. A cloud-side per-sender cap would need the
   sender UID in group jobs.
4. **Listing.** Fill in the story drafts from a real session. Consider moving
   the screenshots from user-attachments into the repo, then register.
