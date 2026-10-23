import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { userCache } from "@okouai/db/schema/user-cache";
import { command, computed, type Computed } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  OFFICIAL_SLACK_APP_NAME,
  officialSlackBotMention,
} from "../../lib/slack-official-app";
import {
  getSlackSignatureHeaders,
  verifySlackSignature,
} from "../../lib/slack-request-verification";
import {
  buildAppHomeView,
  buildErrorMessage,
  buildHelpMessage,
  buildLoginMessage,
  buildLoginPromptMessage,
  buildSuccessMessage,
  buildWelcomeMessage,
} from "../../lib/slack-webhook-blocks";
import type { SlackFile } from "../../lib/slack-webhook-context";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  loadUserFeatureSwitchContext$,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { removeSlackWorkspaceInstallation$ } from "./slack-workspace-identity.service";
import type { SlackAnyBlock } from "../external/slack-block-kit";
import {
  createSlackClient,
  type SlackClient,
} from "../external/slack-message-client";
import { onRejection, safeJsonParse, tapError } from "../utils";
import { processCanonicalSlackIngress$ } from "./canonical-slack-ingress-processor.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { resolveDefaultModelFirstPin$ } from "./model-selection.service";
import {
  admitCanonicalSlackChatEvent$,
  ensureCanonicalSlackChatThreadRoute$,
  findSlackChatThreadRoute$,
  slackSessionThreadTs,
} from "./slack-chat-ingress.service";
import { publishSlackAdminSignal$ } from "./slack-connect.service";
import {
  slackLinkSharedEventSchema,
  unfurlSlackArtifactLinks$,
  type SlackLinkSharedEvent,
} from "./slack-link-unfurl.service";
import {
  slackSessionStoppedEventSchema,
  stopSlackSession$,
  type SlackSessionStoppedEvent,
} from "./slack-session-stop.service";
const L = logger("SlackWebhooks");

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
    | SlackSessionStoppedEvent
    | SlackLinkSharedEvent
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
}

interface SlackEventCallbackArgs {
  readonly payload: SlackEventCallback;
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
  return `${env("APP_URL")}${INTEGRATION_SETTINGS_PATHS.slack}?${params.toString()}`;
}

