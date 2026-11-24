const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");

initializeApp();
const lib = require("./lib");
const db = getFirestore();

// Shared secret, stored in Google Cloud Secret Manager.
// Set it with: firebase functions:secrets:set MESH_KEY
const MESH_KEY = defineSecret("MESH_KEY");

// Deployment region. Override at deploy time via the MESH_REGION param
// (e.g. in functions/.env). Defaults to us-east1.
const REGION = defineString("MESH_REGION", { default: "us-east1" });

const OPTS = { region: REGION, secrets: [MESH_KEY] };
// /wait holds the request open for up to lib.WAIT_MAX_S seconds.
const WAIT_OPTS = { ...OPTS, timeoutSeconds: lib.WAIT_MAX_S + 15 };

// Constant-time key comparison. Returns false on missing header or length mismatch.
function auth(req) {
  const provided = req.headers["x-mesh-key"];
  const expected = MESH_KEY.value();
  if (typeof provided !== "string" || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const tsMs = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : null);
const iso = (t) => (t && typeof t.toDate === "function" ? t.toDate().toISOString() : null);

function newMessage(from, to, payload, replyTo) {
  return {
    from,
    to,
    payload,
    replyTo: replyTo || null,
    ts: FieldValue.serverTimestamp(),
    read: false,
  };
}

/** Liveness: every poll/wait/heartbeat updates the agent doc and renews its task leases. */
function touchAgent(agent, base, extra) {
  return db
    .collection("agents")
    .doc(agent)
    .set({ agent, base, instance: agent, ...(extra || {}), lastSeen: FieldValue.serverTimestamp() }, { merge: true })
    .catch(() => {});
}

async function renewLeases(agent) {
  try {
    const snap = await db.collection("tasks").where("claimedBy", "==", agent).where("status", "==", "claimed").limit(20).get();
    if (snap.empty) return;
    const now = Date.now();
    const batch = db.batch();
    snap.docs.forEach((doc) => {
      const d = doc.data();
      if (typeof d.leaseMs !== "number") return; // legacy claim, no lease
      batch.update(doc.ref, { leaseUntil: Timestamp.fromMillis(now + d.leaseMs) });
    });
    await batch.commit();
  } catch {
    // Lease renewal is best-effort; the claimer can also call tasks/renew.
  }
}

/** Collect undelivered messages for an instance; optionally mark them delivered. */
async function collectMessages(agent, base, consume) {
  const now = Date.now();
  const cutoff = new Date(now - lib.FANOUT_WINDOW_MS);
  // Firestore cannot query "array does not contain", so fan-out messages are
  // fetched over a bounded recent window and filtered in memory.
  const [direct, fan] = await Promise.all([
    db.collection("messages").where("read", "==", false).where("to", "==", agent).limit(25).get(),
    db
      .collection("messages")
      .where("to", "in", [base, "*"])
      .where("ts", ">=", cutoff)
      .orderBy("ts", "desc")
      .limit(lib.FANOUT_LIMIT)
      .get(),
  ]);
  const seen = new Set();
  const messages = [];
  const batch = db.batch();
  const handle = (doc) => {
    if (seen.has(doc.id)) return;
    const d = doc.data();
    const ms = tsMs(d.ts);
    if (!lib.shouldDeliver(d, agent, base, now, ms)) return;
    seen.add(doc.id);
    messages.push({
      id: doc.id,
      from: d.from,
      to: d.to,
      payload: d.payload,
      replyTo: d.replyTo,
      ts: ms ? new Date(ms).toISOString() : null,
    });
    if (!consume) return;
    if (lib.isFanOut(d.to, agent)) {
      batch.update(doc.ref, { readBy: FieldValue.arrayUnion(agent) });
    } else {
      batch.update(doc.ref, { read: true });
    }
  };
  direct.docs.forEach(handle);
  fan.docs.forEach(handle);
  messages.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (consume && messages.length > 0) await batch.commit();
  return messages;
}

function taskView(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    from: d.from,
    fromBase: d.fromBase || d.from,
    repo: d.repo,
    branch: d.branch,
    specPath: d.specPath,
    taskId: d.taskId,
    taskText: d.taskText,
    subTasks: d.subTasks,
    status: d.status,
    priority: lib.normPriority(d.priority),
    requires: d.requires || [],
    assignTo: d.assignTo || null,
    group: d.group || null,
    claimedBy: d.claimedBy,
    claimedByBase: d.claimedByBase || null,
    claimedAt: iso(d.claimedAt),
    leaseUntil: iso(d.leaseUntil),
    completedAt: iso(d.completedAt),
    commitSha: d.commitSha,
    failReason: d.failReason || null,
    publishedAt: iso(d.publishedAt),
    publishedAtMs: tsMs(d.publishedAt),
  };
}

