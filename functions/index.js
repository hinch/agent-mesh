const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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

  const msg = {
    from,
    to,
    payload,
    replyTo: replyTo || null,
    ts: FieldValue.serverTimestamp(),
    read: false,
  };

  const ref = await db.collection("messages").add(msg);
  res.json({ id: ref.id });
});

/**
 * GET /poll?agent=<instanceId>&base=<baseId>
 * Returns undelivered messages for this instance:
 *  - messages addressed to the exact instance id (single `read` flag)
 *  - messages addressed to its base id (role) or "*" (per-recipient `readBy`)
 */
exports.poll = onRequest(OPTS, async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });
  const agent = req.query.agent;
  if (!agent) return res.status(400).json({ e: 3 });
  const base = lib.resolveBase(agent, req.query.base);
  const now = Date.now();
  const cutoff = new Date(now - lib.FANOUT_WINDOW_MS);
  // Polling counts as a heartbeat so fan-out reaches live instances.
  db.collection("agents")
    .doc(agent)
    .set({ agent, base, instance: agent, lastSeen: FieldValue.serverTimestamp() }, { merge: true })
    .catch(() => {});
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
    const tsMs = d.ts ? d.ts.toMillis() : null;
    if (!lib.shouldDeliver(d, agent, base, now, tsMs)) return;
    seen.add(doc.id);
    messages.push({
      id: doc.id,
      from: d.from,
      to: d.to,
      payload: d.payload,
      replyTo: d.replyTo,
      ts: tsMs ? new Date(tsMs).toISOString() : null,
    });
    if (lib.isFanOut(d.to, agent)) {
      batch.update(doc.ref, { readBy: FieldValue.arrayUnion(agent) });
    } else {
      batch.update(doc.ref, { read: true });
    }
  };
  direct.docs.forEach(handle);
  fan.docs.forEach(handle);
  if (messages.length > 0) await batch.commit();
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
    if (mcpVersion) update.mcpVersion = mcpVersion;
    await db.collection("agents").doc(agent).set(update, { merge: true });
    return res.json({ ok: true });
  }

  // List agents
  const now = Date.now();
  const snap = await db.collection("agents").get();
  const agents = [];
  snap.forEach((doc) => {
    const d = doc.data();
    const lastSeenMs = d.lastSeen ? d.lastSeen.toMillis() : null;
    agents.push({
      agent: d.agent,
      base: d.base || d.agent,
      instance: d.instance || d.agent,
      stale: lib.isStale(lastSeenMs, now),
      meta: d.meta,
      mcpVersion: d.mcpVersion || (d.meta && d.meta.mcpVersion) || null,
      lastSeen: d.lastSeen ? d.lastSeen.toDate().toISOString() : null,
    });
  });
  res.json({ agents });
});

/**
 * POST /tasks
 * Body: { action: "publish"|"claim"|"complete"|"fail"|"list", ... }
 *
 * Task lifecycle: open -> claimed -> completed|failed
 *
 * publish: { action:"publish", from, repo, branch, specPath, taskId, taskText, subTasks }
 * claim:   { action:"claim", id, agent }
 * complete:{ action:"complete", id, agent, commitSha }
 * fail:    { action:"fail", id, agent, reason }
 * list:    { action:"list", status? }  -- optional filter by status
 */
exports.tasks = onRequest(OPTS, async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });

  const { action } = req.body;
  if (!action) return res.status(400).json({ e: 3, msg: "action required" });

  const tasksCol = db.collection("tasks");

  switch (action) {
    case "publish": {
      const { from, repo, branch, specPath, taskId, taskText, subTasks } =
        req.body;
      if (!from || !repo || !taskId || !taskText)
        return res.status(400).json({ e: 3, msg: "missing fields" });

      const task = {
        from,
        fromBase: lib.resolveBase(from, req.body.base),
        repo,
        branch: branch || "internal-testing",
        specPath: specPath || null,
        taskId,
        taskText,
        subTasks: subTasks || [],
        status: "open",
        claimedBy: null,
        claimedAt: null,
        completedAt: null,
        commitSha: null,
        failReason: null,
        publishedAt: FieldValue.serverTimestamp(),
      };
      const ref = await tasksCol.add(task);
      return res.json({ id: ref.id, status: "open" });
    }

    case "claim": {
      const { id, agent } = req.body;
      if (!id || !agent)
        return res.status(400).json({ e: 3, msg: "id and agent required" });

      // Atomic claim via transaction — prevents double-claim
      try {
        await db.runTransaction(async (tx) => {
          const ref = tasksCol.doc(id);
          const doc = await tx.get(ref);
          if (!doc.exists) throw new Error("not_found");
          if (doc.data().status !== "open") throw new Error("already_claimed");
          tx.update(ref, {
            status: "claimed",
            claimedBy: agent,
            claimedAt: FieldValue.serverTimestamp(),
          });
        });
        return res.json({ ok: true, status: "claimed" });
      } catch (e) {
        if (e.message === "not_found")
          return res.status(404).json({ e: 4, msg: "task not found" });
        if (e.message === "already_claimed")
          return res.status(409).json({ e: 5, msg: "task already claimed" });
        throw e;
      }
    }

    case "complete": {
      const { id, agent, commitSha } = req.body;
      if (!id || !agent)
        return res.status(400).json({ e: 3, msg: "id and agent required" });

      const ref = tasksCol.doc(id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ e: 4 });
      if (doc.data().claimedBy !== agent)
        return res.status(403).json({ e: 6, msg: "not your task" });

      await ref.update({
        status: "completed",
        commitSha: commitSha || null,
        completedAt: FieldValue.serverTimestamp(),
      });

      // Notify the originator
      await db.collection("messages").add({
        from: agent,
        to: lib.notifyTarget(doc.data()),
        payload: `T:done/${id} sha=${commitSha || "none"};task=${doc.data().taskId}`,
        replyTo: null,
        ts: FieldValue.serverTimestamp(),
        read: false,
      });

      return res.json({ ok: true, status: "completed" });
    }

    case "fail": {
      const { id, agent, reason } = req.body;
      if (!id || !agent)
        return res.status(400).json({ e: 3, msg: "id and agent required" });

      const ref = tasksCol.doc(id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ e: 4 });

      await ref.update({
        status: "failed",
        failReason: reason || "unknown",
        completedAt: FieldValue.serverTimestamp(),
      });

      // Notify the originator
      await db.collection("messages").add({
        from: agent,
        to: lib.notifyTarget(doc.data()),
        payload: `T:fail/${id} reason=${reason || "unknown"};task=${doc.data().taskId}`,
        replyTo: null,
        ts: FieldValue.serverTimestamp(),
        read: false,
      });

      return res.json({ ok: true, status: "failed" });
    }

    case "list": {
      const { status } = req.body;
      let query = tasksCol.orderBy("publishedAt", "desc").limit(50);
      if (status) query = tasksCol.where("status", "==", status).limit(50);
      const snap = await query.get();
      const tasks = [];
      snap.forEach((doc) => {
        const d = doc.data();
        tasks.push({
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
          claimedBy: d.claimedBy,
          claimedAt: d.claimedAt ? d.claimedAt.toDate().toISOString() : null,
          completedAt: d.completedAt
            ? d.completedAt.toDate().toISOString()
            : null,
          commitSha: d.commitSha,
          publishedAt: d.publishedAt
            ? d.publishedAt.toDate().toISOString()
            : null,
        });
      });
      return res.json({ tasks });
    }

    default:
      return res.status(400).json({ e: 3, msg: `unknown action: ${action}` });
  }
});
