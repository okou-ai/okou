import type { ComputerUseCommandClock } from "./computer-use-command-budget";
import { DesktopRecorderController } from "./desktop-recorder-controller";
import { createRecorderNativeBackend } from "./desktop-recorder-native";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopMcpPluginManager } from "./desktop-mcp-plugin";
import { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { resolveDesktopConfig } from "./config";
import { DesktopAuthSession } from "./desktop-auth-session";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthTokenUrl,
} from "./desktop-auth";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import { createDesktopComputerUseHostRuntime } from "./desktop-computer-use-api";
import {
  ComputerUseDriverController,
  type ComputerUseDriver,
} from "./computer-use-driver";
import {
  createComputerUseNativeBackend,
  type ComputerUseNativeRuntimeErrorContext,
} from "./computer-use-native";
import { createComputerUsePermissions } from "./computer-use-permissions";
import {
  ComputerUseRuntimeController,
  type ComputerUsePermissionRecoveryDiagnostic,
} from "./computer-use-runtime-controller";
import {
  SUPPORTED_COMPUTER_USE_CAPABILITIES,
  type ComputerUseCommand,
} from "./computer-use-accessibility";
import { shouldDeferDesktopUpdate } from "./desktop-auto-update-policy";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn() };
});

const realChildProcess =
  await vi.importActual<typeof childProcess>("node:child_process");

const api = "https://api.okou.ai";
const server = setupServer();
const cleanups: (() => Promise<void>)[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  server.resetHandlers();
});
afterAll(() => server.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Only the host's scheduling boundary is controlled; promises and HTTP stay real. */
function controlledTimers() {
  const pending = new Map<
    ReturnType<typeof setTimeout>,
    { delay: number | undefined; run: () => void }
  >();
  const schedule = Object.assign(
    (run: () => void, delay?: number) => {
      const timer = setTimeout(() => {}, 2 ** 30);
      timer.unref();
      pending.set(timer, { delay, run });
      return timer;
    },
    { __promisify__: setTimeout.__promisify__ },
  );
  const clear = (
    timer: ReturnType<typeof setTimeout> | string | number | undefined,
  ) => {
    if (typeof timer === "object") pending.delete(timer);
    clearTimeout(timer);
  };
  return {
    schedule,
    clear,
    count: (delay: number) =>
      [...pending.values()].filter((item) => item.delay === delay).length,
    take(delay: number) {
      const entry = [...pending].find(([, item]) => item.delay === delay);
      if (!entry) throw new Error(`No timer scheduled for ${delay}ms`);
      clear(entry[0]);
      return entry[1].run;
    },
    run(delay: number) {
      this.take(delay)();
    },
    close() {
      for (const timer of pending.keys()) clear(timer);
    },
  };
}

interface NativeRequest {
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

function nativeProcesses(events: string[]) {
  let permissionReply: {
    status: string;
    result?: unknown;
    error?: { code: string };
  } | null = null;
  const pauses = new Map<string, ReturnType<typeof pause>>();
  const active = new Set<ChildProcess>();
  const closeReached = deferred<void>();
  let holdClose = false;
  let created = 0;
  function pause(kind: string) {
    const gate = { reached: deferred<void>(), resume: deferred<void>() };
    pauses.set(kind, gate);
    return gate;
  }
  vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
    if (command !== "/test/computer-use-helper")
      return realChildProcess.spawn(command, args, options);
    const generation = ++created;
    events.push(`create:${generation}`);
    const child = new ChildProcess();
    child.kill = () => true;
    const input = new PassThrough();
    const output = new PassThrough();
    child.stdin = input;
    child.stdout = output;
    child.stderr = new PassThrough();
    active.add(child);
    input.on("data", (chunk: Buffer) => {
      const request: NativeRequest = JSON.parse(chunk.toString());
      const reply = async () => {
        events.push(`${generation}:${request.kind}`);
        const gate = pauses.get(request.kind);
        if (gate) {
          pauses.delete(request.kind);
          gate.reached.resolve();
          await gate.resume.promise;
        }
        let result: Record<string, unknown> = {};
        if (request.kind.startsWith("permissions."))
          result = { accessibility: true, screenRecording: true };
        if (request.kind === "apps.list")
          result = {
            apps: [{ name: `generation-${generation}`, bundleId: "test.app" }],
          };
        if (request.kind === "app.state")
          result = {
            app: request.payload.app,
            snapshotId: request.payload.snapshotId,
            screenshot: "data:image/png;base64,abc123",
            screenshotMimeType: "image/png",
            screenshotSource: "window",
            screenshotSourceName: "Test",
            screenshotWidth: 800,
            screenshotHeight: 600,
            screenshotSourceBounds: { x: 0, y: 0, width: 800, height: 600 },
            windowId: 123,
            windowFrame: { x: 0, y: 0, width: 800, height: 600 },
            elements: [
              {
                id: `element-${generation}`,
                role: "AXButton",
                name: "Open",
                actions: ["AXPress"],
              },
            ],
          };
        const reply = request.kind.startsWith("permissions.")
          ? permissionReply
          : null;
        output.write(
          `${JSON.stringify({ id: request.id, ...(reply ?? { status: "succeeded", result }) })}\n`,
        );
      };
      void reply();
    });
    input.on("finish", () => {
      events.push(`dispose:${generation}`);
      closeReached.resolve();
      if (!holdClose) {
        active.delete(child);
        child.emit("close", 0, null);
      }
    });
    return child;
  });
  return {
    failNextWrite: (mode: "throw" | "callback") => {
      for (const child of active) {
        if (!child.stdin) throw new Error("Fixture has no stdin");
        if (mode === "throw")
          vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
            throw new Error("fixture write failure");
          });
        else
          vi.spyOn(child.stdin, "_write").mockImplementationOnce(
            (_chunk, _encoding, done) =>
              done(new Error("fixture pipe failure")),
          );
      }
    },
    permissions: (reply: typeof permissionReply) => {
      permissionReply = reply;
    },
    pause,
    closeReached,
    holdClose: () => {
      holdClose = true;
    },
    get created() {
      return created;
    },
    get active() {
      return active.size;
    },
    close() {
      holdClose = false;
      for (const child of active) child.emit("close", 0, null);
      active.clear();
    },
  };
}

