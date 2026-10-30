import assert from "node:assert/strict";
import { test } from "node:test";

import { selectWorkerBuilds } from "./worker-role-build.mjs";
import { workerRoles } from "./worker-role-manifest.mjs";

test("the normal Worker command preserves the aggregate deployable artifact", () => {
  assert.deepEqual(selectWorkerBuilds([]), [
    { role: undefined, entry: "src/worker.ts", directory: "dist-worker" },
  ]);
});

test("experimental role builds have distinct, explicitly selected artifacts", () => {
  const selections = selectWorkerBuilds(["--roles"]);
  assert.equal(selections.length, 9);
  assert.deepEqual(
    selections.map(({ role }) => {
      return role;
    }),
    Object.keys(workerRoles),
  );
  for (const selection of selections) {
    assert.deepEqual(selectWorkerBuilds(["--role", selection.role]), [
      selection,
    ]);
    assert.equal(selection.entry, `src/worker-roles/${selection.role}.ts`);
    assert.equal(selection.directory, `dist-worker-roles/${selection.role}`);
  }
});

test("a mistaken experiment selection cannot silently build the complete API", () => {
  assert.throws(() => {
    return selectWorkerBuilds(["--role", ""]);
  }, /Unknown Worker role/);
  assert.throws(() => {
    return selectWorkerBuilds(["--role="]);
  }, /Unknown Worker role/);
  assert.throws(() => {
    return selectWorkerBuilds(["--role", "", "--roles"]);
  }, /not both/);
  assert.throws(() => {
    return selectWorkerBuilds(["--role", "unknown"]);
  }, /Unknown Worker role/);
  assert.throws(() => {
    return selectWorkerBuilds(["--role", "runtime", "--roles"]);
  }, /not both/);
  assert.throws(() => {
    return selectWorkerBuilds(["runtime"]);
  }, /Unexpected argument/);
});
