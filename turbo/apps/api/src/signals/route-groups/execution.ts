// Keep each domain statically scoped; never import the complete ROUTES registry.
import type { RouteEntry } from "../route-entry";
import { runnersStartupRoutes } from "../routes/runners-startup";
import { cronProcessBackgroundJobsRoutes } from "../routes/cron-process-background-jobs";
import { cronReconcileImageGenerationsRoutes } from "../routes/cron-reconcile-image-generations";
import { webhooksBuiltInGenerationRoutes } from "../routes/webhooks-built-in-generations";
import { webhooksWorkflowAutomationsRoutes } from "../routes/webhooks-workflow-automations";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../routes/webhooks-agent-health-usage-telemetry";
import { webhooksAgentCompleteRoutes } from "../routes/webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../routes/webhooks-agent-events";
import { webhooksAgentSessionOutputRoutes } from "../routes/webhooks-agent-session-output";
import { webhooksAgentFirewallAuthRoutes } from "../routes/webhooks-agent-firewall-auth";
import { webhooksAgentStorageRoutes } from "../routes/webhooks-agent-storage";
import { cronCompactChatThreadSnapshotsRoutes } from "../routes/cron-compact-chat-thread-snapshots";
import { cronProjectChatEventSearchRoutes } from "../routes/cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "../routes/cron-snapshot-chat-events";
import { cronRetainChatEventsRoutes } from "../routes/cron-retain-chat-events";
import { cronCleanupSandboxesRoutes } from "../routes/cron-cleanup-sandboxes";
import { cronOfficialWorkflowCatalogRoutes } from "../routes/cron-official-workflow-catalog";
import { cronExecuteWorkflowAutomationsRoutes } from "../routes/cron-execute-workflow-automations";
import { cronMonitorChatEventQueueRoutes } from "../routes/cron-monitor-chat-event-queue";
import { cronMaterializePiResourceIndexesRoutes } from "../routes/cron-materialize-pi-resource-indexes";
import { cronComputerUseScreenshotCleanupRoutes } from "../routes/cron-computer-use-screenshot-cleanup";
import { cronBrowserReconcileRoutes } from "../routes/cron-browser-reconcile";
import { cronSteerRunTimeBudgetRoutes } from "../routes/cron-steer-run-time-budget";
import { cronSyncSkillsRoutes } from "../routes/cron-sync-skills";
import { agentDraftRoutes } from "../routes/agent-draft";
import { suggestionsRoutes } from "../routes/suggestions";
import { jobsRoutes } from "../routes/jobs";
import { agentInstructionsRoutes } from "../routes/agent-instructions";
import { agentsRoutes } from "../routes/agents";
import { chatThreadRoutes } from "../routes/chat-threads";
import { welcomeChatThreadRoutes } from "../routes/welcome-chat-threads";
import { chatEventsRoutes } from "../routes/chat-events";
import { sharedThreadRoutes } from "../routes/shared-threads";
import { computerUseAuthorizationRoutes } from "../routes/computer-use-authorization";
import { desktopShellAuthorizationRoutes } from "../routes/desktop-shell-authorization";
import { computerUseRoutes } from "../routes/computer-use";
import { remotesRoutes } from "../routes/remotes";
import { builtInGenerationRoutes } from "../routes/built-in-generation";
import { imageIoGenerateRoutes } from "../routes/image-io-generate";
import { logsRoutes } from "../routes/logs";
import { mcpServerRoutes } from "../routes/mcp-server";
import { sshConnectionsRoutes } from "../routes/ssh-connections";
import { vncConnectionsRoutes } from "../routes/vnc-connections";
import { chatRemoteAccessRoutes } from "../routes/chat-remote-access";
import { vncAccessRoutes } from "../routes/vnc-access";
import { runnerVncRoutes } from "../routes/runner-vnc";
import { cloudflareAccessRoutes } from "../routes/cloudflare-access";
import { tailscaleRoutes } from "../routes/tailscale";
import { sshAccessRoutes } from "../routes/ssh-access";
import { runnerSshRoutes } from "../routes/runner-ssh";
import { browserRoutes } from "../routes/browser";
import { browserAuthorizationRoutes } from "../routes/browser-authorization";
import { browserUserActionRoutes } from "../routes/browser-user-actions";
import { runModelsRoutes } from "../routes/run-models";
import { agentSetupPromptRoutes } from "../routes/agent-setup-prompts";
import { runDetailRoutes } from "../routes/run-detail";
import { runsRoutes } from "../routes/runs";
import { runsCancelRoutes } from "../routes/runs-cancel";
import { onboardingRecommendationRoutes } from "../routes/onboarding-recommendations";
import {
  proactiveLearningRoutes,
  proactivePlanningRoutes,
} from "../routes/proactive-preferences";

