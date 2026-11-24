import { randomBytes } from "node:crypto";

/**
 * Derive the base (role) id and the effective per-process instance id.
 *
 * - MESH_AGENT_ID is the BASE id (role). Defaults to "agent".
 * - MESH_INSTANCE_ID, if set, is used verbatim as the instance id.
 * - MESH_SESSION_SUFFIX=off uses the base id verbatim (single-instance machines).
 * - Otherwise instance = `<base>-<6 hex chars>`, generated once per process.
 */
export function deriveIds(env = process.env, suffixFn = () => randomBytes(3).toString("hex")) {
  const explicit = (env.MESH_INSTANCE_ID || "").trim();
  const base = (env.MESH_AGENT_ID || "").trim() || explicit || "agent";
  if (explicit) return { base, instance: explicit };
  if ((env.MESH_SESSION_SUFFIX || "").trim().toLowerCase() === "off") {
    return { base, instance: base };
  }
  return { base, instance: `${base}-${suffixFn()}` };
}

/** MESH_CAPABILITIES="android-sdk, emulator,gpu" -> ["android-sdk","emulator","gpu"] */
export function parseCapabilities(raw) {
  if (typeof raw !== "string") return [];
  const out = [];
  for (const part of raw.split(/[,\s]+/)) {
    const t = part.trim().toLowerCase();
    if (t && /^[a-z0-9._:-]+$/.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Shorten a task list for display so a full list fits a tool response:
 * taskText is cut to `max` chars (the full text stays on the relay; claim or
 * list with full=true to read it).
 */
export function briefTasks(result, max = 280) {
  if (!result || !Array.isArray(result.tasks)) return result;
  return {
    ...result,
    tasks: result.tasks.map((t) => {
      const text = typeof t.taskText === "string" ? t.taskText : "";
      const { publishedAtMs, ...rest } = t;
      return text.length > max ? { ...rest, taskText: `${text.slice(0, max)}... [${text.length} chars, full=true to read]` } : rest;
    }),
  };
}

/** Condense the /agents response for display: base, instance, version, stale. */
export function summarizeAgents(result) {
  if (!result || !Array.isArray(result.agents)) return result;
  return {
    agents: result.agents.map((a) => ({
      base: a.base || a.agent,
      instance: a.instance || a.agent,
      version: a.mcpVersion || null,
      stale: !!a.stale,
      lastSeen: a.lastSeen || null,
      ...(Array.isArray(a.capabilities) && a.capabilities.length ? { capabilities: a.capabilities } : {}),
      ...(typeof a.slots === "number" ? { slots: a.slots, busy: a.busy || 0 } : {}),
    })),
  };
}
