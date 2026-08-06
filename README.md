# Agent Mesh

Cross-device, cross-session messaging relay for AI coding agents. Enables multiple Kiro (or other MCP-compatible agent) instances to communicate with each other in real-time via a shared message bus.

## Architecture

```
┌─────────────┐     ┌─────────────────────────┐     ┌─────────────┐
│ Kiro (PC)   │────▶│  Firebase Cloud Functions │◀────│ Kiro (Laptop)│
│ MCP Client  │◀────│  + Firestore message bus  │────▶│ MCP Client   │
└─────────────┘     └─────────────────────────┘     └─────────────┘
```

- **Relay**: Firebase Cloud Functions (Node 20) in `us-east1`
- **Storage**: Firestore collection for message queue
- **Auth**: Shared API key in `x-mesh-key` header
- **Transport**: MCP server over stdio (one per Kiro instance)

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/send` | POST | Send message to a specific agent or broadcast |
| `/poll` | GET | Retrieve unread messages for an agent |
| `/ack` | POST | Delete acknowledged messages |
| `/agents` | GET/POST | List agents or register/heartbeat |

## MCP Server Setup (per device)

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
cd mcp-server
npm install
```

### Configure in Kiro

Add to your `.kiro/settings/mcp.json` (workspace or user level):

```json
{
  "mcpServers": {
    "agent-mesh": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO>/agent-mesh/mcp-server/index.js"],
      "env": {
        "MESH_AGENT_ID": "agent-b",
        "MESH_KEY": "REDACTED",
        "MESH_URL": "https://your-project-id.cloudfunctions.net"
      }
    }
  }
}
```

**Important**: Set a unique `MESH_AGENT_ID` per device:
- Desktop: `"MESH_AGENT_ID": "agent-a"`
- Laptop: `"MESH_AGENT_ID": "agent-b"`
- CI: `"MESH_AGENT_ID": "kiro-ci"`

### Available Tools

| Tool | Description |
|------|-------------|
| `mesh_send` | Send a message to another agent (by ID or `*` for broadcast) |
| `mesh_poll` | Check for new messages addressed to this agent |
| `mesh_agents` | List all registered agents on the mesh |
| `mesh_heartbeat` | Register this agent and report status |

## Mesh Protocol Notation

Agents communicate using a compact structured notation for efficiency:

```
Q:<category>/<topic> <payload>     -- Question
R:<msg_id> <payload>               -- Response
C:<category>/<topic> <payload>     -- Command/instruction
S:<key>=<value>[;<key>=<value>]    -- State/config share
E:<event_type> <payload>           -- Event notification
```

### Examples

```
Q:config/git user.name;user.email;credential.helper
R:abc123 S:user.name=hinch;user.email=user@example.com;credential.helper=manager

C:exec/cmd git config --list | grep user
R:def456 user.name=hinch\nuser.email=user@example.com

E:build/complete branch=internal-testing;status=success;sha=46d5b20
```

## Deploy (Firebase Functions)

```bash
cd functions
npm install
firebase deploy --only functions,firestore
```

## Auth Key

All requests require header: `x-mesh-key: REDACTED`

## License

Private - internal tooling.
