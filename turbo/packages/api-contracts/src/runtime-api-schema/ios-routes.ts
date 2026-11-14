import { chatShareSelectionContract } from "../contracts/chat-share-selection";
import { agentConnectorAccessContract } from "../contracts/agent-connector-access";
import { agentCustomConnectorsContract } from "../contracts/agent-custom-connectors";
import { agentDraftContract } from "../contracts/agent-draft";
import { agentsByIdContract, agentsMainContract } from "../contracts/agents";
import { artifactCatalogContract } from "../contracts/artifact-catalog";
import { artifactReferencesContract } from "../contracts/artifact-references";
import { billingStatusContract } from "../contracts/billing";
import { browserAuthorizationRequestsContract } from "../contracts/browser";
import { chatEventsContract } from "../contracts/chat-event-send";
import { chatConnectorAccessContract } from "../contracts/chat-connector-access";
import { chatRemoteAccessContract } from "../contracts/chat-remote-access";
import { chatThreadActivitySummaryContract } from "../contracts/chat-thread-activity-summary";
import {
  chatThreadArchiveContract,
  chatThreadArtifactsContract,
  chatThreadByIdContract,
  chatThreadComputerUseHostContract,
  chatThreadConnectorSelectionContract,
  chatThreadDraftContract,
  chatThreadEventsContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadMarkUnreadContract,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadMuteContract,
  chatThreadPinContract,
  chatThreadPinOrderContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadUsageContract,
  chatThreadsContract,
} from "../contracts/chat-threads";
import { claudeCodeDeviceAuthContract } from "../contracts/claude-code-device-auth";
import { codexDeviceAuthContract } from "../contracts/codex-device-auth";
import { connectedConnectorsContract } from "../contracts/connected-connectors";
import { computerUseAuthorizationRequestsContract } from "../contracts/computer-use";
import { connectorAccountsContract } from "../contracts/connector-accounts";
import { connectorPermissionsContract } from "../contracts/connector-permissions";
import { connectorCatalogContract } from "../contracts/connector-catalog";
import {
  builtinConnectorAutomaticContract,
  builtinConnectorExternalCodeSessionContract,
  builtinConnectorManualGrantContract,
  builtinConnectorNoAuthGrantContract,
  builtinConnectorOauthDeviceAuthSessionContract,
  builtinConnectorOauthStartContract,
  builtinConnectorOpenIdStartContract,
} from "../contracts/connectors";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "../contracts/custom-connectors";
import { desktopShellAuthorizationContract } from "../contracts/desktop-shell-authorization";
import { mailContract } from "../contracts/mail";
import { sharedThreadVisibilityContract } from "../contracts/shared-thread-visibility";
import { sshAuthorizationContract } from "../contracts/ssh-authorization";
import { featureSwitchesContract } from "../contracts/feature-switches";
import { hostContract } from "../contracts/host";
import { iosNotificationsContract } from "../contracts/ios-notifications";
import { instructionsContract } from "../contracts/instructions";
import { iosPushRegistrationsContract } from "../contracts/ios-push-registrations";
import { mcpChatSearchContract } from "../contracts/mcp-chat-search";
import { modelCatalogContract } from "../contracts/model-catalog";
import { orgContract } from "../contracts/org-routes";
import { personalModelProviderAccountsByIdContract } from "../contracts/personal-model-providers";
import { platformRealtimeTokenContract } from "../contracts/realtime";
import { projectsContract } from "../contracts/projects";
import { remotesContract } from "../contracts/remotes";
import { runModelsMainContract } from "../contracts/run-models";
import { runConnectorAccountsContract } from "../contracts/run-connector-accounts";
import { thirdPartySubscriptionsMainContract } from "../contracts/third-party-subscriptions";
import { uploadsContract } from "../contracts/uploads";
import { userBuiltinConnectorsContract } from "../contracts/user-connectors";
import { userModelPreferenceContract } from "../contracts/user-model-preference";
import { userPermissionGrantsContract } from "../contracts/user-permission-grants";
import { userPreferencesContract } from "../contracts/user-preferences";
import { vncConnectionsContract } from "../contracts/vnc-connections";
import { webFilesContract } from "../contracts/web-files";
import { voiceIoQuotaContract } from "../contracts/voice-io-quota";
import { voiceIoTranscribeContract } from "../contracts/voice-io-transcribe";
import { voiceIoPolishSegmentsContract } from "../contracts/voice-io-polish";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "../contracts/workflows";
import { iosUpgradeRequiredSchema } from "../contracts/ios-client-compatibility";
import type { RuntimeApiRouteBinding, RuntimeApiRouteLike } from "./routes";

