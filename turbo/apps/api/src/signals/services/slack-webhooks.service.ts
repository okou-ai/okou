import { command, computed, type Computed } from "ccstate";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import {
  PUBLIC_BRAND_PRESENTATION,
  PUBLIC_BRAND,
} from "@okouai/core/public-brand";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  getBuiltInVisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { slackUserAgentPreferences } from "@okouai/db/schema/slack-user-agent-preference";
import { userCache } from "@okouai/db/schema/user-cache";
import { agents } from "@okouai/db/schema/agent";
import { and, desc, eq, or } from "drizzle-orm";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  getSlackSignatureHeaders,
  verifySlackSignature,
} from "../../lib/slack-request-verification";
import {
  AGENT_PICKER_ACTION_ID,
  AGENT_PICKER_BLOCK_ID,
  AGENT_PICKER_CALLBACK_ID,
  AGENT_PICKER_ORG_DEFAULT_VALUE,
  MODEL_PICKER_ACTION_ID,
  MODEL_PICKER_BLOCK_ID,
  MODEL_PICKER_CALLBACK_ID,
  buildAgentPickerModal,
  buildAppHomeView,
  buildErrorMessage,
  buildHelpMessage,
  buildLoginMessage,
  buildLoginPromptMessage,
  buildModelPickerModal,
  buildSuccessMessage,
  buildWelcomeMessage,
} from "../../lib/slack-webhook-blocks";
import type { SlackFile } from "../../lib/slack-webhook-context";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import type { SlackAnyBlock } from "../external/slack-block-kit";
import {
  createSlackClient,
  type SlackClient,
} from "../external/slack-message-client";
import { nowDate } from "../../lib/time";
import {
  OFFICIAL_SLACK_APP_NAME,
  OFFICIAL_SLACK_PRIMARY_COMMAND,
  officialSlackBotMention,
} from "../../lib/slack-official-app";
import { writeDb$, type Db } from "../external/db";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { listOrgModelPolicies$ } from "./model-policy.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./user-data.service";
import { publishSlackAdminSignal$ } from "./slack-connect.service";
import {
  admitCanonicalSlackChatEvent,
  ensureCanonicalSlackChatThreadRoute,
  findSlackChatThreadRoute,
  slackSessionThreadTs,
} from "./slack-chat-ingress.service";
import { processCanonicalSlackIngress$ } from "./canonical-slack-ingress-processor.service";
import { onRejection, safeJsonParse, tapError } from "../utils";

const L = logger("SlackWebhooks");
const AGENT_PICKER_MAX_OPTIONS = 100;
const MODEL_PICKER_MAX_OPTIONS = 100;

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;
type SlackConnection = typeof slackOrgConnections.$inferSelect;

interface SlackCommandPayload {
  readonly team_id: string;
  readonly channel_id: string;
  readonly user_id: string;
  readonly text: string;
  readonly trigger_id: string;
}

interface SlackEventCallback {
  readonly type: "event_callback";
  readonly team_id: string;
  readonly event_id?: string;
  readonly event:
    | SlackAppMentionEvent
    | SlackDirectMessageEvent
    | SlackChannelMessageEvent
    | SlackAppHomeOpenedEvent
    | SlackAppUninstalledEvent
    | SlackTokensRevokedEvent;
}

interface SlackUrlVerificationEvent {
  readonly type: "url_verification";
  readonly challenge: string;
}

interface SlackAppMentionEvent {
  readonly type: "app_mention";
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly channel: string;
  readonly channel_type?: string;
  readonly thread_ts?: string;
  readonly files?: readonly SlackFile[];
}

interface SlackDirectMessageEvent {
  readonly type: "message";
  readonly channel_type: "im";
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly channel: string;
  readonly thread_ts?: string;
  readonly subtype?: string;
  readonly bot_id?: string;
  readonly files?: readonly SlackFile[];
}

interface SlackChannelMessageEvent {
  readonly type: "message";
  readonly channel_type?: "channel" | "group" | "mpim";
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly channel: string;
  readonly thread_ts?: string;
  readonly subtype?: string;
  readonly bot_id?: string;
  readonly files?: readonly SlackFile[];
}

interface SlackAppHomeOpenedEvent {
  readonly type: "app_home_opened";
  readonly user: string;
  readonly tab: "home" | "messages";
  readonly channel: string;
}

interface SlackAppUninstalledEvent {
  readonly type: "app_uninstalled";
}

interface SlackTokensRevokedEvent {
  readonly type: "tokens_revoked";
  readonly tokens: {
    readonly bot?: readonly string[];
  };
}

type SlackEvent = SlackUrlVerificationEvent | SlackEventCallback;

interface SlackInteractivePayload {
  readonly type: "view_submission" | "block_actions" | "shortcut";
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly team_id: string;
  };
  readonly team: {
    readonly id: string;
    readonly domain: string;
  };
  readonly trigger_id?: string;
  readonly actions?: readonly {
    readonly action_id: string;
    readonly block_id: string;
  }[];
  readonly view?: {
    readonly callback_id: string;
    readonly private_metadata?: string;
    readonly state: {
      readonly values: Record<
        string,
        Record<
          string,
          { readonly selected_option?: { readonly value: string } | null }
        >
      >;
    };
  };
}

interface ConnectionContext {
  readonly connection: SlackConnection;
  readonly installation: SlackInstallation;
  readonly orgId: string;
}

interface SlackEventCallbackArgs {
  readonly db: Db;
  readonly payload: SlackEventCallback;
  readonly publicBrand: PublicBrand;
  readonly signal: AbortSignal;
}

type SlackChannelType = "channel" | "dm" | "group_dm";

type SlackAgentRouteAdmission =
  | {
      readonly kind: "canonical";
      readonly routeId: string;
    }
  | {
      readonly kind: "ignored";
    };

interface SlackAgentRouteArgs {
  readonly db: Db;
  readonly publicBrand: PublicBrand;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: SlackChannelType;
  readonly slackUserId: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly eventId: string;
  readonly isRetry: boolean;
}

interface WorkspaceAgentSummary {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

type EffectiveComposeResolution =
  | {
      readonly status: "resolved";
      readonly composeId: string;
      readonly agent: WorkspaceAgentSummary;
    }
  | {
      readonly status: "not_configured" | "not_found" | "not_accessible";
    };

type ResolvedEffectiveCompose = Extract<
  EffectiveComposeResolution,
  { readonly status: "resolved" }
>;

interface SlackAgentAdmissionNoticeBase {
  readonly installation: SlackInstallation;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: SlackChannelType;
  readonly slackUserId: string;
  readonly messageTs: string;
  readonly threadTs?: string;
}

type SlackAgentAdmissionNotice =
  | (SlackAgentAdmissionNoticeBase & {
      readonly kind: "not_connected";
    })
  | (SlackAgentAdmissionNoticeBase & {
      readonly kind: "not_configured" | "not_found" | "not_accessible";
      readonly connection: SlackConnection;
    });

interface CommandModelResponseArgs {
  readonly payload: SlackCommandPayload;
  readonly installation: SlackInstallation;
  readonly connection: SlackConnection;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(): Response {
  return new Response("", { status: 200 });
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200 });
}

