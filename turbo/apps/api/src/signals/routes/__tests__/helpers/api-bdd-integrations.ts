import { mockClerkUsers } from "./clerk-users";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  integrationsTelegramBotListContract,
  integrationsTelegramMessageContract,
  integrationsTelegramUploadInitContract,
  integrationsGithubUploadCompleteContract,
  integrationsGithubUploadInitContract,
  integrationsPhoneDownloadFileContract,
  integrationsPhoneMessageContract,
  integrationsPhoneUploadCompleteContract,
  integrationsPhoneUploadInitContract,
  integrationsSlackMessageContract,
  integrationsSlackUploadCompleteContract,
  integrationsSlackUploadInitContract,
  integrationsTelegramUploadCompleteContract,
  type GithubUploadCompleteBody,
  type GithubUploadInitBody,
  type PhoneUploadCompleteBody,
  type PhoneUploadInitBody,
  type SendSlackMessageBody,
  type SendTelegramMessageBody,
  type SendPhoneMessageBody,
  type SlackUploadCompleteBody,
  type SlackUploadInitBody,
  type TelegramUploadInitBody,
  type TelegramUploadCompleteBody,
} from "@okouai/api-contracts/contracts/integrations";
import { integrationsGithubContract } from "@okouai/api-contracts/contracts/integrations-github";
import {
  githubOauthContract,
  type GithubAppSetupCallbackQuery,
  type GithubOauthConnectQuery,
  type GithubOauthInstallQuery,
} from "@okouai/api-contracts/contracts/github-oauth";
import type { SupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { testSlackStateContract } from "@okouai/api-contracts/contracts/test-slack-state";
import {
  integrationsAgentPhoneContract,
  type AgentPhoneConnectRequest,
} from "@okouai/api-contracts/contracts/integrations-agentphone";
import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { integrationsTelegramContract } from "@okouai/api-contracts/contracts/integrations-telegram";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import { modelProvidersMainContract } from "@okouai/api-contracts/contracts/model-provider-routes";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { slackChannelsContract } from "@okouai/api-contracts/contracts/slack-channels";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { HttpResponse, http } from "msw";
import { createApp } from "../../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import type { ApiTestUser, ApiTestUserOptions } from "./api-bdd";
import { sessionHistoryBlobBodyForKey } from "./api-bdd-session-history";
import { createRouteMocks } from "./route-test";
import { githubOauthRoutes } from "../../github-oauth";
import { integrationsGithubRoutes } from "../../integrations-github";
import { testSlackStateRoutes } from "../../test-slack-state";
import { featureSwitchesRoutes } from "../../feature-switches";
import { integrationsAgentPhoneRoutes } from "../../integrations-agentphone";
import { integrationsGithubUploadCompleteRoutes } from "../../integrations-github-upload-complete";
import { integrationsGithubUploadInitRoutes } from "../../integrations-github-upload-init";
import { integrationsPhoneDownloadFileRoutes } from "../../integrations-phone-download-file";
import { integrationsPhoneMessageRoutes } from "../../integrations-phone-message";
import { integrationsPhoneUploadCompleteRoutes } from "../../integrations-phone-upload-complete";
import { integrationsPhoneUploadInitRoutes } from "../../integrations-phone-upload-init";
import { integrationsSlackRoutes } from "../../integrations-slack";
import { integrationsSlackMessageRoutes } from "../../integrations-slack-message";
import { integrationsSlackUploadCompleteRoutes } from "../../integrations-slack-upload-complete";
import { integrationsSlackUploadInitRoutes } from "../../integrations-slack-upload-init";
import { integrationsTelegramRoutes } from "../../integrations-telegram";
import { integrationsTelegramMessageRoutes } from "../../integrations-telegram-message";
import { integrationsTelegramUploadCompleteRoutes } from "../../integrations-telegram-upload-complete";
import { integrationsTelegramUploadInitRoutes } from "../../integrations-telegram-upload-init";
import { modelPoliciesRoutes } from "../../model-policies";
import { modelProvidersRoutes } from "../../model-providers";
import { slackChannelsRoutes } from "../../slack-channels";
import { slackCommandsRoutes } from "../../slack-commands";
import { slackConnectRoutes } from "../../slack-connect";
import { slackEventsRoutes } from "../../slack-events";
import { slackInteractiveRoutes } from "../../slack-interactive";
import { slackOauthRoutes } from "../../slack-oauth";
import { userModelPreferenceRoutes } from "../../user-model-preference";

const TEST_APP_ROUTES = Object.freeze([
  ...githubOauthRoutes,
  ...integrationsGithubRoutes,
  ...testSlackStateRoutes,
  ...featureSwitchesRoutes,
  ...integrationsAgentPhoneRoutes,
  ...integrationsGithubUploadCompleteRoutes,
  ...integrationsGithubUploadInitRoutes,
  ...integrationsPhoneDownloadFileRoutes,
  ...integrationsPhoneMessageRoutes,
  ...integrationsPhoneUploadCompleteRoutes,
  ...integrationsPhoneUploadInitRoutes,
  ...integrationsSlackMessageRoutes,
  ...integrationsSlackUploadCompleteRoutes,
  ...integrationsSlackUploadInitRoutes,
  ...integrationsSlackRoutes,
  ...integrationsTelegramMessageRoutes,
  ...integrationsTelegramUploadCompleteRoutes,
  ...integrationsTelegramUploadInitRoutes,
  ...integrationsTelegramRoutes,
  ...modelPoliciesRoutes,
  ...modelProvidersRoutes,
  ...slackChannelsRoutes,
  ...slackCommandsRoutes,
  ...slackConnectRoutes,
  ...slackEventsRoutes,
  ...slackInteractiveRoutes,
  ...slackOauthRoutes,
  ...userModelPreferenceRoutes,
]);

interface AuthHeaders {
  readonly authorization?: string;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

interface IntegrationUserOptions extends ApiTestUserOptions {
  readonly email?: string;
}

interface TelegramAuthPayload {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly photo_url?: string;
  readonly auth_date: number;
  readonly hash: string;
}

interface TelegramConnectSignaturePayload {
  readonly telegramUserId: string;
  readonly telegramUsername?: string;
  readonly telegramDisplayName?: string;
  readonly timestamp: number;
  readonly signature: string;
}

interface TelegramLinkBody {
  readonly telegramBotId: string;
  readonly telegramAuth?: TelegramAuthPayload;
  readonly connectSignature?: TelegramConnectSignaturePayload;
}

interface TelegramRegisterBody {
  readonly botToken: string;
  readonly defaultAgentId?: string;
  readonly reinstallBotId?: string;
}

interface TelegramSetupStatusBody {
  readonly botToken: string;
  readonly origin?: string;
}

interface TelegramUpdateBody {
  readonly defaultAgentId?: string;
  readonly selectedAgentId?: string | null;
}

interface SlackConnectBody {
  readonly workspaceId: string;
  readonly slackUserId: string;
  readonly channelId?: string;
  readonly threadTs?: string;
}

const AGENTPHONE_API_BASE_URL = "https://api.agentphone.test";
const AGENTPHONE_AGENT_ID = "agt-bdd-agentphone";
const AGENTPHONE_PHONE_NUMBER = "+19039853128";
const SLACK_SIGNING_SECRET = "slack-bdd-signing-secret";
const SLACK_APP_BOT_SCOPES = "chat:write,im:write,users:read";

export function agentPhoneBddWebhookSecret(): string {
  return ["agentphone", "bdd", "webhook", "secret"].join("-");
}
const SLACK_APP_INTERNAL_API_URL = "https://api.okou.test";

type SlackSignatureHeaders = Record<string, string>;
type SlackIngressPath =
  | "/api/webhooks/slack/commands"
  | "/api/webhooks/slack/events"
  | "/api/webhooks/slack/interactive";
type SlackIngressStatus = 200 | 400 | 401 | 500 | 503;
type SlackDownloadStatus = 200 | 400 | 401 | 404 | 413 | 502;
type AgentPhoneWebhookStatus = 200 | 400 | 401 | 404;
type TelegramWebhookStatus = 200 | 400 | 401 | 404;

type SlackIngressResponse = {
  readonly [S in SlackIngressStatus]: {
    readonly status: S;
    readonly body: unknown;
    readonly headers: Headers;
  };
}[SlackIngressStatus];

interface SlackDownloadResponse {
  readonly status: SlackDownloadStatus;
  readonly body: unknown;
  readonly headers: Headers;
}

interface AgentPhoneWebhookResponse {
  readonly status: AgentPhoneWebhookStatus;
  readonly body: unknown;
  readonly headers: Headers;
}

interface TelegramWebhookResponse {
  readonly status: TelegramWebhookStatus;
  readonly body: unknown;
  readonly headers: Headers;
}

interface ForwardedInternalCallback {
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
}

interface SlackAppInstallOptions {
  readonly teamId?: string;
  readonly installerSlackUserId?: string;
}

interface SlackAppInstallation {
  readonly teamId: string;
  readonly botUserId: string;
  readonly installerSlackUserId: string;
}

interface SlackCommandRequest {
  readonly teamId: string;
  readonly userId: string;
  readonly text: string;
  readonly channelId?: string;
  readonly triggerId?: string;
}

interface SlackPickerSubmissionArgs {
  readonly workspaceId: string;
  readonly slackUserId: string;
  readonly selectedValue: string;
  readonly channelId?: string;
}

function signedSlackHeaders(
  body: string,
  timestampOverride?: string,
): SlackSignatureHeaders {
  const timestamp = timestampOverride ?? String(Math.floor(now() / 1000));
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", SLACK_SIGNING_SECRET)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`,
  };
}

function slackOauthStateFromRedirect(location: string | null): string {
  const state = location ? new URL(location).searchParams.get("state") : null;
  if (!state) {
    throw new Error("Expected a signed Slack OAuth state in the redirect");
  }
  return state;
}

function slackCommandRequestBody(args: SlackCommandRequest): string {
  return new URLSearchParams({
    token: "bdd-token",
    team_id: args.teamId,
    team_domain: "bdd-workspace",
    channel_id: args.channelId ?? "C_BDD_CMD",
    channel_name: "general",
    user_id: args.userId,
    user_name: "bdduser",
    command: "/okou",
    text: args.text,
    response_url: "https://hooks.slack.com/commands/bdd/response",
    trigger_id: args.triggerId ?? "trigger-bdd",
    api_app_id: "A-bdd",
  }).toString();
}

function slackPickerSubmission(
  callbackId: string,
  blockId: string,
  actionId: string,
  args: SlackPickerSubmissionArgs,
): Record<string, unknown> {
  return {
    type: "view_submission",
    user: {
      id: args.slackUserId,
      username: "bdduser",
      team_id: args.workspaceId,
    },
    team: { id: args.workspaceId, domain: "bdd" },
    view: {
      callback_id: callbackId,
      ...(args.channelId === undefined
        ? {}
        : {
            private_metadata: JSON.stringify({ channelId: args.channelId }),
          }),
      state: {
        values: {
          [blockId]: {
            [actionId]: { selected_option: { value: args.selectedValue } },
          },
        },
      },
    },
  };
}

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Integration",
  };
}

