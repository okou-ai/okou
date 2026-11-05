import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { literal, object, string } from "zod";
import { parseMigrationCliStderr } from "./migration-cli-stderr";

const expected = {
  status: "failed",
  classification: "ReviewedPlanAndChecksumRequired",
};
const record = JSON.stringify(expected);
assert.deepEqual(parseMigrationCliStderr(`  ${record}\r\n`), expected);

const before = "diagnostic before the failure record";
const after = "diagnostic after the failure record";
const warningImport = new URL(
  "./fixtures/migration-cli-warning.mjs",
  import.meta.url,
).href;
await assert.rejects(
  promisify(execFile)(process.execPath, [
    "--import",
    warningImport,
    "--import",
    "tsx",
    "scripts/migrations/026-retire-workflow-storage/cleanup.ts",
    "--migrate",
  ]),
  (error: unknown) => {
    const failure = object({ code: literal(1), stderr: string() }).parse(error);
    const { stderr } = failure;
    assert.match(stderr, /\[MIGRATION_CLI_TEST\]/u);
    assert.ok(stderr.indexOf(before) < stderr.indexOf(record), stderr);
    assert.ok(stderr.indexOf(after) > stderr.indexOf(record), stderr);
    assert.deepEqual(parseMigrationCliStderr(stderr), expected);
    return true;
  },
);

for (const stderr of [
  `${before}\n${after}\n`,
  `${before}\n${record}\n${record}\n${after}\n`,
  `${before}\n{"status":\n${after}\n`,
  `${before}\n{"status":\n${record}\n${after}\n`,
]) {
  assert.throws(
    () => {
      parseMigrationCliStderr(stderr);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(stderr), error.message);
      return true;
    },
  );
}
console.log("Migration CLI stderr observation checks passed");