function ephemeral(blocks: unknown[]): Response {
  return jsonResponse({ response_type: "ephemeral", blocks });
}

function parseCommandPayload(body: string): SlackCommandPayload | null {
  const params = new URLSearchParams(body);
  const teamId = params.get("team_id");
  const channelId = params.get("channel_id");
  const userId = params.get("user_id");
  const triggerId = params.get("trigger_id");
  if (!teamId || !channelId || !userId || !triggerId) {
    return null;
  }
  return {
    team_id: teamId,
    channel_id: channelId,
    user_id: userId,
    text: params.get("text") ?? "",
    trigger_id: triggerId,
  };
}

async function verifiedSlackBody(
  request: Request,
): Promise<
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly response: Response }
> {
  const signingSecret = optionalEnv("SLACK_SIGNING_SECRET");
  if (!signingSecret) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "Slack integration is not configured" },
        503,
      ),
    };
  }

  const body = await request.text();
  const headers = getSlackSignatureHeaders(request.headers);
  if (!headers) {
    return {
      ok: false,
      response: jsonResponse({ error: "Missing Slack signature headers" }, 401),
    };
  }

  const valid = verifySlackSignature({
    signingSecret,
    signature: headers.signature,
    timestamp: headers.timestamp,
    body,
  });
  if (!valid) {
    return {
      ok: false,
      response: jsonResponse({ error: "Invalid signature" }, 401),
    };
  }

  return { ok: true, body };
}

function buildOrgConnectUrl(
  workspaceId: string,
  slackUserId: string,
  channelId: string,
  threadTs: string | undefined,
): string {
  const params = new URLSearchParams({ w: workspaceId, u: slackUserId });
  if (channelId) {
    params.set("c", channelId);
  }
  if (threadTs) {
    params.set("t", threadTs);
  }
  return `${env("APP_URL")}/settings/slack?${params.toString()}`;
}

function buildNotInstalledMessage(detail?: string): unknown[] {
  const { assistantName } = PUBLIC_BRAND_PRESENTATION;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          detail ??
          `The ${assistantName} Slack app hasn't been set up for this workspace yet.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Set up on Platform" },
          url: `${env("APP_URL")}/works`,
          action_id: "open_platform_setup",
        },
      ],
    },
  ];
}

async function installationForWorkspace(
  db: Db,
  workspaceId: string,
): Promise<SlackInstallation | undefined> {
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  return installation;
}

async function installationForWebhook(
  db: Db,
  workspaceId: string,
  publicBrand: PublicBrand,
): Promise<SlackInstallation | undefined> {
  const installation = await installationForWorkspace(db, workspaceId);
  return installation ? { ...installation, publicBrand } : undefined;
}

function buildOfficialSlackHelpMessage(args: {
  readonly installation: SlackInstallation | undefined;
  readonly canSwitch: boolean;
  readonly canModel: boolean;
}): SlackAnyBlock[] {
  return buildHelpMessage({
    canSwitch: args.canSwitch,
    canModel: args.canModel,
    botUserId: args.installation?.botUserId,
  });
}

async function connectionForSlackUser(
  db: Db,
  workspaceId: string,
  slackUserId: string,
): Promise<SlackConnection | undefined> {
  const [connection] = await db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);
  return connection;
}

async function slackCommandWorkspaceContext(
  db: Db,
  payload: SlackCommandPayload,
  publicBrand: PublicBrand,
  signal: AbortSignal,
): Promise<{
  readonly installation: SlackInstallation | undefined;
  readonly connection: SlackConnection | undefined;
}> {
  const installation = await installationForWebhook(
    db,
    payload.team_id,
    publicBrand,
  );
  signal.throwIfAborted();
  const connection = installation
    ? await connectionForSlackUser(db, payload.team_id, payload.user_id)
    : undefined;
  signal.throwIfAborted();
  return { installation, connection };
}

async function resolveConnectionContext(
  db: Db,
  slackUserId: string,
  workspaceId: string,
  publicBrand: PublicBrand,
): Promise<ConnectionContext | null> {
  const installation = await installationForWebhook(
    db,
    workspaceId,
    publicBrand,
  );
  if (!installation?.orgId) {
    return null;
  }
  const connection = await connectionForSlackUser(db, workspaceId, slackUserId);
  if (!connection) {
    return null;
  }
  return { connection, installation, orgId: installation.orgId };
}

function slackPersistentSecretContext(args: {
  readonly orgId: string | null;
  readonly userId: string | undefined;
}): Computed<Promise<FeatureSwitchContext>> {
  return computed(async (get): Promise<FeatureSwitchContext> => {
    if (!args.orgId) {
      return {};
    }
    if (!args.userId) {
      return { orgId: args.orgId };
    }
    return {
      orgId: args.orgId,
      userId: args.userId,
      overrides: await get(userFeatureSwitchOverrides(args.orgId, args.userId)),
    };
  });
}

function decryptSlackBotToken(args: {
  readonly installation: SlackInstallation;
  readonly userId?: string;
}): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    return await decryptPersistentSecretValue(
      args.installation.encryptedBotToken,
      await get(
        slackPersistentSecretContext({
          orgId: args.installation.orgId,
          userId: args.userId,
        }),
      ),
    );
  });
}

async function resolveDefaultComposeId(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row?.defaultAgentId ?? null;
}

async function getUserAgentPreference(
  db: Db,
  userId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ selectedAgentId: slackUserAgentPreferences.selectedAgentId })
    .from(slackUserAgentPreferences)
    .where(
      and(
        eq(slackUserAgentPreferences.userId, userId),
        eq(slackUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);
  return row?.selectedAgentId ?? null;
}

async function setUserAgentPreference(args: {
  readonly db: Db;
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string | null;
}): Promise<void> {
  await args.db
    .insert(slackUserAgentPreferences)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      selectedAgentId: args.composeId,
    })
    .onConflictDoUpdate({
      target: [
        slackUserAgentPreferences.userId,
        slackUserAgentPreferences.orgId,
      ],
      set: {
        selectedAgentId: args.composeId,
        updatedAt: nowDate(),
      },
    });
}

async function getWorkspaceAgent(
  db: Db,
  composeId: string,
  orgId?: string,
): Promise<WorkspaceAgentSummary | undefined> {
  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(
      orgId
        ? and(eq(agents.id, composeId), eq(agents.orgId, orgId))
        : eq(agents.id, composeId),
    )
    .limit(1);
  return agent;
}

async function getVisibleWorkspaceAgent(
  db: Db,
  composeId: string,
  orgId: string,
  userId: string,
): Promise<WorkspaceAgentSummary | undefined> {
  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(
      and(
        eq(agents.id, composeId),
        eq(agents.orgId, orgId),
        or(eq(agents.visibility, "public"), eq(agents.owner, userId)),
      ),
    )
    .limit(1);
  return agent;
}

async function getVisibleAgentPickerOptions(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly defaultAgentId: string | null;
}): Promise<
  readonly {
    readonly composeId: string;
    readonly name: string;
    readonly displayName: string | null;
  }[]
> {
  const rows = await args.db
    .select({
      composeId: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, args.orgId),
        or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
      ),
    )
    .orderBy(desc(agents.updatedAt));

  return rows
    .filter((agent) => {
      return agent.composeId !== args.defaultAgentId;
    })
    .slice(0, AGENT_PICKER_MAX_OPTIONS);
}

async function resolveEffectiveCompose(
  db: Db,
  userId: string,
  orgId: string,
): Promise<EffectiveComposeResolution> {
  const override = await getUserAgentPreference(db, userId, orgId);
  if (override) {
    const agent = await getVisibleWorkspaceAgent(db, override, orgId, userId);
    if (agent) {
      return { status: "resolved", composeId: override, agent };
    }
  }
  const defaultAgentId = await resolveDefaultComposeId(db, orgId);
  if (!defaultAgentId) {
    return { status: "not_configured" };
  }
  const configuredDefaultAgent = await getWorkspaceAgent(
    db,
    defaultAgentId,
    orgId,
  );
  if (!configuredDefaultAgent) {
    return { status: "not_found" };
  }
  const visibleDefaultAgent = await getVisibleWorkspaceAgent(
    db,
    defaultAgentId,
    orgId,
    userId,
  );
  if (!visibleDefaultAgent) {
    return { status: "not_accessible" };
  }
  return {
    status: "resolved",
    composeId: defaultAgentId,
    agent: visibleDefaultAgent,
  };
}

const postSlackAgentAdmissionNotice$ = command(
  async ({ get }, args: SlackAgentAdmissionNotice): Promise<void> => {
    const connection =
      args.kind === "not_connected" ? undefined : args.connection;
    const botToken = await get(
      decryptSlackBotToken({
        installation: args.installation,
        userId: connection?.userId,
      }),
    );
    const client = createSlackClient(botToken);
    const threadTs = args.threadTs ?? args.messageTs;

    if (args.kind === "not_connected") {
      const connectUrl = buildOrgConnectUrl(
        args.workspaceId,
        args.slackUserId,
        args.channelId,
        args.channelType === "dm" ? threadTs : undefined,
      );
      await postSlackUserNotice({
        client,
        channelId: args.channelId,
        channelType: args.channelType,
        slackUserId: args.slackUserId,
        threadTs,
        text: "Please connect your account first",
        blocks: buildLoginPromptMessage(connectUrl),
      });
      return;
    }

    const notice = (() => {
      switch (args.kind) {
        case "not_configured": {
          return "No agent is configured for this org. Please ask your org admin to set a default agent.";
        }
        case "not_found": {
          return "The configured agent could not be found. Please contact your org admin.";
        }
        case "not_accessible": {
          return `The configured agent is not available to your Slack account. Use \`${OFFICIAL_SLACK_PRIMARY_COMMAND} switch\` to choose an accessible agent.`;
        }
      }
    })();
    await postSlackUserNotice({
      client,
      channelId: args.channelId,
      channelType: args.channelType,
      slackUserId: args.slackUserId,
      threadTs,
      ephemeralThreadTs: args.threadTs ? threadTs : undefined,
      text: notice,
    });
  },
);

