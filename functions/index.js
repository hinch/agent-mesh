const crypto = require("crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
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
 * GET /poll?agent=<id>&since=<iso>
 * Returns unread messages for this agent (including broadcasts)
 */
exports.poll = onRequest(OPTS, async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });

  const agent = req.query.agent;
  if (!agent) return res.status(400).json({ e: 3 });

  // Get unread messages addressed to this agent or broadcast
  // Two queries to avoid composite index requirement
  const [direct, broadcast] = await Promise.all([
    db.collection("messages").where("read", "==", false).where("to", "==", agent).limit(25).get(),
    db.collection("messages").where("read", "==", false).where("to", "==", "*").limit(25).get(),
  ]);
  const snap = { docs: [...direct.docs, ...broadcast.docs] };
  snap.forEach = (fn) => snap.docs.forEach(fn);

  const messages = [];
  const batch = db.batch();

  snap.forEach((doc) => {
    const d = doc.data();
    messages.push({
      id: doc.id,
      from: d.from,
      to: d.to,
      payload: d.payload,
      replyTo: d.replyTo,
      ts: d.ts ? d.ts.toDate().toISOString() : null,
    });
    // Mark as read
    batch.update(doc.ref, { read: true });
  });

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

  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ e: 3 });

  const batch = db.batch();
  ids.forEach((id) => batch.delete(db.collection("messages").doc(id)));
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
    if (!agent) return res.status(400).json({ e: 3 });
    const safeMeta = meta && typeof meta === "object" ? meta : {};
    const mcpVersion =
      typeof safeMeta.mcpVersion === "string"
        ? safeMeta.mcpVersion.slice(0, 64)
        : null;
    const update = {
      agent,
      meta: safeMeta,
      lastSeen: FieldValue.serverTimestamp(),
    };
    if (mcpVersion) update.mcpVersion = mcpVersion;
    await db.collection("agents").doc(agent).set(update, { merge: true });
    return res.json({ ok: true });
  }

  // List agents
  const snap = await db.collection("agents").get();
  const agents = [];
  snap.forEach((doc) => {
    const d = doc.data();
    agents.push({
      agent: d.agent,
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
        to: doc.data().from,
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
        to: doc.data().from,
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