/** Lazily return expired leases to "open" and tell the publisher. */
async function reapExpiredLeases() {
  const now = Date.now();
  const snap = await db.collection("tasks").where("status", "==", "claimed").limit(200).get();
  const expired = snap.docs.filter((doc) => lib.leaseExpired({ ...doc.data(), leaseUntilMs: tsMs(doc.data().leaseUntil) }, now));
  for (const doc of expired) {
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      const d = fresh.data();
      if (!lib.leaseExpired({ ...d, leaseUntilMs: tsMs(d.leaseUntil) }, Date.now())) return;
      tx.update(doc.ref, {
        status: "open",
        claimedBy: null,
        claimedByBase: null,
        claimedAt: null,
        leaseUntil: null,
        lastClaimedBy: d.claimedBy,
        reopenedAt: FieldValue.serverTimestamp(),
      });
      tx.set(
        db.collection("messages").doc(),
        newMessage(
          "agent-mesh",
          lib.notifyTarget(d),
          `T:reopened/${doc.id} reason=lease-expired;was=${d.claimedBy};task=${d.taskId}`,
        ),
      );
    });
  }
  return expired.length;
}

async function agentCapabilities(agent) {
  const doc = await db.collection("agents").doc(agent).get();
  if (!doc.exists) return [];
  const d = doc.data();
  return lib.normList(d.capabilities || (d.meta && d.meta.capabilities) || []);
}

/** Open tasks this agent may claim (role assignment + capabilities), best first. */
async function claimableFor(agent, base, skip) {
  const [snap, caps] = await Promise.all([
    db.collection("tasks").where("status", "==", "open").limit(100).get(),
    agentCapabilities(agent),
  ]);
  const skipSet = new Set(skip || []);
  return snap.docs
    .map(taskView)
    .filter((t) => !skipSet.has(t.id))
    .filter((t) => !t.assignTo || t.assignTo === base || t.assignTo === agent)
    .filter((t) => lib.capabilitiesSatisfy(t.requires, caps))
    .sort(lib.compareTasks);
}

/**
 * POST /send
 * Body: { from: string, to: string, payload: string, replyTo?: string }
 * Sends a message from one agent to another (or broadcast with to:"*")
 */
exports.send = onRequest(OPTS, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });

  const { from, to, payload, replyTo } = req.body;
  if (!from || !to || !payload) return res.status(400).json({ e: 3 });

  const ref = await db.collection("messages").add(newMessage(from, to, payload, replyTo));
  res.json({ id: ref.id });
});

/**
 * GET /poll?agent=<instanceId>&base=<baseId>[&peek=1]
 * Returns undelivered messages for this instance:
 *  - messages addressed to the exact instance id (single `read` flag)
 *  - messages addressed to its base id (role) or "*" (per-recipient `readBy`)
 * peek=1 returns them without marking them delivered.
 */