const resolveSlackRouteCompose$ = command(
  async (
    { set },
    args: SlackAgentAdmissionNoticeBase & {
      readonly db: Db;
      readonly connection: SlackConnection;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<ResolvedEffectiveCompose | undefined> => {
    const effectiveCompose = await resolveEffectiveCompose(
      args.db,
      args.connection.userId,
      args.orgId,
    );
    signal.throwIfAborted();
    if (effectiveCompose.status === "resolved") {
      return effectiveCompose;
    }
    waitUntil(
      tapError(
        set(postSlackAgentAdmissionNotice$, {
          kind: effectiveCompose.status,
          installation: args.installation,
          connection: args.connection,
          workspaceId: args.workspaceId,
          channelId: args.channelId,
          channelType: args.channelType,
          slackUserId: args.slackUserId,
          messageTs: args.messageTs,
          ...(args.threadTs ? { threadTs: args.threadTs } : {}),
        }),
        (error) => {
          L.error("Failed to post Slack admission notice", { error });
        },
      ),
    );
    return undefined;
  },
);

function integrationModelRouteServiceTier(
  route: IntegrationModelRoutePin | undefined,
): IntegrationModelRoutePin["serviceTier"] {
  return route?.serviceTier ?? null;
}

const resolveConnectedSlackAgentRouteAdmission$ = command(
  async (
    { set },
    args: SlackAgentRouteArgs & {
      readonly installation: SlackInstallation;
      readonly connection: SlackConnection;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<SlackAgentRouteAdmission> => {
    const reuseMainDirectMessageSession =
      args.channelType === "dm" && args.threadTs === undefined;
    let effectiveCompose = reuseMainDirectMessageSession
      ? await set(
          resolveSlackRouteCompose$,
          {
            db: args.db,
            connection: args.connection,
            orgId: args.orgId,
            installation: args.installation,
            workspaceId: args.workspaceId,
            channelId: args.channelId,
            channelType: args.channelType,
            slackUserId: args.slackUserId,
            messageTs: args.messageTs,
          },
          signal,
        )
      : undefined;
    if (reuseMainDirectMessageSession && !effectiveCompose) {
      return { kind: "ignored" };
    }
    const mainDirectMessageModelRoute = reuseMainDirectMessageSession
      ? await set(
          resolveIntegrationModelRouteForUser$,
          {
            orgId: args.orgId,
            userId: args.connection.userId,
          },
          signal,
        )
      : undefined;
    signal.throwIfAborted();
    const sessionThreadTs = slackSessionThreadTs({
      channelType: args.channelType,
      messageTs: args.messageTs,
      ...(args.threadTs ? { threadTs: args.threadTs } : {}),
      ...(effectiveCompose ? { agentId: effectiveCompose.composeId } : {}),
      selectedModel: mainDirectMessageModelRoute?.selectedModel ?? null,
      serviceTier: integrationModelRouteServiceTier(
        mainDirectMessageModelRoute,
      ),
    });
    const routeKey = {
      connectionId: args.connection.id,
      channelId: args.channelId,
      threadTs: sessionThreadTs,
      userId: args.connection.userId,
    };
    const existingRoute = await findSlackChatThreadRoute(args.db, routeKey);
    signal.throwIfAborted();
    if (existingRoute) {
      return { kind: "canonical", routeId: existingRoute.id };
    }

    effectiveCompose ??= await set(
      resolveSlackRouteCompose$,
      {
        db: args.db,
        connection: args.connection,
        orgId: args.orgId,
        installation: args.installation,
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        channelType: args.channelType,
        slackUserId: args.slackUserId,
        messageTs: args.messageTs,
        ...(args.threadTs ? { threadTs: args.threadTs } : {}),
      },
      signal,
    );
    if (!effectiveCompose) {
      return { kind: "ignored" };
    }

    const modelRoute = reuseMainDirectMessageSession
      ? mainDirectMessageModelRoute
      : await set(
          resolveIntegrationModelRouteForUser$,
          {
            orgId: args.orgId,
            userId: args.connection.userId,
          },
          signal,
        );
    signal.throwIfAborted();
    const route = await ensureCanonicalSlackChatThreadRoute(args.db, {
      ...routeKey,
      orgId: args.orgId,
      agentId: effectiveCompose.composeId,
      selectedModel: modelRoute?.selectedModel ?? null,
      serviceTier: modelRoute?.serviceTier ?? null,
      currentTime: nowDate(),
    });
    signal.throwIfAborted();
    return { kind: "canonical", routeId: route.id };
  },
);

const resolveSlackAgentRouteAdmission$ = command(
  async (
    { set },
    args: SlackAgentRouteArgs,
    signal: AbortSignal,
  ): Promise<SlackAgentRouteAdmission> => {
    const installation = await installationForWebhook(
      args.db,
      args.workspaceId,
      args.publicBrand,
    );
    signal.throwIfAborted();
    const orgId = installation?.orgId;
    if (!installation || !orgId) {
      return { kind: "ignored" };
    }
    const connection = await connectionForSlackUser(
      args.db,
      args.workspaceId,
      args.slackUserId,
    );
    signal.throwIfAborted();
    if (!connection) {
      if (!args.isRetry) {
        waitUntil(
          tapError(
            set(postSlackAgentAdmissionNotice$, {
              kind: "not_connected",
              installation,
              workspaceId: args.workspaceId,
              channelId: args.channelId,
              channelType: args.channelType,
              slackUserId: args.slackUserId,
              messageTs: args.messageTs,
              ...(args.threadTs ? { threadTs: args.threadTs } : {}),
            }),
            (error) => {
              L.error("Failed to post Slack admission notice", { error });
            },
          ),
        );
      }
      return { kind: "ignored" };
    }
    return await set(
      resolveConnectedSlackAgentRouteAdmission$,
      { ...args, installation, connection, orgId },
      signal,
    );
  },
);

async function disconnect(db: Db, connectionId: string): Promise<void> {
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.id, connectionId));
}

const cleanupWorkspaceInstallation$ = command(
  async (
    { set },
    db: Db,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const installation = await installationForWorkspace(db, workspaceId);
    signal.throwIfAborted();
    if (!installation) {
      return false;
    }
    await db
      .delete(slackOrgConnections)
      .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
    signal.throwIfAborted();
    await db
      .delete(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
    signal.throwIfAborted();
    if (installation.orgId) {
      await set(
        publishSlackAdminSignal$,
        { orgId: installation.orgId, topic: "slack:changed" },
        signal,
      );
    }
    return true;
  },
);

const slackModelPickerState$ = command(
  async (
    { get, set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly enabled: boolean;
    readonly options: readonly {
      readonly model: SupportedRunModel;
      readonly label: string;
      readonly isDefault: boolean;
    }[];
    readonly currentSelectedModel: string | null;
  }> => {
    const visibleModels = new Set(getBuiltInVisibleModels());
    const [policies, preference] = await Promise.all([
      set(listOrgModelPolicies$, { orgId, userId }, signal),
      get(userModelPreference({ orgId, userId })),
    ]);
    signal.throwIfAborted();
    return {
      enabled: true,
      options: policies.policies.flatMap((policy) => {
        if (
          !isSupportedRunModel(policy.model) ||
          !visibleModels.has(policy.model) ||
          policy.routeStatus !== "valid"
        ) {
          return [];
        }
        return {
          model: policy.model,
          label: policy.modelLabel,
          isDefault: policy.isDefault,
        };
      }),
      currentSelectedModel: preference.selectedModel,
    };
  },
);

const isModelCommandAvailable$ = command(
  async (
    { set },
    installation: SlackInstallation | undefined,
    connection: SlackConnection | undefined,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!installation?.orgId || !connection) {
      return false;
    }
    const picker = await set(
      slackModelPickerState$,
      installation.orgId,
      connection.userId,
      signal,
    );
    return picker.enabled && picker.options.length > 0;
  },
);

const refreshOrgAppHome$ = command(
  async (
    { get },
    db: Db,
    installation: SlackInstallation,
    slackUserId: string,
  ): Promise<void> => {
    const workspaceId = installation.slackWorkspaceId;
    const connection = await connectionForSlackUser(
      db,
      workspaceId,
      slackUserId,
    );
    const botToken = await get(
      decryptSlackBotToken({
        installation,
        userId: connection?.userId,
      }),
    );
    const client = createSlackClient(botToken);
    if (!connection) {
      await client.publishAppHome(
        slackUserId,
        buildAppHomeView({
          botUserId: installation.botUserId,
          isLinked: false,
          loginUrl: buildOrgConnectUrl(workspaceId, slackUserId, "", undefined),
        }),
      );
      return;
    }

    let agentName: string | undefined;
    let isOverrideActive = false;
    let canSwitch = false;
    if (installation.orgId) {
      const orgId = installation.orgId;
      const [effectiveCompose, overrideComposeId, defaultAgentId] =
        await Promise.all([
          resolveEffectiveCompose(db, connection.userId, orgId),
          getUserAgentPreference(db, connection.userId, orgId),
          resolveDefaultComposeId(db, orgId),
        ]);
      const visibleOverrideAgent = overrideComposeId
        ? await getVisibleWorkspaceAgent(
            db,
            overrideComposeId,
            orgId,
            connection.userId,
          )
        : undefined;
      const visibleDefaultAgent = defaultAgentId
        ? await getVisibleWorkspaceAgent(
            db,
            defaultAgentId,
            orgId,
            connection.userId,
          )
        : undefined;
      const visibleOptions = await getVisibleAgentPickerOptions({
        db,
        orgId,
        userId: connection.userId,
        defaultAgentId,
      });
      if (effectiveCompose.status === "resolved") {
        agentName =
          effectiveCompose.agent.displayName ?? effectiveCompose.agent.name;
      }
      isOverrideActive = Boolean(
        visibleOverrideAgent && overrideComposeId !== defaultAgentId,
      );
      canSwitch = Boolean(visibleDefaultAgent || visibleOptions.length > 0);
    }

    const [metadata] = await db
      .select({ email: userCache.email })
      .from(userCache)
      .where(eq(userCache.userId, connection.userId))
      .limit(1);

    await client.publishAppHome(
      slackUserId,
      buildAppHomeView({
        botUserId: installation.botUserId,
        isLinked: true,
        userId: connection.userId,
        userEmail: metadata?.email ?? undefined,
        agentName,
        isOverrideActive,
        canSwitch,
      }),
    );
  },
);

const commandSwitchResponse$ = command(
  async (
    { get },
    db: Db,
    payload: SlackCommandPayload,
    installation: SlackInstallation,
    connection: SlackConnection,
  ): Promise<Response> => {
    if (!installation.orgId) {
      return ephemeral(
        buildErrorMessage(
          "This workspace is not bound to an org. Please contact your admin.",
        ),
      );
    }
    if (!payload.trigger_id) {
      return ephemeral(
        buildErrorMessage(
          "Couldn't open the agent picker \u2014 please try again.",
        ),
      );
    }
    const defaultAgentId = await resolveDefaultComposeId(
      db,
      installation.orgId,
    );
    const options = await getVisibleAgentPickerOptions({
      db,
      orgId: installation.orgId,
      userId: connection.userId,
      defaultAgentId,
    });
    const visibleDefaultAgent = defaultAgentId
      ? await getVisibleWorkspaceAgent(
          db,
          defaultAgentId,
          installation.orgId,
          connection.userId,
        )
      : undefined;
    if (!visibleDefaultAgent && options.length === 0) {
      return ephemeral(
        buildErrorMessage("No agents are available to your Slack account."),
      );
    }
    const orgDefaultName = visibleDefaultAgent
      ? (visibleDefaultAgent.displayName ?? visibleDefaultAgent.name)
      : null;
    const currentOverride = await getUserAgentPreference(
      db,
      connection.userId,
      installation.orgId,
    );
    const client = createSlackClient(
      await get(
        decryptSlackBotToken({
          installation,
          userId: connection.userId,
        }),
      ),
    );
    const result = await tapError(
      client.openView(
        payload.trigger_id,
        buildAgentPickerModal({
          options,
          currentSelectedId: currentOverride,
          includeOrgDefault: Boolean(visibleDefaultAgent),
          orgDefaultName,
          privateMetadata: JSON.stringify({ channelId: payload.channel_id }),
        }),
      ),
      (error) => {
        L.warn("Failed to open agent picker modal", { error });
      },
    );
    if (!result) {
      return ephemeral(
        buildErrorMessage(
          "Couldn't open the agent picker \u2014 please try again.",
        ),
      );
    }
    return emptyResponse();
  },
);

const commandModelResponse$ = command(
  async (
    { get, set },
    args: CommandModelResponseArgs,
    signal: AbortSignal,
  ): Promise<Response> => {
    if (!args.installation.orgId) {
      return ephemeral(
        buildErrorMessage(
          "This workspace is not bound to an org. Please contact your admin.",
        ),
      );
    }
    if (!args.payload.trigger_id) {
      return ephemeral(
        buildErrorMessage(
          "Couldn't open the model picker \u2014 please try again.",
        ),
      );
    }
    const picker = await set(
      slackModelPickerState$,
      args.installation.orgId,
      args.connection.userId,
      signal,
    );
    if (!picker.enabled) {
      return ephemeral(
        buildErrorMessage(
          "Model switching is not available for this workspace.",
        ),
      );
    }
    if (picker.options.length === 0) {
      return ephemeral(
        buildErrorMessage("No models are configured for this workspace."),
      );
    }
    const client = createSlackClient(
      await get(
        decryptSlackBotToken({
          installation: args.installation,
          userId: args.connection.userId,
        }),
      ),
    );
    signal.throwIfAborted();
    const result = await tapError(
      client.openView(
        args.payload.trigger_id,
        buildModelPickerModal({
          options: picker.options.slice(0, MODEL_PICKER_MAX_OPTIONS),
          currentSelectedModel: picker.currentSelectedModel,
          privateMetadata: JSON.stringify({
            channelId: args.payload.channel_id,
          }),
        }),
      ),
      (error) => {
        L.warn("Failed to open model picker modal", { error });
      },
    );
    signal.throwIfAborted();
    if (!result) {
      return ephemeral(
        buildErrorMessage(
          "Couldn't open the model picker \u2014 please try again.",
        ),
      );
    }
    return emptyResponse();
  },
);

export const handleSlackCommands$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const publicBrand = PUBLIC_BRAND;
    const verified = await verifiedSlackBody(request.raw);
    signal.throwIfAborted();
    if (!verified.ok) {
      return verified.response;
    }

    const payload = parseCommandPayload(verified.body);
    if (!payload) {
      return jsonResponse(
        { error: "Missing required Slack command fields" },
        400,
      );
    }
    const db = set(writeDb$);
    const args = payload.text.trim().split(/\s+/);
    const subCommand = args[0]?.toLowerCase() ?? "";
    const { installation, connection } = await slackCommandWorkspaceContext(
      db,
      payload,
      publicBrand,
      signal,
    );
    const canSwitchAgents = Boolean(installation?.orgId);
    const canModel = () => {
      return set(isModelCommandAvailable$, installation, connection, signal);
    };

    if (subCommand === "help" || subCommand === "") {
      return ephemeral(
        buildOfficialSlackHelpMessage({
          installation,
          canSwitch: canSwitchAgents,
          canModel: await canModel(),
        }),
      );
    }

    if (subCommand === "connect") {
      if (!installation) {
        return ephemeral(
          buildNotInstalledMessage(
            `The ${OFFICIAL_SLACK_APP_NAME} Slack app hasn't been set up for this workspace yet. An org admin can complete the setup from the platform.`,
          ),
        );
      }
      if (connection) {
        const { assistantName } = PUBLIC_BRAND_PRESENTATION;
        return ephemeral(
          buildSuccessMessage(
            `You are already connected to ${assistantName}.\nMention ${officialSlackBotMention(installation.botUserId)} in any channel or send a DM to start chatting with your agent.`,
          ),
        );
      }
      return ephemeral(
        buildLoginMessage(
          buildOrgConnectUrl(
            payload.team_id,
            payload.user_id,
            payload.channel_id,
            undefined,
          ),
        ),
      );
    }

    if (!installation) {
      return ephemeral(buildNotInstalledMessage());
    }

    if (subCommand === "disconnect") {
      if (!connection) {
        return ephemeral(buildErrorMessage("You are not connected."));
      }
      await disconnect(db, connection.id);
      signal.throwIfAborted();
      waitUntil(
        tapError(
          set(refreshOrgAppHome$, db, installation, payload.user_id),
          (error) => {
            L.warn("Failed to refresh App Home after disconnect", { error });
          },
        ),
      );
      return ephemeral(
        buildSuccessMessage(
          "You have been disconnected and your agent access has been revoked.",
        ),
      );
    }

    if (!connection) {
      return ephemeral(
        buildLoginMessage(
          buildOrgConnectUrl(
            payload.team_id,
            payload.user_id,
            payload.channel_id,
            undefined,
          ),
        ),
      );
    }

    if (subCommand === "switch") {
      return set(commandSwitchResponse$, db, payload, installation, connection);
    }

    if (subCommand === "model") {
      return set(
        commandModelResponse$,
        { payload, installation, connection },
        signal,
      );
    }

    return ephemeral(
      buildOfficialSlackHelpMessage({
        installation,
        canSwitch: canSwitchAgents,
        canModel: await canModel(),
      }),
    );
  },
);

async function postSlackUserNotice(args: {
  readonly client: SlackClient;
  readonly channelId: string;
  readonly channelType: SlackChannelType;
  readonly slackUserId: string;
  readonly threadTs: string;
  readonly ephemeralThreadTs?: string;
  readonly text: string;
  readonly blocks?: SlackAnyBlock[];
}): Promise<void> {
  if (args.channelType === "dm") {
    await args.client.postMessage(args.channelId, args.text, {
      threadTs: args.threadTs,
      blocks: args.blocks,
    });
    return;
  }

  const result = await args.client.postEphemeral({
    channel: args.channelId,
    user: args.slackUserId,
    threadTs: args.ephemeralThreadTs,
    text: args.text,
    blocks: args.blocks,
  });
  if (result.kind === "slack_error") {
    L.error("Failed to post Slack admission notice", { error: result.error });
  }
}

const handleAppHomeOpened$ = command(
  async (
    { set },
    db: Db,
    workspaceId: string,
    slackUserId: string,
    publicBrand: PublicBrand,
  ): Promise<void> => {
    const installation = await installationForWebhook(
      db,
      workspaceId,
      publicBrand,
    );
    if (!installation) {
      return;
    }
    await set(refreshOrgAppHome$, db, installation, slackUserId);
  },
);

const handleMessagesTabOpened$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly channelId: string;
      readonly publicBrand: PublicBrand;
    },
  ): Promise<void> => {
    const installation = await installationForWebhook(
      args.db,
      args.workspaceId,
      args.publicBrand,
    );
    if (!installation) {
      return;
    }
    const [connection] = await args.db
      .select({
        id: slackOrgConnections.id,
        userId: slackOrgConnections.userId,
      })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackUserId, args.slackUserId),
          eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
        ),
      )
      .limit(1);
    if (!connection) {
      return;
    }
    const updated = await args.db
      .update(slackOrgConnections)
      .set({ dmWelcomeSent: true })
      .where(
        and(
          eq(slackOrgConnections.id, connection.id),
          eq(slackOrgConnections.dmWelcomeSent, false),
        ),
      );
    if (updated.rowCount === 0) {
      return;
    }
    let agentName: string | undefined;
    if (installation.orgId) {
      const composeId = await resolveDefaultComposeId(
        args.db,
        installation.orgId,
      );
      const agent = composeId
        ? await getWorkspaceAgent(args.db, composeId)
        : undefined;
      agentName = agent?.displayName ?? agent?.name;
    }
    await createSlackClient(
      await get(
        decryptSlackBotToken({
          installation,
          userId: connection.userId,
        }),
      ),
    ).postMessage(
      args.channelId,
      `Hi! I'm ${officialSlackBotMention(installation.botUserId)}. I can connect you to AI agents to help with your tasks.`,
      {
        blocks: buildWelcomeMessage(installation.botUserId, agentName),
      },
    );
  },
);

