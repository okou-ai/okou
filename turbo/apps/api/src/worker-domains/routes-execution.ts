// Keep each domain statically scoped; never import the complete ROUTES registry.
import type { RouteEntry } from "../signals/route-entry";
import { runnersStartupRoutes } from "../signals/routes/runners-startup";
import { cronProcessBackgroundJobsRoutes } from "../signals/routes/cron-process-background-jobs";
import { cronReconcileImageGenerationsRoutes } from "../signals/routes/cron-reconcile-image-generations";
import { webhooksBuiltInGenerationRoutes } from "../signals/routes/webhooks-built-in-generations";
import { webhooksWorkflowAutomationsRoutes } from "../signals/routes/webhooks-workflow-automations";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../signals/routes/webhooks-agent-health-usage-telemetry";
import { webhooksAgentCompleteRoutes } from "../signals/routes/webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../signals/routes/webhooks-agent-events";
import { webhooksAgentSessionOutputRoutes } from "../signals/routes/webhooks-agent-session-output";
import { webhooksAgentFirewallAuthRoutes } from "../signals/routes/webhooks-agent-firewall-auth";
import { webhooksAgentStorageRoutes } from "../signals/routes/webhooks-agent-storage";
import { cronCompactChatThreadSnapshotsRoutes } from "../signals/routes/cron-compact-chat-thread-snapshots";
import { cronProjectChatEventSearchRoutes } from "../signals/routes/cron-project-chat-event-search";
import { cronSnapshotChatEventsRoutes } from "../signals/routes/cron-snapshot-chat-events";
import { cronRetainChatEventsRoutes } from "../signals/routes/cron-retain-chat-events";
import { cronCleanupSandboxesRoutes } from "../signals/routes/cron-cleanup-sandboxes";
import { cronOfficialWorkflowCatalogRoutes } from "../signals/routes/cron-official-workflow-catalog";
import { cronExecuteWorkflowAutomationsRoutes } from "../signals/routes/cron-execute-workflow-automations";
import { cronMonitorChatEventQueueRoutes } from "../signals/routes/cron-monitor-chat-event-queue";
import { cronMaterializePiResourceIndexesRoutes } from "../signals/routes/cron-materialize-pi-resource-indexes";
import { cronComputerUseScreenshotCleanupRoutes } from "../signals/routes/cron-computer-use-screenshot-cleanup";
import { cronBrowserReconcileRoutes } from "../signals/routes/cron-browser-reconcile";
import { cronSteerRunTimeBudgetRoutes } from "../signals/routes/cron-steer-run-time-budget";
import { cronSyncSkillsRoutes } from "../signals/routes/cron-sync-skills";
import { agentDraftRoutes } from "../signals/routes/agent-draft";
import { suggestionsRoutes } from "../signals/routes/suggestions";
import { jobsRoutes } from "../signals/routes/jobs";
import { agentInstructionsRoutes } from "../signals/routes/agent-instructions";
import { agentsRoutes } from "../signals/routes/agents";
import { chatThreadRoutes } from "../signals/routes/chat-threads";
import { welcomeChatThreadRoutes } from "../signals/routes/welcome-chat-threads";
import { chatEventsRoutes } from "../signals/routes/chat-events";
import { sharedThreadRoutes } from "../signals/routes/shared-threads";
import { computerUseAuthorizationRoutes } from "../signals/routes/computer-use-authorization";
import { desktopShellAuthorizationRoutes } from "../signals/routes/desktop-shell-authorization";
import { computerUseRoutes } from "../signals/routes/computer-use";
import { remotesRoutes } from "../signals/routes/remotes";
import { builtInGenerationRoutes } from "../signals/routes/built-in-generation";
import { imageIoGenerateRoutes } from "../signals/routes/image-io-generate";
import { logsRoutes } from "../signals/routes/logs";
import { mcpServerRoutes } from "../signals/routes/mcp-server";
import { sshConnectionsRoutes } from "../signals/routes/ssh-connections";
import { vncConnectionsRoutes } from "../signals/routes/vnc-connections";
import { chatRemoteAccessRoutes } from "../signals/routes/chat-remote-access";
import { vncAccessRoutes } from "../signals/routes/vnc-access";
import { runnerVncRoutes } from "../signals/routes/runner-vnc";
import { cloudflareAccessRoutes } from "../signals/routes/cloudflare-access";
import { tailscaleRoutes } from "../signals/routes/tailscale";
import { sshAccessRoutes } from "../signals/routes/ssh-access";
import { runnerSshRoutes } from "../signals/routes/runner-ssh";
import { browserRoutes } from "../signals/routes/browser";
import { browserAuthorizationRoutes } from "../signals/routes/browser-authorization";
import { browserUserActionRoutes } from "../signals/routes/browser-user-actions";
import { runModelsRoutes } from "../signals/routes/run-models";
import { agentSetupPromptRoutes } from "../signals/routes/agent-setup-prompts";
import { runDetailRoutes } from "../signals/routes/run-detail";
import { runsRoutes } from "../signals/routes/runs";
import { runsCancelRoutes } from "../signals/routes/runs-cancel";
import { onboardingRecommendationRoutes } from "../signals/routes/onboarding-recommendations";
import { proactiveLearningRoutes } from "../signals/routes/proactive-preferences";
import { proactivePlanningRoutes } from "../signals/routes/proactive-preferences";
import { debugMorningBriefRoutes } from "../signals/routes/debug-morning-brief";
import { workflowsRoutes } from "../signals/routes/workflows";
import { workflowAutomationsRoutes } from "../signals/routes/workflow-automations";
import { skillImportRoutes } from "../signals/routes/skill-import";
import { runnersRoutes } from "../signals/routes/runners";
import { runnerCancellationRoutes } from "../signals/routes/runner-cancellation";

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
