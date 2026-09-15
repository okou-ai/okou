import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  ComputerUseDriverController,
  type ComputerUseDriver,
} from "./computer-use-driver";
import { createComputerUseNativeBackend } from "./computer-use-native";
import { createDesktopComputerUsePermissions } from "./desktop-computer-use-permissions";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import { DeveloperToolsController } from "./desktop-developer-tools-controller";
import { DesktopAuthSession } from "./desktop-auth-session";
import { createDesktopComputerUseHostRuntime } from "./desktop-computer-use-api";
import { DesktopFilesystemPluginManager } from "./desktop-filesystem-plugin";
import { readOrCreateComputerUseInstallationId } from "./desktop-computer-use-installation";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import type { ComputerUseCommand } from "./computer-use-accessibility";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const api = "https://api.okou.ai";
const server = setupServer();
const cleanups: (() => Promise<void>)[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());

function desktop(initial?: string) {
  const directory = mkdtempSync(path.join(tmpdir(), "desktop-auth-recovery-"));
  const file = path.join(directory, "preferences.json");
  const helper = path.join(directory, "helper.cjs");
  const nativeEvents = path.join(directory, "native-events");
  const permissionGate = path.join(directory, "permission-gate");
  const exitRelease = path.join(directory, "exit-release");
  writeFileSync(nativeEvents, "");
  if (initial !== undefined) writeFileSync(file, initial);
  // The actuator is an external process; the real native protocol client,
  // generation owner, executor, auth, host and shared preference writers run.
  writeFileSync(
    helper,
    `#!${process.execPath}
const fs = require('node:fs');
const blocked = fs.existsSync(${JSON.stringify(permissionGate)});
const lines = require('node:readline').createInterface({input:process.stdin});
if (blocked) lines.on('close', () => {
  const watcher = fs.watch(${JSON.stringify(directory)}, () => {
    if (fs.existsSync(${JSON.stringify(exitRelease)})) { watcher.close(); process.exit(0); }
  });
  fs.appendFileSync(${JSON.stringify(nativeEvents)}, 'exit-waiting\\n');
});
fs.appendFileSync(${JSON.stringify(nativeEvents)}, 'start\\n');
lines.on('line', line => {
  const r=JSON.parse(line);
  if (blocked && r.kind === 'permissions.state') {
    fs.appendFileSync(${JSON.stringify(nativeEvents)}, 'permission-waiting\\n');
    return;
  }
  const result=r.kind==='permissions.probe_automation' ? {status:'granted',reason:null} : r.kind.startsWith('permissions.') ? {accessibility:true,screenRecording:true} : {apps:[{name:'Okou fixture',bundleId:'test.editor'}]};
  process.stdout.write(JSON.stringify({id:r.id,status:'succeeded',result})+'\\n');
});
`,
  );
  chmodSync(helper, 0o755);
  let identity = "first";
  const authReplies: Promise<string | null>[] = [];
  let authWindows = 0;
  let rejectIdentityOnce = false;
  let rejectHostStartOnce = false;
  let rejectHostStarts = false;
  const stoppedHostTokens: (string | null)[] = [];
  let debug = true;
  let featureRead: (() => Promise<void>) | null = null;
  const requests: { path: string; body: unknown }[] = [];
  const pending = new Set<Promise<void>>();
  const own = (work: Promise<void>) => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
  };
  const timers = new Map<
    ReturnType<typeof setTimeout>,
    { run: () => void; delay: number }
  >();
  const schedule = (run: () => void, delay: number) => {
    const timer = setTimeout(() => {}, 2 ** 30);
    timer.unref();
    timers.set(timer, { run, delay });
    return timer;
  };
  const clear: typeof clearTimeout = (timer) => {
    if (typeof timer === "object") timers.delete(timer);
    clearTimeout(timer);
  };
  const tick = (delay: number) => {
    const found = [...timers].find(([, item]) => item.delay === delay);
    if (!found) throw new Error(`No lifecycle timer for ${delay}`);
    clear(found[0]);
    found[1].run();
  };
  const headers = createDesktopClientHeaderInjector({
    clientVersion: "1.2.3",
  });
  let authChanged = () => {};
  const auth = new DesktopAuthSession({
    apiBaseUrl: api,
    addClientHeaders: headers,
    tokenUrl: `${api}/token`,
    selectOrgUrl: `${api}/select-org`,
    consumeUrl: () => `${api}/consume`,
    runAuthWindow: async () => {
      authWindows++;
      return await (authReplies.shift() ?? Promise.resolve(identity));
    },
    onChange: () => authChanged(),
    onBackgroundRefresh: (event) =>
      controller.handleBackgroundAuthRefresh(event),
  });
  const developer = new DeveloperToolsController({
    getSessionAuthority: () => auth.getAuthority(),
    fetchFeatureSwitches: () =>
      auth.fetchWithSessionAuth(new URL(`${api}/api/feature-switches`)),
    setFilesystemPluginFeatureEnabled: () => {},
    setScreenRecordingFeatureEnabled: () => {},
    onChange: () => {},
  });
  const okou: ComputerUseDriver = {
    id: "okou",
    buildVersion: "1.2.3",
    createBackend: () => createComputerUseNativeBackend({ helperPath: helper }),
  };
  const driver = new ComputerUseDriverController(okou, "darwin");
  const permissions = createDesktopComputerUsePermissions({
    refreshNative: (query) => controller.refreshNativePermissions(query),
    driver,
  });
  const plugin = new DesktopFilesystemPluginManager({
    preferencesPath: file,
    onChange: () => {},
  });
  let command: ComputerUseCommand | null = null;
  const completed = deferred<unknown>();
  let completionGate: Promise<void> = Promise.resolve();
  let hostStarts = 0;
  const controller = new ComputerUseRuntimeController({
    driver,
    refreshPermissions: permissions.refreshComputerUsePermissionState,
    getAuthState: () => auth.getAuthState(),
    getAuthAuthority: () => auth.getAuthority(),
    setHostRuntimeOnline: (online) => plugin.setHostRuntimeOnline(online),
    getPluginCapabilities: () => plugin.getCapabilities(),
    preparePlugins: () => plugin.prepareForHost(),
    transitionTimeoutMs: 1234,
    lifecycleTimers: { setTimeout: schedule, clearTimeout: clear },
    createRuntime: (options) =>
      createDesktopComputerUseHostRuntime(
        {
          refreshRegistrationAuth: options.refreshRegistrationAuth,
          platformUrl: new URL("https://app.okou.ai"),
          installationId: readOrCreateComputerUseInstallationId(file),
          hostName: "fixture",
          appVersion: "1.2.3",
          addClientHeaders: headers,
          hostFetch: (input, init) => fetch(input, init),
          getPermissions: permissions.refreshReady,
          getSupportedCapabilities: () => [
            ...driver.getCapabilities(),
            ...plugin.getCapabilities(),
          ],
          driver,
          executePluginCommand: (command) => plugin.execute(command),
          setTimeout: schedule,
          clearTimeout: clear,
        },
        { getAuthSession: () => auth },
      ),
  });
  let lastAuth: object | null = null;
  authChanged = () => {
    const current = auth.getAuthority();
    if (lastAuth !== current) {
      lastAuth = current;
      permissions.resetComputerUsePermissionState();
      own(controller.stopForAuthChange());
    }
    developer.requestRefresh();
  };
  server.use(
    http.all(`${api}/*`, async ({ request }) => {
      const url = new URL(request.url);
      const body: unknown =
        request.method === "POST" ? await request.json() : null;
      requests.push({ path: url.pathname, body });
      const user =
        request.headers.get("authorization")?.replace("Bearer ", "") ??
        "unknown";
      if (url.pathname === "/api/auth/me" && rejectIdentityOnce) {
        rejectIdentityOnce = false;
        return new HttpResponse(null, { status: 401 });
      }
      if (url.pathname === "/api/auth/me")
        return HttpResponse.json({
          userId: user,
          email: "fixture@example.test",
          orgId: `org-${user}`,
        });
      if (url.pathname === "/api/org")
        return HttpResponse.json({ id: `org-${user}`, name: "Workspace" });
      if (url.pathname === "/api/feature-switches") {
        const enabled = debug;
        await featureRead?.();
        return HttpResponse.json({ effectiveSwitches: { _debug: enabled } });
      }
      if (url.pathname.endsWith("/hosts/start")) {
        if (rejectHostStartOnce || rejectHostStarts) {
          rejectHostStartOnce = false;
          return new HttpResponse(null, { status: 401 });
        }
        return HttpResponse.json({
          hostId: `host-${++hostStarts}`,
          hostToken: `host-token-${hostStarts}`,
        });
      }
      if (url.pathname.endsWith("/host/stop"))
        stoppedHostTokens.push(request.headers.get("authorization"));
      if (url.pathname.endsWith("/commands/next")) {
        const next = command;
        command = null;
        return HttpResponse.json(
          next
            ? {
                status: "command",
                command: {
                  ...next,
                  timeoutMs: 60_000,
                  createdAt: new Date().toISOString(),
                  claimedAt: new Date().toISOString(),
                },
              }
            : { status: "idle" },
        );
      }
      if (url.pathname.endsWith("/complete")) {
        completed.resolve(body);
        await completionGate;
      }
      return HttpResponse.json({});
    }),
  );
  cleanups.push(async () => {
    await controller.stopForQuit();
    await Promise.allSettled([...pending]);
    plugin.stop();
    for (const timer of timers.keys()) clear(timer);
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    auth,
    developer,
    controller,
    driver,
    permissions,
    requests,
    file,
    plugin,
    directory,
    tick,
    completed,
    expireIdentity: () => {
      rejectIdentityOnce = true;
    },
    rejectHostStart: () => {
      rejectHostStartOnce = true;
    },
    set rejectHostStarts(value: boolean) {
      rejectHostStarts = value;
    },
    acceptedHosts: () => hostStarts,
    stoppedHostTokens,
    authWindows: () => authWindows,
    authReply: (reply: Promise<string | null>) => authReplies.push(reply),
    settle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    holdNativePermissions: () => writeFileSync(permissionGate, "hold"),
    releaseNativeExit: () => {
      rmSync(permissionGate, { force: true });
      writeFileSync(exitRelease, "exit");
    },
    nativeEvents: () => readFileSync(nativeEvents, "utf8"),
    nativeStarts: () =>
      readFileSync(nativeEvents, "utf8").split("start\n").length - 1,
    async authorize() {
      await auth.getAuthState();
      developer.requestRefresh();
      await vi.waitFor(() => expect(developer.getState().available).toBe(true));
    },
    set identity(value: string) {
      identity = value;
    },
    set debug(value: boolean) {
      debug = value;
    },
    set featureRead(value: (() => Promise<void>) | null) {
      featureRead = value;
    },
    set command(value: ComputerUseCommand) {
      command = value;
    },
    set completionGate(value: Promise<void>) {
      completionGate = value;
    },
  };
}