function isSlackUserMessageEvent(
  event: SlackDirectMessageEvent | SlackChannelMessageEvent,
): boolean {
  return (!event.subtype || event.subtype === "file_share") && !event.bot_id;
}

function isSlackDirectAgentMessageEvent(
  event: SlackEventCallback["event"],
): event is SlackDirectMessageEvent {
  return (
    event.type === "message" &&
    event.channel_type === "im" &&
    isSlackUserMessageEvent(event)
  );
}

function slackAgentMessageEvent(
  event: SlackEventCallback["event"],
): SlackAppMentionEvent | SlackDirectMessageEvent | undefined {
  if (event.type === "app_mention") {
    return event;
  }
  if (isSlackDirectAgentMessageEvent(event)) {
    return event;
  }
  return undefined;
}

function slackAppMentionChannelType(
  event: SlackAppMentionEvent,
): SlackChannelType {
  if (event.channel_type === "im") {
    return "dm";
  }
  if (event.channel_type === "mpim") {
    return "group_dm";
  }
  return "channel";
}

const scheduleSlackAppHomeEvent$ = command(
  (
    { set },
    args: {
      readonly callback: SlackEventCallbackArgs;
      readonly event: SlackAppHomeOpenedEvent;
    },
  ): void => {
    if (args.event.tab === "home") {
      waitUntil(
        tapError(
          set(
            handleAppHomeOpened$,
            args.callback.db,
            args.callback.payload.team_id,
            args.event.user,
            args.callback.publicBrand,
          ),
          (error) => {
            L.error("Error handling org app_home_opened", { error });
          },
        ),
      );
    }

    if (args.event.tab === "messages") {
      waitUntil(
        tapError(
          set(handleMessagesTabOpened$, {
            db: args.callback.db,
            workspaceId: args.callback.payload.team_id,
            slackUserId: args.event.user,
            channelId: args.event.channel,
            publicBrand: args.callback.publicBrand,
          }),
          (error) => {
            L.error("Error handling org messages_tab_opened", { error });
          },
        ),
      );
    }
  },
);

