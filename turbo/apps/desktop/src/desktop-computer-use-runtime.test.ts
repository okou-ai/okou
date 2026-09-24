import { ComputerUseDriverController } from "./computer-use-driver";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import { createComputerUseNativeBackend } from "./computer-use-native";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { resolveDesktopConfig } from "./config";
import { DesktopAuthSession } from "./desktop-auth-session";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthTokenUrl,
} from "./desktop-auth";
import type { DesktopAuthWindowRequest } from "./desktop-auth-window";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import { createDesktopComputerUseHostRuntime } from "./desktop-computer-use-api";
import type { ComputerUseHostRuntime } from "./computer-use-host";
import type { ComputerUsePermissionState } from "./computer-use-types";

const api = "https://api.okou.ai";
const startUrl = `${api}/api/computer-use/hosts/start`;
const permissions = { accessibility: true, screenRecording: true };
const server = setupServer();
const runtimes: ComputerUseHostRuntime[] = [];
const controllers: ComputerUseRuntimeController[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(async () => {
  for (const controller of controllers.splice(0))
    await controller.stopForQuit();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
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

function createDesktop() {
  const config = resolveDesktopConfig();
  const windows: DesktopAuthWindowRequest[] = [];
  const replies: Promise<string | null>[] = [];
  const requests: Request[] = [];
  const cleanup: Promise<void>[] = [];
  let controller: ComputerUseRuntimeController | null = null;
  let lastAuthority: object | null = null;
  const addClientHeaders = createDesktopClientHeaderInjector({
    clientVersion: "1.2.3",
  });
  const authSession = new DesktopAuthSession({
    apiBaseUrl: api,
    addClientHeaders,
    tokenUrl: buildDesktopAuthTokenUrl(config.authUrl),
    selectOrgUrl: buildDesktopAuthSelectOrgUrl(config.authUrl, true),
    consumeUrl: (code, id) =>
      buildDesktopAuthConsumeUrl(config.authUrl, code, id),
    runAuthWindow: async (request) => {
      windows.push(request);
      return await (replies.shift() ?? Promise.resolve(null));
    },
    onChange: () => {
      const authority = authSession.getAuthority();
      if (lastAuthority !== authority) {
        lastAuthority = authority;
        if (controller) cleanup.push(controller.stopForAuthChange());
      }
    },
    onBackgroundRefresh: (event) =>
      controller?.handleBackgroundAuthRefresh(event),
  });
  server.use(
    http.all(`${api}/*`, ({ request }) => {
      requests.push(request);
      switch (new URL(request.url).pathname) {
        case "/api/auth/me":
          return HttpResponse.json({
            userId: "app-user",
            email: "app@example.test",
            orgId: "app-org",
            sessionId: "session-app-user",
          });
        case "/api/org":
          return HttpResponse.json({ id: "app-org", name: "App workspace" });
        case "/api/computer-use/hosts/start":
          return hostStarted();
        default:
          return HttpResponse.json({ status: "idle" });
      }
    }),
  );
  function createRuntime(
    options: {
      refreshRegistrationAuth?: boolean;
      platformUrl?: URL;
      getPermissions?: () => Promise<ComputerUsePermissionState>;
    } = {},
  ) {
    // This is the same construction entry point used by main.ts. Keep both
    // the runtime and auth session real so an alternate request policy fails.
    const runtime = createDesktopComputerUseHostRuntime(
      {
        refreshRegistrationAuth: options.refreshRegistrationAuth,
        platformUrl: options.platformUrl ?? config.platformUrl,
        installationId: "00000000-0000-4000-8000-000000000001",
        hostName: "test-host",
        appVersion: "1.2.3",
        addClientHeaders,
        hostFetch: (input, init) => fetch(input, init),
        getPermissions: options.getPermissions ?? (() => permissions),
        driver: new ComputerUseDriverController({
          id: "okou",
          createBackend: () => createComputerUseNativeBackend(),
        }),
        executePluginCommand: async () => ({ status: "succeeded", result: {} }),
      },
      {
        getAuthSession: () => authSession,
      },
    );
    runtimes.push(runtime);
    return runtime;
  }
  return {
    authSession,
    windows,
    replies,
    requests,
    createRuntime,
    createController: () => {
      controller = new ComputerUseRuntimeController({
        createRuntime,
        refreshPermissions: async () => permissions,
        getAuthState: () => authSession.getAuthState(),
        getAuthAuthority: () => authSession.getAuthority(),
        setHostRuntimeOnline: () => {},
      });
      controllers.push(controller);
      return controller;
    },
    settleCleanup: async () => {
      while (cleanup.length) await Promise.all(cleanup.splice(0));
    },
  };
}

function hostStarted() {
  return HttpResponse.json({ hostId: "host-1", hostToken: "host-token" });
}

function expectAppRequest(request: Request) {
  expect(new URL(request.url).origin).toBe(api);
  expect(request.headers.get("cookie")).toBeNull();
  expect(request.credentials).toBe("omit");
  expect(request.redirect).toBe("error");
  expect(request.headers.get("x-client-product")).toBe("okou");
  expect(request.headers.get("x-client-type")).toBe("Desktop");
  expect(request.headers.get("x-client-version")).toBe("1.2.3");
  expect(request.headers.get("x-client-session-id")).toBeTruthy();
  expect(request.headers.get("x-client-request-id")).toBeTruthy();
}

describe("production Okou Computer Use session wiring", () => {
  it("requires an App token before host start or the auth probe", async () => {
    const desktop = createDesktop();
    const runtime = desktop.createRuntime();
    await runtime.start();
    expect(runtime.getState().status).toBe("unauthenticated");
    expect(desktop.requests).toEqual([]);
    expect(desktop.windows.map((window) => window.url)).toEqual([
      "https://app.okou.ai/desktop-auth/token",
    ]);
  });

  it("starts under the validated App bearer and required client headers", async () => {
    const desktop = createDesktop();
    desktop.replies.push(Promise.resolve("app-token"));
    const runtime = desktop.createRuntime();
    await runtime.start();
    expect(runtime.getState()).toMatchObject({
      status: "online",
      hostId: "host-1",
    });
    expect(
      desktop.requests.map((request) => new URL(request.url).pathname),
    ).toEqual(["/api/auth/me", "/api/org", "/api/computer-use/hosts/start"]);
    for (const request of desktop.requests) {
      expectAppRequest(request);
      expect(request.headers.get("authorization")).toBe("Bearer app-token");
    }
  });

  it.each(["fresh", null, "rejected"])(
    "bounds a 401 refresh delivering %s without a cookie request or probe bypass",
    async (refreshed) => {
      const desktop = createDesktop();
      const controller = desktop.createController();
      desktop.replies.push(
        Promise.resolve("expired"),
        Promise.resolve(refreshed),
      );
      await desktop.authSession.getToken();
      const starts: Request[] = [];
      server.use(
        http.get(`${api}/api/auth/me`, ({ request }) => {
          desktop.requests.push(request);
          return request.headers.get("authorization") === "Bearer rejected"
            ? new HttpResponse(null, { status: 401 })
            : HttpResponse.json({
                userId: "app-user",
                email: "app@example.test",
                orgId: "app-org",
                sessionId: "session-app-user",
              });
        }),
        http.post(startUrl, ({ request }) => {
          starts.push(request);
          return request.headers.get("authorization") === "Bearer fresh"
            ? hostStarted()
            : new HttpResponse(null, { status: 401 });
        }),
      );
      await controller.start();
      await expect
        .poll(() => controller.getHostState().status)
        .toBe(refreshed === "fresh" ? "online" : "offline");
      expect(await desktop.authSession.getAuthState()).toMatchObject({
        status: refreshed === "fresh" ? "signed_in" : "signed_out",
      });
      await desktop.settleCleanup();
      expect(
        starts.map((request) => request.headers.get("authorization")),
      ).toEqual(
        refreshed === "fresh"
          ? ["Bearer expired", "Bearer fresh"]
          : ["Bearer expired"],
      );
      for (const request of [...desktop.requests, ...starts])
        expectAppRequest(request);
      expect(
        new Set(
          starts.map((request) => request.headers.get("x-client-request-id")),
        ).size,
      ).toBe(starts.length);
      expect(desktop.windows.map((window) => window.url)).toEqual([
        "https://app.okou.ai/desktop-auth/token",
        "https://app.okou.ai/desktop-auth/token",
      ]);
    },
  );

  it("bounds automatic recovery when host registration rejects a newly validated bearer", async () => {
    const desktop = createDesktop();
    const controller = desktop.createController();
    const unexpectedRefresh = deferred<string | null>();
    // A third window is held only to bound the old-code reproduction. Both
    // supplied bearers pass the real identity validation HTTP contract.
    desktop.replies.push(
      Promise.resolve("expired"),
      Promise.resolve("fresh"),
      unexpectedRefresh.promise,
    );
    await desktop.authSession.getToken();
    const starts: Request[] = [];
    server.use(
      http.post(startUrl, ({ request }) => {
        starts.push(request);
        return request.headers.get("authorization") === "Bearer retry"
          ? hostStarted()
          : new HttpResponse(null, { status: 401 });
      }),
    );
    try {
      await controller.start();
      await expect
        .poll(() => ({
          status: controller.getHostState().status,
          authWindows: desktop.windows.length,
        }))
        .toEqual({ status: "error", authWindows: 2 });
      expect(
        starts.map((request) => request.headers.get("authorization")),
      ).toEqual(["Bearer expired", "Bearer fresh"]);
      expect(controller.getHostState().hostId).toBeNull();

      // Only an explicit Start may spend a new refresh budget after failure.
      unexpectedRefresh.resolve("retry");
      await controller.start({ userInitiated: true });
      await expect.poll(() => controller.getHostState().status).toBe("online");
      expect(desktop.windows).toHaveLength(3);
      expect(
        starts.map((request) => request.headers.get("authorization")),
      ).toEqual([
        "Bearer expired",
        "Bearer fresh",
        "Bearer fresh",
        "Bearer retry",
      ]);
      expect(await desktop.authSession.getAuthState()).toMatchObject({
        status: "signed_in",
      });
      expect(controller.getHostState().hostId).toBe("host-1");
      for (const request of [...desktop.requests, ...starts])
        expectAppRequest(request);
    } finally {
      desktop.authSession.signOut();
      unexpectedRefresh.resolve(null);
      await controller.stopForQuit();
      await desktop.settleCleanup();
    }
  });

  it("refuses redirects from host registration without exposing credentials to the target", async () => {
    const desktop = createDesktop();
    desktop.replies.push(Promise.resolve("app-token"));
    const leaked: string[] = [];
    server.use(
      http.post(startUrl, () =>
        HttpResponse.redirect("https://untrusted.test/host", 307),
      ),
      http.all("https://untrusted.test/*", ({ request }) => {
        leaked.push(request.url);
        return hostStarted();
      }),
    );
    const runtime = desktop.createRuntime();
    await runtime.start();
    expect(runtime.getState().hostId).toBeNull();
    expect(runtime.getState().status).not.toBe("online");
    expect(leaked).toEqual([]);
  });

  it("pins a runtime request to the auth session's exact API origin", async () => {
    const desktop = createDesktop();
    desktop.replies.push(Promise.resolve("app-token"));
    const runtime = desktop.createRuntime({
      platformUrl: new URL("https://api.okou.ai:444"),
    });
    await runtime.start();
    expect(runtime.getState()).toMatchObject({
      hostId: null,
      lastError: "Invalid Desktop API origin",
    });
    expect(desktop.requests.map((request) => request.url)).toEqual([
      `${api}/api/auth/me`,
      `${api}/api/org`,
    ]);
  });

  it("blocks an existing runtime after synchronous sign-out while startup is awaiting permissions", async () => {
    const desktop = createDesktop();
    desktop.replies.push(Promise.resolve("app-token"));
    await desktop.authSession.getToken();
    desktop.requests.length = 0;
    const entered = deferred<void>();
    const release = deferred<ComputerUsePermissionState>();
    const runtime = desktop.createRuntime({
      getPermissions: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const starting = runtime.start();
    await entered.promise;
    desktop.authSession.signOut();
    release.resolve(permissions);
    await starting;
    expect(runtime.getState().status).toBe("unauthenticated");
    expect(desktop.requests).toEqual([]);
    expect(desktop.windows).toHaveLength(1);
  });

  it("cancels an in-flight host start and cannot restart through cookies after sign-out", async () => {
    const desktop = createDesktop();
    desktop.replies.push(Promise.resolve("app-token"));
    await desktop.authSession.getToken();
    desktop.requests.length = 0;
    const entered = deferred<void>();
    const release = deferred<void>();
    const starts: Request[] = [];
    server.use(
      http.post(startUrl, async ({ request }) => {
        starts.push(request);
        entered.resolve();
        await release.promise;
        return hostStarted();
      }),
    );
    const runtime = desktop.createRuntime();
    const starting = runtime.start();
    await entered.promise;
    desktop.authSession.signOut();
    release.resolve();
    await starting;
    expect(runtime.getState().hostId).toBeNull();
    expect(starts[0]?.signal.aborted).toBe(true);
    await runtime.stop();
    await runtime.start();
    expect(runtime.getState().status).toBe("unauthenticated");
    expect(starts).toHaveLength(1);
    expect(desktop.requests).toEqual([]);
  });

  it("discards a late refresh delivery after sign-out before runtime teardown", async () => {
    const desktop = createDesktop();
    desktop.replies.push(Promise.resolve("expired"));
    await desktop.authSession.getToken();
    desktop.requests.length = 0;
    const reply = deferred<string | null>();
    desktop.replies.push(reply.promise);
    let starts = 0;
    server.use(
      http.post(startUrl, () => {
        starts++;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    const runtime = desktop.createRuntime();
    const starting = runtime.start();
    // The queued window is the observable refresh boundary, not a timer.
    await expect.poll(() => desktop.windows.length).toBe(2);
    desktop.authSession.signOut();
    reply.resolve("late-token");
    await starting;
    expect(runtime.getState().status).toBe("unauthenticated");
    expect(desktop.authSession.getCachedToken()).toBeNull();
    expect(starts).toBe(1);
    expect(desktop.requests).toEqual([]);
    expect(desktop.windows[1]?.signal.aborted).toBe(true);
  });
});
