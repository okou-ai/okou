import { string, type ZodType } from "zod";
import type { NoBodyMarker } from "../contracts/trpc-contract";
import { orgContract } from "../contracts/org-routes";
import { userPreferencesContract } from "../contracts/user-preferences";
import { emailSubscriptionContract } from "../contracts/email-subscription";
import { apiErrorSchema } from "../contracts/api-error";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";
import { androidUpdatesContract } from "../contracts/android-updates";
import { uploadsContract } from "../contracts/uploads";
import { webFilesContract } from "../contracts/web-files";
import {
  chatThreadsContract,
  chatSearchContract,
  chatThreadSnapshotArchiveSchema,
  chatThreadEventsContract,
  chatThreadByIdContract,
  chatThreadMarkReadContract,
  chatThreadMarkUnreadContract,
  chatThreadMuteContract,
  chatThreadArchiveContract,
  chatThreadRenameContract,
  chatThreadModelSelectionContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
  chatThreadPinOrderContract,
  chatThreadDraftContract,
} from "../contracts/chat-threads";
import { composerDraftContract } from "../contracts/composer-draft";
import { chatEventRowSchema } from "../contracts/chat-event-rows";
import { projectsContract } from "../contracts/projects";
import { projectSnapshotArchiveSchema } from "../validators/projects";
import { instructionsContract } from "../contracts/instructions";
import { chatEventsContract } from "../contracts/chat-event-send";
import { chatThreadActivitySummaryContract } from "../contracts/chat-thread-activity-summary";
import { chatInputStatusContract } from "../contracts/chat-input-status";
import { onboardingStatusContract } from "../contracts/onboarding";
import { platformRealtimeTokenContract } from "../contracts/realtime";
import { sessionOutputDeltaSchema } from "../validators/realtime";
import { modelCatalogContract } from "../contracts/model-catalog";
import { runModelsMainContract } from "../contracts/run-models";
import {
  imageModelPreferenceSchema,
  userModelPreferenceContract,
} from "../contracts/user-model-preference";
import { paidToolsContract } from "../contracts/paid-tools";
import { featureSwitchesContract } from "../contracts/feature-switches";
import { feedContract } from "../contracts/feed";
import { morningBriefPreferenceContract } from "../contracts/morning-brief-preference";
import { proactiveSuggestionsContract } from "../contracts/proactive-suggestions";
import { thirdPartySubscriptionsMainContract } from "../contracts/third-party-subscriptions";
import {
  billingStatusContract,
  billingUsagePackCreditsContract,
} from "../contracts/billing";
import { artifactAccessContract } from "../contracts/artifact-access";
import { artifactCatalogContract } from "../contracts/artifact-catalog";
import { chatRelationsContract } from "../contracts/chat-relations";
import { artifactDownloadsContract } from "../contracts/artifact-downloads";
import { artifactReferencesContract } from "../contracts/artifact-references";
import { hostContract } from "../contracts/host";
import { personalModelProviderAccountsByIdContract } from "../contracts/personal-model-providers";
import { connectedConnectorsContract } from "../contracts/connected-connectors";
import {
  workflowAutomationsContract,
  workflowRunHistoryEntrySchema,
  workflowScheduleAutomationSummarySchema,
  workflowSummarySchema,
  workflowsCollectionContract,
  workflowsDetailContract,
} from "../contracts/workflows";
import { connectorCatalogContract } from "../contracts/connector-catalog";
import { connectorAccountsContract } from "../contracts/connector-accounts";
import { chatConnectorAccessContract } from "../contracts/chat-connector-access";
import {
  builtinConnectorAutomaticContract,
  builtinConnectorExternalCodeSessionContract,
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorOauthDeviceAuthSessionContract,
  builtinConnectorOauthStartContract,
  builtinConnectorOpenIdStartContract,
} from "../contracts/connectors";

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
  {
    name: "chatDraftIndex",
    response: "ChatDraftIndex",
    route: chatThreadsContract.drafts,
  },
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
    name: "relatedCreatedChats",
    response: "RelatedCreatedChats",
    route: chatRelationsContract.children,
  },
  {
    name: "relatedCommunicatingChats",
    response: "RelatedCommunicatingChats",
    route: chatRelationsContract.communications,
  },
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

