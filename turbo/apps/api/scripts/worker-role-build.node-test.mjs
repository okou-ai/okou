import assert from "node:assert/strict";
import { test } from "node:test";

import { selectWorkerBuilds } from "./worker-role-build.mjs";
import { workerRoles } from "./worker-role-manifest.mjs";
import { workerDomains } from "./worker-domain-manifest.mjs";

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

test("partial business probes have their own explicit artifact namespace", () => {
  const selections = selectWorkerBuilds(["--domains"]);
  assert.deepEqual(
    selections.map(({ domain }) => {
      return domain;
    }),
    Object.keys(workerDomains),
  );
  for (const selection of selections) {
    assert.deepEqual(selectWorkerBuilds(["--domain", selection.domain]), [
      selection,
    ]);
    assert.equal(selection.entry, `src/worker-domains/${selection.domain}.ts`);
    assert.equal(
      selection.directory,
      `dist-worker-domains/${selection.domain}`,
    );
  }
});

test("mistaken or mixed business selections cannot fall back to an aggregate or role build", () => {
  for (const args of [
    ["--domain", ""],
    ["--domain="],
    ["--domain", "unknown"],
  ]) {
    assert.throws(() => {
      return selectWorkerBuilds(args);
    }, /Unknown Worker business domain/);
  }
  assert.throws(() => {
    return selectWorkerBuilds(["--domain", "threads", "--domains"]);
  }, /not both/);
  for (const args of [
    ["--domains", "--roles"],
    ["--domain", "chat", "--role", "runtime"],
  ]) {
    assert.throws(() => {
      return selectWorkerBuilds(args);
    }, /cannot be mixed/);
  }
});
