import { StrictMode } from "react";
import type { Store } from "ccstate";
import { StoreProvider, useGet, useSet } from "ccstate-react";
import { Toaster } from "@okouai/ui/components/ui/sonner";
import { ErrorBoundary } from "./error-boundary.tsx";
import { AppSkeletonOverlay, Router } from "./router.tsx";
import { ClerkOptionsProvider } from "./clerk-options-provider.tsx";
import { ForceUpgradeDialog } from "./components/force-upgrade-dialog.tsx";
import { SharedWorkerFailureDialog } from "./components/shared-worker-failure-dialog.tsx";
import { InspectLogFileInput } from "./inspect-log-file-input.tsx";
import { listenForceUpgradeDialog$ } from "../signals/force-upgrade.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import { handleInvitationRedirect$ } from "../signals/invitation-redirect.ts";
import { pollInstatusIssues$ } from "../signals/instatus-status.ts";
import { handleBillingRedirect$ } from "../signals/okou-page/billing.ts";
import { detach, Reason } from "../signals/utils.ts";
import {
  isStandalonePwa,
  setupKeyboardDismissGesture,
} from "../lib/keyboard-dismiss-gesture.ts";
import { InstatusStatusNotice } from "./components/instatus-status-notice.tsx";
import { ConnectorConnectionProgress } from "./components/connector-connection-progress.tsx";
import { setupViewportPinchPrevention } from "../lib/viewport-pinch.ts";
import { IN_VITEST } from "../env.ts";
import "./css/index.css";

function AppToaster() {
  const signal = useGet(rootSignal$);
  const handleBillingRedirect = useSet(handleBillingRedirect$);
  const handleInvitationRedirect = useSet(handleInvitationRedirect$);

  const handleReady = () => {
    detach(
      handleBillingRedirect(signal),
      Reason.DomCallback,
      "handle-billing-redirect",
    );
    detach(
      handleInvitationRedirect(signal),
      Reason.DomCallback,
      "invitation-redirect",
    );
  };

  return (
    <Toaster
      position="top-center"
      visibleToasts={1}
      duration={IN_VITEST ? Infinity : undefined}
      onReady={handleReady}
    />
  );
}

export const setupRouter = (
  store: Store,
  render: (children: React.ReactNode) => void,
) => {
  const signal = store.get(rootSignal$);
  setupViewportPinchPrevention(signal);
  if (isStandalonePwa()) {
    const cleanupKeyboardDismissGesture = setupKeyboardDismissGesture();
    signal.addEventListener("abort", cleanupKeyboardDismissGesture, {
      once: true,
    });
  }
  detach(
    store.set(listenForceUpgradeDialog$, signal),
    Reason.Daemon,
    "force-upgrade",
  );
  detach(
    store.set(pollInstatusIssues$, signal),
    Reason.Daemon,
    "service status polling",
  );
  render(
    <StrictMode>
      <StoreProvider value={store}>
        <ErrorBoundary>
          <AppSkeletonOverlay />
          <ClerkOptionsProvider>
            <Router />
          </ClerkOptionsProvider>
          <InspectLogFileInput />
          <ForceUpgradeDialog />
          <InstatusStatusNotice />
          <ConnectorConnectionProgress />
        </ErrorBoundary>
        <SharedWorkerFailureDialog />
        <AppToaster />
      </StoreProvider>
    </StrictMode>,
  );
};
