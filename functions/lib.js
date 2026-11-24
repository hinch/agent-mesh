"use strict";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FANOUT_WINDOW_MS = 7 * DAY_MS;
const STALE_MS = DAY_MS;
const FANOUT_LIMIT = 200;
// A claim is a lease. Without a renew (task "renew" or any heartbeat/poll from the
// claimer) it lapses and the task goes back to "open".
const DEFAULT_LEASE_MS = 4 * HOUR_MS;
const MAX_LEASE_MS = 7 * DAY_MS;
const MIN_LEASE_MS = 5 * 60 * 1000;
// Long-poll bounds for GET /wait (the function timeout must stay above MAX).
const WAIT_DEFAULT_S = 50;
const WAIT_MAX_S = 55;
const PRIORITIES = ["high", "normal", "low"];
const MAX_LIST = 20;

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
  // Legacy fan-out docs (pre-readBy) already marked read are considered delivered.
  if (!Array.isArray(msg.readBy) && msg.read === true) return false;
  const readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
  return !readBy.includes(agent);
}

/** Task notifications go to the originator's role; old tasks fall back to `from`. */
function notifyTarget(task) {
  return task.fromBase || task.from;
}

/** Instance ids are `<base>-<suffix>`; the base is the role. */
function baseOf(instance, knownBase) {
  if (typeof knownBase === "string" && knownBase) return knownBase;
  return typeof instance === "string" ? instance : "";
}

/**
 * Who may complete / fail / renew / release a claimed task:
 * the claiming instance, any instance of the claiming role (a restarted or
 * second session of the same worker), or any instance of the publishing role.
 */
function mayCloseTask(task, agent, agentBase) {
  if (!task || !agent) return false;
  if (task.claimedBy === agent) return true;
  const claimBase = task.claimedByBase || null;
  if (claimBase && agentBase && claimBase === agentBase) return true;
  // Legacy claims without claimedByBase: same role if the instance id starts with `<base>-`.
  if (!claimBase && agentBase && typeof task.claimedBy === "string" &&
      (task.claimedBy === agentBase || task.claimedBy.startsWith(`${agentBase}-`))) return true;
  const pubBase = task.fromBase || task.from;
  return !!agentBase && pubBase === agentBase;
}

/** Only the publishing role may cancel or reprioritise. */
function mayManageTask(task, agentBase) {
  return !!task && !!agentBase && (task.fromBase || task.from) === agentBase;
}

function clampLeaseMs(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LEASE_MS;
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.round(n * HOUR_MS)));
}

/** A claimed task whose lease has passed. Legacy claims (no leaseUntil) never expire here. */
function leaseExpired(task, nowMs) {
  if (!task || task.status !== "claimed") return false;
  const until = task.leaseUntilMs;
  return typeof until === "number" && until < nowMs;
}

function normPriority(p) {
  return PRIORITIES.includes(p) ? p : "normal";
}

function priorityRank(p) {
  const i = PRIORITIES.indexOf(normPriority(p));
  return i < 0 ? 1 : i;
}

/** Clean a capability / requirement list: short lowercase tokens, de-duplicated. */
function normList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.trim().toLowerCase().slice(0, 48);
    if (t && /^[a-z0-9._:-]+$/.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** Every required capability must be present. A task without requirements fits anyone. */
function capabilitiesSatisfy(requires, capabilities) {
  const need = normList(requires);
  if (!need.length) return true;
  const have = new Set(normList(capabilities));
  return need.every((r) => have.has(r));
}

/** Order open tasks: priority first, then oldest first. */
function compareTasks(a, b) {
  const p = priorityRank(a.priority) - priorityRank(b.priority);
  if (p) return p;
  return (a.publishedAtMs || 0) - (b.publishedAtMs || 0);
}

function clampWaitSeconds(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return WAIT_DEFAULT_S;
  return Math.min(WAIT_MAX_S, Math.max(1, Math.round(n)));
}

/** Is this message addressed to the agent at all (ignoring read state)? */
function addressedTo(msg, agent, base) {
  return msg.to === agent || msg.to === base || msg.to === "*";
}

module.exports = {
  HOUR_MS,
  FANOUT_WINDOW_MS,
  FANOUT_LIMIT,
  STALE_MS,
  DEFAULT_LEASE_MS,
  MAX_LEASE_MS,
  MIN_LEASE_MS,
  WAIT_DEFAULT_S,
  WAIT_MAX_S,
  PRIORITIES,
  resolveBase,
  isStale,
  isFanOut,
  shouldDeliver,
  notifyTarget,
  baseOf,
  mayCloseTask,
  mayManageTask,
  clampLeaseMs,
  leaseExpired,
  normPriority,
  priorityRank,
  normList,
  capabilitiesSatisfy,
  compareTasks,
  clampWaitSeconds,
  addressedTo,
};
