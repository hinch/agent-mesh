#!/usr/bin/env node
// Device pool: one lock per device serial, shared by every worker and session on a machine.
//
// A lock is the directory `<lockDir>/<serial>.lock` (mkdir is atomic) holding `owner.txt`
// with key=value lines: serial, instance, taskId, task, pid, agentPid, host, token, since,
// heartbeat, ttlMinutes. The worker daemon takes the lock before a run and releases it when
// the run ends, whatever the reason; the agent it starts never touches the lock.
//
// Any taker may break a lock that is stale: released (`instance=NONE`), heartbeat too old,
// every recorded pid dead (same host), or held by a worker that no longer runs that task.
//
// Also a small CLI for sessions that are not started by the worker:
//   node devices.mjs acquire   --dir <lockDir> --serials a,b --instance <id> [--task <id>] [--pid <n>] [--ttl-minutes <n>]
//   node devices.mjs heartbeat --dir <lockDir> --serial a --token <token>
//   node devices.mjs release   --dir <lockDir> --serial a --token <token>
//   node devices.mjs list      --dir <lockDir> --serials a,b

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const DEFAULT_STALE_MINUTES = 10;
const MAX_TTL_MINUTES = 240;
const NEW_LOCK_GRACE_MS = 30_000; // a lock directory whose owner.txt is not written yet

export const lockPath = (dir, serial) => path.join(dir, `${serial}.lock`);
const ownerPath = (dir, serial) => path.join(lockPath(dir, serial), "owner.txt");

