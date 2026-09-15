import { stoppedOkouDriverState } from "./test/desktop-driver-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import type {
  ComputerUseAutomationPermissionTarget,
  DesktopComputerUseState,
} from "./computer-use-types";
import type { DesktopAuthState } from "./desktop-bridge";
import { DesktopAuthWindow } from "./desktop-auth-window";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import { DESKTOP_DEVELOPER_TOOLS_CHANNELS } from "./desktop-developer-tools-ipc-channels";
import { DESKTOP_RECORDER_CHANNELS } from "./desktop-recorder-ipc-channels";

type IpcEvent = {
  readonly sender?: object;
  readonly senderFrame?: {
    readonly url?: string;
  };
};
type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown;
type IpcHandle = (channel: string, handler: IpcHandler) => void;
type WebContentsSend = (channel: string) => void;
type OpenExternal = (url: string) => Promise<void>;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const windows: MockBrowserWindow[] = [];
  const handle = vi.fn<IpcHandle>((channel, handler) => {
    handlers.set(channel, handler);
  });
  const getAllWindows = vi.fn<() => readonly MockBrowserWindow[]>(() => {
    return windows;
  });
  const openExternal = vi.fn<OpenExternal>(async () => {});

  return {
    BrowserWindow: {
      getAllWindows,
    },
    handlers,
    ipcMain: {
      handle,
    },
    shell: {
      openExternal,
    },
    windows,
  };
});

vi.mock("electron", () => {
  return {
    BrowserWindow: electronMock.BrowserWindow,
    ipcMain: electronMock.ipcMain,
    shell: electronMock.shell,
  };
});

interface MockBrowserWindow {
  readonly isDestroyed: () => boolean;
  readonly webContents: {
    readonly send: ReturnType<typeof vi.fn<WebContentsSend>>;
  };
}

const rendererUrl = "vm0-desktop://renderer/index.html";
const recorderUrl = "vm0-desktop://renderer/recorder.html?mode=bar";
const trustedFrame = {
  url: rendererUrl,
  detached: false,
  isDestroyed: () => false,
};
const trustedContents = { mainFrame: trustedFrame, isDestroyed: () => false };
const trustedWindow = {
  webContents: trustedContents,
  isDestroyed: () => false,
};
const blockedAppUrl = "https://evil.example/desktop-auth/callback";

beforeEach(() => {
  vi.resetModules();
  electronMock.handlers.clear();
  electronMock.windows.length = 0;
  electronMock.BrowserWindow.getAllWindows.mockClear();
  electronMock.ipcMain.handle.mockClear();
  electronMock.shell.openExternal.mockClear();
});

