import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import { DESKTOP_DEVELOPER_TOOLS_CHANNELS } from "./desktop-developer-tools-ipc-channels";
import { DESKTOP_IDENTITY_CHANNEL } from "./desktop-identity-ipc-channels";
import type {
  DesktopAuthApi,
  DesktopComputerUseApi,
  DesktopDeveloperToolsApi,
} from "./desktop-bridge";

type ExposeInMainWorld = (key: string, api: unknown) => void;
type IpcInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
type IpcListener = (...args: unknown[]) => void;
type IpcOn = (channel: string, listener: IpcListener) => void;
type IpcOff = (channel: string, listener: IpcListener) => void;
type IpcSendSync = (channel: string) => unknown;

const electronMock = vi.hoisted(() => {
  const exposed = new Map<string, unknown>();
  const listeners = new Map<string, Set<IpcListener>>();
  const exposeInMainWorld = vi.fn<ExposeInMainWorld>((key, api) => {
    exposed.set(key, api);
  });
  const invoke = vi.fn<IpcInvoke>(async () => {
    return undefined;
  });
  const on = vi.fn<IpcOn>((channel, listener) => {
    const channelListeners = listeners.get(channel) ?? new Set<IpcListener>();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
  });
  const off = vi.fn<IpcOff>((channel, listener) => {
    listeners.get(channel)?.delete(listener);
  });
  const sendSync = vi.fn<IpcSendSync>(() => ({
    product: "okou",
    brandName: "Okou",
    displayName: "Okou",
  }));

  return {
    contextBridge: {
      exposeInMainWorld,
    },
    emit(channel: string, ...args: unknown[]): void {
      for (const listener of listeners.get(channel) ?? []) {
        listener(...args);
      }
    },
    exposed,
    ipcRenderer: {
      invoke,
      off,
      on,
      sendSync,
    },
    listeners,
  };
});

vi.mock("electron", () => {
  return {
    contextBridge: electronMock.contextBridge,
    ipcRenderer: electronMock.ipcRenderer,
  };
});

beforeEach(() => {
  vi.resetModules();
  electronMock.exposed.clear();
  electronMock.listeners.clear();
  electronMock.contextBridge.exposeInMainWorld.mockClear();
  electronMock.ipcRenderer.invoke.mockClear();
  electronMock.ipcRenderer.off.mockClear();
  electronMock.ipcRenderer.on.mockClear();
  electronMock.ipcRenderer.sendSync.mockClear();
});