it("starts the native Okou helper using existing installation preferences without rewriting them", async () => {
  const initial = JSON.stringify({
    computerUseInstallationId: "00000000-0000-4000-8000-000000000099",
    computerUseDriver: { experimentalCuaEnabled: true, selectedDriver: "cua" },
    keepAwakeEnabled: true,
    filesystemPlugin: { enabled: false, allowedDirectories: ["/fixture"] },
  });
  const app = desktop(initial);
  await app.authorize();
  await app.controller.start({ userInitiated: true });
  expect(app.controller.getHostState().status).toBe("online");
  expect(app.controller.getDriverState().actual).toMatchObject({
    id: "okou",
    version: "1.2.3",
  });
  expect(app.nativeStarts()).toBe(1);
  expect(readFileSync(app.file, "utf8")).toBe(initial);
});

it.each(["refresh", "sign-out", "quit"] as const)(
  "settles cancelled default-driver permission inspection after %s",
  async (next) => {
    const app = desktop();
    app.holdNativePermissions();
    const stale = app.permissions.refreshComputerUsePermissionState().then(
      () => "published",
      () => "cancelled",
    );
    await vi.waitFor(() =>
      expect(app.nativeEvents()).toContain("permission-waiting"),
    );
    await app.authorize();
    expect(await stale).toBe("cancelled");
    await vi.waitFor(() =>
      expect(app.nativeEvents()).toContain("exit-waiting"),
    );
    expect(
      await app.permissions.probeComputerUseAutomationPermission("chrome"),
    ).toMatchObject({
      automation: { chrome: { status: "unknown" } },
    });
    expect(app.nativeStarts()).toBe(1);
    if (next === "sign-out") app.auth.signOut();
    const quit = next === "quit" ? app.controller.stopForQuit() : null;
    app.releaseNativeExit();
    if (quit) await quit;
    await vi.waitFor(() => expect(app.driver.cleanupPending).toBe(false));
    if (next === "quit") {
      await expect(
        app.permissions.refreshComputerUsePermissionState(),
      ).rejects.toThrow("cancelled");
    } else {
      expect(
        await app.permissions.refreshComputerUsePermissionState(),
      ).toMatchObject({ accessibility: true, screenRecording: true });
    }
    expect(
      await app.permissions.probeComputerUseAutomationPermission("chrome"),
    ).toMatchObject({
      automation: {
        chrome: { status: next === "quit" ? "unknown" : "granted" },
      },
    });
    expect(app.nativeStarts()).toBe(next === "quit" ? 1 : 2);
    expect(app.driver.getCapabilities()).toEqual([]);
    expect(
      app.requests.some((request) => request.path.endsWith("/hosts/start")),
    ).toBe(false);
  },
);