const connectorBindings = [
  {
    name: "connectorDiscovery",
    response: "ConnectorDiscovery",
    route: connectorCatalogContract.discovery,
  },
  {
    name: "connectorDetail",
    response: "ConnectorDetail",
    route: connectorCatalogContract.get,
  },
  {
    name: "connectorPermissions",
    response: "ConnectorPermissions",
    route: connectorCatalogContract.permissions,
  },
  {
    name: "connectorOverview",
    response: "ConnectorOverview",
    route: chatConnectorAccessContract.overview,
  },
  {
    name: "chatConnectorAccess",
    response: "ChatConnectorAccess",
    route: chatConnectorAccessContract.getThread,
  },
  {
    name: "chatConnectorOverride",
    response: "ChatConnectorAccess",
    request: "ChatConnectorOverrideRequest",
    route: chatConnectorAccessContract.setThreadOverride,
  },
  {
    name: "connectorAccountDefaults",
    response: "ConnectorAccountDefaults",
    route: chatConnectorAccessContract.accountDefaults,
  },
  {
    name: "connectorAccountPolicies",
    response: "ConnectorAccountPolicies",
    route: chatConnectorAccessContract.accountPolicies,
  },
  {
    name: "connectorAccountPolicyUpdate",
    response: "ConnectorAccountPolicy",
    request: "ConnectorAccountPolicyRequest",
    route: chatConnectorAccessContract.updateAccountPolicy,
  },
  {
    name: "connectorAccountDefaultUpdate",
    response: "ConnectorAccountDefault",
    request: "ConnectorAccountDefaultRequest",
    route: chatConnectorAccessContract.updateAccountDefault,
  },
  {
    name: "connectorAccounts",
    response: "ConnectorAccounts",
    route: connectorAccountsContract.connections,
  },
  {
    name: "connectorAccount",
    response: "ConnectorAccount",
    route: connectorAccountsContract.connection,
  },
  {
    name: "connectorAccountInspect",
    response: "ConnectorAccountInspection",
    request: "ConnectorAccountInspectionRequest",
    route: connectorAccountsContract.inspect,
  },
  {
    name: "connectorAccountRename",
    response: "ConnectorAccount",
    request: "ConnectorAccountRenameRequest",
    route: connectorAccountsContract.rename,
  },
  {
    name: "connectorAccountImpact",
    response: "ConnectorAccountImpact",
    route: connectorAccountsContract.deletionImpact,
  },
  {
    name: "connectorAccountDelete",
    response: "ConnectorAccountDeletion",
    request: "ConnectorAccountTargetRequest",
    route: connectorAccountsContract.delete,
  },
  {
    name: "connectorOauthCompletion",
    response: "ConnectorOauthCompletion",
    route: connectorAccountsContract.oauthCompletion,
  },
  {
    name: "connectorOauthStart",
    response: "ConnectorOauthStart",
    request: "ConnectorOauthStartRequest",
    route: builtinConnectorOauthStartContract.start,
  },
  {
    name: "connectorOpenIdStart",
    response: "ConnectorOauthStart",
    request: "ConnectorOpenIdStartRequest",
    route: builtinConnectorOpenIdStartContract.start,
  },
  {
    name: "connectorAutomaticStart",
    response: "ConnectorAutomaticStart",
    request: "ConnectorAutomaticStartRequest",
    route: builtinConnectorAutomaticContract.start,
  },
  {
    name: "connectorNoAuth",
    response: "ConnectorGrant",
    request: "ConnectorNoAuthRequest",
    route: builtinConnectorNoAuthGrantContract.connect,
  },
  {
    name: "connectorManual",
    response: "ConnectorGrant",
    request: "ConnectorManualRequest",
    route: builtinConnectorManualGrantContract.connect,
  },
  {
    name: "connectorDeviceStart",
    response: "ConnectorDeviceStart",
    request: "ConnectorDeviceStartRequest",
    route: builtinConnectorOauthDeviceAuthSessionContract.create,
  },
  {
    name: "connectorDevicePoll",
    response: "ConnectorDevicePoll",
    request: "ConnectorDevicePollRequest",
    route: builtinConnectorOauthDeviceAuthSessionContract.poll,
  },
  {
    name: "connectorExternalStart",
    response: "ConnectorExternalStart",
    request: "ConnectorExternalStartRequest",
    route: builtinConnectorExternalCodeSessionContract.create,
  },
  {
    name: "connectorExternalComplete",
    response: "ConnectorExternalComplete",
    request: "ConnectorExternalCompleteRequest",
    route: builtinConnectorExternalCodeSessionContract.complete,
  },
] as const satisfies readonly KotlinRouteBinding[];