function createUser(options: IntegrationUserOptions = {}): ApiTestUser {
  const userId = options.userId ?? `user_${randomUUID()}`;
  const orgId =
    options.orgId === undefined ? `org_${randomUUID()}` : options.orgId;
  return {
    userId,
    orgId,
    orgRole:
      options.orgRole ?? (options.orgId === null ? undefined : "org:admin"),
    email: options.email ?? `${userId}@example.test`,
  };
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function extraHeaders(headers: AuthHeaders): Record<string, string> {
  return headers.authorization ? { authorization: headers.authorization } : {};
}

function configureClerkDirectory(
  context: TestContext,
  actor: ApiTestUser | null,
): void {
  if (!actor) {
    mockClerkUsers(context, []);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });
    return;
  }

  mockClerkUsers(context, [clerkUserProfile(actor)]);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: actor.orgId
      ? [
          {
            organization: { id: actor.orgId },
            role: actor.orgRole ?? "org:admin",
            createdAt: 1,
          },
        ]
      : [],
  });
}

function authenticate(
  context: TestContext,
  routeMocks: ReturnType<typeof createRouteMocks>,
  actor: ApiTestUser | null,
): AuthHeaders {
  configureClerkDirectory(context, actor);

  if (!actor) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }

  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return authHeaders(actor);
}

