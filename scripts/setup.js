#!/usr/bin/env node
// Self-host tooling: setup | rotate-key | show-config
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawnSync } = require("node:child_process");
const lib = require("./lib");

const REPO_ROOT = path.resolve(__dirname, "..");
const MCP_INDEX = path.join(REPO_ROOT, "mcp-server", "index.js");
const IS_WIN = process.platform === "win32";

const HELP = `agent-mesh self-host tooling

Usage:
  npm run setup       -- [flags]   Deploy your own relay and print MCP config
  npm run rotate-key  -- [flags]   Generate a new key, redeploy, print config
  npm run show-config -- [flags]   Print MCP config for adding another machine

Flags (also read from env in parentheses):
  --project <id>     Firebase project id (MESH_PROJECT)
  --region <region>  Functions region, default us-east1 (MESH_REGION)
  --agent-id <id>    Suggested MESH_AGENT_ID, default agent-1 (MESH_AGENT_ID)
  --yes, -y          Non-interactive: accept defaults, never prompt
  --merge-mcp        Merge the config into ~/.kiro/settings/mcp.json
  --no-merge-mcp     Never offer to merge (default in --yes mode)
  --help, -h         Show this help

The mesh key is generated on this machine, piped to Firebase over stdin, and
never written to any file in this repository.
`;

function run(cmd, args, opts = {}) {
  // shell is needed on Windows for firebase.cmd; all args are validated constants/ids.
  return spawnSync(cmd, args, {
    encoding: "utf8",
    shell: IS_WIN,
    stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : ["inherit", "pipe", "pipe"],
    ...opts,
  });
}

function fail(msg) {
  console.error("Error: " + msg);
  process.exit(1);
}

function ask(rl, q, def) {
  return new Promise((resolve) =>
    rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => resolve(a.trim() || def || ""))
  );
}

function checkFirebase() {
  const v = run("firebase", ["--version"]);
  if (v.status !== 0) fail("Firebase CLI not found. Install it: npm install -g firebase-tools");
  const l = run("firebase", ["login:list"]);
  const out = (l.stdout || "") + (l.stderr || "");
  if (l.status !== 0 || /No authorized accounts/i.test(out)) {
    fail("Firebase CLI is not logged in. Run: firebase login");
  }
}

function enableApis(project) {
  const g = run("gcloud", ["--version"]);
  if (g.status !== 0) {
    console.log("gcloud not found; skipping API enablement (firebase deploy enables most APIs itself).");
    return;
  }
  const apis = [
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "firestore.googleapis.com",
  ];
  console.log("Enabling APIs (best effort)...");
  const r = run("gcloud", ["services", "enable", ...apis, "--project", project]);
  if (r.status !== 0) console.log("Could not enable all APIs automatically; continuing.");
}

function setSecret(project, key) {
  // Key goes over stdin only: never a CLI arg, never a file.
  const r = run(
    "firebase",
    ["functions:secrets:set", "MESH_KEY", "--project", project, "--data-file", "-", "--force"],
    { input: key }
  );
  if (r.status !== 0) fail("Failed to set the MESH_KEY secret:\n" + (r.stderr || "").replace(key, "[redacted]"));
}

function deploy(project, only) {
  console.log(`Deploying (${only}) to ${project}...`);
  const r = spawnSync("firebase", ["deploy", "--only", only, "--project", project], {
    shell: IS_WIN,
    stdio: "inherit",
  });
  if (r.status !== 0) fail("firebase deploy failed.");
}

function writeLocalConfig(project, region) {
  const rc = path.join(REPO_ROOT, ".firebaserc");
  fs.writeFileSync(rc, JSON.stringify({ projects: { default: project } }, null, 2) + "\n");
  // functions/.env is gitignored and holds only the region (no secrets).
  fs.writeFileSync(path.join(REPO_ROOT, "functions", ".env"), `MESH_REGION=${region}\n`);
}

function printConfig(project, region, key, agentId) {
  const block = lib.buildConfigBlock({
    url: lib.meshUrl(project, region),
    key,
    agentId,
    indexPath: MCP_INDEX,
  });
  console.log("\nPaste this into each agent's MCP config (use a unique MESH_AGENT_ID per agent).");
  console.log("It contains your key: keep it private.\n");
  console.log(block + "\n");
}