const scheduleSlackInstallationCleanup$ = command(
  (
    { set },
    args: {
      readonly callback: SlackEventCallbackArgs;
      readonly errorMessage: string;
    },
  ): void => {
    waitUntil(
      tapError(
        set(
          cleanupWorkspaceInstallation$,
          args.callback.db,
          args.callback.payload.team_id,
          args.callback.signal,
        ),
        (error) => {
          L.error(args.errorMessage, { error });
        },
      ),
    );
  },
);

const handleEventCallback$ = command(
  ({ set }, args: SlackEventCallbackArgs): void => {
    const event = args.payload.event;
    if (event.type === "app_home_opened") {
      set(scheduleSlackAppHomeEvent$, {
        callback: args,
        event,
      });
    }

    if (event.type === "app_uninstalled") {
      set(scheduleSlackInstallationCleanup$, {
        callback: args,
        errorMessage: "Error handling app_uninstalled",
      });
    }

    if (event.type === "tokens_revoked" && event.tokens.bot?.length) {
      set(scheduleSlackInstallationCleanup$, {
        callback: args,
        errorMessage: "Error handling tokens_revoked",
      });
    }
  },
);

export const handleSlackEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const publicBrand = PUBLIC_BRAND;
    const verified = await verifiedSlackBody(request.raw);
    signal.throwIfAborted();
    if (!verified.ok) {
      return verified.response;
    }

    const parsedPayload = safeJsonParse(verified.body);
    if (parsedPayload === undefined) {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }
    const payload = parsedPayload as SlackEvent;

    if (payload.type === "url_verification") {
      return jsonResponse({ challenge: payload.challenge });
    }

    if (payload.type === "event_callback") {
      const retryNum = request.header("x-slack-retry-num");
      const agentEvent = slackAgentMessageEvent(payload.event);
      if (agentEvent) {
        if (!payload.event_id) {
          L.error("Canonical Slack ingress is missing required identity", {
            type: "canonical_slack_ingress_admission",
            success: false,
            hasEventId: false,
            isRetry: Boolean(retryNum),
          });
          return jsonResponse(
            { error: "Canonical Slack event identity is missing" },
            400,
          );
        }
        const db = set(writeDb$);
        const channelType =
          agentEvent.type === "app_mention"
            ? slackAppMentionChannelType(agentEvent)
            : "dm";
        const route = await set(
          resolveSlackAgentRouteAdmission$,
          {
            db,
            publicBrand,
            workspaceId: payload.team_id,
            channelId: agentEvent.channel,
            channelType,
            slackUserId: agentEvent.user,
            messageTs: agentEvent.ts,
            ...(agentEvent.thread_ts ? { threadTs: agentEvent.thread_ts } : {}),
            eventId: payload.event_id,
            isRetry: Boolean(retryNum),
          },
          signal,
        );
        signal.throwIfAborted();
        if (route.kind === "canonical") {
          const ingress = await onRejection(
            admitCanonicalSlackChatEvent(db, {
              routeId: route.routeId,
              eventId: payload.event_id,
              payload: verified.body,
              publicBrand,
              isRetry: Boolean(retryNum),
              currentTime: nowDate(),
            }),
            (error) => {
              L.error("Canonical Slack ingress admission failed", {
                type: "canonical_slack_ingress_admission",
                success: false,
                isRetry: Boolean(retryNum),
                retryNum: retryNum ?? null,
                error,
              });
            },
          );
          signal.throwIfAborted();
          L.debug("Canonical Slack ingress admitted", {
            type: "canonical_slack_ingress_admission",
            success: true,
            isRetry: Boolean(retryNum),
            retryNum: retryNum ?? null,
            outcome: ingress.inserted ? "accepted" : "deduplicated",
            status: ingress.status,
          });
          if (ingress.status !== "processed") {
            // Admission is durable and already acknowledged to Slack. Keep the
            // processor alive if the request signal is cancelled afterward.
            const backgroundSignal = new AbortController().signal;
            waitUntil(
              tapError(
                set(
                  processCanonicalSlackIngress$,
                  { ingressId: ingress.id },
                  backgroundSignal,
                ),
                (error) => {
                  L.error(
                    "Canonical Slack ingress background processing failed",
                    {
                      ingressId: ingress.id,
                      error,
                    },
                  );
                },
              ),
            );
          }
          return textResponse("OK");
        }

        return textResponse("OK");
      }

      if (retryNum) {
        return textResponse("OK");
      }
      set(handleEventCallback$, {
        db: set(writeDb$),
        payload,
        publicBrand,
        signal,
      });
      return textResponse("OK");
    }

    return textResponse("OK");
  },
);

