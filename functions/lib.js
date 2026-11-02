"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const FANOUT_WINDOW_MS = 7 * DAY_MS;
const STALE_MS = DAY_MS;
const FANOUT_LIMIT = 200;

/** Clients without `base` are treated as base = agent id. */
function resolveBase(agent, base) {
  return typeof base === "string" && base ? base.slice(0, 128) : agent;
}

function isStale(lastSeenMs, nowMs) {
  return typeof lastSeenMs === "number" && nowMs - lastSeenMs > STALE_MS;
}

/** Fan-out messages are addressed to a role (base id) or "*", not this exact instance. */
function isFanOut(to, agent) {
  return to !== agent;
}

/**
 * Decide whether a message document should be delivered to `agent`.
 * - Exact-instance messages use the single `read` flag.
 * - Fan-out messages (role or "*") use the per-recipient `readBy` array,
 *   and never loop back to their sender.
 */
function shouldDeliver(msg, agent, base, nowMs, tsMs) {
  if (msg.to === agent) return !msg.read;
  if (msg.to !== base && msg.to !== "*") return false;
  if (msg.from === agent) return false;
  if (typeof tsMs === "number" && nowMs - tsMs > FANOUT_WINDOW_MS) return false;
  const readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
  return !readBy.includes(agent);
}

/** Task notifications go to the originator's role; old tasks fall back to `from`. */
function notifyTarget(task) {
  return task.fromBase || task.from;
}

module.exports = {
  FANOUT_WINDOW_MS,
  FANOUT_LIMIT,
  STALE_MS,
  resolveBase,
  isStale,
  isFanOut,
  shouldDeliver,
  notifyTarget,
};
