import { StrictMode } from "react";
import type { Store } from "ccstate";
import { StoreProvider, useGet, useLastResolved, useSet } from "ccstate-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { Toaster } from "@okouai/ui/components/ui/sonner";
import { ErrorBoundary } from "./error-boundary.tsx";
import { BillingFeedbackSurvey } from "./okou-page/components/billing-feedback-survey.tsx";
import { Router } from "./router.tsx";
import { ClerkOptionsProvider } from "./clerk-options-provider.tsx";
import { FeatureGuideDialog } from "./components/feature-guide-dialog.tsx";
import { ForceUpgradeDialog } from "./components/force-upgrade-dialog.tsx";
import { InspectLogFileInput } from "./inspect-log-file-input.tsx";
import type { BootstrapView } from "../signals/bootstrap.ts";
import { AuthV1LoadError } from "./auth-v1/auth-v1-load-error.tsx";
import { rootSignal$ } from "../signals/root-signal.ts";
import { theme$ } from "../signals/theme.ts";
import { handleInvitationRedirect$ } from "../signals/invitation-redirect.ts";
import { pollInstatusIssues$ } from "../signals/instatus-status.ts";
import { handleBillingFeedbackRedirect$ } from "../signals/billing-feedback.ts";
import { detach, Reason } from "../signals/utils.ts";
import {
  isStandalonePwa,
  setupKeyboardDismissGesture,
} from "../lib/keyboard-dismiss-gesture.ts";
import { InstatusStatusNotice } from "./components/instatus-status-notice.tsx";
import { setupViewportPinchPrevention } from "../lib/viewport-pinch.ts";
import { IN_VITEST } from "../env.ts";
import { featureSwitches$ } from "../signals/external/feature-switch.ts";
import { setupProjectActionShortcuts$ } from "../signals/projects/project-action-shortcuts.ts";
import { projects$ } from "../signals/projects/projects.ts";
import { projectReorderEnabled$ } from "../signals/projects/project-order.ts";
import { setupGlobalKeyboardShortcuts$ } from "../signals/okou-page/nav.ts";
import { setupProjectFoldShortcuts$ } from "../signals/projects/project-fold-shortcuts.ts";
import { setupProjectOrderShortcuts$ } from "../signals/projects/project-order-shortcuts.ts";
import "./css/index.css";

function GlobalKeyboardShortcuts() {
  const signal = useGet(rootSignal$);

  const projects = useLastResolved(projects$);
  const reorderEnabled = useLastResolved(projectReorderEnabled$);
  const setupGlobal = useSet(setupGlobalKeyboardShortcuts$);
  const setupFold = useSet(setupProjectFoldShortcuts$);
  const setupOrder = useSet(setupProjectOrderShortcuts$);
  const archiveEnabled =
    useLastResolved(featureSwitches$)?.[FeatureSwitchKey.ProjectArchive] ===
    true;
  const setupActions = useSet(setupProjectActionShortcuts$);

  const shortcutRef = (element: HTMLSpanElement | null) => {
    if (!element) {
      return;
    }
    const ids =
      projects?.map((project) => {
        return project.id;
      }) ?? [];
    const stopGlobal = setupGlobal(signal);
    const stopActions = setupActions(archiveEnabled, signal);
    const stopFold = setupFold(ids, signal);
    const stopOrder = setupOrder(ids, reorderEnabled === true, signal);
    return () => {
      stopGlobal();
      stopActions();
      stopFold();
      stopOrder();
    };
  };
  return <span hidden ref={shortcutRef} />;
}

function AppToaster() {
  const signal = useGet(rootSignal$);
  const theme = useGet(theme$);
  const handleBillingRedirect = useSet(handleBillingFeedbackRedirect$);
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
      theme={theme}
      position="top-center"
      visibleToasts={1}
      duration={IN_VITEST ? Infinity : undefined}
      onReady={handleReady}
    />
  );
}

export const setupRouter = (
  store: Store,
  view: BootstrapView,
  render: (children: React.ReactNode) => void,
) => {
  if (view === "error") {
    render(
      <StoreProvider value={store}>
        <AuthV1LoadError />
        <ForceUpgradeDialog />
      </StoreProvider>,
    );
    return;
  }

  const signal = store.get(rootSignal$);
  setupViewportPinchPrevention(signal);
  if (isStandalonePwa()) {
    const cleanupKeyboardDismissGesture = setupKeyboardDismissGesture();
    signal.addEventListener("abort", cleanupKeyboardDismissGesture, {
      once: true,
    });
  }
  store.set(pollInstatusIssues$, signal);
  render(
    <StrictMode>
      <StoreProvider value={store}>
        <ErrorBoundary>
          <ClerkOptionsProvider>
            <Router />
          </ClerkOptionsProvider>
          <GlobalKeyboardShortcuts />
          <InspectLogFileInput />
          <ForceUpgradeDialog />
          <FeatureGuideDialog />
          <BillingFeedbackSurvey />
          <InstatusStatusNotice />
        </ErrorBoundary>
        <AppToaster />
      </StoreProvider>
    </StrictMode>,
  );
};