function desktop(
  options: {
    commandClock?: ComputerUseCommandClock;
    transitionTimeoutMs?: number;
    nativeShutdownGraceMs?: number;
    nativeRequestTimeoutMs?: number;
    expectedQuitError?: string;
    plugin?: DesktopMcpPluginManager;
  } = {},
) {
  const events: string[] = [];
  const nativeErrors: ComputerUseNativeRuntimeErrorContext[] = [];
  const recoveries: ComputerUsePermissionRecoveryDiagnostic[] = [];
  const native = nativeProcesses(events);
  const timers = controlledTimers();
  const config = resolveDesktopConfig(undefined, "okou");
  const addClientHeaders = createDesktopClientHeaderInjector({
    clientVersion: "1.2.3",
  });
  const authSession = new DesktopAuthSession({
    onChange: () => {
      controller.cancelPermissionRefresh();
      permissions.resetComputerUsePermissionState();
    },
    apiBaseUrl: api,
    addClientHeaders,
    tokenUrl: buildDesktopAuthTokenUrl(config.authUrl),
    selectOrgUrl: buildDesktopAuthSelectOrgUrl(config.authUrl, true),
    consumeUrl: (code, id) =>
      buildDesktopAuthConsumeUrl(config.authUrl, code, id),
    runAuthWindow: async () => "app-token",
  });
  const driverDefinition: ComputerUseDriver = {
    id: "okou",
    createBackend: () =>
      createComputerUseNativeBackend({
        helperPath: "/test/computer-use-helper",
        shutdownGraceMs: options.nativeShutdownGraceMs ?? 100,
        requestTimeoutMs: options.nativeRequestTimeoutMs,
        onRuntimeError: (_error, context) => nativeErrors.push(context),
      }),
  };
  const driver = new ComputerUseDriverController(driverDefinition, "darwin");
  const permissions = createComputerUsePermissions(
    (read) => driver.withPermissionProvider(read),
    (query) => controller.refreshNativePermissions(query),
  );
  const requests: {
    path: string;
    body: unknown;
    authorization: string | null;
  }[] = [];
  const heartbeat = deferred<void>();
  const releaseRequests: (() => void)[] = [];
  let hostStarts = 0;
  server.use(
    http.all(`${api}/*`, async ({ request }) => {
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        body: request.method === "POST" ? await request.json() : null,
        authorization: request.headers.get("authorization"),
      });
      if (path === "/api/auth/me")
        return HttpResponse.json({
          userId: "user",
          email: "test@example.test",
          orgId: "org",
        });
      if (path === "/api/org")
        return HttpResponse.json({ id: "org", name: "Workspace" });
      if (path.endsWith("/hosts/start"))
        return HttpResponse.json({
          hostId: `host-${++hostStarts}`,
          hostToken: "host-token",
        });
      if (path.endsWith("/heartbeat")) heartbeat.resolve();
      return HttpResponse.json({ status: "idle" });
    }),
  );
  const online: boolean[] = [];
  const stateWaiters: (() => void)[] = [];
  const notify = () => {
    options.plugin?.setHostRuntimeOnline(controller.isRuntimeOnline());
    for (const resolve of stateWaiters.splice(0)) resolve();
  };
  const controller = new ComputerUseRuntimeController({
    onPermissionRecovery: (diagnostic) => recoveries.push(diagnostic),
    driver,
    createRuntime: () =>
      createDesktopComputerUseHostRuntime(
        {
          platformUrl: config.platformUrl,
          installationId: "00000000-0000-4000-8000-000000000001",
          hostName: "test-host",
          appVersion: "1.2.3",
          addClientHeaders,
          hostFetch: (input, init) => fetch(input, init),
          getPermissions: permissions.refreshComputerUsePermissionState,
          onChange: notify,
          getSupportedCapabilities: () => [
            ...SUPPORTED_COMPUTER_USE_CAPABILITIES,
            ...(options.plugin?.getCapabilities() ?? []),
          ],
          driver,
          executePluginCommand: async (command) => {
            if (!options.plugin)
              throw new Error("No plugin configured in this fixture");
            return options.plugin.execute(command);
          },
          commandClock: options.commandClock,
          setTimeout: timers.schedule,
          clearTimeout: timers.clear,
        },
        { getAuthSession: () => authSession },
      ),
    refreshPermissions: permissions.refreshComputerUsePermissionState,
    getAuthState: () => authSession.getAuthState(),
    getAuthAuthority: () => authSession.getAuthority(),
    setHostRuntimeOnline: (value) => {
      online.push(value);
      options.plugin?.setHostRuntimeOnline(value);
    },
    onChange: notify,
    transitionTimeoutMs: options.transitionTimeoutMs,
    lifecycleTimers: {
      setTimeout: timers.schedule,
      clearTimeout: timers.clear,
    },
  });
  cleanups.push(async () => {
    for (const release of releaseRequests) release();
    native.close();
    const quit = controller.stopForQuit();
    if (options.expectedQuitError)
      await expect(quit).rejects.toThrow(options.expectedQuitError);
    else await quit;
    timers.close();
  });
  function claim(command: ComputerUseCommand) {
    const reached = deferred<void>();
    const response = deferred<void>();
    const completed = deferred<Record<string, unknown>>();
    const completeResponse = deferred<void>();
    releaseRequests.push(() => {
      response.resolve();
      completeResponse.resolve();
    });
    server.use(
      http.post(`${api}/api/computer-use/host/commands/next`, async () => {
        events.push("claim");
        reached.resolve();
        await response.promise;
        return HttpResponse.json({
          status: "command",
          command: {
            timeoutMs: 60_000,
            createdAt: new Date().toISOString(),
            claimedAt: new Date().toISOString(),
            ...command,
          },
        });
      }),
      http.post<never, Record<string, unknown>>(
        `${api}/api/computer-use/host/commands/${command.id}/complete`,
        async ({ request }) => {
          const body: Record<string, unknown> = await request.json();
          events.push("completion");
          completed.resolve(body);
          await completeResponse.promise;
          return HttpResponse.json({ ok: true });
        },
      ),
    );
    return { reached, response, completed, completeResponse };
  }
  return {
    async waitForHostState(status: string) {
      while (controller.getHostState().status !== status)
        await new Promise<void>((resolve) => stateWaiters.push(resolve));
    },
    controller,
    driver,
    driverDefinition,
    authSession,
    nativeErrors,
    recoveries,
    permissions,
    native,
    events,
    timers,
    requests,
    heartbeat,
    online,
    claim,
  };
}

function pluginFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "driver-plugin-"));
  const script = path.join(dir, "server.cjs");
  writeFileSync(
    script,
    `
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : request.method === "tools/list"
      ? { tools: [{ name: "pid", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: String(process.pid) }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
  );
  const ready = deferred<void>();
  const manager = new DesktopMcpPluginManager({
    preferencesPath: path.join(dir, "preferences.json"),
    resolveShellPath: async () => null,
    onChange: () => {
      if (manager.getState().servers[0]?.status === "running") ready.resolve();
    },
  });
  manager.load();
  manager.importServersJson(
    JSON.stringify({
      mcpServers: { fixture: { command: process.execPath, args: [script] } },
    }),
  );
  manager.setServerEnabled("fixture", true);
  manager.setFeatureEnabled(true);
  cleanups.push(async () => {
    manager.setHostRuntimeOnline(false);
    manager.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { manager, ready: ready.promise };
}

function recorderFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "driver-recorder-"));
  const helperPath = path.join(dir, "recorder.cjs");
  writeFileSync(
    helperPath,
    `#!${process.execPath}
const readline = require("node:readline");
let status = "idle";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.kind === "recorder.start") status = "recording";
  if (request.kind === "recorder.pause") status = "paused";
  if (request.kind === "recorder.resume") status = "recording";
  const result = request.kind === "recorder.prepare"
    ? { sessionId: String(process.pid), width: 800, height: 600, geometry: { originX: 0, originY: 0, widthPoints: 800, heightPoints: 600, scale: 1 } }
    : { status, elapsedMs: 1000 };
  process.stdout.write(JSON.stringify({ id: request.id, status: "succeeded", result }) + "\\n");
});
`,
  );
  chmodSync(helperPath, 0o755);
  const backend = createRecorderNativeBackend({ helperPath });
  const recorder = new DesktopRecorderController({
    createBackend: () => backend,
    createOutputPath: () => path.join(dir, "recording.mp4"),
    canDeliver: async () => true,
    deliver: async () => {
      throw new Error("Recording delivery is outside this fixture");
    },
    openReview: () => {},
  });
  recorder.setFeatureEnabled(true);
  cleanups.push(async () => {
    backend.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  return recorder;
}

const action: ComputerUseCommand = {
  id: "command-1",
  kind: "keyboard.type_text",
  payload: { app: "test.app", text: "hello" },
};

describe("production driver generation and admission wiring", () => {
  it.each(["drain"] as const)(
    "drains a healthy claimed action when %s cancels a concurrent permission refresh",
    async () => {
      const app = desktop();
      await app.controller.start();
      const write = app.native.pause("keyboard.type_text");
      const command = app.claim(action);
      app.timers.run(5_000);
      command.response.resolve();
      await write.reached.promise;
      const refresh = app.permissions.refreshComputerUsePermissionState();
      const rejected = expect(refresh).rejects.toThrow();
      const transition = app.controller.drainAndStop();
      write.resume.resolve();
      const completed = await command.completed.promise;
      command.completeResponse.resolve();
      await transition;
      await rejected;
      expect(completed).toMatchObject({ status: "succeeded" });
      expect(app.events.indexOf("completion")).toBeLessThan(
        app.events.indexOf("dispose:1"),
      );
      expect(app.driver.getCapabilities()).toEqual([]);
      expect(app.controller.getHostState().status).toBe("offline");
    },
  );
  it.each(["stop", "auth", "quit", "update"] as const)(
    "lets %s supersede a delayed host registration",
    async (reason) => {
      const app = desktop();
      const registration = deferred<void>();
      const response = deferred<void>();
      const stopped = deferred<void>();
      server.use(
        http.post(`${api}/api/computer-use/hosts/start`, async () => {
          registration.resolve();
          await response.promise;
          return HttpResponse.json({
            hostId: "late-host",
            hostToken: "late-token",
          });
        }),
        http.post(`${api}/api/computer-use/host/stop`, ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer late-token",
          );
          stopped.resolve();
          return HttpResponse.json({});
        }),
      );
      const start = app.controller.start();
      await registration.promise;
      if (reason === "stop") await app.controller.stop();
      if (reason === "auth") await app.controller.stopForAuthChange();
      if (reason === "quit") await app.controller.stopForQuit();
      if (reason === "update")
        await app.controller.stopForQuit("update_relaunch");
      response.resolve();
      await start;
      await stopped.promise;
      expect(app.controller.getHostState().status).toBe("offline");
      expect(app.online).not.toContain(true);
      expect(app.timers.count(5_000)).toBe(0);
      expect(app.native.active).toBe(0);
    },
  );
  it("keeps the permission request UX available after a manual stop without restarting commands", async () => {
    const app = desktop();
    await app.controller.start();
    await app.controller.stop();
    await app.permissions.requestComputerUseAccessibilityPermission();
    expect(app.events).toContain("2:permissions.request_accessibility");
    await app.controller.start();
    expect(app.controller.getHostState().status).toBe("offline");
    await app.controller.start({ userInitiated: true });
    expect(app.controller.getHostState().status).toBe("online");
  });
  it("does not revive a start whose first permission read finishes after Stop", async () => {
    const app = desktop();
    const permission = app.native.pause("permissions.state");
    const start = app.controller.start();
    await permission.reached.promise;
    const stop = app.controller.stop();
    permission.resume.resolve();
    await Promise.all([start, stop]);
    expect(app.controller.getHostState().status).toBe("offline");
    expect(app.requests.map((request) => request.path)).toEqual([
      "/api/auth/me",
      "/api/org",
    ]);
    expect(app.native.active).toBe(0);
    await app.controller.start();
    expect(app.native.created).toBe(1);
  });

  it("preserves manual Stop when a late sign-in completion arrives", async () => {
    const app = desktop();
    await app.controller.start();
    await app.controller.stop();
    await app.controller.startForAuthChange(new AbortController().signal);
    expect(app.controller.getHostState().status).toBe("offline");
    expect(app.native.created).toBe(1);
  });

  it("does not register a host when the auth lifetime aborts during readiness", async () => {
    const app = desktop();
    const reached = deferred<void>();
    const response = deferred<void>();
    server.use(
      http.get(`${api}/api/auth/me`, async () => {
        reached.resolve();
        await response.promise;
        return HttpResponse.json({
          userId: "user",
          email: "test@example.test",
          orgId: "org",
        });
      }),
    );
    const auth = new AbortController();
    const start = app.controller.startForAuthChange(auth.signal);
    await reached.promise;
    auth.abort();
    response.resolve();
    await start;
    await app.controller.stop();
    expect(app.controller.getHostState().status).toBe("offline");
    expect(
      app.requests.some((request) => request.path.endsWith("/hosts/start")),
    ).toBe(false);
    expect(app.native.active).toBe(0);
  });
});

it.each(["permissions.state", "apps.list", "app.open", "app.state"])(
  "keeps one Okou deadline through %s even before the timer callback is delivered",
  async (phase) => {
    let monotonic = 0;
    const app = desktop({
      commandClock: {
        wallNow: () => Date.parse("2026-09-08T02:42:36.593Z"),
        monotonicNow: () => monotonic,
        setTimeout: (run, delay) => setTimeout(run, delay),
        clearTimeout: (timer) => clearTimeout(timer),
      },
    });
    await app.controller.start();
    const gate = app.native.pause(phase);
    const command = app.claim({
      id: "deadline-command",
      kind: phase === "apps.list" ? "apps.list" : "app.open",
      payload: { app: "test.app" },
      timeoutMs: 10_000,
      createdAt: "2026-09-08T02:44:35.425Z",
      claimedAt: "2026-09-08T02:44:36.980Z",
    });
    app.timers.run(5_000);
    await command.reached.promise;
    command.response.resolve();
    await gate.reached.promise;
    monotonic = 10_000;
    const before = app.events.length;
    gate.resume.resolve();
    expect(await command.completed.promise).toMatchObject({
      status: "failed",
      error: { code: "command_timeout" },
    });
    expect(app.events.slice(before)).not.toContain("1:app.open");
    expect(app.events.slice(before)).not.toContain("1:app.state");
    expect(app.driver.getCapabilities()).toEqual([]);
    command.completeResponse.resolve();
    await app.driver.retire();
  },
);

describe("native permission recovery through the runtime owner", () => {
  it("preserves the MCP process and recorder session while recovering the native helper", async () => {
    const plugin = pluginFixture();
    const app = desktop({
      plugin: plugin.manager,
      nativeRequestTimeoutMs: 100,
    });
    const recorder = recorderFixture();
    await app.controller.start();
    await plugin.ready;
    await recorder.prepare({
      sourceId: "display:1",
      sourceKind: "display",
      systemAudio: false,
      microphone: false,
    });
    await recorder.start();
    const sessionId = recorder.getState().sessionId;
    const command: ComputerUseCommand = {
      id: "plugin",
      kind: "plugin.call",
      payload: { plugin: "mcp", server: "fixture", tool: "pid", arguments: {} },
    };
    const before = await plugin.manager.execute(command);
    expect(before.status).toBe("succeeded");
    const pause = app.native.pause("permissions.state");
    const refresh = app.permissions.refreshComputerUsePermissionState();
    await pause.reached.promise;
    await app.native.closeReached.promise;
    expect(shouldDeferDesktopUpdate(app.controller.getHostState())).toBe(true);
    await refresh;
    pause.resume.resolve();
    expect(app.driver.generation).toBe(2);
    expect(app.controller.getHostState().status).toBe("online");
    expect(plugin.manager.getState().servers[0]?.status).toBe("running");
    const queued = app.claim(command);
    app.timers.run(0);
    queued.response.resolve();
    expect(await queued.completed.promise).toEqual(before);
    queued.completeResponse.resolve();
    await recorder.refreshRecordingStatus();
    expect(recorder.getState()).toMatchObject({
      status: "recording",
      sessionId,
    });
    expect(app.online).toEqual([true]);
  });

  it("coalesces a hung read, retires before one fresh probe, and preserves the host", async () => {
    const app = desktop({ nativeRequestTimeoutMs: 100 });
    await app.controller.start();
    const generation = app.driver.generation;
    const pause = app.native.pause("permissions.state");
    const first = app.permissions.refreshComputerUsePermissionState();
    const second = app.permissions.refreshComputerUsePermissionState();
    await pause.reached.promise;
    const permissions = await Promise.all([first, second]);
    expect(permissions).toEqual([
      expect.objectContaining({ accessibility: true }),
      expect.objectContaining({ accessibility: true }),
    ]);
    expect(app.native.created).toBe(2);
    expect(app.driver.generation).not.toBe(generation);
    expect(app.driver.getCapabilities()).toEqual(
      SUPPORTED_COMPUTER_USE_CAPABILITIES,
    );
    expect(app.events.indexOf("dispose:1")).toBeLessThan(
      app.events.indexOf("create:2"),
    );
    expect(
      app.events.filter((event) => event === "2:permissions.state"),
    ).toHaveLength(1);
    expect(
      app.requests.filter((request) => request.path.endsWith("/hosts/start")),
    ).toHaveLength(1);
    expect(app.recoveries).toEqual([
      expect.objectContaining({ generation, outcome: "recovered" }),
    ]);
    pause.resume.resolve();
    await app.permissions.refreshComputerUsePermissionState();
    expect(app.native.created).toBe(2);
  });

  it("ends a second hung probe without a third generation", async () => {
    const app = desktop({ nativeRequestTimeoutMs: 100 });
    await app.controller.start();
    const first = app.native.pause("permissions.state");
    const result = app.permissions.refreshComputerUsePermissionState();
    const rejected = expect(result).rejects.toThrow();
    await first.reached.promise;
    const second = app.native.pause("permissions.state");
    await second.reached.promise;
    await rejected;
    await app.driver.retire();
    expect(app.native.created).toBe(2);
    expect(app.driver.getCapabilities()).toEqual([]);
    expect(app.controller.getDriverState()).toMatchObject({
      phase: "error",
      canRetry: true,
    });
    expect(app.recoveries).toEqual([
      expect.objectContaining({ outcome: "failed" }),
    ]);
    first.resume.resolve();
    second.resume.resolve();
  });

  it.each([
    [
      "denied",
      {
        status: "succeeded",
        result: { accessibility: false, screenRecording: true },
      },
    ],
    [
      "native denial",
      { status: "failed", error: { code: "permission_denied" } },
    ],
    ["malformed", { status: "succeeded", result: [] }],
  ])(
    "does not retry %s or reinterpret persistent permission grants",
    async (_label, reply) => {
      const app = desktop();
      await app.controller.start();
      app.native.permissions(reply);
      await Promise.allSettled([
        app.permissions.refreshComputerUsePermissionState(),
      ]);
      expect(app.native.created).toBe(1);
      expect(app.driver.getCapabilities()).toEqual([]);
      expect(app.recoveries).toEqual([]);
      if (_label !== "denied")
        expect(
          app.permissions.getComputerUsePermissionState().accessibility,
        ).toBe(true);
    },
  );

  it.each(["stop", "auth", "workspace", "quit", "update", "cancel"] as const)(
    "%s supersedes cleanup and prevents a fresh probe",
    async (action) => {
      const app = desktop({ nativeRequestTimeoutMs: 100 });
      await app.controller.start();
      app.native.holdClose();
      const pause = app.native.pause("permissions.state");
      const abort = new AbortController();
      const refresh = app.permissions.refreshComputerUsePermissionState({
        signal: abort.signal,
      });
      const rejected = expect(refresh).rejects.toThrow();
      await pause.reached.promise;
      await app.native.closeReached.promise;
      let supersede: Promise<void> = Promise.resolve();
      if (action === "stop") supersede = app.controller.stop();
      if (action === "auth") {
        app.authSession.signOut();
        supersede = app.controller.stopForAuthChange();
      }
      if (action === "workspace")
        supersede = app.authSession.selectOrganization();
      if (action === "quit" || action === "update")
        supersede = app.controller.stopForQuit(
          action === "quit" ? "app_quit" : "update_relaunch",
        );
      if (action === "cancel") abort.abort();
      const settledSupersede = Promise.allSettled([supersede]);
      app.native.close();
      pause.resume.resolve();
      await rejected;
      await settledSupersede;
      expect(
        app.recoveries.filter((event) => event.outcome === "recovered"),
      ).toEqual([]);
      expect(
        app.events.filter((event) => event === "2:permissions.state"),
      ).toEqual([]);
      expect(app.driver.getCapabilities()).toEqual([]);
    },
  );

  it("leaves cleanup owned when old helper exit cannot be proven", async () => {
    const app = desktop({
      nativeRequestTimeoutMs: 100,
      nativeShutdownGraceMs: 5,
      expectedQuitError: "did not exit after SIGKILL",
    });
    await app.controller.start();
    app.native.holdClose();
    const pause = app.native.pause("permissions.state");
    const result = app.permissions.refreshComputerUsePermissionState();
    const rejected = expect(result).rejects.toThrow("did not exit");
    await pause.reached.promise;
    await rejected;
    expect(app.native.created).toBe(1);
    expect(app.driver.cleanupPending).toBe(true);
    expect(app.nativeErrors).toContainEqual(
      expect.objectContaining({ stage: "shutdown", exitKnown: false }),
    );
    expect(app.driver.getCapabilities()).toEqual([]);
    pause.resume.resolve();
  });

  it("does not recover a stopped passive probe or a permission prompt", async () => {
    const app = desktop({ nativeRequestTimeoutMs: 100 });
    const pause = app.native.pause("permissions.state");
    const passive = app.permissions.refreshComputerUsePermissionState();
    const rejected = expect(passive).rejects.toThrow("timed out");
    await pause.reached.promise;
    await rejected;
    expect(app.native.created).toBe(1);
    expect(app.recoveries).toEqual([]);
    pause.resume.resolve();
    await app.controller.start({ userInitiated: true });
    const prompt = app.native.pause("permissions.request_accessibility");
    const request = app.permissions.requestComputerUseAccessibilityPermission();
    const promptRejected = expect(request).rejects.toThrow("timed out");
    await prompt.reached.promise;
    await promptRejected;
    expect(app.native.created).toBe(2);
    expect(app.recoveries).toEqual([]);
    prompt.resume.resolve();
  });
});

describe("permission recovery ownership and deadlines", () => {
  it.each([
    "stop",
    "sign-out",
    "workspace",
    "quit",
    "update",
    "cancel",
  ] as const)(
    "%s withdraws a pending fresh probe before a late success",
    async (action) => {
      const app = desktop({ nativeRequestTimeoutMs: 100 });
      await app.controller.start();
      const first = app.native.pause("permissions.state");
      const abort = new AbortController();
      const refresh = app.permissions.refreshComputerUsePermissionState({
        signal: abort.signal,
      });
      const rejected = expect(refresh).rejects.toThrow();
      await first.reached.promise;
      const fresh = app.native.pause("permissions.state");
      await fresh.reached.promise;
      // The original process's buffered result is not fresh-generation readiness.
      first.resume.resolve();
      expect(app.driver.getCapabilities()).toEqual([]);
      let change: Promise<void> = Promise.resolve();
      if (action === "stop") change = app.controller.stop();
      if (action === "sign-out") {
        app.authSession.signOut();
        change = app.controller.stopForAuthChange();
      }
      if (action === "workspace") change = app.authSession.selectOrganization();
      if (action === "quit" || action === "update")
        change = app.controller.stopForQuit(
          action === "quit" ? "app_quit" : "update_relaunch",
        );
      if (action === "cancel") abort.abort();
      const changed = Promise.allSettled([change]);
      fresh.resume.resolve();
      await rejected;
      await changed;
      expect(app.native.created).toBe(2);
      expect(app.driver.getCapabilities()).toEqual([]);
      expect(
        app.recoveries.filter((value) => value.outcome === "recovered"),
      ).toEqual([]);
    },
  );

  it("uses the caller deadline before retry dispatch even when its timer has not run", async () => {
    const app = desktop({ nativeRequestTimeoutMs: 100 });
    await app.controller.start();
    const pause = app.native.pause("permissions.state");
    const deadline = performance.now() + 50;
    const refresh = app.permissions.refreshComputerUsePermissionState({
      deadline,
    });
    const rejected = expect(refresh).rejects.toThrow();
    await pause.reached.promise;
    // Native's real 100ms timer fires; the host's controlled deadline callback
    // stays undelivered. The monotonic deadline must still reject replacement.
    await rejected;
    expect(app.native.created).toBe(1);
    expect(app.driver.getCapabilities()).toEqual([]);
    pause.resume.resolve();
  });

  it("keeps a claimed command in its failed generation through completion reporting", async () => {
    const app = desktop({ nativeRequestTimeoutMs: 100 });
    await app.controller.start();
    const generation = app.driver.generation;
    const pause = app.native.pause("permissions.state");
    const claim = app.claim({
      ...action,
      id: "claimed-before-permission-recovery",
    });
    app.timers.run(5_000);
    claim.response.resolve();
    await pause.reached.promise;
    const refresh = app.permissions.refreshComputerUsePermissionState();
    const completed = await claim.completed.promise;
    expect(completed).toMatchObject({ status: "failed" });
    expect(app.driver.getCapabilities()).toEqual([]);
    expect(app.native.created).toBe(1);
    expect(app.events).not.toContain("1:keyboard.type_text");
    claim.completeResponse.resolve();
    await refresh;
    expect(app.driver.generation).not.toBe(generation);
    expect(app.events).not.toContain("2:keyboard.type_text");
    expect(app.events.indexOf("completion")).toBeLessThan(
      app.events.indexOf("create:2"),
    );
    pause.resume.resolve();
  });

  it("rejects an old snapshot after automatic permission recovery", async () => {
    const app = desktop({ nativeRequestTimeoutMs: 100 });
    await app.controller.start();
    const capture = app.claim({
      id: "capture-before-recovery",
      kind: "app.state",
      payload: { app: "test.app" },
    });
    app.timers.run(5_000);
    capture.response.resolve();
    const completed = await capture.completed.promise;
    const result = completed.result as { snapshotId: string };
    const pause = app.native.pause("permissions.state");
    const refresh = app.permissions.refreshComputerUsePermissionState();
    await pause.reached.promise;
    capture.completeResponse.resolve();
    await refresh;
    const stale = app.claim({
      ...action,
      id: "stale-after-recovery",
      payload: { ...action.payload, snapshotId: result.snapshotId },
    });
    app.timers.run(0);
    stale.response.resolve();
    expect(await stale.completed.promise).toMatchObject({
      status: "failed",
      error: { code: "unsupported_command" },
    });
    expect(app.events).not.toContain("2:keyboard.type_text");
    stale.completeResponse.resolve();
    pause.resume.resolve();
  });
});

it("recovers only the correlated native permission execution deadline", async () => {
  const app = desktop();
  await app.controller.start();
  app.native.holdClose();
  app.native.permissions({
    status: "failed",
    error: { code: "target_app_unresponsive" },
  });
  const refresh = app.permissions.refreshComputerUsePermissionState();
  await app.native.closeReached.promise;
  expect(app.driver.getCapabilities()).toEqual([]);
  app.native.permissions(null);
  app.native.close();
  await expect(refresh).resolves.toMatchObject({
    accessibility: true,
    screenRecording: true,
  });
  expect(app.native.created).toBe(2);
  expect(app.nativeErrors).toEqual([
    expect.objectContaining({
      stage: "timeout",
      requestKind: "permissions.state",
    }),
  ]);
  expect(app.nativeErrors[0]?.timerDelayMs).toBeUndefined();
});

it.each(["throw", "callback"] as const)(
  "settles %s write failures and queued probes without recovery",
  async (mode) => {
    const app = desktop();
    await app.controller.start();
    app.native.failNextWrite(mode);
    const results = await Promise.allSettled([
      app.permissions.refreshComputerUsePermissionState(),
      app.permissions.refreshComputerUsePermissionState(),
    ]);
    expect(results.map((value) => value.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    app.native.close();
    expect(app.native.created).toBe(1);
    expect(app.driver.getCapabilities()).toEqual([]);
    expect(app.nativeErrors).toEqual([
      expect.objectContaining({ stage: "write", pendingRequestCount: 1 }),
    ]);
    expect(app.recoveries).toEqual([]);
  },
);

it("cancels a native heartbeat probe at the existing host deadline", async () => {
  const app = desktop();
  await app.controller.start();
  const pause = app.native.pause("permissions.state");
  app.timers.run(2_000);
  await pause.reached.promise;
  app.timers.run(10_000);
  await app.waitForHostState("recovering");
  expect(app.driver.getCapabilities()).toEqual([]);
  expect(app.native.created).toBe(1);
  expect(app.nativeErrors.filter((error) => error.stage === "timeout")).toEqual(
    [],
  );
  expect(app.recoveries).toEqual([]);
  pause.resume.resolve();
  await app.driver.retire();
});