describe("Desktop IPC boundary", () => {
  it("rejects every computer use handler from untrusted sender frames", async () => {
    const { installComputerUseIpc } = await import("./computer-use-electron");
    const api = createComputerUseApi();

    installComputerUseIpc(api, {
      rendererUrl,
      getMainWindow: () => trustedWindow,
    });

    const protectedHandlers: readonly {
      readonly channel: string;
      readonly args: readonly unknown[];
    }[] = [
      { channel: COMPUTER_USE_CHANNELS.getState, args: [] },
      { channel: COMPUTER_USE_CHANNELS.refreshPermissions, args: [] },
      {
        channel: COMPUTER_USE_CHANNELS.start,
        args: [{ userInitiated: true }],
      },
      { channel: COMPUTER_USE_CHANNELS.stop, args: [] },
      {
        channel: COMPUTER_USE_CHANNELS.requestAccessibilityPermission,
        args: [],
      },
      {
        channel: COMPUTER_USE_CHANNELS.requestScreenRecordingPermission,
        args: [],
      },
      {
        channel: COMPUTER_USE_CHANNELS.probeAutomationPermission,
        args: ["chrome"],
      },
      { channel: COMPUTER_USE_CHANNELS.setKeepAwakeEnabled, args: [true] },
      {
        channel: COMPUTER_USE_CHANNELS.setFilesystemPluginEnabled,
        args: [true],
      },
      {
        channel: COMPUTER_USE_CHANNELS.addFilesystemPluginAllowedDirectory,
        args: [],
      },
      {
        channel: COMPUTER_USE_CHANNELS.removeFilesystemPluginAllowedDirectory,
        args: ["/tmp"],
      },
      {
        channel: COMPUTER_USE_CHANNELS.importMcpPluginServers,
        args: ['{"mcpServers":{}}'],
      },
      {
        channel: COMPUTER_USE_CHANNELS.setMcpPluginServerEnabled,
        args: ["notes", true],
      },
      {
        channel: COMPUTER_USE_CHANNELS.removeMcpPluginServer,
        args: ["notes"],
      },
      { channel: COMPUTER_USE_CHANNELS.openAccessibilitySettings, args: [] },
      { channel: COMPUTER_USE_CHANNELS.openScreenRecordingSettings, args: [] },
      { channel: COMPUTER_USE_CHANNELS.openAutomationSettings, args: [] },
    ];

    for (const { channel, args } of protectedHandlers) {
      await expect(invokeIpc(channel, blockedAppUrl, ...args)).rejects.toThrow(
        "Desktop Computer Use is unavailable on this page",
      );
    }

    expect(api.getState).not.toHaveBeenCalled();
    expect(api.refreshPermissions).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
    expect(api.requestAccessibilityPermission).not.toHaveBeenCalled();
    expect(api.requestScreenRecordingPermission).not.toHaveBeenCalled();
    expect(api.probeAutomationPermission).not.toHaveBeenCalled();
    expect(api.setKeepAwakeEnabled).not.toHaveBeenCalled();
    expect(api.setFilesystemPluginEnabled).not.toHaveBeenCalled();
    expect(api.addFilesystemPluginAllowedDirectory).not.toHaveBeenCalled();
    expect(api.removeFilesystemPluginAllowedDirectory).not.toHaveBeenCalled();
    expect(api.importMcpPluginServers).not.toHaveBeenCalled();
    expect(api.setMcpPluginServerEnabled).not.toHaveBeenCalled();
    expect(api.removeMcpPluginServer).not.toHaveBeenCalled();
    expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
  });

  it("protects computer use handlers by renderer URL and validates keep-awake payloads", async () => {
    const { installComputerUseIpc } = await import("./computer-use-electron");
    const api = createComputerUseApi();

    installComputerUseIpc(api, {
      rendererUrl,
      getMainWindow: () => trustedWindow,
    });

    await expect(
      invokeIpc(COMPUTER_USE_CHANNELS.setKeepAwakeEnabled, rendererUrl, "true"),
    ).rejects.toThrow("Desktop keep-awake enabled state must be a boolean");
    await expect(
      invokeIpc(
        COMPUTER_USE_CHANNELS.probeAutomationPermission,
        rendererUrl,
        "firefox",
      ),
    ).rejects.toThrow("Unknown Computer Use Automation permission target");

    await invokeIpc(COMPUTER_USE_CHANNELS.start, rendererUrl, {
      userInitiated: true,
    });
    await invokeIpc(
      COMPUTER_USE_CHANNELS.setKeepAwakeEnabled,
      rendererUrl,
      true,
    );
    await invokeIpc(
      COMPUTER_USE_CHANNELS.probeAutomationPermission,
      rendererUrl,
      "chrome",
    );

    expect(api.start).toHaveBeenCalledWith({ userInitiated: true });
    expect(api.setKeepAwakeEnabled).toHaveBeenCalledWith(true);
    expect(api.probeAutomationPermission).toHaveBeenCalledWith("chrome");
  });

  it("requires the live main window and its exact top-level frame even for local URLs", async () => {
    const { installComputerUseIpc } = await import("./computer-use-electron");
    const api = createComputerUseApi();
    installComputerUseIpc(api, {
      rendererUrl,
      getMainWindow: () => trustedWindow,
    });
    const handler = electronMock.handlers.get(COMPUTER_USE_CHANNELS.start)!;
    const reject = (event: IpcEvent) =>
      expect(
        Promise.resolve().then(() => handler(event, { userInitiated: true })),
      ).rejects.toThrow("unavailable on this page");
    await reject({ sender: {}, senderFrame: trustedFrame }); // auth/recorder/other local window
    await reject({
      sender: trustedContents,
      senderFrame: { url: rendererUrl },
    }); // subframe
    await reject({ sender: trustedContents });
    trustedFrame.detached = true;
    await reject({ sender: trustedContents, senderFrame: trustedFrame });
    trustedFrame.detached = false;
    const stale = { ...trustedWindow, isDestroyed: () => true };
    installComputerUseIpc(api, { rendererUrl, getMainWindow: () => stale });
    await expect(
      invokeIpc(COMPUTER_USE_CHANNELS.start, rendererUrl, {
        userInitiated: true,
      }),
    ).rejects.toThrow("unavailable on this page");
    expect(api.start).not.toHaveBeenCalled();
  });

  it("rejects forged start authority", async () => {
    const { installComputerUseIpc } = await import("./computer-use-electron");
    const api = createComputerUseApi();
    installComputerUseIpc(api, {
      rendererUrl,
      getMainWindow: () => trustedWindow,
    });
    for (const invalid of [
      null,
      "true",
      {},
      { userInitiated: "true" },
      { userInitiated: true, tool: "click" },
    ]) {
      await expect(
        invokeIpc(COMPUTER_USE_CHANNELS.start, rendererUrl, invalid),
      ).rejects.toThrow("Invalid Computer Use start options");
    }
    expect(api.start).not.toHaveBeenCalled();
  });

  it("rejects recorder handlers from every frame but the recorder overlays", async () => {
    const { installDesktopRecorderIpc } =
      await import("./desktop-recorder-electron");
    const api = {
      getState: vi.fn(),
      getCapabilities: vi.fn(async () => ({ supportsMicrophone: true })),
      listWindowOptions: vi.fn(async () => []),
      startCapture: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      beginAreaSelection: vi.fn(),
      completeAreaSelection: vi.fn(async () => {}),
      selectWindow: vi.fn(async () => null),
      completeWindowSelection: vi.fn(),
      cancel: vi.fn(),
      openScreenRecordingSettings: vi.fn(),
    };

    installDesktopRecorderIpc(api, { recorderUrl });

    // Keyed by channel so a new recorder channel cannot be added without
    // deciding what an untrusted page may send it. The list below is checked
    // against the channel table, and a missing entry fails this test.
    const sampleArgs: Record<string, readonly unknown[]> = {
      [DESKTOP_RECORDER_CHANNELS.getState]: [],
      [DESKTOP_RECORDER_CHANNELS.getCapabilities]: [],
      [DESKTOP_RECORDER_CHANNELS.startCapture]: [
        { sourceKind: "display", systemAudio: true, microphone: false },
      ],
      [DESKTOP_RECORDER_CHANNELS.beginAreaSelection]: [
        { systemAudio: true, microphone: false },
      ],
      [DESKTOP_RECORDER_CHANNELS.completeAreaSelection]: [null],
      [DESKTOP_RECORDER_CHANNELS.selectWindow]: [],
      [DESKTOP_RECORDER_CHANNELS.listWindowOptions]: [],
      [DESKTOP_RECORDER_CHANNELS.completeWindowSelection]: [null],
      // Ending a capture is as sensitive as starting one: an untrusted page
      // reaching discard would throw away someone's recording.
      [DESKTOP_RECORDER_CHANNELS.pause]: [],
      [DESKTOP_RECORDER_CHANNELS.resume]: [],
      [DESKTOP_RECORDER_CHANNELS.discard]: [],
      [DESKTOP_RECORDER_CHANNELS.stop]: [],
      [DESKTOP_RECORDER_CHANNELS.cancel]: [],
      [DESKTOP_RECORDER_CHANNELS.openScreenRecordingSettings]: [],
    };

    expect(Object.keys(sampleArgs).sort()).toEqual(
      Object.values(DESKTOP_RECORDER_CHANNELS).sort(),
    );

    for (const [channel, args] of Object.entries(sampleArgs)) {
      await expect(invokeIpc(channel, blockedAppUrl, ...args)).rejects.toThrow(
        "Screen recording is unavailable on this page",
      );
      // The main window is not a recorder overlay either.
      await expect(invokeIpc(channel, rendererUrl, ...args)).rejects.toThrow(
        "Screen recording is unavailable on this page",
      );
    }

    expect(api.startCapture).not.toHaveBeenCalled();
    expect(api.beginAreaSelection).not.toHaveBeenCalled();
    expect(api.selectWindow).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(api.pause).not.toHaveBeenCalled();
    expect(api.resume).not.toHaveBeenCalled();
    expect(api.discard).not.toHaveBeenCalled();
    expect(api.stop).not.toHaveBeenCalled();
  });

  it("validates capture requests before they reach the recorder", async () => {
    const { installDesktopRecorderIpc } =
      await import("./desktop-recorder-electron");
    const api = {
      getState: vi.fn(),
      getCapabilities: vi.fn(async () => ({ supportsMicrophone: true })),
      listWindowOptions: vi.fn(async () => []),
      startCapture: vi.fn(async () => {}),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      beginAreaSelection: vi.fn(),
      completeAreaSelection: vi.fn(async () => {}),
      selectWindow: vi.fn(async () => null),
      completeWindowSelection: vi.fn(),
      cancel: vi.fn(),
      openScreenRecordingSettings: vi.fn(),
    };

    installDesktopRecorderIpc(api, { recorderUrl });

    await expect(
      invokeIpc(DESKTOP_RECORDER_CHANNELS.startCapture, recorderUrl, {
        sourceKind: "everything",
        systemAudio: true,
        microphone: false,
      }),
    ).rejects.toThrow("Unsupported screen recording source kind: everything");
    await expect(
      invokeIpc(DESKTOP_RECORDER_CHANNELS.startCapture, recorderUrl, {
        sourceKind: "window",
        systemAudio: true,
        microphone: false,
      }),
    ).rejects.toThrow("Recording a window needs the window to record");
    // A region without its display would be rebased onto the wrong screen.
    await expect(
      invokeIpc(DESKTOP_RECORDER_CHANNELS.completeAreaSelection, recorderUrl, {
        area: { x: 10, y: 20, width: 300, height: 200 },
      }),
    ).rejects.toThrow("A selected region must name its display and rectangle");
    await expect(
      invokeIpc(
        DESKTOP_RECORDER_CHANNELS.completeWindowSelection,
        recorderUrl,
        { sourceId: "window:1" },
      ),
    ).rejects.toThrow("A chosen window must name its source");
    expect(api.startCapture).not.toHaveBeenCalled();

    await invokeIpc(
      DESKTOP_RECORDER_CHANNELS.completeAreaSelection,
      recorderUrl,
      {
        displayId: 7,
        area: { x: 10, y: 20, width: 300, height: 200 },
      },
    );
    expect(api.completeAreaSelection).toHaveBeenCalledWith({
      displayId: 7,
      area: { x: 10, y: 20, width: 300, height: 200 },
    });
  });

  it("rejects desktop auth renderer handlers from untrusted sender frames", async () => {
    const { installDesktopAuthIpc } = await import("./desktop-auth-electron");
    const api = createDesktopAuthApi();

    installDesktopAuthIpc(api, {
      rendererUrl,
      authWindow: new DesktopAuthWindow({
        authOrigin: "https://app.okou.ai",
        partition: "persist:desktop-test",
        windowOptions: () => ({}),
        openExternal: () => {},
      }),
    });

    for (const channel of [
      DESKTOP_AUTH_CHANNELS.getState,
      DESKTOP_AUTH_CHANNELS.openSignIn,
      DESKTOP_AUTH_CHANNELS.openOrgSelection,
      DESKTOP_AUTH_CHANNELS.signOut,
    ]) {
      await expect(invokeIpc(channel, blockedAppUrl)).rejects.toThrow(
        "Desktop auth is unavailable on this page",
      );
    }

    expect(api.getState).not.toHaveBeenCalled();
    expect(api.openSignIn).not.toHaveBeenCalled();
    expect(api.openOrgSelection).not.toHaveBeenCalled();
    expect(api.signOut).not.toHaveBeenCalled();
  });

  it("protects developer tools handlers by renderer URL and validates payloads", async () => {
    const { installDesktopDeveloperToolsIpc } =
      await import("./desktop-developer-tools-electron");
    const api = createDesktopDeveloperToolsApi();

    installDesktopDeveloperToolsIpc(api, { rendererUrl });

    await expect(
      invokeIpc(DESKTOP_DEVELOPER_TOOLS_CHANNELS.getState, blockedAppUrl),
    ).rejects.toThrow("Desktop developer tools are unavailable on this page");
    await expect(
      invokeIpc(
        DESKTOP_DEVELOPER_TOOLS_CHANNELS.setEnabled,
        rendererUrl,
        "true",
      ),
    ).rejects.toThrow(
      "Desktop developer tools enabled state must be a boolean",
    );

    await invokeIpc(
      DESKTOP_DEVELOPER_TOOLS_CHANNELS.setEnabled,
      rendererUrl,
      true,
    );

    expect(api.setEnabled).toHaveBeenCalledWith(true);
  });

  it("notifies only live windows when computer use state changes", async () => {
    const { notifyDesktopComputerUseChanged } =
      await import("./computer-use-electron");
    const liveWindow = createMockWindow({ destroyed: false });
    const destroyedWindow = createMockWindow({ destroyed: true });
    electronMock.windows.push(liveWindow, destroyedWindow);

    notifyDesktopComputerUseChanged();

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      COMPUTER_USE_CHANNELS.changed,
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("notifies only live windows when desktop auth state changes", async () => {
    const { notifyDesktopAuthChanged } =
      await import("./desktop-auth-electron");
    const liveWindow = createMockWindow({ destroyed: false });
    const destroyedWindow = createMockWindow({ destroyed: true });
    electronMock.windows.push(liveWindow, destroyedWindow);

    notifyDesktopAuthChanged();

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      DESKTOP_AUTH_CHANNELS.changed,
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });

  it("notifies only live windows when developer tools state changes", async () => {
    const { notifyDesktopDeveloperToolsChanged } =
      await import("./desktop-developer-tools-electron");
    const liveWindow = createMockWindow({ destroyed: false });
    const destroyedWindow = createMockWindow({ destroyed: true });
    electronMock.windows.push(liveWindow, destroyedWindow);

    notifyDesktopDeveloperToolsChanged();

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(
      DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed,
    );
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled();
  });
});

function createComputerUseApi(): {
  readonly getState: ReturnType<typeof vi.fn<() => DesktopComputerUseState>>;
  readonly refreshPermissions: ReturnType<
    typeof vi.fn<() => Promise<DesktopComputerUseState>>
  >;
  readonly start: ReturnType<
    typeof vi.fn<
      (options: {
        readonly userInitiated: boolean;
      }) => Promise<DesktopComputerUseState>
    >
  >;
  readonly stop: ReturnType<
    typeof vi.fn<() => Promise<DesktopComputerUseState>>
  >;
  readonly requestAccessibilityPermission: ReturnType<
    typeof vi.fn<() => Promise<DesktopComputerUseState>>
  >;
  readonly requestScreenRecordingPermission: ReturnType<
    typeof vi.fn<() => Promise<DesktopComputerUseState>>
  >;
  readonly probeAutomationPermission: ReturnType<
    typeof vi.fn<
      (
        target: ComputerUseAutomationPermissionTarget,
      ) => Promise<DesktopComputerUseState>
    >
  >;
  readonly setKeepAwakeEnabled: ReturnType<
    typeof vi.fn<(enabled: boolean) => DesktopComputerUseState>
  >;
  readonly setFilesystemPluginEnabled: ReturnType<
    typeof vi.fn<(enabled: boolean) => DesktopComputerUseState>
  >;
  readonly addFilesystemPluginAllowedDirectory: ReturnType<
    typeof vi.fn<() => Promise<DesktopComputerUseState>>
  >;
  readonly removeFilesystemPluginAllowedDirectory: ReturnType<
    typeof vi.fn<(directory: string) => DesktopComputerUseState>
  >;
  readonly importMcpPluginServers: ReturnType<
    typeof vi.fn<(json: string) => DesktopComputerUseState>
  >;
  readonly setMcpPluginServerEnabled: ReturnType<
    typeof vi.fn<(server: string, enabled: boolean) => DesktopComputerUseState>
  >;
  readonly removeMcpPluginServer: ReturnType<
    typeof vi.fn<(server: string) => DesktopComputerUseState>
  >;
} {
  const state = createComputerUseState();
  return {
    getState: vi.fn(() => state),
    refreshPermissions: vi.fn(async () => state),
    start: vi.fn(async () => state),
    stop: vi.fn(async () => state),
    requestAccessibilityPermission: vi.fn(async () => state),
    requestScreenRecordingPermission: vi.fn(async () => state),
    probeAutomationPermission: vi.fn(async () => state),
    setKeepAwakeEnabled: vi.fn(() => state),
    setFilesystemPluginEnabled: vi.fn(() => state),
    addFilesystemPluginAllowedDirectory: vi.fn(async () => state),
    removeFilesystemPluginAllowedDirectory: vi.fn(() => state),
    importMcpPluginServers: vi.fn(() => state),
    setMcpPluginServerEnabled: vi.fn(() => state),
    removeMcpPluginServer: vi.fn(() => state),
  };
}

function createDesktopAuthApi(): {
  readonly getState: ReturnType<typeof vi.fn<() => DesktopAuthState>>;
  readonly openSignIn: ReturnType<typeof vi.fn<() => void>>;
  readonly openOrgSelection: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly signOut: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    getState: vi.fn(() => {
      return {
        status: "signed_out",
        user: null,
        organization: null,
      };
    }),
    openSignIn: vi.fn(() => {}),
    openOrgSelection: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  };
}

function createDesktopDeveloperToolsApi(): {
  readonly getState: ReturnType<
    typeof vi.fn<
      () => { readonly available: boolean; readonly enabled: boolean }
    >
  >;
  readonly setEnabled: ReturnType<
    typeof vi.fn<
      (enabled: boolean) => {
        readonly available: boolean;
        readonly enabled: boolean;
      }
    >
  >;
} {
  const state = { available: true, enabled: false };
  return {
    getState: vi.fn(() => state),
    setEnabled: vi.fn((enabled) => {
      return { available: true, enabled };
    }),
  };
}

function createComputerUseState(): DesktopComputerUseState {
  return {
    driver: stoppedOkouDriverState,
    platform: "darwin",
    supported: true,
    permissions: {
      accessibility: true,
      screenRecording: true,
    },
    host: {
      status: "offline",
      hostId: null,
      lastHeartbeatAt: null,
      lastCommandAt: null,
      lastError: null,
      recovery: null,
      errorLog: [],
      localCommandLog: [],
    },
    keepAwake: {
      active: false,
      enabled: false,
    },
  };
}

function createMockWindow({
  destroyed,
}: {
  readonly destroyed: boolean;
}): MockBrowserWindow {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      send: vi.fn<WebContentsSend>(() => {}),
    },
  };
}

async function invokeIpc(
  channel: string,
  senderFrameUrl: string,
  ...args: unknown[]
): Promise<unknown> {
  const handler = electronMock.handlers.get(channel);
  if (!handler) {
    throw new Error(`Expected ${channel} to be handled`);
  }
  return await handler(
    {
      sender: trustedContents,
      senderFrame:
        senderFrameUrl === rendererUrl ? trustedFrame : { url: senderFrameUrl },
    },
    ...args,
  );
}
