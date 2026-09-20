import { stoppedOkouDriverState } from "./test/desktop-driver-state";
import type { DesktopAuthState } from "./desktop-bridge";
import type {
  ComputerUseHostRuntimeState,
  ComputerUseLocalCommandLogEntry,
  DesktopComputerUseState,
} from "./computer-use-types";
import {
  buildDesktopTrayMenuItems,
  type DesktopTrayMenuActions,
  type DesktopTrayMenuItem,
} from "./desktop-tray-menu";

const baseHostState: ComputerUseHostRuntimeState = {
  status: "offline",
  hostId: null,
  lastHeartbeatAt: null,
  lastCommandAt: null,
  lastError: null,
  recovery: null,
  errorLog: [],
  localCommandLog: [],
};

const signedInAuth: DesktopAuthState = {
  status: "signed_in",
  user: {
    userId: "user_1",
    email: "user@example.com",
  },
  organization: {
    id: "org_1",
    name: "Max & Zoe",
  },
};

const signingInAuth: DesktopAuthState = {
  status: "signing_in",
  user: null,
  organization: null,
};

function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): string {
  return new Date(year, monthIndex, day, hour, minute, second).toISOString();
}

function setCurrentLocalTime(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
): void {
  vi.spyOn(Date, "now").mockReturnValue(
    new Date(year, monthIndex, day, hour, minute).getTime(),
  );
}

function computerUseState(
  host: Partial<ComputerUseHostRuntimeState> = {},
  permissions: DesktopComputerUseState["permissions"] = {
    accessibility: true,
    screenRecording: true,
  },
): DesktopComputerUseState {
  return {
    driver: stoppedOkouDriverState,
    platform: "darwin",
    supported: true,
    permissions,
    keepAwake: {
      enabled: false,
      active: false,
    },
    host: {
      ...baseHostState,
      ...host,
    },
  };
}

function commandEntry(index: number): ComputerUseLocalCommandLogEntry {
  return {
    commandId: `cmd-${index}`,
    kind: `command-${index}`,
    app: `App ${index}`,
    status: index % 2 === 0 ? "succeeded" : "running",
    payload: {},
    result: null,
    error: null,
    startedAt: localIso(2026, 5, 9, 4, index),
    completedAt: index % 2 === 0 ? localIso(2026, 5, 9, 4, index, 1) : null,
    durationMs: index % 2 === 0 ? 1_000 : null,
  };
}

function trayActions(
  overrides: Partial<DesktopTrayMenuActions> = {},
): DesktopTrayMenuActions {
  return {
    showMainWindow: vi.fn(),
    startComputerUse: vi.fn(),
    stopComputerUse: vi.fn(),
    refreshStatus: vi.fn(),
    openSignIn: vi.fn(),
    switchWorkspace: vi.fn(),
    signOut: vi.fn(),
    requestAccessibilityPermission: vi.fn(),
    requestScreenRecordingPermission: vi.fn(),
    openAccessibilitySettings: vi.fn(),
    openScreenRecordingSettings: vi.fn(),
    setKeepAwakeEnabled: vi.fn(),
    quit: vi.fn(),
    ...overrides,
  };
}

function findItem(
  items: readonly DesktopTrayMenuItem[],
  label: string,
): DesktopTrayMenuItem {
  const item = items.find((candidate) => {
    return candidate.label === label;
  });
  if (!item) {
    throw new Error(`No menu item found for ${label}`);
  }
  return item;
}

function submenu(item: DesktopTrayMenuItem): readonly DesktopTrayMenuItem[] {
  if (!item.submenu) {
    throw new Error(`Menu item ${item.label ?? "unknown"} has no submenu`);
  }
  return item.submenu;
}

function click(item: DesktopTrayMenuItem): void {
  if (!item.click) {
    throw new Error(
      `Menu item ${item.label ?? "unknown"} has no click handler`,
    );
  }
  item.click();
}

