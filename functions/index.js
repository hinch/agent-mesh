const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// Auth key - all agents must include this in x-mesh-key header
const MESH_KEY = "REDACTED";

function auth(req) {
  return req.headers["x-mesh-key"] === MESH_KEY;
}

/**
 * POST /send
 * Body: { from: string, to: string, payload: string, replyTo?: string }
 * Sends a message from one agent to another (or broadcast with to:"*")
 */
exports.send = onRequest({ region: "us-east1" }, async (req, res) => {
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
exports.poll = onRequest({ region: "us-east1" }, async (req, res) => {
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
exports.ack = onRequest({ region: "us-east1" }, async (req, res) => {
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
exports.agents = onRequest({ region: "us-east1" }, async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST")
    return res.status(405).json({ e: 1 });
  if (!auth(req)) return res.status(401).json({ e: 2 });

  if (req.method === "POST") {
    // Register/heartbeat
    const { agent, meta } = req.body;
    if (!agent) return res.status(400).json({ e: 3 });
    await db
      .collection("agents")
      .doc(agent)
      .set(
        { agent, meta: meta || {}, lastSeen: FieldValue.serverTimestamp() },
        { merge: true }
      );
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
      lastSeen: d.lastSeen ? d.lastSeen.toDate().toISOString() : null,
    });
  });
  res.json({ agents });
});
