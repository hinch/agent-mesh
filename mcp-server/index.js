#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { createUpdateChecker, DEFAULT_UPDATE_REPO } from "./version.js";

const LOCAL_VERSION = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
).version;
const UPDATE_REPO = process.env.MESH_UPDATE_REPO || DEFAULT_UPDATE_REPO;
const updates = createUpdateChecker({ localVersion: LOCAL_VERSION, repo: UPDATE_REPO });

const BASE_URL = (process.env.MESH_URL || "").replace(/\/+$/, "");
const MESH_KEY = process.env.MESH_KEY || "";
const AGENT_ID = process.env.MESH_AGENT_ID || `agent-${Date.now()}`;

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
async function meshFetch(endpoint, method, body) {
  const opts = {
    method,
    headers: {
      "x-mesh-key": MESH_KEY,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}/${endpoint}`, opts);
  return res.json();
}

const server = new Server(
  { name: "agent-mesh", version: LOCAL_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mesh_send",
      description:
        "Send a message to another agent on the mesh. Use structured compact notation for efficiency.",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              'Target agent ID or "*" for broadcast to all agents',
          },
          payload: {
            type: "string",
            description:
              "Message content. Use mesh protocol notation for efficiency.",
          },
          replyTo: {
            type: "string",
            description: "Optional message ID this is replying to",
          },
        },
        required: ["to", "payload"],
      },
    },
    {
      name: "mesh_poll",
      description:
        "Check for new messages addressed to this agent. Call periodically during conversations.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "mesh_agents",
      description: "List all agents currently registered on the mesh.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "mesh_heartbeat",
      description:
        "Register this agent on the mesh and send a heartbeat with metadata.",
      inputSchema: {
        type: "object",
        properties: {
          meta: {
            type: "object",
            description:
              "Optional metadata about this agent (device, project, capabilities)",
          },
        },
      },
    },
    {
      name: "mesh_task_publish",
      description:
        "Publish a task to the mesh for any idle agent to pick up. Include repo URL, branch, spec path, and task details.",
      inputSchema: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Git repo URL (https://github.com/...)",
          },
          branch: { type: "string", description: "Branch to work on" },
          specPath: {
            type: "string",
            description: "Path to spec tasks.md relative to repo root",
          },
          taskId: { type: "string", description: "Task ID from the spec" },
          taskText: {
            type: "string",
            description: "Full task description text",
          },
          subTasks: {
            type: "array",
            items: { type: "string" },
            description: "Sub-task descriptions",
          },
        },
        required: ["repo", "taskId", "taskText"],
      },
    },
    {
      name: "mesh_task_claim",
      description:
        "Claim an open task from the mesh. Uses atomic transaction to prevent double-claim.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Mesh task document ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "mesh_task_complete",
      description: "Mark a claimed task as completed with the commit SHA.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Mesh task document ID" },
          commitSha: {
            type: "string",
            description: "Git commit SHA of the completed work",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "mesh_task_fail",
      description: "Mark a claimed task as failed with a reason.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Mesh task document ID" },
          reason: { type: "string", description: "Why the task failed" },
        },
        required: ["id"],
      },
    },
    {
      name: "mesh_task_list",
      description:
        "List tasks on the mesh. Optionally filter by status (open, claimed, completed, failed).",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Filter by status: open, claimed, completed, failed. Omit for all.",
          },
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
          version: { type: "string", description: "Version being announced (defaults to local version)" },
        },
      },
    },
  ],
}));

async function handleTool(name, args) {

  switch (name) {
    case "mesh_send": {
      const result = await meshFetch("send", "POST", {
        from: AGENT_ID,
        to: args.to,
        payload: args.payload,
        replyTo: args.replyTo,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "mesh_poll": {
      const result = await meshFetch(
        `poll?agent=${encodeURIComponent(AGENT_ID)}`,
        "GET"
      );
      // An E:mesh/update announcement only triggers a re-check; GitHub is the source of truth.
      if (
        result &&
        Array.isArray(result.messages) &&
        result.messages.some((m) => typeof m.payload === "string" && m.payload.startsWith("E:mesh/update"))
      ) {
        await updates.check(true);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "mesh_agents": {
      const result = await meshFetch("agents", "GET");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "mesh_heartbeat": {
      const result = await meshFetch("agents", "POST", {
        agent: AGENT_ID,
        meta: { ...(args.meta || {}), mcpVersion: LOCAL_VERSION },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "mesh_task_publish": {
      const result = await meshFetch("tasks", "POST", {
        action: "publish",
        from: AGENT_ID,
        repo: args.repo,
        branch: args.branch || "internal-testing",
        specPath: args.specPath || null,
        taskId: args.taskId,
        taskText: args.taskText,
        subTasks: args.subTasks || [],
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "mesh_task_claim": {
      const result = await meshFetch("tasks", "POST", {
        action: "claim",
        id: args.id,
        agent: AGENT_ID,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "mesh_task_complete": {
      const result = await meshFetch("tasks", "POST", {
        action: "complete",
        id: args.id,
        agent: AGENT_ID,
        commitSha: args.commitSha || null,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "mesh_task_fail": {
      const result = await meshFetch("tasks", "POST", {
        action: "fail",
        id: args.id,
        agent: AGENT_ID,
        reason: args.reason || "unknown",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "mesh_task_list": {
      const result = await meshFetch("tasks", "POST", {
        action: "list",
        status: args.status || undefined,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    case "mesh_version": {
      await updates.check(true);
      return {
        content: [{ type: "text", text: JSON.stringify({ ...updates.status(), repo: UPDATE_REPO }) }],
      };
    }

    case "mesh_announce_update": {
      const result = await meshFetch("send", "POST", {
        from: AGENT_ID,
        to: "*",
        payload: `E:mesh/update version=${args.version || LOCAL_VERSION}`,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const result = await handleTool(name, rawArgs || {});
  const notice = updates.notice();
  if (notice && name !== "mesh_version" && Array.isArray(result.content)) {
    result.content.push({ type: "text", text: notice.trim() });
  }
  return result;
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Startup check, fire-and-forget; failures are silent.
  updates.check(true).catch(() => {});
}

main().catch(console.error);
