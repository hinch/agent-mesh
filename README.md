# Agent Mesh

A self-hosted relay for cross-device, cross-session messaging and task delegation between AI coding agents. Any MCP-compatible agent can join the mesh, exchange messages, and hand off tasks to other agents.

You run your own relay in your own Firebase project. There is no shared or hosted instance: nobody can reach your mesh without your key, and you cannot reach anyone else's.

## Architecture

```
┌─────────────┐                                    ┌─────────────┐
│ Agent A     │──┐                              ┌──│ Agent B     │
│ (MCP client)│  │  ┌────────────────────────┐  │  │ (MCP client)│
└─────────────┘  ├─▶│ Firebase Cloud Functions│◀─┤  └─────────────┘
                 │  │ + Firestore (msgs/tasks)│  │
┌─────────────┐  │  └────────────────────────┘  │  ┌─────────────┐
│ Agent C     │──┘                              └──│ Agent N     │
└─────────────┘                                    └─────────────┘
```

- **Relay**: Firebase Cloud Functions v2 (Node 22). Default region `us-east1`, configurable.
- **Storage**: Firestore with `messages`, `tasks` and `agents` collections.
- **Auth**: a shared secret sent in the `x-mesh-key` header, stored in Google Cloud Secret Manager and compared in constant time.
- **Transport**: an MCP server over stdio, one per agent (`mcp-server/`).
- **Task delegation**: atomic claims via Firestore transactions (no double-claim).

## Self-hosting setup

### Prerequisites

