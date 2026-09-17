import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const builder = fileURLToPath(
  new URL("build-definitions.mjs", import.meta.url),
);
test("review bodies contain the exact service-validated queries and no destination", async () => {
  const bodies = JSON.parse(
    execFileSync(process.execPath, [builder, "--review-only"], {
      encoding: "utf8",
    }),
  );
  assert.equal(bodies.length, 2);
  for (const [index, queryFile] of ["cost.apl", "health.apl"].entries()) {
    assert.equal(
      bodies[index].aplQuery,
      await readFile(new URL(queryFile, import.meta.url), "utf8"),
    );
    assert.equal(bodies[index].disabled, true);
    assert.deepEqual(bodies[index].notifierIds, []);
    assert.equal(bodies[index].operator, "AboveOrEqual");
    assert.equal(bodies[index].threshold, index === 0 ? 20 : 1);
    assert.equal(bodies[index].intervalMinutes, 5);
  }
});
test("destination-bound generation still requires reviewed IDs", () => {
  assert.throws(
    () => execFileSync(process.execPath, [builder], { stdio: "pipe" }),
    /Supply actual controller-reviewed notifier IDs/,
  );
});