/** Only routes used by the installed native client, not every Web contract. */
export const kotlinRouteBindings: readonly KotlinRouteBinding[] = [
  ...connectorBindings,
  {
    name: "artifactCatalog",
    response: "ArtifactCatalog",
    route: artifactCatalogContract.list,
  },
  {
    name: "artifactDetail",
    response: "ArtifactDetail",
    route: artifactCatalogContract.get,
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
    name: "artifactVisibility",
    response: "ArtifactVisibility",
    route: artifactAccessContract.getVisibility,
  },
  {
    name: "updateArtifactVisibility",
    response: "ArtifactVisibility",
    request: "ArtifactVisibilityUpdate",
    route: artifactAccessContract.updateVisibility,
  },
  {
    name: "artifactSiteUrl",
    response: "ArtifactSiteUrl",
    route: hostContract.siteUrl,
  },
  {
    name: "connectedConnectors",
    response: "ConnectedConnectors",
    route: connectedConnectorsContract.list,
  },
  {
    name: "workflows",
    response: "Workflows",
    route: workflowsCollectionContract.list,
  },
  {
    name: "composerWorkflows",
    response: "ComposerWorkflows",
    route: workflowsCollectionContract.composer,
  },
  {
    name: "recentComposerWorkflows",
    response: "RecentComposerWorkflows",
    route: workflowsCollectionContract.recent,
  },
  {
    name: "recordComposerWorkflowUse",
    request: "RecordComposerWorkflowUseRequest",
    response: "RecordedComposerWorkflowUse",
    route: workflowsCollectionContract.recordRecentUse,
  },
  {
    name: "workflow",
    response: "WorkflowDetail",
    route: workflowsDetailContract.get,
  },
  {
    name: "workflowRunHistory",
    response: "WorkflowRunHistory",
    route: workflowsDetailContract.runHistory,
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
    name: "searchChatMessages",
    response: "ChatMessageSearchResponse",
    route: chatSearchContract.search,
  },
  {
    name: "workspaceDraft",
    response: "ComposerDraft",
    route: composerDraftContract.get,
  },
  {
    name: "threadDraft",
    response: "ThreadDraft",
    route: chatThreadDraftContract.get,
  },
  {
    name: "saveWorkspaceDraft",
    request: "SaveWorkspaceDraft",
    response: "Unit",
    route: composerDraftContract.patch,
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
    name: "defaultModelPreference",
    response: "DefaultModelPreference",
    route: userModelPreferenceContract.get,
  },
  {
    name: "updateDefaultModelPreference",
    request: "UpdateDefaultModelPreference",
    response: "DefaultModelPreference",
    route: userModelPreferenceContract.update,
  },
  {
    name: "updateImageModelPreference",
    request: "UpdateImageModelPreference",
    response: "DefaultModelPreference",
    route: userModelPreferenceContract.updateImageModel,
  },
  {
    name: "paidToolPreferences",
    response: "PaidToolPreferences",
    route: paidToolsContract.get,
  },
  {
    name: "updatePaidTool",
    request: "UpdatePaidTool",
    response: "PaidToolUpdate",
    route: paidToolsContract.update,
  },
  {
    name: "emailSubscription",
    response: "EmailSubscription",
    route: emailSubscriptionContract.get,
  },
  {
    name: "updateEmailSubscription",
    request: "UpdateEmailSubscriptionRequest",
    response: "EmailSubscriptionUpdate",
    route: emailSubscriptionContract.update,
  },
  {
    name: "featureSwitches",
    response: "FeatureSwitches",
    route: featureSwitchesContract.get,
  },
  {
    name: "morningBriefPreference",
    response: "MorningBriefPreference",
    route: morningBriefPreferenceContract.get,
  },
  {
    name: "updateMorningBriefPreference",
    request: "SetMorningBriefPreference",
    response: "MorningBriefPreference",
    route: morningBriefPreferenceContract.update,
  },
  {
    name: "proactiveSuggestionsPreference",
    response: "ProactiveSuggestionsPreference",
    route: proactiveSuggestionsContract.get,
  },
  {
    name: "updateProactiveSuggestionsWithFeed",
    request: "SetProactiveSuggestionsPreference",
    response: "ProactiveSuggestionsPreference",
    route: proactiveSuggestionsContract.updateWithFeed,
  },
  {
    name: "suggestionFeedSources",
    response: "SuggestionFeedSources",
    route: feedContract.sources,
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
    name: "usagePackCredits",
    response: "UsagePackCredits",
    route: billingUsagePackCreditsContract.get,
  },
  {
    name: "activateModelAccount",
    request: "ActivateModelAccountRequest",
    response: "ActivatedModelAccount",
    route: personalModelProviderAccountsByIdContract.activate,
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
    name: "summarizeRunActivity",
    request: "RunActivityRequest",
    response: "RunActivitySummary",
    route: chatThreadActivitySummaryContract.summarize,
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
    name: "prepareChatUpload",
    request: "PrepareChatUploadRequest",
    response: "PrepareChatUploadResult",
    route: uploadsContract.prepare,
  },
  {
    name: "completeChatUpload",
    request: "CompleteChatUploadRequest",
    response: "CompleteChatUploadResult",
    route: uploadsContract.complete,
  },
  {
    name: "completeChatMultipartUpload",
    request: "CompleteChatMultipartUploadRequest",
    response: "CompleteChatMultipartUploadResult",
    route: uploadsContract.completeMultipart,
  },
  {
    name: "abortChatMultipartUpload",
    request: "AbortChatMultipartUploadRequest",
    response: "AbortChatMultipartUploadResult",
    route: uploadsContract.abortMultipart,
  },
  {
    name: "chatUploadedFile",
    response: "ChatUploadedFile",
    route: webFilesContract.fileUrl,
  },
  {
    name: "setThreadModel",
    request: "SetThreadModelRequest",
    response: "Unit",
    route: chatThreadModelSelectionContract.update,
  },
  {
    name: "createProject",
    request: "CreateProjectRequest",
    response: "ProjectRecord",
    route: projectsContract.create,
  },
  {
    name: "projectDetail",
    response: "ProjectRecord",
    route: projectsContract.get,
  },
  {
    name: "renameProject",
    request: "RenameProjectRequest",
    response: "ProjectRecord",
    route: projectsContract.update,
  },
  {
    name: "moveThreadToProject",
    request: "MoveThreadToProjectRequest",
    response: "ProjectMembership",
    route: projectsContract.membership,
  },
  {
    name: "deleteProject",
    request: "DeleteProjectRequest",
    response: "Unit",
    route: projectsContract.delete,
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
  /** Native response projection. Route validation still uses the full schema. */
  readonly readSchema?: ZodType;
  /** Raw transport/cache envelopes retain all JSON members; their consumer owns decoding. */
  readonly representation?: "raw-object";
  /** Reuse precisely this output shape when the same schema appears inside another DTO. */
  readonly reusableOutput?: boolean;
  readonly unionFields?: readonly string[];
  /** Response fields where explicit null and omission have distinct meanings. */
  readonly preserveOptionalNullable?: readonly string[];
}

const connectorTypeBindings: KotlinTypeBinding[] = connectorBindings.flatMap(
  (binding): KotlinTypeBinding[] => {
    const response = {
      name: binding.response,
      schema: binding.route.responses[200],
      direction: "output",
    } as const;
    if (!("request" in binding)) {
      return [response];
    }
    return [
      response,
      {
        name: binding.request,
        schema: binding.route.body,
        direction: "input",
      },
    ];
  },
);

export const kotlinTypeBindings: readonly KotlinTypeBinding[] = [
  ...new Map(
    connectorTypeBindings.map((binding) => {
      return [binding.name, binding] as const;
    }),
  ).values(),
  {
    name: "ArtifactCatalog",
    schema: artifactCatalogContract.list.responses[200],
    direction: "output",
  },
  {
    name: "ArtifactDetail",
    schema: artifactCatalogContract.get.responses[200],
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
    name: "ArtifactVisibility",
    schema: artifactAccessContract.getVisibility.responses[200],
    direction: "output",
  },
  {
    name: "ArtifactVisibilityUpdate",
    schema: artifactAccessContract.updateVisibility.body,
    direction: "input",
  },
  {
    name: "ArtifactSiteUrl",
    schema: hostContract.siteUrl.responses[200],
    direction: "output",
  },
  {
    name: "ConnectedConnectors",
    schema: connectedConnectorsContract.list.responses[200],
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
    name: "ComposerWorkflows",
    schema: workflowsCollectionContract.composer.responses[200],
    direction: "output",
  },
  {
    name: "RecentComposerWorkflows",
    schema: workflowsCollectionContract.recent.responses[200],
    direction: "output",
  },
  {
    name: "RecordComposerWorkflowUseRequest",
    schema: workflowsCollectionContract.recordRecentUse.body,
    direction: "input",
  },
  {
    name: "RecordedComposerWorkflowUse",
    schema: workflowsCollectionContract.recordRecentUse.responses[200],
    direction: "output",
  },
  {
    name: "WorkflowDetail",
    schema: workflowsDetailContract.get.responses[200],
    direction: "output",
  },
  {
    name: "WorkflowRunHistoryEntry",
    schema: workflowRunHistoryEntrySchema,
    direction: "output",
    reusableOutput: true,
  },
  {
    name: "WorkflowRunHistory",
    schema: workflowsDetailContract.runHistory.responses[200],
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
    name: "ChatMessageSearchResponse",
    schema: chatSearchContract.search.responses[200],
    direction: "output",
  },
  {
    name: "CreateProjectRequest",
    schema: projectsContract.create.body,
    direction: "input",
  },
  {
    name: "RenameProjectRequest",
    schema: projectsContract.update.body,
    direction: "input",
  },
  {
    name: "ProjectRecord",
    schema: projectsContract.update.responses[200],
    direction: "output",
  },
  {
    name: "MoveThreadToProjectRequest",
    schema: projectsContract.membership.body,
    direction: "input",
  },
  {
    name: "ProjectMembership",
    schema: projectsContract.membership.responses[200],
    direction: "output",
  },
  {
    name: "DeleteProjectRequest",
    schema: projectsContract.delete.body,
    direction: "input",
  },
  {
    name: "PrepareChatUploadRequest",
    schema: uploadsContract.prepare.body,
    direction: "input",
  },
  {
    name: "PrepareChatUploadResult",
    schema: uploadsContract.prepare.responses[200],
    direction: "output",
  },
  {
    name: "CompleteChatUploadRequest",
    schema: uploadsContract.complete.body,
    direction: "input",
  },
  {
    name: "CompleteChatUploadResult",
    schema: uploadsContract.complete.responses[200],
    direction: "output",
  },
  {
    name: "CompleteChatMultipartUploadRequest",
    schema: uploadsContract.completeMultipart.body,
    direction: "input",
  },
  {
    name: "CompleteChatMultipartUploadResult",
    schema: uploadsContract.completeMultipart.responses[200],
    direction: "output",
  },
  {
    name: "AbortChatMultipartUploadRequest",
    schema: uploadsContract.abortMultipart.body,
    direction: "input",
  },
  {
    name: "AbortChatMultipartUploadResult",
    schema: uploadsContract.abortMultipart.responses[200],
    direction: "output",
  },
  {
    name: "ChatUploadedFile",
    schema: webFilesContract.fileUrl.responses[200],
    direction: "output",
  },
  {
    name: "RenameThreadRequest",
    schema: chatThreadRenameContract.rename.body,
    direction: "input",
  },
  {
    name: "SetThreadModelRequest",
    schema: chatThreadModelSelectionContract.update.body,
    direction: "input",
  },
  {
    name: "ReorderPinnedThreadRequest",
    schema: chatThreadPinOrderContract.reorder.body,
    direction: "input",
  },
  {
    name: "ComposerDraft",
    schema: composerDraftContract.get.responses[200],
    direction: "output",
    representation: "raw-object",
  },
  {
    name: "ThreadDraft",
    schema: chatThreadDraftContract.get.responses[200],
    direction: "output",
    representation: "raw-object",
  },
  {
    name: "SaveWorkspaceDraft",
    schema: composerDraftContract.patch.body,
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
    name: "DefaultModelPreference",
    schema: userModelPreferenceContract.get.responses[200],
    readSchema: userModelPreferenceContract.get.responses[200]
      .pick({ selectedModel: true, serviceTier: true, modelSettings: true })
      // Image catalog changes must remain decodable by the chat-model picker.
      .extend({ selectedImageModel: string().nullish() }),
    direction: "output",
  },
  {
    name: "UpdateDefaultModelPreference",
    schema: userModelPreferenceContract.update.body,
    direction: "input",
  },
  {
    name: "UpdateImageModelPreference",
    schema: imageModelPreferenceSchema,
    direction: "input",
  },
  {
    name: "PaidToolPreferences",
    schema: paidToolsContract.get.responses[200],
    direction: "output",
  },
  {
    name: "UpdatePaidTool",
    schema: paidToolsContract.update.body,
    direction: "input",
  },
  {
    name: "PaidToolUpdate",
    schema: paidToolsContract.update.responses[200],
    direction: "output",
  },
  {
    name: "EmailSubscription",
    schema: emailSubscriptionContract.get.responses[200],
    direction: "output",
  },
  {
    name: "UpdateEmailSubscriptionRequest",
    schema: emailSubscriptionContract.update.body,
    direction: "input",
  },
  {
    name: "EmailSubscriptionUpdate",
    schema: emailSubscriptionContract.update.responses[200],
    direction: "output",
  },
  {
    name: "FeatureSwitches",
    schema: featureSwitchesContract.get.responses[200],
    readSchema: featureSwitchesContract.get.responses[200].pick({
      effectiveSwitches: true,
    }),
    direction: "output",
  },
  {
    name: "MorningBriefPreference",
    schema: morningBriefPreferenceContract.get.responses[200],
    direction: "output",
  },
  {
    name: "SetMorningBriefPreference",
    schema: morningBriefPreferenceContract.update.body,
    direction: "input",
  },
  {
    name: "ProactiveSuggestionsPreference",
    schema: proactiveSuggestionsContract.get.responses[200],
    direction: "output",
  },
  {
    name: "SetProactiveSuggestionsPreference",
    schema: proactiveSuggestionsContract.updateWithFeed.body,
    direction: "input",
  },
  {
    name: "SuggestionFeedSources",
    schema: feedContract.sources.responses[200],
    readSchema: feedContract.sources.responses[200].pick({ suggestions: true }),
    direction: "output",
  },
  {
    name: "RecoverySubscriptions",
    schema: thirdPartySubscriptionsMainContract.list.responses[200],
    direction: "output",
    preserveOptionalNullable: ["subscriptionCredits"],
  },
  {
    name: "RecoveryBilling",
    schema: billingStatusContract.get.responses[200],
    direction: "output",
  },
  {
    name: "UsagePackCredits",
    schema: billingUsagePackCreditsContract.get.responses[200],
    readSchema: billingUsagePackCreditsContract.get.responses[200].pick({
      totalCredits: true,
      purchasedCredits: true,
      bonusCredits: true,
    }),
    direction: "output",
  },
  {
    name: "ActivateModelAccountRequest",
    schema: personalModelProviderAccountsByIdContract.activate.body,
    direction: "input",
  },
  {
    name: "ActivatedModelAccount",
    schema: personalModelProviderAccountsByIdContract.activate.responses[200],
    readSchema:
      personalModelProviderAccountsByIdContract.activate.responses[200].pick({
        id: true,
        isActive: true,
      }),
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
    name: "RunActivityRequest",
    schema: chatThreadActivitySummaryContract.summarize.body,
    direction: "input",
  },
  {
    name: "RunActivitySummary",
    schema: chatThreadActivitySummaryContract.summarize.responses[200],
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