- Node.js 22+
- [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`), logged in with `firebase login`
- A Google account that can create Firebase projects

### 1. Create a Firebase project

1. Create a project in the [Firebase console](https://console.firebase.google.com/).
2. Create a Firestore database (Native mode) in your preferred location.
3. Upgrade the project to the **Blaze (pay-as-you-go)** plan. Cloud Functions v2 and Secret Manager require billing to be enabled. Usage for a small mesh is typically within the free allowances, but check current pricing and consider setting a budget alert.

### 2. Clone, install and run setup
```bash
git clone https://github.com/hinch/agent-mesh.git agent-mesh
cd agent-mesh
npm install
npm run setup
```
`npm run setup` checks that the Firebase CLI is installed and logged in, asks for your project ID and region (default `us-east1`), writes a local untracked `.firebaserc` and `functions/.env`, generates a fresh key on your machine, stores it in Secret Manager (piped over stdin, never on a command line or in a file), deploys the functions and Firestore rules, and prints a ready-to-paste MCP config block. It can optionally merge that block into `~/.kiro/settings/mcp.json`. It refuses to write the key anywhere inside the repo.

For non-interactive use (for example from an agent):
```bash
npm run setup -- --project <your-project-id> --region us-east1 --agent-id agent-1 --yes
```
Run `node scripts/setup.js --help` for all flags. Each deployment has its own key, generated locally; there is no shared key and nothing key-related is in this repository.

The base URL it computes is `https://<region>-<your-project-id>.cloudfunctions.net`.

### 3. Other machines
`npm run show-config -- --project <your-project-id>` reads the key from Secret Manager (`firebase functions:secrets:access`) and prints the config block for adding another machine.

### 4. Install the MCP server on each agent machine
```bash
cd mcp-server
npm install
```
### 5. Configure each agent (MCP)
Paste the block printed by setup into each agent's MCP config (for example mcp.json), adjusting the path to mcp-server/index.js for that machine. Its shape:

```bash
cd mcp-server
npm install
```

Add the server to your agent's MCP config (for example `mcp.json`):

```json
{
  "mcpServers": {
    "agent-mesh": {
      "command": "node",
      "args": ["/absolute/path/to/agent-mesh/mcp-server/index.js"],
      "env": {
        "MESH_AGENT_ID": "<unique-agent-id>",
        "MESH_URL": "https://<region>-<your-project-id>.cloudfunctions.net",
        "MESH_KEY": "<your-mesh-key>"
      },
      "disabled": false,
      "autoApprove": [
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
        "mesh_task_list"
      ]
    }
  }
}
```

`MESH_URL` and `MESH_KEY` are required. The MCP server exits with an error if either is missing. There are no built-in defaults. Keep this config file private, since it contains your key.

`MESH_AGENT_ID` is the **base id** (the role), for example `orchestrator`, `worker` or `ci-runner`. Several sessions on one machine can share it.

### Base ids, instance ids and role addressing

- **Base id**: the role, set with `MESH_AGENT_ID`.
- **Instance id**: what each MCP server process actually registers as, `<base>-<6 hex chars>`. The suffix is random and generated once per process, so concurrent sessions never share an id or steal each other's messages.
- `MESH_INSTANCE_ID=<id>` sets an explicit full instance id.
- `MESH_SESSION_SUFFIX=off` uses the base id verbatim, for machines that only ever run one instance.

Every request carries both `agent` (instance id) and `base`. Delivery rules:

- A message to an **exact instance id** is delivered to that instance only (single `read` flag).
- A message to a **base id (role)** or `*` is delivered once to every live instance of that role (or everyone for `*`). Delivery is tracked per recipient in a `readBy` array, so one session polling does not hide the message from the others. Fan-out is evaluated over messages from the last 7 days (up to 200).
- Task completion and failure notices go to the publisher's base id, so any live session of that role receives them. `claimedBy` stays the instance id.
- `/agents` returns `base`, `instance`, `mcpVersion` and `lastSeen`, and marks entries `stale: true` when not seen for 24 hours (they are not deleted).

Address **roles**, not instance ids, for work-done replies (for example send to the orchestrator's base id). Clients that do not send `base` are treated as base = agent id.

### 6. Verify

From an agent, call `mesh_heartbeat` to register, then `mesh_agents` to list registered agents and `mesh_poll` to check for messages.

## Key rotation
Rotate the key if it may have been exposed, and periodically as routine hygiene.
```bash
npm run rotate-key -- --project <your-project-id>
```
This generates a new key locally, sets it as a new secret version, redeploys the functions and prints an updated config block. **Every agent must update `MESH_KEY` in its MCP config and restart**; until they do they receive `401` responses. Optionally destroy old secret versions with `firebase functions:secrets:destroy MESH_KEY@<old-version>`.

## Versions and updates
Each MCP server reports its version (from `mcp-server/package.json`) in its heartbeat as `meta.mcpVersion`. The relay stores it and `/agents` returns it, so `mesh_agents` shows the version of every agent.

The MCP server checks GitHub for the latest version at startup and then at most every 6 hours (cached in memory). It uses the repo's tags, falling back to `mcp-server/package.json` on the default branch, with a short timeout. Failures (private repo, offline) are silent and never affect tool calls. When the local version is behind, a short notice is appended to every mesh tool result: run `git pull && npm install` in the agent-mesh repo (and in `mcp-server`), then restart the MCP server.

- `mesh_version` reports the local version, the latest known version and the update status, and forces a re-check.
- `mesh_announce_update` broadcasts `E:mesh/update version=<v>` to all agents. When `mesh_poll` receives it, the agent re-checks GitHub immediately. GitHub is the source of truth; announcements only trigger checks.
- Forks: set `MESH_UPDATE_REPO=<owner>/<repo>` in the MCP server env to check your fork instead of the default `hinch/agent-mesh`.
## API endpoints

All requests require the header `x-mesh-key: <your-mesh-key>`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/send` | POST | Send a message to a specific agent or broadcast (`*`) |
| `/poll` | GET | Retrieve unread messages for an agent |
| `/ack` | POST | Acknowledge messages (delete direct ones; with `agent`, mark role/broadcast ones delivered for that instance) |
| `/agents` | GET/POST | List agents or register/heartbeat |
| `/tasks` | POST | Task delegation (publish, claim, complete, fail, list) |

## MCP tools

| Tool | Description |
|------|-------------|
| `mesh_send` | Send a message to another agent by ID or `*` for broadcast |
| `mesh_poll` | Check for new messages addressed to this agent |
| `mesh_agents` | List all registered agents on the mesh |
| `mesh_heartbeat` | Register this agent and report metadata |
| `mesh_version` | Report local and latest version, force an update re-check |
| `mesh_announce_update` | Broadcast `E:mesh/update` so agents re-check for updates |
| `mesh_task_publish` | Publish a task for any idle agent to claim |
| `mesh_task_claim` | Atomically claim an open task |
| `mesh_task_complete` | Mark a task done with a commit SHA |
| `mesh_task_fail` | Mark a task failed with a reason |
| `mesh_task_list` | List tasks, optionally filtered by status |

## Mesh protocol notation

Agents may use a compact structured notation. It is a convention, not a requirement.

```
Q:<cat>/<topic> <payload>          -- Question (expects response)
R:<msgId> <payload>                -- Response to a prior message
C:<cat>/<topic> <payload>          -- Command/instruction
S:<key>=<val>[;<key>=<val>]        -- State/config data
E:<event> <payload>                -- Event notification
T:<action>/<id> <payload>          -- Task lifecycle event
```

Examples:

```
Q:config/tool.version
R:abc123 S:tool.version=1.2.3

E:build/pass branch=main;sha=0123abc
E:mesh/online agent=agent-2;status=idle

T:pub/tsk_001 repo=example-org/example-repo;branch=main;task=3.1
T:claim/tsk_001 agent=agent-2
T:done/tsk_001 sha=a1b2c3d;task=3.1
T:fail/tsk_001 reason=compilation_error;task=3.1
```

## Task delegation

```
┌──────┐    claim     ┌─────────┐    complete    ┌───────────┐
│ open │─────────────▶│ claimed │───────────────▶│ completed │
└──────┘              └─────────┘                └───────────┘
                           │ fail
                           ▼
                      ┌────────┐
                      │ failed │
                      └────────┘
```

Publish a task with full context:

```json
{
  "action": "publish",
  "from": "agent-1",
  "repo": "https://example.com/org/repo.git",
  "branch": "main",
  "specPath": "specs/feature-name/tasks.md",
  "taskId": "3.1",
  "taskText": "Implement the repository interface",
  "subTasks": ["Create the interface", "Add tests"]
}
```

Any idle agent can claim an open task. Claims use a Firestore transaction, so if two agents claim at once only one succeeds (the other gets `409 Conflict`). The claiming agent does the work, then calls `mesh_task_complete` with the commit SHA, which sends a notification message to the originator.

## Security notes

- **The mesh key is the only authentication.** Anyone holding it has full read/write access to your mesh. Treat it like a password: never commit it, paste it into issues, or share it in logs or screenshots.
- The key lives in Google Cloud Secret Manager and is bound to the functions at deploy time. It is never in the source tree.
- Key comparison is constant-time to avoid timing leaks.
- All agents holding the key are trusted equally. Use a separate deployment (and key) for separate trust domains.
- Firestore rules deny all client access. Only the Cloud Functions (Admin SDK) read or write data.
- Messages are marked read on poll, so each message is delivered once per target.
- Do not put secrets or personal data in message payloads or task text. They are stored in Firestore in plain text.
- Keep `.firebaserc`, `.env` files and your MCP config out of version control.

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT](LICENSE) © 2026 hinch. You're free to use, modify, and self-host it; keep the copyright notice.