function buildNotInstalledMessage(detail?: string): unknown[] {
  const { assistantName } = BRAND_PRESENTATION;
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

function buildOfficialSlackHelpMessage(args: {
  readonly installation: SlackInstallation | undefined;
}): SlackAnyBlock[] {
  return buildHelpMessage({
    botUserId: args.installation?.botUserId,
  });
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
          return "The configured agent is not available to your Slack account. Please contact your org admin.";
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
    { get, set },
    args: SlackAgentAdmissionNoticeBase & {
      readonly connection: SlackConnection;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<ResolvedEffectiveCompose | undefined> => {
    const routeDb = get(db$);
    const routeUser = args.connection.userId;
    const routeOrg = args.orgId;
    const effectiveCompose =
      await (async (): Promise<EffectiveComposeResolution> => {
        const defaultAgentId = await (async () => {
          const [row] = await routeDb
            .select({ defaultAgentId: orgMetadata.defaultAgentId })
            .from(orgMetadata)
            .where(eq(orgMetadata.orgId, routeOrg))
            .limit(1);
          return row?.defaultAgentId ?? null;
        })();
        if (!defaultAgentId) {
          return { status: "not_configured" };
        }
        const configuredDefaultAgent = await (async () => {
          const [agent] = await routeDb
            .select({
              id: agents.id,
              name: agents.name,
              displayName: agents.displayName,
            })
            .from(agents)
            .where(
              routeOrg
                ? and(eq(agents.id, defaultAgentId), eq(agents.orgId, routeOrg))
                : eq(agents.id, defaultAgentId),
            )
            .limit(1);
          return agent;
        })();
        if (!configuredDefaultAgent) {
          return { status: "not_found" };
        }
        const visibleDefaultAgent = await (async () => {
          const [agent] = await routeDb
            .select({
              id: agents.id,
              name: agents.name,
              displayName: agents.displayName,
            })
            .from(agents)
            .where(
              and(
                eq(agents.id, defaultAgentId),
                eq(agents.orgId, routeOrg),
                or(
                  eq(agents.visibility, "public"),
                  eq(agents.owner, routeUser),
                ),
              ),
            )
            .limit(1);
          return agent;
        })();
        if (!visibleDefaultAgent) {
          return { status: "not_accessible" };
        }
        return {
          status: "resolved",
          composeId: defaultAgentId,
          agent: visibleDefaultAgent,
        };
      })();
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
    const sessionThreadTs = slackSessionThreadTs({
      channelType: args.channelType,
      messageTs: args.messageTs,
      ...(args.threadTs ? { threadTs: args.threadTs } : {}),
    });
    const routeKey = {
      connectionId: args.connection.id,
      channelId: args.channelId,
      threadTs: sessionThreadTs,
      userId: args.connection.userId,
    };
    const existingRoute = await set(
      findSlackChatThreadRoute$,
      routeKey,
      signal,
    );
    signal.throwIfAborted();
    if (existingRoute) {
      return { kind: "canonical", routeId: existingRoute.id };
    }

    const effectiveCompose = await set(
      resolveSlackRouteCompose$,
      {
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

    const route = await set(
      ensureCanonicalSlackChatThreadRoute$,
      {
        initialModel: await set(
          resolveDefaultModelFirstPin$,
          {
            orgId: args.orgId,
            userId: args.connection.userId,
            orgPlanCapabilities: undefined,
          },
          signal,
        ),
        ...routeKey,
        orgId: args.orgId,
        agentId: effectiveCompose.composeId,
        currentTime: nowDate(),
      },
      signal,
    );
    signal.throwIfAborted();
    return { kind: "canonical", routeId: route.id };
  },
);

const resolveSlackAccountRoute$ = command(
  async (
    { get, set },
    args: {
      readonly installation: SlackInstallation;
      readonly slackUserId: string;
    },
    signal: AbortSignal,
  ) => {
    const candidates = await get(db$)
      .select({
        connection: slackOrgConnections,
        installationOrgId: slackOrgInstallations.orgId,
      })
      .from(slackOrgConnections)
      .leftJoin(
        slackOrgInstallations,
        eq(
          slackOrgInstallations.slackWorkspaceId,
          slackOrgConnections.slackWorkspaceId,
        ),
      )
      .where(eq(slackOrgConnections.slackUserId, args.slackUserId));
    signal.throwIfAborted();
    let identityRouting = false;
    for (const candidate of candidates) {
      const candidateOrgId =
        candidate.connection.orgId ?? candidate.installationOrgId;
      if (!candidateOrgId) {
        continue;
      }
      const features = await set(
        loadUserFeatureSwitchContext$,
        candidateOrgId,
        candidate.connection.userId,
        signal,
      );
      if (
        !isFeatureEnabled(FeatureSwitchKey.SlackWorkspaceIdentity, features)
      ) {
        continue;
      }
      identityRouting = true;
      const token = await decryptPersistentSecretValue(
        args.installation.encryptedBotToken,
        args.installation.orgId ? { orgId: args.installation.orgId } : {},
      );
      signal.throwIfAborted();
      const identity = await createSlackClient(token).fetchUserIdentity(
        args.slackUserId,
      );
      signal.throwIfAborted();
      if (
        !identity ||
        identity.deleted ||
        identity.isBot ||
        identity.teamId !== candidate.connection.slackWorkspaceId
      ) {
        continue;
      }
      const membership = await set(
        getMemberRoleAndUpdateCache$,
        candidateOrgId,
        candidate.connection.userId,
        signal,
      );
      if (membership.kind !== "member") {
        return { kind: "ignored" } as const;
      }
      return {
        kind: "account",
        connection: candidate.connection,
        orgId: candidateOrgId,
      } as const;
    }
    if (identityRouting) {
      return { kind: "ignored" } as const;
    }
    return { kind: "legacy" } as const;
  },
);

const resolveSlackAgentRouteAdmission$ = command(
  async (
    { get, set },
    args: SlackAgentRouteArgs,
    signal: AbortSignal,
  ): Promise<SlackAgentRouteAdmission> => {
    const installationDb = get(db$);
    const installationWorkspaceId = args.workspaceId;
    const installation = await (async (): Promise<
      SlackInstallation | undefined
    > => {
      const [installation] = await installationDb
        .select()
        .from(slackOrgInstallations)
        .where(
          eq(slackOrgInstallations.slackWorkspaceId, installationWorkspaceId),
        )
        .limit(1);
      return installation;
    })();
    signal.throwIfAborted();
    let orgId = installation?.orgId;
    if (!installation) {
      return { kind: "ignored" };
    }
    const connectionLookupDb = get(db$);
    const connectionLookupWorkspaceId = args.workspaceId;
    const connectionLookupSlackUserId = args.slackUserId;
    let connection = await (async (): Promise<SlackConnection | undefined> => {
      const [connection] = await connectionLookupDb
        .select()
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.slackUserId, connectionLookupSlackUserId),
            eq(
              slackOrgConnections.slackWorkspaceId,
              connectionLookupWorkspaceId,
            ),
          ),
        )
        .limit(1);
      return connection;
    })();
    signal.throwIfAborted();
    const accountRoute = await set(
      resolveSlackAccountRoute$,
      { installation, slackUserId: args.slackUserId },
      signal,
    );
    if (accountRoute.kind === "ignored") {
      return { kind: "ignored" };
    }
    if (accountRoute.kind === "account") {
      connection = accountRoute.connection;
      orgId = accountRoute.orgId;
    }
    if (!orgId || (connection?.orgId && connection.orgId !== orgId)) {
      return { kind: "ignored" };
    }
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

const cleanupWorkspaceInstallation$ = command(
  async (
    { set },
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const installation = await (async (): Promise<
      SlackInstallation | undefined
    > => {
      const [installation] = await db
        .select()
        .from(slackOrgInstallations)
        .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
        .limit(1);
      return installation;
    })();
    signal.throwIfAborted();
    if (!installation) {
      return false;
    }
    await set(removeSlackWorkspaceInstallation$, workspaceId, signal);
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

function appHomeAgentSelection() {
  return {
    id: agents.id,
    name: agents.name,
    displayName: agents.displayName,
  };
}

const refreshOrgAppHome$ = command(
  async (
    { get },
    installation: SlackInstallation,
    slackUserId: string,
  ): Promise<void> => {
    const db = get(db$);
    const workspaceId = installation.slackWorkspaceId;
    const connectionLookupDb = db;
    const connectionLookupWorkspaceId = workspaceId;
    const connectionLookupSlackUserId = slackUserId;
    const connection = await (async (): Promise<
      SlackConnection | undefined
    > => {
      const [connection] = await connectionLookupDb
        .select()
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.slackUserId, connectionLookupSlackUserId),
            eq(
              slackOrgConnections.slackWorkspaceId,
              connectionLookupWorkspaceId,
            ),
          ),
        )
        .limit(1);
      return connection;
    })();
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
    if (installation.orgId) {
      const homeDb = db;
      const userId = connection.userId;
      const orgId = installation.orgId;
      const effectiveCompose =
        await (async (): Promise<EffectiveComposeResolution> => {
          const defaultAgentId = await (async () => {
            const [row] = await homeDb
              .select({ defaultAgentId: orgMetadata.defaultAgentId })
              .from(orgMetadata)
              .where(eq(orgMetadata.orgId, orgId))
              .limit(1);
            return row?.defaultAgentId ?? null;
          })();
          if (!defaultAgentId) {
            return { status: "not_configured" };
          }
          const configuredDefaultAgent = await (async () => {
            const [agent] = await homeDb
              .select(appHomeAgentSelection())
              .from(agents)
              .where(
                orgId
                  ? and(eq(agents.id, defaultAgentId), eq(agents.orgId, orgId))
                  : eq(agents.id, defaultAgentId),
              )
              .limit(1);
            return agent;
          })();
          if (!configuredDefaultAgent) {
            return { status: "not_found" };
          }
          const visibleDefaultAgent = await (async () => {
            const [agent] = await homeDb
              .select(appHomeAgentSelection())
              .from(agents)
              .where(
                and(
                  eq(agents.id, defaultAgentId),
                  eq(agents.orgId, orgId),
                  or(eq(agents.visibility, "public"), eq(agents.owner, userId)),
                ),
              )
              .limit(1);
            return agent;
          })();
          if (!visibleDefaultAgent) {
            return { status: "not_accessible" };
          }
          return {
            status: "resolved",
            composeId: defaultAgentId,
            agent: visibleDefaultAgent,
          };
        })();
      if (effectiveCompose.status === "resolved") {
        agentName =
          effectiveCompose.agent.displayName ?? effectiveCompose.agent.name;
      }
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
      }),
    );
  },
);

