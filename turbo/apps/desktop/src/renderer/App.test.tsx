// @vitest-environment happy-dom

import { stoppedOkouDriverState } from "../test/desktop-driver-state";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComputerUseHostRuntimeStatus,
  type ComputerUsePermissionState,
  type DesktopComputerUsePluginsState,
  type DesktopComputerUseState,
  type DesktopComputerUseDriverState,
  type DesktopKeepAwakeState,
} from "../computer-use-types";
import type {
  DesktopAuthApi,
  DesktopAuthState,
  DesktopComputerUseApi,
  DesktopDeveloperToolsApi,
  DesktopDeveloperToolsState,
} from "../desktop-bridge";
import { App } from "./App";
import { settleDesktopActions } from "./async-action";

const signedInAuthState: DesktopAuthState = {
  status: "signed_in",
  user: {
    userId: "user_test",
    email: "desktop@example.com",
  },
  organization: {
    id: "org_test",
    name: "Desktop Team",
  },
};

const signedOutAuthState: DesktopAuthState = {
  status: "signed_out",
  user: null,
  organization: null,
};

const defaultDeveloperToolsState: DesktopDeveloperToolsState = {
  available: false,
  enabled: false,
};

function createComputerUsePluginsState(): DesktopComputerUsePluginsState {
  return {
    filesystem: {
      featureEnabled: true,
      enabled: false,
      allowedDirectories: [],
      status: "disabled",
      lastError: null,
      version: "2026.1.14",
      capabilities: [],
    },
    mcp: {
      featureEnabled: true,
      servers: [],
    },
  };
}

function createComputerUseState({
  deviceName = "lisa",
  keepAwake = { active: false, enabled: false },
  permissions = { accessibility: true, screenRecording: true },
  plugins,
  status = "offline",
}: {
  readonly deviceName?: string | null;
  readonly keepAwake?: DesktopKeepAwakeState;
  readonly permissions?: ComputerUsePermissionState;
  readonly plugins?: DesktopComputerUsePluginsState;
  readonly status?: ComputerUseHostRuntimeStatus;
} = {}): DesktopComputerUseState {
  return {
    driver: stoppedOkouDriverState,
    platform: "darwin",
    supported: true,
    deviceName,
    permissions,
    host: {
      status,
      hostId: status === "online" ? "host_test" : null,
      lastHeartbeatAt: null,
      lastCommandAt: null,
      lastError: null,
      recovery: null,
      errorLog: [],
      localCommandLog: [],
    },
    keepAwake,
    plugins,
  };
}

