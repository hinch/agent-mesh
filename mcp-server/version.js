// Version helpers and update checker for the agent-mesh MCP server.
// All network failures are swallowed: update checks must never break tool calls.

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_UPDATE_REPO = "hinch/agent-mesh";
const TIMEOUT_MS = 4000;

/** Parse "v1.2.3" / "1.2.3-abc" into [1,2,3]; returns null if not parseable. */
export function parseVersion(v) {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Returns -1, 0, 1 (a<b, equal, a>b) or null if either is unparseable. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Valid "owner/name" repo slug only (guards URL construction). */
export function isValidRepo(repo) {
  return typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo);
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-mesh-mcp" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Highest version among GitHub tags, falling back to raw package.json. */
export async function fetchLatestVersion(repo, fetchImpl = fetch) {
  if (!isValidRepo(repo)) return null;
  try {
    const tags = await getJson(`https://api.github.com/repos/${repo}/tags?per_page=100`, fetchImpl);
    let best = null;
    for (const t of Array.isArray(tags) ? tags : []) {
      if (parseVersion(t && t.name) && (best === null || compareVersions(t.name, best) === 1)) {
        best = t.name;
      }
    }
    if (best) return parseVersion(best).join(".");
  } catch {
    // fall through to raw package.json
  }
  try {
    const pkg = await getJson(
      `https://raw.githubusercontent.com/${repo}/HEAD/mcp-server/package.json`,
      fetchImpl
    );
    if (parseVersion(pkg && pkg.version)) return parseVersion(pkg.version).join(".");
  } catch {
    // silent
  }
  return null;
}

export function createUpdateChecker({ localVersion, repo, fetchImpl = fetch, now = Date.now }) {
  let latest = null;
  let lastCheck = 0;
  let inflight = null;

  async function check(force = false) {
    if (!force && lastCheck && now() - lastCheck < CHECK_INTERVAL_MS) return latest;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const v = await fetchLatestVersion(repo, fetchImpl);
        if (v) latest = v;
      } catch {
        // silent
      } finally {
        lastCheck = now();
        inflight = null;
      }
      return latest;
    })();
    return inflight;
  }

  function status() {
    const cmp = latest ? compareVersions(localVersion, latest) : null;
    return {
      local: localVersion,
      latest,
      updateAvailable: cmp === -1,
      state: latest === null ? "unknown" : cmp === -1 ? "behind" : "up-to-date",
    };
  }

  function notice() {
    const s = status();
    if (!s.updateAvailable) return "";
    return (
      `\n[agent-mesh] update available ${s.local} -> ${s.latest}: run ` +
      "`git pull && npm install` in the agent-mesh repo (and in mcp-server), then restart the MCP server."
    );
  }

  return { check, status, notice };
}
