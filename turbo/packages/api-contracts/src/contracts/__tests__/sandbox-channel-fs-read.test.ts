import { expect, it } from "vitest";
import type { SandboxChannelOperation } from "../sandbox-channel";
import {
  SANDBOX_FS_READ_LIMITS,
  sandboxFsReadOpen,
  sandboxFsRead,
  sandboxFsReadFinish,
  sandboxFsReadClose,
} from "../sandbox-channel-fs";
import vectors from "../../../../../../crates/guest-contracts/tests/fixtures/sandbox-channel-fs-read.json";

const operations = new Map<string, SandboxChannelOperation>([
  ["open", sandboxFsReadOpen],
  ["read", sandboxFsRead],
  ["finish", sandboxFsReadFinish],
  ["close", sandboxFsReadClose],
]);
for (const vector of vectors.payloads) {
  it(vector.name, () => {
    const operation = operations.get(vector.operation);
    if (!operation) throw new Error("Missing file read fixture operation");
    expect(
      (vector.direction === "params"
        ? operation.params
        : operation.result
      ).safeParse(vector.value).success,
    ).toBe(vector.valid);
  });
}

it("accepts a complete maximum chunk within the response framing budget", () => {
  const data = btoa("\xff".repeat(SANDBOX_FS_READ_LIMITS.maxChunkBytes));
  expect(
    sandboxFsRead.result.safeParse({
      offset: "9007199254740993",
      length: 32768,
      data,
    }).success,
  ).toBe(true);
  expect(
    sandboxFsRead.result.safeParse({
      offset: "0",
      length: 32769,
      data: btoa("a".repeat(32769)),
    }).success,
  ).toBe(false);
});
