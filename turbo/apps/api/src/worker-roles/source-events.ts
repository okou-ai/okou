import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { webhooksGithubRoutes } from "../signals/routes/webhooks-github";
import { webhooksGmailRoutes } from "../signals/routes/webhooks-gmail";
import { webhooksGoogleFormsRoutes } from "../signals/routes/webhooks-google-forms";
import { webhooksGoogleCalendarRoutes } from "../signals/routes/webhooks-google-calendar";
import { webhooksGoogleWorkspaceEventsRoutes } from "../signals/routes/webhooks-google-workspace-events";
import { webhooksNotionRoutes } from "../signals/routes/webhooks-notion";
import { webhooksWorkflowAutomationsRoutes } from "../signals/routes/webhooks-workflow-automations";
import { cronRenewGmailWatchesRoutes } from "../signals/routes/cron-renew-gmail-watches";
import { cronRenewGoogleFormsWatchesRoutes } from "../signals/routes/cron-renew-google-forms-watches";
import { cronRenewGoogleCalendarWatchesRoutes } from "../signals/routes/cron-renew-google-calendar-watches";
import { cronRenewGoogleWorkspaceEventSubscriptionsRoutes } from "../signals/routes/cron-renew-google-workspace-event-subscriptions";
import { debugMorningBriefRoutes } from "../signals/routes/debug-morning-brief";
import { wechatReceiverRoutes } from "../signals/routes/wechat-receiver";
import { discordGatewayRoutes } from "../signals/routes/discord-gateway";
import { feishuEventsRoutes } from "../signals/routes/feishu-events";
import { teamsBotRoutes } from "../signals/routes/teams-bot";
import { integrationsAgentPhoneRoutes } from "../signals/routes/integrations-agentphone";
import { integrationsWhatsappRoutes } from "../signals/routes/integrations-whatsapp";
import { integrationsPhoneDownloadFileRoutes } from "../signals/routes/integrations-phone-download-file";
import { integrationsPhoneMessageRoutes } from "../signals/routes/integrations-phone-message";
import { integrationsPhoneUploadCompleteRoutes } from "../signals/routes/integrations-phone-upload-complete";
import { integrationsTelegramRoutes } from "../signals/routes/integrations-telegram";
import { integrationsTelegramMessageRoutes } from "../signals/routes/integrations-telegram-message";
import { integrationsTelegramUploadCompleteRoutes } from "../signals/routes/integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "../signals/routes/integrations-telegram-upload-init";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";

const roleRoutes: readonly RouteEntry[] = [
  ...webhooksGithubRoutes,
  ...webhooksGmailRoutes,
  ...webhooksGoogleFormsRoutes,
  ...webhooksGoogleCalendarRoutes,
  ...webhooksGoogleWorkspaceEventsRoutes,
  ...webhooksNotionRoutes,
  ...webhooksWorkflowAutomationsRoutes,
  ...cronRenewGmailWatchesRoutes,
  ...cronRenewGoogleFormsWatchesRoutes,
  ...cronRenewGoogleCalendarWatchesRoutes,
  ...cronRenewGoogleWorkspaceEventSubscriptionsRoutes,
  ...debugMorningBriefRoutes,
  ...wechatReceiverRoutes,
  ...discordGatewayRoutes,
  ...feishuEventsRoutes,
  ...teamsBotRoutes,
  ...integrationsAgentPhoneRoutes,
  ...integrationsWhatsappRoutes,
  ...integrationsPhoneDownloadFileRoutes,
  ...integrationsPhoneMessageRoutes,
  ...integrationsPhoneUploadCompleteRoutes,
  ...integrationsTelegramRoutes,
  ...integrationsTelegramMessageRoutes,
  ...integrationsTelegramUploadCompleteRoutes,
  ...integrationsTelegramUploadInitRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
