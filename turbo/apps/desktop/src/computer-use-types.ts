export const COMPUTER_USE_AUTOMATION_PERMISSION_TARGETS = [
  "chrome",
  "safari",
] as const;

export type ComputerUseAutomationPermissionTarget =
  (typeof COMPUTER_USE_AUTOMATION_PERMISSION_TARGETS)[number];

export type ComputerUseAutomationPermissionStatus =
  | "unknown"
  | "granted"
  | "denied"
  | "not_installed"
  | "not_running";

export interface ComputerUseAutomationPermissionTargetState {
  readonly status: ComputerUseAutomationPermissionStatus;
  readonly updatedAt: string | null;
  readonly reason: string | null;
}

export type ComputerUseAutomationPermissionState = Record<
  ComputerUseAutomationPermissionTarget,
  ComputerUseAutomationPermissionTargetState
>;

export const COMPUTER_USE_AUTOMATION_PERMISSION_TARGET_DETAILS = {
  chrome: {
    bundleId: "com.google.Chrome",
    label: "Google Chrome",
  },
  safari: {
    bundleId: "com.apple.Safari",
    label: "Safari",
  },
} as const satisfies Record<
  ComputerUseAutomationPermissionTarget,
  { readonly bundleId: string; readonly label: string }
>;

export interface ComputerUsePermissionState {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly automation?: ComputerUseAutomationPermissionState;
}

export type ComputerUseHostRuntimeStatus =
  | "offline"
  | "connecting"
  | "online"
  | "recovering"
  | "unauthenticated"
  | "needs_organization"
  | "disabled"
  | "error";

export type ComputerUseRuntimeRecoveryPhase =
  | "start"
  | "heartbeat"
  | "command_poll";

export interface ComputerUseRuntimeRecoveryState {
  readonly phase: ComputerUseRuntimeRecoveryPhase;
  readonly attempt: number;
  readonly nextRetryAt: string;
  readonly lastRetryAt: string;
  readonly retryDelayMs: number;
}

export type ComputerUseLocalCommandLogStatus =
  | "running"
  | "succeeded"
  | "failed";

export interface ComputerUseLocalCommandLogEntry {
  readonly driver?: ComputerUseExecutionIdentity;
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly status: ComputerUseLocalCommandLogStatus;
  readonly payload: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly error: Record<string, unknown> | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
}

export type ComputerUseRuntimeErrorSource =
  | "start"
  | "stop"
  | "heartbeat"
  | "command_poll";

export interface ComputerUseRuntimeErrorLogEntry {
  readonly id: string;
  readonly source: ComputerUseRuntimeErrorSource;
  readonly message: string;
  readonly occurredAt: string;
  readonly hostId: string | null;
  readonly status: Extract<ComputerUseHostRuntimeStatus, "error">;
}

export interface ComputerUseHostRuntimeState {
  readonly driverTransitioning?: boolean;
  readonly status: ComputerUseHostRuntimeStatus;
  readonly hostId: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly lastCommandAt: string | null;
  readonly lastError: string | null;
  readonly recovery: ComputerUseRuntimeRecoveryState | null;
  readonly errorLog: readonly ComputerUseRuntimeErrorLogEntry[];
  readonly localCommandLog: readonly ComputerUseLocalCommandLogEntry[];
}

export interface DesktopKeepAwakeState {
  readonly enabled: boolean;
  readonly active: boolean;
}

export type DesktopComputerUsePluginStatus =
  | "disabled"
  | "starting"
  | "running"
  | "restarting"
  | "error";

export interface DesktopComputerUseFilesystemPluginState {
  readonly featureEnabled: boolean;
  readonly enabled: boolean;
  readonly allowedDirectories: readonly string[];
  readonly status: DesktopComputerUsePluginStatus;
  readonly lastError: string | null;
  readonly version: string;
  readonly capabilities: readonly string[];
}

export interface DesktopComputerUseMcpServerState {
  readonly name: string;
  readonly transport: "stdio" | "http";
  readonly enabled: boolean;
  readonly status: DesktopComputerUsePluginStatus;
  readonly lastError: string | null;
  readonly tools: readonly string[];
}

export interface DesktopComputerUseMcpPluginState {
  readonly featureEnabled: boolean;
  readonly servers: readonly DesktopComputerUseMcpServerState[];
}

export interface DesktopComputerUsePluginsState {
  readonly filesystem: DesktopComputerUseFilesystemPluginState;
  readonly mcp: DesktopComputerUseMcpPluginState;
}

export interface DesktopComputerUseState {
  readonly driver: DesktopComputerUseDriverState;
  readonly platform: NodeJS.Platform;
  readonly supported: boolean;
  /**
   * Friendly name of this Mac (derived from the system hostname), shown under
   * the online status. Optional so existing state constructors stay valid.
   */
  readonly deviceName?: string | null;
  readonly permissions: ComputerUsePermissionState;
  readonly host: ComputerUseHostRuntimeState;
  readonly keepAwake: DesktopKeepAwakeState;
  readonly plugins?: DesktopComputerUsePluginsState;
}

export interface ComputerUseExecutionIdentity {
  readonly id: string;
  readonly generation: number;
  readonly version: string | null;
}

export interface DesktopComputerUseDriverState {
  readonly actual: ComputerUseExecutionIdentity | null;
  readonly phase:
    | "stopped"
    | "starting"
    | "ready"
    | "recovering"
    | "retiring"
    | "error";
  readonly lifecycleElapsedMs: number;
  readonly cleanupPending: boolean;
  readonly error: string | null;
  readonly canRetry: boolean;
}

export function hasRequiredComputerUsePermissions(
  permissions: ComputerUsePermissionState,
): boolean {
  return permissions.accessibility && permissions.screenRecording;
}

function unknownAutomationPermissionTargetState(): ComputerUseAutomationPermissionTargetState {
  return {
    status: "unknown",
    updatedAt: null,
    reason: null,
  };
}

export function defaultComputerUseAutomationPermissionState(): ComputerUseAutomationPermissionState {
  return {
    chrome: unknownAutomationPermissionTargetState(),
    safari: unknownAutomationPermissionTargetState(),
  };
}

export function computerUseAutomationPermissionState(
  permissions: ComputerUsePermissionState,
): ComputerUseAutomationPermissionState {
  return {
    ...defaultComputerUseAutomationPermissionState(),
    ...permissions.automation,
  };
}

export function normalizeComputerUsePermissionState(
  permissions: ComputerUsePermissionState,
): ComputerUsePermissionState {
  return {
    accessibility: permissions.accessibility,
    screenRecording: permissions.screenRecording,
    automation: computerUseAutomationPermissionState(permissions),
  };
}

export const OFFLINE_COMPUTER_USE_HOST_STATE: ComputerUseHostRuntimeState =
  Object.freeze({
    status: "offline",
    hostId: null,
    lastHeartbeatAt: null,
    lastCommandAt: null,
    lastError: null,
    recovery: null,
    errorLog: [],
    localCommandLog: [],
  });