/** key=value lines -> object. Unknown lines are ignored. */
export function parseOwner(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function formatOwner(owner) {
  return (
    Object.entries(owner)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]+/g, " ")}`)
      .join("\n") + "\n"
  );
}

/** null when the serial is not locked; otherwise the owner fields plus `mtimeMs` (and `missing` without owner.txt). */
export function readOwner(dir, serial) {
  let dirStat;
  try {
    dirStat = fs.statSync(lockPath(dir, serial));
  } catch {
    return null;
  }
  try {
    const file = ownerPath(dir, serial);
    return { ...parseOwner(fs.readFileSync(file, "utf8")), mtimeMs: fs.statSync(file).mtimeMs };
  } catch {
    return { missing: true, mtimeMs: dirStat.mtimeMs };
  }
}

export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * Why a lock may be broken, or null while it is validly held.
 * ctx: { now, host, staleMinutes, pidAlive, workerPid, holds(owner) } where `holds` says whether
 * this worker process still runs the task the lock names (only asked for its own locks).
 */
export function staleReason(owner, ctx = {}) {
  const now = ctx.now ?? Date.now();
  if (!owner) return "not locked";
  if (owner.missing) return now - owner.mtimeMs > NEW_LOCK_GRACE_MS ? "no owner.txt" : null;
  if (!owner.instance || /^NONE\b/i.test(owner.instance)) return "released";
  const ttl = Math.min(MAX_TTL_MINUTES, Math.max(1, Number(owner.ttlMinutes) || ctx.staleMinutes || DEFAULT_STALE_MINUTES));
  const beat = Date.parse(owner.heartbeat || "") || owner.mtimeMs || 0;
  if (now - beat > ttl * 60_000) return `heartbeat older than ${ttl} min`;
  if (owner.host && owner.host === (ctx.host ?? os.hostname())) {
    const alive = ctx.pidAlive || pidAlive;
    const pids = [owner.pid, owner.agentPid].filter((p) => Number(p) > 0);
    if (pids.length && !pids.some((p) => alive(p))) return "pid dead";
    if (ctx.workerPid && Number(owner.pid) === ctx.workerPid && ctx.holds && !ctx.holds(owner)) return "its slot is not running that task";
  }
  return null;
}

function writeOwner(dir, serial, owner) {
  const file = ownerPath(dir, serial);
  const tmp = `${file}.${owner.token}.tmp`;
  fs.writeFileSync(tmp, formatOwner(owner));
  fs.renameSync(tmp, file);
}

/**
 * Take the first free (or stale) serial. Returns { serial, token, broke } or null when every
 * device is in use. `broke` is the reason a stale lock was taken over, if one was.
 */
export function acquireDevice({ dir, serials, owner, ctx = {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const now = ctx.now ?? Date.now();
  const stamp = new Date(now).toISOString();
  for (const serial of serials) {
    const token = crypto.randomBytes(8).toString("hex");
    const mine = { serial, host: ctx.host ?? os.hostname(), pid: process.pid, ...owner, token, since: stamp, heartbeat: stamp };
    let broke = null;
    try {
      fs.mkdirSync(lockPath(dir, serial));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      broke = staleReason(readOwner(dir, serial), ctx);
      if (!broke) continue;
    }
    try {
      writeOwner(dir, serial, mine);
    } catch {
      continue; // the lock directory went away under us; try the next serial
    }
    // Two takers may break the same stale lock at once: the last write wins, the other moves on.
    if (readOwner(dir, serial)?.token !== token) continue;
    return { serial, token, broke };
  }
  return null;
}

/** Refresh the heartbeat (and any extra fields). False when the lock is no longer ours. */
export function touchDevice({ dir, serial, token, extra = {}, now = Date.now() }) {
  const cur = readOwner(dir, serial);
  if (!cur || cur.token !== token) return false;
  const { mtimeMs, missing, ...fields } = cur;
  try {
    writeOwner(dir, serial, { ...fields, ...extra, heartbeat: new Date(now).toISOString() });
    return true;
  } catch {
    return false;
  }
}

/** Give the device back. False when someone else holds it by now (their lock is left alone). */
export function releaseDevice({ dir, serial, token }) {
  const cur = readOwner(dir, serial);
  if (!cur) return true;
  if (cur.token !== token) return false;
  try {
    fs.rmSync(lockPath(dir, serial), { recursive: true, force: true });
  } catch {
    // Directory cannot be removed (permissions, open handle): mark it released instead.
    try {
      fs.writeFileSync(ownerPath(dir, serial), "instance=NONE (released)\n");
    } catch {
      return false;
    }
  }
  return true;
}

export function listDevices({ dir, serials, ctx = {} }) {
  return serials.map((serial) => {
    const owner = readOwner(dir, serial);
    if (!owner) return { serial, state: "free" };
    const reason = staleReason(owner, ctx);
    const { mtimeMs, missing, token, ...fields } = owner;
    return reason ? { serial, state: "stale", reason, owner: fields } : { serial, state: "held", owner: fields };
  });
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (name) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined);
  const dir = opt("dir");
  const serials = (opt("serials") || opt("serial") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!dir || !serials.length || !["acquire", "heartbeat", "release", "list"].includes(cmd)) {
    console.error("usage: node devices.mjs acquire|heartbeat|release|list --dir <lockDir> --serials a,b [--instance id] [--task id] [--pid n] [--ttl-minutes n] [--token t]");
    process.exit(2);
  }
  let result;
  if (cmd === "acquire") {
    if (!opt("instance")) {
      console.error("acquire needs --instance");
      process.exit(2);
    }
    // The CLI process exits at once, so its own pid is not recorded; pass --pid for a long-lived holder.
    const owner = { instance: opt("instance"), taskId: opt("task"), pid: opt("pid") || "", ttlMinutes: opt("ttl-minutes") };
    result = acquireDevice({ dir, serials, owner });
  } else if (cmd === "heartbeat") {
    result = { ok: touchDevice({ dir, serial: serials[0], token: opt("token") }) };
  } else if (cmd === "release") {
    result = { ok: releaseDevice({ dir, serial: serials[0], token: opt("token") }) };
  } else {
    result = listDevices({ dir, serials });
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result === null || result.ok === false ? 1 : 0);
}
