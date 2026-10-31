import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { userExportRoutes } from "../signals/routes/user-export";
import { webhooksAgentStorageRoutes } from "../signals/routes/webhooks-agent-storage";
import { cronCompactChatThreadSnapshotsRoutes } from "../signals/routes/cron-compact-chat-thread-snapshots";
import { cronReconcileArtifactCatalogRoutes } from "../signals/routes/cron-reconcile-artifact-catalog";
import { cronSnapshotChatEventsRoutes } from "../signals/routes/cron-snapshot-chat-events";
import { cronOfficialWorkflowCatalogRoutes } from "../signals/routes/cron-official-workflow-catalog";
import { cronPruneStoragePresignedUrlsRoutes } from "../signals/routes/cron-prune-storage-presigned-urls";
import { cronMaterializePiResourceIndexesRoutes } from "../signals/routes/cron-materialize-pi-resource-indexes";
import { cronComputerUseScreenshotCleanupRoutes } from "../signals/routes/cron-computer-use-screenshot-cleanup";
import { cronBrowserReconcileRoutes } from "../signals/routes/cron-browser-reconcile";
import { cronSyncSkillsRoutes } from "../signals/routes/cron-sync-skills";
import { agentDraftRoutes } from "../signals/routes/agent-draft";
import { suggestionsRoutes } from "../signals/routes/suggestions";
import { agentInstructionsRoutes } from "../signals/routes/agent-instructions";
import { agentsRoutes } from "../signals/routes/agents";
import { computerUseAuthorizationRoutes } from "../signals/routes/computer-use-authorization";
import { computerUseRoutes } from "../signals/routes/computer-use";
import { agentConnectorAccessRoutes } from "../signals/routes/agent-connector-access";
import { remotesRoutes } from "../signals/routes/remotes";
import { hostRoutes } from "../signals/routes/host";
import { artifactShareRoutes } from "../signals/routes/artifact-shares";
import { artifactReferenceRoutes } from "../signals/routes/artifact-references";
import { artifactOgRoutes } from "../signals/routes/artifact-og";
import { artifactDownloadRoutes } from "../signals/routes/artifact-downloads";
import { browserUserActionRoutes } from "../signals/routes/browser-user-actions";
import { webFileUrlRoutes } from "../signals/routes/web-file-url";
import { onboardingCompleteRoutes } from "../signals/routes/onboarding-complete";
import { onboardingStatusRoutes } from "../signals/routes/onboarding-status";
import { userPreferencesRoutes } from "../signals/routes/user-preferences";
import { morningBriefPreferenceRoutes } from "../signals/routes/morning-brief-preference";
import {
  proactiveSuggestionsRoutes,
  proactiveJobsRoutes,
  proactiveLearningRoutes,
} from "../signals/routes/proactive-preferences";
import { integrationsWechatFileRoutes } from "../signals/routes/integrations-wechat-files";
import { integrationsPhoneUploadInitRoutes } from "../signals/routes/integrations-phone-upload-init";
import { integrationsGithubUploadCompleteRoutes } from "../signals/routes/integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "../signals/routes/integrations-github-upload-init";
import { integrationsFeishuFileRoutes } from "../signals/routes/integrations-feishu-files";
import { integrationsDiscordFileRoutes } from "../signals/routes/integrations-discord-files";
import { integrationsSlackUploadCompleteRoutes } from "../signals/routes/integrations-slack-upload-complete";
import { integrationsSlackUploadInitRoutes } from "../signals/routes/integrations-slack-upload-init";
import { integrationsSlackUploadMaterializeRoutes } from "../signals/routes/integrations-slack-upload-materialize";
import { integrationsTeamsUploadCompleteRoutes } from "../signals/routes/integrations-teams-upload-complete";
import { integrationsTeamsUploadInitRoutes } from "../signals/routes/integrations-teams-upload-init";
import { uploadsCompleteRoutes } from "../signals/routes/uploads-complete";
import { uploadsMultipartRoutes } from "../signals/routes/uploads-multipart";
import { uploadsPrepareRoutes } from "../signals/routes/uploads-prepare";
import { presentationTemplatesRoutes } from "../signals/routes/presentation-templates";
import { userTemplatesRoutes } from "../signals/routes/user-templates";
import { registryResourceDownloadRoutes } from "../signals/routes/registry-resources-download";
import { initializeNoServices$ } from "./initialize-no-services";

const roleRoutes: readonly RouteEntry[] = [
  ...userExportRoutes,
  ...webhooksAgentStorageRoutes,
  ...cronCompactChatThreadSnapshotsRoutes,
  ...cronReconcileArtifactCatalogRoutes,
  ...cronSnapshotChatEventsRoutes,
  ...cronOfficialWorkflowCatalogRoutes,
  ...cronPruneStoragePresignedUrlsRoutes,
  ...cronMaterializePiResourceIndexesRoutes,
  ...cronComputerUseScreenshotCleanupRoutes,
  ...cronBrowserReconcileRoutes,
  ...cronSyncSkillsRoutes,
  ...agentDraftRoutes,
  ...suggestionsRoutes,
  ...agentInstructionsRoutes,
  ...agentsRoutes,
  ...computerUseAuthorizationRoutes,
  ...computerUseRoutes,
  ...agentConnectorAccessRoutes,
  ...remotesRoutes,
  ...hostRoutes,
  ...artifactShareRoutes,
  ...artifactReferenceRoutes,
  ...artifactOgRoutes,
  ...artifactDownloadRoutes,
  ...browserUserActionRoutes,
  ...webFileUrlRoutes,
  ...onboardingCompleteRoutes,
  ...onboardingStatusRoutes,
  ...userPreferencesRoutes,
  ...morningBriefPreferenceRoutes,
  ...proactiveSuggestionsRoutes,
  ...proactiveJobsRoutes,
  ...proactiveLearningRoutes,
  ...integrationsWechatFileRoutes,
  ...integrationsPhoneUploadInitRoutes,
  ...integrationsGithubUploadCompleteRoutes,
  ...integrationsGithubUploadInitRoutes,
  ...integrationsFeishuFileRoutes,
  ...integrationsDiscordFileRoutes,
  ...integrationsSlackUploadCompleteRoutes,
  ...integrationsSlackUploadInitRoutes,
  ...integrationsSlackUploadMaterializeRoutes,
  ...integrationsTeamsUploadCompleteRoutes,
  ...integrationsTeamsUploadInitRoutes,
  ...uploadsCompleteRoutes,
  ...uploadsMultipartRoutes,
  ...uploadsPrepareRoutes,
  ...presentationTemplatesRoutes,
  ...userTemplatesRoutes,
  ...registryResourceDownloadRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: initializeNoServices$,
  });
});
