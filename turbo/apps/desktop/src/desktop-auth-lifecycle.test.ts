import { setImmediate as nextTurn } from "node:timers/promises";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { MenuItemConstructorOptions } from "electron";
import { DesktopAuthSession } from "./desktop-auth-session";
import type { DesktopAuthWindowRequest } from "./desktop-auth-window";
import { DesktopTrayController } from "./desktop-tray";
import { DeveloperToolsController } from "./desktop-developer-tools-controller";
import { DesktopApplicationMenu } from "./desktop-application-menu";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import {
  ComputerUseDriverController,
  type ComputerUseDriver,
} from "./computer-use-driver";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import { UNAVAILABLE_RECORDER_STATE } from "./desktop-recorder-types";

const native = vi.hoisted(() => ({
  application: [] as MenuItemConstructorOptions[][],
  tray: [] as MenuItemConstructorOptions[][],
}));
vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => template,
    setApplicationMenu: (menu: MenuItemConstructorOptions[]) => {
      native.application.push(menu);
    },
  },
  Tray: class {
    setToolTip() {}
    setImage() {}
    setContextMenu(menu: MenuItemConstructorOptions[]) {
      native.tray.push(menu);
    }
  },
  nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
}));
const api = "https://api.okou.ai";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  native.application = [];
  native.tray = [];
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function developerCheckbox() {
  const submenu = native.application.at(-1)?.[0]?.submenu;
  return Array.isArray(submenu)
    ? submenu.find((item) => item.label === "Developer Tools")
    : undefined;
}

async function desktop() {
  const pending = new Set<Promise<unknown>>();
  const own = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  const settle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  const windows: DesktopAuthWindowRequest[] = [];
  const replies: ReturnType<typeof deferred<string | null>>[] = [];
  const allReplies: typeof replies = [];
  const nativeStarts: string[] = [];
  let lastAuthority: object | null = null;
  let depth = 0;
  let maximumDepth = 0;
  let notifications = 0;
  const session = new DesktopAuthSession({
    apiBaseUrl: api,
    addClientHeaders: createDesktopClientHeaderInjector({
      clientVersion: "1.2.3",
    }),
    tokenUrl: `${api}/token`,
    selectOrgUrl: `${api}/select-org`,
    consumeUrl: () => `${api}/consume`,
    runAuthWindow: async (request) => {
      windows.push(request);
      return await (replies.shift()?.promise ?? Promise.resolve(null));
    },
    onBackgroundRefresh: (event) => runtime.handleBackgroundAuthRefresh(event),
    onChange: () => {
      notifications++;
      // Bound only the old-code reproduction. Production has no depth cap.
      if (depth === 8) return;
      depth++;
      maximumDepth = Math.max(maximumDepth, depth);
      // main.ts orders authority withdrawal, real tray read-back, then the
      // developer refresh. The native backend is not involved in that read-back.
      const authority = session.getAuthority();
      if (authority !== lastAuthority) {
        lastAuthority = authority;
        own(runtime.stopForAuthChange());
      }
      tray.refreshAuth();
      developer.requestRefresh();
      depth--;
    },
  });
  const developer = new DeveloperToolsController({
    getSessionAuthority: () => session.getAuthority(),
    fetchFeatureSwitches: () =>
      own(session.fetchWithSessionAuth(new URL(`${api}/api/feature-switches`))),
    setFilesystemPluginFeatureEnabled: () => {},
    setScreenRecordingFeatureEnabled: () => {},
    onChange: () => {
      menu.refresh();
    },
  });
  const backend = (id: string): never => {
    nativeStarts.push(id);
    throw new Error("Auth/menu reads must not start a native driver");
  };
  const okou: ComputerUseDriver = {
    id: "okou",
    buildVersion: "test",
    createBackend: () => backend("okou"),
  };
  const driver = new ComputerUseDriverController(okou, "darwin");
  const runtime = new ComputerUseRuntimeController({
    driver,
    createRuntime: () => {
      throw new Error("Auth/menu reads must not start a host");
    },
    refreshPermissions: async () => ({
      accessibility: false,
      screenRecording: false,
    }),
    getAuthState: () => own(session.getAuthState()),
    getAuthAuthority: () => session.getAuthority(),
    setHostRuntimeOnline: () => {},
  });
  const menu = new DesktopApplicationMenu({
    displayName: "Okou",
    developerTools: developer,
    updatesEnabled: () => true,
    checkForUpdates: () => {},
    quit: () => {},
  });
  const tray = new DesktopTrayController({
    displayName: "Okou",
    iconPath: "/icon",
    disabledIconPath: "/disabled",
    runningIconPath: "/running",
    getComputerUseState: () => ({
      driver: runtime.getDriverState(),
      platform: "darwin",
      supported: true,
      permissions: { accessibility: false, screenRecording: false },
      host: runtime.getHostState(),
      keepAwake: { enabled: false, active: false },
    }),
    getAuthState: () => own(session.getAuthState()),
    showMainWindow: async () => {
      await session.getAuthState();
    },
    startComputerUse: () => runtime.start(),
    stopComputerUse: () => runtime.stop(),
    refreshStatus: async () => {},
    openSignIn: () => {},
    switchWorkspace: () => session.selectOrganization(),
    signOut: async () => session.signOut(),
    requestAccessibilityPermission: async () => {},
    requestScreenRecordingPermission: async () => {},
    openAccessibilitySettings: () => {},
    openScreenRecordingSettings: () => {},
    setKeepAwakeEnabled: async () => {},
    getRecorderState: () => UNAVAILABLE_RECORDER_STATE,
    startScreenRecording: async () => {},
    stopScreenRecording: async () => {},
    retryScreenRecordingDelivery: async () => {},
    quit: () => menu.dispose(),
  });
  server.use(
    http.get(`${api}/api/auth/me`, ({ request }) => {
      const userId = request.headers.get("authorization");
      return HttpResponse.json({
        userId,
        email: "fixture@example.test",
        orgId: `org-${userId}`,
      });
    }),
    http.get(`${api}/api/org`, ({ request }) =>
      HttpResponse.json({
        id: `org-${request.headers.get("authorization")}`,
        name: "Workspace",
      }),
    ),
    http.get(`${api}/api/feature-switches`, () =>
      HttpResponse.json({ effectiveSwitches: { _debug: true } }),
    ),
  );
  onTestFinished(async () => {
    menu.dispose();
    session.signOut();
    for (const reply of allReplies) reply.resolve(null);
    await settle();
    await runtime.stopForQuit();
  });
  return {
    session,
    developer,
    runtime,
    tray,
    menu,
    windows,
    nativeStarts,
    settle,
    metrics: () => ({ maximumDepth, notifications }),
    reply: () => {
      const reply = deferred<string | null>();
      replies.push(reply);
      allReplies.push(reply);
      return reply;
    },
  };
}

