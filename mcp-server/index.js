#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createUpdateChecker, DEFAULT_UPDATE_REPO } from "./version.js";
import { deriveIds, summarizeAgents, parseCapabilities, briefTasks } from "./ids.js";

const LOCAL_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
).version;
const UPDATE_REPO = process.env.MESH_UPDATE_REPO || DEFAULT_UPDATE_REPO;
const updates = createUpdateChecker({ localVersion: LOCAL_VERSION, repo: UPDATE_REPO });

const BASE_URL = (process.env.MESH_URL || "").replace(/\/+$/, "");
const MESH_KEY = process.env.MESH_KEY || "";
// MESH_AGENT_ID is the BASE (role) id; AGENT_ID is this process's unique instance id.
const { base: BASE_ID, instance: AGENT_ID } = deriveIds(process.env);
// What this machine can do, e.g. "android-sdk,emulator,gpu". Tasks can require these.
const CAPABILITIES = parseCapabilities(process.env.MESH_CAPABILITIES || "");
const WAIT_MAX_S = 55;

const missing = [];
if (!BASE_URL) missing.push("MESH_URL");
if (!MESH_KEY) missing.push("MESH_KEY");
if (missing.length) {
  console.error(
    `agent-mesh-mcp: missing required environment variable(s): ${missing.join(", ")}. ` +
      "Set MESH_URL (your relay base URL) and MESH_KEY (your mesh key) in the MCP server env."
  );
  process.exit(1);
}
async function meshFetch(endpoint, method, body, timeoutMs = 30000) {
  const opts = {
    method,
    headers: {
      "x-mesh-key": MESH_KEY,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}/${endpoint}`, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // An older relay without this endpoint answers 404 with HTML.
    return { e: res.status, msg: res.status === 404 ? `relay has no /${endpoint.split("?")[0]} (deploy agent-mesh >= 1.4.0)` : text.slice(0, 200) };
  }
}

const q = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

const heartbeatMeta = (extra) => ({
  host: hostname(),
  ...(CAPABILITIES.length ? { capabilities: CAPABILITIES } : {}),
  ...(extra || {}),
  mcpVersion: LOCAL_VERSION,
});

const server = new Server(
  { name: "agent-mesh", version: LOCAL_VERSION },
  { capabilities: { tools: {} } }
);

const str = (description) => ({ type: "string", description });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mesh_send",
      description:
        "Send a message to another agent on the mesh. Use structured compact notation for efficiency. Address ROLES (base ids) for replies and work-done notes: a message to one instance id is only seen by that one session.",
      inputSchema: {
        type: "object",
        properties: {
          to: str('Target: a ROLE (base id, e.g. "kiro-orchestrator") reaches every live instance of that role; an exact instance id reaches one session; "*" broadcasts. Address roles, not instance ids, for work-done replies.'),
          payload: str("Message content. Use mesh protocol notation for efficiency."),
          replyTo: str("Optional message ID this is replying to"),
        },
        required: ["to", "payload"],
      },
    },
    {
      name: "mesh_poll",
      description:
        "Check for new messages addressed to this instance, to its role (base id), or broadcast. Marks them delivered for this instance unless peek=true.",
      inputSchema: {
        type: "object",
        properties: { peek: { type: "boolean", description: "Return messages without marking them delivered." } },
      },
    },
    {
      name: "mesh_wait",
      description:
        "Block until a message arrives for this instance/role (pushed by the relay, no polling), or until `seconds` pass (max 55; call again to keep waiting). Use this instead of sleep loops when you expect a reply. With tasks=true it also returns as soon as an open task you can claim appears.",
      inputSchema: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "How long to wait, 1-55 (default 50)." },
          tasks: { type: "boolean", description: "Also wake on a claimable open task (respects assignTo and requires)." },
          peek: { type: "boolean", description: "Do not mark returned messages delivered." },
        },
      },
    },
    {
      name: "mesh_history",
      description:
        "Recent messages to this instance, its role or '*', INCLUDING ones another session of your role (e.g. a background watcher) already consumed. Read-only. Use when a poll is empty but you expect something.",
      inputSchema: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Look back this many hours (1-168, default 24)." },
          limit: { type: "number", description: "Max messages (default 30)." },
          full: { type: "boolean", description: "Return full payloads (default: cut to 400 chars)." },
        },
      },
    },
    {
      name: "mesh_status",
      description:
        "One-call overview: open tasks (best first), claimed tasks with lease expiry, live roles with capabilities and free worker slots, and how many messages wait for you. Expired leases are reopened as a side effect.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mesh_agents",
      description: "List agents registered on the mesh: base (role), instance id, version, capabilities, worker slots and stale flag (no heartbeat for 24h).",
      inputSchema: {
        type: "object",
        properties: { live: { type: "boolean", description: "Only agents seen in the last 24h." } },
      },
    },
    {
      name: "mesh_heartbeat",
      description:
        "Register this agent on the mesh and send a heartbeat with metadata. Capabilities from MESH_CAPABILITIES are sent automatically; heartbeats also renew leases on tasks you hold.",
      inputSchema: {
        type: "object",
        properties: {
          meta: { type: "object", description: "Optional metadata (device, project, capabilities: string[])" },
        },
      },
    },
    {
      name: "mesh_task_publish",
      description:
        "Publish a task to the mesh. Completion/failure notices go to your role. Use assignTo to route it to one role (that role is also messaged), requires to restrict it to machines with given capabilities, priority to order the queue, and group to fan out a set of parallel sub-tasks you can track together.",
      inputSchema: {
        type: "object",
        properties: {
          repo: str("Git repo URL"),
          branch: str("Branch to work on"),
          specPath: str("Path to spec tasks.md relative to repo root"),
          taskId: str("Task ID from the spec"),
          taskText: str("Full, self-contained task description"),
          subTasks: { type: "array", items: { type: "string" }, description: "Sub-task descriptions" },
          priority: { type: "string", enum: ["high", "normal", "low"], description: "Queue order (default normal)." },
          requires: { type: "array", items: { type: "string" }, description: 'Capabilities a claimer must have, e.g. ["android-sdk","emulator"].' },
          assignTo: str("Only this role (base id) or instance may claim it."),
          group: str("Group id for a batch of parallel tasks (list with group=...)."),
          leaseHours: { type: "number", description: "Claim lease (default 4h). A claim not renewed in time reopens the task." },
        },
        required: ["repo", "taskId", "taskText"],
      },
    },
    {
      name: "mesh_task_claim",
      description:
        'Claim an open task (atomic). id="next" takes the best task you are allowed to do (priority, then oldest). The claim is a lease: your polls/waits/heartbeats renew it; if you go silent it reopens.',
      inputSchema: {
        type: "object",
        properties: { id: str('Mesh task document ID, or "next"') },
        required: ["id"],
      },
    },
    {
      name: "mesh_task_renew",
      description: "Extend the lease on a task you (or your role) hold. Needed only if you work for hours without any mesh call.",
      inputSchema: { type: "object", properties: { id: str("Mesh task document ID") }, required: ["id"] },
    },
    {
      name: "mesh_task_release",
      description: "Give a claimed task back to the queue (status open) with a reason, e.g. when you cannot finish it.",
      inputSchema: {
        type: "object",
        properties: { id: str("Mesh task document ID"), reason: str("Why") },
        required: ["id"],
      },
    },
    {
      name: "mesh_task_complete",
      description: "Mark a claimed task as completed with the commit SHA. Any session of the claiming role, or the publishing role, may close it. The originator's role is notified automatically.",
      inputSchema: {
        type: "object",
        properties: {
          id: str("Mesh task document ID"),
          commitSha: str("Git commit SHA of the completed work"),
        },
        required: ["id"],
      },
    },
    {
      name: "mesh_task_fail",
      description: "Mark a task as failed with a reason (claimer, its role, or the publisher withdrawing an open task).",
      inputSchema: {
        type: "object",
        properties: { id: str("Mesh task document ID"), reason: str("Why the task failed") },
        required: ["id"],
      },
    },
    {
      name: "mesh_task_cancel",
      description: "Cancel a task you published (open or claimed). The claimer is told.",
      inputSchema: {
        type: "object",
        properties: { id: str("Mesh task document ID"), reason: str("Why") },
        required: ["id"],
      },
    },
    {
      name: "mesh_task_list",
      description:
        "List tasks. Filter by status (open, claimed, completed, failed, cancelled) and/or group; mine=true lists open tasks YOU may claim. Task text is shortened unless full=true.",
      inputSchema: {
        type: "object",
        properties: {
          status: str("open, claimed, completed, failed or cancelled. Omit for the 50 newest."),
          group: str("Only tasks of this group."),
          mine: { type: "boolean", description: "Open tasks this instance may claim (assignTo + requires), best first." },
          full: { type: "boolean", description: "Return full task text." },
        },
      },
    },
    {
      name: "mesh_version",
      description:
        "Report this MCP server version, the latest known version on GitHub, and update status. Forces a re-check.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mesh_announce_update",
      description:
        "Broadcast E:mesh/update to all agents so they re-check GitHub for a new version.",
      inputSchema: {
        type: "object",
        properties: {
          version: str("Version being announced (defaults to local version)"),
        },
      },
    },
  ],
}));

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] });

function trimMessages(result, full) {
  if (full || !result || !Array.isArray(result.messages)) return result;
  return {
    ...result,
    messages: result.messages.map((m) => {
      const p = typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload);
      return p.length > 400 ? { ...m, payload: `${p.slice(0, 400)}... [${p.length} chars, full=true]` } : m;
    }),
  };
}

async function maybeCheckUpdate(result) {
  // An E:mesh/update announcement only triggers a re-check; GitHub is the source of truth.
  if (
    result &&
    Array.isArray(result.messages) &&
    result.messages.some((m) => typeof m.payload === "string" && m.payload.startsWith("E:mesh/update"))
  ) {
    await updates.check(true);
  }
}

const ids = () => ({ agent: AGENT_ID, base: BASE_ID });

async function handleTool(name, args) {
  switch (name) {
    case "mesh_send":
      return text(
        await meshFetch("send", "POST", {
          from: AGENT_ID,
          base: BASE_ID,
          to: args.to,
          payload: args.payload,
          replyTo: args.replyTo,
        })
      );

    case "mesh_poll": {
      const result = await meshFetch(`poll?${q({ ...ids(), peek: args.peek ? 1 : undefined })}`, "GET");
      await maybeCheckUpdate(result);
      return text(result);
    }

    case "mesh_wait": {
      const seconds = Math.min(WAIT_MAX_S, Math.max(1, Math.round(Number(args.seconds) || 50)));
      const result = await meshFetch(
        `wait?${q({ ...ids(), timeout: seconds, tasks: args.tasks ? 1 : undefined, peek: args.peek ? 1 : undefined })}`,
        "GET",
        undefined,
        (seconds + 20) * 1000
      );
      await maybeCheckUpdate(result);
      return text(briefTasks(result));
    }

    case "mesh_history":
      return text(
        trimMessages(
          await meshFetch(`history?${q({ ...ids(), hours: args.hours, limit: args.limit || 30 })}`, "GET"),
          args.full
        )
      );

    case "mesh_status":
      return text(await meshFetch(`status?${q(ids())}`, "GET"));

    case "mesh_agents": {
      const result = summarizeAgents(await meshFetch("agents", "GET"));
      if (args.live && result && Array.isArray(result.agents)) {
        return text({ agents: result.agents.filter((a) => !a.stale) });
      }
      return text(result);
    }

    case "mesh_heartbeat":
      return text(
        await meshFetch("agents", "POST", {
          ...ids(),
          meta: heartbeatMeta(args.meta),
        })
      );

    case "mesh_task_publish":
      return text(
        await meshFetch("tasks", "POST", {
          action: "publish",
          from: AGENT_ID,
          base: BASE_ID,
          repo: args.repo,
          branch: args.branch || "internal-testing",
          specPath: args.specPath || null,
          taskId: args.taskId,
          taskText: args.taskText,
          subTasks: args.subTasks || [],
          priority: args.priority,
          requires: args.requires,
          assignTo: args.assignTo,
          group: args.group,
          leaseHours: args.leaseHours,
        })
      );

    case "mesh_task_claim":
    case "mesh_task_renew":
    case "mesh_task_release":
    case "mesh_task_complete":
    case "mesh_task_fail":
    case "mesh_task_cancel": {
      const action = name.replace("mesh_task_", "");
      return text(
        await meshFetch("tasks", "POST", {
          action,
          id: args.id,
          ...ids(),
          commitSha: action === "complete" ? args.commitSha || null : undefined,
          reason: ["fail", "release", "cancel"].includes(action) ? args.reason || (action === "fail" ? "unknown" : undefined) : undefined,
        })
      );
    }

    case "mesh_task_list": {
      const result = await meshFetch("tasks", "POST", {
        action: "list",
        status: args.status || undefined,
        group: args.group || undefined,
        for: args.mine ? AGENT_ID : undefined,
        base: BASE_ID,
      });
      return text(args.full ? result : briefTasks(result));
    }

    case "mesh_version":
      await updates.check(true);
      return text({ ...updates.status(), repo: UPDATE_REPO, instance: AGENT_ID, base: BASE_ID, capabilities: CAPABILITIES });

    case "mesh_announce_update":
      return text(
        await meshFetch("send", "POST", {
          from: AGENT_ID,
          base: BASE_ID,
          to: "*",
          payload: `E:mesh/update version=${args.version || LOCAL_VERSION}`,
        })
      );

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  let result;
  try {
    result = await handleTool(name, rawArgs || {});
  } catch (e) {
    result = { content: [{ type: "text", text: `agent-mesh error: ${e && e.message ? e.message : e}` }], isError: true };
  }
  const notice = updates.notice();
  if (notice && name !== "mesh_version" && Array.isArray(result.content)) {
    result.content.push({ type: "text", text: notice.trim() });
  }
  return result;
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Startup check and registration (so capability-gated claims work), fire-and-forget.
  updates.check(true).catch(() => {});
  meshFetch("agents", "POST", { ...ids(), meta: heartbeatMeta() }).catch(() => {});
}

main().catch(console.error);
