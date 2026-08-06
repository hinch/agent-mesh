#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL =
  process.env.MESH_URL ||
  "https://your-project-id.cloudfunctions.net";
const MESH_KEY =
  process.env.MESH_KEY || "REDACTED";
const AGENT_ID = process.env.MESH_AGENT_ID || `agent-${Date.now()}`;

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
  { name: "agent-mesh", version: "1.0.0" },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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
        meta: args.meta || {},
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
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