describe("auth/tray/developer composition", () => {
  it("coalesces startup and signed-in restoration while revoking authority synchronously", async () => {
    const app = await desktop();
    const first = app.reply();
    app.tray.install();
    const windowsAtStartup = app.windows.length;
    const startup = app.session.getAuthState();
    first.resolve("startup");
    await startup;
    await app.settle();
    expect(windowsAtStartup).toBe(1);
    await vi.waitFor(() => expect(developerCheckbox()?.checked).toBe(false));
    expect(app.windows).toHaveLength(1);
    expect(app.metrics().maximumDepth).toBe(1);
    expect(app.session.getAuthority()).not.toBeNull();
    expect(app.developer.getState().available).toBe(true);
    const next = app.reply();
    const restore = app.session.getToken({ forceRefresh: true });
    expect(app.session.getCachedToken()).toBeNull();
    expect(app.session.getAuthority()).toBeNull();
    expect(app.developer.getState().available).toBe(false);
    const reopened = [app.session.getAuthState(), app.session.getAuthState()];
    expect(app.windows).toHaveLength(2);
    next.resolve("restored");
    expect(await restore).toBe("restored");
    expect(await Promise.all(reopened)).toEqual([
      expect.objectContaining({ status: "signed_in" }),
      expect.objectContaining({ status: "signed_in" }),
    ]);
    await app.settle();
    await vi.waitFor(() =>
      expect(app.developer.getState().available).toBe(true),
    );
    await nextTurn();
    expect(app.nativeStarts).toEqual([]);
    expect(app.metrics().notifications).toBeLessThan(12);
    expect(native.application.length).toBeLessThan(8);
    const before = native.tray.length;
    app.tray.refresh();
    app.tray.refresh();
    expect(native.tray).toHaveLength(before);
  });

  it.each(["empty", "failed", "cancelled"] as const)(
    "settles %s hidden restoration without reopening or granting authority",
    async (outcome) => {
      const app = await desktop();
      const reply = app.reply();
      app.tray.install();
      const state = app.session.getAuthState();
      if (outcome === "cancelled") app.session.signOut();
      if (outcome === "failed") reply.reject(new Error("Auth window failed"));
      else reply.resolve(outcome === "cancelled" ? "late" : null);
      expect(await state).toMatchObject({ status: "signed_out" });
      await app.settle();
      await vi.waitFor(() =>
        expect(app.developer.getState().available).toBe(false),
      );
      await nextTurn();
      expect(await app.session.getAuthState()).toMatchObject({
        status: "signed_out",
      });
      expect(app.windows).toHaveLength(1);
      expect(app.session.getAuthority()).toBeNull();
      expect(app.developer.getState().available).toBe(false);
      expect(developerCheckbox()).toBeUndefined();
      expect(app.nativeStarts).toEqual([]);
      expect(native.application.length).toBeLessThan(4);
    },
  );

  it("keeps interactive account and workspace changes when an older hidden reply arrives late", async () => {
    const app = await desktop();
    const old = app.reply();
    app.tray.install();
    const explicit = app.reply();
    const signIn = app.session.consumeCode("new-account");
    expect(app.windows[0]?.signal.aborted).toBe(true);
    expect(await app.session.getAuthState()).toMatchObject({
      status: "signing_in",
    });
    explicit.resolve("account");
    await signIn;
    const workspace = app.reply();
    const switchOrg = app.session.selectOrganization();
    expect(app.session.getAuthority()).toBeNull();
    expect(app.developer.getState().available).toBe(false);
    old.resolve("retired");
    workspace.resolve("workspace");
    await switchOrg;
    await app.settle();
    await vi.waitFor(() =>
      expect(app.developer.getState().available).toBe(true),
    );
    expect(app.session.getCachedToken()).toBe("workspace");
    expect(await app.session.getAuthState()).toMatchObject({
      user: { userId: "Bearer workspace" },
      organization: { id: "org-Bearer workspace" },
    });
    expect(app.nativeStarts).toEqual([]);
  });

  it("coalesces a 401 refresh and rejects a late developer grant after sign-out", async () => {
    const app = await desktop();
    const initial = app.reply();
    app.tray.install();
    initial.resolve("expired");
    await app.settle();
    await vi.waitFor(() =>
      expect(app.developer.getState().available).toBe(true),
    );
    const requested = deferred<void>();
    const release = deferred<void>();
    onTestFinished(() => release.resolve());
    server.use(
      // Token rotation preserves the server-verified account and workspace.
      http.get(`${api}/api/auth/me`, () =>
        HttpResponse.json({
          userId: "Bearer expired",
          email: "fixture@example.test",
          orgId: "org-Bearer expired",
        }),
      ),
      http.get(`${api}/api/org`, () =>
        HttpResponse.json({ id: "org-Bearer expired", name: "Workspace" }),
      ),
      http.get(
        `${api}/api/protected`,
        ({ request }) =>
          new HttpResponse(null, {
            status:
              request.headers.get("authorization") === "Bearer expired"
                ? 401
                : 200,
          }),
      ),
      http.get(`${api}/api/feature-switches`, async () => {
        requested.resolve();
        await release.promise;
        return HttpResponse.json({ effectiveSwitches: { _debug: true } });
      }),
    );
    const fresh = app.reply();
    const response = app.session.fetchWithSessionAuth(
      new URL(`${api}/api/protected`),
    );
    await vi.waitFor(() => expect(app.windows).toHaveLength(2));
    expect(app.session.getAuthority()).toBeNull();
    expect(app.developer.getState().available).toBe(false);
    fresh.resolve("fresh");
    expect((await response).status).toBe(200);
    await requested.promise;
    app.session.signOut();
    expect(app.session.getAuthority()).toBeNull();
    expect(app.developer.getState().available).toBe(false);
    release.resolve();
    await app.settle();
    await vi.waitFor(() =>
      expect(app.developer.getState().available).toBe(false),
    );
    expect(app.session.getCachedToken()).toBeNull();
    expect(app.developer.getState().available).toBe(false);
    expect(app.nativeStarts).toEqual([]);
  });
});
