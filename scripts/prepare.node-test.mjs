import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const prepare = fileURLToPath(new URL("./prepare.sh", import.meta.url));

function runPrepare(version) {
  const bin = mkdtempSync(join(tmpdir(), "okou-prepare-node-"));
  try {
    // Only expose the shell and path utility needed by the real setup entry.
    // Package managers, databases and credential tools must remain unavailable.
    symlinkSync("/bin/bash", join(bin, "bash"));
    symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
    if (version !== undefined) {
      writeFileSync(join(bin, "node"), `#!/bin/bash\necho '${version}'\n`, {
        mode: 0o755,
      });
    }
    return spawnSync("/bin/bash", [prepare], {
      encoding: "utf8",
      env: { PATH: bin, DATABASE_URL: "" },
    });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test("setup rejects unpatched, unsupported and prerelease Node before environment setup", () => {
  for (const version of [
    undefined,
    "v20.20.0",
    "v22.23.3",
    "v24.22.0",
    "v26.12.0",
    "v23.11.0",
    "v25.0.0",
    "v27.0.0",
    "v26.12.1-rc.1",
  ]) {
    const result = runPrepare(version);
    assert.equal(result.status, 1, version);
    assert.match(result.stdout, /Error: Node.js/, version);
    assert.doesNotMatch(result.stdout, /2\. Checking pnpm/, version);
  }
});

test("patched supported releases proceed to the remaining setup checks", () => {
  for (const version of [
    "v22.23.4",
    "v24.22.1",
    "v26.12.1",
    "v22.24.0",
    "v24.22.2",
  ]) {
    const result = runPrepare(version);
    // Setup stops later because this isolated PATH has no external setup tools.
    assert.equal(result.status, 1, version);
    assert.doesNotMatch(result.stdout, /Error: Node.js/, version);
    assert.match(result.stdout, /2\. Checking pnpm/, version);
  }
});
