# Agent Index listing: draft

Draft copy for `aiworthusing.com/agent-index/puppeteer`. The live listing
currently has a blurb, a video and seven images, but no capabilities, tools,
Latch setting or stories. Nothing here has been published. Register it with the
[agent-index-client](https://github.com/plow-pbc/agent-index-client) when it
reads right.

## Identity

- **id:** `puppeteer`
- **name:** Puppeteer
- **runtime:** OpenClaw
- **repo:** https://github.com/EnzoTironi/puppeteer
- **latch:** `required`. The connector runs on the owner's Mac, and Puppeteer
  reaches MyPlow only through Latch.
- **blurb:** Let your group text the Claude Code and Codex agents already
  running on your Mac. Every reply comes back with the sender's name and a
  request ID.

## What it does (exactly four)

| Title | Detail |
|---|---|
| Put your coding agents in a group chat | anyone types /prompt; your real session answers |
| Give each person their own worker | separate worktrees, four at once by default |
| Keep guests in a narrow lane | four tools, no commands, verified on both sides |
| Answer guest questions privately | /prompt ask owner reaches only you |

Client form: `--does 'Put your coding agents in a group chat: anyone types /prompt; your real session answers'`, and so on.

## Tools

| Name | Description |
|---|---|
| Plow Chat | Set it up in your private chat. Guests use /prompt in an iMessage group. |
| Plow Latch | Required: installs the pinned connector and reaches MyPlow on your Mac, with your approval. |

## Media

- **video:** YouTube id `A6wRp-Ymw9U` (already registered).
- **images:** the seven registered `github.com/user-attachments` screenshots.
  - Prefer copies committed to this repository and linked at an immutable
    commit (`raw.githubusercontent.com/.../<sha>/docs/agent-index/...`).
    Attachment URLs belong to an issue or PR, not to the project.
  - Lead with a real group thread that shows a `/prompt`, the receipt and the
    reply with the requester's name.

## Stories (drafts)

These follow the Rundown pattern: first person, one specific moment, real
numbers, and what the agent did *not* do. Every behavior below is implemented
and tested. Bracketed details have to come from a real session before
publishing; do not publish invented times, names or counts.

### It ignored the banter and answered the /prompt

Tags: `Team`, `Engineering`, `Multiplayer`

> I put [N] people from [the meetup] in a group with Puppeteer and a fresh demo
> project. For the first minutes it was jokes and "is this thing on". Puppeteer
> said nothing, and nothing ran on my Mac. Then [name] typed `/prompt make the
> greeting say good morning before noon`. [Seconds] later the group saw their
> name, a request ID and "Queued for a separate coding worker". The reply came
> back from the actual Codex session with the test it ran. Nobody installed
> anything. They joined a text thread.

### It didn't resend what it couldn't confirm

Tags: `Engineering`, `follow-through`

> My Mac went to sleep in the middle of a demo. The next `/prompt` came back
> with "I couldn't confirm delivery. It may already be running, so I won't
> resend it," plus a status command. When the Mac woke, `/prompt status [id]`
> showed the session had finished the task, and there was exactly one reply, not
> two competing edits. It reported the uncertainty instead of guessing.

### A guest's question reached only me

Tags: `Team`, `approval`

> In the middle of a session [name] asked `/prompt ask owner can we touch the
> payment code?`. The group saw nothing. The question arrived in my private chat
> with their name on it. I answered "No, keep it to the landing page," and
> Puppeteer posted exactly that to the group, once. My answer didn't give anyone
> new permissions. It was a message, not a grant.
