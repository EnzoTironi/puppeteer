import { execFile } from "node:child_process";

export function reconcileRecovery(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["/opt/puppeteer/scripts/register-crons.mjs", "--if-ready"],
      { env: process.env, timeout: 120_000, maxBuffer: 65_536 }, error => error ? reject(new Error("recovery_schedule_unavailable")) : resolve());
  });
}
