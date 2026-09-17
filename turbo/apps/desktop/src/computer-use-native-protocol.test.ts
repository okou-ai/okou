import { ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createComputerUseNativeBackend } from "./computer-use-native";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

// Control only the external process boundary. Real executable transport,
// lifecycle, and timeout coverage stays in computer-use-native.test.ts.
function createControlledHelper() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
  child.kill = vi.fn((signal) => {
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  });
  let onSpawn!: () => void;
  const spawned = new Promise<void>((resolve) => {
    onSpawn = resolve;
  });
  vi.mocked(spawn).mockImplementationOnce(() => {
    onSpawn();
    return child;
  });
  stdin.once("finish", () => {
    stdout.end();
    stderr.end();
    child.emit("close", 0, null);
  });
  onTestFinished(() => {
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  });

  return {
    child,
    spawned,
    stdout,
    startReading() {
      child.emit("spawn");
      const lines = createInterface({ input: stdin });
      onTestFinished(() => lines.close());
      return new Promise<string>((resolve) => lines.once("line", resolve));
    },
  };
}

describe("native permission response settlement", () => {
  it.each([
    [
      "invalid status",
      (id: string) => JSON.stringify({ id, status: "invalid" }),
    ],
    [
      "invalid result",
      (id: string) => JSON.stringify({ id, status: "succeeded", result: [] }),
    ],
    [
      "invalid permission fields",
      (id: string) =>
        JSON.stringify({
          id,
          status: "succeeded",
          result: { accessibility: "private-payload" },
        }),
    ],
    ["malformed JSON", () => "{private-payload"],
    ["non-object frame", () => "null"],
  ])(
    "rejects %s after delayed helper readiness and releases queued work without reuse",
    async (_label, frame) => {
      const helper = createControlledHelper();
      const onRuntimeError = vi.fn();
      const backend = createComputerUseNativeBackend({
        helperPath: "controlled-native-helper",
        requestTimeoutMs: 400,
        onRuntimeError,
      });
      onTestFinished(() => backend.dispose());
      const settlement = Promise.allSettled([
        backend.getPermissions(),
        backend.listApps(),
      ]);

      // Dispatch buffers stdin while the helper is not ready. Release readiness
      // and the response explicitly, using stream events and microtasks rather
      // than racing a fresh OS process against the request timeout.
      await helper.spawned;
      expect(onRuntimeError).not.toHaveBeenCalled();
      const request = JSON.parse(await helper.startReading()) as {
        id: string;
        kind: string;
      };
      expect(request.kind).toBe("permissions.state");
      helper.stdout.write(`${frame(request.id)}\n`);

      const results = await settlement;
      expect(results.map((result) => result.status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(onRuntimeError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        expect.objectContaining({
          stage: "protocol",
          pendingRequestCount: 1,
          queuedRequestCount: 1,
        }),
      );
      expect(JSON.stringify(onRuntimeError.mock.calls)).not.toContain(
        "private-payload",
      );
      await expect(backend.getPermissions()).rejects.toThrow("closed");
      expect(backend.isAvailable?.()).toBe(false);
      expect(helper.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );
});
