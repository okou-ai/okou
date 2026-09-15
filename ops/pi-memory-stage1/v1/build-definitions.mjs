import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Offline compiler only. It never contacts Axiom, enables a monitor, or sends.
const args = process.argv.slice(2);
const reviewOnly = args.length === 1 && args[0] === "--review-only";
const notifierIds = reviewOnly ? [] : args;
assert.ok(
  reviewOnly ||
    (notifierIds.length > 0 &&
      notifierIds.every(
        (id) => id.trim() === id && id.length > 0 && !id.startsWith("--"),
      )),
  "Supply actual controller-reviewed notifier IDs; none are provided by this repository",
);
const config = JSON.parse(
  await readFile(new URL("definitions.json", import.meta.url), "utf8"),
);
const definitions = [];
for (const monitor of config.monitors) {
  assert.equal(
    monitor.definition.disabled,
    true,
    "Only disabled bodies may be generated",
  );
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
