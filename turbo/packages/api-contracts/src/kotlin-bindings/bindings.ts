import type { ZodType } from "zod";
import type { NoBodyMarker } from "../contracts/trpc-contract";
import { orgContract } from "../contracts/org-routes";
import { userPreferencesContract } from "../contracts/user-preferences";
import { apiErrorSchema } from "../contracts/api-error";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import { androidUpdatesContract } from "../contracts/android-updates";
import {
  chatThreadsContract,
  chatThreadSnapshotArchiveSchema,
  chatThreadEventsContract,
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadMarkUnreadContract,
  chatThreadMuteContract,
  chatThreadArchiveContract,
  chatThreadRenameContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
  chatThreadPinOrderContract,
  chatThreadDraftContract,
} from "../contracts/chat-threads";
import { agentDraftContract } from "../contracts/agent-draft";
import { chatEventRowSchema } from "../contracts/chat-event-rows";
import { agentsMainContract } from "../contracts/agents";
import { projectsContract } from "../contracts/projects";
import { projectSnapshotArchiveSchema } from "../validators/projects";
import { instructionsContract } from "../contracts/instructions";
import { chatEventsContract } from "../contracts/chat-event-send";
import { chatInputStatusContract } from "../contracts/chat-input-status";
import { onboardingStatusContract } from "../contracts/onboarding";
import { platformRealtimeTokenContract } from "../contracts/realtime";
import { sessionOutputDeltaSchema } from "../validators/realtime";
import { modelCatalogContract } from "../contracts/model-catalog";
import { runModelsMainContract } from "../contracts/run-models";
import { thirdPartySubscriptionsMainContract } from "../contracts/third-party-subscriptions";
import { billingStatusContract } from "../contracts/billing";
import { artifactCatalogRuntimeContract } from "../contracts/artifact-catalog";
import { artifactDownloadsContract } from "../contracts/artifact-downloads";
import { artifactReferencesContract } from "../contracts/artifact-references";
import { hostContract } from "../contracts/host";
import { personalModelProviderAccountsByIdContract } from "../contracts/personal-model-providers";
import { featureSwitchesContract } from "../contracts/feature-switches";
import { connectedConnectorsContract } from "../contracts/connected-connectors";
import {
  workflowAutomationsContract,
  workflowScheduleAutomationSummarySchema,
  workflowSummarySchema,
  workflowsCollectionContract,
  workflowsDetailContract,
} from "../contracts/workflows";

export interface KotlinRouteBinding {
  readonly authenticated?: boolean;
  readonly name: string;
  readonly response: string;
  readonly request?: string;
  readonly route: {
    readonly method: string;
    readonly path: string;
    readonly body?: ZodType | NoBodyMarker;
    readonly query?: ZodType;
    readonly pathParams?: ZodType;
    readonly responses: Readonly<Record<number, ZodType | NoBodyMarker>>;
  };
}

const chatReadBindings = [
  {
    name: "chatSnapshot",
    response: "ChatSnapshot",
    route: chatThreadsContract.snapshot,
  },
  {
    name: "chatEvents",
    response: "ChatEvents",
    route: chatThreadsContract.events,
  },
  {
    name: "indicators",
    response: "Indicators",
    route: chatThreadsContract.indicators,
  },
  { name: "agents", response: "Agents", route: agentsMainContract.list },
  {
    name: "projectSnapshot",
    response: "ProjectSnapshot",
    route: projectsContract.snapshot,
  },
  {
    name: "projectEvents",
    response: "ProjectEvents",
    route: projectsContract.events,
  },
] satisfies readonly KotlinRouteBinding[];

const historyReadBindings = [
  {
    name: "historyCatchUp",
    request: "HistoryCatchUpRequest",
    response: "HistoryCatchUp",
    route: chatThreadEventsContract.catchUp,
  },
  {
    name: "historySnapshot",
    response: "HistorySnapshot",
    route: chatThreadEventsContract.snapshot,
  },
  {
    name: "historyRows",
    response: "HistoryRows",
    route: chatThreadEventsContract.rows,
  },
  {
    name: "threadDetail",
    response: "ThreadDetail",
    route: chatThreadByIdContract.get,
  },
  {
    name: "markRead",
    response: "ReadState",
    route: chatThreadMarkReadContract.markRead,
  },
] satisfies readonly KotlinRouteBinding[];

