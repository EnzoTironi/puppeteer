import { randomUUID } from "node:crypto";
import { mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { object } from "./latch.ts";

export async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** A live holder never loses its lock because a remote call took too long. */
export async function withLock<T>(path: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lock = path + ".lock", nonce = randomUUID(), deadline = Date.now() + 30_000;
  const owner = JSON.stringify({ pid: process.pid, nonce });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    signal?.throwIfAborted();
    try { await symlink(owner, lock); break; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    // Serialize dead-holder cleanup, then re-read the owner. An old contender
    // must never remove a new holder's lock after another contender recovered it.
    const reaper = lock + ".reap";
    let acquired = false;
    try { await mkdir(reaper, { mode: 0o700 }); acquired = true; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    if (acquired) try {
      let holder: unknown;
      try { holder = JSON.parse(await readlink(lock)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (holder !== undefined) {
        if (!object(holder) || typeof holder.pid !== "number" || !Number.isInteger(holder.pid) || holder.pid <= 0
          || typeof holder.nonce !== "string") throw new Error("invalid_state_lock");
        try { process.kill(holder.pid, 0); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") await rm(lock);
          else throw error;
        }
      }
    } finally { await rm(reaper, { recursive: true, force: true }); }
    if (Date.now() >= deadline) throw new Error("state_lock_busy");
    await pause(20, undefined, { signal });
  }
  try {
    signal?.throwIfAborted();
    return await work();
  } finally {
    if (await readlink(lock) === owner) await rm(lock);
  }
}