describe("Desktop preload bridge", () => {
  it("exposes the desktop APIs in the renderer", async () => {
    await loadPreload();

    expect(
      electronMock.contextBridge.exposeInMainWorld.mock.calls.map(([key]) => {
        return key;
      }),
    ).toStrictEqual([
      "vm0DesktopAuth",
      "okouDesktopComputerUse",
      "okouDesktopDeveloperTools",
      "okouDesktopIdentity",
      "okouDesktopRecorder",
    ]);
    expect(exposedApi<DesktopAuthApi>("vm0DesktopAuth")).toBeTruthy();
    expect(
      exposedApi<DesktopComputerUseApi>("okouDesktopComputerUse"),
    ).toBeTruthy();
    expect(
      exposedApi<DesktopDeveloperToolsApi>("okouDesktopDeveloperTools"),
    ).toBeTruthy();
    expect(exposedApi("okouDesktopIdentity")).toStrictEqual({
      product: "okou",
      brandName: "Okou",
      displayName: "Okou",
    });
    expect(electronMock.ipcRenderer.sendSync).toHaveBeenCalledExactlyOnceWith(
      DESKTOP_IDENTITY_CHANNEL,
    );
  });

  it("routes desktop auth API calls through IPC channels", async () => {
    await loadPreload();
    const auth = exposedApi<DesktopAuthApi>("vm0DesktopAuth");

    await auth.getState();
    await auth.openSignIn();
    await auth.openOrgSelection();
    await auth.signOut();
    await auth.completeSignIn({ token: "desktop_token" });

    expect(electronMock.ipcRenderer.invoke.mock.calls).toStrictEqual([
      [DESKTOP_AUTH_CHANNELS.getState],
      [DESKTOP_AUTH_CHANNELS.openSignIn],
      [DESKTOP_AUTH_CHANNELS.openOrgSelection],
      [DESKTOP_AUTH_CHANNELS.signOut],
      [DESKTOP_AUTH_CHANNELS.completeSignIn, { token: "desktop_token" }],
    ]);
  });

  it("routes computer use API calls through IPC channels", async () => {
    await loadPreload();
    const computerUse = exposedApi<DesktopComputerUseApi>(
      "okouDesktopComputerUse",
    );

    await computerUse.getState();
    await computerUse.refreshPermissions();
    await computerUse.start({ userInitiated: true });
    await computerUse.stop();
    await computerUse.requestAccessibilityPermission();
    await computerUse.requestScreenRecordingPermission();
    await computerUse.probeAutomationPermission("chrome");
    await computerUse.setKeepAwakeEnabled(true);
    await computerUse.setFilesystemPluginEnabled(true);
    await computerUse.addFilesystemPluginAllowedDirectory();
    await computerUse.removeFilesystemPluginAllowedDirectory("/tmp/project");
    await computerUse.importMcpPluginServers('{"mcpServers":{}}');
    await computerUse.setMcpPluginServerEnabled("notes", true);
    await computerUse.removeMcpPluginServer("notes");
    await computerUse.openAccessibilitySettings();
    await computerUse.openScreenRecordingSettings();
    await computerUse.openAutomationSettings();

    expect(electronMock.ipcRenderer.invoke.mock.calls).toStrictEqual([
      [COMPUTER_USE_CHANNELS.getState],
      [COMPUTER_USE_CHANNELS.refreshPermissions],
      [COMPUTER_USE_CHANNELS.start, { userInitiated: true }],
      [COMPUTER_USE_CHANNELS.stop],
      [COMPUTER_USE_CHANNELS.requestAccessibilityPermission],
      [COMPUTER_USE_CHANNELS.requestScreenRecordingPermission],
      [COMPUTER_USE_CHANNELS.probeAutomationPermission, "chrome"],
      [COMPUTER_USE_CHANNELS.setKeepAwakeEnabled, true],
      [COMPUTER_USE_CHANNELS.setFilesystemPluginEnabled, true],
      [COMPUTER_USE_CHANNELS.addFilesystemPluginAllowedDirectory],
      [
        COMPUTER_USE_CHANNELS.removeFilesystemPluginAllowedDirectory,
        "/tmp/project",
      ],
      [COMPUTER_USE_CHANNELS.importMcpPluginServers, '{"mcpServers":{}}'],
      [COMPUTER_USE_CHANNELS.setMcpPluginServerEnabled, "notes", true],
      [COMPUTER_USE_CHANNELS.removeMcpPluginServer, "notes"],
      [COMPUTER_USE_CHANNELS.openAccessibilitySettings],
      [COMPUTER_USE_CHANNELS.openScreenRecordingSettings],
      [COMPUTER_USE_CHANNELS.openAutomationSettings],
    ]);
  });

  it("routes developer tools API calls through IPC channels", async () => {
    await loadPreload();
    const developerTools = exposedApi<DesktopDeveloperToolsApi>(
      "okouDesktopDeveloperTools",
    );

    await developerTools.getState();
    await developerTools.setEnabled(true);

    expect(electronMock.ipcRenderer.invoke.mock.calls).toStrictEqual([
      [DESKTOP_DEVELOPER_TOOLS_CHANNELS.getState],
      [DESKTOP_DEVELOPER_TOOLS_CHANNELS.setEnabled, true],
    ]);
  });

  it("cleans up desktop IPC subscriptions", async () => {
    await loadPreload();
    const auth = exposedApi<DesktopAuthApi>("vm0DesktopAuth");
    const computerUse = exposedApi<DesktopComputerUseApi>(
      "okouDesktopComputerUse",
    );
    const developerTools = exposedApi<DesktopDeveloperToolsApi>(
      "okouDesktopDeveloperTools",
    );
    const authChanged = vi.fn<() => void>();
    const computerUseChanged = vi.fn<() => void>();
    const developerToolsChanged = vi.fn<() => void>();

    const unsubscribeAuth = auth.subscribe(authChanged);
    const unsubscribeComputerUse = computerUse.subscribe(computerUseChanged);
    const unsubscribeDeveloperTools = developerTools.subscribe(
      developerToolsChanged,
    );

    electronMock.emit(DESKTOP_AUTH_CHANNELS.changed, { ignored: true });
    electronMock.emit(COMPUTER_USE_CHANNELS.changed, { ignored: true });
    electronMock.emit(DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed, {
      ignored: true,
    });

    expect(authChanged).toHaveBeenCalledOnce();
    expect(computerUseChanged).toHaveBeenCalledOnce();
    expect(developerToolsChanged).toHaveBeenCalledOnce();

    const authListener = listenerFor(DESKTOP_AUTH_CHANNELS.changed);
    const computerUseListener = listenerFor(COMPUTER_USE_CHANNELS.changed);
    const developerToolsListener = listenerFor(
      DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed,
    );
    unsubscribeAuth();
    unsubscribeComputerUse();
    unsubscribeDeveloperTools();
    electronMock.emit(DESKTOP_AUTH_CHANNELS.changed);
    electronMock.emit(COMPUTER_USE_CHANNELS.changed);
    electronMock.emit(DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed);

    expect(authChanged).toHaveBeenCalledOnce();
    expect(computerUseChanged).toHaveBeenCalledOnce();
    expect(developerToolsChanged).toHaveBeenCalledOnce();
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(
      DESKTOP_AUTH_CHANNELS.changed,
      authListener,
    );
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(
      COMPUTER_USE_CHANNELS.changed,
      computerUseListener,
    );
    expect(electronMock.ipcRenderer.off).toHaveBeenCalledWith(
      DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed,
      developerToolsListener,
    );
  });
});

async function loadPreload(): Promise<void> {
  await import("./preload");
}

function exposedApi<T>(key: string): T {
  const api = electronMock.exposed.get(key);
  if (!api) {
    throw new Error(`Expected ${key} to be exposed`);
  }
  return api as T;
}

function listenerFor(channel: string): IpcListener {
  const listener = electronMock.ipcRenderer.on.mock.calls.find((call) => {
    return call[0] === channel;
  })?.[1];
  if (!listener) {
    throw new Error(`Expected listener for ${channel}`);
  }
  return listener;
}
