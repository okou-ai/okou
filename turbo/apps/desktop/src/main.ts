import {
  captureDesktopNativeHelperError,
  captureDesktopNativePermissionRecovery,
} from "./sentry-main";
import { openAsBlob, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  net,
  powerSaveBlocker,
  protocol,
  session,
  shell,
} from "electron";
import { isComputerUseMcpPluginCallPayload } from "@okouai/api-contracts/contracts/computer-use-plugins";
import {
  MAC_AUTOMATION_SETTINGS_URL,
  createAutomationPermissionDeniedPrompt,
} from "./desktop-automation-permission";
import {
  installComputerUseIpc,
  notifyDesktopComputerUseChanged,
} from "./computer-use-electron";
import {
  type ComputerUseHostRuntime,
  readSystemHostName,
  resolveComputerUseApiBaseUrl,
} from "./computer-use-host";
import {
  hasRequiredComputerUsePermissions,
  type ComputerUseAutomationPermissionTarget,
  type DesktopComputerUseState,
} from "./computer-use-types";
import { isComputerUseSetupRequired } from "./computer-use-startup-gate";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import { DeveloperToolsController } from "./desktop-developer-tools-controller";
import { DesktopRecorderController } from "./desktop-recorder-controller";
import { createRecorderNativeBackend } from "./desktop-recorder-native";
import { deliverRecording } from "./desktop-recorder-delivery";
import { installDesktopRecorderIpc } from "./desktop-recorder-electron";
import { DesktopRecorderWindows } from "./desktop-recorder-windows";
import { STOP_SCREEN_RECORDING_ACCELERATOR } from "./desktop-recorder-types";
import type {
  DesktopRecorderArea,
  DesktopRecorderError,
  DesktopRecorderAudioChoice,
  DesktopRecorderPrepareRequest,
} from "./desktop-recorder-types";
import { buildWindowOptions } from "./desktop-recorder-window-options";
import { areaToGlobal } from "./desktop-recorder-overlay-geometry";
import { createDesktopComputerUsePermissions } from "./desktop-computer-use-permissions";
import {
  ComputerUseDriverController,
  type ComputerUseDriver,
} from "./computer-use-driver";
import { DesktopApplicationMenu } from "./desktop-application-menu";
import { createComputerUseNativeBackend } from "./computer-use-native";
import { resolveDesktopConfig } from "./config";
import desktopBrandAssets from "./desktop-brand-assets.json";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import type {
  DesktopAutoUpdatesController,
  DesktopMainModule,
} from "./desktop-main-module";
import { DesktopComputerUseAutoStartSupervisor } from "./desktop-computer-use-autostart";
import { createDesktopComputerUseHostRuntime } from "./desktop-computer-use-api";
import { readOrCreateComputerUseInstallationId } from "./desktop-computer-use-installation";
import { DesktopFilesystemPluginManager } from "./desktop-filesystem-plugin";
import { DesktopMcpPluginManager } from "./desktop-mcp-plugin";
import { DesktopKeepAwakeController } from "./desktop-keep-awake";
import type { DesktopIdentityInfo } from "./desktop-bridge";
import { DESKTOP_IDENTITY_CHANNEL } from "./desktop-identity-ipc-channels";
import { startDesktopLaunchComputerUse } from "./desktop-launch-computer-use";
import {
  DesktopQuitConfirmationController,
  buildDesktopQuitConfirmationOptions,
  isDesktopQuitConfirmed,
} from "./desktop-quit-confirmation";
import {
  DESKTOP_SMOKE_TEST_READY_MARKER,
  isDesktopSmokeTestEnabled,
} from "./desktop-smoke-test";
import { installDesktopTray, type DesktopTrayController } from "./desktop-tray";
import { DesktopAuthSession } from "./desktop-auth-session";
import { DesktopAuthWindow } from "./desktop-auth-window";
import {
  installDesktopAuthIpc,
  notifyDesktopAuthChanged,
} from "./desktop-auth-electron";
import {
  installDesktopDeveloperToolsIpc,
  notifyDesktopDeveloperToolsChanged,
} from "./desktop-developer-tools-electron";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthStartUrl,
  buildDesktopAuthTokenUrl,
  createDesktopAuthStartGate,
  isElectronNavigationAborted,
  isDesktopAuthStartNavigation,
  parseDesktopAuthCallback,
  parseDesktopAuthCallbackArgv,
  type DesktopAuthCallback,
} from "./desktop-auth";
import {
  buildDesktopMainWindowSizeOptions,
  hideDockForHiddenMainWindow,
  shouldHideMainWindowOnClose,
  showAndFocusWindow,
  showDockForVisibleMainWindow,
} from "./desktop-window-lifecycle";
import { buildDesktopWindowChromeOptions } from "./desktop-window-chrome";
import {
  desktopRecorderUrl,
  desktopRendererFilePath,
  desktopRendererUrl,
  isDesktopRendererUrl,
} from "./desktop-renderer-url";
import { decideWindowOpen } from "./window-policy";

const config = resolveDesktopConfig();
const desktopApiBaseUrl = resolveComputerUseApiBaseUrl(config.platformUrl);
const addDesktopClientHeaders = createDesktopClientHeaderInjector({
  clientVersion: app.getVersion(),
});
const desktopAuthStartUrl = buildDesktopAuthStartUrl(
  config.authUrl,
  config.identity.authScheme,
);
const desktopAuthSelectOrgUrl = buildDesktopAuthSelectOrgUrl(
  config.authUrl,
  true,
);
const desktopAuthTokenUrl = buildDesktopAuthTokenUrl(config.authUrl);
const localRendererUrl = desktopRendererUrl();
const localRecorderUrl = desktopRecorderUrl("bar");
const FEATURE_SWITCHES_PATH = "/api/feature-switches";
const noAllowedAppOrigins: ReadonlySet<string> = new Set();
const SCREEN_RECORDING_POLL_INTERVAL_MS = 1000;
const MAC_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const MAC_SCREEN_RECORDING_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
let mainWindow: BrowserWindow | null = null;
let appIsQuitting = false;
let computerUseQuitPreparationPromise: Promise<void> | null = null;
let computerUseQuitPreparationComplete = false;
let desktopTray: DesktopTrayController | null = null;
let keepAwakeController: DesktopKeepAwakeController | null = null;