function createComputerUseBridge(initialState: DesktopComputerUseState): {
  readonly api: DesktopComputerUseApi;
  readonly emitState: (nextState: DesktopComputerUseState) => void;
  readonly getState: ReturnType<
    typeof vi.fn<DesktopComputerUseApi["getState"]>
  >;
  readonly start: ReturnType<typeof vi.fn<DesktopComputerUseApi["start"]>>;
  readonly probeAutomationPermission: ReturnType<
    typeof vi.fn<DesktopComputerUseApi["probeAutomationPermission"]>
  >;
  readonly subscribe: ReturnType<
    typeof vi.fn<DesktopComputerUseApi["subscribe"]>
  >;
} {
  let currentState = initialState;
  const subscribers = new Set<() => void>();
  const getState = vi.fn<DesktopComputerUseApi["getState"]>(async () => {
    return currentState;
  });
  const refreshPermissions = vi.fn<DesktopComputerUseApi["refreshPermissions"]>(
    async () => {
      return currentState;
    },
  );
  const start = vi.fn<DesktopComputerUseApi["start"]>(async () => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: currentState.permissions,
      status: "online",
    });
    return currentState;
  });
  const stop = vi.fn<DesktopComputerUseApi["stop"]>(async () => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: currentState.permissions,
    });
    return currentState;
  });
  const requestAccessibilityPermission = vi.fn<
    DesktopComputerUseApi["requestAccessibilityPermission"]
  >(async () => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: {
        ...currentState.permissions,
        accessibility: true,
      },
      status: currentState.host.status,
    });
    return currentState;
  });
  const requestScreenRecordingPermission = vi.fn<
    DesktopComputerUseApi["requestScreenRecordingPermission"]
  >(async () => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: {
        ...currentState.permissions,
        screenRecording: true,
      },
      status: currentState.host.status,
    });
    return currentState;
  });
  const probeAutomationPermission = vi.fn<
    DesktopComputerUseApi["probeAutomationPermission"]
  >(async (target) => {
    currentState = createComputerUseState({
      keepAwake: currentState.keepAwake,
      permissions: {
        ...currentState.permissions,
        automation: {
          chrome: {
            status: "unknown",
            updatedAt: null,
            reason: null,
          },
          safari: {
            status: "unknown",
            updatedAt: null,
            reason: null,
          },
          [target]: {
            status: "granted",
            updatedAt: "2026-06-22T00:00:00.000Z",
            reason: null,
          },
        },
      },
      status: currentState.host.status,
    });
    return currentState;
  });
  const setKeepAwakeEnabled = vi.fn<
    DesktopComputerUseApi["setKeepAwakeEnabled"]
  >(async (enabled) => {
    currentState = createComputerUseState({
      keepAwake: {
        active: enabled,
        enabled,
      },
      permissions: currentState.permissions,
      status: currentState.host.status,
    });
    return currentState;
  });
  const setFilesystemPluginEnabled = vi.fn<
    DesktopComputerUseApi["setFilesystemPluginEnabled"]
  >(async () => {
    return currentState;
  });
  const addFilesystemPluginAllowedDirectory = vi.fn<
    DesktopComputerUseApi["addFilesystemPluginAllowedDirectory"]
  >(async () => {
    return currentState;
  });
  const removeFilesystemPluginAllowedDirectory = vi.fn<
    DesktopComputerUseApi["removeFilesystemPluginAllowedDirectory"]
  >(async () => {
    return currentState;
  });
  const subscribe = vi.fn<DesktopComputerUseApi["subscribe"]>((callback) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  const api: DesktopComputerUseApi = {
    getState,
    refreshPermissions,
    start,
    stop,
    requestAccessibilityPermission,
    requestScreenRecordingPermission,
    probeAutomationPermission,
    setKeepAwakeEnabled,
    setFilesystemPluginEnabled,
    addFilesystemPluginAllowedDirectory,
    removeFilesystemPluginAllowedDirectory,
    importMcpPluginServers: vi.fn<
      DesktopComputerUseApi["importMcpPluginServers"]
    >(async () => {
      return currentState;
    }),
    setMcpPluginServerEnabled: vi.fn<
      DesktopComputerUseApi["setMcpPluginServerEnabled"]
    >(async () => {
      return currentState;
    }),
    removeMcpPluginServer: vi.fn<
      DesktopComputerUseApi["removeMcpPluginServer"]
    >(async () => {
      return currentState;
    }),
    openAccessibilitySettings: vi.fn<
      DesktopComputerUseApi["openAccessibilitySettings"]
    >(async () => {}),
    openScreenRecordingSettings: vi.fn<
      DesktopComputerUseApi["openScreenRecordingSettings"]
    >(async () => {}),
    openAutomationSettings: vi.fn<
      DesktopComputerUseApi["openAutomationSettings"]
    >(async () => {}),
    subscribe,
  };

  return {
    api,
    emitState: (nextState) => {
      currentState = nextState;
      for (const subscriber of subscribers) {
        subscriber();
      }
    },
    getState,
    probeAutomationPermission,
    start,
    subscribe,
  };
}