function slackCommandLoginResponse(payload: SlackCommandPayload): Response {
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

export const handleSlackCommands$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
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
    const { installation, connection } = await (async (
      signal: AbortSignal,
    ): Promise<{
      readonly installation: SlackInstallation | undefined;
      readonly connection: SlackConnection | undefined;
    }> => {
      const installationWorkspaceId = payload.team_id;
      const installation = await (async (): Promise<
        SlackInstallation | undefined
      > => {
        const [installation] = await db
          .select()
          .from(slackOrgInstallations)
          .where(
            eq(slackOrgInstallations.slackWorkspaceId, installationWorkspaceId),
          )
          .limit(1);
        return installation;
      })();
      signal.throwIfAborted();
      let connection: SlackConnection | undefined;
      if (installation) {
        const lookupDb = db;
        const workspaceId = payload.team_id;
        const slackUserId = payload.user_id;
        connection = await (async (): Promise<SlackConnection | undefined> => {
          const [connection] = await lookupDb
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
        })();
      }
      signal.throwIfAborted();
      return { installation, connection };
    })(signal);
    if (subCommand === "help" || subCommand === "") {
      return ephemeral(
        buildOfficialSlackHelpMessage({
          installation,
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
        const { assistantName } = BRAND_PRESENTATION;
        return ephemeral(
          buildSuccessMessage(
            `You are already connected to ${assistantName}.\nMention ${officialSlackBotMention(installation.botUserId)} in any channel or send a DM to start chatting with your agent.`,
          ),
        );
      }
      return slackCommandLoginResponse(payload);
    }

    if (!installation) {
      return ephemeral(buildNotInstalledMessage());
    }

    if (subCommand === "disconnect") {
      if (!connection) {
        return ephemeral(buildErrorMessage("You are not connected."));
      }
      const connectionId = connection.id;
      await (async (): Promise<void> => {
        await db
          .delete(slackOrgConnections)
          .where(eq(slackOrgConnections.id, connectionId));
      })();
      signal.throwIfAborted();
      waitUntil(
        tapError(
          set(refreshOrgAppHome$, installation, payload.user_id),
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
      return slackCommandLoginResponse(payload);
    }

    return ephemeral(
      buildOfficialSlackHelpMessage({
        installation,
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
    { get, set },
    workspaceId: string,
    slackUserId: string,
  ): Promise<void> => {
    const db = get(db$);
    const installation = await (async (): Promise<
      SlackInstallation | undefined
    > => {
      const [installation] = await db
        .select()
        .from(slackOrgInstallations)
        .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
        .limit(1);
      return installation;
    })();
    if (!installation) {
      return;
    }
    await set(refreshOrgAppHome$, installation, slackUserId);
  },
);

const handleMessagesTabOpened$ = command(
  async (
    { get, set },
    args: {
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly channelId: string;
    },
  ): Promise<void> => {
    const installationDb = get(db$);
    const installationWorkspaceId = args.workspaceId;
    const installation = await (async (): Promise<
      SlackInstallation | undefined
    > => {
      const [installation] = await installationDb
        .select()
        .from(slackOrgInstallations)
        .where(
          eq(slackOrgInstallations.slackWorkspaceId, installationWorkspaceId),
        )
        .limit(1);
      return installation;
    })();
    if (!installation) {
      return;
    }
    const [connection] = await get(db$)
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
    const updated = await set(writeDb$)
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
      const db = get(db$);
      const orgId = installation.orgId;
      const composeId = await (async () => {
        const [row] = await db
          .select({ defaultAgentId: orgMetadata.defaultAgentId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, orgId))
          .limit(1);
        return row?.defaultAgentId ?? null;
      })();
      let agent: WorkspaceAgentSummary | undefined;
      if (composeId) {
        const db = get(db$);
        agent = await (async () => {
          const [row] = await db
            .select({
              id: agents.id,
              name: agents.name,
              displayName: agents.displayName,
            })
            .from(agents)
            .where(eq(agents.id, composeId))
            .limit(1);
          return row;
        })();
      }
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
            args.callback.payload.team_id,
            args.event.user,
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
            workspaceId: args.callback.payload.team_id,
            slackUserId: args.event.user,
            channelId: args.event.channel,
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
    signal: AbortSignal,
  ): void => {
    waitUntil(
      tapError(
        set(
          cleanupWorkspaceInstallation$,
          args.callback.payload.team_id,
          signal,
        ),
        (error) => {
          L.error(args.errorMessage, { error });
        },
      ),
    );
  },
);

const handleEventCallback$ = command(
  ({ set }, args: SlackEventCallbackArgs, signal: AbortSignal): void => {
    const event = args.payload.event;
    if (event.type === "app_home_opened") {
      set(scheduleSlackAppHomeEvent$, {
        callback: args,
        event,
      });
    }

    if (event.type === "app_uninstalled") {
      set(
        scheduleSlackInstallationCleanup$,
        {
          callback: args,
          errorMessage: "Error handling app_uninstalled",
        },
        signal,
      );
    }

    if (event.type === "tokens_revoked" && event.tokens.bot?.length) {
      set(
        scheduleSlackInstallationCleanup$,
        {
          callback: args,
          errorMessage: "Error handling tokens_revoked",
        },
        signal,
      );
    }
  },
);

const handleSlackSessionStoppedEvent$ = command(
  async (
    { set },
    args: { readonly payload: SlackEventCallback; readonly isRetry: boolean },
    signal: AbortSignal,
  ): Promise<Response> => {
    const { payload, isRetry } = args;
    const stopped = slackSessionStoppedEventSchema.safeParse(payload.event);
    if (!stopped.success || !payload.team_id) {
      return jsonResponse({ error: "Invalid Slack stop event" }, 400);
    }
    await set(
      stopSlackSession$,
      { workspaceId: payload.team_id, event: stopped.data, isRetry },
      signal,
    );
    signal.throwIfAborted();
    return textResponse("OK");
  },
);

const scheduleSlackLinkUnfurl$ = command(
  ({ set }, payload: SlackEventCallback): Response => {
    const shared = slackLinkSharedEventSchema.safeParse(payload.event);
    if (
      !shared.success ||
      typeof payload.team_id !== "string" ||
      !payload.team_id
    ) {
      return jsonResponse({ error: "Invalid Slack link event" }, 400);
    }
    // chat.unfurl updates the same message/URL on redelivery. Acknowledge
    // before loading previews, with a bounded lifetime beyond the response.
    waitUntil(
      tapError(
        set(
          unfurlSlackArtifactLinks$,
          { workspaceId: payload.team_id, event: shared.data },
          AbortSignal.timeout(30_000),
        ),
        (error) => {
          L.error("Error unfurling Slack artifact links", { error });
        },
      ),
    );
    return textResponse("OK");
  },
);

const scheduleCanonicalSlackIngress$ = command(({ set }, ingressId: string) => {
  // Admission is durable and already acknowledged to Slack. Keep the
  // processor alive if the request signal is cancelled afterward.
  const backgroundSignal = new AbortController().signal;
  waitUntil(
    tapError(
      set(processCanonicalSlackIngress$, { ingressId }, backgroundSignal),
      (error) => {
        L.error("Canonical Slack ingress background processing failed", {
          ingressId,
          error,
        });
      },
    ),
  );
});

export const handleSlackEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
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
      if (payload.event.type === "link_shared") {
        // Unfurl retries are safe and must precede the generic retry guard.
        return set(scheduleSlackLinkUnfurl$, payload);
      }
      if (payload.event.type === "agent_session_stopped") {
        // Stop retries repeat the same time-bounded mutation; do not discard them
        // with the generic non-message retry guard below.
        return await set(
          handleSlackSessionStoppedEvent$,
          { payload, isRetry: Boolean(retryNum) },
          signal,
        );
      }
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
        const channelType =
          agentEvent.type === "app_mention"
            ? slackAppMentionChannelType(agentEvent)
            : "dm";
        const route = await set(
          resolveSlackAgentRouteAdmission$,
          {
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
            set(
              admitCanonicalSlackChatEvent$,
              {
                routeId: route.routeId,
                eventId: payload.event_id,
                payload: verified.body,
                isRetry: Boolean(retryNum),
                currentTime: nowDate(),
              },
              signal,
            ),
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
            set(scheduleCanonicalSlackIngress$, ingress.id);
          }
          return textResponse("OK");
        }

        return textResponse("OK");
      }

      if (retryNum) {
        return textResponse("OK");
      }
      set(handleEventCallback$, { payload }, signal);
      return textResponse("OK");
    }

    return textResponse("OK");
  },
);

const handleHomeDisconnect$ = command(
  async ({ set }, payload: SlackInteractivePayload): Promise<void> => {
    const db = set(writeDb$);
    const connectionLookupDb = db;
    const connectionLookupWorkspaceId = payload.team.id;
    const connectionLookupSlackUserId = payload.user.id;
    const connection = await (async (): Promise<
      SlackConnection | undefined
    > => {
      const [connection] = await connectionLookupDb
        .select()
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.slackUserId, connectionLookupSlackUserId),
            eq(
              slackOrgConnections.slackWorkspaceId,
              connectionLookupWorkspaceId,
            ),
          ),
        )
        .limit(1);
      return connection;
    })();
    if (!connection) {
      return;
    }
    const connectionId = connection.id;
    await (async (): Promise<void> => {
      await db
        .delete(slackOrgConnections)
        .where(eq(slackOrgConnections.id, connectionId));
    })();
    const installationWorkspaceId = payload.team.id;
    const installation = await (async (): Promise<
      SlackInstallation | undefined
    > => {
      const [installation] = await db
        .select()
        .from(slackOrgInstallations)
        .where(
          eq(slackOrgInstallations.slackWorkspaceId, installationWorkspaceId),
        )
        .limit(1);
      return installation;
    })();
    if (!installation) {
      return;
    }
    await set(refreshOrgAppHome$, installation, payload.user.id);
  },
);

export const handleSlackInteractive$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
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

    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      if (!action) {
        return emptyResponse();
      }
      if (action.action_id === "home_disconnect") {
        await set(handleHomeDisconnect$, payload);
      }
    }
    return emptyResponse();
  },
);