const desktopIdentity: DesktopIdentityInfo = {
  product: config.identity.product,
  brandName: config.identity.brandName,
  displayName: config.identity.displayName,
};

ipcMain.on(DESKTOP_IDENTITY_CHANNEL, (event) => {
  event.returnValue = desktopIdentity;
});
let filesystemPluginManager: DesktopFilesystemPluginManager | null = null;
let mcpPluginManager: DesktopMcpPluginManager | null = null;
let desktopAutoUpdates: DesktopAutoUpdatesController | null = null;
const desktopAuthStartGate = createDesktopAuthStartGate();
const okouDriver: ComputerUseDriver = {
  id: "okou",
  buildVersion: app.getVersion(),
  createBackend: () =>
    createComputerUseNativeBackend({
      onRuntimeError: captureDesktopNativeHelperError,
    }),
};
const computerUseDriver = new ComputerUseDriverController(
  okouDriver,
  process.platform,
  notifyComputerUseChanged,
);
const {
  getComputerUsePermissionState,
  resetComputerUsePermissionState,
  refreshReady,
  refreshComputerUsePermissionState,
  requestComputerUseAccessibilityPermission,
  requestComputerUseScreenRecordingPermission,
  probeComputerUseAutomationPermission,
  recordComputerUseAutomationPermissionDenied,
} = createDesktopComputerUsePermissions({
  refreshNative: (query) =>
    computerUseController.refreshNativePermissions(query),
  driver: computerUseDriver,
});
const automationPermissionPrompt = createAutomationPermissionDeniedPrompt({
  sourceLabel: config.identity.displayName,
  showDialog: async (options) => {
    const window = currentDialogWindow();
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    return result.response;
  },
  openAutomationSettings: () => {
    openExternal(MAC_AUTOMATION_SETTINGS_URL);
  },
  onPermissionDenied: (target, reason) => {
    recordComputerUseAutomationPermissionDenied(target, reason);
    notifyComputerUseChanged();
  },
  onError: (error) => {
    console.error("Automation permission prompt failed", error);
  },
});
const computerUseAutoStart = new DesktopComputerUseAutoStartSupervisor({
  getState: getComputerUseBridgeState,
  start: async () => {
    await startComputerUseRuntime();
  },
  logError: logComputerUseAutoStartError,
});
const quitConfirmation = new DesktopQuitConfirmationController({
  confirmQuit: confirmDesktopQuit,
  quit: () => {
    app.quit();
  },
});
/**
 * Whether a finished recording could be handed back to Okou.
 *
 * Answering means two round trips to the API, and it used to be asked only
 * when Start was pressed, ahead of everything else on that path: on a slow
 * link that alone was a second or more of "Starting…". The question is asked
 * when the bar opens instead, and Start reuses that answer while the bar is
 * up. A bar left open for a long time asks again.
 */
let deliverabilityCheck: {
  readonly at: number;
  readonly result: Promise<boolean>;
} | null = null;
const DELIVERABILITY_CHECK_LIFETIME_MS = 5 * 60 * 1000;

function checkDeliverability(): Promise<boolean> {
  const now = Date.now();
  if (
    deliverabilityCheck &&
    now - deliverabilityCheck.at < DELIVERABILITY_CHECK_LIFETIME_MS
  ) {
    return deliverabilityCheck.result;
  }
  const result = getAuthSession()
    .getAuthState()
    .then((auth) => {
      return auth.status === "signed_in" && auth.organization !== null;
    });
  // A failed check must not be served to the next Start; it asks afresh.
  result.catch(() => {
    if (deliverabilityCheck?.result === result) {
      deliverabilityCheck = null;
    }
  });
  deliverabilityCheck = { at: now, result };
  return result;
}

const screenRecorder = new DesktopRecorderController({
  createBackend: () => createRecorderNativeBackend(),
  createOutputPath: () =>
    path.join(
      app.getPath("userData"),
      "recordings",
      `screen-recording-${Date.now().toString()}.mp4`,
    ),
  canDeliver: () => checkDeliverability(),
  deliver: async (recording) => {
    const auth = await getAuthSession().getAuthState();
    if (auth.status !== "signed_in") {
      throw new Error("Sign in to Okou to upload the recording");
    }
    return await deliverRecording(recording, {
      apiBaseUrl: desktopApiBaseUrl,
      appUrl: config.platformUrl.toString(),
      userId: auth.user.userId,
      fetchWithSessionAuth: (url, init) =>
        getAuthSession().fetchWithSessionAuth(url, init),
      fetchUpload: (url, init) => fetch(url, init),
      // Streams from disk rather than buffering a whole video in memory.
      readFile: (filePath) => openAsBlob(filePath),
    });
  },
  openReview: (reviewUrl) => {
    openExternal(reviewUrl);
  },
  onChange: notifyScreenRecorderChanged,
  logError: (error) => {
    console.warn("Desktop screen recording teardown failed", error);
  },
});
let screenRecordingPollTimer: NodeJS.Timeout | null = null;
const developerTools = new DeveloperToolsController({
  getSessionAuthority: () => authSession?.getAuthority() ?? null,
  fetchFeatureSwitches: () =>
    getAuthSession().fetchWithSessionAuth(
      new URL(FEATURE_SWITCHES_PATH, desktopApiBaseUrl),
    ),
  setFilesystemPluginFeatureEnabled: (enabled) => {
    filesystemPluginManager?.setFeatureEnabled(enabled);
    mcpPluginManager?.setFeatureEnabled(enabled);
  },
  setScreenRecordingFeatureEnabled: (enabled) => {
    screenRecorder.setFeatureEnabled(enabled);
  },
  onChange: notifyDeveloperToolsChanged,
  logRefreshError: (error) => {
    console.warn("Unable to refresh desktop developer tools state", error);
  },
});
const applicationMenu = new DesktopApplicationMenu({
  displayName: config.identity.displayName,
  developerTools,
  updatesEnabled: () => desktopAutoUpdates !== null,
  checkForUpdates: requestDesktopUpdateCheck,
  quit: requestDesktopQuit,
});
const computerUseController = new ComputerUseRuntimeController({
  onPermissionRecovery: captureDesktopNativePermissionRecovery,
  driver: computerUseDriver,
  createRuntime: createComputerUseHostRuntime,
  refreshPermissions: refreshComputerUsePermissionState,
  getPluginCapabilities: supportedPluginCapabilities,
  preparePlugins: async () => {
    await Promise.all([
      ensureFilesystemPluginManager().prepareForHost(),
      ensureMcpPluginManager().prepareForHost(),
    ]);
  },
  getAuthState: () => getAuthSession().getAuthState(),
  getAuthAuthority: () => getAuthSession().getAuthority(),
  setHostRuntimeOnline: (online) => {
    filesystemPluginManager?.setHostRuntimeOnline(online);
    mcpPluginManager?.setHostRuntimeOnline(online);
  },
  onChange: notifyComputerUseChanged,
});

