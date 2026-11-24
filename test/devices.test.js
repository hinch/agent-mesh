const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mesh-devices-"));
const SERIALS = ["emulator-5554", "emulator-5556"];

test("device pool: one lock per serial, release frees it, a foreign token cannot release", async () => {
  const d = await import("../worker/devices.mjs");
  const dir = tmp();
  const a = d.acquireDevice({ dir, serials: SERIALS, owner: { instance: "w-s1", taskId: "T1" } });
  const b = d.acquireDevice({ dir, serials: SERIALS, owner: { instance: "w-s2", taskId: "T2" } });
  assert.strictEqual(a.serial, "emulator-5554");
  assert.strictEqual(b.serial, "emulator-5556");
  assert.strictEqual(d.acquireDevice({ dir, serials: SERIALS, owner: { instance: "w-s3", taskId: "T3" } }), null);

  const owner = d.readOwner(dir, a.serial);
  assert.strictEqual(owner.instance, "w-s1");
  assert.strictEqual(owner.taskId, "T1");
  assert.strictEqual(Number(owner.pid), process.pid);
  assert.strictEqual(owner.host, os.hostname());
  assert.ok(Date.parse(owner.heartbeat));

  assert.strictEqual(d.releaseDevice({ dir, serial: a.serial, token: "not-mine" }), false);
  assert.ok(fs.existsSync(d.lockPath(dir, a.serial)));
  assert.strictEqual(d.releaseDevice({ dir, serial: a.serial, token: a.token }), true);
  assert.ok(!fs.existsSync(d.lockPath(dir, a.serial)));
  assert.strictEqual(d.releaseDevice({ dir, serial: a.serial, token: a.token }), true); // twice is fine
  assert.strictEqual(d.acquireDevice({ dir, serials: SERIALS, owner: { instance: "w-s3", taskId: "T3" } }).serial, "emulator-5554");
  assert.deepStrictEqual(d.listDevices({ dir, serials: SERIALS }).map((x) => x.state), ["held", "held"]);
});

test("device pool: heartbeat keeps a lock, a silent one goes stale and is taken over", async () => {
  const d = await import("../worker/devices.mjs");
  const dir = tmp();
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const a = d.acquireDevice({ dir, serials: ["e1"], owner: { instance: "w-s1", taskId: "T1" }, ctx: { now: t0 } });
  const later = (min) => ({ now: t0 + min * 60_000, pidAlive: () => true });
  assert.strictEqual(d.acquireDevice({ dir, serials: ["e1"], owner: { instance: "x" }, ctx: later(9) }), null);
  assert.strictEqual(d.touchDevice({ dir, serial: "e1", token: a.token, extra: { agentPid: 4242 }, now: t0 + 9 * 60_000 }), true);
  assert.strictEqual(d.readOwner(dir, "e1").agentPid, "4242");
  assert.strictEqual(d.acquireDevice({ dir, serials: ["e1"], owner: { instance: "x" }, ctx: later(18) }), null);
  const b = d.acquireDevice({ dir, serials: ["e1"], owner: { instance: "x", taskId: "T2" }, ctx: later(20) });
  assert.match(b.broke, /heartbeat older than 10 min/);
  assert.strictEqual(d.readOwner(dir, "e1").instance, "x");
  // The old holder can neither refresh nor release the lock it lost.
  assert.strictEqual(d.touchDevice({ dir, serial: "e1", token: a.token }), false);
  assert.strictEqual(d.releaseDevice({ dir, serial: "e1", token: a.token }), false);
  assert.strictEqual(d.readOwner(dir, "e1").instance, "x");
});

