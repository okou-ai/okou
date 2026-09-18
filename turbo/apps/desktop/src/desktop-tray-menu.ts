import type { DesktopAuthState } from "./desktop-bridge";
import {
  hasRequiredComputerUsePermissions,
  type ComputerUseHostRuntimeStatus,
  type ComputerUseLocalCommandLogEntry,
  type DesktopComputerUseState,
} from "./computer-use-types";

const HOST_STATUS_LABELS = {
  offline: "Offline",
  connecting: "Starting...",
  online: "Online",
  recovering: "Recovering",
  unauthenticated: "Sign in required",
  needs_organization: "Select workspace",
  disabled: "Disabled",
  error: "Error",
} as const satisfies Record<ComputerUseHostRuntimeStatus, string>;

const COMMAND_STATUS_LABELS = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
} as const satisfies Record<ComputerUseLocalCommandLogEntry["status"], string>;

const MAX_RECENT_COMMANDS = 5;

const MAX_COMMAND_LABEL_LENGTH = 90;

export interface DesktopTrayMenuItem {
  readonly label?: string;
  readonly type?: "checkbox" | "separator";
  readonly checked?: boolean;
  readonly enabled?: boolean;
  readonly submenu?: readonly DesktopTrayMenuItem[];
  readonly click?: () => void;
}

export interface DesktopTrayMenuActions {
  readonly showMainWindow: () => void;
  readonly startComputerUse: () => void;
  readonly stopComputerUse: () => void;
  readonly refreshStatus: () => void;
  readonly openSignIn: () => void;
  readonly switchWorkspace: () => void;
  readonly signOut: () => void;
  readonly requestAccessibilityPermission: () => void;
  readonly requestScreenRecordingPermission: () => void;
  readonly openAccessibilitySettings: () => void;
  readonly openScreenRecordingSettings: () => void;
  readonly setKeepAwakeEnabled: (enabled: boolean) => void;
  readonly quit: () => void;
}

interface DesktopTrayMenuState {
  readonly computerUse: DesktopComputerUseState;
  readonly auth: DesktopAuthState | null;
  readonly authLoading?: boolean;
  readonly authError: string | null;
}

function separator(): DesktopTrayMenuItem {
  return { type: "separator" };
}

function disabledLabel(label: string): DesktopTrayMenuItem {
  return { label, enabled: false };
}

function computerUseStatusLabel(state: DesktopTrayMenuState): string {
  if (!state.computerUse.supported) {
    return "Unsupported";
  }
  if (!hasRequiredComputerUsePermissions(state.computerUse.permissions)) {
    return "Needs permissions";
  }
  if (state.computerUse.host.status !== "offline") {
    return HOST_STATUS_LABELS[state.computerUse.host.status];
  }
  if (isAuthLoading(state)) {
    return "Signing in...";
  }
  if (state.auth?.status !== "signed_in") {
    return "Sign in required";
  }
  if (!state.auth.organization) {
    return "Select workspace";
  }
  return HOST_STATUS_LABELS[state.computerUse.host.status];
}

function isAuthReady(auth: DesktopAuthState | null): boolean {
  return auth?.status === "signed_in" && auth.organization !== null;
}

function isAuthLoading(state: DesktopTrayMenuState): boolean {
  return state.authLoading === true || state.auth?.status === "signing_in";
}

function canStartComputerUse(state: DesktopTrayMenuState): boolean {
  return (
    state.computerUse.supported &&
    hasRequiredComputerUsePermissions(state.computerUse.permissions) &&
    !isAuthLoading(state) &&
    isAuthReady(state.auth) &&
    state.computerUse.host.status !== "connecting" &&
    state.computerUse.host.status !== "online" &&
    state.computerUse.host.status !== "recovering"
  );
}

function canStopComputerUse(state: DesktopTrayMenuState): boolean {
  return (
    state.computerUse.supported &&
    (state.computerUse.host.status === "online" ||
      state.computerUse.host.status === "recovering")
  );
}

function authActionForComputerUse(
  state: DesktopTrayMenuState,
  actions: DesktopTrayMenuActions,
): DesktopTrayMenuItem | null {
  if (
    state.computerUse.host.status === "online" ||
    state.computerUse.host.status === "recovering"
  ) {
    return null;
  }
  if (isAuthLoading(state)) {
    return disabledLabel("Signing in...");
  }
  if (state.auth?.status === "signed_in") {
    if (!state.auth.organization) {
      return { label: "Select Workspace", click: actions.switchWorkspace };
    }
    return null;
  }
  return {
    label: "Sign in to Okou",
    click: actions.openSignIn,
  };
}

function buildComputerUseSubmenu(
  state: DesktopTrayMenuState,
  actions: DesktopTrayMenuActions,
): readonly DesktopTrayMenuItem[] {
  const items: DesktopTrayMenuItem[] = [
    disabledLabel(`Status: ${computerUseStatusLabel(state)}`),
  ];

  if (!state.computerUse.supported) {
    return [
      ...items,
      separator(),
      { label: "Refresh Status", click: actions.refreshStatus },
    ];
  }

  items.push(separator(), ...buildPermissionItems(state, actions));

  if (!hasRequiredComputerUsePermissions(state.computerUse.permissions)) {
    return [
      ...items,
      separator(),
      { label: "Refresh Status", click: actions.refreshStatus },
    ];
  }

  const authAction = authActionForComputerUse(state, actions);
  const startItems: DesktopTrayMenuItem[] = [
    ...items,
    separator(),
    {
      label: "Start Computer Use",
      enabled: canStartComputerUse(state),
      click: actions.startComputerUse,
    },
    {
      label: "Stop Computer Use",
      enabled: canStopComputerUse(state),
      click: actions.stopComputerUse,
    },
  ];
  if (authAction) {
    startItems.push(authAction);
  }
  startItems.push({ label: "Refresh Status", click: actions.refreshStatus });
  return startItems;
}

