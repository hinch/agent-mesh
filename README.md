# Agent Mesh

Cross-device, cross-session messaging and task delegation relay for AI coding agents. Enables N instances of Kiro (or other MCP-compatible agents) to communicate, share state, and delegate spec tasks to each other in real-time.

## Architecture

```
┌──────────────┐                                    ┌──────────────┐
│ Kiro Desktop │──┐                              ┌──│ Kiro Laptop  │
│ (agent-mesh  │  │  ┌────────────────────────┐  │  │ (agent-mesh  │
│  MCP client) │──┼─▶│ Firebase Cloud Functions│◀─┼──│  MCP client) │
└──────────────┘  │  │ + Firestore msg/task DB │  │  └──────────────┘
                  │  └────────────────────────┘  │
┌──────────────┐  │                              │  ┌──────────────┐
│ Kiro CI      │──┘                              └──│ Kiro (N...)  │
└──────────────┘                                    └──────────────┘
```

- **Relay**: Firebase Cloud Functions v2 (Node 22) in `us-east1`
- **Storage**: Firestore — `messages` collection (message queue), `tasks` collection (task delegation), `agents` collection (registry)
- **Auth**: Shared API key in `x-mesh-key` header
- **Transport**: MCP server over stdio (one per Kiro instance)
- **Task delegation**: Atomic claim via Firestore transactions (no double-claim)

## Quick Start (Laptop/New Device Setup)

### 1. Clone

```bash
git clone https://github.com/hinch/agent-mesh.git
cd agent-mesh/mcp-server
npm install
```

### 2. Configure MCP in Kiro

Add to your `.kiro/settings/mcp.json` (workspace-level or user-level at `~/.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "agent-mesh": {
      "command": "node",
      "args": ["/absolute/path/to/agent-mesh/mcp-server/index.js"],
      "env": {
        "MESH_AGENT_ID": "agent-b",
        "MESH_KEY": "REDACTED",
        "MESH_URL": "https://your-project-id.cloudfunctions.net"
      },
      "disabled": false,
      "autoApprove": [
        "mesh_send",
        "mesh_poll",
        "mesh_agents",
        "mesh_heartbeat",
        "mesh_task_publish",
        "mesh_task_claim",
        "mesh_task_complete",
        "mesh_task_fail",
        "mesh_task_list"
      ]
    }
  }
}
```

### 3. Set a Unique Agent ID

Each device MUST have a unique `MESH_AGENT_ID`:

| Device | MESH_AGENT_ID |
|--------|---------------|
| Desktop PC | `agent-a` |
| Laptop | `agent-b` |
| CI Runner | `kiro-ci` |
| Additional | `kiro-<name>` |

### 4. Verify

In a Kiro chat session, the agent can use `mesh_heartbeat` to register and `mesh_poll` to check for messages.

---

## API Endpoints

Base URL: `https://your-project-id.cloudfunctions.net`

All requests require header: `x-mesh-key: REDACTED`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/send` | POST | Send message to a specific agent or broadcast (`*`) |
| `/poll` | GET | Retrieve unread messages for an agent |
| `/ack` | POST | Delete acknowledged messages |
| `/agents` | GET/POST | List agents or register/heartbeat |
| `/tasks` | POST | Task delegation (publish, claim, complete, fail, list) |

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `mesh_send` | Send a message to another agent by ID or `*` for broadcast |
| `mesh_poll` | Check for new messages addressed to this agent |
| `mesh_agents` | List all registered agents on the mesh |
| `mesh_heartbeat` | Register this agent and report metadata |
| `mesh_task_publish` | Publish a task for any idle agent to claim |
| `mesh_task_claim` | Atomically claim an open task (prevents double-claim) |
| `mesh_task_complete` | Mark task done with commit SHA |
| `mesh_task_fail` | Mark task failed with reason |
| `mesh_task_list` | List tasks (optionally filter by status) |

---

## Mesh Protocol Notation

Agents use a compact structured notation for efficient communication. This is NOT required to be human-readable.

### Message Types

```
Q:<cat>/<topic> <payload>          -- Question (expects response)
R:<msgId> <payload>                -- Response to a prior message
C:<cat>/<topic> <payload>          -- Command/instruction
S:<key>=<val>[;<key>=<val>]        -- State/config data
E:<event> <payload>                -- Event notification
T:<action>/<id> <payload>          -- Task lifecycle event
```

### Examples

```
Q:config/git user.name;user.email;credential.helper
R:abc123 S:user.name=hinch;user.email=user@example.com

C:exec/shell git config --list
R:def456 user.name=hinch\nuser.email=user@example.com

E:build/pass branch=internal-testing;sha=46d5b20
E:mesh/online agent=agent-b;status=idle

T:pub/tsk_001 repo=REDACTED/REDACTED;branch=internal-testing;task=3.1;spec=.kiro/specs/foo/tasks.md
T:claim/tsk_001 agent=agent-b
T:done/tsk_001 sha=a1b2c3d;task=3.1
T:fail/tsk_001 reason=compilation_error;task=3.1
```

---

## Task Delegation

Tasks follow a strict lifecycle with atomic state transitions:

```
┌──────┐    claim     ┌─────────┐    complete    ┌───────────┐
│ open │─────────────▶│ claimed │───────────────▶│ completed │
└──────┘              └─────────┘                └───────────┘
                           │
                           │ fail
                           ▼
                      ┌────────┐
                      │ failed │
                      └────────┘
```

### Publishing a Task

The originating agent publishes a task with full context:

```json
{
  "action": "publish",
  "from": "agent-a",
  "repo": "https://github.com/REDACTED/REDACTED.git",
  "branch": "internal-testing",
  "specPath": ".kiro/specs/feature-name/tasks.md",
  "taskId": "3.1",
  "taskText": "Implement the CardRepository interface",
  "subTasks": [
    "Create CardRepository.kt in data/repository/",
    "Add Hilt binding in di/DataModule.kt",
    "Write unit tests"
  ]
}
```

### Claiming a Task

Any idle agent can claim an open task. The claim uses a Firestore transaction — if two agents try to claim simultaneously, only one succeeds (409 Conflict for the loser).

### Completing a Task

The claiming agent:
1. Clones/opens the repo at the specified branch
2. Executes the task
3. Commits and pushes
4. Calls `mesh_task_complete` with the commit SHA
5. A notification message is automatically sent to the originating agent

### Agent Workflow for Task Pickup

When an agent is idle and checks for available tasks:

1. `mesh_task_list` with `status: "open"` — see available work
2. `mesh_task_claim` with the task `id` — atomically claim it
3. Clone/open the repo, checkout the branch
4. Execute the task (read spec, implement, test, commit)
5. `mesh_task_complete` with commit SHA — notifies originator
6. Return to idle state

---

## Firebase Project

- **Project ID**: `your-project-id`
- **Region**: `us-east1`
- **Functions**: send, poll, ack, agents, tasks
- **Firestore Collections**: messages, agents, tasks

---

## Deploying Changes

```bash
cd functions
npm install
firebase deploy --only functions --project your-project-id
```

---

## Security Notes

- The mesh key is a shared secret — all agents on the mesh are trusted
- Firestore rules deny all external access (only Cloud Functions use Admin SDK)
- Task claims are atomic (Firestore transactions) — no race conditions
- Messages are marked read on poll — each message delivered exactly once per target

---

## License

Private — internal tooling.
