import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { getStartedRoutes } from "../signals/routes/get-started";
import { webhooksAgentSessionOutputRoutes } from "../signals/routes/webhooks-agent-session-output";
import { cronProjectChatEventSearchRoutes } from "../signals/routes/cron-project-chat-event-search";
import { jobsRoutes } from "../signals/routes/jobs";
import { bankingRoutes } from "../signals/routes/banking";
import { claudeCodeDeviceAuthRoutes } from "../signals/routes/claude-code-device-auth";
import { codexDeviceAuthRoutes } from "../signals/routes/codex-device-auth";
import { atomSubscriptionGrantRoutes } from "../signals/routes/atom-subscription-grants";
import { sshConnectionsRoutes } from "../signals/routes/ssh-connections";
import { vncConnectionsRoutes } from "../signals/routes/vnc-connections";
import { vncAccessRoutes } from "../signals/routes/vnc-access";
import { cloudflareAccessRoutes } from "../signals/routes/cloudflare-access";
import { tailscaleRoutes } from "../signals/routes/tailscale";
import { browserAuthorizationRoutes } from "../signals/routes/browser-authorization";
import { realtimeTokenRoutes } from "../signals/routes/realtime-token";
import { userModelPreferenceRoutes } from "../signals/routes/user-model-preference";
import { slackConnectRoutes } from "../signals/routes/slack-connect";
import { discordOauthRoutes } from "../signals/routes/discord-oauth";
import { discordInteractionsRoutes } from "../signals/routes/discord-interactions";
import { teamsBrowserConnectRoutes } from "../signals/routes/teams-browser-connect";
import { teamsConnectRoutes } from "../signals/routes/teams-connect";
import { teamsOauthRoutes } from "../signals/routes/teams-oauth";
import { integrationsSlackRoutes } from "../signals/routes/integrations-slack";
import { integrationsDiscordRoutes } from "../signals/routes/integrations-discord";
import { integrationsDiscordReadRoutes } from "../signals/routes/integrations-discord-read";
import { integrationsDiscordMessageRoutes } from "../signals/routes/integrations-discord-message";
import { initializeNoServices$ } from "./initialize-no-services";

const roleRoutes: readonly RouteEntry[] = [
  ...getStartedRoutes,
  ...webhooksAgentSessionOutputRoutes,
  ...cronProjectChatEventSearchRoutes,
  ...jobsRoutes,
  ...bankingRoutes,
  ...claudeCodeDeviceAuthRoutes,
  ...codexDeviceAuthRoutes,
  ...atomSubscriptionGrantRoutes,
  ...sshConnectionsRoutes,
  ...vncConnectionsRoutes,
  ...vncAccessRoutes,
  ...cloudflareAccessRoutes,
  ...tailscaleRoutes,
  ...browserAuthorizationRoutes,
  ...realtimeTokenRoutes,
  ...userModelPreferenceRoutes,
  ...slackConnectRoutes,
  ...discordOauthRoutes,
  ...discordInteractionsRoutes,
  ...teamsBrowserConnectRoutes,
  ...teamsConnectRoutes,
  ...teamsOauthRoutes,
  ...integrationsSlackRoutes,
  ...integrationsDiscordRoutes,
  ...integrationsDiscordReadRoutes,
  ...integrationsDiscordMessageRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: initializeNoServices$,
  });
});
