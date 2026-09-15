import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { BrowserWindow, ipcMain, shell } from "electron";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { isDesktopComputerUsePageUrl } from "./computer-use-page-url";
import { MAC_AUTOMATION_SETTINGS_URL } from "./desktop-automation-permission";
import {
  COMPUTER_USE_AUTOMATION_PERMISSION_TARGETS,
  type ComputerUseAutomationPermissionTarget,
  type DesktopComputerUseState,
} from "./computer-use-types";

interface ComputerUseIpcOptions {
  readonly rendererUrl: string;
  readonly getMainWindow: () => {
    isDestroyed(): boolean;
    readonly webContents: Pick<WebContents, "isDestroyed"> & {
      readonly mainFrame: Pick<
        WebFrameMain,
        "url" | "detached" | "isDestroyed"
      >;
    };
  } | null;
}

interface ComputerUseNativeApi {
  readonly getState: () => DesktopComputerUseState;
  readonly refreshPermissions: () => Promise<DesktopComputerUseState>;
  readonly start: (options: {
    readonly userInitiated: boolean;
  }) => Promise<DesktopComputerUseState>;
  readonly stop: () => Promise<DesktopComputerUseState>;
  readonly requestAccessibilityPermission: () => Promise<DesktopComputerUseState>;
  readonly requestScreenRecordingPermission: () => Promise<DesktopComputerUseState>;
  readonly probeAutomationPermission: (
    target: ComputerUseAutomationPermissionTarget,
  ) => Promise<DesktopComputerUseState>;
  readonly setKeepAwakeEnabled: (enabled: boolean) => DesktopComputerUseState;
  readonly setFilesystemPluginEnabled: (
    enabled: boolean,
  ) => DesktopComputerUseState;
  readonly addFilesystemPluginAllowedDirectory: () => Promise<DesktopComputerUseState>;
  readonly removeFilesystemPluginAllowedDirectory: (
    directory: string,
  ) => DesktopComputerUseState;
  readonly importMcpPluginServers: (json: string) => DesktopComputerUseState;
  readonly setMcpPluginServerEnabled: (
    server: string,
    enabled: boolean,
  ) => DesktopComputerUseState;
  readonly removeMcpPluginServer: (server: string) => DesktopComputerUseState;
}

function isComputerUseStartOptions(
  value: unknown,
): value is { readonly userInitiated?: unknown } {
  return (
    typeof value === "object" && value !== null && "userInitiated" in value
  );
}

function isAutomationPermissionTarget(
  value: unknown,
): value is ComputerUseAutomationPermissionTarget {
  return (
    typeof value === "string" &&
    COMPUTER_USE_AUTOMATION_PERMISSION_TARGETS.some((target) => {
      return target === value;
    })
  );
}

export function notifyDesktopComputerUseChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(COMPUTER_USE_CHANNELS.changed);
    }
  }
}

export function installComputerUseIpc(
  api: ComputerUseNativeApi,
  options: ComputerUseIpcOptions,
): void {
  const assertComputerUsePage = (event: IpcMainInvokeEvent): void => {
    const window = options.getMainWindow();
    const frame = event.senderFrame;
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      event.sender !== window.webContents ||
      frame !== window.webContents.mainFrame ||
      !frame ||
      frame.isDestroyed() ||
      frame.detached ||
      !isDesktopComputerUsePageUrl(
        event.senderFrame?.url ?? "",
        options.rendererUrl,
      )
    ) {
      throw new Error("Desktop Computer Use is unavailable on this page");
    }
  };
  const startOptions = (
    value: unknown,
  ): { readonly userInitiated: boolean } => {
    if (
      value !== undefined &&
      (!isComputerUseStartOptions(value) ||
        typeof value.userInitiated !== "boolean" ||
        Object.keys(value).some((key) => key !== "userInitiated"))
    )
      throw new Error("Invalid Computer Use start options");
    return {
      userInitiated:
        isComputerUseStartOptions(value) && value.userInitiated === true,
    };
  };

  ipcMain.handle(COMPUTER_USE_CHANNELS.getState, (event) => {
    assertComputerUsePage(event);
    return api.getState();
  });
  ipcMain.handle(COMPUTER_USE_CHANNELS.refreshPermissions, (event) => {
    assertComputerUsePage(event);
    return api.refreshPermissions();
  });
  ipcMain.handle(COMPUTER_USE_CHANNELS.start, async (event, options) => {
    assertComputerUsePage(event);
    return api.start(startOptions(options));
  });
  ipcMain.handle(COMPUTER_USE_CHANNELS.stop, async (event) => {
    assertComputerUsePage(event);
    return api.stop();
  });
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.requestAccessibilityPermission,
    (event) => {
      assertComputerUsePage(event);
      return api.requestAccessibilityPermission();
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.requestScreenRecordingPermission,
    (event) => {
      assertComputerUsePage(event);
      return api.requestScreenRecordingPermission();
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.probeAutomationPermission,
    (event, target: unknown) => {
      assertComputerUsePage(event);
      if (!isAutomationPermissionTarget(target)) {
        throw new Error("Unknown Computer Use Automation permission target");
      }
      return api.probeAutomationPermission(target);
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.setKeepAwakeEnabled,
    (event, enabled: unknown) => {
      assertComputerUsePage(event);
      if (typeof enabled !== "boolean") {
        throw new Error("Desktop keep-awake enabled state must be a boolean");
      }
      return api.setKeepAwakeEnabled(enabled);
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.setFilesystemPluginEnabled,
    (event, enabled: unknown) => {
      assertComputerUsePage(event);
      if (typeof enabled !== "boolean") {
        throw new Error("Filesystem plugin enabled state must be a boolean");
      }
      return api.setFilesystemPluginEnabled(enabled);
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.importMcpPluginServers,
    (event, json: unknown) => {
      assertComputerUsePage(event);
      if (typeof json !== "string" || !json.trim()) {
        throw new Error("MCP server configuration must be a JSON string");
      }
      return api.importMcpPluginServers(json);
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.setMcpPluginServerEnabled,
    (event, server: unknown, enabled: unknown) => {
      assertComputerUsePage(event);
      if (typeof server !== "string" || !server.trim()) {
        throw new Error("MCP server name must be a string");
      }
      if (typeof enabled !== "boolean") {
        throw new Error("MCP server enabled state must be a boolean");
      }
      return api.setMcpPluginServerEnabled(server, enabled);
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.removeMcpPluginServer,
    (event, server: unknown) => {
      assertComputerUsePage(event);
      if (typeof server !== "string" || !server.trim()) {
        throw new Error("MCP server name must be a string");
      }
      return api.removeMcpPluginServer(server);
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.addFilesystemPluginAllowedDirectory,
    (event) => {
      assertComputerUsePage(event);
      return api.addFilesystemPluginAllowedDirectory();
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.removeFilesystemPluginAllowedDirectory,
    (event, directory: unknown) => {
      assertComputerUsePage(event);
      if (typeof directory !== "string" || !directory.trim()) {
        throw new Error("Filesystem plugin directory must be a string");
      }
      return api.removeFilesystemPluginAllowedDirectory(directory);
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.openAccessibilitySettings,
    async (event) => {
      assertComputerUsePage(event);
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.openScreenRecordingSettings,
    async (event) => {
      assertComputerUsePage(event);
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
    },
  );
  ipcMain.handle(
    COMPUTER_USE_CHANNELS.openAutomationSettings,
    async (event) => {
      assertComputerUsePage(event);
      await shell.openExternal(MAC_AUTOMATION_SETTINGS_URL);
    },
  );
}