exports.poll = onRequest(OPTS, async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });
  const agent = req.query.agent;
  if (!agent) return res.status(400).json({ e: 3 });
  const base = lib.resolveBase(agent, req.query.base);
  // Polling counts as a heartbeat so fan-out reaches live instances.
  touchAgent(agent, base);
  renewLeases(agent);
  const messages = await collectMessages(agent, base, req.query.peek !== "1");
  res.json({ messages });
});

/**
 * GET /wait?agent=&base=[&timeout=50][&tasks=1][&skip=id,id][&peek=1]
 * Long-poll: returns as soon as there is a message for this instance (consumed
 * like /poll unless peek=1) or, with tasks=1, an open task it may claim.
 * Returns empty lists after `timeout` seconds (max 55). Clients loop on it.
 */
exports.wait = onRequest(WAIT_OPTS, async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });
  const agent = req.query.agent;
  if (!agent) return res.status(400).json({ e: 3 });
  const base = lib.resolveBase(agent, req.query.base);
  const timeoutS = lib.clampWaitSeconds(req.query.timeout);
  const wantTasks = req.query.tasks === "1";
  const consume = req.query.peek !== "1";
  const skip = String(req.query.skip || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  touchAgent(agent, base);
  renewLeases(agent);
  if (wantTasks) await reapExpiredLeases().catch(() => 0);

  const check = async () => {
    const messages = await collectMessages(agent, base, consume);
    const tasks = wantTasks ? await claimableFor(agent, base, skip) : [];
    return { messages, tasks };
  };

  let out = await check();
  if (out.messages.length || out.tasks.length) return res.json({ ...out, waited: 0 });

  const started = Date.now();
  out = await new Promise((resolve) => {
    let done = false;
    const unsubs = [];
    let busy = false;
    let again = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubs.forEach((u) => {
        try {
          u();
        } catch {}
      });
      resolve(value);
    };
    const recheck = async () => {
      if (done) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const r = await check();
        if (r.messages.length || r.tasks.length) return finish(r);
      } catch {
        // keep waiting; the timeout still ends the request
      } finally {
        busy = false;
      }
      if (again) {
        again = false;
        recheck();
      }
    };
    const timer = setTimeout(() => finish({ messages: [], tasks: [] }), timeoutS * 1000);
    req.on("close", () => finish({ messages: [], tasks: [] }));
    const since = Timestamp.fromMillis(started - 5000);
    let first = true;
    unsubs.push(
      db
        .collection("messages")
        .where("to", "in", [agent, base, "*"])
        .where("ts", ">=", since)
        .onSnapshot(
          (snap) => {
            if (first) {
              first = false;
              if (snap.empty) return;
            }
            if (snap.docChanges().some((c) => c.type === "added" || c.type === "modified")) recheck();
          },
          () => {},
        ),
    );
    if (wantTasks) {
      let firstT = true;
      unsubs.push(
        db
          .collection("tasks")
          .where("status", "==", "open")
          .onSnapshot(
            (snap) => {
              if (firstT) {
                firstT = false;
                return; // existing open tasks were already checked
              }
              if (snap.docChanges().some((c) => c.type === "added")) recheck();
            },
            () => {},
          ),
      );
    }
  });
  if (res.headersSent || res.writableEnded) return;
  res.json({ ...out, waited: Math.round((Date.now() - started) / 1000) });
});

/**
 * GET /history?agent=&base=[&hours=24][&limit=50]
 * Recent messages addressed to this instance, its role or "*", whether or not
 * they were delivered. Never marks anything. For sessions that want to see what
 * another session of the same role (e.g. a watcher) already consumed.
 */
