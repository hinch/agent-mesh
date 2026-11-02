// Pure helpers for the self-host tooling. No side effects, no network.
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

/** Fresh mesh key: "msh_" + 32 random bytes, base64url. Generated locally, never stored in the repo. */
function generateKey(bytes = 32) {
  return "msh_" + crypto.randomBytes(bytes).toString("base64url");
}

const PROJECT_RE = /^[a-z][a-z0-9-]{4,29}$/;
const REGION_RE = /^[a-z]+-[a-z]+[0-9]+$/;
const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isValidProject(p) {
  return typeof p === "string" && PROJECT_RE.test(p);
}
function isValidRegion(r) {
  return typeof r === "string" && REGION_RE.test(r);
}
function isValidAgentId(a) {
  return typeof a === "string" && AGENT_RE.test(a);
}

function meshUrl(project, region) {
  return `https://${region}-${project}.cloudfunctions.net`;
}

/** Build the MCP server entry for a deployment. */
function buildServerEntry({ url, key, agentId, indexPath }) {
  return {
    command: "node",
    args: [indexPath],
    env: { MESH_AGENT_ID: agentId, MESH_URL: url, MESH_KEY: key },
    disabled: false,
    autoApprove: [
      "mesh_send",
      "mesh_poll",
      "mesh_agents",
      "mesh_heartbeat",
      "mesh_version",
      "mesh_announce_update",
      "mesh_task_publish",
      "mesh_task_claim",
      "mesh_task_complete",
      "mesh_task_fail",
      "mesh_task_list",
    ],
  };
}

function buildConfigBlock(opts) {
  return JSON.stringify({ mcpServers: { "agent-mesh": buildServerEntry(opts) } }, null, 2);
}

/** True if target resolves to repoRoot or anything inside it. */
function isInsideDir(target, repoRoot) {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Throws if a path that would receive the key is inside the repo working tree. */
function assertOutsideRepo(target, repoRoot) {
  if (isInsideDir(target, repoRoot)) {
    throw new Error(
      "Refusing to write the mesh key to a path inside the repository working tree: " + target
    );
  }
}

/** Minimal flag parser: --flag, --flag value, --flag=value. First bare word is the command. */
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out.flags[a.slice(2)] = next;
          i++;
        } else {
          out.flags[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

module.exports = {
  generateKey,
  isValidProject,
  isValidRegion,
  isValidAgentId,
  meshUrl,
  buildServerEntry,
  buildConfigBlock,
  isInsideDir,
  assertOutsideRepo,
  parseArgs,
};