function parseViewChannelId(
  privateMetadata: string | undefined,
): string | undefined {
  if (!privateMetadata) {
    return undefined;
  }
  const metadata = safeJsonParse(privateMetadata);
  const channelId =
    typeof metadata === "object" && metadata !== null && "channelId" in metadata
      ? metadata.channelId
      : undefined;
  return typeof channelId === "string" && channelId.length > 0
    ? channelId
    : undefined;
}

async function postEphemeralMessage(args: {
  readonly botToken: string;
  readonly channel: string;
  readonly slackUserId: string;
  readonly text: string;
}): Promise<void> {
  const result = await createSlackClient(args.botToken).postEphemeral({
    channel: args.channel,
    user: args.slackUserId,
    text: args.text,
  });
  if (result.kind === "slack_error") {
    L.warn("Failed to post ephemeral message", { error: result.error });
  }
}

const handleAgentPickerSubmit$ = command(
  async (
    { get, set },
    db: Db,
    payload: SlackInteractivePayload,
    publicBrand: PublicBrand,
  ): Promise<Response> => {
    const selected =
      payload.view?.state.values[AGENT_PICKER_BLOCK_ID]?.[
        AGENT_PICKER_ACTION_ID
      ]?.selected_option?.value;
    if (!selected) {
      return jsonResponse({
        response_action: "errors",
        errors: { [AGENT_PICKER_BLOCK_ID]: "Please choose an agent." },
      });
    }
    const ctx = await resolveConnectionContext(
      db,
      payload.user.id,
      payload.team.id,
      publicBrand,
    );
    if (!ctx) {
      return emptyResponse();
    }
    const botToken = await get(
      decryptSlackBotToken({
        installation: ctx.installation,
        userId: ctx.connection.userId,
      }),
    );
    const channelId = parseViewChannelId(payload.view?.private_metadata);
    if (selected === AGENT_PICKER_ORG_DEFAULT_VALUE) {
      const defaultAgentId = await resolveDefaultComposeId(db, ctx.orgId);
      const visibleDefaultAgent = defaultAgentId
        ? await getVisibleWorkspaceAgent(
            db,
            defaultAgentId,
            ctx.orgId,
            ctx.connection.userId,
          )
        : undefined;
      if (!visibleDefaultAgent) {
        return jsonResponse({
          response_action: "errors",
          errors: {
            [AGENT_PICKER_BLOCK_ID]: "You don't have access to that agent.",
          },
        });
      }
      const defaultName =
        visibleDefaultAgent.displayName ?? visibleDefaultAgent.name;
      await setUserAgentPreference({
        db,
        userId: ctx.connection.userId,
        orgId: ctx.orgId,
        composeId: null,
      });
      if (channelId) {
        await postEphemeralMessage({
          botToken,
          channel: channelId,
          slackUserId: payload.user.id,
          text: `Switched to *${defaultName}* for new Slack threads.`,
        });
      }
      waitUntil(set(refreshOrgAppHome$, db, ctx.installation, payload.user.id));
      return emptyResponse();
    }

    const agent = await getVisibleWorkspaceAgent(
      db,
      selected,
      ctx.orgId,
      ctx.connection.userId,
    );
    if (!agent || agent.id !== selected) {
      return jsonResponse({
        response_action: "errors",
        errors: {
          [AGENT_PICKER_BLOCK_ID]: "You don't have access to that agent.",
        },
      });
    }
    await setUserAgentPreference({
      db,
      userId: ctx.connection.userId,
      orgId: ctx.orgId,
      composeId: agent.id,
    });
    if (channelId) {
      await postEphemeralMessage({
        botToken,
        channel: channelId,
        slackUserId: payload.user.id,
        text: `Switched to *${agent.displayName ?? agent.name}* for new Slack threads.`,
      });
    }
    waitUntil(set(refreshOrgAppHome$, db, ctx.installation, payload.user.id));
    return emptyResponse();
  },
);

