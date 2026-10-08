import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cliRoot = new URL("../", import.meta.url);
const turboRoot = new URL("../../", cliRoot);
const readJson = (url) => JSON.parse(readFileSync(url, "utf8"));
const pkg = readJson(new URL("dist/package.json", cliRoot));
const runtime = readJson(
  new URL("packages/pi-agent-runtime/package.json", turboRoot),
);
const session = readJson(
  new URL(
    "packages/pi-agent-runtime/session-construction-digest.json",
    turboRoot,
  ),
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
if (
  typeof session.digest !== "string" ||
  session.digest.length !== 64 ||
  !/^[0-9a-f]+$/.test(session.digest)
) {
  throw new Error("Invalid CLI session-construction digest");
}
const patchesRoot = new URL("patches/", turboRoot);
const patches = readdirSync(patchesRoot, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.startsWith("@earendil-works__") &&
      entry.name.endsWith(".patch"),
  )
  .map((entry) => entry.name)
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
  sessionConstruction: { digest: session.digest },
};
writeFileSync(
  fileURLToPath(new URL("dist/package.json", cliRoot)),
  `${JSON.stringify(pkg, null, 2)}\n`,
);