async function parseRawResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
}

async function requestRawSlackIngress(
  context: TestContext,
  path: SlackIngressPath,
  body: string,
  headers: SlackSignatureHeaders,
): Promise<SlackIngressResponse> {
  const origin = "https://api.okou.ai";
  const contentType = path.endsWith("/events")
    ? "application/json"
    : "application/x-www-form-urlencoded";
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...headers,
    },
    body,
  });
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 500: {
      return { status: 500, ...result };
    }
    case 503: {
      return { status: 503, ...result };
    }
    default: {
      throw new Error(`Unexpected Slack ingress status ${response.status}`);
    }
  }
}

async function requestRawAgentPhoneWebhook(
  context: TestContext,
  body: string,
  headers: {
    readonly "x-webhook-signature"?: string;
    readonly "x-webhook-timestamp"?: string;
    readonly "x-webhook-event"?: string;
    readonly "x-webhook-id"?: string;
  },
): Promise<AgentPhoneWebhookResponse> {
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(`${"https://api.okou.ai"}/api/agentphone/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 404: {
      return { status: 404, ...result };
    }
    default: {
      throw new Error(
        `Unexpected AgentPhone webhook status ${response.status}`,
      );
    }
  }
}

async function requestRawTelegramWebhook(
  context: TestContext,
  telegramBotId: string,
  body: string,
  headers: { readonly "x-telegram-bot-api-secret-token"?: string },
): Promise<TelegramWebhookResponse> {
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(`https://api.okou.ai/api/telegram/webhook/${telegramBotId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 404: {
      return { status: 404, ...result };
    }
    default: {
      throw new Error(`Unexpected Telegram webhook status ${response.status}`);
    }
  }
}

async function requestRawSlackDownloadFile(
  context: TestContext,
  headers: AuthHeaders,
  fileId: string | undefined,
): Promise<SlackDownloadResponse> {
  const search = new URLSearchParams();
  if (fileId !== undefined) {
    search.set("file_id", fileId);
  }
  const query = search.toString();
  const response = await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request(
    `/api/integrations/slack/download-file${query ? `?${query}` : ""}`,
    {
      method: "GET",
      headers: extraHeaders(headers),
    },
  );
  const result = {
    body: await parseRawResponseBody(response),
    headers: response.headers,
  };

  switch (response.status) {
    case 200: {
      return { status: 200, ...result };
    }
    case 400: {
      return { status: 400, ...result };
    }
    case 401: {
      return { status: 401, ...result };
    }
    case 404: {
      return { status: 404, ...result };
    }
    case 413: {
      return { status: 413, ...result };
    }
    case 502: {
      return { status: 502, ...result };
    }
    default: {
      throw new Error(
        `Unexpected Slack download-file status ${response.status}`,
      );
    }
  }
}