it("recovers Okou after repeated hidden identity refresh and executes a new command", async () => {
  const app = desktop();
  await app.authorize();
  await app.controller.start({ userInitiated: true });
  expect(app.controller.getHostState().status).toBe("online");
  for (let refresh = 0; refresh < 2; refresh++) {
    const previousAuthority = app.auth.getAuthority();
    const previousHost = app.controller.getHostState().hostId;
    app.expireIdentity();
    expect(await app.auth.getAuthState()).toMatchObject({
      status: "signed_in",
    });
    expect(app.auth.getAuthority()).not.toBe(previousAuthority);
    await vi.waitFor(() => {
      expect(app.controller.getHostState().status).toBe("online");
      expect(app.controller.getHostState().hostId).not.toBe(previousHost);
    });
    expect(
      app.requests.filter((request) => request.path.endsWith("/hosts/start")),
    ).toHaveLength(refresh + 2);
    expect(
      app.requests.filter((request) => request.path.endsWith("/host/stop")),
    ).toHaveLength(refresh + 1);
  }
  expect(app.authWindows()).toBe(3);
  app.command = { id: "after-refresh", kind: "apps.list", payload: {} };
  app.tick(5000);
  expect(await app.completed.promise).toMatchObject({ status: "succeeded" });
  await vi.waitFor(() =>
    expect(app.controller.getHostState().localCommandLog).toHaveLength(1),
  );
  expect(app.controller.getHostState().localCommandLog[0]).toMatchObject({
    status: "succeeded",
    driver: { id: "okou" },
  });
});

