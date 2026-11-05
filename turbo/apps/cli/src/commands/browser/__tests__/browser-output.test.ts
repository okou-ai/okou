import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { http, passthrough } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { server } from "../../../mocks/server";
import {
  buildProcessEntry,
  disposePreparedProcessEntry,
} from "../../../test/fixtures/build-process-entry";
import { browserCdpProvider } from "../../../test/fixtures/browser-cdp-provider";

const run = promisify(execFile);
const preload = fileURLToPath(
  new URL(
    "../../../test/fixtures/browser-process-boundaries.mjs",
    import.meta.url,
  ),
);
const helper = fileURLToPath(
  new URL("../../../test/fixtures/guest-task-helper.py", import.meta.url),
);
let preparation: ReturnType<typeof buildProcessEntry> | undefined;
let compiled: Awaited<ReturnType<typeof buildProcessEntry>>;
let directory: string;
let provider: Awaited<ReturnType<typeof browserCdpProvider>>;
const children: {
  child: ChildProcess;
  exited: Promise<unknown>;
  closed: Promise<unknown>;
}[] = [];
const connections: WebSocket[] = [];

beforeAll(async () => {
  preparation = buildProcessEntry(
    fileURLToPath(new URL("../../../okou.ts", import.meta.url)),
  );
  compiled = await preparation;
});
afterAll(async () => {
  await disposePreparedProcessEntry(preparation);
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "okou-browser-output-"));
  provider = await browserCdpProvider();
});
afterEach(async () => {
  for (const socket of connections.splice(0)) socket.terminate();
  for (const { child, exited } of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
  try {
    for (const handle of await readdir(directory)) {
      if (/^[0-9a-f-]{36}$/u.test(handle))
        await run("python3", [helper, "normal", directory, "stop", handle]);
    }
    for (const { closed } of children.splice(0)) await closed;
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function launch(
  command: string,
  json: boolean,
  failure?: "startup" | "driver",
) {
  await writeFile(
    join(directory, "boundaries.json"),
    JSON.stringify({
      cdpUrl: failure === "startup" ? "ws://127.0.0.1:1" : provider.endpoint,
      driverExit: failure === "driver" ? 7 : 0,
    }),
  );
  const child = spawn(
    process.execPath,
    [compiled.entry, "browser", command, ...(json ? ["--json"] : [])],
    {
      cwd: directory,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import=${preload}`,
        NODE_NO_WARNINGS: "1",
        SENTRY_DSN: "",
        OKOU_TOKEN: "test-token",
        OKOU_API_BACKEND_URL: "http://browser-api.test",
        OKOU_CHAT_THREAD_ID: "c0000000-0000-4000-a000-000000000010",
        OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  const closed = once(child, "close");
  children.push({ child, exited, closed });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  return {
    child,
    exited,
    closed,
    output: () => {
      return { stdout, stderr };
    },
  };
}

async function targets(socket: WebSocket) {
  const response = once(socket, "message");
  socket.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
  const [raw] = await response;
  return JSON.parse(String(raw)) as {
    result: { targetInfos: { targetId: string }[] };
  };
}

it.each([
  { command: "use", json: true },
  { command: "new", json: false },
])(
  "finishes $command output while its scoped proxy stays usable",
  async ({ command, json }) => {
    const runtime = await launch(command, json);
    const exit = await runtime.exited;
    expect(exit, runtime.output().stderr).toEqual([0, null]);
    const endpoint = await readFile(join(directory, "endpoint"), "utf8");
    server.use(
      http.get(endpoint.replace(/^ws/u, "http"), () => {
        return passthrough();
      }),
    );
    const socket = new WebSocket(endpoint);
    connections.push(socket);
    await once(socket, "open");
    expect((await targets(socket)).result.targetInfos).toEqual(
      expect.arrayContaining([expect.objectContaining({ targetId: "A" })]),
    );

    // Foreground exit alone is insufficient: inherited writers can delay close forever.
    expect(await runtime.closed).toEqual([0, null]);
    expect(runtime.child.stdout?.readableEnded).toBe(true);
    expect(runtime.child.stderr?.readableEnded).toBe(true);
    expect((await targets(socket)).result.targetInfos).toEqual(
      expect.arrayContaining([expect.objectContaining({ targetId: "A" })]),
    );
    const { stdout, stderr } = runtime.output();
    expect(stderr).toBe("");
    if (json)
      expect(JSON.parse(stdout)).toMatchObject({
        agentBrowserSession: "okou-browser",
      });
    else expect(stdout).toContain("Managed browser ready");
  },
);

it.each(["startup", "driver"] as const)(
  "reports %s failure and retires the owned task",
  async (failure) => {
    const runtime = await launch("use", true, failure);
    expect(await runtime.closed).toEqual([1, null]);
    expect(runtime.output().stdout).toBe("");
    if (failure === "startup") {
      // IPC failure and child exit are independent terminal notifications.
      expect(runtime.output().stderr).toMatch(
        /Scoped Browser (?:startup failed|exited during startup)/u,
      );
    } else {
      expect(runtime.output().stderr).toContain(
        "agent-browser connect exited with status 7",
      );
    }
    expect(
      (await readdir(directory)).filter((file) => {
        return file.endsWith(".stopped");
      }),
    ).toHaveLength(1);
  },
);