export function createBddIntegrationApi(context: TestContext) {
  const routeMocks = createRouteMocks(context);

  return {
    user: createUser,

    configureAgentPhoneProvider(): void {
      mockOptionalEnv("AGENTPHONE_AGENT_ID", AGENTPHONE_AGENT_ID);
      mockOptionalEnv("AGENTPHONE_API_BASE_URL", AGENTPHONE_API_BASE_URL);
      mockOptionalEnv("AGENTPHONE_API_KEY", "agentphone-bdd-key");
      mockOptionalEnv("AGENTPHONE_PHONE_NUMBER", AGENTPHONE_PHONE_NUMBER);
    },

    clearAgentPhoneProvider(): void {
      mockOptionalEnv("AGENTPHONE_AGENT_ID", undefined);
      mockOptionalEnv("AGENTPHONE_API_BASE_URL", undefined);
      mockOptionalEnv("AGENTPHONE_API_KEY", undefined);
      mockOptionalEnv("AGENTPHONE_PHONE_NUMBER", undefined);
      mockOptionalEnv("AGENTPHONE_WEBHOOK_SECRET", undefined);
    },

    configureAgentPhoneWebhook(): void {
      mockOptionalEnv(
        "AGENTPHONE_WEBHOOK_SECRET",
        agentPhoneBddWebhookSecret(),
      );
      mockOptionalEnv("AGENTPHONE_PHONE_NUMBER", AGENTPHONE_PHONE_NUMBER);
    },

    configureGithubAppInstallProvider(): void {
      mockOptionalEnv("GITHUB_APP_SLUG", "bdd-github-app");
    },

    configureGithubAppCallbackProvider(): void {
      mockOptionalEnv("GITHUB_APP_ID", "12345");
      mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", "bdd-private-key");
    },

    clearGithubAppProvider(): void {
      mockOptionalEnv("GITHUB_APP_SLUG", undefined);
      mockOptionalEnv("GITHUB_APP_ID", undefined);
      mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);
      mockOptionalEnv("GITHUB_APP_CLIENT_ID", undefined);
      mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", undefined);
      mockOptionalEnv("GH_OAUTH_CLIENT_ID", undefined);
      mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", undefined);
    },

    async requestGithubOauthInstall(
      query: GithubOauthInstallQuery,
      statuses: readonly (307 | 503)[],
    ) {
      const client = setupApp({
        baseUrl: "https://api.okou.ai",
        context,
        routes: githubOauthRoutes,
      })(githubOauthContract);
      return await accept(
        client.install({
          query,
        }),
        statuses,
      );
    },

    async requestGithubOauthConnect(
      actor: ApiTestUser | null,
      query: GithubOauthConnectQuery,
      statuses: readonly (307 | 401 | 503)[],
    ) {
      const client = setupApp({
        baseUrl: "https://api.okou.ai",
        context,
        routes: githubOauthRoutes,
      })(githubOauthContract);
      return await accept(
        client.connect({
          extraHeaders: {
            ...extraHeaders(authenticate(context, routeMocks, actor)),
          },
          query,
        }),
        statuses,
      );
    },

    async requestGithubAppSetupCallback(
      query: GithubAppSetupCallbackQuery,
      statuses: readonly 307[],
      baseUrl = "https://api.okou.ai",
    ) {
      const client = setupApp({
        baseUrl,
        context,
        routes: githubOauthRoutes,
      })(githubOauthContract);
      return await accept(
        client.setupCallback({
          query,
        }),
        statuses,
      );
    },

    async requestSlackDisconnect(
      actor: ApiTestUser | null,
      action: string | undefined,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context, routes: integrationsSlackRoutes })(
        integrationsSlackContract,
      );
      return await accept(
        client.disconnect({
          headers: authenticate(context, routeMocks, actor),
          query: { action },
        }),
        statuses,
      );
    },

    async requestSlackIntegrationStatus(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      const client = setupApp({ context, routes: integrationsSlackRoutes })(
        integrationsSlackContract,
      );
      return await accept(
        client.getStatus({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async requestListSlackChannels(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404)[],
    ) {
      const client = setupApp({ context, routes: slackChannelsRoutes })(
        slackChannelsContract,
      );
      return await accept(
        client.list({ headers: authenticate(context, routeMocks, actor) }),
        statuses,
      );
    },

    async requestSendSlackMessage(
      actor: ApiTestUser | null,
      body: SendSlackMessageBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsSlackMessageRoutes,
      })(integrationsSlackMessageContract);
      return await accept(
        client.sendMessage({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSendSlackMessageAsRun(
      okouToken: string,
      body: SendSlackMessageBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsSlackMessageRoutes,
      })(integrationsSlackMessageContract);
      return await accept(
        client.sendMessage({
          headers: { authorization: `Bearer ${okouToken}` },
          body,
        }),
        statuses,
      );
    },

    async requestSlackUploadInit(
      actor: ApiTestUser | null,
      body: SlackUploadInitBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsSlackUploadInitRoutes,
      })(integrationsSlackUploadInitContract);
      return await accept(
        client.init({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSlackUploadComplete(
      actor: ApiTestUser | null,
      body: SlackUploadCompleteBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsSlackUploadCompleteRoutes,
      })(integrationsSlackUploadCompleteContract);
      return await accept(
        client.complete({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSlackDownloadFile(
      actor: ApiTestUser | null,
      fileId: string | undefined,
      statuses: readonly SlackDownloadStatus[],
    ) {
      return await accept(
        requestRawSlackDownloadFile(
          context,
          authenticate(context, routeMocks, actor),
          fileId,
        ),
        statuses,
      );
    },

    async requestSlackConnectStatus(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      const client = setupApp({ context, routes: slackConnectRoutes })(
        slackConnectContract,
      );
      return await accept(
        client.getStatus({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async requestSlackConnect(
      actor: ApiTestUser | null,
      body: SlackConnectBody,
      statuses: readonly (202 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context, routes: slackConnectRoutes })(
        slackConnectContract,
      );
      return await accept(
        client.connect({
          headers: authenticate(context, routeMocks, actor),
          body: { ...body, requestUserScopes: true },
        }),
        statuses,
      );
    },

    async requestSlackOauthInstall(
      query: {
        readonly orgId?: string;
        readonly userId?: string;
        readonly reinstall?: string;
        readonly prompt?: string;
      },
      statuses: readonly (307 | 503)[],
    ) {
      const client = setupApp({ context, routes: slackOauthRoutes })(
        slackOauthContract,
      );
      return await accept(client.install({ query }), statuses);
    },

    configureSlackOauthProvider(): void {
      mockEnv("SLACK_OAUTH_CLIENT_ID", "slack-bdd-client-id");
      mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-bdd-client-secret");
    },

    configureSlackSigningSecret(): void {
      mockOptionalEnv("SLACK_SIGNING_SECRET", SLACK_SIGNING_SECRET);
    },

    signedSlackIngressHeaders(
      body: string,
      timestampOverride?: string,
    ): SlackSignatureHeaders {
      return signedSlackHeaders(body, timestampOverride);
    },

    configureSlackAppMocks(): void {
      mockOptionalEnv("SLACK_SIGNING_SECRET", SLACK_SIGNING_SECRET);
      mockEnv("SLACK_OAUTH_CLIENT_ID", "slack-bdd-client-id");
      mockOptionalEnv("SLACK_OAUTH_CLIENT_SECRET", "slack-bdd-client-secret");
      mockEnv("APP_URL", "https://app.okou.test");
      mockEnv("OKOU_WEB_URL", "https://www.okou.test");
      mockEnv("OKOU_API_BACKEND_URL", SLACK_APP_INTERNAL_API_URL);
      context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
      context.mocks.slack.assistant.threads.setStatus.mockResolvedValue({
        ok: true,
      });
      context.mocks.slack.chat.postMessage.mockResolvedValue({
        ok: true,
        ts: "1710000000.000000",
        channel: "C-bdd",
      });
      context.mocks.slack.chat.getPermalink.mockImplementation(
        (...args: unknown[]) => {
          const request = args[0];
          if (
            typeof request !== "object" ||
            request === null ||
            !("channel" in request) ||
            typeof request.channel !== "string" ||
            !("message_ts" in request) ||
            typeof request.message_ts !== "string"
          ) {
            throw new Error("Expected Slack permalink request arguments");
          }
          return Promise.resolve({
            ok: true,
            permalink: `https://vm0.slack.com/archives/${request.channel}/p${request.message_ts.replace(".", "")}`,
          });
        },
      );
      context.mocks.slack.chat.postEphemeral.mockResolvedValue({
        ok: true,
        message_ts: "1710000000.000001",
      });
      context.mocks.slack.conversations.history.mockResolvedValue({
        ok: true,
        messages: [],
      });
      context.mocks.slack.conversations.replies.mockResolvedValue({
        ok: true,
        messages: [],
      });
      context.mocks.slack.conversations.open.mockResolvedValue({
        ok: true,
        channel: { id: "D-bdd" },
      });
      context.mocks.slack.users.info.mockResolvedValue({
        ok: true,
        user: {
          profile: {
            display_name: "Slack User",
            email: "slack@example.com",
          },
          tz: "UTC",
        },
      });
      context.mocks.slack.views.publish.mockResolvedValue({ ok: true });
      context.mocks.slack.views.open.mockResolvedValue({
        ok: true,
        view: { id: "V-bdd" },
      });
    },

    clearSlackCallHistory(): void {
      context.mocks.slack.assistant.threads.setStatus.mockClear();
      context.mocks.slack.chat.getPermalink.mockClear();
      context.mocks.slack.chat.postMessage.mockClear();
      context.mocks.slack.chat.postEphemeral.mockClear();
      context.mocks.slack.conversations.history.mockClear();
      context.mocks.slack.conversations.replies.mockClear();
      context.mocks.slack.conversations.open.mockClear();
      context.mocks.slack.users.info.mockClear();
      context.mocks.slack.views.publish.mockClear();
      context.mocks.slack.views.open.mockClear();
    },

    acceptSlackSessionHistoryDownloads(): void {
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        if (command instanceof GetObjectCommand) {
          const key =
            typeof command.input.Key === "string" ? command.input.Key : "";
          const historyBody = sessionHistoryBlobBodyForKey(context, key);
          return Promise.resolve({
            Body: (async function* () {
              yield historyBody ?? new TextEncoder().encode("[]");
            })(),
          });
        }
        return Promise.resolve({});
      });
    },

    forwardSlackInternalCallbacks(): readonly ForwardedInternalCallback[] {
      const forwarded: ForwardedInternalCallback[] = [];
      server.use(
        http.post(
          `${SLACK_APP_INTERNAL_API_URL}/api/internal/callbacks/*`,
          async ({ request }) => {
            const url = new URL(request.url);
            const response = await createApp({
              signal: context.signal,
              routes: TEST_APP_ROUTES,
            }).request(`${url.pathname}${url.search}`, {
              method: "POST",
              headers: request.headers,
              body: await request.text(),
            });
            const contentType =
              response.headers.get("content-type") ?? "application/json";
            const text = await response.text();
            forwarded.push({
              path: url.pathname,
              status: response.status,
              body: contentType.includes("application/json")
                ? (JSON.parse(text) as unknown)
                : text,
            });
            return new HttpResponse(text, {
              status: response.status,
              headers: { "content-type": contentType },
            });
          },
        ),
      );
      return forwarded;
    },

    async installSlackWorkspace(
      actor: ApiTestUser | null,
      options: SlackAppInstallOptions = {},
    ): Promise<SlackAppInstallation> {
      const teamId =
        options.teamId ??
        `T_BDD_${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      const installerSlackUserId =
        options.installerSlackUserId ?? `U_INSTALL_${randomUUID().slice(0, 8)}`;
      const botUserId = `UBOT_${randomUUID().slice(0, 8)}`;
      if (actor && !actor.orgId) {
        throw new Error("Slack install actor must have an organization");
      }
      if (actor) {
        authenticate(context, routeMocks, actor);
      }
      context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
        ok: true,
        access_token: `xoxb-bdd-${teamId}`,
        bot_user_id: botUserId,
        team: { id: teamId, name: `BDD Slack App ${teamId}` },
        authed_user: { id: installerSlackUserId },
        scope: SLACK_APP_BOT_SCOPES,
      });
      const client = setupApp({ context, routes: slackOauthRoutes })(
        slackOauthContract,
      );
      const started = await accept(
        client.install({
          query: actor?.orgId
            ? { orgId: actor.orgId, userId: actor.userId }
            : {},
        }),
        [307],
      );
      await accept(
        client.callback({
          query: {
            code: `bdd-install-${teamId}`,
            state: slackOauthStateFromRedirect(started.headers.get("location")),
          },
        }),
        [307],
      );
      return { teamId, botUserId, installerSlackUserId };
    },

    async connectSlackUser(
      actor: ApiTestUser,
      body: SlackConnectBody,
    ): Promise<void> {
      const clients = setupApp({
        context,
        routes: [...slackConnectRoutes, ...slackOauthRoutes],
      });
      const pending = await accept(
        clients(slackConnectContract).connect({
          headers: authenticate(context, routeMocks, actor),
          body: { ...body, requestUserScopes: true },
        }),
        [202],
      );
      const entry = new URL(pending.body.authorizationUrl);
      const authorization = await accept(
        clients(slackOauthContract).connect({
          query: Object.fromEntries(entry.searchParams),
        }),
        [307],
      );
      const location = authorization.headers.get("location");
      if (!location) {
        throw new Error("Expected a Slack OAuth authorization URL");
      }
      const authorizationUrl = new URL(location);
      const userScopes = authorizationUrl.searchParams.get("user_scope");
      if (!userScopes) {
        throw new Error("Expected Slack user OAuth scopes");
      }
      context.mocks.slack.oauth.v2.access.mockResolvedValueOnce({
        ok: true,
        team: {
          id: body.workspaceId,
          name: `BDD Slack App ${body.workspaceId}`,
        },
        authed_user: {
          id: body.slackUserId,
          access_token: `xoxp-bdd-${body.slackUserId}`,
          scope: userScopes,
        },
      });
      context.mocks.slack.users.info.mockResolvedValueOnce({
        ok: true,
        user: {
          id: body.slackUserId,
          real_name: "Slack User",
          profile: { email: actor.email },
        },
      });
      const completed = await accept(
        clients(slackOauthContract).callback({
          query: {
            code: `bdd-connect-${randomUUID()}`,
            state: slackOauthStateFromRedirect(location),
          },
        }),
        [307],
      );
      const completedLocation = completed.headers.get("location");
      if (
        !completedLocation ||
        new URL(completedLocation).searchParams.get("status") !== "connected"
      ) {
        throw new Error(`Slack connection failed: ${completedLocation}`);
      }
    },

    async postSlackEvent(
      teamId: string,
      event: Record<string, unknown>,
    ): Promise<unknown> {
      const body = JSON.stringify({
        type: "event_callback",
        team_id: teamId,
        event_id: `EvBDD${randomUUID().replace(/-/g, "")}`,
        event,
      });
      const response = await accept(
        requestRawSlackIngress(
          context,
          "/api/webhooks/slack/events",
          body,
          signedSlackHeaders(body),
        ),
        [200],
      );
      return response.body;
    },

    async postSlackCommand(args: SlackCommandRequest): Promise<unknown> {
      const body = slackCommandRequestBody(args);
      const response = await accept(
        requestRawSlackIngress(
          context,
          "/api/webhooks/slack/commands",
          body,
          signedSlackHeaders(body),
        ),
        [200],
      );
      return response.body;
    },

    async postSlackInteractive(
      payload: Record<string, unknown>,
    ): Promise<unknown> {
      const body = new URLSearchParams({
        payload: JSON.stringify(payload),
      }).toString();
      const response = await accept(
        requestRawSlackIngress(
          context,
          "/api/webhooks/slack/interactive",
          body,
          signedSlackHeaders(body),
        ),
        [200],
      );
      return response.body;
    },

    agentPickerSubmission(
      args: SlackPickerSubmissionArgs,
    ): Record<string, unknown> {
      return slackPickerSubmission(
        "switch_agent_modal",
        "agent_select_block",
        "agent_select",
        args,
      );
    },

    modelPickerSubmission(
      args: SlackPickerSubmissionArgs,
    ): Record<string, unknown> {
      return slackPickerSubmission(
        "model_preference_modal",
        "model_select_block",
        "model_select",
        args,
      );
    },

    async readSlackTestState(teamId: string) {
      const client = setupApp({ context, routes: testSlackStateRoutes })(
        testSlackStateContract,
      );
      const response = await accept(
        client.get({ query: { team_id: teamId } }),
        [200],
      );
      return response.body;
    },

    async deleteSlackTestState(teamId: string): Promise<void> {
      const client = setupApp({ context, routes: testSlackStateRoutes })(
        testSlackStateContract,
      );
      await accept(client.delete({ query: { team_id: teamId } }), [200]);
    },

    async readUserModelPreference(actor: ApiTestUser) {
      const client = setupApp({
        context,
        routes: userModelPreferenceRoutes,
      })(userModelPreferenceContract);
      const response = await accept(
        client.get({ headers: authenticate(context, routeMocks, actor) }),
        [200],
      );
      return response.body;
    },

    async updateUserModelPreference(
      actor: ApiTestUser,
      selectedModel: SupportedRunModel | null,
      serviceTier: "priority" | null = null,
    ): Promise<void> {
      const client = setupApp({
        context,
        routes: userModelPreferenceRoutes,
      })(userModelPreferenceContract);
      await accept(
        client.update({
          headers: authenticate(context, routeMocks, actor),
          body: { selectedModel, serviceTier },
        }),
        [200],
      );
    },

    async configureSlackRunModelPolicies(actor: ApiTestUser): Promise<void> {
      const providers = setupApp({ context, routes: modelProvidersRoutes })(
        modelProvidersMainContract,
      );
      const anthropic = await accept(
        providers.upsert({
          headers: authenticate(context, routeMocks, actor),
          body: { type: "anthropic-api-key", secret: "bdd-anthropic-key" },
        }),
        [200, 201],
      );
      const openai = await accept(
        providers.upsert({
          headers: authenticate(context, routeMocks, actor),
          body: { type: "openai-api-key", secret: "bdd-openai-key" },
        }),
        [200, 201],
      );
      await accept(
        setupApp({ context, routes: modelPoliciesRoutes })(
          modelPoliciesMainContract,
        ).update({
          headers: authenticate(context, routeMocks, actor),
          body: {
            policies: [
              {
                model: "claude-sonnet-5",
                isDefault: true,
                defaultProviderType: "anthropic-api-key",
                credentialScope: "org",
                modelProviderId: anthropic.body.provider.id,
              },
              {
                model: "gpt-5.6-sol",
                isDefault: false,
                defaultProviderType: "openai-api-key",
                credentialScope: "org",
                modelProviderId: openai.body.provider.id,
              },
            ],
          },
        }),
        [200],
      );
    },

    async enableAuditLinkSwitch(actor: ApiTestUser): Promise<void> {
      await accept(
        setupApp({ context, routes: featureSwitchesRoutes })(
          featureSwitchesContract,
        ).update({
          headers: authenticate(context, routeMocks, actor),
          body: { switches: { [FeatureSwitchKey.OkouDebug]: true } },
        }),
        [200],
      );
    },

    async requestSlackEvent(
      body: string,
      headers: SlackSignatureHeaders,
      statuses: readonly SlackIngressStatus[],
    ) {
      return await accept(
        requestRawSlackIngress(
          context,
          "/api/webhooks/slack/events",
          body,
          headers,
        ),
        statuses,
      );
    },

    async requestSlackCommand(
      body: string,
      headers: SlackSignatureHeaders,
      statuses: readonly (200 | 400 | 401 | 503)[],
    ) {
      return await accept(
        requestRawSlackIngress(
          context,
          "/api/webhooks/slack/commands",
          body,
          headers,
        ),
        statuses,
      );
    },

    async requestSlackInteractive(
      body: string,
      headers: SlackSignatureHeaders,
      statuses: readonly (200 | 400 | 401 | 503)[],
    ) {
      return await accept(
        requestRawSlackIngress(
          context,
          "/api/webhooks/slack/interactive",
          body,
          headers,
        ),
        statuses,
      );
    },

    async requestSlackOauthConnect(
      query: {
        readonly orgId?: string;
        readonly userId?: string;
        readonly prompt?: string;
      },
      statuses: readonly (307 | 400 | 404 | 503)[],
    ) {
      const client = setupApp({ context, routes: slackOauthRoutes })(
        slackOauthContract,
      );
      return await accept(client.connect({ query }), statuses);
    },

    async requestSlackOauthCallback(
      query: {
        readonly code?: string;
        readonly error?: string;
        readonly state?: string;
      },
      statuses: readonly (307 | 400 | 503)[],
    ) {
      const client = setupApp({ context, routes: slackOauthRoutes })(
        slackOauthContract,
      );
      return await accept(client.callback({ query }), statuses);
    },

    async requestListTelegramIntegrations(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      return await accept(
        client.list({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async requestListTelegramBots(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramBotListContract);
      return await accept(
        client.listBots({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async readTelegramLinkStatus(actor: ApiTestUser, botId: string) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      const response = await accept(
        client.getLinkStatus({
          headers: authenticate(context, routeMocks, actor),
          query: { botId },
        }),
        [200],
      );
      return response.body;
    },

    async requestTelegramAuthCallback(statuses: readonly 200[]) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      return await accept(client.authCallback(), statuses);
    },

    async requestTelegramAvatar(
      actor: ApiTestUser | null,
      botId: string,
      query: { readonly exp?: string; readonly sig?: string },
      statuses: readonly (200 | 401 | 404 | 413 | 502)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      return await accept(
        client.avatar({
          headers: authenticate(context, routeMocks, actor),
          params: { botId },
          query,
        }),
        statuses,
      );
    },

    async requestLinkTelegram(
      actor: ApiTestUser | null,
      body: TelegramLinkBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      return await accept(
        client.link({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestUnlinkTelegram(
      actor: ApiTestUser | null,
      botId: string | undefined,
      statuses: readonly (204 | 401 | 404)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      return await accept(
        client.unlink({
          headers: authenticate(context, routeMocks, actor),
          query: { botId },
        }),
        statuses,
      );
    },

    async requestUpdateTelegramBot(
      actor: ApiTestUser | null,
      botId: string,
      body: TelegramUpdateBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      return await accept(
        client.updateBot({
          headers: authenticate(context, routeMocks, actor),
          params: { botId },
          body,
        }),
        statuses,
      );
    },

    async requestDisconnectTelegramBot(
      actor: ApiTestUser | null,
      botId: string,
      statuses: readonly (204 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      return await accept(
        client.disconnect({
          headers: authenticate(context, routeMocks, actor),
          params: { botId },
        }),
        statuses,
      );
    },

    async requestRegisterTelegramBot(
      actor: ApiTestUser | null,
      body: TelegramRegisterBody,
      statuses: readonly (
        | 200
        | 201
        | 400
        | 401
        | 403
        | 404
        | 409
        | 500
        | 502
      )[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      return await accept(
        client.register({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestTelegramSetupStatus(
      actor: ApiTestUser | null,
      body: TelegramSetupStatusBody,
      statuses: readonly (200 | 400 | 401 | 409)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramRoutes,
      })(integrationsTelegramContract);
      return await accept(
        client.setupStatus({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestTelegramUploadInit(
      actor: ApiTestUser | null,
      body: TelegramUploadInitBody,
      statuses: readonly (200 | 400 | 401 | 403)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramUploadInitRoutes,
      })(integrationsTelegramUploadInitContract);
      return await accept(
        client.init({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestTelegramUploadComplete(
      actor: ApiTestUser | null,
      body: TelegramUploadCompleteBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 502)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramUploadCompleteRoutes,
      })(integrationsTelegramUploadCompleteContract);
      return await accept(
        client.complete({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSendTelegramMessage(
      actor: ApiTestUser | null,
      body: SendTelegramMessageBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 502)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramMessageRoutes,
      })(integrationsTelegramMessageContract);
      return await accept(
        client.sendMessage({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestSendTelegramMessageAsRun(
      okouToken: string,
      body: SendTelegramMessageBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 502)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsTelegramMessageRoutes,
      })(integrationsTelegramMessageContract);
      return await accept(
        client.sendMessage({
          headers: { authorization: `Bearer ${okouToken}` },
          body,
        }),
        statuses,
      );
    },

    async readGithubInstallation(actor: ApiTestUser) {
      const client = setupApp({ context, routes: integrationsGithubRoutes })(
        integrationsGithubContract,
      );
      return await accept(
        client.getInstallation({
          headers: authenticate(context, routeMocks, actor),
        }),
        [200, 404],
      );
    },

    async requestGithubUploadInit(
      actor: ApiTestUser | null,
      body: GithubUploadInitBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500 | 502)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsGithubUploadInitRoutes,
      })(integrationsGithubUploadInitContract);
      return await accept(
        client.init({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestGithubUploadComplete(
      actor: ApiTestUser | null,
      body: GithubUploadCompleteBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 500 | 502)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsGithubUploadCompleteRoutes,
      })(integrationsGithubUploadCompleteContract);
      return await accept(
        client.complete({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async getAgentPhoneLinkStatus(actor: ApiTestUser) {
      const client = setupApp({
        context,
        routes: integrationsAgentPhoneRoutes,
      })(integrationsAgentPhoneContract);
      const response = await accept(
        client.getLinkStatus({
          headers: authenticate(context, routeMocks, actor),
        }),
        [200],
      );
      return response.body;
    },

    async requestStartAgentPhoneLink(
      actor: ApiTestUser | null,
      body: { readonly phoneHandle: string },
      statuses: readonly (200 | 400 | 401 | 409 | 429 | 503)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsAgentPhoneRoutes,
      })(integrationsAgentPhoneContract);
      return await accept(
        client.startLink({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestUnlinkAgentPhone(
      actor: ApiTestUser | null,
      statuses: readonly (204 | 401 | 404)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsAgentPhoneRoutes,
      })(integrationsAgentPhoneContract);
      return await accept(
        client.unlink({
          headers: authenticate(context, routeMocks, actor),
        }),
        statuses,
      );
    },

    async requestConnectAgentPhone(
      actor: ApiTestUser | null,
      body: {
        readonly phoneHandle: string;
        readonly agentphoneAgentId: string;
        readonly timestamp: number;
        readonly signature: string;
        readonly channel?: string;
        readonly publicBrand?: PublicBrand;
        readonly publicBrandSignature?: string;
      },
      statuses: readonly (200 | 400 | 401 | 409)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsAgentPhoneRoutes,
      })(integrationsAgentPhoneContract);
      return await accept(
        client.connectAgentPhone({
          headers: authenticate(context, routeMocks, actor),
          body: body as AgentPhoneConnectRequest,
        }),
        statuses,
      );
    },

    async requestAgentPhoneWebhook(
      body: string,
      headers: {
        readonly "x-webhook-signature"?: string;
        readonly "x-webhook-timestamp"?: string;
        readonly "x-webhook-event"?: string;
        readonly "x-webhook-id"?: string;
      },
      statuses: readonly (200 | 400 | 401 | 404)[],
    ) {
      return await accept(
        requestRawAgentPhoneWebhook(context, body, headers),
        statuses,
      );
    },

    async requestTelegramWebhook(
      telegramBotId: string,
      body: string,
      headers: { readonly "x-telegram-bot-api-secret-token"?: string },
      statuses: readonly TelegramWebhookStatus[],
    ) {
      return await accept(
        requestRawTelegramWebhook(context, telegramBotId, body, headers),
        statuses,
      );
    },

    async requestPhoneUploadInit(
      actor: ApiTestUser | null,
      body: PhoneUploadInitBody,
      statuses: readonly (200 | 400 | 401 | 403)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsPhoneUploadInitRoutes,
      })(integrationsPhoneUploadInitContract);
      return await accept(
        client.init({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestPhoneUploadComplete(
      actor: ApiTestUser | null,
      body: PhoneUploadCompleteBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 502)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsPhoneUploadCompleteRoutes,
      })(integrationsPhoneUploadCompleteContract);
      return await accept(
        client.complete({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },

    async requestPhoneDownloadFile(
      actor: ApiTestUser | null,
      fileId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 413 | 502)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsPhoneDownloadFileRoutes,
      })(integrationsPhoneDownloadFileContract);
      return await accept(
        client.download({
          headers: authenticate(context, routeMocks, actor),
          query: { file_id: fileId },
        }),
        statuses,
      );
    },

    async requestSendPhoneMessage(
      actor: ApiTestUser | null,
      body: SendPhoneMessageBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 502)[],
    ) {
      const client = setupApp({
        context,
        routes: integrationsPhoneMessageRoutes,
      })(integrationsPhoneMessageContract);
      return await accept(
        client.sendMessage({
          headers: authenticate(context, routeMocks, actor),
          body,
        }),
        statuses,
      );
    },
  };
}

/**
 * Valid Telegram Login Widget payload for a bot token the test registered
 * through the API: HMAC-SHA256 over the sorted data-check string keyed with
 * sha256(botToken), matching `verifyTelegramLogin`.
 */
export function telegramLoginAuth(
  botToken: string,
  user: {
    readonly id: number;
    readonly first_name?: string;
    readonly username?: string;
  },
): TelegramAuthPayload {
  const authDate = Math.floor(now() / 1000);
  const fields: Record<string, string | number | undefined> = {
    id: user.id,
    first_name: user.first_name,
    username: user.username,
    auth_date: authDate,
  };
  const checkString = Object.entries(fields)
    .filter((entry): entry is [string, string | number] => {
      return entry[1] !== undefined;
    })
    .sort(([left], [right]) => {
      return left.localeCompare(right);
    })
    .map(([key, value]) => {
      return `${key}=${value}`;
    })
    .join("\n");
  const hash = createHmac(
    "sha256",
    createHash("sha256").update(botToken).digest(),
  )
    .update(checkString)
    .digest("hex");
  return {
    id: user.id,
    ...(user.first_name === undefined ? {} : { first_name: user.first_name }),
    ...(user.username === undefined ? {} : { username: user.username }),
    auth_date: authDate,
    hash,
  };
}
