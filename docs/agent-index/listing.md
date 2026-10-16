# Agent Index listing: draft

Draft copy for `aiworthusing.com/agent-index/puppeteer`. Nothing here has been
published. Register it with the
[agent-index-client](https://github.com/plow-pbc/agent-index-client) when it
reads right.

The live record (checked 2026-10-16 with `?fresh=1`):

- **Already there:** blurb, video `A6wRp-Ymw9U`, 7 images, `deployable_at` set.
- **Missing:** `blessed_at`, capabilities, tools and `latch` (all empty), and
  stories (0).

## Identity

- **id:** `puppeteer` (unchanged)
- **name:** Puppeteer (unchanged)
- **runtime:** OpenClaw
- **repo:** https://github.com/EnzoTironi/puppeteer
- **latch:** `required`. The connector runs on the owner's Mac, and Puppeteer
  reaches MyPlow only through Latch.
- **blurb:** Your group chat gets a coding teammate. The people you add ask the
  Claude Code and Codex agents already on your Mac; you see what they changed
  and keep it as a branch.

## What it does (exactly four)

| Title | Detail |
|---|---|
| Put your coding agents in a group chat | anyone starts with "Puppeteer,"; your real session answers |
| Give each person their own worker | separate worktrees, four at once by default |
| Review and keep what they changed | who asked, what changed, kept as a branch |
| Keep guests in a narrow lane | four tools, no commands, verified on both sides |

## Registering it

With [agent-index-client](https://github.com/plow-pbc/agent-index-client), from the account that owns the listing. `--does` and `--tool` split on the first colon:

```sh
python3 agent_index_client.py --register --agent puppeteer --latch required \
  --blurb 'Your group chat gets a coding teammate. The people you add ask the Claude Code and Codex agents already on your Mac; you see what they changed and keep it as a branch.' \
  --does 'Put your coding agents in a group chat: anyone starts with "Puppeteer,"; your real session answers' \
  --does 'Give each person their own worker: separate worktrees, four at once by default' \
  --does 'Review and keep what they changed: who asked, what changed, kept as a branch' \
  --does 'Keep guests in a narrow lane: four tools, no commands, verified on both sides' \
  --tool 'Plow Chat: Set it up and review changes in your private chat; your group talks to it in iMessage.' \
  --tool 'Plow Latch: Required: installs the pinned connector and reaches MyPlow on your Mac, with your approval.'
python3 agent_index_client.py --agent puppeteer --story banter-and-name --title '...' --body '...' --tag Team --tag Engineering --tag Multiplayer
```

## Tools

| Name | Description |
|---|---|
| Plow Chat | Set it up and review changes in your private chat; your group talks to it in iMessage. |
| Plow Latch | Required: installs the pinned connector and reaches MyPlow on your Mac, with your approval. |

## Media

- **video:** YouTube id `A6wRp-Ymw9U` (already registered). It shows the
  `/prompt` audience demo; a short re-cut of the "Puppeteer," flow and of
  "What's waiting? / keep" would match the new listing.
- **images:** the seven registered `github.com/user-attachments` screenshots.
  - Prefer copies committed to this repository and linked at an immutable
    commit (`raw.githubusercontent.com/.../<sha>/docs/agent-index/...`).
    Attachment URLs belong to an issue or PR, not to the project.
  - Lead with a real group thread: a "Puppeteer," request, its receipt, and the
    reply with the requester's name.

## Stories (drafts)

These follow the Rundown pattern: first person, one specific moment, real
numbers, and what the agent did *not* do. Every behavior below is implemented
and tested. Bracketed details have to come from a real session before
publishing; do not publish invented times, names or counts.

Tags reuse existing ones from `GET /v1/tags`; at most three per story.

### It ignored the banter and answered the one that said its name

Tags: `Team`, `Engineering`, `Multiplayer`

> I put [N] people from [my team] in a group with Puppeteer. For the first
> minutes it was jokes and "is this thing on". Puppeteer said nothing, and
> nothing ran on my Mac. Then [name] wrote "Puppeteer, make the greeting say
> good morning before noon". [Seconds] later the group saw their name, a request
> ID and "Queued for a separate coding worker". The reply came back from the
> actual Codex session with the test it ran. Nobody installed anything. They
> joined a text thread.

### I kept the change I wanted, and nothing else moved

Tags: `Engineering`, `Review`, `approval`

> After lunch I asked Puppeteer what was waiting. It listed [N] finished tasks:
> who asked, what they asked for, and how big each change was. I said "keep
> [id]". It saved that one as a branch and told me the commit. It didn't merge
> anything or touch my checkout, and the other changes stayed where they were
> until I decided.

### It didn't resend what it couldn't confirm

Tags: `Engineering`, `follow-through`

> My Mac went to sleep in the middle of a session. The next request came back
> with "I couldn't confirm delivery. It may already be running, so I won't
> resend it," plus a status command. When the Mac woke, `status [id]` showed the
> session had finished the task. There was exactly one reply, not two competing
> edits.