function buildPermissionItems(
  state: DesktopTrayMenuState,
  actions: DesktopTrayMenuActions,
): readonly DesktopTrayMenuItem[] {
  const items: DesktopTrayMenuItem[] = [];

  if (state.computerUse.permissions.accessibility) {
    items.push(disabledLabel("Accessibility: Ready"));
  } else {
    items.push({
      label: "Request Accessibility Permission",
      click: actions.requestAccessibilityPermission,
    });
  }
  items.push({
    label: "Accessibility Settings",
    click: actions.openAccessibilitySettings,
  });

  if (state.computerUse.permissions.screenRecording) {
    items.push(disabledLabel("Screen Recording: Ready"));
  } else {
    items.push({
      label: "Request Screen Recording Permission",
      click: actions.requestScreenRecordingPermission,
    });
  }
  items.push({
    label: "Screen Recording Settings",
    click: actions.openScreenRecordingSettings,
  });

  return items;
}

function authStatusLabel(state: DesktopTrayMenuState): string {
  if (isAuthLoading(state)) {
    return "Signing in to Okou...";
  }
  if (state.authError) {
    return "Sign in to Okou";
  }
  if (!state.auth) {
    return "Sign in to Okou";
  }
  if (state.auth.status === "signed_out") {
    return "Sign in to Okou";
  }
  if (!state.auth.organization) {
    return "Select Workspace";
  }
  return `Workspace: ${state.auth.organization.name}`;
}

function buildAuthSubmenu(
  state: DesktopTrayMenuState,
  actions: DesktopTrayMenuActions,
): readonly DesktopTrayMenuItem[] {
  if (isAuthLoading(state)) {
    return [disabledLabel("Signing in...")];
  }

  if (state.authError || !state.auth || state.auth.status === "signed_out") {
    return [
      disabledLabel("Not signed in"),
      {
        label: "Sign in to Okou",
        click: actions.openSignIn,
      },
      { label: "Refresh Account Status", click: actions.refreshStatus },
    ];
  }

  if (state.auth.status === "signing_in") {
    return [disabledLabel("Signing in...")];
  }

  return [
    disabledLabel(`Signed in as ${state.auth.user.email}`),
    disabledLabel(
      `Workspace: ${state.auth.organization?.name ?? "Not selected"}`,
    ),
    separator(),
    { label: "Switch Workspace", click: actions.switchWorkspace },
    { label: "Sign out", click: actions.signOut },
  ];
}

function padDateTimePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatTrayDate(date: Date, now: Date): string {
  const monthDay = `${padDateTimePart(date.getMonth() + 1)}/${padDateTimePart(
    date.getDate(),
  )}`;
  if (date.getFullYear() === now.getFullYear()) {
    return monthDay;
  }
  return `${date.getFullYear()}/${monthDay}`;
}

function formatTrayTimestamp(value: string | null): string {
  if (!value) {
    return "running";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const now = new Date(Date.now());
  if (!isSameLocalDate(date, now)) {
    return formatTrayDate(date, now);
  }
  return `${padDateTimePart(date.getHours())}:${padDateTimePart(
    date.getMinutes(),
  )}`;
}

function truncateMenuLabel(value: string): string {
  if (value.length <= MAX_COMMAND_LABEL_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_COMMAND_LABEL_LENGTH - 3)}...`;
}

function formatRecentCommandLabel(
  entry: ComputerUseLocalCommandLogEntry,
): string {
  const target = entry.app ? `${entry.app} - ` : "";
  const timestamp = formatTrayTimestamp(entry.completedAt ?? entry.startedAt);
  return truncateMenuLabel(
    `${timestamp} - ${target}${entry.kind} - ${COMMAND_STATUS_LABELS[entry.status]}`,
  );
}

function buildRecentCommandItems(
  state: DesktopTrayMenuState,
  actions: DesktopTrayMenuActions,
): readonly DesktopTrayMenuItem[] {
  const commands = state.computerUse.host.localCommandLog.slice(
    0,
    MAX_RECENT_COMMANDS,
  );

  if (commands.length === 0) {
    return [disabledLabel("No Recent Commands")];
  }

  return commands.map((entry) => {
    return {
      label: formatRecentCommandLabel(entry),
      click: actions.showMainWindow,
    };
  });
}

function buildRecentCommandSection(
  state: DesktopTrayMenuState,
  actions: DesktopTrayMenuActions,
): readonly DesktopTrayMenuItem[] {
  const commands = buildRecentCommandItems(state, actions);
  if (commands.length === 1 && commands[0]?.enabled === false) {
    return commands;
  }
  return [disabledLabel("Recent Commands"), ...commands];
}

export function buildDesktopTrayMenuItems(
  state: DesktopTrayMenuState,
  actions: DesktopTrayMenuActions,
): readonly DesktopTrayMenuItem[] {
  return [
    {
      label: "Open Okou",
      click: actions.showMainWindow,
    },
    {
      label: authStatusLabel(state),
      submenu: buildAuthSubmenu(state, actions),
    },
    separator(),
    {
      label: `Computer Use: ${computerUseStatusLabel(state)}`,
      submenu: buildComputerUseSubmenu(state, actions),
    },
    {
      label: "Keep Mac Awake",
      type: "checkbox",
      checked: state.computerUse.keepAwake.enabled,
      click: () => {
        actions.setKeepAwakeEnabled(!state.computerUse.keepAwake.enabled);
      },
    },
    separator(),
    ...buildRecentCommandSection(state, actions),
    separator(),
    { label: "Quit", click: actions.quit },
  ];
}
