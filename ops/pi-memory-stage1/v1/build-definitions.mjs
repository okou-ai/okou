import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Offline compiler only. It never contacts Axiom, enables a monitor, or sends.
const notifierIds = process.argv.slice(2);
assert.ok(
  notifierIds.length > 0 &&
    notifierIds.every((id) => id.trim() === id && id.length > 0),
  "Supply actual controller-reviewed notifier IDs; none are provided by this repository",
);
const config = JSON.parse(
  await readFile(new URL("definitions.json", import.meta.url), "utf8"),
);
const definitions = [];
for (const monitor of config.monitors) {
  definitions.push({
    ...monitor.definition,
    notifierIds,
    aplQuery: await readFile(
      new URL(monitor.queryFile, import.meta.url),
      "utf8",
    ),
  });
}
console.log(JSON.stringify(definitions, null, 2));