test("device pool: stale rules (dead pid, wrong task, released, ttl, other host)", async () => {
  const d = await import("../worker/devices.mjs");
  const now = Date.parse("2026-01-01T00:00:00Z");
  const fresh = new Date(now - 60_000).toISOString();
  const base = { instance: "w-s1", taskId: "T1", pid: "100", host: "h", heartbeat: fresh };
  const ctx = (extra) => ({ now, host: "h", pidAlive: (p) => Number(p) === 100, ...extra });

  assert.strictEqual(d.staleReason(base, ctx()), null);
  assert.strictEqual(d.staleReason(base, ctx({ pidAlive: () => false })), "pid dead");
  // The worker died but the agent it started is still alive: not dead yet.
  assert.strictEqual(d.staleReason({ ...base, agentPid: "200" }, ctx({ pidAlive: (p) => Number(p) === 200 })), null);
  // Another machine's pids mean nothing here; only its heartbeat counts.
  assert.strictEqual(d.staleReason({ ...base, host: "other" }, ctx({ pidAlive: () => false })), null);
  // Held by this worker process for a task it no longer runs (the 2026-11 laptop case).
  assert.strictEqual(d.staleReason(base, ctx({ workerPid: 100, holds: () => false })), "its slot is not running that task");
  assert.strictEqual(d.staleReason(base, ctx({ workerPid: 100, holds: () => true })), null);
  assert.strictEqual(d.staleReason(base, ctx({ workerPid: 999, holds: () => false })), null);
  assert.strictEqual(d.staleReason({ instance: "NONE (released)" }, ctx()), "released");
  assert.strictEqual(d.staleReason({ ...base, heartbeat: new Date(now - 11 * 60_000).toISOString() }, ctx()), "heartbeat older than 10 min");
  assert.strictEqual(d.staleReason({ ...base, ttlMinutes: "60", heartbeat: new Date(now - 11 * 60_000).toISOString() }, ctx()), null);
  // No heartbeat field (lock written by hand): the file time is used.
  assert.strictEqual(d.staleReason({ instance: "manual", mtimeMs: now - 5 * 60_000 }, ctx()), null);
  assert.match(d.staleReason({ instance: "manual", mtimeMs: now - 15 * 60_000 }, ctx()), /heartbeat older/);
  // A lock directory without owner.txt is being created; after the grace time it is abandoned.
  assert.strictEqual(d.staleReason({ missing: true, mtimeMs: now - 5_000 }, ctx()), null);
  assert.strictEqual(d.staleReason({ missing: true, mtimeMs: now - 60_000 }, ctx()), "no owner.txt");
});

test("device pool: a hand-released lock directory (instance=NONE) is taken over", async () => {
  const d = await import("../worker/devices.mjs");
  const dir = tmp();
  fs.mkdirSync(d.lockPath(dir, "e1"), { recursive: true });
  fs.writeFileSync(path.join(d.lockPath(dir, "e1"), "owner.txt"), "instance=NONE (released)\n");
  assert.strictEqual(d.listDevices({ dir, serials: ["e1"] })[0].state, "stale");
  const a = d.acquireDevice({ dir, serials: ["e1"], owner: { instance: "w-s1", taskId: "T1" } });
  assert.strictEqual(a.broke, "released");
  assert.strictEqual(d.readOwner(dir, "e1").taskId, "T1");
});

test("worker helpers: device tasks and the device line in the prompt", async () => {
  const w = await import("../worker/lib.mjs");
  assert.strictEqual(w.needsDevice({ requires: ["android-sdk", "emulator"] }), true);
  assert.strictEqual(w.needsDevice({ requires: ["android-sdk"] }), false);
  assert.strictEqual(w.needsDevice({}), false);
  assert.strictEqual(w.needsDevice({ requires: ["device"] }, ["emulator", "device"]), true);
  const task = { id: "T1", taskId: "WP1", fromBase: "orch" };
  const withDevice = w.buildPrompt("task", { task, instance: "lap-s1", role: "lap", slot: 1, attempt: 1, device: "emulator-5556" });
  assert.match(withDevice, /holds the lock for device "emulator-5556"/);
  assert.doesNotMatch(w.buildPrompt("task", { task, instance: "lap-s1", role: "lap", slot: 1, attempt: 1 }), /DEVICE:/);
});