it.each(["stop", "quit", "sign-out"] as const)(
  "does not recover when %s supersedes a hidden refresh",
  async (action) => {
    const app = desktop();
    await app.authorize();
    await app.controller.start({ userInitiated: true });
    const reply = deferred<string | null>();
    app.authReply(reply.promise);
    app.expireIdentity();
    const refreshing = app.auth.getAuthState();
    try {
      await vi.waitFor(() => expect(app.authWindows()).toBe(2));
      if (action === "stop") await app.controller.stop();
      else if (action === "quit") await app.controller.stopForQuit();
      else app.auth.signOut();
      reply.resolve("first");
      expect(await refreshing).toMatchObject({
        status: action === "sign-out" ? "signed_out" : "signed_in",
      });
      await app.settle();
      await nextTurn();
      expect(app.controller.getHostState().status).toBe("offline");
      expect(
        app.requests.filter((request) => request.path.endsWith("/hosts/start")),
      ).toHaveLength(1);
      expect(app.driver.getCapabilities()).toHaveLength(0);
    } finally {
      reply.resolve(null);
      await refreshing;
    }
  },
);

it.each(["failed", "different identity"] as const)(
  "does not reuse online intent after a hidden refresh returns %s",
  async (outcome) => {
    const app = desktop();
    await app.authorize();
    await app.controller.start({ userInitiated: true });
    app.authReply(Promise.resolve(outcome === "failed" ? null : "second"));
    app.expireIdentity();
    expect(await app.auth.getAuthState()).toMatchObject({
      status: outcome === "failed" ? "signed_out" : "signed_in",
    });
    await app.settle();
    await nextTurn();
    expect(app.controller.getHostState().status).toBe("offline");
    expect(
      app.requests.filter((request) => request.path.endsWith("/hosts/start")),
    ).toHaveLength(1);
    expect(app.driver.getCapabilities()).toHaveLength(0);
  },
);

