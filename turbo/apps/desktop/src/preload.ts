import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopAuthApi,
  DesktopComputerUseApi,
  DesktopDeveloperToolsApi,
  DesktopIdentityInfo,
  DesktopRecorderApi,
} from "./desktop-bridge";
import { COMPUTER_USE_CHANNELS } from "./computer-use-ipc-channels";
import { DESKTOP_RECORDER_CHANNELS } from "./desktop-recorder-ipc-channels";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import { DESKTOP_DEVELOPER_TOOLS_CHANNELS } from "./desktop-developer-tools-ipc-channels";
import { DESKTOP_IDENTITY_CHANNEL } from "./desktop-identity-ipc-channels";
import type { DesktopComputerUseState } from "./computer-use-types";

const desktopAuthApi: DesktopAuthApi = {
  getState() {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.getState);
  },
  openSignIn(): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.openSignIn);
  },
  openOrgSelection(): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.openOrgSelection);
  },
  signOut(): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.signOut);
  },
  completeSignIn(params): Promise<void> {
    return ipcRenderer.invoke(DESKTOP_AUTH_CHANNELS.completeSignIn, params);
  },
  subscribe(callback: () => void): () => void {
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on(DESKTOP_AUTH_CHANNELS.changed, listener);
    return () => {
      ipcRenderer.off(DESKTOP_AUTH_CHANNELS.changed, listener);
    };
  },
};

const desktopComputerUseApi: DesktopComputerUseApi = {
  getState(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.getState);
  },
  refreshPermissions(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.refreshPermissions);
  },
  start(options): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.start, options);
  },
  stop(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.stop);
  },
  requestAccessibilityPermission(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.requestAccessibilityPermission,
    );
  },
  requestScreenRecordingPermission(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.requestScreenRecordingPermission,
    );
  },
  probeAutomationPermission(target): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.probeAutomationPermission,
      target,
    );
  },
  setKeepAwakeEnabled(enabled: boolean): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.setKeepAwakeEnabled,
      enabled,
    );
  },
  setFilesystemPluginEnabled(
    enabled: boolean,
  ): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.setFilesystemPluginEnabled,
      enabled,
    );
  },
  addFilesystemPluginAllowedDirectory(): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.addFilesystemPluginAllowedDirectory,
    );
  },
  removeFilesystemPluginAllowedDirectory(
    directory: string,
  ): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.removeFilesystemPluginAllowedDirectory,
      directory,
    );
  },
  importMcpPluginServers(json: string): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.importMcpPluginServers,
      json,
    );
  },
  setMcpPluginServerEnabled(
    server: string,
    enabled: boolean,
  ): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.setMcpPluginServerEnabled,
      server,
      enabled,
    );
  },
  removeMcpPluginServer(server: string): Promise<DesktopComputerUseState> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.removeMcpPluginServer,
      server,
    );
  },
  openAccessibilitySettings(): Promise<void> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.openAccessibilitySettings);
  },
  openScreenRecordingSettings(): Promise<void> {
    return ipcRenderer.invoke(
      COMPUTER_USE_CHANNELS.openScreenRecordingSettings,
    );
  },
  openAutomationSettings(): Promise<void> {
    return ipcRenderer.invoke(COMPUTER_USE_CHANNELS.openAutomationSettings);
  },
  subscribe(callback: () => void): () => void {
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on(COMPUTER_USE_CHANNELS.changed, listener);
    return () => {
      ipcRenderer.off(COMPUTER_USE_CHANNELS.changed, listener);
    };
  },
};

const desktopDeveloperToolsApi: DesktopDeveloperToolsApi = {
  getState() {
    return ipcRenderer.invoke(DESKTOP_DEVELOPER_TOOLS_CHANNELS.getState);
  },
  setEnabled(enabled) {
    return ipcRenderer.invoke(
      DESKTOP_DEVELOPER_TOOLS_CHANNELS.setEnabled,
      enabled,
    );
  },
  subscribe(callback: () => void): () => void {
    const listener = (): void => {
      callback();
    };
    ipcRenderer.on(DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed, listener);
    return () => {
      ipcRenderer.off(DESKTOP_DEVELOPER_TOOLS_CHANNELS.changed, listener);
    };
  },
};

const desktopRecorderApi: DesktopRecorderApi = {
  getState() {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.getState);
  },
  getCapabilities() {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.getCapabilities);
  },
  openScreenRecordingSettings() {
    return ipcRenderer.invoke(
      DESKTOP_RECORDER_CHANNELS.openScreenRecordingSettings,
    );
  },
  startCapture(request) {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.startCapture, request);
  },
  beginAreaSelection(audio) {
    return ipcRenderer.invoke(
      DESKTOP_RECORDER_CHANNELS.beginAreaSelection,
      audio,
    );
  },
  completeAreaSelection(selection) {
    return ipcRenderer.invoke(
      DESKTOP_RECORDER_CHANNELS.completeAreaSelection,
      selection,
    );
  },
  selectWindow() {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.selectWindow);
  },
  listWindowOptions() {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.listWindowOptions);
  },
  completeWindowSelection(choice) {
    return ipcRenderer.invoke(
      DESKTOP_RECORDER_CHANNELS.completeWindowSelection,
      choice,
    );
  },
  pause() {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.pause);
  },
  resume() {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.resume);
  },
  discard() {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.discard);
  },
  stop() {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.stop);
  },
  cancel() {
    return ipcRenderer.invoke(DESKTOP_RECORDER_CHANNELS.cancel);
  },
};

const desktopIdentity = ipcRenderer.sendSync(
  DESKTOP_IDENTITY_CHANNEL,
) as DesktopIdentityInfo;

contextBridge.exposeInMainWorld("vm0DesktopAuth", desktopAuthApi);
contextBridge.exposeInMainWorld(
  "okouDesktopComputerUse",
  desktopComputerUseApi,
);
contextBridge.exposeInMainWorld(
  "okouDesktopDeveloperTools",
  desktopDeveloperToolsApi,
);
contextBridge.exposeInMainWorld("okouDesktopIdentity", desktopIdentity);
contextBridge.exposeInMainWorld("okouDesktopRecorder", desktopRecorderApi);
