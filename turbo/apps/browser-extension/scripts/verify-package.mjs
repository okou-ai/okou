import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, basename } from "node:path";
import assert from "node:assert/strict";

const directory = process.cwd();
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const name = basename(directory);
const archive = resolve(directory, `artifacts/${name}-${pkg.version}.zip`);
const bytes = await readFile(archive);
const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
  .trim()
  .split("\n")
  .sort();
assert.deepEqual(entries, ["background.js", "manifest.json"]);
const manifest = JSON.parse(
  execFileSync("unzip", ["-p", archive, "manifest.json"], { encoding: "utf8" }),
);
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.manifest_version, 3);
const digest = createHash("sha256").update(bytes).digest("hex");
const receipt = JSON.parse(
  await readFile(`${archive}.provenance.json`, "utf8"),
);
assert.equal(receipt.sha256, digest);
const before = digest;
for (const timezone of ["UTC", "Asia/Shanghai"]) {
  execFileSync("pnpm", ["build"], {
    cwd: directory,
    stdio: "pipe",
    env: { ...process.env, TZ: timezone },
  });
  assert.equal(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
    before,
    `Package changed under ${timezone}`,
  );
}
console.log(`Verified repeatable package ${name}@${pkg.version}: ${digest}`);
