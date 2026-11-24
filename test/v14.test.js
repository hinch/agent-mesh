"use strict";
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../functions/lib");

const H = lib.HOUR_MS;

test("lease: clamp, default, expiry; legacy claims never expire", () => {
  assert.strictEqual(lib.clampLeaseMs(undefined), lib.DEFAULT_LEASE_MS);
  assert.strictEqual(lib.clampLeaseMs(-1), lib.DEFAULT_LEASE_MS);
  assert.strictEqual(lib.clampLeaseMs(2), 2 * H);
  assert.strictEqual(lib.clampLeaseMs(0.01), lib.MIN_LEASE_MS);
  assert.strictEqual(lib.clampLeaseMs(10000), lib.MAX_LEASE_MS);
  const now = 1_000_000_000;
  assert.strictEqual(lib.leaseExpired({ status: "claimed", leaseUntilMs: now - 1 }, now), true);
  assert.strictEqual(lib.leaseExpired({ status: "claimed", leaseUntilMs: now + 1 }, now), false);
  assert.strictEqual(lib.leaseExpired({ status: "claimed" }, now), false);
  assert.strictEqual(lib.leaseExpired({ status: "open", leaseUntilMs: 1 }, now), false);
});

test("mayCloseTask: claimer, same role, publisher role; others refused", () => {
  const t = { claimedBy: "laptop-abc123", claimedByBase: "laptop", from: "orch-1", fromBase: "orch" };
  assert.ok(lib.mayCloseTask(t, "laptop-abc123", "laptop"));
  assert.ok(lib.mayCloseTask(t, "laptop-ffffff", "laptop"), "another session of the claiming role");
  assert.ok(lib.mayCloseTask(t, "orch-9", "orch"), "publishing role");
  assert.ok(!lib.mayCloseTask(t, "desk-1", "desk"));
  // legacy claim without claimedByBase: role inferred from the instance prefix
  const legacy = { claimedBy: "laptop-abc123", from: "orch-1", fromBase: "orch" };
  assert.ok(lib.mayCloseTask(legacy, "laptop-9e4169", "laptop"));
  assert.ok(!lib.mayCloseTask(legacy, "lap-1", "lap"));
  assert.ok(lib.mayManageTask(t, "orch"));
  assert.ok(!lib.mayManageTask(t, "laptop"));
});

test("capabilities: normalise and match", () => {
  assert.deepStrictEqual(lib.normList([" Android-SDK ", "gpu", "gpu", 3, "bad space", ""]), ["android-sdk", "gpu"]);
  assert.ok(lib.capabilitiesSatisfy([], []));
  assert.ok(lib.capabilitiesSatisfy(undefined, ["x"]));
  assert.ok(lib.capabilitiesSatisfy(["emulator"], ["android-sdk", "emulator"]));
  assert.ok(!lib.capabilitiesSatisfy(["emulator", "gpu"], ["emulator"]));
});

test("task order: priority then oldest", () => {
  const list = [
    { id: "a", priority: "low", publishedAtMs: 1 },
    { id: "b", priority: "normal", publishedAtMs: 5 },
    { id: "c", priority: "high", publishedAtMs: 9 },
    { id: "d", priority: undefined, publishedAtMs: 2 },
  ].sort(lib.compareTasks);
  assert.deepStrictEqual(list.map((t) => t.id), ["c", "d", "b", "a"]);
  assert.strictEqual(lib.normPriority("urgent"), "normal");
});

test("wait seconds are clamped", () => {
  assert.strictEqual(lib.clampWaitSeconds(undefined), lib.WAIT_DEFAULT_S);
  assert.strictEqual(lib.clampWaitSeconds(500), lib.WAIT_MAX_S);
  assert.strictEqual(lib.clampWaitSeconds(0.2), 1);
  assert.strictEqual(lib.clampWaitSeconds(3), 3);
});

test("mcp helpers: capabilities env and brief task lists", async () => {
  const { parseCapabilities, briefTasks } = await import("../mcp-server/ids.js");
  assert.deepStrictEqual(parseCapabilities("android-sdk, Emulator gpu,,gpu"), ["android-sdk", "emulator", "gpu"]);
  assert.deepStrictEqual(parseCapabilities(undefined), []);
  const out = briefTasks({ tasks: [{ id: "1", taskText: "x".repeat(500), publishedAtMs: 3 }, { id: "2", taskText: "short" }] }, 10);
  assert.match(out.tasks[0].taskText, /^x{10}\.\.\. \[500 chars/);
  assert.strictEqual(out.tasks[0].publishedAtMs, undefined);
  assert.strictEqual(out.tasks[1].taskText, "short");
});

test("worker helpers: slots, args, backoff, picking, secrets, prompts", async () => {
  const w = await import("../worker/lib.mjs");
  assert.strictEqual(w.slotInstance("lap-worker", 2), "lap-worker-s2");
  assert.deepStrictEqual(w.expandArgs(["-p", "{mcpConfig}", "x{nope}"], { mcpConfig: "/tmp/m.json" }), ["-p", "/tmp/m.json", "x{nope}"]);
  assert.strictEqual(w.nextBackoffMs(0), 5000);
  assert.strictEqual(w.nextBackoffMs(5000), 10000);
  assert.strictEqual(w.nextBackoffMs(400000), 300000);
  const picked = w.pickTasks([{ id: "a" }, { id: "b" }, { id: "a" }, { id: "c" }], [1, 3], ["b"]);
  assert.deepStrictEqual(picked.map(([s, t]) => [s, t.id]), [[1, "a"], [3, "c"]]);
  assert.deepStrictEqual(w.pickTasks([{ id: "a" }], [], []), []);
  assert.deepStrictEqual(w.loadSecrets({ MESH_URL: "https://x/", MESH_KEY: "k" }, null), { url: "https://x", key: "k" });
  assert.throws(() => w.loadSecrets({}, null), /required/);
  const p = w.buildPrompt("task", { task: { id: "T1", taskId: "WP1", fromBase: "orch" }, instance: "lap-s1", role: "lap", slot: 1, attempt: 1 });
  assert.match(p, /ALREADY CLAIMED mesh task id "T1"/);
  assert.match(p, /publisher ROLE "orch"/);
  assert.match(w.buildPrompt("inbox", { messages: [], instance: "lap-inbox", role: "lap" }), /Do not call mesh_poll/);
});