const handleModelPickerSubmit$ = command(
  async (
    { get, set },
    db: Db,
    payload: SlackInteractivePayload,
    publicBrand: PublicBrand,
    signal: AbortSignal,
  ): Promise<Response> => {
    const selected =
      payload.view?.state.values[MODEL_PICKER_BLOCK_ID]?.[
        MODEL_PICKER_ACTION_ID
      ]?.selected_option?.value;
    if (!selected) {
      return jsonResponse({
        response_action: "errors",
        errors: { [MODEL_PICKER_BLOCK_ID]: "Please choose a model." },
      });
    }
    const ctx = await resolveConnectionContext(
      db,
      payload.user.id,
      payload.team.id,
      publicBrand,
    );
    signal.throwIfAborted();
    if (!ctx) {
      return emptyResponse();
    }
    const picker = await set(
      slackModelPickerState$,
      ctx.orgId,
      ctx.connection.userId,
      signal,
    );
    const option = picker.options.find((candidate) => {
      return candidate.model === selected;
    });
    if (!option) {
      return jsonResponse({
        response_action: "errors",
        errors: {
          [MODEL_PICKER_BLOCK_ID]: "You don't have access to that model.",
        },
      });
    }
    await set(
      updateUserModelPreference$,
      {
        orgId: ctx.orgId,
        userId: ctx.connection.userId,
        preference: { selectedModel: option.model, serviceTier: null },
      },
      signal,
    );
    const channelId = parseViewChannelId(payload.view?.private_metadata);
    if (channelId) {
      await postEphemeralMessage({
        botToken: await get(
          decryptSlackBotToken({
            installation: ctx.installation,
            userId: ctx.connection.userId,
          }),
        ),
        channel: channelId,
        slackUserId: payload.user.id,
        text: `Switched to *${option.label}* for new Slack threads.`,
      });
    }
    return emptyResponse();
  },
);

