import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const { scripts } = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);

// Reuse the public scripts without starting another package manager per stage.
for (const stage of [
  "deps",
  "boundaries",
  "gateways",
  "core",
  "bootstrap",
  "tests",
  "bootstrap-wiring",
]) {
  const name = `check-types:${stage}`;
  const command = scripts[name];
  process.stdout.write(`\n> ${name}\n> ${command}\n\n`);
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
