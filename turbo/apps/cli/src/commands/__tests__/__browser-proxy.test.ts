import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  buildProcessEntry,
  disposePreparedProcessEntry,
} from "../../test/fixtures/build-process-entry";

let compiled: Awaited<ReturnType<typeof buildProcessEntry>>;
let preparation: ReturnType<typeof buildProcessEntry> | undefined;
const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];

beforeAll(async () => {
  preparation = buildProcessEntry(
    fileURLToPath(new URL("../../okou.ts", import.meta.url)),
  );
  compiled = await preparation;
});
afterAll(async () => {
  await disposePreparedProcessEntry(preparation);
});
afterEach(async () => {
  for (const { child, closed } of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  }
});

function launch(ipc = true) {
  const child = spawn(process.execPath, [compiled.entry, "__browser-proxy"], {
    env: { ...process.env, SENTRY_DSN: "" },
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  // Explicit IPC disconnect need not emit ChildProcess.close in every Node version.
  const closed = Promise.all([
    once(child, "exit"),
    child.stdout && finished(child.stdout),
    child.stderr && finished(child.stderr),
  ]).then(([exit]) => {
    return exit;
  });
  children.push({ child, closed });
  const message = () => {
    return Promise.race([
      once(child, "message").then(([value]: unknown[]) => {
        return value;
      }),
      closed.then(() => {
        throw new Error("Proxy exited before its IPC response");
      }),
    ]);
  };
  return {
    child,
    closed,
    message,
    stdout: () => {
      return stdout;
    },
    stderr: () => {
      return stderr;
    },
  };
}

it("requires the private startup pipe through the canonical CLI entry", async () => {
  const runtime = launch(false);
  const [code] = await runtime.closed;
  expect(code).toBe(1);
  expect(runtime.stdout()).toBe("");
  expect(runtime.stderr()).toContain("requires a private startup pipe");
});

it("announces its receiver after CLI bootstrap and rejects invalid config without printing it", async () => {
  const runtime = launch();
  expect(await runtime.message()).toStrictEqual({ ready: true });
  const failed = runtime.message();
  runtime.child.send?.({
    cdpUrl: "PRIVATE_CONFIGURATION_SENTINEL",
    windowId: 0,
  });
  expect(await failed).toStrictEqual({ error: "Scoped Browser setup failed" });
  const [code] = await runtime.closed;
  expect(code).toBe(1);
  expect(runtime.stdout()).toBe("");
  expect(runtime.stderr()).not.toContain("PRIVATE_CONFIGURATION_SENTINEL");
});

it("exits when its parent disconnects before sending configuration", async () => {
  const runtime = launch();
  expect(await runtime.message()).toStrictEqual({ ready: true });
  runtime.child.disconnect();
  const [code] = await runtime.closed;
  expect(code).toBe(1);
  expect(runtime.stdout()).toBe("");
});