exports.history = onRequest(OPTS, async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });
  const agent = req.query.agent;
  if (!agent) return res.status(400).json({ e: 3 });
  const base = lib.resolveBase(agent, req.query.base);
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const cutoff = new Date(Date.now() - hours * lib.HOUR_MS);
  const targets = Array.from(new Set([agent, base, "*"]));
  const snap = await db
    .collection("messages")
    .where("to", "in", targets)
    .where("ts", ">=", cutoff)
    .orderBy("ts", "desc")
    .limit(limit)
    .get();
  const messages = snap.docs.map((doc) => {
    const d = doc.data();
    const delivered = d.to === agent ? !!d.read : Array.isArray(d.readBy) ? d.readBy.includes(agent) : !!d.read;
    return {
      id: doc.id,
      from: d.from,
      to: d.to,
      payload: d.payload,
      replyTo: d.replyTo,
      ts: iso(d.ts),
      deliveredToYou: delivered,
      readBy: Array.isArray(d.readBy) ? d.readBy : d.read ? [d.to] : [],
    };
  });
  res.json({ messages });
});

/**
 * POST /ack
 * Body: { ids: string[] }
 * Explicitly acknowledge/delete messages
 */
exports.ack = onRequest(OPTS, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });

  const { ids, agent } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ e: 3 });
  const refs = ids.map((id) => db.collection("messages").doc(String(id)));
  const batch = db.batch();
  if (typeof agent === "string" && agent && refs.length) {
    // Instance-scoped ack: exact-instance messages are deleted; role/broadcast
    // messages are only marked delivered for this instance so others still get them.
    const docs = await db.getAll(...refs);
    docs.forEach((doc) => {
      if (!doc.exists) return;
      if (lib.isFanOut(doc.data().to, agent)) {
        batch.update(doc.ref, { readBy: FieldValue.arrayUnion(agent) });
      } else {
        batch.delete(doc.ref);
      }
    });
  } else {
    // Legacy ack without an agent: delete.
    refs.forEach((ref) => batch.delete(ref));
  }
  await batch.commit();
  res.json({ ok: true });
});

/**
 * GET /agents
 * Returns list of registered agents and their last heartbeat
 */
exports.agents = onRequest(OPTS, async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST")
    return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });

  if (req.method === "POST") {
    // Register/heartbeat
    const { agent, meta } = req.body;
    const base = lib.resolveBase(agent, req.body.base);
    if (!agent) return res.status(400).json({ e: 3 });
    const safeMeta = meta && typeof meta === "object" ? meta : {};
    const mcpVersion =
      typeof safeMeta.mcpVersion === "string"
        ? safeMeta.mcpVersion.slice(0, 64)
        : null;
    const update = {
      agent,
      base,
      instance: agent,
      meta: safeMeta,
      lastSeen: FieldValue.serverTimestamp(),
    };
    if (Array.isArray(safeMeta.capabilities)) update.capabilities = lib.normList(safeMeta.capabilities);
    if (typeof safeMeta.slots === "number") update.slots = Math.max(0, Math.min(64, Math.floor(safeMeta.slots)));
    if (typeof safeMeta.busy === "number") update.busy = Math.max(0, Math.min(64, Math.floor(safeMeta.busy)));
    if (mcpVersion) update.mcpVersion = mcpVersion;
    await db.collection("agents").doc(agent).set(update, { merge: true });
    renewLeases(agent);
    return res.json({ ok: true });
  }

  // List agents
  const now = Date.now();
  const snap = await db.collection("agents").get();
  const agents = [];
  snap.forEach((doc) => {
    const d = doc.data();
    const lastSeenMs = tsMs(d.lastSeen);
    agents.push({
      agent: d.agent,
      base: d.base || d.agent,
      instance: d.instance || d.agent,
      stale: lib.isStale(lastSeenMs, now),
      meta: d.meta,
      capabilities: d.capabilities || [],
      slots: typeof d.slots === "number" ? d.slots : null,
      busy: typeof d.busy === "number" ? d.busy : null,
      mcpVersion: d.mcpVersion || (d.meta && d.meta.mcpVersion) || null,
      lastSeen: d.lastSeen ? d.lastSeen.toDate().toISOString() : null,
    });
  });
  res.json({ agents });
});

