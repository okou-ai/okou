import assert from "node:assert/strict";

// Migration operators emit one compact JSON object on stderr when they fail.
// Runtime diagnostics can precede or follow it on the same stream.
export function parseMigrationCliStderr(stderr: string): unknown {
  const records = stderr.split("\n").filter((line) => {
    return line.trimStart().startsWith("{");
  });
  const [record] = records;
  assert.ok(
    records.length === 1 && record !== undefined,
    `Expected exactly one migration CLI failure record:\n${stderr}`,
  );
  try {
    return JSON.parse(record);
  } catch (cause) {
    throw new Error(`Invalid migration CLI failure record:\n${stderr}`, {
      cause,
    });
  }
}