describe("desktop tray menu", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Okou copy for the Okou product", () => {
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState(),
        auth: { status: "signed_out", user: null, organization: null },
        authError: null,
      },
      trayActions(),
    );

    expect(findItem(menu, "Open Okou")).toBeDefined();
    expect(findItem(menu, "Sign in to Okou")).toBeDefined();
    expect(
      findItem(submenu(findItem(menu, "Sign in to Okou")), "Sign in to Okou"),
    ).toBeDefined();
  });

  it("shows the main window, status submenus, recent commands, and quit", () => {
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({ status: "online" }),
        auth: signedInAuth,
        authError: null,
      },
      trayActions(),
    );

    expect(menu.map((item) => item.label).filter((label) => label)).toEqual([
      "Open Okou",
      "Workspace: Max & Zoe",
      "Computer Use: Online",
      "Keep Mac Awake",
      "No Recent Commands",
      "Quit",
    ]);
    expect(findItem(menu, "Open Okou")).toBeDefined();
    expect(findItem(menu, "Keep Mac Awake")).toStrictEqual({
      label: "Keep Mac Awake",
      type: "checkbox",
      checked: false,
      click: expect.any(Function),
    });
    expect(findItem(menu, "Computer Use: Online")).toBeDefined();
    expect(findItem(menu, "Workspace: Max & Zoe")).toBeDefined();
    expect(findItem(menu, "No Recent Commands")).toStrictEqual({
      label: "No Recent Commands",
      enabled: false,
    });
    expect(findItem(menu, "Quit")).toBeDefined();
  });

  it("toggles keep-awake from the top-level menu", () => {
    const setKeepAwakeEnabled = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: {
          ...computerUseState({ status: "online" }),
          keepAwake: {
            enabled: true,
            active: true,
          },
        },
        auth: signedInAuth,
        authError: null,
      },
      trayActions({ setKeepAwakeEnabled }),
    );

    const keepAwakeItem = findItem(menu, "Keep Mac Awake");

    expect(keepAwakeItem.type).toBe("checkbox");
    expect(keepAwakeItem.checked).toBe(true);
    click(keepAwakeItem);
    expect(setKeepAwakeEnabled).toHaveBeenCalledWith(false);
  });

  it("enables starting Computer Use when offline and signed in", () => {
    const startComputerUse = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({ status: "offline" }),
        auth: signedInAuth,
        authError: null,
      },
      trayActions({ startComputerUse }),
    );

    const computerUseMenu = submenu(findItem(menu, "Computer Use: Offline"));
    const startItem = findItem(computerUseMenu, "Start Computer Use");

    expect(startItem.enabled).toBe(true);
    expect(findItem(computerUseMenu, "Stop Computer Use").enabled).toBe(false);
    click(startItem);
    expect(startComputerUse).toHaveBeenCalledOnce();
  });

  it("enables stopping Computer Use while online", () => {
    const stopComputerUse = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({ status: "online" }),
        auth: signedInAuth,
        authError: null,
      },
      trayActions({ stopComputerUse }),
    );

    const computerUseMenu = submenu(findItem(menu, "Computer Use: Online"));
    const stopItem = findItem(computerUseMenu, "Stop Computer Use");

    expect(findItem(computerUseMenu, "Start Computer Use").enabled).toBe(false);
    expect(stopItem.enabled).toBe(true);
    click(stopItem);
    expect(stopComputerUse).toHaveBeenCalledOnce();
  });

  it("keeps stop enabled while Computer Use is recovering", () => {
    const stopComputerUse = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({ status: "recovering" }),
        auth: signedInAuth,
        authError: null,
      },
      trayActions({ stopComputerUse }),
    );

    const computerUseMenu = submenu(findItem(menu, "Computer Use: Recovering"));
    const stopItem = findItem(computerUseMenu, "Stop Computer Use");

    expect(findItem(computerUseMenu, "Start Computer Use").enabled).toBe(false);
    expect(stopItem.enabled).toBe(true);
    click(stopItem);
    expect(stopComputerUse).toHaveBeenCalledOnce();
  });

  it("shows sign-in next to disabled start when Computer Use needs auth", () => {
    const openSignIn = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({ status: "offline" }),
        auth: {
          status: "signed_out",
          user: null,
          organization: null,
        },
        authError: null,
      },
      trayActions({ openSignIn }),
    );

    const computerUseMenu = submenu(
      findItem(menu, "Computer Use: Sign in required"),
    );

    expect(findItem(computerUseMenu, "Start Computer Use").enabled).toBe(false);
    click(findItem(computerUseMenu, "Sign in to Okou"));
    expect(openSignIn).toHaveBeenCalledOnce();
  });

  it("shows signing in and disables start while auth is signing in", () => {
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({ status: "offline" }),
        auth: signingInAuth,
        authError: null,
      },
      trayActions(),
    );

    const computerUseMenu = submenu(
      findItem(menu, "Computer Use: Signing in..."),
    );
    expect(findItem(computerUseMenu, "Status: Signing in...").enabled).toBe(
      false,
    );
    expect(findItem(computerUseMenu, "Start Computer Use").enabled).toBe(false);
    expect(findItem(computerUseMenu, "Signing in...").enabled).toBe(false);
  });

  it("keeps stale signed-in auth from showing offline while auth is loading", () => {
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({ status: "offline" }),
        auth: signedInAuth,
        authLoading: true,
        authError: null,
      },
      trayActions(),
    );

    const computerUseMenu = submenu(
      findItem(menu, "Computer Use: Signing in..."),
    );
    expect(findItem(computerUseMenu, "Status: Signing in...").enabled).toBe(
      false,
    );
    expect(findItem(computerUseMenu, "Start Computer Use").enabled).toBe(false);
    expect(findItem(menu, "Signing in to Okou...")).toBeDefined();
  });

  it("shows permission actions when Computer Use is blocked locally", () => {
    const requestAccessibilityPermission = vi.fn();
    const requestScreenRecordingPermission = vi.fn();
    const openAccessibilitySettings = vi.fn();
    const openScreenRecordingSettings = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState(
          { status: "offline" },
          { accessibility: false, screenRecording: false },
        ),
        auth: signedInAuth,
        authError: null,
      },
      trayActions({
        requestAccessibilityPermission,
        requestScreenRecordingPermission,
        openAccessibilitySettings,
        openScreenRecordingSettings,
      }),
    );

    const computerUseMenu = submenu(
      findItem(menu, "Computer Use: Needs permissions"),
    );
    click(findItem(computerUseMenu, "Request Accessibility Permission"));
    click(findItem(computerUseMenu, "Accessibility Settings"));
    click(findItem(computerUseMenu, "Request Screen Recording Permission"));
    click(findItem(computerUseMenu, "Screen Recording Settings"));

    expect(requestAccessibilityPermission).toHaveBeenCalledOnce();
    expect(requestScreenRecordingPermission).toHaveBeenCalledOnce();
    expect(openAccessibilitySettings).toHaveBeenCalledOnce();
    expect(openScreenRecordingSettings).toHaveBeenCalledOnce();
  });

  it("shows ready permissions and keeps settings available", () => {
    const openAccessibilitySettings = vi.fn();
    const openScreenRecordingSettings = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({ status: "offline" }),
        auth: signedInAuth,
        authError: null,
      },
      trayActions({
        openAccessibilitySettings,
        openScreenRecordingSettings,
      }),
    );

    const computerUseMenu = submenu(findItem(menu, "Computer Use: Offline"));
    expect(findItem(computerUseMenu, "Status: Offline").enabled).toBe(false);
    expect(findItem(computerUseMenu, "Accessibility: Ready").enabled).toBe(
      false,
    );
    expect(findItem(computerUseMenu, "Screen Recording: Ready").enabled).toBe(
      false,
    );

    click(findItem(computerUseMenu, "Accessibility Settings"));
    click(findItem(computerUseMenu, "Screen Recording Settings"));

    expect(openAccessibilitySettings).toHaveBeenCalledOnce();
    expect(openScreenRecordingSettings).toHaveBeenCalledOnce();
  });

  it("shows signed-in account and workspace actions", () => {
    const switchWorkspace = vi.fn();
    const signOut = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState(),
        auth: signedInAuth,
        authError: null,
      },
      trayActions({ switchWorkspace, signOut }),
    );

    const authMenu = submenu(findItem(menu, "Workspace: Max & Zoe"));

    expect(findItem(authMenu, "Signed in as user@example.com").enabled).toBe(
      false,
    );
    expect(findItem(authMenu, "Workspace: Max & Zoe").enabled).toBe(false);
    click(findItem(authMenu, "Switch Workspace"));
    click(findItem(authMenu, "Sign out"));
    expect(switchWorkspace).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
    expect(
      authMenu.some((item) => {
        return item.label === "Sign in again";
      }),
    ).toBe(false);
  });

  it("shows sign-in action when signed out", () => {
    const openSignIn = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState(),
        auth: {
          status: "signed_out",
          user: null,
          organization: null,
        },
        authError: null,
      },
      trayActions({ openSignIn }),
    );

    const authMenu = submenu(findItem(menu, "Sign in to Okou"));
    click(findItem(authMenu, "Sign in to Okou"));

    expect(openSignIn).toHaveBeenCalledOnce();
  });

  it("keeps sign-in actionable when auth status is unavailable", () => {
    const openSignIn = vi.fn();
    const refreshStatus = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState(),
        auth: null,
        authError: "Desktop auth status failed: 500",
      },
      trayActions({ openSignIn, refreshStatus }),
    );

    const authMenu = submenu(findItem(menu, "Sign in to Okou"));
    expect(
      menu.some((item) => {
        return item.label?.includes("Unknown") ?? false;
      }),
    ).toBe(false);
    click(findItem(authMenu, "Sign in to Okou"));
    click(findItem(authMenu, "Refresh Account Status"));

    expect(openSignIn).toHaveBeenCalledOnce();
    expect(refreshStatus).toHaveBeenCalledOnce();
  });

  it("does not show stale workspace when auth refresh fails", () => {
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState(),
        auth: signedInAuth,
        authError: "Desktop auth status failed: 500",
      },
      trayActions(),
    );

    expect(findItem(menu, "Sign in to Okou")).toBeDefined();
    expect(
      menu.some((item) => {
        return item.label === "Workspace: Max & Zoe";
      }),
    ).toBe(false);
  });

  it("limits today's recent commands to five and opens the main window from each row", () => {
    setCurrentLocalTime(2026, 5, 9, 18, 0);

    const showMainWindow = vi.fn();
    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({
          localCommandLog: [0, 1, 2, 3, 4, 5].map(commandEntry),
        }),
        auth: signedInAuth,
        authError: null,
      },
      trayActions({ showMainWindow }),
    );

    const commandItems = menu.filter((item) => {
      return item.label?.includes("command-") ?? false;
    });

    expect(findItem(menu, "Recent Commands").enabled).toBe(false);
    expect(commandItems).toHaveLength(5);
    expect(commandItems[0]?.label).toBe(
      "04:00 - App 0 - command-0 - Succeeded",
    );
    expect(commandItems[0]?.label).toMatch(/ - Succeeded$/);
    expect(commandItems[1]?.label).toMatch(/ - Running$/);
    expect(commandItems[4]?.label).toBe(
      "04:04 - App 4 - command-4 - Succeeded",
    );
    expect(commandItems[4]?.label).toMatch(/ - Succeeded$/);
    expect(
      commandItems.some((item) => {
        return item.label?.includes("Done") ?? false;
      }),
    ).toBe(false);
    expect(
      commandItems.some((item) => {
        return item.label?.includes("command-5") ?? false;
      }),
    ).toBe(false);

    const firstCommandItem = commandItems[0];
    if (!firstCommandItem) {
      throw new Error("Expected at least one command menu item");
    }

    click(firstCommandItem);
    expect(showMainWindow).toHaveBeenCalledOnce();
  });

  it("shows the local date for recent commands from another day", () => {
    setCurrentLocalTime(2026, 5, 10, 9, 0);

    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({
          localCommandLog: [commandEntry(0)],
        }),
        auth: signedInAuth,
        authError: null,
      },
      trayActions(),
    );

    expect(
      findItem(menu, "06/09 - App 0 - command-0 - Succeeded"),
    ).toBeDefined();
  });

  it("includes the year for recent commands from another year", () => {
    setCurrentLocalTime(2027, 0, 1, 9, 0);

    const menu = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState({
          localCommandLog: [commandEntry(0)],
        }),
        auth: signedInAuth,
        authError: null,
      },
      trayActions(),
    );

    expect(
      findItem(menu, "2026/06/09 - App 0 - command-0 - Succeeded"),
    ).toBeDefined();
  });
});