/** Only routes used by the installed native client, not every Web contract. */
export const kotlinRouteBindings: readonly KotlinRouteBinding[] = [
  {
    name: "connectedConnectors",
    response: "ConnectedConnectors",
    route: connectedConnectorsContract.list,
  },
  {
    name: "featureSwitches",
    response: "FeatureSwitches",
    route: featureSwitchesContract.get,
  },
  {
    name: "workflows",
    response: "Workflows",
    route: workflowsCollectionContract.list,
  },
  {
    name: "workflow",
    response: "WorkflowDetail",
    route: workflowsDetailContract.get,
  },
  {
    name: "updateWorkflow",
    request: "UpdateWorkflowRequest",
    response: "WorkflowDetail",
    route: workflowsDetailContract.update,
  },
  {
    name: "workspaceWorkflowAutomations",
    response: "WorkspaceWorkflowAutomations",
    route: workflowAutomationsContract.listWorkspace,
  },
  {
    name: "createWorkflowAutomation",
    request: "CreateWorkflowAutomationRequest",
    response: "WorkflowAutomation",
    route: workflowAutomationsContract.create,
  },
  {
    name: "updateWorkflowAutomation",
    request: "UpdateWorkflowAutomationRequest",
    response: "WorkflowAutomation",
    route: workflowAutomationsContract.update,
  },
  {
    name: "enableWorkflowAutomation",
    response: "WorkflowAutomation",
    route: workflowAutomationsContract.enable,
  },
  {
    name: "disableWorkflowAutomation",
    response: "WorkflowAutomation",
    route: workflowAutomationsContract.disable,
  },
  {
    name: "artifactCatalog",
    response: "ArtifactCatalog",
    route: artifactCatalogRuntimeContract.list,
  },
  {
    name: "artifactDetail",
    response: "ArtifactDetail",
    route: artifactCatalogRuntimeContract.get,
  },
  {
    name: "resolveArtifactReference",
    response: "ArtifactReference",
    route: artifactReferencesContract.resolve,
  },
  {
    name: "artifactDownload",
    response: "ArtifactDownload",
    route: artifactDownloadsContract.download,
  },
  {
    name: "artifactSitePreview",
    response: "ArtifactSitePreview",
    route: hostContract.sitePreview,
  },
  {
    name: "agentDraft",
    response: "ComposerDraft",
    route: agentDraftContract.get,
  },
  {
    name: "threadDraft",
    response: "ComposerDraft",
    route: chatThreadDraftContract.get,
  },
  {
    name: "saveAgentDraft",
    request: "SaveAgentDraft",
    response: "Unit",
    route: agentDraftContract.patch,
  },
  {
    name: "saveThreadDraft",
    request: "SaveThreadDraft",
    response: "Unit",
    route: chatThreadByIdContract.patch,
  },
  {
    name: "recoveryCatalog",
    response: "RecoveryCatalog",
    route: modelCatalogContract.get,
  },
  {
    name: "recoveryModels",
    response: "RecoveryModels",
    route: runModelsMainContract.list,
  },
  {
    name: "recoverySubscriptions",
    response: "RecoverySubscriptions",
    route: thirdPartySubscriptionsMainContract.list,
  },
  {
    name: "recoveryBilling",
    response: "RecoveryBilling",
    route: billingStatusContract.get,
  },
  {
    name: "resetSubscription",
    request: "ResetSubscriptionRequest",
    response: "ResetSubscriptionResult",
    route: personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
  },
  {
    name: "androidUpdates",
    response: "AndroidUpdates",
    authenticated: false,
    route: androidUpdatesContract.get,
  },
  {
    name: "createThread",
    request: "CreateThreadRequest",
    response: "CreatedThread",
    route: chatThreadsContract.create,
  },
  {
    name: "sendInput",
    request: "SendRequest",
    response: "AcceptedInput",
    route: chatEventsContract.send,
  },
  {
    name: "inputStatus",
    response: "InputStatus",
    route: chatInputStatusContract.get,
  },
  {
    name: "onboardingStatus",
    response: "OnboardingStatus",
    route: onboardingStatusContract.getStatus,
  },
  {
    name: "personalInstructions",
    response: "PersonalInstructions",
    route: instructionsContract.get,
  },
  {
    name: "updatePersonalInstructions",
    response: "PersonalInstructions",
    request: "UpdateInstructionsRequest",
    route: instructionsContract.update,
  },
  { name: "organization", response: "Organization", route: orgContract.get },
  {
    name: "realtimeToken",
    response: "RealtimeToken",
    request: "RealtimeTokenRequest",
    route: platformRealtimeTokenContract.create,
  },
  {
    name: "preferences",
    response: "UserPreferences",
    route: userPreferencesContract.get,
  },
  {
    name: "initializePreferences",
    response: "UserPreferences",
    request: "InitializePreferencesRequest",
    route: userPreferencesContract.initialize,
  },
  {
    name: "updatePreferences",
    response: "UserPreferences",
    request: "UpdatePreferencesRequest",
    route: userPreferencesContract.update,
  },
  ...chatReadBindings,
  ...historyReadBindings,
  {
    name: "markUnread",
    response: "ReadState",
    route: chatThreadMarkUnreadContract.markUnread,
  },
  {
    name: "muteThread",
    response: "Unit",
    route: chatThreadMuteContract.mute,
  },
  {
    name: "unmuteThread",
    response: "Unit",
    route: chatThreadMuteContract.unmute,
  },
  {
    name: "archiveThread",
    response: "Unit",
    route: chatThreadArchiveContract.archive,
  },
  {
    name: "unarchiveThread",
    response: "Unit",
    route: chatThreadArchiveContract.unarchive,
  },
  {
    name: "renameThread",
    request: "RenameThreadRequest",
    response: "Unit",
    route: chatThreadRenameContract.rename,
  },
  {
    name: "renameProject",
    request: "RenameProjectRequest",
    response: "RenamedProject",
    route: projectsContract.update,
  },
  {
    name: "deleteThread",
    response: "Unit",
    route: chatThreadByIdContract.delete,
  },
  {
    name: "pinThread",
    response: "Unit",
    route: chatThreadPinContract.pin,
  },
  {
    name: "unpinThread",
    response: "Unit",
    route: chatThreadUnpinContract.unpin,
  },
  {
    name: "reorderPinnedThread",
    request: "ReorderPinnedThreadRequest",
    response: "Unit",
    route: chatThreadPinOrderContract.reorder,
  },
];

