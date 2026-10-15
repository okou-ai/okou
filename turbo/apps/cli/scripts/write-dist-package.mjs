import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const cliRoot = new URL("../", import.meta.url);
const turboRoot = new URL("../../", cliRoot);
const readJson = (url) => {
  return JSON.parse(readFileSync(url, "utf8"));
};
const pkg = readJson(new URL("dist/package.json", cliRoot));
const runtime = readJson(
  new URL("packages/pi-agent-runtime/package.json", turboRoot),
);
const sdk = runtime.dependencies["@earendil-works/pi-coding-agent"];
const releaseVersion =
  /^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})$/;
for (const [field, value] of [
  ["cli", pkg.version],
  ["piAgentRuntime", runtime.version],
  ["piSdk", sdk],
]) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !releaseVersion.test(value)
  ) {
    throw new Error(`Invalid CLI build identity ${field}`);
  }
}
const patchesRoot = new URL("patches/", turboRoot);
const patches = readdirSync(patchesRoot, { withFileTypes: true })
  .filter((entry) => {
    return (
      entry.isFile() &&
      entry.name.startsWith("@earendil-works__") &&
      entry.name.endsWith(".patch")
    );
  })
  .map((entry) => {
    return entry.name;
  })
  .sort();
if (patches.length === 0) {
  throw new Error("CLI build identity requires the first-party Pi SDK patches");
}
const patchHash = createHash("sha256");
for (const patch of patches) {
  patchHash.update(
    readFileSync(new URL(encodeURIComponent(patch), patchesRoot)),
  );
}
pkg.okouBuildIdentity = {
  schemaVersion: 1,
  piAgentRuntime: runtime.version,
  piSdk: `${sdk}+okou.${patchHash.digest("hex").slice(0, 12)}`,
};
writeFileSync(
  fileURLToPath(new URL("dist/package.json", cliRoot)),
  `${JSON.stringify(pkg, null, 2)}\n`,
);
