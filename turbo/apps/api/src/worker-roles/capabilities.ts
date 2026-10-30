import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { webhooksAgentFirewallAuthRoutes } from "../signals/routes/webhooks-agent-firewall-auth";
import { builtinConnectorsAutomaticRoutes } from "../signals/routes/connectors-automatic";
import { walletRoutes } from "../signals/routes/wallet";
import { builtinConnectorsSlugCallbackRoutes } from "../signals/routes/connectors-slug-callback";
import { cronConnectorCatalogRoutes } from "../signals/routes/cron-connector-catalog";
import { connectorAgentAccessRoutes } from "../signals/routes/connector-agent-access";
import { connectorCatalogRoutes } from "../signals/routes/connector-catalog";
import { connectedConnectorsRoutes } from "../signals/routes/connected-connectors";
import { connectorCheckRoutes } from "../signals/routes/connector-check";
import { builtinConnectorsExternalCodeRoutes } from "../signals/routes/connectors-external-code";
import { builtinConnectorsOauthDeviceAuthRoutes } from "../signals/routes/connectors-oauth-device-auth";
import { builtinConnectorsRoutes } from "../signals/routes/connectors";
import { connectorAccountRoutes } from "../signals/routes/connector-accounts";
import { customConnectorsRoutes } from "../signals/routes/custom-connectors";
import { mcpConnectorsRoutes } from "../signals/routes/mcp-connectors";
import { meModelProvidersDeleteRoutes } from "../signals/routes/me-model-providers-delete";
import { meModelProviderAccountRoutes } from "../signals/routes/me-model-provider-accounts";
import {
  meModelProvidersListRoutes,
  meThirdPartySubscriptionsListRoutes,
} from "../signals/routes/me-model-providers-list";
import { meModelProvidersResetSubscriptionRoutes } from "../signals/routes/me-model-providers-reset-subscription";
import { meModelProvidersUpsertRoutes } from "../signals/routes/me-model-providers-upsert";
import { feishuBrowserConnectRoutes } from "../signals/routes/feishu-browser-connect";
import { feishuConnectRoutes } from "../signals/routes/feishu-connect";
import { feishuOauthRoutes } from "../signals/routes/feishu-oauth";
import { initializeNoServices$ } from "./initialize-no-services";

const roleRoutes: readonly RouteEntry[] = [
  ...webhooksAgentFirewallAuthRoutes,
  ...builtinConnectorsAutomaticRoutes,
  ...walletRoutes,
  ...builtinConnectorsSlugCallbackRoutes,
  ...cronConnectorCatalogRoutes,
  ...connectorAgentAccessRoutes,
  ...connectorCatalogRoutes,
  ...connectedConnectorsRoutes,
  ...connectorCheckRoutes,
  ...builtinConnectorsExternalCodeRoutes,
  ...builtinConnectorsOauthDeviceAuthRoutes,
  ...builtinConnectorsRoutes,
  ...connectorAccountRoutes,
  ...customConnectorsRoutes,
  ...mcpConnectorsRoutes,
  ...meModelProvidersDeleteRoutes,
  ...meModelProviderAccountRoutes,
  ...meModelProvidersListRoutes,
  ...meThirdPartySubscriptionsListRoutes,
  ...meModelProvidersResetSubscriptionRoutes,
  ...meModelProvidersUpsertRoutes,
  ...feishuBrowserConnectRoutes,
  ...feishuConnectRoutes,
  ...feishuOauthRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: initializeNoServices$,
  });
});