export interface KotlinTypeBinding {
  readonly name: string;
  readonly schema: ZodType;
  readonly direction: "input" | "output";
  /** Raw transport/cache envelopes retain all JSON members; their consumer owns decoding. */
  readonly representation?: "raw-object";
  /** Reuse precisely this output shape when the same schema appears inside another DTO. */
  readonly reusableOutput?: boolean;
  readonly unionFields?: readonly string[];
}

export const kotlinTypeBindings: readonly KotlinTypeBinding[] = [
  {
    name: "ConnectedConnectors",
    schema: connectedConnectorsContract.list.responses[200],
    direction: "output",
  },
  {
    name: "FeatureSwitches",
    schema: featureSwitchesContract.get.responses[200],
    direction: "output",
  },
  {
    name: "WorkflowSummary",
    schema: workflowSummarySchema,
    direction: "output",
    reusableOutput: true,
  },
  {
    name: "WorkflowAutomationRuleOrigin",
    schema: workflowScheduleAutomationSummarySchema.shape.official.unwrap(),
    direction: "output",
    reusableOutput: true,
  },
  {
    name: "WorkflowAutomation",
    schema: workflowAutomationsContract.enable.responses[200],
    direction: "output",
    reusableOutput: true,
    unionFields: [
      "id",
      "enabled",
      "chatThreadId",
      "nextRunAt",
      "lastRunAt",
      "official",
    ],
  },
  {
    name: "Workflows",
    schema: workflowsCollectionContract.list.responses[200],
    direction: "output",
  },
  {
    name: "WorkflowDetail",
    schema: workflowsDetailContract.get.responses[200],
    direction: "output",
  },
  {
    name: "UpdateWorkflowRequest",
    schema: workflowsDetailContract.update.body,
    direction: "input",
  },
  {
    name: "WorkspaceWorkflowAutomations",
    schema: workflowAutomationsContract.listWorkspace.responses[200],
    direction: "output",
  },
  {
    name: "CreateWorkflowAutomationRequest",
    schema: workflowAutomationsContract.create.body,
    direction: "input",
  },
  {
    name: "UpdateWorkflowAutomationRequest",
    schema: workflowAutomationsContract.update.body,
    direction: "input",
  },
  {
    name: "ArtifactCatalog",
    schema: artifactCatalogRuntimeContract.list.responses[200],
    direction: "output",
  },
  {
    name: "ArtifactDetail",
    schema: artifactCatalogRuntimeContract.get.responses[200],
    direction: "output",
  },
  {
    name: "ArtifactReference",
    schema: artifactReferencesContract.resolve.responses[200],
    direction: "output",
  },
  {
    name: "ArtifactDownload",
    schema: artifactDownloadsContract.download.responses[200],
    direction: "output",
  },
  {
    name: "ArtifactSitePreview",
    schema: hostContract.sitePreview.responses[200],
    direction: "output",
  },
  {
    name: "RenameProjectRequest",
    schema: projectsContract.update.body,
    direction: "input",
  },
  {
    name: "RenamedProject",
    schema: projectsContract.update.responses[200],
    direction: "output",
  },
  {
    name: "RenameThreadRequest",
    schema: chatThreadRenameContract.rename.body,
    direction: "input",
  },
  {
    name: "ReorderPinnedThreadRequest",
    schema: chatThreadPinOrderContract.reorder.body,
    direction: "input",
  },
  {
    name: "ComposerDraft",
    schema: agentDraftContract.get.responses[200],
    direction: "output",
    representation: "raw-object",
  },
  {
    name: "SaveAgentDraft",
    schema: agentDraftContract.patch.body,
    direction: "input",
  },
  {
    name: "SaveThreadDraft",
    schema: chatThreadByIdContract.patch.body,
    direction: "input",
  },
  {
    name: "RecoveryCatalog",
    schema: modelCatalogContract.get.responses[200],
    direction: "output",
  },
  {
    name: "RecoveryModels",
    schema: runModelsMainContract.list.responses[200],
    direction: "output",
  },
  {
    name: "RecoverySubscriptions",
    schema: thirdPartySubscriptionsMainContract.list.responses[200],
    direction: "output",
  },
  {
    name: "RecoveryBilling",
    schema: billingStatusContract.get.responses[200],
    direction: "output",
  },
  {
    name: "ResetSubscriptionRequest",
    schema:
      personalModelProviderAccountsByIdContract.resetSubscriptionUsage.body,
    direction: "input",
  },
  {
    name: "ResetSubscriptionResult",
    schema:
      personalModelProviderAccountsByIdContract.resetSubscriptionUsage
        .responses[200],
    direction: "output",
  },
  {
    name: "SessionOutputDelta",
    schema: sessionOutputDeltaSchema,
    direction: "output",
  },
  {
    name: "HistoryCatchUpRequest",
    schema: chatThreadEventsContract.catchUp.body,
    direction: "input",
  },
  {
    name: "RealtimeTokenRequest",
    schema: platformRealtimeTokenContract.create.body,
    direction: "input",
  },
  {
    name: "RealtimeToken",
    schema: platformRealtimeTokenContract.create.responses[200],
    direction: "output",
  },
  {
    name: "AndroidUpdates",
    schema: androidUpdatesContract.get.responses[200],
    direction: "output",
  },
  {
    name: "CreateThreadRequest",
    schema: chatThreadsContract.create.body,
    direction: "input",
  },
  {
    name: "CreatedThread",
    schema: chatThreadsContract.create.responses[201],
    direction: "output",
  },
  {
    name: "SendRequest",
    schema: chatEventsContract.send.body,
    direction: "input",
  },
  {
    name: "AcceptedInput",
    schema: chatEventsContract.send.responses[201],
    direction: "output",
  },
  {
    name: "InputStatus",
    schema: chatInputStatusContract.get.responses[200],
    direction: "output",
  },
  {
    name: "OnboardingStatus",
    schema: onboardingStatusContract.getStatus.responses[200],
    direction: "output",
  },
  {
    name: "PersonalInstructions",
    schema: instructionsContract.get.responses[200],
    direction: "output",
  },
  {
    name: "UpdateInstructionsRequest",
    schema: instructionsContract.update.body,
    direction: "input",
  },
  {
    name: "Organization",
    schema: orgContract.get.responses[200],
    direction: "output",
  },
  {
    name: "UserPreferences",
    schema: userPreferencesContract.get.responses[200],
    direction: "output",
  },
  {
    name: "InitializePreferencesRequest",
    schema: userPreferencesContract.initialize.body,
    direction: "input",
  },
  {
    name: "UpdatePreferencesRequest",
    schema: userPreferencesContract.update.body,
    direction: "input",
  },
  { name: "ApiError", schema: apiErrorSchema, direction: "output" },
  {
    name: "AndroidUpgradeRequired",
    schema: androidUpgradeRequiredSchema,
    direction: "output",
  },
  ...chatReadBindings.map(({ response, route }) => {
    return {
      name: response,
      schema: route.responses[200]!,
      direction: "output" as const,
    };
  }),
  ...historyReadBindings.map(({ response, route }) => {
    return {
      name: response,
      schema: route.responses[200]!,
      direction: "output" as const,
    };
  }),
  {
    name: "RawHistoryRow",
    schema: chatEventRowSchema,
    direction: "output",
    representation: "raw-object",
  },
  {
    name: "ChatArchive",
    schema: chatThreadSnapshotArchiveSchema,
    direction: "input",
  },
  {
    name: "ProjectArchive",
    schema: projectSnapshotArchiveSchema,
    direction: "input",
  },
];
