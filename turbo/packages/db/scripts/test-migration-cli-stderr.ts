import assert from "node:assert/strict";
import { parseMigrationCliStderr } from "./migration-cli-stderr";

const expected = {
  result: "failed",
  classification: "ZodError",
};
const record = JSON.stringify(expected);
assert.deepEqual(parseMigrationCliStderr(`  ${record}\r\n`), expected);

const before = "diagnostic before the failure record";
const after = "diagnostic after the failure record";
assert.deepEqual(
  parseMigrationCliStderr(`${before}\n${record}\n${after}\n`),
  expected,
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
