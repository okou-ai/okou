import { agentConnectorAccessContract } from "../contracts/agent-connector-access";
import { agentCustomConnectorsContract } from "../contracts/agent-custom-connectors";
import { agentDraftContract } from "../contracts/agent-draft";
import { agentsByIdContract, agentsMainContract } from "../contracts/agents";
import { artifactReferencesContract } from "../contracts/artifact-references";
import { billingStatusContract } from "../contracts/billing";
import { chatEventsContract } from "../contracts/chat-event-send";
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
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadUsageContract,
  chatThreadsContract,
} from "../contracts/chat-threads";
import { claudeCodeDeviceAuthContract } from "../contracts/claude-code-device-auth";
import { codexDeviceAuthContract } from "../contracts/codex-device-auth";
import { connectedConnectorsContract } from "../contracts/connected-connectors";
import { connectorAccountsContract } from "../contracts/connector-accounts";
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
import { featureSwitchesContract } from "../contracts/feature-switches";
import { iosNotificationsContract } from "../contracts/ios-notifications";
import { iosPushRegistrationsContract } from "../contracts/ios-push-registrations";
import { mcpChatSearchContract } from "../contracts/mcp-chat-search";
import { modelCatalogContract } from "../contracts/model-catalog";
import { orgContract } from "../contracts/org-routes";
import { personalModelProviderAccountsByIdContract } from "../contracts/personal-model-providers";
import { platformRealtimeTokenContract } from "../contracts/realtime";
import { remotesContract } from "../contracts/remotes";
import { runModelsMainContract } from "../contracts/run-models";
import { thirdPartySubscriptionsMainContract } from "../contracts/third-party-subscriptions";
import { uploadsContract } from "../contracts/uploads";
import { userBuiltinConnectorsContract } from "../contracts/user-connectors";
import { userModelPreferenceContract } from "../contracts/user-model-preference";
import { userPermissionGrantsContract } from "../contracts/user-permission-grants";
import { userPreferencesContract } from "../contracts/user-preferences";
import { vncConnectionsContract } from "../contracts/vnc-connections";
import { webFilesContract } from "../contracts/web-files";
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
    id: "ios.artifactReferencesContract.resolve",
    route: artifactReferencesContract.resolve,
  },
  { id: "ios.billingStatusContract.get", route: billingStatusContract.get },
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
  { id: "ios.remotesContract.overview", route: remotesContract.overview },
  { id: "ios.runModelsMainContract.list", route: runModelsMainContract.list },
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
    id: "ios.userPermissionGrantsContract.list",
    route: userPermissionGrantsContract.list,
  },
  { id: "ios.userPreferencesContract.get", route: userPreferencesContract.get },
  { id: "ios.vncConnectionsContract.list", route: vncConnectionsContract.list },
  { id: "ios.webFilesContract.fileUrl", route: webFilesContract.fileUrl },
  {
    id: "ios.workflowsCollectionContract.composer",
    route: workflowsCollectionContract.composer,
  },
  { id: "ios.workflowsDetailContract.get", route: workflowsDetailContract.get },
];

export const iosRouteBindings: readonly RuntimeApiRouteBinding[] =
  iosContracts.map(({ id, route }) => {return {
    id,
    owner: "ios",
    // The global compatibility middleware can answer 426 before route matching.
    route: {
      ...route,
      responses: { ...route.responses, 426: iosUpgradeRequiredSchema },
    },
  }});