/**
 * GET /status[?agent=&base=]
 * One-call overview for orchestrators: open tasks (best first), claimed tasks
 * with lease state, live agents grouped by role with capabilities and free
 * worker slots, and (with agent) how many messages are waiting for you.
 */
exports.status = onRequest(OPTS, async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });
  const reaped = await reapExpiredLeases().catch(() => 0);
  const now = Date.now();
  const [open, claimed, agentsSnap] = await Promise.all([
    db.collection("tasks").where("status", "==", "open").limit(100).get(),
    db.collection("tasks").where("status", "==", "claimed").limit(100).get(),
    db.collection("agents").get(),
  ]);
  const roles = {};
  agentsSnap.forEach((doc) => {
    const d = doc.data();
    const lastSeenMs = tsMs(d.lastSeen);
    if (lib.isStale(lastSeenMs, now) || lastSeenMs === null) return;
    const base = d.base || d.agent;
    const r = (roles[base] = roles[base] || { instances: 0, slots: 0, busy: 0, capabilities: [], lastSeen: null });
    r.instances += 1;
    if (typeof d.slots === "number") r.slots += d.slots;
    if (typeof d.busy === "number") r.busy += d.busy;
    for (const c of d.capabilities || []) if (!r.capabilities.includes(c)) r.capabilities.push(c);
    const ls = new Date(lastSeenMs).toISOString();
    if (!r.lastSeen || ls > r.lastSeen) r.lastSeen = ls;
  });
  const short = (t) => ({
    id: t.id,
    taskId: t.taskId,
    priority: t.priority,
    requires: t.requires,
    assignTo: t.assignTo,
    group: t.group,
    fromBase: t.fromBase,
    claimedBy: t.claimedBy,
    leaseUntil: t.leaseUntil,
    publishedAt: t.publishedAt,
  });
  const out = {
    reopenedNow: reaped,
    open: open.docs.map(taskView).sort(lib.compareTasks).map(short),
    claimed: claimed.docs.map(taskView).map(short),
    roles,
  };
  if (req.query.agent) {
    const base = lib.resolveBase(req.query.agent, req.query.base);
    out.waitingForYou = (await collectMessages(req.query.agent, base, false)).length;
  }
  res.json(out);
});

/**
 * POST /tasks
 * Body: { action, ... }
 *
 * Task lifecycle: open -> claimed -> completed | failed | cancelled
 *   (a claimed task whose lease lapses, or that is released, goes back to open)
 *
 * publish: { action:"publish", from, base, repo, branch, specPath, taskId, taskText, subTasks,
 *            priority?: "high"|"normal"|"low", requires?: string[], assignTo?: role,
 *            group?: string, leaseHours?: number }
 * claim:   { action:"claim", id, agent, base }  (id may be "next" to take the best claimable task)
 * renew:   { action:"renew", id, agent, base }
 * release: { action:"release", id, agent, base, reason? }
 * complete:{ action:"complete", id, agent, base, commitSha }
 * fail:    { action:"fail", id, agent, base, reason }
 * cancel:  { action:"cancel", id, agent, base, reason? }  (publishing role only)
 * list:    { action:"list", status?, group?, for?: agent, base? }
 */
