import type {
  ComputerUseAutomationPermissionTarget,
  DesktopComputerUseState,
} from "./computer-use-types";
import type { DesktopIdentity } from "./config";

export interface DesktopAuthUser {
  readonly userId: string;
  readonly email: string;
}

export interface DesktopAuthOrganization {
  readonly id: string;
  readonly name: string;
}

export type DesktopAuthState =
  | {
      readonly status: "signing_in";
      readonly user: null;
      readonly organization: null;
    }
  | {
      readonly status: "signed_out";
      readonly user: null;
      readonly organization: null;
    }
  | {
      readonly status: "signed_in";
      readonly user: DesktopAuthUser;
      readonly organization: DesktopAuthOrganization | null;
    };

export interface DesktopAuthApi {
  readonly getState: () => Promise<DesktopAuthState>;
  readonly openSignIn: () => Promise<void>;
  readonly openOrgSelection: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly completeSignIn: (params: {
    readonly token: string;
  }) => Promise<void>;
  readonly subscribe: (callback: () => void) => () => void;
}

export interface DesktopComputerUseApi {
  readonly getState: () => Promise<DesktopComputerUseState>;
  readonly refreshPermissions: () => Promise<DesktopComputerUseState>;
  readonly start: (options?: {
    readonly userInitiated?: boolean;
  }) => Promise<DesktopComputerUseState>;
  readonly stop: () => Promise<DesktopComputerUseState>;
  readonly requestAccessibilityPermission: () => Promise<DesktopComputerUseState>;
  readonly requestScreenRecordingPermission: () => Promise<DesktopComputerUseState>;
  readonly probeAutomationPermission: (
    target: ComputerUseAutomationPermissionTarget,
  ) => Promise<DesktopComputerUseState>;
  readonly setKeepAwakeEnabled: (
    enabled: boolean,
  ) => Promise<DesktopComputerUseState>;
  readonly setFilesystemPluginEnabled: (
    enabled: boolean,
  ) => Promise<DesktopComputerUseState>;
  readonly addFilesystemPluginAllowedDirectory: () => Promise<DesktopComputerUseState>;
  readonly removeFilesystemPluginAllowedDirectory: (
    directory: string,
  ) => Promise<DesktopComputerUseState>;
  readonly importMcpPluginServers: (
    json: string,
  ) => Promise<DesktopComputerUseState>;
  readonly setMcpPluginServerEnabled: (
    server: string,
    enabled: boolean,
  ) => Promise<DesktopComputerUseState>;
  readonly removeMcpPluginServer: (
    server: string,
  ) => Promise<DesktopComputerUseState>;
  readonly openAccessibilitySettings: () => Promise<void>;
  readonly openScreenRecordingSettings: () => Promise<void>;
  readonly openAutomationSettings: () => Promise<void>;
  readonly subscribe: (callback: () => void) => () => void;
}

export interface DesktopDeveloperToolsState {
  readonly available: boolean;
  readonly enabled: boolean;
}

export interface DesktopDeveloperToolsApi {
  readonly getState: () => Promise<DesktopDeveloperToolsState>;
  readonly setEnabled: (
    enabled: boolean,
  ) => Promise<DesktopDeveloperToolsState>;
  readonly subscribe: (callback: () => void) => () => void;
}

export type DesktopIdentityInfo = Pick<
  DesktopIdentity,
  "brandName" | "displayName" | "product"
>;

declare global {
  interface Window {
    vm0DesktopAuth?: DesktopAuthApi;
    okouDesktopComputerUse?: DesktopComputerUseApi;
    okouDesktopDeveloperTools?: DesktopDeveloperToolsApi;
    okouDesktopIdentity: DesktopIdentityInfo;
  }
}

export {};
