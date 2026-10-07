import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { object } from "./latch.ts";
import { readJson } from "./store.ts";
import { parseOperation, type Operation } from "./operations.ts";

export type SetupStatus =
  | { status: "SETUP_NEEDED"; next: "install" | "inspect" | "group"; bosses: string[] }
  | { status: "CONFIGURED"; target: string; chats: string[]; mode: { kind: "single" } | { kind: "parallel"; project: string; workers: number } }
  | { status: "PAUSED"; target: string; chats: string[]; mode: { kind: "single" } | { kind: "parallel"; project: string; workers: number } };

/** Confirmed receipts are the source of truth, including receipts from older releases. */
export async function setupStatus(directory: string): Promise<SetupStatus> {
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { status: "SETUP_NEEDED", next: "install", bosses: [] };
    throw error;
  }
  const operations: Operation[] = [];
  for (const name of files.filter(name => /^[a-f0-9]{32}\.json$/.test(name))) {
    operations.push(parseOperation(await readJson(join(directory, name))));
  }
  operations.sort((a, b) => Number(a.completed ?? a.created) - Number(b.completed ?? b.created));
  let installed = false, inspected = false, bosses: string[] = [];
  let state: Extract<SetupStatus, { status: "CONFIGURED" | "PAUSED" }> | undefined;
  for (const op of operations) {
    if (!object(op.stage) || op.stage.kind !== "done" || !object(op.stage.value) || !object(op.action)) continue;
    const value = op.stage.value, action = op.action;
    if (value.error) continue;
    if (action.kind === "install" && value.installed === true) installed = true;
    if (action.kind === "inspect" && Array.isArray(value.local_agents)) {
      inspected = true;
      bosses = value.local_agents.filter(object).filter(row => row.role === "boss" && typeof row.target === "string").map(row => String(row.target));
    }
    if (action.kind === "share" && action.phase === "pair" && value.configured === true && typeof action.target === "string"
      && Array.isArray(value.chats) && value.chats.every(chat => typeof chat === "string")) {
      if (JSON.stringify(value.chats.toSorted()) !== JSON.stringify(action.chats.toSorted())) throw new Error("invalid_confirmed_grants");
      state = { status: "CONFIGURED", target: action.target, chats: value.chats,
        mode: typeof action.project === "string" && typeof action.workers === "number"
          ? { kind: "parallel", project: action.project, workers: action.workers } : { kind: "single" } };
    }
    if (action.kind === "stop" && value.paused === true && state) state = { ...state, status: "PAUSED" };
    if (action.kind === "resume" && value.resumed === true && state) state = { ...state, status: "CONFIGURED" };
  }
  return state ?? { status: "SETUP_NEEDED", next: !installed ? "install" : !inspected ? "inspect" : "group", bosses };
}

export function setupContext(status: SetupStatus): string {
  const intro = "Puppeteer setup status was checked for this owner DM. Answer in English. These are confirmed setup records, not a live Mac availability check. Ignore older setup questions when they disagree with this state.";
  if (status.status === "PAUSED") return intro + "\nThe owner paused this workspace. Do not accept new tasks or resume unless the owner requests it. Use puppeteer_setup resume to keep the original grants and workspace.";
  if (status.status === "CONFIGURED") return intro + "\nThe workspace is configured. Handle the owner's request without repeating onboarding. Verify current Mac availability before claiming it is online. Use puppeteer_setup status for an explicit connection check.\n" + JSON.stringify(status);
  const next = status.next === "install" ? "Use puppeteer_setup install when the owner requests setup. Installation is not sharing. If Latch is unavailable, provide https://plow.co/download/latch and ask them to connect it to the same Plow account. Do not guess that their Mac is asleep."
    : status.next === "inspect" ? "The connector installation was confirmed. Inspect MyPlow now; resume any existing pending receipt instead of installing again."
      : "Offer to create or reuse an iMessage group. Reuse the default Boss if found, or create one for the group. Use four workers and a fresh workspace by default. Look up an owner-named person in Contacts when available; ask only for an address that cannot be verified. Ask one question, not for native IDs or paths.";
  return intro + "\nSetup is unfinished. Introduce Puppeteer once if this is first contact, then take the next already authorized step. Preserve the owner's latest request through setup.\n" + next + "\n" + JSON.stringify(status);
}