function createAuthBridge(initialState: DesktopAuthState): {
  readonly api: DesktopAuthApi;
  readonly getState: ReturnType<typeof vi.fn<DesktopAuthApi["getState"]>>;
  readonly openSignIn: ReturnType<typeof vi.fn<DesktopAuthApi["openSignIn"]>>;
} {
  let currentState = initialState;
  const subscribers = new Set<() => void>();
  const getState = vi.fn<DesktopAuthApi["getState"]>(async () => {
    return currentState;
  });
  const openSignIn = vi.fn<DesktopAuthApi["openSignIn"]>(async () => {});
  const openOrgSelection = vi.fn<DesktopAuthApi["openOrgSelection"]>(
    async () => {},
  );
  const signOut = vi.fn<DesktopAuthApi["signOut"]>(async () => {
    currentState = signedOutAuthState;
    for (const subscriber of subscribers) {
      subscriber();
    }
  });
  const subscribe = vi.fn<DesktopAuthApi["subscribe"]>((callback) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  const api: DesktopAuthApi = {
    getState,
    openSignIn,
    openOrgSelection,
    signOut,
    completeSignIn: vi.fn<DesktopAuthApi["completeSignIn"]>(async () => {}),
    subscribe,
  };

  return {
    api,
    getState,
    openSignIn,
  };
}

function createDeveloperToolsBridge(initialState: DesktopDeveloperToolsState): {
  readonly api: DesktopDeveloperToolsApi;
  readonly emitState: (nextState: DesktopDeveloperToolsState) => void;
  readonly getState: ReturnType<
    typeof vi.fn<DesktopDeveloperToolsApi["getState"]>
  >;
  readonly subscribe: ReturnType<
    typeof vi.fn<DesktopDeveloperToolsApi["subscribe"]>
  >;
} {
  let currentState = initialState;
  const subscribers = new Set<() => void>();
  const getState = vi.fn<DesktopDeveloperToolsApi["getState"]>(async () => {
    return currentState;
  });
  const setEnabled = vi.fn<DesktopDeveloperToolsApi["setEnabled"]>(
    async (enabled) => {
      currentState = {
        available: currentState.available,
        enabled: currentState.available && enabled,
      };
      return currentState;
    },
  );
  const subscribe = vi.fn<DesktopDeveloperToolsApi["subscribe"]>((callback) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  const api: DesktopDeveloperToolsApi = {
    getState,
    setEnabled,
    subscribe,
  };

  return {
    api,
    emitState: (nextState) => {
      currentState = nextState;
      for (const subscriber of subscribers) {
        subscriber();
      }
    },
    getState,
    subscribe,
  };
}

function installDesktopBridges({
  authState = signedInAuthState,
  computerUseState = createComputerUseState(),
  developerToolsState = defaultDeveloperToolsState,
}: {
  readonly authState?: DesktopAuthState;
  readonly computerUseState?: DesktopComputerUseState;
  readonly developerToolsState?: DesktopDeveloperToolsState;
} = {}): {
  readonly auth: ReturnType<typeof createAuthBridge>;
  readonly computerUse: ReturnType<typeof createComputerUseBridge>;
  readonly developerTools: ReturnType<typeof createDeveloperToolsBridge>;
} {
  const auth = createAuthBridge(authState);
  const computerUse = createComputerUseBridge(computerUseState);
  const developerTools = createDeveloperToolsBridge(developerToolsState);
  window.vm0DesktopAuth = auth.api;
  window.okouDesktopComputerUse = computerUse.api;
  window.okouDesktopDeveloperTools = developerTools.api;
  return {
    auth,
    computerUse,
    developerTools,
  };
}

function buttonForText(text: string): HTMLButtonElement {
  const button = screen.getByText(text).closest("button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button for ${text}`);
  }
  return button;
}

function renderDesktopApp(): void {
  window.okouDesktopIdentity = {
    product: "okou",
    brandName: "Okou",
    displayName: "Okou",
  };
  render(
    <StoreProvider value={createStore()}>
      <App />
    </StoreProvider>,
  );
}

afterEach(async () => {
  await settleDesktopActions();
  cleanup();
  delete window.vm0DesktopAuth;
  delete window.okouDesktopComputerUse;
  delete window.okouDesktopDeveloperTools;
  vi.clearAllMocks();
});

describe("Desktop renderer bridge integration", () => {
  it("shows the online host and the existing developer panels", async () => {
    installDesktopBridges({
      computerUseState: createComputerUseState({
        status: "online",
        plugins: createComputerUsePluginsState(),
      }),
      developerToolsState: { available: true, enabled: true },
    });
    renderDesktopApp();
    expect(await screen.findAllByText("Online")).toHaveLength(2);
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Filesystem plugin", "MCP servers", "Runtime", "Command Log"]);
  });

  it("keeps explicit native recovery reachable from permission setup", async () => {
    const driver: DesktopComputerUseDriverState = {
      ...stoppedOkouDriverState,
      phase: "error",
      error:
        "Native driver permission check failed. Explicit recovery is required.",
      canRetry: true,
    };
    const { computerUse } = installDesktopBridges({
      computerUseState: {
        ...createComputerUseState({
          permissions: { accessibility: false, screenRecording: false },
        }),
        driver,
      },
    });
    renderDesktopApp();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert").textContent).toContain(
      "permission check failed",
    );
    expect(computerUse.start).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(computerUse.start).toHaveBeenCalledWith({ userInitiated: true }),
    );
  });

  it("keeps Stop available while native cleanup blocks Retry", async () => {
    const { computerUse } = installDesktopBridges({
      computerUseState: {
        ...createComputerUseState({
          permissions: { accessibility: false, screenRecording: false },
        }),
        driver: {
          ...stoppedOkouDriverState,
          phase: "retiring",
          cleanupPending: true,
          canRetry: false,
        },
      },
    });
    const stop = vi.spyOn(computerUse.api, "stop");
    renderDesktopApp();
    await screen.findByText(/Cleanup is still pending/);
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.hasAttribute("disabled")).toBe(true);
    fireEvent.click(retry);
    expect(computerUse.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("shows Okou identity and fresh permission guidance", async () => {
    installDesktopBridges({
      authState: { status: "signed_out", user: null, organization: null },
      computerUseState: createComputerUseState({
        permissions: { accessibility: false, screenRecording: false },
      }),
    });

    renderDesktopApp();

    expect(await screen.findByRole("img", { name: "Okou" })).toBeTruthy();
    expect(await screen.findByText("Sign in to Okou")).toBeTruthy();
  });

  it("shows a Desktop bridge fallback when preload did not expose the computer use bridge", async () => {
    renderDesktopApp();

    expect(await screen.findByText("Desktop bridge unavailable.")).toBeTruthy();
  });

  it("loads ready runtime state from the desktop bridges and starts computer use", async () => {
    const { auth, computerUse } = installDesktopBridges();
    renderDesktopApp();

    expect(
      await screen.findByText("desktop@example.com · Desktop Team"),
    ).toBeTruthy();
    // Permission status is a quiet dot in the footer (auto-checked, no button).
    expect(
      screen.getByTitle("Accessibility and screen recording granted"),
    ).toBeTruthy();
    expect(await screen.findByText("Offline")).toBeTruthy();
    // The permission status updates automatically; there is no manual refresh.
    expect(screen.queryByText("Refresh")).toBeNull();

    fireEvent.click(buttonForText("Go online"));

    await waitFor(() => {
      expect(computerUse.start).toHaveBeenCalledWith({
        userInitiated: true,
      });
    });
    expect(await screen.findByText("Online")).toBeTruthy();
    expect(screen.queryByText("Browser Automation")).toBeNull();
    // The online hero labels this Mac by its friendly device name.
    expect(await screen.findByText("lisa")).toBeTruthy();
    expect(auth.getState).toHaveBeenCalled();
    expect(computerUse.getState).toHaveBeenCalled();
  });

  it("probes browser automation from an explicit user action", async () => {
    const { computerUse } = installDesktopBridges({
      computerUseState: createComputerUseState({
        permissions: { accessibility: false, screenRecording: true },
      }),
    });
    renderDesktopApp();

    expect(await screen.findByText("Browser Automation")).toBeTruthy();
    expect(
      await screen.findByText(
        "Optional for browser control. Test only the browser you use.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("Not tested")).toBeTruthy();
    expect(computerUse.probeAutomationPermission).not.toHaveBeenCalled();

    fireEvent.click(buttonForText("Test Chrome"));

    await waitFor(() => {
      expect(computerUse.probeAutomationPermission).toHaveBeenCalledWith(
        "chrome",
      );
    });
  });

  it("treats browser automation as ready when one browser is approved", async () => {
    installDesktopBridges({
      computerUseState: createComputerUseState({
        permissions: {
          accessibility: false,
          screenRecording: true,
          automation: {
            chrome: {
              status: "granted",
              updatedAt: "2026-06-22T00:00:00.000Z",
              reason: null,
            },
            safari: {
              status: "denied",
              updatedAt: "2026-06-22T00:00:00.000Z",
              reason: "Automation denied",
            },
          },
        },
      }),
    });
    renderDesktopApp();

    expect(
      await screen.findByText(
        "Google Chrome ready. Other browsers can be approved later.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Needs approval")).toBeNull();
    expect(screen.queryByText("Test Safari")).toBeNull();
  });

  it("keeps offline account actions in the overflow menu until it is opened", async () => {
    const { auth } = installDesktopBridges();
    renderDesktopApp();

    expect(await screen.findByText("Offline")).toBeTruthy();
    // Switch workspace / sign out are collapsed into the footer menu.
    expect(screen.queryByText("Sign out")).toBeNull();

    fireEvent.click(screen.getByLabelText("Account actions"));

    expect(await screen.findByText("Switch workspace")).toBeTruthy();
    fireEvent.click(buttonForText("Sign out"));

    await waitFor(() => {
      expect(auth.api.signOut).toHaveBeenCalledTimes(1);
    });
  });

  it("refreshes the runtime panel when the bridge subscription emits", async () => {
    const { computerUse } = installDesktopBridges();
    renderDesktopApp();

    expect(await screen.findByText("Offline")).toBeTruthy();

    computerUse.emitState(createComputerUseState({ status: "online" }));

    expect(await screen.findByText("Online")).toBeTruthy();
    expect(computerUse.subscribe).toHaveBeenCalled();
  });

  it("opens runtime error details from the first captured error", async () => {
    const baseState = createComputerUseState({ status: "error" });
    installDesktopBridges({
      computerUseState: {
        ...baseState,
        host: {
          ...baseState.host,
          errorLog: [
            {
              id: "runtime-error-1",
              source: "heartbeat",
              message: "Heartbeat failed",
              occurredAt: "2026-06-22T00:00:00.000Z",
              hostId: "host_test",
              status: "error",
            },
          ],
        },
      },
      developerToolsState: { available: true, enabled: true },
    });
    renderDesktopApp();

    fireEvent.click(await screen.findByLabelText("Show error details"));

    expect(await screen.findAllByText("Heartbeat failed")).toHaveLength(2);
  });

  it("delegates signed-out account actions to the auth bridge", async () => {
    const { auth } = installDesktopBridges({
      authState: signedOutAuthState,
    });
    renderDesktopApp();

    expect(await screen.findByText("Sign in to Okou")).toBeTruthy();

    fireEvent.click(buttonForText("Sign in"));

    await waitFor(() => {
      expect(auth.openSignIn).toHaveBeenCalledTimes(1);
    });
  });
});
