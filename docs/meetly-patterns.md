# Meetly patterns applied to Puppeteer

Reference: [Meetly at 41666ded](https://github.com/plow-pbc/meetly-openclaw-agent/tree/41666ded67215ab8fb6be5936d7010a6db81eb39).
Meetly is MIT licensed; adapted boot/plugin patterns retain its notice in
`licenses/Meetly-MIT.txt`. Puppeteer remains a shared coding product. The
general patterns below were evaluated against its existing authority model.

| Meetly pattern | Puppeteer implementation |
| --- | --- |
| Immutable public Plow base | Same digest as Meetly, mapped to Plow commit ddbaa6bc; source-anchor changes fail the build. |
| Dedicated startup plugin | `plugin/index.ts`, explicit manifest and seven tools; no Puppeteer registration inside the base plugin. |
| Global extension root on a state volume | `boot/gate.ts` refreshes `/var/lib/plow/extensions/puppeteer` from `/opt/puppeteer/plugin` on every boot. Base-owned plugin paths stay intact. |
| Required plugin fails closed | Missing entry point, wrong manifest or failed copy prevents gateway startup. |
| Custom preboot follows base lifecycle | Retains credential rotation, profile/config rendering, owned includes, gateway boot and five-minute Agent Index reporting; fixtures pin upstream contracts. |
| Preserve operator model preferences | Apply plugin/heartbeat changes to existing JSON5 before base sync. Default model/fallback remain upstream; corrupt JSON5 parks boot. |
| Longer Mac MCP round trips | The relay gets 60 seconds unless upstream already supplies a timeout. |
| Fresh setup gate before owner replies | `before_prompt_build` checks the owner-DM route, a fresh account profile and confirmed receipts; old chat cannot reset or fabricate setup. Tools separately require the authenticated current source message. |
| Use existing profile/config facts | Verified owner display name and inspected Bosses inform onboarding; ask only for unavailable or ambiguous recipient data. |
| Finish setup without losing the request | Default group → Boss → fresh workspace → four-worker share; no native-ID questionnaire. |
| Small workflow skills | Separate coding, setup, private owner questions and recovery instructions. |
| Idle polling costs no model turn | Native OpenClaw command cron, every five minutes, no fallback delivery. Empty ledgers perform no service calls. |
| Reconcile scheduler declarations | Create/edit/enable/remove only `puppeteer-recover`; duplicates are reconciled, malformed/truncated listings fail closed, unrelated jobs remain. |
| Register after setup and gateway readiness | Setup completion and `gateway_start` reconcile the command job. No preboot CLI race against an unavailable gateway. |
| Persist decisions before effects | Requests, group notifications and private questions record unknown/sending before network calls. Uncertain effects are never replayed. |
| Atomic and locked state | Private atomic JSON writes and shared process locks; dead-holder recovery is serialized, live locks are never expired by elapsed time. |
| Corrupt state is not empty state | Schema/JSON failures stop that operation; no automatic permission/history reset. |
| Fresh owner-DM lookup | Re-read `/v1/agents/me`, require one active two-party owner DM served by this line; never route from cached labels. |
| Canonical identity | Exact complete E.164/email matching across Plow seats. National numbers and fuzzy suffixes are rejected rather than guessed. |
| Narrow private owner question | `/prompt ask owner QUESTION` sends only the current authenticated question to the owner; one pending question per group. |
| Quiet private escalation | No room announcement or model turn for the handoff, including failures. Only the owner's answer is relayed to the original still-shared group. |
| Fresh owner answer | Actual owner DM, current message quote, matching question ID and askedAt, 48-hour expiry; never interpret the answer as a coding permission. |
| SDK outbound delivery | Private question/answer uses `sendDurableMessageBatch`; no unrestricted guest message sender. Receipt cron uses a fixed, freshly verified group route with its own durable send ledger. |
| Pause/resume | Read-only live check and explicit resume preserve grants/workspace without re-creating groups or replaying cancelled/uncertain tasks. |
| Prompt contract retention | Applicable base messaging, authority and identity clauses are verbatim and checked against a pinned fixture. |
| Operator-friendly local runtime | Native local architecture including Apple Silicon arm64, loopback-only dashboard, configurable host port and restart policy. |
| Manual and runtime verification | Tests exercise the actual packaged SDK and gateway, plus explicit stage checklist and known-limit evidence. |

## Deliberate domain adaptations

Meetly's calendars, availability arithmetic, attendees, email inbox, recurring
calendar-event ledger, reminders, travel blocks and calendar mutations do not
belong in a coding agent. Its general ledger, recipient-verification and
uncertain-delivery rules apply here; its scheduling tools and OAuth/calendar
configuration do not.

Meetly's base lets an owner approve broader tools in trusted rooms. Puppeteer
keeps every phone group limited to four guest tools, even on owner turns.
Private answers cannot expand that grant. The phone line's old display name
also never overrides Puppeteer's identity: the Alder regression stays fixed.

Existing per-user worktrees and the selected MyPlow Boss remain the concurrency
boundary. This work does not make all audience members edit one shared checkout,
create an inbound Mac port, bypass Latch or claim that a 100-person simulated
gateway proves Apple's physical iMessage group-size support.

## Architecture-specific runtime verification

Both the new candidate and the published v0.1.3 baseline failed fresh-state
startup in this machine's linux/amd64 emulator. The underlying file-lock error
is `openat2 beneath root: Function not implemented`, code ENOSYS. It is not
evidence of a Meetly-specific migration regression.

The adopted Meetly base manifest supplies linux/amd64 and linux/arm64. Test
local Apple Silicon with native linux/arm64 and cloud deployment with native
linux/amd64 CI. Do not disable OpenClaw's secure file locks, set test-only
environments to evade them, or treat an emulated tool-discovery pass as proof
that the full gateway booted.