/** iOS API consumption inventory, including dynamic chat actions and connector auth.
 * Add route references when adding calls in ios/Packages/ChatData or the App.
 * Wire DTO generation is independent; this gate protects installed Codable readers.
 */
const iosContracts: readonly {
  readonly id: string;
  readonly route: RuntimeApiRouteLike & {
    readonly responses: Readonly<Record<number, unknown>>;
  };
}[] = [
  { id: "ios.instructionsContract.get", route: instructionsContract.get },
  { id: "ios.instructionsContract.update", route: instructionsContract.update },
  {
    id: "ios.agentConnectorAccessContract.agent",
    route: agentConnectorAccessContract.agent,
  },
  {
    id: "ios.agentCustomConnectorsContract.get",
    route: agentCustomConnectorsContract.get,
  },
  {
    id: "ios.agentCustomConnectorsContract.update",
    route: agentCustomConnectorsContract.update,
  },
  { id: "ios.agentDraftContract.get", route: agentDraftContract.get },
  { id: "ios.agentDraftContract.patch", route: agentDraftContract.patch },
  { id: "ios.agentsByIdContract.get", route: agentsByIdContract.get },
  { id: "ios.agentsMainContract.list", route: agentsMainContract.list },
  {
    id: "ios.artifactCatalogContract.list",
    route: artifactCatalogContract.list,
  },
  {
    id: "ios.artifactReferencesContract.resolve",
    route: artifactReferencesContract.resolve,
  },
  { id: "ios.billingStatusContract.get", route: billingStatusContract.get },
  {
    id: "ios.browserAuthorizationRequestsContract.get",
    route: browserAuthorizationRequestsContract.get,
  },
  {
    id: "ios.browserAuthorizationRequestsContract.apply",
    route: browserAuthorizationRequestsContract.apply,
  },
  {
    id: "ios.computerUseAuthorizationRequestsContract.get",
    route: computerUseAuthorizationRequestsContract.get,
  },
  {
    id: "ios.computerUseAuthorizationRequestsContract.apply",
    route: computerUseAuthorizationRequestsContract.apply,
  },
  {
    id: "ios.chatConnectorAccessContract.accountDefaults",
    route: chatConnectorAccessContract.accountDefaults,
  },
  {
    id: "ios.chatConnectorAccessContract.updateAccountDefault",
    route: chatConnectorAccessContract.updateAccountDefault,
  },
  {
    id: "ios.chatConnectorAccessContract.getThread",
    route: chatConnectorAccessContract.getThread,
  },
  {
    id: "ios.chatConnectorAccessContract.setThreadOverride",
    route: chatConnectorAccessContract.setThreadOverride,
  },
  {
    id: "ios.chatConnectorAccessContract.setThreadCurrent",
    route: chatConnectorAccessContract.setThreadCurrent,
  },
  { id: "ios.chatEventsContract.send", route: chatEventsContract.send },
  {
    id: "ios.chatRemoteAccessContract.clearThreadOverride",
    route: chatRemoteAccessContract.clearThreadOverride,
  },
  {
    id: "ios.chatRemoteAccessContract.listThreadAccess",
    route: chatRemoteAccessContract.listThreadAccess,
  },
  {
    id: "ios.chatRemoteAccessContract.setThreadOverride",
    route: chatRemoteAccessContract.setThreadOverride,
  },
  {
    id: "ios.chatThreadActivitySummaryContract.summarize",
    route: chatThreadActivitySummaryContract.summarize,
  },
  {
    id: "ios.chatThreadArchiveContract.archive",
    route: chatThreadArchiveContract.archive,
  },
  {
    id: "ios.chatThreadArchiveContract.unarchive",
    route: chatThreadArchiveContract.unarchive,
  },
  {
    id: "ios.chatThreadArtifactsContract.list",
    route: chatThreadArtifactsContract.list,
  },
  { id: "ios.chatThreadByIdContract.get", route: chatThreadByIdContract.get },
  {
    id: "ios.chatThreadByIdContract.patch",
    route: chatThreadByIdContract.patch,
  },
  {
    id: "ios.chatThreadComputerUseHostContract.update",
    route: chatThreadComputerUseHostContract.update,
  },
  {
    id: "ios.chatThreadConnectorSelectionContract.get",
    route: chatThreadConnectorSelectionContract.get,
  },
  {
    id: "ios.chatThreadConnectorSelectionContract.update",
    route: chatThreadConnectorSelectionContract.update,
  },
  {
    id: "ios.chatThreadConnectorSelectionContract.clear",
    route: chatThreadConnectorSelectionContract.clear,
  },
  { id: "ios.chatThreadDraftContract.get", route: chatThreadDraftContract.get },
  {
    id: "ios.chatThreadEventsContract.catchUp",
    route: chatThreadEventsContract.catchUp,
  },
  {
    id: "ios.chatThreadEventsContract.rows",
    route: chatThreadEventsContract.rows,
  },
  {
    id: "ios.chatThreadEventsContract.snapshot",
    route: chatThreadEventsContract.snapshot,
  },
  {
    id: "ios.chatThreadMarkAgentReadContract.markAgentRead",
    route: chatThreadMarkAgentReadContract.markAgentRead,
  },
  {
    id: "ios.chatThreadMarkReadContract.markRead",
    route: chatThreadMarkReadContract.markRead,
  },
  {
    id: "ios.chatThreadMarkUnreadContract.markUnread",
    route: chatThreadMarkUnreadContract.markUnread,
  },
  {
    id: "ios.chatThreadMetadataContract.get",
    route: chatThreadMetadataContract.get,
  },
  {
    id: "ios.chatThreadModelSelectionContract.update",
    route: chatThreadModelSelectionContract.update,
  },
  { id: "ios.chatThreadMuteContract.mute", route: chatThreadMuteContract.mute },
  {
    id: "ios.chatThreadMuteContract.unmute",
    route: chatThreadMuteContract.unmute,
  },
  { id: "ios.chatThreadPinContract.pin", route: chatThreadPinContract.pin },
  {
    id: "ios.chatThreadPinOrderContract.reorder",
    route: chatThreadPinOrderContract.reorder,
  },
  {
    id: "ios.chatThreadRenameContract.rename",
    route: chatThreadRenameContract.rename,
  },
  {
    id: "ios.chatThreadUnpinContract.unpin",
    route: chatThreadUnpinContract.unpin,
  },
  {
    id: "ios.chatThreadUsageContract.read",
    route: chatThreadUsageContract.read,
  },
  { id: "ios.chatThreadsContract.create", route: chatThreadsContract.create },
  { id: "ios.chatThreadsContract.drafts", route: chatThreadsContract.drafts },
  { id: "ios.chatThreadsContract.events", route: chatThreadsContract.events },
  {
    id: "ios.chatThreadsContract.indicators",
    route: chatThreadsContract.indicators,
  },
  {
    id: "ios.chatThreadsContract.snapshot",
    route: chatThreadsContract.snapshot,
  },
  {
    id: "ios.claudeCodeDeviceAuthContract.cancel",
    route: claudeCodeDeviceAuthContract.cancel,
  },
  {
    id: "ios.claudeCodeDeviceAuthContract.complete",
    route: claudeCodeDeviceAuthContract.complete,
  },
  {
    id: "ios.claudeCodeDeviceAuthContract.start",
    route: claudeCodeDeviceAuthContract.start,
  },
  {
    id: "ios.codexDeviceAuthContract.cancel",
    route: codexDeviceAuthContract.cancel,
  },
  {
    id: "ios.codexDeviceAuthContract.complete",
    route: codexDeviceAuthContract.complete,
  },
  {
    id: "ios.codexDeviceAuthContract.start",
    route: codexDeviceAuthContract.start,
  },
  {
    id: "ios.connectedConnectorsContract.list",
    route: connectedConnectorsContract.list,
  },
  {
    id: "ios.connectorAccountsContract.connection",
    route: connectorAccountsContract.connection,
  },
  {
    id: "ios.connectorAccountsContract.connections",
    route: connectorAccountsContract.connections,
  },
  {
    id: "ios.connectorAccountsContract.oauthCompletion",
    route: connectorAccountsContract.oauthCompletion,
  },
  {
    id: "ios.connectorAccountsContract.setDefault",
    route: connectorAccountsContract.setDefault,
  },
  {
    id: "ios.connectorPermissionsContract.get",
    route: connectorPermissionsContract.get,
  },
  {
    id: "ios.connectorPermissionsContract.apply",
    route: connectorPermissionsContract.apply,
  },
  {
    id: "ios.connectorCatalogContract.discovery",
    route: connectorCatalogContract.discovery,
  },
  {
    id: "ios.connectorCatalogContract.get",
    route: connectorCatalogContract.get,
  },
  {
    id: "ios.connectorCatalogContract.permissions",
    route: connectorCatalogContract.permissions,
  },
  {
    id: "ios.builtinConnectorAutomaticContract.start",
    route: builtinConnectorAutomaticContract.start,
  },
  {
    id: "ios.builtinConnectorExternalCodeSessionContract.complete",
    route: builtinConnectorExternalCodeSessionContract.complete,
  },
  {
    id: "ios.builtinConnectorExternalCodeSessionContract.create",
    route: builtinConnectorExternalCodeSessionContract.create,
  },
  {
    id: "ios.builtinConnectorManualGrantContract.connect",
    route: builtinConnectorManualGrantContract.connect,
  },
  {
    id: "ios.builtinConnectorNoAuthGrantContract.connect",
    route: builtinConnectorNoAuthGrantContract.connect,
  },
  {
    id: "ios.builtinConnectorOauthDeviceAuthSessionContract.create",
    route: builtinConnectorOauthDeviceAuthSessionContract.create,
  },
  {
    id: "ios.builtinConnectorOauthDeviceAuthSessionContract.poll",
    route: builtinConnectorOauthDeviceAuthSessionContract.poll,
  },
  {
    id: "ios.builtinConnectorOauthStartContract.start",
    route: builtinConnectorOauthStartContract.start,
  },
  {
    id: "ios.builtinConnectorOpenIdStartContract.start",
    route: builtinConnectorOpenIdStartContract.start,
  },
  {
    id: "ios.customConnectorByIdContract.get",
    route: customConnectorByIdContract.get,
  },
  {
    id: "ios.customConnectorOAuth2Contract.start",
    route: customConnectorOAuth2Contract.start,
  },
  {
    id: "ios.customConnectorValuesContract.set",
    route: customConnectorValuesContract.set,
  },
  {
    id: "ios.customConnectorsContract.list",
    route: customConnectorsContract.list,
  },
  { id: "ios.featureSwitchesContract.get", route: featureSwitchesContract.get },
  { id: "ios.hostContract.sitePreview", route: hostContract.sitePreview },
  {
    id: "ios.iosNotificationsContract.prefetch",
    route: iosNotificationsContract.prefetch,
  },
  {
    id: "ios.iosNotificationsContract.reconcile",
    route: iosNotificationsContract.reconcile,
  },
  {
    id: "ios.iosPushRegistrationsContract.register",
    route: iosPushRegistrationsContract.register,
  },
  {
    id: "ios.iosPushRegistrationsContract.unregister",
    route: iosPushRegistrationsContract.unregister,
  },
  {
    id: "ios.mcpChatSearchContract.search",
    route: mcpChatSearchContract.search,
  },
  { id: "ios.modelCatalogContract.get", route: modelCatalogContract.get },
  { id: "ios.orgContract.get", route: orgContract.get },
  {
    id: "ios.personalModelProviderAccountsByIdContract.activate",
    route: personalModelProviderAccountsByIdContract.activate,
  },
  {
    id: "ios.personalModelProviderAccountsByIdContract.delete",
    route: personalModelProviderAccountsByIdContract.delete,
  },
  {
    id: "ios.personalModelProviderAccountsByIdContract.resetSubscriptionUsage",
    route: personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
  },
  {
    id: "ios.platformRealtimeTokenContract.create",
    route: platformRealtimeTokenContract.create,
  },
  { id: "ios.projectsContract.list", route: projectsContract.list },
  { id: "ios.projectsContract.snapshot", route: projectsContract.snapshot },
  { id: "ios.projectsContract.events", route: projectsContract.events },
  { id: "ios.projectsContract.create", route: projectsContract.create },
  { id: "ios.projectsContract.update", route: projectsContract.update },
  { id: "ios.projectsContract.delete", route: projectsContract.delete },
  { id: "ios.projectsContract.membership", route: projectsContract.membership },
  { id: "ios.remotesContract.overview", route: remotesContract.overview },
  { id: "ios.runModelsMainContract.list", route: runModelsMainContract.list },
  {
    id: "ios.runConnectorAccountsContract.approve",
    route: runConnectorAccountsContract.approve,
  },
  {
    id: "ios.thirdPartySubscriptionsMainContract.list",
    route: thirdPartySubscriptionsMainContract.list,
  },
  {
    id: "ios.uploadsContract.abortMultipart",
    route: uploadsContract.abortMultipart,
  },
  { id: "ios.uploadsContract.complete", route: uploadsContract.complete },
  {
    id: "ios.uploadsContract.completeMultipart",
    route: uploadsContract.completeMultipart,
  },
  { id: "ios.uploadsContract.prepare", route: uploadsContract.prepare },
  {
    id: "ios.userBuiltinConnectorsContract.get",
    route: userBuiltinConnectorsContract.get,
  },
  {
    id: "ios.userBuiltinConnectorsContract.update",
    route: userBuiltinConnectorsContract.update,
  },
  {
    id: "ios.userModelPreferenceContract.get",
    route: userModelPreferenceContract.get,
  },
  {
    id: "ios.userModelPreferenceContract.update",
    route: userModelPreferenceContract.update,
  },
  {
    id: "ios.userPermissionGrantsContract.apply",
    route: userPermissionGrantsContract.apply,
  },
  {
    id: "ios.userPermissionGrantsContract.applyBatch",
    route: userPermissionGrantsContract.applyBatch,
  },
  {
    id: "ios.userPermissionGrantsContract.list",
    route: userPermissionGrantsContract.list,
  },
  { id: "ios.userPreferencesContract.get", route: userPreferencesContract.get },
  { id: "ios.vncConnectionsContract.list", route: vncConnectionsContract.list },
  { id: "ios.webFilesContract.fileUrl", route: webFilesContract.fileUrl },
  { id: "ios.voiceIoQuotaContract.get", route: voiceIoQuotaContract.get },
  {
    id: "ios.voiceIoTranscribeContract.segment",
    route: voiceIoTranscribeContract.segment,
  },
  {
    id: "ios.voiceIoPolishSegmentsContract.post",
    route: voiceIoPolishSegmentsContract.post,
  },
  {
    id: "ios.workflowsCollectionContract.list",
    route: workflowsCollectionContract.list,
  },
  {
    id: "ios.workflowsCollectionContract.composer",
    route: workflowsCollectionContract.composer,
  },
  { id: "ios.workflowsDetailContract.get", route: workflowsDetailContract.get },
  {
    id: "ios.sshAuthorizationContract.get",
    route: sshAuthorizationContract.get,
  },
  {
    id: "ios.sshAuthorizationContract.approve",
    route: sshAuthorizationContract.approve,
  },
  {
    id: "ios.sshAuthorizationContract.revoke",
    route: sshAuthorizationContract.revoke,
  },
  {
    id: "ios.desktopShellAuthorizationContract.get",
    route: desktopShellAuthorizationContract.get,
  },
  {
    id: "ios.desktopShellAuthorizationContract.approve",
    route: desktopShellAuthorizationContract.approve,
  },
  {
    id: "ios.desktopShellAuthorizationContract.deny",
    route: desktopShellAuthorizationContract.deny,
  },
  {
    id: "ios.desktopShellAuthorizationContract.revoke",
    route: desktopShellAuthorizationContract.revoke,
  },
  { id: "ios.mailContract.getDraft", route: mailContract.getDraft },
  { id: "ios.mailContract.sendDraft", route: mailContract.sendDraft },
  { id: "ios.mailContract.deleteDraft", route: mailContract.deleteDraft },
  // Keep the published selection routes registered for installed iOS clients.
  {
    id: "ios.chatShareSelectionContract.get",
    route: chatShareSelectionContract.get,
  },
  {
    id: "ios.chatShareSelectionContract.create",
    route: chatShareSelectionContract.create,
  },
  {
    id: "ios.sharedThreadVisibilityContract.get",
    route: sharedThreadVisibilityContract.get,
  },
  {
    id: "ios.sharedThreadVisibilityContract.update",
    route: sharedThreadVisibilityContract.update,
  },
  {
    id: "ios.sharedThreadVisibilityContract.create",
    route: sharedThreadVisibilityContract.create,
  },
];

export const iosRouteBindings: readonly RuntimeApiRouteBinding[] =
  iosContracts.map(({ id, route }) => {
    return {
      id,
      owner: "ios",
      // The global compatibility middleware can answer 426 before route matching.
      route: {
        ...route,
        responses: { ...route.responses, 426: iosUpgradeRequiredSchema },
      },
    };
  });
