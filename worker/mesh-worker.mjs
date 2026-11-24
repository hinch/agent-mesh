#!/usr/bin/env node
// agent-mesh worker daemon.
//
// Keeps a machine responsive on the mesh without an open chat session:
//  - long-polls the relay (GET /wait) so messages and new tasks arrive within ~1 s;
//  - runs up to `slots` headless agent processes in parallel, one per claimed task
//    (more slots = more parallel requests = more tokens per second from this machine);
//  - batches incoming messages for the role into one "inbox" agent run at a time;
//  - keeps task leases alive while a run is going and gives a task back to the queue
//    (or fails it after `maxAttempts`) when a run ends without closing it.
//
// Usage: node mesh-worker.mjs --config <path/to/worker.json> [--once]
// Config reference: worker/worker.example.json and the "Worker daemon" section of README.md.
// Secrets (MESH_URL, MESH_KEY) come from the environment or from an MCP config file;
// they are written only to a temp MCP config per run, which is deleted when the run ends.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildPrompt, expandArgs, nextBackoffMs, pickTasks, loadSecrets, slotInstance } from "./lib.mjs";

const argv = process.argv.slice(2);
const cfgPath = argv[argv.indexOf("--config") + 1];
if (!argv.includes("--config") || !cfgPath) {
  console.error("usage: node mesh-worker.mjs --config <worker.json> [--once]");
  process.exit(2);
}
const ONCE = argv.includes("--once");
const cfgDir = path.dirname(path.resolve(cfgPath));
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
const rel = (p) => (p ? path.resolve(cfgDir, p.replace(/^~(?=$|[\\/])/, os.homedir())) : p);

const ROLE = cfg.role;
if (!ROLE) throw new Error("config.role is required");
const NAME = cfg.instance || `${ROLE}-worker-${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}`;
const SLOTS = Math.max(0, Math.min(16, Number(cfg.slots ?? 1)));
const CAPS = Array.isArray(cfg.capabilities) ? cfg.capabilities : [];
const STATE_DIR = rel(cfg.stateDir || path.join(os.homedir(), ".agent-mesh", "worker", NAME));
const RUNS = path.join(STATE_DIR, "runs");
const STATUS = path.join(STATE_DIR, "status.json");
const STATE = path.join(STATE_DIR, "state.json");
const PAUSE = path.join(STATE_DIR, "PAUSE");
const MAX_ATTEMPTS = Math.max(1, Number(cfg.maxAttempts ?? 2));
const RUN_TIMEOUT_MS = Math.max(5, Number(cfg.runTimeoutMinutes ?? 90)) * 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const INBOX_ENABLED = cfg.inbox?.enabled !== false;
fs.mkdirSync(RUNS, { recursive: true });

