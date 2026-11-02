"use strict";
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../functions/lib");

const NOW = Date.parse("2025-01-10T00:00:00Z");
const HOUR = 3600 * 1000;

test("id derivation: suffix, explicit instance, suffix off", async () => {
  const { deriveIds } = await import("../mcp-server/ids.js");
  const fixed = () => "abc123";
  assert.deepStrictEqual(deriveIds({ MESH_AGENT_ID: "orch" }, fixed), { base: "orch", instance: "orch-abc123" });
  assert.deepStrictEqual(deriveIds({ MESH_AGENT_ID: "orch", MESH_INSTANCE_ID: "custom-1" }, fixed), {
    base: "orch",
    instance: "custom-1",
  });
  assert.deepStrictEqual(deriveIds({ MESH_AGENT_ID: "orch", MESH_SESSION_SUFFIX: "off" }, fixed), {
    base: "orch",
    instance: "orch",
  });
  assert.strictEqual(deriveIds({}, fixed).base, "agent");
  const a = deriveIds({ MESH_AGENT_ID: "x" });
  assert.match(a.instance, /^x-[0-9a-f]{6}$/);
});

test("agents summary shows base/instance/version/stale with fallback", async () => {
  const { summarizeAgents } = await import("../mcp-server/ids.js");
  const out = summarizeAgents({ agents: [{ agent: "old", mcpVersion: "1.2.0" }, { agent: "o-1", base: "o", instance: "o-1", stale: true }] });
  assert.deepStrictEqual(out.agents[0], { base: "old", instance: "old", version: "1.2.0", stale: false, lastSeen: null });
  assert.strictEqual(out.agents[1].stale, true);
});

test("resolveBase and staleness", () => {
  assert.strictEqual(lib.resolveBase("a-1", undefined), "a-1");
  assert.strictEqual(lib.resolveBase("a-1", "a"), "a");
  assert.strictEqual(lib.isStale(NOW - 25 * HOUR, NOW), true);
  assert.strictEqual(lib.isStale(NOW - 23 * HOUR, NOW), false);
  assert.strictEqual(lib.isStale(null, NOW), false);
});

test("direct messages use the single read flag", () => {
  const m = { to: "orch-1", from: "w-1", read: false };
  assert.ok(lib.shouldDeliver(m, "orch-1", "orch", NOW, NOW));
  assert.ok(!lib.shouldDeliver({ ...m, read: true }, "orch-1", "orch", NOW, NOW));
  assert.ok(!lib.shouldDeliver(m, "orch-2", "orch", NOW, NOW));
});

test("role and broadcast fan-out deliver once to each instance", () => {
  const role = { to: "orch", from: "w-1", readBy: [] };
  assert.ok(lib.shouldDeliver(role, "orch-1", "orch", NOW, NOW));
  assert.ok(lib.shouldDeliver(role, "orch-2", "orch", NOW, NOW));
  const after = { ...role, readBy: ["orch-1"] };
  assert.ok(!lib.shouldDeliver(after, "orch-1", "orch", NOW, NOW));
  assert.ok(lib.shouldDeliver(after, "orch-2", "orch", NOW, NOW));
  // other roles never receive it
  assert.ok(!lib.shouldDeliver(role, "w-2", "w", NOW, NOW));
  // broadcast: everyone except sender, once each
  const bc = { to: "*", from: "w-1" };
  assert.ok(lib.shouldDeliver(bc, "orch-1", "orch", NOW, NOW));
  assert.ok(!lib.shouldDeliver(bc, "w-1", "w", NOW, NOW));
  assert.ok(!lib.shouldDeliver({ ...bc, readBy: ["orch-1"] }, "orch-1", "orch", NOW, NOW));
  // missing readBy on legacy docs counts as undelivered
  assert.ok(lib.shouldDeliver({ to: "*", from: "x" }, "y", "y", NOW, NOW));
  // legacy docs already read (no readBy) must not be re-delivered
  assert.ok(!lib.shouldDeliver({ to: "*", from: "x", read: true }, "y", "y", NOW, NOW));
  assert.ok(!lib.shouldDeliver({ to: "orch", from: "x", read: true }, "orch-1", "orch", NOW, NOW));
  // but readBy present takes precedence over legacy read flag
  assert.ok(lib.shouldDeliver({ to: "orch", from: "x", read: true, readBy: [] }, "orch-1", "orch", NOW, NOW));
});

test("fan-out ignores messages older than the window; isFanOut", () => {
  const old = { to: "orch", from: "w", readBy: [] };
  assert.ok(!lib.shouldDeliver(old, "orch-1", "orch", NOW, NOW - lib.FANOUT_WINDOW_MS - 1));
  assert.ok(lib.shouldDeliver(old, "orch-1", "orch", NOW, NOW - lib.FANOUT_WINDOW_MS + 1000));
  assert.ok(lib.isFanOut("orch", "orch-1"));
  assert.ok(!lib.isFanOut("orch-1", "orch-1"));
  // single-instance (suffix off): base === agent is a direct message
  assert.ok(!lib.isFanOut("orch", "orch"));
});

test("notifyTarget uses fromBase with fallback to from", () => {
  assert.strictEqual(lib.notifyTarget({ from: "orch-1", fromBase: "orch" }), "orch");
  assert.strictEqual(lib.notifyTarget({ from: "legacy-agent" }), "legacy-agent");
});