import { debugMorningBriefRoutes } from "../routes/debug-morning-brief";
import { workflowsRoutes } from "../routes/workflows";
import { workflowAutomationsRoutes } from "../routes/workflow-automations";
import { skillImportRoutes } from "../routes/skill-import";
import { runnersRoutes } from "../routes/runners";
import { runnerCancellationRoutes } from "../routes/runner-cancellation";

export const EXECUTION_ROUTES: readonly RouteEntry[] = [
  ...runnersStartupRoutes,
  ...cronProcessBackgroundJobsRoutes,
  ...cronReconcileImageGenerationsRoutes,
  ...webhooksBuiltInGenerationRoutes,
  ...webhooksWorkflowAutomationsRoutes,
  ...webhooksAgentHealthUsageTelemetryRoutes,
  ...webhooksAgentCompleteRoutes,
  ...webhooksAgentEventsRoutes,
  ...webhooksAgentSessionOutputRoutes,
  ...webhooksAgentFirewallAuthRoutes,
  ...webhooksAgentStorageRoutes,
  ...cronCompactChatThreadSnapshotsRoutes,
  ...cronProjectChatEventSearchRoutes,
  ...cronSnapshotChatEventsRoutes,
  ...cronRetainChatEventsRoutes,
  ...cronCleanupSandboxesRoutes,
  ...cronOfficialWorkflowCatalogRoutes,
  ...cronExecuteWorkflowAutomationsRoutes,
  ...cronMonitorChatEventQueueRoutes,
  ...cronMaterializePiResourceIndexesRoutes,
  ...cronComputerUseScreenshotCleanupRoutes,
  ...cronBrowserReconcileRoutes,
  ...cronSteerRunTimeBudgetRoutes,
  ...cronSyncSkillsRoutes,
  ...agentDraftRoutes,
  ...suggestionsRoutes,
  ...jobsRoutes,
  ...agentInstructionsRoutes,
  ...agentsRoutes,
  ...chatThreadRoutes,
  ...welcomeChatThreadRoutes,
  ...chatEventsRoutes,
  ...sharedThreadRoutes,
  ...computerUseAuthorizationRoutes,
  ...desktopShellAuthorizationRoutes,
  ...computerUseRoutes,
  ...remotesRoutes,
  ...builtInGenerationRoutes,
  ...imageIoGenerateRoutes,
  ...logsRoutes,
  ...mcpServerRoutes,
  ...sshConnectionsRoutes,
  ...vncConnectionsRoutes,
  ...chatRemoteAccessRoutes,
  ...vncAccessRoutes,
  ...runnerVncRoutes,
  ...cloudflareAccessRoutes,
  ...tailscaleRoutes,
  ...sshAccessRoutes,
  ...runnerSshRoutes,
  ...browserRoutes,
  ...browserAuthorizationRoutes,
  ...browserUserActionRoutes,
  ...runModelsRoutes,
  ...agentSetupPromptRoutes,
  ...runDetailRoutes,
  ...runsRoutes,
  ...runsCancelRoutes,
  ...onboardingRecommendationRoutes,
  ...proactiveLearningRoutes,
  ...proactivePlanningRoutes,
  ...debugMorningBriefRoutes,
  ...workflowsRoutes,
  ...workflowAutomationsRoutes,
  ...skillImportRoutes,
  ...runnersRoutes,
  ...runnerCancellationRoutes,
];