function mergeMcp(project, region, key, agentId) {
  const target = path.join(os.homedir(), ".kiro", "settings", "mcp.json");
  lib.assertOutsideRepo(target, REPO_ROOT);
  let cfg = {};
  if (fs.existsSync(target)) {
    try {
      cfg = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch {
      fail(`${target} is not valid JSON; not modifying it.`);
    }
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers["agent-mesh"] = lib.buildServerEntry({
    url: lib.meshUrl(project, region),
    key,
    agentId,
    indexPath: MCP_INDEX,
  });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`Merged agent-mesh into ${target}`);
}

function readRcProject() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".firebaserc"), "utf8")).projects.default;
  } catch {
    return "";
  }
}

async function resolveInputs(flags, yes) {
  let project = flags.project || process.env.MESH_PROJECT || "";
  let region = flags.region || process.env.MESH_REGION || "";
  let agentId = flags["agent-id"] || process.env.MESH_AGENT_ID || "";
  const rcProject = readRcProject();
  const needPrompt = !yes && (!project || !region);
  if (needPrompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!project) project = await ask(rl, "Firebase project id", rcProject && rcProject !== "your-project-id" ? rcProject : "");
    if (!region) region = await ask(rl, "Region", "us-east1");
    if (!agentId) agentId = await ask(rl, "Suggested MESH_AGENT_ID", "agent-1");
    rl.close();
  }
  if (!project && yes && rcProject && rcProject !== "your-project-id") project = rcProject;
  region = region || "us-east1";
  agentId = agentId || "agent-1";
  if (!lib.isValidProject(project)) fail("A valid --project <firebase-project-id> is required.");
  if (!lib.isValidRegion(region)) fail(`Invalid region: ${region}`);
  if (!lib.isValidAgentId(agentId)) fail(`Invalid agent id: ${agentId}`);
  return { project, region, agentId };
}

async function maybeMerge(flags, yes, project, region, key, agentId) {
  let doMerge = false;
  if (flags["merge-mcp"]) doMerge = true;
  else if (flags["no-merge-mcp"] || yes) doMerge = false;
  else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await ask(rl, "Merge into ~/.kiro/settings/mcp.json? (y/N)", "n");
    rl.close();
    doMerge = /^y/i.test(a);
  }
  if (doMerge) mergeMcp(project, region, key, agentId);
}

async function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  const f = args.flags;
  if (f.help || f.h || args._[0] === "help" || args._.length === 0) {
    console.log(HELP);
    return;
  }
  const yes = Boolean(f.yes || f.y);
  const cmd = args._[0];
  if (!["setup", "rotate-key", "show-config"].includes(cmd)) fail(`Unknown command: ${cmd}\n\n${HELP}`);

  checkFirebase();
  const { project, region, agentId } = await resolveInputs(f, yes);

  if (cmd === "show-config") {
    const r = run("firebase", ["functions:secrets:access", "MESH_KEY", "--project", project]);
    const key = (r.stdout || "").trim();
    if (r.status !== 0 || !key) fail("Could not read the MESH_KEY secret. Has setup been run for this project?");
    printConfig(project, region, key, agentId);
    await maybeMerge(f, yes, project, region, key, agentId);
    return;
  }

  const key = lib.generateKey();
  if (cmd === "setup") {
    writeLocalConfig(project, region);
    enableApis(project);
  } else if (f.region || process.env.MESH_REGION) {
    writeLocalConfig(project, region);
  }
  setSecret(project, key);
  deploy(project, cmd === "setup" ? "functions,firestore" : "functions");
  printConfig(project, region, key, agentId);
  if (cmd === "rotate-key") {
    console.warn(
      "WARNING: the old key no longer works. Every agent must update MESH_KEY in its MCP config and restart.\n"
    );
  }
  await maybeMerge(f, yes, project, region, key, agentId);
}

if (require.main === module) {
  main().catch((e) => fail(e.message));
}