const secrets = loadSecrets(process.env, cfg.meshConfig ? rel(cfg.meshConfig) : null);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { attempts: {}, declined: [], pendingMessages: [] };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const slots = new Map(); // slotNo -> { taskId, pid, since, log }
let inboxRun = null;
const passedOver = new Map(); // task id -> skip until (ms)
let stopping = false;
let backoff = 0;

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function relay(endpoint, method = "GET", body, timeoutMs = 30_000) {
  const res = await fetch(`${secrets.url}/${endpoint}`, {
    method,
    headers: { "x-mesh-key": secrets.key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`relay ${endpoint}: HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  return { status: res.status, json };
}

const heartbeat = (instance, busy) =>
  relay("agents", "POST", {
    agent: instance,
    base: ROLE,
    meta: { host: os.hostname(), capabilities: CAPS, slots: instance === NAME ? SLOTS : 1, busy, worker: true, mcpVersion: "worker" },
  }).catch((e) => log("heartbeat failed", e.message));

function writeMcpConfig(instance, stamp) {
  const file = path.join(os.tmpdir(), `mesh-worker-${stamp}-${process.pid}.json`);
  const mcp = cfg.agent?.mcpServer || { command: "node", args: [rel(cfg.mcpServerPath || path.join(cfgDir, "..", "mcp-server", "index.js"))] };
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        "agent-mesh": {
          command: mcp.command,
          args: mcp.args,
          env: {
            MESH_URL: secrets.url,
            MESH_KEY: secrets.key,
            MESH_AGENT_ID: ROLE,
            MESH_INSTANCE_ID: instance,
            MESH_CAPABILITIES: CAPS.join(","),
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  return file;
}

function runAgent({ kind, instance, prompt, instructions, cwd, onExit }) {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}`;
  const logFile = path.join(RUNS, `${stamp}.log`);
  const mcpFile = writeMcpConfig(instance, stamp);
  const args = expandArgs(cfg.agent?.args || ["-p", "--mcp-config", "{mcpConfig}", "--strict-mcp-config", "--append-system-prompt-file", "{instructions}"], {
    mcpConfig: mcpFile,
    instructions: instructions ? rel(instructions) : "",
  });
  const out = fs.openSync(logFile, "a");
  fs.writeSync(out, `# ${kind} run ${stamp} as ${instance}\n`);
  const child = spawn(cfg.agent?.command || "claude", args, {
    cwd: rel(cwd || cfg.cwd || process.cwd()),
    stdio: ["pipe", out, out],
    windowsHide: true,
    env: { ...process.env, MESH_INSTANCE_ID: instance, MESH_ROLE: ROLE },
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  const timer = setTimeout(() => {
    fs.writeSync(out, "\n# timeout, killing\n");
    child.kill();
  }, RUN_TIMEOUT_MS);
  child.on("error", (e) => {
    fs.writeSync(out, `\n# spawn error ${e.message}\n`);
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    try {
      fs.writeSync(out, `\n# exit ${code}\n`);
      fs.closeSync(out);
    } catch {}
    try {
      fs.unlinkSync(mcpFile);
    } catch {}
    onExit(code, logFile);
  });
  return { pid: child.pid, since: stamp, log: logFile };
}

async function taskStatus(id) {
  const { json } = await relay("tasks", "POST", { action: "list", status: "claimed" });
  const t = (json.tasks || []).find((x) => x.id === id);
  return t ? "claimed" : "closed";
}

async function startTask(slotNo, task) {
  const instance = slotInstance(NAME, slotNo);
  await heartbeat(instance, 1);
  const claim = await relay("tasks", "POST", { action: "claim", id: task.id, agent: instance, base: ROLE });
  if (claim.status !== 200) {
    log(`claim ${task.id} (${task.taskId}) refused: ${claim.status} ${claim.json.msg || ""}`);
    if (claim.status === 412 || claim.status === 403) state.declined.push(task.id);
    save();
    return false;
  }
  log(`slot ${slotNo}: claimed ${task.id} (${task.taskId})`);
  const prompt = buildPrompt("task", { task, instance, role: ROLE, slot: slotNo, attempt: (state.attempts[task.id] || 0) + 1 });
  const run = runAgent({
    kind: `task-s${slotNo}`,
    instance,
    prompt,
    instructions: cfg.task?.instructionsFile,
    cwd: cfg.task?.cwd,
    onExit: async (code, logFile) => {
      slots.delete(slotNo);
      state.attempts[task.id] = (state.attempts[task.id] || 0) + 1;
      save();
      try {
        if ((await taskStatus(task.id)) === "claimed") {
          const out = state.attempts[task.id] >= MAX_ATTEMPTS ? "fail" : "release";
          await relay("tasks", "POST", {
            action: out,
            id: task.id,
            agent: instance,
            base: ROLE,
            reason: `worker run ended (exit ${code}) without closing the task; attempt ${state.attempts[task.id]}/${MAX_ATTEMPTS}; log ${path.basename(logFile)} on ${os.hostname()}`,
          });
          if (out === "release") state.declined.push(task.id); // let another machine try first
          log(`slot ${slotNo}: ${task.id} still claimed after exit ${code} -> ${out}`);
        } else {
          log(`slot ${slotNo}: ${task.id} closed (exit ${code})`);
        }
      } catch (e) {
        log(`slot ${slotNo}: post-run check failed: ${e.message}`);
      }
      save();
      heartbeat(instance, 0);
      kick();
    },
  });
  slots.set(slotNo, { taskId: task.id, task: task.taskId, ...run });
  return true;
}

function startInbox() {
  if (!INBOX_ENABLED || inboxRun || !state.pendingMessages.length) return;
  const items = state.pendingMessages.splice(0);
  save();
  const instance = `${NAME}-inbox`;
  inboxRun = runAgent({
    kind: "inbox",
    instance,
    prompt: buildPrompt("inbox", { messages: items, instance, role: ROLE }),
    instructions: cfg.inbox?.instructionsFile || cfg.task?.instructionsFile,
    cwd: cfg.inbox?.cwd || cfg.task?.cwd,
    onExit: (code) => {
      inboxRun = null;
      if (code !== 0) {
        state.pendingMessages.unshift(...items);
        state.inboxRetryAfter = Date.now() + 10 * 60_000;
      }
      save();
      kick();
    },
  });
}

function freeSlots() {
  const out = [];
  for (let i = 1; i <= SLOTS; i++) if (!slots.has(i)) out.push(i);
  return out;
}

function writeStatus(extra) {
  fs.writeFileSync(
    STATUS,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        instance: NAME,
        role: ROLE,
        capabilities: CAPS,
        slots: SLOTS,
        running: [...slots.entries()].map(([n, s]) => ({ slot: n, ...s })),
        inbox: inboxRun,
        queuedMessages: state.pendingMessages.length,
        paused: fs.existsSync(PAUSE),
        ...extra,
      },
      null,
      2,
    ),
  );
}

let wake = null;
function kick() {
  if (wake) wake();
}

async function cycle() {
  const paused = fs.existsSync(PAUSE);
  const free = paused ? [] : freeSlots();
  const wantTasks = free.length > 0;
  const now = Date.now();
  for (const [id, until] of passedOver) if (until < now) passedOver.delete(id);
  const skipIds = [...new Set([...state.declined.slice(-40), ...passedOver.keys()])].slice(-50);
  const { json } = await relay(
    `wait?agent=${encodeURIComponent(NAME)}&base=${encodeURIComponent(ROLE)}&timeout=50${wantTasks ? "&tasks=1" : ""}` +
      (skipIds.length ? `&skip=${encodeURIComponent(skipIds.join(","))}` : ""),
    "GET",
    undefined,
    80_000,
  );
  const msgs = (json.messages || []).filter((m) => !String(m.from || "").startsWith(`${NAME}`));
  if (msgs.length) {
    state.pendingMessages.push(...msgs);
    save();
    log(`${msgs.length} message(s) queued for the inbox run`);
  }
  if (!paused) {
    const offered = json.tasks || [];
    const picked = pickTasks(offered, free, state.declined, { acceptUnassigned: cfg.acceptUnassigned !== false, role: ROLE, name: NAME });
    // Tasks offered but not taken (filtered out) are skipped for 30 min so /wait doesn't
    // return them again at once and spin.
    const pickedIds = new Set(picked.map(([, t]) => t.id));
    if (picked.length < free.length) for (const t of offered) if (!pickedIds.has(t.id)) passedOver.set(t.id, now + 30 * 60_000);
    for (const [slotNo, task] of picked) {
      await startTask(slotNo, task).catch((e) => log(`start ${task.id} failed: ${e.message}`));
    }
    if (state.declined.length > 200) state.declined = state.declined.slice(-200);
    if (Date.now() >= (state.inboxRetryAfter || 0)) startInbox();
  }
  writeStatus({ lastWaitSeconds: json.waited ?? null, error: null });
}

async function main() {
  log(`worker ${NAME} role=${ROLE} slots=${SLOTS} caps=[${CAPS.join(",")}] state=${STATE_DIR}`);
  await heartbeat(NAME, 0);
  let lastBeat = Date.now();
  const beat = setInterval(() => {
    heartbeat(NAME, slots.size);
    for (const n of slots.keys()) heartbeat(slotInstance(NAME, n), 1); // renews the slot's task lease
    lastBeat = Date.now();
  }, HEARTBEAT_MS);
  beat.unref();
  while (!stopping) {
    try {
      await cycle();
      backoff = 0;
    } catch (e) {
      backoff = nextBackoffMs(backoff);
      log(`relay error: ${e.message}; retry in ${Math.round(backoff / 1000)} s`);
      writeStatus({ error: e.message });
      await new Promise((r) => {
        wake = r;
        setTimeout(r, backoff);
      });
      wake = null;
    }
    if (ONCE) break;
    if (Date.now() - lastBeat > HEARTBEAT_MS * 2) lastBeat = Date.now();
  }
  if (ONCE) {
    // --once: wait for started runs, then exit (useful for testing a config).
    while (slots.size || inboxRun) await new Promise((r) => setTimeout(r, 2000));
    process.exit(0);
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    log(`${sig}: stopping after the current wait; running agents keep going`);
    setTimeout(() => process.exit(0), 1000);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
