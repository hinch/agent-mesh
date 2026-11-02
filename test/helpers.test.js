"use strict";
const test = require("node:test");
const assert = require("node:assert");
const lib = require("../scripts/lib");

test("generateKey format and uniqueness", () => {
  const a = lib.generateKey();
  const b = lib.generateKey();
  assert.match(a, /^msh_[A-Za-z0-9_-]{43}$/);
  assert.notStrictEqual(a, b);
});

test("assertOutsideRepo", () => {
  const root = require("node:path").resolve(__dirname, "..");
  assert.throws(() => lib.assertOutsideRepo(require("node:path").join(root, "x.json"), root));
  assert.doesNotThrow(() => lib.assertOutsideRepo(require("node:os").homedir(), root));
});

test("validators and url", () => {
  assert.ok(lib.isValidProject("my-proj-123"));
  assert.ok(!lib.isValidProject("a; rm -rf"));
  assert.ok(lib.isValidRegion("us-east1"));
  assert.ok(!lib.isValidRegion("us east"));
  assert.strictEqual(lib.meshUrl("p-1234", "us-east1"), "https://us-east1-p-1234.cloudfunctions.net");
});

test("parseArgs", () => {
  const a = lib.parseArgs(["setup", "--project", "p", "--yes", "--region=r"]);
  assert.deepStrictEqual(a._, ["setup"]);
  assert.strictEqual(a.flags.project, "p");
  assert.strictEqual(a.flags.yes, true);
  assert.strictEqual(a.flags.region, "r");
});

test("version comparison", async () => {
  const v = await import("../mcp-server/version.js");
  assert.strictEqual(v.compareVersions("1.2.0", "1.10.0"), -1);
  assert.strictEqual(v.compareVersions("v2.0.0", "1.9.9"), 1);
  assert.strictEqual(v.compareVersions("1.2.0-abc", "1.2.0"), 0);
  assert.strictEqual(v.compareVersions("junk", "1.0.0"), null);
});

test("update checker notice and silent failure", async () => {
  const v = await import("../mcp-server/version.js");
  const ok = v.createUpdateChecker({
    localVersion: "1.2.0",
    repo: "o/r",
    fetchImpl: async () => ({ ok: true, json: async () => [{ name: "v1.3.0" }, { name: "v1.2.5" }] }),
  });
  await ok.check(true);
  assert.strictEqual(ok.status().latest, "1.3.0");
  assert.match(ok.notice(), /update available 1\.2\.0 -> 1\.3\.0/);

  const bad = v.createUpdateChecker({
    localVersion: "1.2.0",
    repo: "o/r",
    fetchImpl: async () => {
      throw new Error("network");
    },
  });
  await bad.check(true);
  assert.strictEqual(bad.status().state, "unknown");
  assert.strictEqual(bad.notice(), "");
});