exports.tasks = onRequest(OPTS, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });

  const { action } = req.body;
  if (!action) return res.status(400).json({ e: 3, msg: "action required" });

  const tasksCol = db.collection("tasks");
  const agentBase = (agent) => lib.resolveBase(agent, req.body.base);

  switch (action) {
    case "publish": {
      const { from, repo, branch, specPath, taskId, taskText, subTasks } =
        req.body;
      if (!from || !repo || !taskId || !taskText)
        return res.status(400).json({ e: 3, msg: "missing fields" });

      const assignTo =
        typeof req.body.assignTo === "string" && req.body.assignTo.trim()
          ? req.body.assignTo.trim().slice(0, 128)
          : null;
      const task = {
        from,
        fromBase: lib.resolveBase(from, req.body.base),
        repo,
        branch: branch || "internal-testing",
        specPath: specPath || null,
        taskId,
        taskText,
        subTasks: subTasks || [],
        priority: lib.normPriority(req.body.priority),
        requires: lib.normList(req.body.requires),
        assignTo,
        group: typeof req.body.group === "string" && req.body.group ? req.body.group.slice(0, 128) : null,
        leaseMs: lib.clampLeaseMs(req.body.leaseHours),
        status: "open",
        claimedBy: null,
        claimedByBase: null,
        claimedAt: null,
        leaseUntil: null,
        completedAt: null,
        commitSha: null,
        failReason: null,
        publishedAt: FieldValue.serverTimestamp(),
      };
      const ref = await tasksCol.add(task);
      // A task meant for a specific role is also announced to it, so interactive
      // sessions of that role see it in their inbox, not only their task list.
      if (assignTo) {
        await db.collection("messages").add(
          newMessage(
            from,
            assignTo,
            `E:task/assigned id=${ref.id};task=${taskId};priority=${task.priority}` +
              (task.requires.length ? `;requires=${task.requires.join(",")}` : ""),
          ),
        );
      }
      return res.json({ id: ref.id, status: "open" });
    }

    case "claim": {
      const { agent } = req.body;
      let { id } = req.body;
      if (!id || !agent)
        return res.status(400).json({ e: 3, msg: "id and agent required" });
      const base = agentBase(agent);
      await reapExpiredLeases().catch(() => 0);
      if (id === "next") {
        const list = await claimableFor(agent, base, []);
        if (!list.length) return res.status(404).json({ e: 4, msg: "no claimable task" });
        id = list[0].id;
      }
      const caps = await agentCapabilities(agent);

      // Atomic claim via transaction — prevents double-claim
      try {
        let claimedView = null;
        await db.runTransaction(async (tx) => {
          const ref = tasksCol.doc(id);
          const doc = await tx.get(ref);
          if (!doc.exists) throw new Error("not_found");
          const d = doc.data();
          if (d.status !== "open") throw new Error("already_claimed");
          if (d.assignTo && d.assignTo !== base && d.assignTo !== agent) throw new Error("assigned_elsewhere");
          if (!lib.capabilitiesSatisfy(d.requires, caps)) throw new Error("missing_capability");
          const leaseMs = typeof d.leaseMs === "number" ? d.leaseMs : lib.DEFAULT_LEASE_MS;
          tx.update(ref, {
            status: "claimed",
            claimedBy: agent,
            claimedByBase: base,
            claimedAt: FieldValue.serverTimestamp(),
            leaseMs,
            leaseUntil: Timestamp.fromMillis(Date.now() + leaseMs),
          });
          claimedView = { id, taskId: d.taskId, leaseHours: leaseMs / lib.HOUR_MS };
        });
        return res.json({ ok: true, status: "claimed", ...claimedView });
      } catch (e) {
        if (e.message === "not_found")
          return res.status(404).json({ e: 4, msg: "task not found" });
        if (e.message === "already_claimed")
          return res.status(409).json({ e: 5, msg: "task already claimed" });
        if (e.message === "assigned_elsewhere")
          return res.status(403).json({ e: 7, msg: "task is assigned to another role" });
        if (e.message === "missing_capability")
          return res.status(412).json({ e: 8, msg: "this agent lacks a required capability (send it in mesh_heartbeat meta.capabilities)" });
        throw e;
      }
    }

    case "renew":
    case "release":
    case "complete":
    case "fail":
    case "cancel": {
      const { id, agent } = req.body;
      if (!id || !agent)
        return res.status(400).json({ e: 3, msg: "id and agent required" });
      const base = agentBase(agent);
      const ref = tasksCol.doc(id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ e: 4 });
      const d = doc.data();

      if (action === "cancel") {
        if (!lib.mayManageTask(d, base))
          return res.status(403).json({ e: 6, msg: "only the publishing role may cancel" });
        await ref.update({ status: "cancelled", failReason: req.body.reason || "cancelled", completedAt: FieldValue.serverTimestamp() });
        if (d.claimedBy) {
          await db.collection("messages").add(newMessage(agent, d.claimedBy, `T:cancelled/${id} reason=${req.body.reason || "cancelled"};task=${d.taskId}`));
        }
        return res.json({ ok: true, status: "cancelled" });
      }

      // fail is also allowed on an open task by its publisher (withdraw with a reason).
      const openWithdraw = action === "fail" && d.status === "open" && lib.mayManageTask(d, base);
      if (!openWithdraw && !lib.mayCloseTask(d, agent, base))
        return res.status(403).json({ e: 6, msg: "not your task (claimer, its role, or the publishing role only)" });

      if (action === "renew") {
        if (d.status !== "claimed") return res.status(409).json({ e: 5, msg: `task is ${d.status}` });
        const leaseMs = typeof d.leaseMs === "number" ? d.leaseMs : lib.DEFAULT_LEASE_MS;
        const until = Date.now() + leaseMs;
        await ref.update({ leaseMs, leaseUntil: Timestamp.fromMillis(until) });
        return res.json({ ok: true, status: "claimed", leaseUntil: new Date(until).toISOString() });
      }

      if (action === "release") {
        if (d.status !== "claimed") return res.status(409).json({ e: 5, msg: `task is ${d.status}` });
        await ref.update({
          status: "open",
          claimedBy: null,
          claimedByBase: null,
          claimedAt: null,
          leaseUntil: null,
          lastClaimedBy: d.claimedBy,
          reopenedAt: FieldValue.serverTimestamp(),
        });
        await db.collection("messages").add(
          newMessage(agent, lib.notifyTarget(d), `T:released/${id} reason=${req.body.reason || "released"};task=${d.taskId}`),
        );
        return res.json({ ok: true, status: "open" });
      }

      if (action === "complete") {
        const { commitSha } = req.body;
        await ref.update({
          status: "completed",
          commitSha: commitSha || null,
          completedAt: FieldValue.serverTimestamp(),
          completedBy: agent,
        });
        await db.collection("messages").add(
          newMessage(agent, lib.notifyTarget(d), `T:done/${id} sha=${commitSha || "none"};task=${d.taskId}`),
        );
        return res.json({ ok: true, status: "completed" });
      }

      // fail
      const { reason } = req.body;
      await ref.update({
        status: "failed",
        failReason: reason || "unknown",
        completedAt: FieldValue.serverTimestamp(),
        completedBy: agent,
      });
      await db.collection("messages").add(
        newMessage(agent, lib.notifyTarget(d), `T:fail/${id} reason=${reason || "unknown"};task=${d.taskId}`),
      );
      return res.json({ ok: true, status: "failed" });
    }

    case "list": {
      const { status, group } = req.body;
      await reapExpiredLeases().catch(() => 0);
      if (req.body.for) {
        const forAgent = String(req.body.for);
        const tasks = await claimableFor(forAgent, lib.resolveBase(forAgent, req.body.base), []);
        return res.json({ tasks });
      }
      let query = tasksCol.orderBy("publishedAt", "desc").limit(50);
      if (status) query = tasksCol.where("status", "==", status).limit(50);
      if (group) query = tasksCol.where("group", "==", String(group)).limit(100);
      const snap = await query.get();
      let tasks = snap.docs.map(taskView);
      if (group && status) tasks = tasks.filter((t) => t.status === status);
      if (status === "open") tasks.sort(lib.compareTasks);
      return res.json({ tasks });
    }

    default:
      return res.status(400).json({ e: 3, msg: `unknown action: ${action}` });
  }
});
