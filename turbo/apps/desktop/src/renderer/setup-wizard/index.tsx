import { useEffect } from "react";
import {
  AlertCircle,
  Building,
  Check,
  ExternalLink,
  LogOut,
  ShieldCheck,
} from "lucide-react";
import { useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { DesktopAuthState } from "../../desktop-bridge";
import {
  COMPUTER_USE_AUTOMATION_PERMISSION_TARGETS,
  COMPUTER_USE_AUTOMATION_PERMISSION_TARGET_DETAILS,
  computerUseAutomationPermissionState,
  hasRequiredComputerUsePermissions,
  type ComputerUseAutomationPermissionStatus,
  type ComputerUseAutomationPermissionTarget,
  type DesktopComputerUseState,
} from "../../computer-use-types";
import {
  hasDesktopAuthBridge,
  openAccessibilitySettings$,
  openAutomationSettings$,
  openDesktopOrgSelection$,
  openDesktopSignIn$,
  openScreenRecordingSettings$,
  probeAutomationPermission$,
  refreshComputerUse$,
  requestAccessibilityPermission$,
  requestScreenRecordingPermission$,
  signOutDesktop$,
} from "../computer-use-state";
import { DesktopBrandMark, IconButton } from "../components";
import { currentDesktopIdentity } from "../desktop-identity";

const AUTOMATION_PERMISSION_STATUS_LABELS = {
  unknown: "Not tested",
  granted: "Ready",
  denied: "Needs approval",
  not_installed: "Not installed",
  not_running: "Open browser",
} as const satisfies Record<ComputerUseAutomationPermissionStatus, string>;

const AUTOMATION_PERMISSION_TEST_LABELS = {
  chrome: "Test Chrome",
  safari: "Test Safari",
} as const satisfies Record<ComputerUseAutomationPermissionTarget, string>;

const PERMISSION_POLL_INTERVAL_MS = 5_000;

function StepIndex({
  step,
  tone = "active",
}: {
  readonly step: number;
  readonly tone?: "active" | "pending" | "ready";
}) {
  return (
    <span className={`step-index step-index-${tone}`}>
      {tone === "ready" ? <Check size={14} /> : step}
    </span>
  );
}

export function AuthStepCard({
  authLoading,
  authState,
}: {
  readonly authLoading: boolean;
  readonly authState: DesktopAuthState | null;
}) {
  const identity = currentDesktopIdentity();
  const [signInLoadable, signIn] = useLoadableSet(openDesktopSignIn$);
  const [orgSelectionLoadable, selectOrg] = useLoadableSet(
    openDesktopOrgSelection$,
  );
  const [signOutLoadable, signOut] = useLoadableSet(signOutDesktop$);
  const signedInAuth = authState?.status === "signed_in" ? authState : null;
  const activeOrganization = signedInAuth?.organization ?? null;
  const signingIn =
    authState?.status === "signing_in" || signInLoadable.state === "loading";
  const authBridgeAvailable = hasDesktopAuthBridge();

  if (signedInAuth && activeOrganization) {
    return (
      <section className="step-card step-card-compact">
        <div className="compact-step-main">
          <StepIndex step={1} tone="ready" />
          <DesktopBrandMark className="desktop-brand-mark-chip" size={26} />
          <span className="compact-step-copy">
            <strong>Signed in</strong>
            <span>
              {signedInAuth.user.email ??
                signedInAuth.user.phoneNumber ??
                signedInAuth.user.userId}{" "}
              - {activeOrganization.name}
            </span>
          </span>
        </div>
        <div className="row-actions">
          <IconButton
            icon={<Building size={15} />}
            onClick={() => {
              void selectOrg();
            }}
            disabled={orgSelectionLoadable.state === "loading"}
          >
            Switch workspace
          </IconButton>
          <IconButton
            tone="danger"
            icon={<LogOut size={15} />}
            onClick={() => {
              void signOut();
            }}
            disabled={signOutLoadable.state === "loading"}
          >
            Sign out
          </IconButton>
        </div>
      </section>
    );
  }

  const title = authLoading
    ? "Checking sign-in"
    : signedInAuth
      ? "Select a workspace"
      : signingIn
        ? "Finish signing in"
        : `Sign in to ${identity.brandName}`;
  const description = signedInAuth
    ? "Choose the workspace that should receive this Mac as a Computer Use runtime."
    : `Connect this Mac to a ${identity.brandName} account before Computer Use can register a runtime.`;

  return (
    <section className="step-card step-card-expanded">
      <div className="step-card-main">
        <div className="step-kicker">
          <StepIndex step={1} />
          <span>Account</span>
        </div>
        <div className="step-heading">
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <div className="step-actions">
          {signedInAuth ? (
            <>
              <IconButton
                tone="primary"
                icon={<Building size={15} />}
                onClick={() => {
                  void selectOrg();
                }}
                disabled={orgSelectionLoadable.state === "loading"}
              >
                Select workspace
              </IconButton>
              <IconButton
                tone="danger"
                icon={<LogOut size={15} />}
                onClick={() => {
                  void signOut();
                }}
                disabled={signOutLoadable.state === "loading"}
              >
                Sign out
              </IconButton>
            </>
          ) : (
            <IconButton
              tone="primary"
              icon={<ExternalLink size={15} />}
              onClick={() => {
                void signIn();
              }}
              disabled={authLoading || signingIn || !authBridgeAvailable}
            >
              {signingIn ? "Signing in..." : "Sign in"}
            </IconButton>
          )}
        </div>
      </div>
    </section>
  );
}

function PermissionSetupRow({
  granted,
  meta,
  onOpenSettings,
  onRequest,
  requestLoading,
  title,
}: {
  readonly granted: boolean;
  readonly meta: string;
  readonly onOpenSettings: () => void;
  readonly onRequest: () => void;
  readonly requestLoading: boolean;
  readonly title: string;
}) {
  return (
    <div className="permission-row">
      <div>
        <div className="row-title">{title}</div>
        <div className="row-meta">{granted ? "Granted" : meta}</div>
      </div>
      <div className="row-actions">
        {granted ? (
          <span className="check-pill">
            <Check size={14} />
            Ready
          </span>
        ) : (
          <IconButton
            icon={<ShieldCheck size={15} />}
            onClick={onRequest}
            disabled={requestLoading}
          >
            Request
          </IconButton>
        )}
        <IconButton icon={<ExternalLink size={15} />} onClick={onOpenSettings}>
          Settings
        </IconButton>
      </div>
    </div>
  );
}

function browserAutomationReadyLabels(
  automation: ReturnType<typeof computerUseAutomationPermissionState>,
): readonly string[] {
  return COMPUTER_USE_AUTOMATION_PERMISSION_TARGETS.filter((target) => {
    return automation[target].status === "granted";
  }).map((target) => {
    return COMPUTER_USE_AUTOMATION_PERMISSION_TARGET_DETAILS[target].label;
  });
}

function browserAutomationHasDeniedTarget(
  automation: ReturnType<typeof computerUseAutomationPermissionState>,
): boolean {
  return COMPUTER_USE_AUTOMATION_PERMISSION_TARGETS.some((target) => {
    return automation[target].status === "denied";
  });
}

function formatBrowserAutomationTargets(labels: readonly string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? "a browser";
  }
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function browserAutomationMeta(
  automation: ReturnType<typeof computerUseAutomationPermissionState>,
): string {
  const identity = currentDesktopIdentity();
  const readyLabels = browserAutomationReadyLabels(automation);
  if (readyLabels.length > 0) {
    return `${formatBrowserAutomationTargets(
      readyLabels,
    )} ready. Other browsers can be approved later.`;
  }
  if (browserAutomationHasDeniedTarget(automation)) {
    return `Allow ${identity.brandName} to control the browser you use in System Settings`;
  }
  return "Optional for browser control. Test only the browser you use.";
}

function BrowserAutomationSetupRow({
  state,
}: {
  readonly state: DesktopComputerUseState;
}) {
  const automation = computerUseAutomationPermissionState(state.permissions);
  const [probeLoadable, probeAutomation] = useLoadableSet(
    probeAutomationPermission$,
  );
  const [, openAutomationSettings] = useLoadableSet(openAutomationSettings$);
  const disabled = probeLoadable.state === "loading";
  const readyLabels = browserAutomationReadyLabels(automation);
  const ready = readyLabels.length > 0;
  const needsApproval = !ready && browserAutomationHasDeniedTarget(automation);
  const pillStatus: ComputerUseAutomationPermissionStatus = ready
    ? "granted"
    : needsApproval
      ? "denied"
      : "unknown";

  return (
    <div className="permission-row browser-automation-row">
      <div>
        <div className="row-title">Browser Automation</div>
        <div className="row-meta">{browserAutomationMeta(automation)}</div>
      </div>
      <div className="row-actions">
        <span className={`automation-pill automation-pill-${pillStatus}`}>
          {ready ? <Check size={14} /> : <AlertCircle size={14} />}
          {AUTOMATION_PERMISSION_STATUS_LABELS[pillStatus]}
        </span>
        {!ready &&
          COMPUTER_USE_AUTOMATION_PERMISSION_TARGETS.map((target) => {
            return (
              <IconButton
                key={target}
                icon={<ShieldCheck size={15} />}
                disabled={disabled}
                onClick={() => {
                  void probeAutomation(target);
                }}
              >
                {AUTOMATION_PERMISSION_TEST_LABELS[target]}
              </IconButton>
            );
          })}
        {needsApproval && (
          <IconButton
            icon={<ExternalLink size={15} />}
            onClick={() => {
              void openAutomationSettings();
            }}
          >
            Settings
          </IconButton>
        )}
      </div>
    </div>
  );
}

export function PermissionsStepCard({
  authReady,
  state,
}: {
  readonly authReady: boolean;
  readonly state: DesktopComputerUseState;
}) {
  const identity = currentDesktopIdentity();
  const [requestLoadable, requestPermission] = useLoadableSet(
    requestAccessibilityPermission$,
  );
  const [screenRecordingRequestLoadable, requestScreenRecording] =
    useLoadableSet(requestScreenRecordingPermission$);
  const [, openAccessibility] = useLoadableSet(openAccessibilitySettings$);
  const [, openScreenRecording] = useLoadableSet(openScreenRecordingSettings$);
  const accessibilityGranted = state.permissions.accessibility;
  const screenRecordingGranted = state.permissions.screenRecording;
  const permissionsReady = hasRequiredComputerUsePermissions(state.permissions);

  // When permissions are granted the renderer shows the online/offline hero
  // instead of this setup card, so there is nothing to render here.
  if (permissionsReady) {
    return null;
  }

  if (!authReady) {
    return (
      <section className="step-card step-card-locked">
        <div className="step-card-main">
          <div className="step-kicker">
            <StepIndex step={2} tone="pending" />
            <span>Permissions</span>
          </div>
          <div className="step-heading">
            <h2>Allow Computer Use permissions</h2>
            <p>Sign in and select a workspace first.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="step-card step-card-expanded">
      <div className="step-card-main">
        <div className="step-kicker">
          <StepIndex step={2} />
          <span>Permissions</span>
        </div>
        <div className="step-heading">
          <h2>Allow Computer Use permissions</h2>
          <p>
            {identity.brandName} needs macOS permission to inspect the screen
            and control UI elements on this Mac. macOS grants these permissions
            to each app separately, so approve {identity.brandName} in System
            Settings.
          </p>
        </div>
        <div className="permission-list">
          <PermissionSetupRow
            title="Accessibility"
            meta="Required for clicking, typing, and reading UI structure"
            granted={accessibilityGranted}
            requestLoading={requestLoadable.state === "loading"}
            onRequest={() => {
              void requestPermission();
            }}
            onOpenSettings={() => {
              void openAccessibility();
            }}
          />
          <PermissionSetupRow
            title="Screen Recording"
            meta="Required for screenshots and visual context"
            granted={screenRecordingGranted}
            requestLoading={screenRecordingRequestLoadable.state === "loading"}
            onRequest={() => {
              void requestScreenRecording();
            }}
            onOpenSettings={() => {
              void openScreenRecording();
            }}
          />
          <BrowserAutomationSetupRow state={state} />
        </div>
      </div>
    </section>
  );
}

/**
 * Re-checks macOS permission state on an interval so the status stays current
 * without a manual refresh button. Mounted only while Computer Use is not
 * online (during setup or while offline).
 */
export function PermissionAutoRefresh() {
  const refresh = useSet(refreshComputerUse$);
  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh();
    }, PERMISSION_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [refresh]);
  return null;
}
