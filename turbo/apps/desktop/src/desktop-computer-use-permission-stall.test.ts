import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { runPermissionStallFixture } from "./test/native-permission-stall";

it("recovers a ready helper's buffered reply after an isolated parent stall", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-parent-stall-"));
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--conditions=import",
        "--import",
        import.meta.resolve("tsx"),
        "-e",
        `require('./src/test/native-permission-stall.ts').${runPermissionStallFixture.name}(process.argv[1])`,
        directory,
      ],
      { timeout: 10_000 },
    );
    const result = JSON.parse(stdout) as {
      outcome: { ok: boolean };
      generation: number;
      freshGeneration: number;
      ready: boolean;
      writtenAfterMs: number;
      elapsedMs: number;
      startsAfterStall: number;
      errors: unknown[];
    };
    // This isolated process must prove the helper wrote before the real native
    // request deadline while the parent remained blocked past that deadline.
    // See the real-deadline exception in docs/testing/desktop-testing.md.
    expect(result.writtenAfterMs).toBeLessThan(400);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(850);
    expect(result.outcome.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.freshGeneration).toBeGreaterThan(result.generation);
    expect(result.startsAfterStall).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        stage: "timeout",
        requestKind: "permissions.state",
        timerDelayMs: expect.any(Number),
        pendingRequestCount: 1,
      }),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