it("finishes initial hidden authentication triggered by Okou startup", async () => {
  const app = desktop();
  await app.controller.start();
  await vi.waitFor(() =>
    expect(app.controller.getHostState().status).toBe("online"),
  );
  expect(app.authWindows()).toBe(1);
  expect(
    app.requests.filter((request) => request.path.endsWith("/hosts/start")),
  ).toHaveLength(1);
  expect(app.controller.getDriverState().actual).toMatchObject({
    id: "okou",
  });
});

it("preserves a newer manual Start for Okou while hidden authentication is pending", async () => {
  const app = desktop();
  await app.authorize();
  await app.controller.start({ userInitiated: true });
  const reply = deferred<string | null>();
  app.authReply(reply.promise);
  app.expireIdentity();
  const refreshing = app.auth.getAuthState();
  try {
    await vi.waitFor(() => expect(app.authWindows()).toBe(2));
    await app.controller.stop();
    const starting = app.controller.start({ userInitiated: true });
    reply.resolve("first");
    await refreshing;
    await starting;
    await vi.waitFor(() =>
      expect(app.controller.getHostState().status).toBe("online"),
    );
    expect(
      app.requests.filter((request) => request.path.endsWith("/hosts/start")),
    ).toHaveLength(2);
    expect(app.controller.getDriverState().actual).toMatchObject({
      id: "okou",
    });
  } finally {
    reply.resolve(null);
    await refreshing;
  }
});

it("keeps Okou offline when hidden authentication refresh has no online intent", async () => {
  const app = desktop();
  await app.authorize();
  app.expireIdentity();
  expect(await app.auth.getAuthState()).toMatchObject({
    status: "signed_in",
  });
  await app.settle();
  await nextTurn();
  expect(app.controller.getHostState().status).toBe("offline");
  expect(
    app.requests.filter((request) => request.path.endsWith("/hosts/start")),
  ).toHaveLength(0);
  expect(app.nativeStarts()).toBe(0);
});

it("recovers a hidden refresh triggered by host registration without registering a retired owner", async () => {
  const app = desktop();
  await app.authorize();
  app.rejectHostStart();
  await app.controller.start({ userInitiated: true });
  await vi.waitFor(() =>
    expect(app.controller.getHostState().status).toBe("online"),
  );
  app.command = {
    id: "after-registration-refresh",
    kind: "apps.list",
    payload: {},
  };
  app.tick(5000);
  expect(await app.completed.promise).toMatchObject({ status: "succeeded" });
  await vi.waitFor(() =>
    expect(app.controller.getHostState().localCommandLog).toHaveLength(1),
  );
  await app.settle();
  expect({
    registrationAttempts: app.requests.filter((request) =>
      request.path.endsWith("/hosts/start"),
    ).length,
    acceptedHosts: app.acceptedHosts(),
    stoppedHostTokens: app.stoppedHostTokens,
    onlineHost: app.controller.getHostState().hostId,
    nativeStarts: app.nativeStarts(),
    nativeActive: app.driver.getCapabilities().length > 0,
  }).toEqual({
    registrationAttempts: 2,
    acceptedHosts: 1,
    stoppedHostTokens: [],
    onlineHost: "host-1",
    nativeStarts: 2,
    nativeActive: true,
  });
});

it("keeps a terminal registration error after developer access is refreshed", async () => {
  const app = desktop();
  await app.authorize();
  const unexpectedRefresh = deferred<string | null>();
  app.authReply(Promise.resolve("first"));
  // Bound a broken automatic retry loop without granting another refresh.
  app.authReply(unexpectedRefresh.promise);
  app.rejectHostStarts = true;
  try {
    await app.controller.start({ userInitiated: true });
    await vi.waitFor(() =>
      expect(app.controller.getHostState().status).toBe("error"),
    );
    expect(app.authWindows()).toBe(2);
    expect(
      app.requests.filter((request) => request.path.endsWith("/hosts/start")),
    ).toHaveLength(2);
    expect(app.acceptedHosts()).toBe(0);

    app.developer.requestRefresh();
    await vi.waitFor(() =>
      expect(app.developer.getState().available).toBe(true),
    );
    await app.settle();
    await nextTurn();
    expect(app.controller.getHostState().status).toBe("error");
    expect(app.authWindows()).toBe(2);
    expect(
      app.requests.filter((request) => request.path.endsWith("/hosts/start")),
    ).toHaveLength(2);
    expect(app.acceptedHosts()).toBe(0);
  } finally {
    app.auth.signOut();
    unexpectedRefresh.resolve(null);
  }
});
