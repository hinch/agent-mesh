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

### 2. Clone and point at your project

```bash
git clone <this-repo-url> agent-mesh
cd agent-mesh
cp .firebaserc.example .firebaserc
```

Edit `.firebaserc` and replace `your-project-id` with your Firebase project ID. `.firebaserc` is gitignored so your project ID stays out of version control.

### 3. Generate and store your mesh key

Generate a long random key and store it as a secret. Do not put it in any file in this repo.

```bash
# Example: generate 32 random bytes as hex
node -e "console.log('msh_' + require('crypto').randomBytes(32).toString('hex'))"

# Store it in Secret Manager (you will be prompted for the value)
firebase functions:secrets:set MESH_KEY
```

### 4. Deploy

```bash
cd functions
npm install
cd ..
firebase deploy --only functions,firestore
```

Optional: to deploy to a different region, create `functions/.env` containing `MESH_REGION=<region>` before deploying. The default is `us-east1`.

After deployment, your base URL is:

```
https://<region>-<your-project-id>.cloudfunctions.net
```

### 5. Configure each agent (MCP)

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

Each agent needs a unique `MESH_AGENT_ID` (for example `agent-1`, `agent-2`, `ci-runner`).

### 6. Verify

From an agent, call `mesh_heartbeat` to register, then `mesh_agents` to list registered agents and `mesh_poll` to check for messages.

## Key rotation

Rotate the key if it may have been exposed, and periodically as routine hygiene.

```bash
# 1. Generate a new key and set it as a new secret version
node -e "console.log('msh_' + require('crypto').randomBytes(32).toString('hex'))"
firebase functions:secrets:set MESH_KEY

# 2. Redeploy so the functions pick up the new version
firebase deploy --only functions

# 3. Optionally destroy old versions
firebase functions:secrets:destroy MESH_KEY@<old-version>
```

Then update `MESH_KEY` in every agent's MCP config and restart the agents. Until they are updated, they will receive `401` responses.

## API endpoints

All requests require the header `x-mesh-key: <your-mesh-key>`.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/send` | POST | Send a message to a specific agent or broadcast (`*`) |
| `/poll` | GET | Retrieve unread messages for an agent |
| `/ack` | POST | Delete acknowledged messages |
| `/agents` | GET/POST | List agents or register/heartbeat |
| `/tasks` | POST | Task delegation (publish, claim, complete, fail, list) |

## MCP tools

| Tool | Description |
|------|-------------|
| `mesh_send` | Send a message to another agent by ID or `*` for broadcast |
| `mesh_poll` | Check for new messages addressed to this agent |
| `mesh_agents` | List all registered agents on the mesh |
| `mesh_heartbeat` | Register this agent and report metadata |
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

No license has been specified yet. Add a `LICENSE` file before reusing or redistributing.
