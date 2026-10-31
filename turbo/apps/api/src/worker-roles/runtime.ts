import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { runnersStartupRoutes } from "../signals/routes/runners-startup";
import { cronProcessBackgroundJobsRoutes } from "../signals/routes/cron-process-background-jobs";
import { webhooksClerkRoutes } from "../signals/routes/webhooks-clerk";
import { webhooksStripeRoutes } from "../signals/routes/webhooks-stripe";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../signals/routes/webhooks-agent-health-usage-telemetry";
import { webhooksAgentCompleteRoutes } from "../signals/routes/webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../signals/routes/webhooks-agent-events";
import { linkApprovalWorkflowRoutes } from "../signals/routes/link-approval-workflow";
import { cronCleanupSandboxesRoutes } from "../signals/routes/cron-cleanup-sandboxes";
import { cronExecuteWorkflowAutomationsRoutes } from "../signals/routes/cron-execute-workflow-automations";
import { cronReconcileBillingEntitlementsRoutes } from "../signals/routes/cron-reconcile-billing-entitlements";
import { cronSteerRunTimeBudgetRoutes } from "../signals/routes/cron-steer-run-time-budget";
import { artifactCatalogRoutes } from "../signals/routes/artifact-catalog";
import { billingCheckoutRoutes } from "../signals/routes/billing-checkout";
import { chatThreadRoutes } from "../signals/routes/chat-threads";
import { welcomeChatThreadRoutes } from "../signals/routes/welcome-chat-threads";
import { chatEventsRoutes } from "../signals/routes/chat-events";
import { sharedThreadRoutes } from "../signals/routes/shared-threads";
import { desktopShellAuthorizationRoutes } from "../signals/routes/desktop-shell-authorization";
import { chatRemoteAccessRoutes } from "../signals/routes/chat-remote-access";
import { runnerVncRoutes } from "../signals/routes/runner-vnc";
import { runnerSshRoutes } from "../signals/routes/runner-ssh";
import { browserRoutes } from "../signals/routes/browser";
import { runDetailRoutes } from "../signals/routes/run-detail";
import { runsRoutes } from "../signals/routes/runs";
import { runsCancelRoutes } from "../signals/routes/runs-cancel";
import { orgDeleteRoutes } from "../signals/routes/org-delete";
import { orgMembersRoutes } from "../signals/routes/org-members";
import { orgReadRoutes } from "../signals/routes/org-read";
import { workflowsRoutes } from "../signals/routes/workflows";
import { workflowAutomationsRoutes } from "../signals/routes/workflow-automations";
import { skillImportRoutes } from "../signals/routes/skill-import";
import { slackCommandsRoutes } from "../signals/routes/slack-commands";
import { slackEventsRoutes } from "../signals/routes/slack-events";
import { slackInteractiveRoutes } from "../signals/routes/slack-interactive";
import { runnersRoutes } from "../signals/routes/runners";
import { runnerCancellationRoutes } from "../signals/routes/runner-cancellation";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";

const roleRoutes: readonly RouteEntry[] = [
  ...runnersStartupRoutes,
  ...cronProcessBackgroundJobsRoutes,
  ...webhooksClerkRoutes,
  ...webhooksStripeRoutes,
  ...webhooksAgentHealthUsageTelemetryRoutes,
  ...webhooksAgentCompleteRoutes,
  ...webhooksAgentEventsRoutes,
  ...linkApprovalWorkflowRoutes,
  ...cronCleanupSandboxesRoutes,
  ...cronExecuteWorkflowAutomationsRoutes,
  ...cronReconcileBillingEntitlementsRoutes,
  ...cronSteerRunTimeBudgetRoutes,
  ...artifactCatalogRoutes,
  ...billingCheckoutRoutes,
  ...chatThreadRoutes,
  ...welcomeChatThreadRoutes,
  ...chatEventsRoutes,
  ...sharedThreadRoutes,
  ...desktopShellAuthorizationRoutes,
  ...chatRemoteAccessRoutes,
  ...runnerVncRoutes,
  ...runnerSshRoutes,
  ...browserRoutes,
  ...runDetailRoutes,
  ...runsRoutes,
  ...runsCancelRoutes,
  ...orgDeleteRoutes,
  ...orgMembersRoutes,
  ...orgReadRoutes,
  ...workflowsRoutes,
  ...workflowAutomationsRoutes,
  ...skillImportRoutes,
  ...slackCommandsRoutes,
  ...slackEventsRoutes,
  ...slackInteractiveRoutes,
  ...runnersRoutes,
  ...runnerCancellationRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
