// Pure helpers for the worker daemon (unit-tested in test/worker.test.js).
import fs from "node:fs";

/** Per-slot instance id: claims, leases and the spawned agent's MCP all use it. */
export function slotInstance(name, slotNo) {
  return `${name}-s${slotNo}`;
}

/** Replace {placeholders} in argv entries. Unknown placeholders are left as-is. */
export function expandArgs(args, vars) {
  return args.map((a) => String(a).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)));
}

/** Exponential backoff for relay errors: 5 s, 10 s, ... capped at 5 min. */
export function nextBackoffMs(prev) {
  if (!prev) return 5000;
  return Math.min(5 * 60_000, prev * 2);
}

/**
 * Assign claimable tasks (already sorted best-first by the relay) to free slots.
 * Skips declined ids and duplicates. Returns [[slotNo, task], ...].
 */
export function pickTasks(tasks, freeSlots, declined = []) {
  const skip = new Set(declined);
  const out = [];
  const used = new Set();
  let i = 0;
  for (const t of tasks) {
    if (i >= freeSlots.length) break;
    if (!t || !t.id || skip.has(t.id) || used.has(t.id)) continue;
    used.add(t.id);
    out.push([freeSlots[i++], t]);
  }
  return out;
}

/**
 * Mesh URL + key: MESH_URL / MESH_KEY from the environment win; otherwise the
 * "agent-mesh" entry of an MCP config file (Kiro / Claude Code format).
 */
export function loadSecrets(env, mcpConfigPath) {
  let url = (env.MESH_URL || "").trim();
  let key = (env.MESH_KEY || "").trim();
  if ((!url || !key) && mcpConfigPath) {
    const raw = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8").replace(/^\uFEFF/, ""));
    const entry = raw.mcpServers && raw.mcpServers["agent-mesh"];
    if (!entry || !entry.env) throw new Error(`no mcpServers["agent-mesh"].env in ${mcpConfigPath}`);
    url = url || String(entry.env.MESH_URL || "").trim();
    key = key || String(entry.env.MESH_KEY || "").trim();
  }
  if (!url || !key) throw new Error("MESH_URL and MESH_KEY are required (env or meshConfig)");
  return { url: url.replace(/\/+$/, ""), key };
}

/** The prompt (stdin) for a headless run. Instructions files add the project rules. */
export function buildPrompt(kind, ctx) {
  if (kind === "task") {
    const t = ctx.task;
    return [
      `You are a mesh worker: role "${ctx.role}", instance "${ctx.instance}" (slot ${ctx.slot}, attempt ${ctx.attempt}).`,
      `This worker has ALREADY CLAIMED mesh task id "${t.id}" (taskId ${t.taskId}) for you. Do not claim another task.`,
      "Do the task end to end in a working copy of your own (other slots may run in the same repo at the same time: use a separate git worktree per branch).",
      `When done call mesh_task_complete with id "${t.id}" and the commit SHA, then mesh_send a short work-done note to the publisher ROLE "${t.fromBase || t.from}" (never to an instance id).`,
      `If you cannot finish, call mesh_task_fail with id "${t.id}" and a precise reason (or mesh_task_release to give it back).`,
      "Your mesh calls renew the claim lease; the worker also renews it while you run.",
      "",
      "```json",
      JSON.stringify(t, null, 2),
      "```",
    ].join("\n");
  }
  return [
    `You are the inbox handler for mesh role "${ctx.role}" (instance "${ctx.instance}").`,
    "These messages arrived for the role. Action each one per your standing instructions, reply to ROLES (base ids) not instance ids, then exit.",
    "Do not call mesh_poll or mesh_wait: the worker already collected the messages below.",
    "",
    "```json",
    JSON.stringify(ctx.messages, null, 2),
    "```",
  ].join("\n");
}