function refreshDesktopTray(): void {
  desktopTray?.refresh();
}

/**
 * Keeps the poll timer and the global stop shortcut alive exactly while a
 * capture is running.
 *
 * The helper protocol has no push channel, so a source disappearing — the
 * display being unplugged — only surfaces through polling. The shortcut is
 * registered just for the duration so it is not held hostage the rest of the
 * time, and it exists because the recording controls live in the menu bar
 * rather than in an overlay that the capture would record.
 */
let lastLoggedRecorderError: DesktopRecorderError | null = null;

function notifyScreenRecorderChanged(): void {
  refreshDesktopTray();

  const state = screenRecorder.getState();
  // The tray truncates the message to a menu line; the terminal gets it whole.
  if (state.error && state.error !== lastLoggedRecorderError) {
    console.error(
      `Desktop screen recording ${state.error.code}: ${state.error.message}`,
    );
  }
  lastLoggedRecorderError = state.error;

  const status = state.status;
  // Paused still holds the capture open, so the poll, the stop shortcut and the
  // on-screen controls all stay alive for it.
  const isCapturing = status === "recording" || status === "paused";

  // The controller stays up through the finish as well as the capture: it
  // vanishing the instant Stop was pressed, seconds before the finalize and
  // upload were done, read as the recorder having quit. It is dismissed once
  // the session is over, whether that came from the tray, the shortcut, the
  // system indicator, a failure, or a successful delivery.
  const showsController =
    isCapturing || status === "finalizing" || status === "delivering";
  if (!showsController) {
    recorderWindows?.hideController();
  }

  if (isCapturing === (screenRecordingPollTimer !== null)) {
    return;
  }

  if (isCapturing) {
    screenRecordingPollTimer = setInterval(() => {
      void screenRecorder.refreshRecordingStatus().catch((error: unknown) => {
        console.warn("Desktop screen recording status refresh failed", error);
      });
    }, SCREEN_RECORDING_POLL_INTERVAL_MS);
    if (
      !globalShortcut.register(
        STOP_SCREEN_RECORDING_ACCELERATOR,
        stopScreenRecordingFromShortcut,
      )
    ) {
      console.warn(
        "Unable to register the screen recording stop shortcut",
        STOP_SCREEN_RECORDING_ACCELERATOR,
      );
    }
    return;
  }

  clearInterval(screenRecordingPollTimer ?? undefined);
  screenRecordingPollTimer = null;
  globalShortcut.unregister(STOP_SCREEN_RECORDING_ACCELERATOR);
}

function stopScreenRecordingFromShortcut(): void {
  void screenRecorder.stop().catch((error: unknown) => {
    console.error("Desktop screen recording stop failed", error);
  });
}

function refreshDesktopTrayAuth(): void {
  desktopTray?.refreshAuth();
}

function notifyComputerUseChanged(): void {
  filesystemPluginManager?.setHostRuntimeOnline(
    computerUseController.pluginsMayRun(),
  );
  mcpPluginManager?.setHostRuntimeOnline(computerUseController.pluginsMayRun());
  notifyDesktopComputerUseChanged();
  refreshDesktopTray();
  computerUseAutoStart.restartRecoverableRuntimeState();
}

let lastSessionAuthority: object | null = null;
function notifyAuthChanged(): void {
  const authority = authSession?.getAuthority() ?? null;
  if (lastSessionAuthority !== authority) {
    lastSessionAuthority = authority;
    resetComputerUsePermissionState();
    // Finish auth-owned cleanup before permission inspection resumes. A
    // cancelled probe must not leave the native helper permanently paused.
    void computerUseController.stopForAuthChange().catch(() => {
      console.warn("Computer Use session cleanup remains unproven");
    });
  }
  notifyDesktopAuthChanged();
  refreshDesktopTrayAuth();
  developerTools.requestRefresh();
}

function notifyDeveloperToolsChanged(): void {
  notifyDesktopDeveloperToolsChanged();
  notifyDesktopComputerUseChanged();
  if (app.isReady()) {
    applicationMenu.refresh();
  }
}

const authWindow = new DesktopAuthWindow({
  authOrigin: config.authUrl.origin,
  partition: config.authPartition,
  windowOptions: () => browserWindowOptions(),
  openExternal,
});
let authStorageClearing: Promise<void> | null = null;

let authSession: DesktopAuthSession | null = null;
let pendingDesktopAuthCallback: DesktopAuthCallback | null = null;

function getAuthSession(): DesktopAuthSession {
  if (authSession) {
    return authSession;
  }

  if (!app.isReady()) {
    throw new Error("Desktop auth session is unavailable before app is ready");
  }

  authSession = new DesktopAuthSession({
    apiBaseUrl: desktopApiBaseUrl,
    addClientHeaders: addDesktopClientHeaders,
    tokenUrl: desktopAuthTokenUrl,
    consumeUrl: (code, handoffId) =>
      buildDesktopAuthConsumeUrl(config.authUrl, code, handoffId),
    selectOrgUrl: desktopAuthSelectOrgUrl,
    runAuthWindow: async (request) => {
      await authStorageClearing;
      request.signal.throwIfAborted();
      return await authWindow.run(request);
    },
    onChange: notifyAuthChanged,
    onBackgroundRefresh: (event) =>
      computerUseController.handleBackgroundAuthRefresh(event),
    onAuthCompleted: maybeStartComputerUseAfterAuth,
  });

  if (pendingDesktopAuthCallback) {
    authSession.queuePendingCallback(pendingDesktopAuthCallback);
    pendingDesktopAuthCallback = null;
  }

  return authSession;
}

