import { object } from "./latch.ts";
import type { Turn } from "./requests.ts";

export type PromptCommand =
  | { kind: "help" }
  | { kind: "agents" }
  | { kind: "status"; request: string; full: boolean }
  | { kind: "invalid_status" }
  | { kind: "owner_question"; question: string }
  | { kind: "invalid_question" }
  | { kind: "task" };

export function promptCommand(prompt: string): PromptCommand {
  const text = prompt.replace(/^\/prompt(?:[ \t\r\n]+|$)/, "").trim();
  if (!text || /^(help|what(?: can you do)?)\??$/i.test(text)) return { kind: "help" };
  if (/^(agents|list (?:the )?shared (?:coding )?agents)[.!?]?$/i.test(text)) return { kind: "agents" };
  const status = /^status\s+#?([a-f0-9]{8}|[a-f0-9]{32})(?:\s+(full))?$/i.exec(text);
  if (status?.[1]) return { kind: "status", request: status[1].toLowerCase(), full: status[2] !== undefined };
  if (/^status(?:\s|$)/i.test(text)) return { kind: "invalid_status" };
  const question = /^ask owner\s+([\s\S]+)$/i.exec(text)?.[1]?.trim();
  if (question && question.length <= 500) return { kind: "owner_question", question };
  if (/^ask owner(?:\s|$)/i.test(text)) return { kind: "invalid_question" };
  return { kind: "task" };
}

export const promptHelp = "I'm Puppeteer, your link to the coding team the owner shared. Start your request with /prompt.\n\n/prompt agents\n/prompt Fix the failing test\n/prompt status REQUEST_ID\n/prompt ask owner Which file should we work on?\n\nOwner questions go privately to the Mac owner. In parallel mode, each task gets its own worker. Extra tasks wait in the queue. I'll stay quiet during regular group chat.";

function errorReply(error: string): string {
  if (["chat_not_shared", "agent_not_shared", "request_not_shared", "owner_main_dm_required"].includes(error)) {
    return error === "request_not_shared"
      ? "I can't find that request in this conversation. Check the ID and use the group where you sent it."
      : "This conversation doesn't have access to a coding workspace. The owner can connect this group from my private setup chat.";
  }
  if (error === "ambiguous_request_id") return "That short ID matches more than one request. Ask the owner for the full request ID.";
  if (error === "demo_paused") return "The owner has paused this demo. I did not accept a new task. The owner can resume it in my private setup chat.";
  if (error === "local_agent_unavailable") return "The shared session is unavailable. The owner needs to open it in MyPlow before we can send a task.";
  if (["latch_denied", "latch_blocked"].includes(error)) return "Latch refused this operation. I stopped and did not try another route.";
  if (error === "prompt_text_required" || error === "control_request_requires_matching_tool") return promptHelp;
  if (error === "source_message_already_routed_to_another_agent") return "This message was already sent to another shared agent. I won't send it twice.";
  if (["original_message_not_found", "source_message_expired_or_invalid", "verified_inbound_member_required"].includes(error)) return "I couldn't verify the original message, so I didn't send a task. Send a new message starting with /prompt.";
  return "I couldn't complete this operation. I haven't confirmed a coding result. The owner should check Latch and MyPlow before trying again.";
}

/** Derive public text from verified tool results, never the model's claimed outcome. */
export function publicReply(result: Record<string, unknown>, turn: Turn): string {
  const name = (turn.sender ?? "").replace(/[\p{C}\r\n]/gu, " ").trim().slice(0, 40);
  const id = typeof result.request === "string" && /^[a-f0-9]{32}$/.test(result.request) ? result.request : undefined;
  const label = id && !Array.isArray(result.agents) ? "#" + id.slice(0, 8) : "";
  const alias = typeof result.agent === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(result.agent) ? result.agent : "coding session";
  const header = [name, label].filter(Boolean).join(" · ");
  const wrap = (text: string): string => header ? header + "\n" + text : text;
  if (typeof result.error === "string" && result.status !== "delivery_unknown" && result.status !== "pending") return wrap(errorReply(result.error));
  if (Array.isArray(result.agents)) {
    const agents = result.agents.filter(object).filter(row => typeof row.alias === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(row.alias));
    if (!agents.length) return wrap("No coding session is shared here yet. The owner can choose one in my private setup chat.");
    return wrap("Shared sessions:\n" + agents.map(row => row.alias + (row.backend === "codex" ? " (Codex)" : row.backend === "claude" ? " (Claude Code)" : "")).join("\n")
      + (result.mode === "parallel" && typeof result.workers === "number" ? "\nParallel mode: up to " + result.workers + " separate workers. Extra tasks are queued." : "\nOne existing session is shared. It handles one task at a time.")
      + "\n\nSend /prompt followed by your task.");
  }
  const resume = id ? "\nCheck again: /prompt status " + id.slice(0, 8) : "";
  switch (result.status) {
    case "cancelled": return wrap("The owner cancelled this request. Any work already done stays available for the owner to review.");
    case "queued": return wrap("Queued for a separate coding worker." + (turn.background ? " I'll post its reply here when it arrives." : "") + resume);
    case "queue_full": return wrap("The task queue is full. I didn't accept this task. Please try a new /prompt after some replies arrive.");
    case "busy": return wrap("An earlier request has this session reserved. I didn't send this task. Wait for its reply, then send your /prompt again.");
    case "awaiting_approval": return wrap("Waiting for the Mac owner to approve this operation in Latch." + resume);
    case "submitted": return wrap(alias + " accepted your task. I'm waiting for its reply." + resume);
    case "dispatching": return wrap("I'm handing this request to " + alias + ". Delivery isn't confirmed yet." + resume);
    case "pending": case "running": return wrap("I'm still waiting for your coding reply." + resume);
    case "delivery_unknown": return wrap("I couldn't confirm delivery. It may already be running, so I won't resend it." + resume);
    case "not_ready": return wrap(alias + " didn't accept this task. The owner should check the session in MyPlow before you try again.");
    case "send_failed": return wrap("Your task couldn't reach a coding worker. The Mac owner needs to check MyPlow and Latch. I haven't confirmed execution, so I won't resend it automatically.");
    case "timed_out": return wrap("This request expired after 15 minutes. I haven't confirmed a result. The owner should check the session before another task is sent.");
    case "replied": {
      if (typeof result.reply !== "string" || !result.reply.trim()) return wrap("The coding session returned an empty reply. I haven't confirmed a result.");
      const command = promptCommand(turn.prompt);
      const full = command.kind === "status" && command.full;
      const text = result.reply.trim();
      const answer = full || text.length <= 1600 ? text : text.slice(0, 1600).replace(/[\uD800-\uDBFF]$/, "").trimEnd() + "\n\nReply excerpt. Full reply: /prompt status " + (id?.slice(0, 8) ?? "REQUEST_ID") + " full";
      return wrap(alias + " replied:\n\n" + answer);
    }
    default: return wrap("I haven't confirmed a coding result yet.");
  }
}
