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
    })),
  };
}