function queuePendingDesktopAuthCallback(callback: DesktopAuthCallback): void {
  if (authSession) {
    authSession.queuePendingCallback(callback);
    return;
  }
  pendingDesktopAuthCallback = callback;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "vm0-desktop",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function preloadPath(): string {
  return path.join(__dirname, "preload.js");
}

function desktopAssetPath(filename: string): string {
  return path.join(__dirname, "..", "assets", filename);
}

function appIconPath(): string {
  return desktopAssetPath(desktopBrandAssets.appIconFileName);
}

function trayIconPath(): string {
  return desktopAssetPath(desktopBrandAssets.trayIconFileName);
}

function trayIconDisabledPath(): string {
  return desktopAssetPath(desktopBrandAssets.trayIconDisabledFileName);
}

function trayIconRunningPath(): string {
  return desktopAssetPath(desktopBrandAssets.trayIconRunningFileName);
}

function desktopPreferencesPath(): string {
  return path.join(app.getPath("userData"), "desktop-preferences.json");
}

function applyAppName(): void {
  app.setName(config.identity.displayName);
  app.name = config.identity.displayName;
}

function applyDockIcon(): void {
  if (process.platform === "darwin" && app.dock) {
    app.dock.setIcon(appIconPath());
  }
}

function hideDockForInactiveMainWindow(): void {
  hideDockForHiddenMainWindow({
    platform: process.platform,
    dock: app.dock,
  });
}

async function showDockForActiveMainWindow(): Promise<void> {
  await showDockForVisibleMainWindow({
    platform: process.platform,
    dock: app.dock,
  });
}

function installDesktopRendererProtocol(): void {
  const electronSession = session.fromPartition(config.sessionPartition);
  electronSession.protocol.handle("vm0-desktop", (request) => {
    const filePath = desktopRendererFilePath(request.url);
    if (!filePath) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}
function friendlyDeviceName(): string | null {
  const hostname = os.hostname().trim();
  if (!hostname) {
    return null;
  }
  return hostname.replace(/\.local$/i, "");
}

function getComputerUseBridgeState(): DesktopComputerUseState {
  return {
    driver: computerUseController.getDriverState(),
    platform: process.platform,
    supported: process.platform === "darwin",
    deviceName: friendlyDeviceName(),
    permissions: getComputerUsePermissionState(),
    host: computerUseController.getHostState(),
    keepAwake: keepAwakeController?.getState() ?? {
      enabled: false,
      active: false,
    },
    plugins: {
      filesystem: filesystemPluginManager?.getState() ?? {
        featureEnabled: false,
        enabled: false,
        allowedDirectories: [],
        status: "disabled",
        lastError: null,
        version: "",
        capabilities: [],
      },
      mcp: mcpPluginManager?.getState() ?? {
        featureEnabled: false,
        servers: [],
      },
    },
  };
}

function installKeepAwake(): void {
  keepAwakeController = new DesktopKeepAwakeController({
    preferencesPath: desktopPreferencesPath(),
    blocker: powerSaveBlocker,
    onChange: notifyComputerUseChanged,
  });
  keepAwakeController.load();
}

function setKeepAwakeEnabled(enabled: boolean): DesktopComputerUseState {
  if (!keepAwakeController) {
    throw new Error("Desktop keep-awake settings are unavailable");
  }
  keepAwakeController.setEnabled(enabled);
  return getComputerUseBridgeState();
}

function releaseKeepAwake(): void {
  keepAwakeController?.release();
}

function ensureFilesystemPluginManager(): DesktopFilesystemPluginManager {
  if (!filesystemPluginManager) {
    filesystemPluginManager = new DesktopFilesystemPluginManager({
      preferencesPath: desktopPreferencesPath(),
      onChange: notifyComputerUseChanged,
    });
    filesystemPluginManager.load();
  }
  return filesystemPluginManager;
}

function ensureMcpPluginManager(): DesktopMcpPluginManager {
  if (!mcpPluginManager) {
    mcpPluginManager = new DesktopMcpPluginManager({
      preferencesPath: desktopPreferencesPath(),
      onChange: notifyComputerUseChanged,
    });
    mcpPluginManager.load();
  }
  return mcpPluginManager;
}

function supportedComputerUseCapabilities(): readonly string[] {
  return [
    ...computerUseDriver.getCapabilities(),
    ...supportedPluginCapabilities(),
  ];
}

function supportedPluginCapabilities(): readonly string[] {
  return [
    ...(filesystemPluginManager?.getCapabilities() ?? []),
    ...(mcpPluginManager?.getCapabilities() ?? []),
  ];
}

function createComputerUseHostRuntime(options: {
  readonly refreshRegistrationAuth: boolean;
}): ComputerUseHostRuntime {
  const installationId = readOrCreateComputerUseInstallationId(
    desktopPreferencesPath(),
  );
  return createDesktopComputerUseHostRuntime(
    {
      refreshRegistrationAuth: options.refreshRegistrationAuth,
      platformUrl: config.platformUrl,
      installationId,
      hostName: readSystemHostName(config.identity.displayName),
      appVersion: app.getVersion(),
      hostFetch: (input, init) => {
        return fetch(input, init);
      },
      addClientHeaders: addDesktopClientHeaders,
      getPermissions: refreshReady,
      getSupportedCapabilities: supportedComputerUseCapabilities,
      driver: computerUseDriver,
      executePluginCommand: (command) => {
        if (isComputerUseMcpPluginCallPayload(command.payload)) {
          return ensureMcpPluginManager().execute(command);
        }
        return ensureFilesystemPluginManager().execute(command);
      },
      onCommandFailure: automationPermissionPrompt,
      onChange: notifyComputerUseChanged,
    },
    {
      getAuthSession,
    },
  );
}

async function startComputerUseRuntime(
  options: { readonly userInitiated?: boolean } = {},
): Promise<DesktopComputerUseState> {
  try {
    await computerUseController.start(options);
  } catch {
    throw new Error(
      "Computer Use could not start. Check driver status and cleanup.",
    );
  }
  return getComputerUseBridgeState();
}

async function stopComputerUseRuntime(): Promise<DesktopComputerUseState> {
  try {
    await computerUseController.stop();
  } catch {
    throw new Error("Computer Use cleanup is still pending.");
  }
  return getComputerUseBridgeState();
}

function setFilesystemPluginEnabled(enabled: boolean): DesktopComputerUseState {
  ensureFilesystemPluginManager().setEnabled(enabled);
  return getComputerUseBridgeState();
}

function importMcpPluginServers(json: string): DesktopComputerUseState {
  ensureMcpPluginManager().importServersJson(json);
  return getComputerUseBridgeState();
}

function setMcpPluginServerEnabled(
  server: string,
  enabled: boolean,
): DesktopComputerUseState {
  ensureMcpPluginManager().setServerEnabled(server, enabled);
  return getComputerUseBridgeState();
}

function removeMcpPluginServer(server: string): DesktopComputerUseState {
  ensureMcpPluginManager().removeServer(server);
  return getComputerUseBridgeState();
}

async function addFilesystemPluginAllowedDirectory(): Promise<DesktopComputerUseState> {
  const options = {
    properties: ["openDirectory", "createDirectory"],
  } satisfies Electron.OpenDialogOptions;
  const window = currentDialogWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (!result.canceled) {
    const [directory] = result.filePaths;
    if (directory) {
      ensureFilesystemPluginManager().addAllowedDirectory(directory);
    }
  }
  return getComputerUseBridgeState();
}

function removeFilesystemPluginAllowedDirectory(
  directory: string,
): DesktopComputerUseState {
  ensureFilesystemPluginManager().removeAllowedDirectory(directory);
  return getComputerUseBridgeState();
}

async function requestComputerUsePermission(): Promise<DesktopComputerUseState> {
  await requestComputerUseAccessibilityPermission();
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

async function requestComputerUseScreenRecording(): Promise<DesktopComputerUseState> {
  await requestComputerUseScreenRecordingPermission();
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

async function refreshComputerUsePermissions(): Promise<DesktopComputerUseState> {
  const permissions = await refreshComputerUsePermissionState();
  if (!hasRequiredComputerUsePermissions(permissions)) {
    computerUseController.clearBlockedHostState();
  }
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

async function probeComputerUseAutomation(
  target: ComputerUseAutomationPermissionTarget,
): Promise<DesktopComputerUseState> {
  await probeComputerUseAutomationPermission(target);
  notifyComputerUseChanged();
  return getComputerUseBridgeState();
}

function installComputerUse(): void {
  ensureFilesystemPluginManager();
  ensureMcpPluginManager();
  installComputerUseIpc(
    {
      getState: getComputerUseBridgeState,
      refreshPermissions: refreshComputerUsePermissions,
      start: startComputerUseRuntime,
      stop: stopComputerUseRuntime,
      requestAccessibilityPermission: requestComputerUsePermission,
      requestScreenRecordingPermission: requestComputerUseScreenRecording,
      probeAutomationPermission: probeComputerUseAutomation,
      setKeepAwakeEnabled,
      setFilesystemPluginEnabled,
      addFilesystemPluginAllowedDirectory,
      removeFilesystemPluginAllowedDirectory,
      importMcpPluginServers,
      setMcpPluginServerEnabled,
      removeMcpPluginServer,
    },
    { rendererUrl: localRendererUrl, getMainWindow: () => mainWindow },
  );
}

let recorderWindows: DesktopRecorderWindows | null = null;

function getRecorderWindows(): DesktopRecorderWindows {
  recorderWindows ??= new DesktopRecorderWindows({
    preloadPath: preloadPath(),
    sessionPartition: config.sessionPartition,
    logError: (error) => {
      console.error("Desktop recorder overlay failed", error);
    },
  });
  return recorderWindows;
}

/**
 * The audio choices made in the bar, held while the area overlays are open.
 *
 * An area capture starts from the overlay that drew the region, by which time
 * the bar is no longer the one asking, so its toggles have to travel with the
 * selection rather than be read back from a window that may already be gone.
 */
let pendingAreaAudio: DesktopRecorderAudioChoice | null = null;

async function startRecorderCapture(
  request: DesktopRecorderPrepareRequest,
  captured: DesktopRecorderArea | null,
): Promise<void> {
  const windows = getRecorderWindows();
  // Each phase is timed and logged: "Starting…" was reported as taking
  // seconds, and where those seconds go is the only way to know what to cut.
  const startedAt = Date.now();
  const phases: string[] = [];
  const timed = async (name: string, run: () => Promise<void>) => {
    const phaseStartedAt = Date.now();
    await run();
    phases.push(`${name} ${String(Date.now() - phaseStartedAt)}ms`);
  };
  await timed("permission", () =>
    screenRecorder.ensureScreenRecordingPermission(),
  );
  await timed("prepare", () => screenRecorder.prepare(request));
  await timed("start", () => screenRecorder.start());
  // The bar has done its job; leaving it up would put it in the capture.
  windows.hideBar();
  windows.showController(captured);
  console.info(
    `Desktop screen recording started in ${String(Date.now() - startedAt)}ms (${phases.join(", ")})`,
  );
}

function installDesktopRecorder(): void {
  installDesktopRecorderIpc(
    {
      getState: () => screenRecorder.getState(),
      getCapabilities: () => screenRecorder.getCapabilities(),
      listWindowOptions: async () => {
        await screenRecorder.ensureScreenRecordingPermission();
        const [sources, previews] = await Promise.all([
          screenRecorder.listSources(),
          screenRecorder.listWindowPreviews(),
        ]);
        return buildWindowOptions(sources, previews);
      },
      startCapture: async (request) => {
        const windows = getRecorderWindows();
        await startRecorderCapture(
          {
            sourceId:
              request.sourceKind === "window"
                ? request.sourceId
                : windows.displaySourceId(windows.barDisplayId()),
            sourceKind: request.sourceKind,
            systemAudio: request.systemAudio,
            microphone: request.microphone,
          },
          null,
        );
      },
      beginAreaSelection: (audio) => {
        pendingAreaAudio = audio;
        getRecorderWindows().openAreaSelectors();
      },
      completeAreaSelection: async (selection) => {
        const windows = getRecorderWindows();
        const audio = pendingAreaAudio;
        pendingAreaAudio = null;
        windows.closeAreaSelectors();
        if (!selection || !audio) {
          return;
        }
        const display = windows.displayBounds(selection.displayId);
        if (!display) {
          throw new Error("The screen that region was drawn on is gone");
        }
        const area = areaToGlobal(selection.area, display);
        await startRecorderCapture(
          {
            sourceId: windows.displaySourceId(selection.displayId),
            sourceKind: "area",
            systemAudio: audio.systemAudio,
            microphone: audio.microphone,
            area,
          },
          area,
        );
      },
      selectWindow: () => getRecorderWindows().selectWindow(),
      completeWindowSelection: (choice) => {
        getRecorderWindows().completeWindowSelection(choice);
      },
      pause: () => screenRecorder.pause(),
      resume: () => screenRecorder.resume(),
      discard: () => screenRecorder.discard(),
      stop: async () => {
        try {
          await screenRecorder.stop();
        } catch (error) {
          // The window that asked may already be gone; the terminal running
          // the app is the one place this is guaranteed to be seen.
          console.error("Desktop screen recording stop failed", error);
          throw error;
        }
      },
      cancel: () => {
        getRecorderWindows().hideBar();
      },
      openScreenRecordingSettings: () => {
        openExternal(MAC_SCREEN_RECORDING_SETTINGS_URL);
      },
    },
    { recorderUrl: localRecorderUrl },
  );
}

function installDesktopDeveloperTools(): void {
  installDesktopDeveloperToolsIpc(
    {
      getState: () => developerTools.getState(),
      setEnabled: (enabled) => developerTools.setEnabled(enabled),
    },
    { rendererUrl: localRendererUrl },
  );
}

function refreshComputerUsePermissionsForState(): void {
  void refreshComputerUsePermissionState()
    .catch((error) => {
      console.warn("Unable to refresh native Computer Use permissions", error);
    })
    .finally(() => {
      notifyComputerUseChanged();
    });
}

async function prepareForQuitAndInstall(): Promise<void> {
  await computerUseController.stopForQuit("update_relaunch");
  quitConfirmation.allowQuitWithoutConfirmation();
  appIsQuitting = true;
  applicationMenu.dispose();
  releaseKeepAwake();
}

// Bootstrap contract: the auto-updater is owned by bootstrap.ts so it keeps
// working when this bundle fails to load. Bootstrap reads these typed exports
// after requiring this module at runtime.
export const desktopUpdateHooks: DesktopMainModule["desktopUpdateHooks"] =
  () => ({
    getComputerUseHostState: () => getComputerUseBridgeState().host,
    prepareForQuitAndInstall,
  });

export const notifyDesktopAutoUpdatesInstalled: DesktopMainModule["notifyDesktopAutoUpdatesInstalled"] =
  (autoUpdates) => {
    desktopAutoUpdates = autoUpdates;
    applicationMenu.refresh();
  };

async function signOutDesktopSession(): Promise<void> {
  getAuthSession().signOut();
  authStorageClearing = (authStorageClearing ?? Promise.resolve()).then(
    async () => {
      await authWindow.clearStorage();
      await computerUseController.stopForAuthChange();
    },
  );
  await authStorageClearing;
}

function installDesktopAuth(): void {
  installDesktopAuthIpc(
    {
      getState: () => getAuthSession().getAuthState(),
      openSignIn: () => {
        openExternal(desktopAuthStartUrl);
      },
      openOrgSelection: () => getAuthSession().selectOrganization(),
      signOut: signOutDesktopSession,
    },
    {
      rendererUrl: localRendererUrl,
      authWindow,
    },
  );
}

function installTray(): void {
  desktopTray = installDesktopTray({
    displayName: config.identity.displayName,
    iconPath: trayIconPath(),
    disabledIconPath: trayIconDisabledPath(),
    runningIconPath: trayIconRunningPath(),
    getComputerUseState: getComputerUseBridgeState,
    getAuthState: () => getAuthSession().getAuthState(),
    showMainWindow: async () => {
      await createMainWindow();
    },
    startComputerUse: async () => {
      await startComputerUseRuntime({ userInitiated: true });
    },
    stopComputerUse: async () => {
      await stopComputerUseRuntime();
    },
    refreshStatus: async () => {
      await refreshComputerUsePermissions();
    },
    openSignIn: () => {
      openExternal(desktopAuthStartUrl);
    },
    switchWorkspace: () => getAuthSession().selectOrganization(),
    signOut: signOutDesktopSession,
    requestAccessibilityPermission: async () => {
      await requestComputerUsePermission();
    },
    requestScreenRecordingPermission: async () => {
      await requestComputerUseScreenRecording();
    },
    openAccessibilitySettings: () => {
      openExternal(MAC_ACCESSIBILITY_SETTINGS_URL);
    },
    openScreenRecordingSettings: () => {
      openExternal(MAC_SCREEN_RECORDING_SETTINGS_URL);
    },
    setKeepAwakeEnabled: async (enabled) => {
      setKeepAwakeEnabled(enabled);
    },
    getRecorderState: () => screenRecorder.getState(),
    startScreenRecording: async () => {
      getRecorderWindows().showBar();
      // Asked now so Start does not have to wait for the answer.
      checkDeliverability().catch(() => {});
    },
    stopScreenRecording: async () => {
      await screenRecorder.stop();
    },
    retryScreenRecordingDelivery: async () => {
      await screenRecorder.retryDelivery();
    },
    quit: () => {
      requestDesktopQuit();
    },
  });
}

function requestDesktopQuit(): void {
  void quitConfirmation.requestQuit().catch((error) => {
    console.error("Desktop quit confirmation failed", error);
  });
}

function requestDesktopUpdateCheck(): void {
  if (!desktopAutoUpdates) {
    return;
  }

  desktopAutoUpdates.checkForUpdates(config.identity.displayName);
}

function currentDialogWindow(): BrowserWindow | undefined {
  return mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
    ? mainWindow
    : undefined;
}

async function confirmDesktopQuit(): Promise<boolean> {
  const options = buildDesktopQuitConfirmationOptions(
    config.identity.displayName,
  );
  const window = currentDialogWindow();
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return isDesktopQuitConfirmed(result.response);
}

function openExternal(url: string): void {
  void shell.openExternal(url);
}

function logDesktopAuthError(error: unknown): void {
  if (isElectronNavigationAborted(error)) {
    return;
  }
  console.error("Desktop auth flow failed", error);
}

function logComputerUseAutoStartError(error: unknown): void {
  console.error("Desktop Computer Use auto-start failed", error);
}

function logComputerUseLaunchError(error: unknown): void {
  console.error("Desktop Computer Use launch setup check failed", error);
}

function openDesktopAuthStart(rawUrl: string): boolean {
  if (!isDesktopAuthStartNavigation(rawUrl, new Set([config.authUrl.origin]))) {
    return false;
  }

  if (desktopAuthStartGate.shouldOpen()) {
    openExternal(desktopAuthStartUrl);
  }
  return true;
}

function dispatchDesktopAuthCallback(callback: DesktopAuthCallback): void {
  desktopAuthStartGate.suppressRetry();
  if (authSession) {
    authSession.consumeCallback(callback, logDesktopAuthError);
    return;
  }
  queuePendingDesktopAuthCallback(callback);
}

function openDesktopAuthCallback(rawUrl: string): boolean {
  const callback = parseDesktopAuthCallback(rawUrl, config.identity.authScheme);
  if (!callback) {
    return false;
  }

  dispatchDesktopAuthCallback(callback);
  return true;
}

interface PreventableNavigationEvent {
  readonly preventDefault: () => void;
}

function handleAuthNavigation(
  event: PreventableNavigationEvent,
  url: string,
): boolean {
  if (openDesktopAuthCallback(url)) {
    event.preventDefault();
    return true;
  }
  if (openDesktopAuthStart(url)) {
    event.preventDefault();
    return true;
  }
  return false;
}

interface BrowserWindowOptionsInput {
  readonly preload?: boolean;
}

function browserWindowOptions(options: BrowserWindowOptionsInput = {}) {
  const preload = options.preload === false ? undefined : preloadPath();
  return {
    title: config.identity.displayName,
    backgroundColor: "#19191b",
    icon: appIconPath(),
    ...buildDesktopWindowChromeOptions(process.platform),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      ...(preload ? { preload } : {}),
      partition: config.sessionPartition,
    },
  } satisfies Electron.BrowserWindowConstructorOptions;
}

function installMainWindowPolicy(window: BrowserWindow): void {
  window.webContents.on("will-navigate", (event, url) => {
    if (handleAuthNavigation(event, url)) {
      return;
    }

    if (isDesktopRendererUrl(url, localRendererUrl)) {
      return;
    }
    event.preventDefault();
    const decision = decideWindowOpen(url, noAllowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
  });

  window.webContents.on("will-redirect", (event) => {
    if (!event.isMainFrame) {
      return;
    }
    handleAuthNavigation(event, event.url);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (openDesktopAuthCallback(url)) {
      return { action: "deny" };
    }
    if (openDesktopAuthStart(url)) {
      return { action: "deny" };
    }

    const decision = decideWindowOpen(url, noAllowedAppOrigins);
    if (decision.action === "open-external") {
      openExternal(decision.url);
    }
    return { action: "deny" };
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    await showDockForActiveMainWindow();
    showAndFocusWindow(mainWindow);
    return mainWindow;
  }

  await showDockForActiveMainWindow();
  const window = new BrowserWindow({
    ...browserWindowOptions(),
    ...buildDesktopMainWindowSizeOptions(),
  });

  mainWindow = window;
  window.on("close", (event) => {
    if (
      shouldHideMainWindowOnClose({
        platform: process.platform,
        isQuitting: appIsQuitting,
      })
    ) {
      event.preventDefault();
      window.hide();
      hideDockForInactiveMainWindow();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  installMainWindowPolicy(window);
  await window.loadURL(localRendererUrl);
  return window;
}

interface DesktopSmokeBridgeState {
  readonly auth: boolean;
  readonly authCompletionRejected: boolean;
  readonly computerUse: boolean;
  readonly developerTools: boolean;
  readonly driverControls: boolean;
  readonly driver: unknown;
  readonly identity: DesktopIdentityInfo | null;
}

function isDesktopIdentityInfo(value: unknown): value is DesktopIdentityInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "product" in value &&
    value.product === "okou" &&
    "brandName" in value &&
    value.brandName === "Okou" &&
    "displayName" in value &&
    typeof value.displayName === "string"
  );
}

function isDesktopSmokeBridgeState(
  value: unknown,
): value is DesktopSmokeBridgeState {
  return (
    typeof value === "object" &&
    value !== null &&
    "auth" in value &&
    typeof value.auth === "boolean" &&
    "authCompletionRejected" in value &&
    typeof value.authCompletionRejected === "boolean" &&
    "computerUse" in value &&
    typeof value.computerUse === "boolean" &&
    "developerTools" in value &&
    typeof value.developerTools === "boolean" &&
    "driverControls" in value &&
    typeof value.driverControls === "boolean" &&
    "driver" in value &&
    "identity" in value &&
    (value.identity === null || isDesktopIdentityInfo(value.identity))
  );
}

async function verifyDesktopSmokeBridge() {
  const window = await createMainWindow();
  const rawState: unknown = await window.webContents.executeJavaScript(
    `(async () => ({
      auth: typeof window.vm0DesktopAuth === "object",
      authCompletionRejected: await window.vm0DesktopAuth.completeSignIn({ token: "smoke-test-token" }).then(() => false, () => true),
      computerUse: typeof window.okouDesktopComputerUse === "object",
      developerTools: typeof window.okouDesktopDeveloperTools === "object",
      driverControls: ["start", "stop"].every(name => typeof window.okouDesktopComputerUse[name] === "function"),
      driver: (await window.okouDesktopComputerUse.getState()).driver,
      identity: window.okouDesktopIdentity ?? null,
    }))()`,
    true,
  );

  if (!isDesktopSmokeBridgeState(rawState)) {
    throw new Error("Desktop renderer bridge returned an invalid result");
  }

  const state = rawState;
  if (
    !state.auth ||
    !state.authCompletionRejected ||
    !state.computerUse ||
    !state.developerTools ||
    !state.driverControls ||
    !state.identity ||
    state.identity.product !== desktopIdentity.product ||
    state.identity.brandName !== desktopIdentity.brandName ||
    state.identity.displayName !== desktopIdentity.displayName
  ) {
    throw new Error("Desktop renderer bridge failed acceptance");
  }
  // Settle the real passive permission lifecycle, then read through IPC again.
  // Neither read admits native commands or starts the cloud host.
  await refreshComputerUsePermissions();
  const settledDriver: unknown = await window.webContents.executeJavaScript(
    "window.okouDesktopComputerUse.getState().then(state => state.driver)",
    true,
  );
  return { ...state, settledDriver };
}

async function maybeStartComputerUseAfterAuth(
  signal: AbortSignal,
): Promise<void> {
  await computerUseController.startForAuthChange(signal);
  signal.throwIfAborted();
  notifyDesktopAuthChanged();
  notifyComputerUseChanged();
}

async function shouldOpenComputerUseSetupWindowOnLaunch(): Promise<boolean> {
  const permissions = await refreshComputerUsePermissionState();
  if (!hasRequiredComputerUsePermissions(permissions)) {
    return true;
  }

  const authState = await getAuthSession().getAuthState();
  return isComputerUseSetupRequired({ authState, permissions });
}

function handleDesktopAuthCallback(rawUrl: string): void {
  openDesktopAuthCallback(rawUrl);
}

function handleDesktopAuthCallbackArgv(argv: readonly string[]): boolean {
  const callback = parseDesktopAuthCallbackArgv(
    argv,
    config.identity.authScheme,
  );
  if (!callback) {
    return false;
  }

  dispatchDesktopAuthCallback(callback);
  return true;
}

function queueDesktopAuthCallbackArgv(argv: readonly string[]): boolean {
  const callback = parseDesktopAuthCallbackArgv(
    argv,
    config.identity.authScheme,
  );
  if (!callback) {
    return false;
  }

  desktopAuthStartGate.suppressRetry();
  queuePendingDesktopAuthCallback(callback);
  return true;
}

function registerDesktopAuthProtocol(): void {
  if (process.platform !== "darwin") {
    return;
  }

  if (process.defaultApp) {
    const entryPoint = process.argv[1];
    if (entryPoint) {
      app.setAsDefaultProtocolClient(
        config.identity.authScheme,
        process.execPath,
        [path.resolve(entryPoint)],
      );
      return;
    }
  }

  app.setAsDefaultProtocolClient(config.identity.authScheme);
}

if (process.platform !== "darwin") {
  console.warn(
    "Computer Use Desktop is macOS-first and only packages for darwin.",
  );
}

applyAppName();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (handleDesktopAuthCallbackArgv(argv)) {
      return;
    }

    void createMainWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDesktopAuthCallback(url);
  });

  app.on("before-quit", (event) => {
    if (!quitConfirmation.isQuitAllowed()) {
      event.preventDefault();
      requestDesktopQuit();
      return;
    }

    if (computerUseQuitPreparationComplete) {
      return;
    }
    event.preventDefault();
    if (!computerUseQuitPreparationPromise) {
      computerUseQuitPreparationPromise = (async () => {
        try {
          await computerUseController.stopForQuit();
        } catch (error) {
          console.error("Unable to prepare Computer Use for app quit", error);
          return;
        }
        appIsQuitting = true;
        applicationMenu.dispose();
        releaseKeepAwake();
        globalShortcut.unregisterAll();
        computerUseQuitPreparationComplete = true;
        app.quit();
      })();
    }
  });

  void app.whenReady().then(async () => {
    applyDockIcon();
    hideDockForInactiveMainWindow();
    registerDesktopAuthProtocol();
    installDesktopRendererProtocol();
    applicationMenu.refresh();
    installKeepAwake();
    installComputerUse();
    installDesktopDeveloperTools();
    installDesktopRecorder();
    const desktopAuthSession = getAuthSession();
    installDesktopAuth();
    refreshComputerUsePermissionsForState();
    developerTools.requestRefresh();
    installTray();
    queueDesktopAuthCallbackArgv(process.argv);

    if (isDesktopSmokeTestEnabled(process.env)) {
      desktopAuthSession.signOut();
      try {
        const bridge = await verifyDesktopSmokeBridge();
        writeSync(
          1,
          `[smoke-test] evidence ${JSON.stringify({
            schemaVersion: 1,
            desktopVersion: app.getVersion(),
            electronVersion: process.versions.electron,
            bundleId: config.identity.bundleId,
            bridge,
          })}\n`,
        );
      } catch (error) {
        console.error("[smoke-test] desktop renderer bridge failed", error);
        app.exit(1);
        return;
      }
      writeSync(1, `${DESKTOP_SMOKE_TEST_READY_MARKER}\n`);
      process.exit(0);
    }

    startDesktopLaunchComputerUse({
      pendingCallback: desktopAuthSession.takePendingCallback(),
      consumeAuthCallback: (callback) =>
        desktopAuthSession.consumeCode(callback.code, callback.handoffId),
      isComputerUseSetupRequired: shouldOpenComputerUseSetupWindowOnLaunch,
      openSetupWindow: async () => {
        await createMainWindow();
      },
      requestAutoStartComputerUse: () => {
        computerUseAutoStart.requestStart();
      },
      logAuthError: logDesktopAuthError,
      logLaunchError: logComputerUseLaunchError,
    });

    app.on("activate", () => {
      void createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
