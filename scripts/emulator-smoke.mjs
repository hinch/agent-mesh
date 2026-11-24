// End-to-end smoke test against the Firebase emulators (not part of `npm test`).
//   firebase emulators:exec --only functions,firestore "node scripts/emulator-smoke.mjs"
// Needs functions/.secret.local with MESH_KEY=<any test value> and EMU_KEY set to the same.
import assert from "node:assert";

const project = process.env.GCLOUD_PROJECT;
const region = process.env.MESH_REGION || "us-east1";
const BASE = `http://127.0.0.1:5001/${project}/${region}`;
const KEY = process.env.EMU_KEY;
const H = { "x-mesh-key": KEY, "Content-Type": "application/json" };
const get = async (p) => (await fetch(`${BASE}/${p}`, { headers: H })).json();
const post = async (p, b) => {
  const r = await fetch(`${BASE}/${p}`, { method: "POST", headers: H, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json() };
};
const step = (s) => console.log(`- ${s}`);

// heartbeat with capabilities
await post("agents", { agent: "w-s1", base: "w", meta: { capabilities: ["emulator"] } });
await post("agents", { agent: "x-1", base: "x", meta: {} });

// 1. /wait returns immediately when a message is already waiting
await post("send", { from: "o-1", to: "w", payload: "hello" });
let r = await get("wait?agent=w-s1&base=w&timeout=5");
assert.strictEqual(r.messages.length, 1);
assert.strictEqual(r.messages[0].payload, "hello");
step("wait: immediate delivery");

// 2. /wait blocks, then wakes on a message sent while waiting (push)
const t0 = Date.now();
const pending = get("wait?agent=w-s1&base=w&timeout=20");
await new Promise((res) => setTimeout(res, 2000));
await post("send", { from: "o-1", to: "w", payload: "pushed" });
r = await pending;
const ms = Date.now() - t0;
assert.strictEqual(r.messages.length, 1, JSON.stringify(r));
assert.strictEqual(r.messages[0].payload, "pushed");
assert.ok(ms < 10000, `woke after ${ms} ms`);
step(`wait: woke on push after ${ms} ms`);

// 3. /wait times out empty
r = await get("wait?agent=w-s1&base=w&timeout=2");
assert.deepStrictEqual(r.messages, []);
step("wait: empty timeout");

// 4. history shows consumed messages, peek does not consume
r = await get("history?agent=w-s1&base=w&hours=1");
assert.ok(r.messages.some((m) => m.payload === "pushed" && m.deliveredToYou));
await post("send", { from: "o-1", to: "w-s1", payload: "direct" });
r = await get("poll?agent=w-s1&base=w&peek=1");
assert.strictEqual(r.messages.length, 1);
r = await get("poll?agent=w-s1&base=w");
assert.strictEqual(r.messages.length, 1);
r = await get("poll?agent=w-s1&base=w");
assert.strictEqual(r.messages.length, 0);
step("history + peek");

// 5. publish with requires/assignTo; claim rules
let p = await post("tasks", { action: "publish", from: "o-1", base: "o", repo: "r", taskId: "T-EMU", taskText: "t", requires: ["emulator"], assignTo: "w", priority: "high", leaseHours: 0.1 });
const id = p.json.id;
r = await get("poll?agent=w-s1&base=w");
assert.ok(r.messages.some((m) => m.payload.startsWith(`E:task/assigned id=${id}`)), "assignee role is told");
let c = await post("tasks", { action: "claim", id, agent: "x-1", base: "x" });
assert.strictEqual(c.status, 403, "other role refused");
await post("agents", { agent: "w-s2", base: "w", meta: {} });
c = await post("tasks", { action: "claim", id, agent: "w-s2", base: "w" });
assert.strictEqual(c.status, 412, "missing capability refused");
c = await post("tasks", { action: "claim", id: "next", agent: "w-s1", base: "w" });
assert.strictEqual(c.status, 200, JSON.stringify(c.json));
assert.strictEqual(c.json.id, id);
step("assignTo / requires / claim next");

// 6. another session of the same role may complete; publisher is told
c = await post("tasks", { action: "complete", id, agent: "w-s9", base: "w", commitSha: "abc" });
assert.strictEqual(c.status, 200, JSON.stringify(c.json));
r = await get("poll?agent=o-1&base=o");
assert.ok(r.messages.some((m) => m.payload.startsWith(`T:done/${id}`)));
step("same-role complete + notify");

// 7. /wait tasks=1 wakes on a newly published claimable task
const pend = get("wait?agent=w-s1&base=w&timeout=20&tasks=1");
await new Promise((res) => setTimeout(res, 2000));
p = await post("tasks", { action: "publish", from: "o-1", base: "o", repo: "r", taskId: "T-WAKE", taskText: "t" });
r = await pend;
assert.ok(r.tasks.some((t) => t.id === p.json.id), JSON.stringify(r).slice(0, 300));
step("wait: woke on new task");

// 8. release, cancel, status
c = await post("tasks", { action: "claim", id: p.json.id, agent: "w-s1", base: "w" });
c = await post("tasks", { action: "release", id: p.json.id, agent: "w-s1", base: "w", reason: "test" });
assert.strictEqual(c.json.status, "open");
c = await post("tasks", { action: "cancel", id: p.json.id, agent: "w-s1", base: "w" });
assert.strictEqual(c.status, 403, "only publisher cancels");
c = await post("tasks", { action: "cancel", id: p.json.id, agent: "o-1", base: "o" });
assert.strictEqual(c.json.status, "cancelled");
const st = await get("status?agent=o-1&base=o");
assert.ok(st.roles.w && st.roles.w.capabilities.includes("emulator"));
step("release / cancel / status");

console.log("EMULATOR SMOKE PASS");
