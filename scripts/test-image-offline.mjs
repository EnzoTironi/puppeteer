#!/usr/bin/env node
// Runs the image's tests without Docker or root: rebuilds /opt/plow and /opt/puppeteer the way
// the Dockerfile does, from the pinned base commit and the pinned OpenClaw package, under a
// temporary root, then runs each in-image test file against the real OpenClaw runtime.
//
//   node scripts/test-image-offline.mjs [test files...]     (default: every in-image test)
//
// It needs network on first use (GitHub codeload for the base, the npm registry for OpenClaw and
// its dependencies) and caches both in .cache/image-offline. Differences from the image: absolute
// image paths in the copied files point into the temporary root, OpenClaw's LAN discovery and
// self-update are off, and the base image's apt and curl layers are not reproduced. CI still
// builds and tests the real image.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(REPO, ".cache/image-offline");
const IN_IMAGE = ["runtime-tools.test.mjs", "group-ingress.test.mjs", "group-load.test.mjs", "owner-dm.test.mjs",
  "gateway-stage.mjs", "identity-gateway.mjs", "preboot.test.mjs"];
const BUILT = ["boot/agent-index", "boot/config", "boot/identity", "boot/log", "boot/prompt", "boot/main", "boot/process",
  "boot/probe", "boot/probe-fixture", "boot/mcp-bridge", "plugin/index", "plugin/transport", "plugin/email"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

const dockerfile = await readFile(join(REPO, "Dockerfile"), "utf8");
const baseCommit = /^FROM \S+:base-([a-f0-9]{40})@sha256:[a-f0-9]{64}$/m.exec(dockerfile)?.[1];
if (!baseCommit) throw new Error("Dockerfile FROM must name base-<commit>@sha256:<digest>");

// The base source at the pinned commit, checked against the reviewed fixtures of that commit.
const base = join(CACHE, "base-" + baseCommit);
if (!existsSync(join(base, "boot/main.ts"))) {
  await mkdir(base, { recursive: true });
  const archive = join(CACHE, baseCommit + ".tar.gz");
  run("curl", ["-fsSL", "--max-time", "120", "-o", archive, `https://codeload.github.com/plow-pbc/plow-openclaw-agent/tar.gz/${baseCommit}`]);
  run("tar", ["-xzf", archive, "-C", base, "--strip-components=1"]);
  await rm(archive);
}
for (const [fixture, source] of [["tests/fixtures/base-main.ts.txt", "boot/main.ts"], ["tests/fixtures/base-AGENTS.md", "prompt/AGENTS.md"]]) {
  if (await readFile(join(REPO, fixture), "utf8") !== await readFile(join(base, source), "utf8")) {
    throw new Error(`Downloaded base ${source} differs from ${fixture}; update the fixture with the base pin`);
  }
}

// The OpenClaw runtime the base image ships, from npm with the same integrity pin as typecheck.
const version = JSON.parse(await readFile(join(base, "package.json"), "utf8")).devDependencies.openclaw;
const integrity = /const integrity='([^']+)'/.exec(await readFile(join(REPO, "scripts/typecheck.mjs"), "utf8"))?.[1];
const openclaw = join(CACHE, "openclaw-" + version);
if (!existsSync(join(openclaw, "node_modules/ws"))) {
  await mkdir(openclaw, { recursive: true });
  const response = await fetch(`https://registry.npmjs.org/openclaw/-/openclaw-${version}.tgz`, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error("Could not fetch the pinned OpenClaw package");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha512").update(bytes).digest("base64") !== integrity) throw new Error("OpenClaw package checksum mismatch");
  const archive = join(CACHE, "openclaw.tgz");
  await writeFile(archive, bytes);
  run("tar", ["-xzf", archive, "-C", openclaw, "--strip-components=1"]);
  await rm(archive);
  run("npm", ["install", "--omit=dev", "--omit=peer", "--omit=optional", "--ignore-scripts", "--legacy-peer-deps",
    "--no-audit", "--no-fund", "--no-package-lock"], { cwd: openclaw });
}

// The image layout, as the base Dockerfile, its build.ts and Puppeteer's Dockerfile produce it.
// A real path: OpenClaw refuses command paths behind a symlinked prefix such as macOS /var/folders.
const root = await realpath(await mkdtemp(join(tmpdir(), "puppeteer-image-")));
const plow = join(root, "opt/plow"), puppeteer = join(root, "opt/puppeteer");
const tmpOpenclaw = ["/tmp/openclaw", `/tmp/openclaw-state-locks-${process.getuid?.() ?? ""}`].filter(path => !existsSync(path));
let failed = 0;
try {
  for (const dir of ["boot", "plugin", "prompt", "skills"]) await cp(join(base, dir), join(plow, dir), { recursive: true });
  await cp(join(base, "package.json"), join(plow, "package.json"));
  for (const name of ["AGENTS.md", "SOUL.md"]) await cp(join(REPO, "prompt", name), join(plow, "prompt", name));
  await cp(join(REPO, "skills"), join(plow, "skills"), { recursive: true });
  await cp(join(REPO, "plugin"), join(plow, "puppeteer-src"), { recursive: true });
  for (const dir of ["boot", "scripts"]) await cp(join(REPO, dir), join(puppeteer, dir), { recursive: true });
  for (const name of BUILT) {
    const source = await readFile(join(plow, name + ".ts"), "utf8");
    const output = join(plow, name.startsWith("plugin/") ? name.replace("plugin/", "plugin/dist/") : name) + ".js";
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, stripTypeScriptTypes(source.replaceAll(/(from "\.\/[^"\n]+)\.ts"/g, '$1.js"')));
  }
  run(process.execPath, ["--no-warnings", join(REPO, "scripts/customize-base.mjs"), plow]);
  for (const dir of [join(plow, "node_modules"), join(puppeteer, "plugin/node_modules"), join(root, "tests"), join(root, "var/lib/plow"), join(root, "etc/plow/openclaw")]) {
    await mkdir(dir, { recursive: true });
  }
  await symlink(openclaw, join(plow, "node_modules/openclaw"));
  await symlink(openclaw, join(puppeteer, "plugin/node_modules/openclaw"));
  for (const dep of ["json5", "ws"]) await symlink(join(openclaw, "node_modules", dep), join(plow, "node_modules", dep));
  const tests = process.argv.slice(2).length ? process.argv.slice(2) : IN_IMAGE;
  for (const name of tests) await cp(join(REPO, "tests", name), join(root, "tests", name));

  // Absolute image paths in the copied files point into the temporary root.
  const moves = [["/opt/plow", plow], ["/opt/puppeteer", puppeteer], ["/var/lib/plow", join(root, "var/lib/plow")],
    ["/etc/plow", join(root, "etc/plow")], ["/app/", openclaw + "/"]];
  async function rewrite(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await rewrite(path); continue; }
      if (!/\.(m?js|ts)$/.test(entry.name)) continue;
      let text = await readFile(path, "utf8"), changed = text;
      for (const [from, to] of moves) changed = changed.replace(new RegExp(`(["'\`])${from.replaceAll("/", "\\/")}`, "g"), `$1${to}`);
      if (changed !== text) await writeFile(path, changed);
    }
  }
  await rewrite(join(root, "opt")); await rewrite(join(root, "tests"));

  // The image's ENV (Dockerfile) and the base image's ENV, without the developer's own.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENT_|BOSS_|MYPEOPLE_|PUPPETEER_|PLOW_|OPENCLAW_)/.test(name)));
  for (const line of dockerfile.replaceAll("\\\n", " ").split("\n").filter(line => line.startsWith("ENV "))) {
    for (const [, name, quoted, bare] of line.slice(4).matchAll(/([A-Z_][A-Z0-9_]*)=(?:"([^"]*)"|(\S*))/g)) env[name] = quoted ?? bare;
  }
  Object.assign(env, { OPENCLAW_STATE_DIR: join(root, "var/lib/plow"), OPENCLAW_CONFIG_PATH: join(root, "var/lib/plow/openclaw.json"),
    OPENCLAW_INCLUDE_ROOTS: join(root, "etc/plow/openclaw"), OPENCLAW_NO_RESPAWN: "1", NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_DISABLE_BONJOUR: "1", OPENCLAW_NO_AUTO_UPDATE: "1", NO_COLOR: "1", FORCE_COLOR: "0" });

  // One process per file: the gateway tests each boot a real gateway on the same port.
  for (const name of tests) {
    await rm(join(root, "var/lib/plow"), { recursive: true, force: true }); await mkdir(join(root, "var/lib/plow"), { recursive: true });
    const result = spawnSync(process.execPath, ["--no-warnings", "--test", "--test-timeout=300000", name], { cwd: join(root, "tests"), env, stdio: "inherit" });
    if (result.status !== 0) { failed++; console.error(`FAILED ${name}`); }
  }
  console.log(failed ? `${failed} of ${tests.length} in-image test files failed` : `all ${tests.length} in-image test files passed`);
} finally {
  await rm(root, { recursive: true, force: true });
  for (const path of tmpOpenclaw) await rm(path, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