const handleHomeSwitchAgent$ = command(
  async (
    { get },
    db: Db,
    payload: SlackInteractivePayload,
    publicBrand: PublicBrand,
  ): Promise<void> => {
    if (!payload.trigger_id) {
      return;
    }
    const triggerId = payload.trigger_id;
    const ctx = await resolveConnectionContext(
      db,
      payload.user.id,
      payload.team.id,
      publicBrand,
    );
    if (!ctx) {
      return;
    }
    const defaultAgentId = await resolveDefaultComposeId(db, ctx.orgId);
    const options = await getVisibleAgentPickerOptions({
      db,
      orgId: ctx.orgId,
      userId: ctx.connection.userId,
      defaultAgentId,
    });
    const visibleDefaultAgent = defaultAgentId
      ? await getVisibleWorkspaceAgent(
          db,
          defaultAgentId,
          ctx.orgId,
          ctx.connection.userId,
        )
      : undefined;
    if (!visibleDefaultAgent && options.length === 0) {
      return;
    }
    const orgDefaultName = visibleDefaultAgent
      ? (visibleDefaultAgent.displayName ?? visibleDefaultAgent.name)
      : null;
    const currentOverride = await getUserAgentPreference(
      db,
      ctx.connection.userId,
      ctx.orgId,
    );
    await tapError(
      createSlackClient(
        await get(
          decryptSlackBotToken({
            installation: ctx.installation,
            userId: ctx.connection.userId,
          }),
        ),
      ).openView(
        triggerId,
        buildAgentPickerModal({
          options,
          currentSelectedId: currentOverride,
          includeOrgDefault: Boolean(visibleDefaultAgent),
          orgDefaultName,
        }),
      ),
      (error) => {
        L.warn("Failed to open switch modal from App Home", { error });
      },
    );
  },
);

const handleHomeDisconnect$ = command(
  async (
    { set },
    db: Db,
    payload: SlackInteractivePayload,
    publicBrand: PublicBrand,
  ): Promise<void> => {
    const connection = await connectionForSlackUser(
      db,
      payload.team.id,
      payload.user.id,
    );
    if (!connection) {
      return;
    }
    await disconnect(db, connection.id);
    const installation = await installationForWebhook(
      db,
      payload.team.id,
      publicBrand,
    );
    if (!installation) {
      return;
    }
    await set(refreshOrgAppHome$, db, installation, payload.user.id);
  },
);

export const handleSlackInteractive$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const publicBrand = PUBLIC_BRAND;
    const verified = await verifiedSlackBody(request.raw);
    signal.throwIfAborted();
    if (!verified.ok) {
      return verified.response;
    }

    const payloadString = new URLSearchParams(verified.body).get("payload");
    if (!payloadString) {
      return jsonResponse({ error: "Missing payload" }, 400);
    }

    const parsedPayload = safeJsonParse(payloadString);
    if (parsedPayload === undefined) {
      return jsonResponse({ error: "Invalid payload" }, 400);
    }
    const payload = parsedPayload as SlackInteractivePayload;

    const db = set(writeDb$);
    if (
      payload.type === "view_submission" &&
      payload.view?.callback_id === AGENT_PICKER_CALLBACK_ID
    ) {
      return set(handleAgentPickerSubmit$, db, payload, publicBrand);
    }
    if (
      payload.type === "view_submission" &&
      payload.view?.callback_id === MODEL_PICKER_CALLBACK_ID
    ) {
      return set(handleModelPickerSubmit$, db, payload, publicBrand, signal);
    }
    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      if (!action) {
        return emptyResponse();
      }
      if (action.action_id === "home_disconnect") {
        await set(handleHomeDisconnect$, db, payload, publicBrand);
      } else if (action.action_id === "home_switch_agent") {
        await set(handleHomeSwitchAgent$, db, payload, publicBrand);
      }
    }
    return emptyResponse();
  },
);
