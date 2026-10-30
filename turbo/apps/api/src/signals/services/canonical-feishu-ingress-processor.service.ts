import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";
import type { FeishuPlatform } from "@okouai/api-contracts/contracts/feishu-platform";
import { agents } from "@okouai/db/schema/agent";
import { feishuChatIngress } from "@okouai/db/schema/feishu-chat-ingress";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { command } from "ccstate";
import { and, asc, eq, inArray, lt, or } from "drizzle-orm";
import { array, object, string, enum as zEnum } from "zod";
import { buildFeishuNoticeMessage } from "../../lib/feishu-message-card";
import {
  formatFeishuMessageContent,
  type FeishuPromptFile,
} from "../../lib/feishu-message-content";
import { logger } from "../../lib/log";
import { inferMimetype } from "../../lib/mimetype";
import { now, nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  FeishuApiError,
  feishuReactionCreationUrl,
  feishuMessageHistoryUrl,
  parseFeishuMessageHistoryResponse,
  type FeishuHistoryMessage,
  feishuTokenUpdateValues,
  parseFeishuReactionCreationResponse,
  readFeishuResponseJson,
  replyWithFeishuMessage$,
  resolveFeishuRequestCredentials,
} from "../external/feishu-client";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
  publishUserSignal,
} from "../external/realtime";
import { settle, tapError } from "../utils";
import { waitUntil } from "../context/wait-until";
import { createChatEventSourcePart } from "./chat-event-annotation.service";
import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
import { chatQueueWaitNotice } from "./chat-queue-wait-notice";
import type { ChatQueueWaitReason } from "./chat-queue-wait-reason";
import {
  pickEnqueuedChatThread$,
  enqueuedChatQueueWaitReason$,
  notifyRunningChatRunOfPendingInput$,
} from "./chat-thread-queue-drain.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import {
  ensureFeishuChatThreadRoute$,
  feishuRouteThreadId,
} from "./feishu-chat-ingress.service";
import {
  buildFeishuChatOpenUrl,
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "./feishu-config";
import {
  feishuOAuthMemberReadPlan,
  feishuOAuthMemberFromRows,
  feishuOAuthInstallationReadPlan,
  feishuOAuthAccountReadPlan,
  feishuOAuthAccountFromRows,
  feishuOAuthCredentialReadPlan,
} from "./feishu-custom-connector.service";
import {
  dispatchConnectedFeishuCommand$,
  formatFeishuConversationHistory,
  feishuMessageReceivedValues,
  feishuMessageReceivedCondition,
  replyFeishuAgentUnavailable$,
  replyToUnconnectedFeishuMessage$,
  feishuEffectiveAgentReadPlan,
  feishuEffectiveAgentFromRows,
  type FeishuDispatchConnection,
  type FeishuDispatchInstallation,
  type FeishuInboundMessage,
} from "./feishu-dispatch.service";
import {
  feishuOrgChangedAdminReadPlan,
  feishuOrgChangedUserIds,
} from "./feishu-realtime.service";
import { enqueueIntegrationChatInput$ } from "./integration-chat-queue.service";
import {
  canonicalInputFilePrompt,
  integrationInputMessageFiles,
  materializeIntegrationInputAssets$,
  readyIntegrationInputAsset,
  type IntegrationInputAsset,
  type IntegrationInputFile,
} from "./integration-input-assets.service";
import { resolveDefaultModelFirstPin$ } from "./model-selection.service";
import { touchNativeChatThread$ } from "./native-chat-event-write.service";
import { resolveOptionalChatEnrichment } from "./queued-launch-enrichment.service";

const L = logger("CanonicalFeishuIngressProcessor");
const feishuDispatchL = logger("FeishuDispatch");
const FEISHU_THINKING_EMOJI = "Typing";
const PROCESSING_STALE_AFTER_MS = 5 * 60 * 1000;
const SWEEP_LIMIT = 20;

const feishuPromptFileSchema = object({
  fileId: string(),
  messageId: string(),
  fileKey: string(),
  type: zEnum(["file", "image"]),
  filename: string(),
});

const feishuInboundMessageSchema = object({
  installationId: string(),
  eventId: string(),
  tenantKey: string(),
  appId: string(),
  messageId: string(),
  chatId: string(),
  chatType: zEnum(["group", "p2p", "topic_group"]),
  rootId: string().nullable(),
  parentId: string().nullable(),
  threadId: string().nullable(),
  openId: string(),
  text: string(),
  promptText: string(),
  files: array(feishuPromptFileSchema),
});

interface CanonicalFeishuInboundMessage extends FeishuInboundMessage {
  readonly platform: FeishuPlatform;
}

const claimIngress$ = command(
  async ({ set }, ingressId: string, currentTime: Date): Promise<boolean> => {
    const db = set(writeDb$);
    const staleBefore = new Date(
      currentTime.getTime() - PROCESSING_STALE_AFTER_MS,
    );
    const [claimed] = await db
      .update(feishuChatIngress)
      .set({
        status: "processing",
        lastError: null,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(feishuChatIngress.id, ingressId),
          or(
            inArray(feishuChatIngress.status, ["pending", "failed"]),
            and(
              eq(feishuChatIngress.status, "processing"),
              lt(feishuChatIngress.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning({ id: feishuChatIngress.id });
    return claimed !== undefined;
  },
);

type ClaimedFeishuIngress = Pick<
  typeof feishuChatIngress.$inferSelect,
  "installationId" | "payload" | "reactionId" | "createdAt"
> &
  Pick<
    typeof feishuOrgInstallations.$inferSelect,
    | "orgId"
    | "ownerUserId"
    | "appId"
    | "platform"
    | "botName"
    | "messageReceivedAt"
  > & {
    ingressId: typeof feishuChatIngress.$inferSelect.id;
    defaultAgentId: typeof orgMetadata.$inferSelect.defaultAgentId;
  };

function parseMatchingMessage(
  ingress: ClaimedFeishuIngress,
): CanonicalFeishuInboundMessage {
  const message = feishuInboundMessageSchema.parse(
    JSON.parse(ingress.payload) as unknown,
  );
  if (
    message.installationId !== ingress.installationId ||
    message.appId !== ingress.appId
  ) {
    throw new Error(
      "Canonical Feishu ingress payload does not match installation",
    );
  }
  return { ...message, platform: ingress.platform };
}

const loadConnection$ = command(
  async (
    { get },
    orgId: string,
    message: CanonicalFeishuInboundMessage,
  ): Promise<FeishuDispatchConnection | undefined> => {
    const db = get(db$);
    const [connection] = await db
      .select({
        id: feishuOrgConnections.id,
        userId: feishuOrgConnections.userId,
        connectorId: feishuOrgConnections.connectorId,
        feishuUserName: feishuOrgConnections.feishuUserName,
      })
      .from(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.installationId, message.installationId),
          eq(feishuOrgConnections.feishuOpenId, message.openId),
        ),
      )
      .limit(1);
    if (!connection) {
      return undefined;
    }
    const connectorId = await (async () => {
      const scope = {
        orgId,
        userId: connection.userId,
        installationId: message.installationId,
        memberConnectorId: connection.connectorId,
        feishuOpenId: message.openId,
      };
      const memberPlan = feishuOAuthMemberReadPlan(scope);
      const memberRows = memberPlan.needsRead
        ? await db
            .select(memberPlan.columns)
            .from(feishuOrgConnections)
            .where(memberPlan.condition)
            .limit(2)
        : [];
      const member = feishuOAuthMemberFromRows(scope, memberRows);
      if (!member) {
        return null;
      }
      const installationPlan = feishuOAuthInstallationReadPlan(scope);
      const [installation] = await db
        .select(installationPlan.columns)
        .from(feishuOrgInstallations)
        .where(installationPlan.condition)
        .limit(1);
      const customConnectorId = installation?.customConnectorId;
      if (!customConnectorId) {
        return null;
      }
      const accountScope = { ...scope, ...member, customConnectorId };
      const accountPlan = feishuOAuthAccountReadPlan(accountScope);
      const [exactRows, defaultRows] = await Promise.all([
        accountPlan.exactWhere
          ? db
              .select(accountPlan.columns)
              .from(connectors)
              .where(accountPlan.exactWhere)
          : [],
        accountPlan.defaultWhere
          ? db
              .select(accountPlan.columns)
              .from(connectors)
              .where(accountPlan.defaultWhere)
          : [],
      ]);
      const accountId = feishuOAuthAccountFromRows(accountPlan, {
        exactRows,
        defaultRows,
      });
      if (accountId === null) {
        return null;
      }
      const credentialPlan = feishuOAuthCredentialReadPlan({
        ...accountScope,
        memberConnectorId: accountId,
      });
      const [matchedConnection] = await db
        .select(credentialPlan.columns)
        .from(connectors)
        .innerJoin(orgCustomConnectors, credentialPlan.connectorJoin)
        .innerJoin(secrets, credentialPlan.secretJoin)
        .where(credentialPlan.condition)
        .limit(1);
      return matchedConnection?.id ?? null;
    })();
    return connectorId ? { ...connection, connectorId } : undefined;
  },
);

const markIngressFailed$ = command(
  async ({ set }, ingressId: string, error: unknown): Promise<void> => {
    const db = set(writeDb$);
    const message = error instanceof Error ? error.message : "Unknown error";
    await db
      .update(feishuChatIngress)
      .set({
        status: "failed",
        lastError: message.slice(0, 4000),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(feishuChatIngress.id, ingressId),
          eq(feishuChatIngress.status, "processing"),
        ),
      );
  },
);

interface PersistedCanonicalFeishuIngress {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly message: CanonicalFeishuInboundMessage;
  readonly receivedAt: Date;
}

interface CanonicalFeishuLaunchContext {
  readonly conversationHistory: string;
  readonly messageText: string;
  readonly messageFiles: {
    readonly fileId: string;
    readonly messageId: string;
    readonly fileKey: string;
    readonly type: "file" | "image";
  }[];
  readonly chatType: "group" | "p2p" | "topic_group";
  readonly chatId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly replyInThread: boolean;
  readonly reactionId: string | null;
  readonly senderOpenId: string;
  readonly connectionId: string;
  readonly installationId: string;
}

function canonicalFeishuLaunchContext(args: {
  readonly message: CanonicalFeishuInboundMessage;
  readonly connectionId: string;
  readonly reactionId: string | undefined;
  readonly conversationHistory: string;
  readonly files: readonly FeishuPromptFile[];
}): CanonicalFeishuLaunchContext {
  return {
    conversationHistory: args.conversationHistory,
    messageText: args.message.promptText,
    messageFiles: [...args.message.files, ...args.files].map((file) => {
      return {
        fileId: file.fileId,
        messageId: file.messageId,
        fileKey: file.fileKey,
        type: file.type,
      };
    }),
    chatType: args.message.chatType,
    chatId: args.message.chatId,
    messageId: args.message.messageId,
    threadId:
      args.message.threadId ??
      args.message.rootId ??
      args.message.parentId ??
      args.message.messageId,
    replyInThread: true,
    reactionId: args.reactionId ?? null,
    senderOpenId: args.message.openId,
    connectionId: args.connectionId,
    installationId: args.message.installationId,
  };
}

function feishuInboundUserMessage(
  message: CanonicalFeishuInboundMessage,
  chatOpenUrl: string,
  assets: readonly IntegrationInputAsset[],
) {
  return createUserMessageDocument({
    text: message.files.length
      ? formatFeishuMessageContent(
          {
            text: message.text,
            files: message.files.filter((file) => {
              return !readyIntegrationInputAsset(assets, file.fileId);
            }),
          },
          message.platform,
        )
      : message.promptText,
    files: integrationInputMessageFiles(assets),
    nonContentPart: createChatEventSourcePart({
      kind: message.platform,
      chatOpenUrl,
    }),
  });
}

function feishuInputFiles(
  message: CanonicalFeishuInboundMessage,
  platform: FeishuPlatform,
): readonly IntegrationInputFile[] {
  return message.files.map((file) => {
    return {
      sourceId: file.fileId,
      filename: file.filename,
      contentType: inferMimetype(file.filename),
      provenance: {
        provider: platform,
        installationId: message.installationId,
        messageId: message.messageId,
        externalFileId: `${file.type}:${file.fileKey}`,
      },
      resource: {
        provider: platform,
        installationId: message.installationId,
        messageId: file.messageId,
        fileKey: file.fileKey,
        resourceType: file.type,
      },
    };
  });
}

const persistCanonicalFeishuIngress$ = command(
  async (
    { set },
    args: {
      readonly ingress: ClaimedFeishuIngress;
      readonly installation: FeishuDispatchInstallation;
      readonly connection: FeishuDispatchConnection;
      readonly message: CanonicalFeishuInboundMessage;
      readonly agentId: string;
      readonly reactionId: string | undefined;
      readonly launchContext: CanonicalFeishuLaunchContext;
    },
    signal: AbortSignal,
  ): Promise<PersistedCanonicalFeishuIngress> => {
    const routeThreadId = feishuRouteThreadId(args.message);
    const route = await set(
      ensureFeishuChatThreadRoute$,
      {
        initialModel: await set(
          resolveDefaultModelFirstPin$,
          {
            orgId: args.installation.orgId,
            userId: args.connection.userId,
            orgPlanCapabilities: undefined,
          },
          signal,
        ),
        connectionId: args.connection.id,
        chatId: args.message.chatId,
        threadId: routeThreadId,
        userId: args.connection.userId,
        orgId: args.installation.orgId,
        agentId: args.agentId,
        currentTime: args.ingress.createdAt,
      },
      signal,
    );
    signal.throwIfAborted();

    const assets = await set(
      materializeIntegrationInputAssets$,
      {
        userId: args.connection.userId,
        orgId: args.installation.orgId,
        chatThreadId: route.chatThreadId,
        files: feishuInputFiles(args.message, args.ingress.platform),
      },
      signal,
    );
    const messageText = args.message.files.reduce((prompt, file) => {
      const asset = readyIntegrationInputAsset(assets, file.fileId);
      return asset
        ? prompt.replace(
            formatFeishuMessageContent(
              { text: "", files: [file] },
              args.message.platform,
            ),
            () => {
              return canonicalInputFilePrompt(asset);
            },
          )
        : prompt;
    }, args.message.promptText);

    const chatOpenUrl = buildFeishuChatOpenUrl(
      args.message.chatId,
      args.message.platform,
    );
    const enqueuedModel = await set(
      resolveEnqueuedChatInputModel$,
      {
        threadId: route.chatThreadId,
        orgId: args.installation.orgId,
        userId: args.connection.userId,
      },
      signal,
    );
    const values = {
      id: args.ingress.ingressId,
      chatThreadId: route.chatThreadId,
      eventType: "input.prompt",
      modelSelection: enqueuedModel.modelSelection,
      userMessage: feishuInboundUserMessage(args.message, chatOpenUrl, assets),
      runId: null,
      feishuContext: {
        ...args.launchContext,
        messageText,
      },
      createdAt: args.ingress.createdAt,
    } as const;
    await set(
      enqueueIntegrationChatInput$,
      {
        orgId: args.installation.orgId,
        input: values,
        threadModelReplacement: enqueuedModel.threadModelReplacement,
        ingress: { kind: "feishu", ingressId: args.ingress.ingressId },
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      orgId: args.installation.orgId,
      userId: args.connection.userId,
      chatThreadId: route.chatThreadId,
      message: args.message,
      receivedAt: args.ingress.createdAt,
    };
  },
);

/** Tell the sender when their message waits for an org run slot. */
const notifyFeishuChatQueueWait$ = command(
  async (
    { set },
    args: {
      readonly ingressId: string;
      readonly message: CanonicalFeishuInboundMessage;
      readonly reason: ChatQueueWaitReason;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const notice = chatQueueWaitNotice(args.reason);
    if (!notice) {
      return;
    }
    const message = buildFeishuNoticeMessage({
      title: "Waiting for a run slot",
      text: notice,
      kind: "warning",
    });
    await set(
      replyWithFeishuMessage$,
      {
        installationId: args.message.installationId,
        messageId: args.message.messageId,
        message,
        replyInThread: true,
        idempotencyKey: `queued-${args.ingressId}`,
      },
      signal,
    );
  },
);

const finishUnconnectedFeishuIngress$ = command(
  async (
    { set },
    args: {
      readonly ingressId: string;
      readonly message: CanonicalFeishuInboundMessage;
      readonly botName: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await set(
      replyToUnconnectedFeishuMessage$,
      {
        message: args.message,
        botName: args.botName,
      },
      signal,
    );
    signal.throwIfAborted();
    const processedIngressDb = db;
    const processedIngressId = args.ingressId;
    await (async (): Promise<void> => {
      await processedIngressDb
        .update(feishuChatIngress)
        .set({ status: "processed", lastError: null, updatedAt: nowDate() })
        .where(
          and(
            eq(feishuChatIngress.id, processedIngressId),
            eq(feishuChatIngress.status, "processing"),
          ),
        );
    })();
  },
);

const finishUnavailableAgentFeishuIngress$ = command(
  async (
    { set },
    args: {
      readonly ingressId: string;
      readonly message: CanonicalFeishuInboundMessage;
      readonly status: "not_accessible" | "not_found";
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await set(
      replyFeishuAgentUnavailable$,
      { message: args.message, status: args.status },
      signal,
    );
    signal.throwIfAborted();
    const processedIngressDb = db;
    const processedIngressId = args.ingressId;
    await (async (): Promise<void> => {
      await processedIngressDb
        .update(feishuChatIngress)
        .set({ status: "processed", lastError: null, updatedAt: nowDate() })
        .where(
          and(
            eq(feishuChatIngress.id, processedIngressId),
            eq(feishuChatIngress.status, "processing"),
          ),
        );
    })();
  },
);

const loadFeishuIngressDispatchContext$ = command(
  async ({ set }, ingressId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const claimedIngressDb = db;
    const claimedIngressId = ingressId;
    const ingress = await (async () => {
      const [row] = await claimedIngressDb
        .select({
          ingressId: feishuChatIngress.id,
          installationId: feishuChatIngress.installationId,
          payload: feishuChatIngress.payload,
          reactionId: feishuChatIngress.reactionId,
          createdAt: feishuChatIngress.createdAt,
          orgId: feishuOrgInstallations.orgId,
          ownerUserId: feishuOrgInstallations.ownerUserId,
          appId: feishuOrgInstallations.appId,
          platform: feishuOrgInstallations.platform,
          defaultAgentId: orgMetadata.defaultAgentId,
          botName: feishuOrgInstallations.botName,
          messageReceivedAt: feishuOrgInstallations.messageReceivedAt,
        })
        .from(feishuChatIngress)
        .innerJoin(
          feishuOrgInstallations,
          eq(feishuOrgInstallations.id, feishuChatIngress.installationId),
        )
        .leftJoin(
          orgMetadata,
          eq(orgMetadata.orgId, feishuOrgInstallations.orgId),
        )
        .where(
          and(
            eq(feishuChatIngress.id, claimedIngressId),
            eq(feishuChatIngress.status, "processing"),
          ),
        )
        .limit(1);
      return row;
    })();
    signal.throwIfAborted();
    if (!ingress) {
      throw new Error("Canonical Feishu ingress is unavailable");
    }
    if (
      !(await (async () => {
        const plan = feishuInstallationAvailabilityReadPlan(ingress);
        if (plan.kind === "resolved") {
          return plan.enabled;
        }
        const rows = await db
          .select(plan.columns)
          .from(userFeatureSwitches)
          .where(plan.condition);
        return feishuInstallationEnabledFromRows(plan.scope, rows);
      })())
    ) {
      throw new Error("Lark integration is not enabled");
    }
    const message = parseMatchingMessage(ingress);
    if (ingress.defaultAgentId === null) {
      return { ingress, message, installation: null, connection: null };
    }
    const installation: FeishuDispatchInstallation = {
      orgId: ingress.orgId,
      platform: ingress.platform,
      ownerUserId: ingress.ownerUserId,
      defaultAgentId: ingress.defaultAgentId,
      botName: ingress.botName,
      messageReceivedAt: ingress.messageReceivedAt,
    };
    const receiptArgs = { installation, message };
    await (async () => {
      if (receiptArgs.installation.messageReceivedAt) {
        return;
      }
      const [markedAsReceived] = await db
        .update(feishuOrgInstallations)
        .set(feishuMessageReceivedValues(receiptArgs.message.tenantKey))
        .where(
          feishuMessageReceivedCondition(receiptArgs.message.installationId),
        )
        .returning({ id: feishuOrgInstallations.id });
      signal.throwIfAborted();
      if (markedAsReceived) {
        await (async () => {
          const plan = feishuOrgChangedAdminReadPlan(
            receiptArgs.installation.orgId,
          );
          const admins = await db
            .select(plan.columns)
            .from(orgMembersCache)
            .where(plan.condition);
          const userIds = feishuOrgChangedUserIds(
            admins,
            receiptArgs.installation.ownerUserId,
          );
          if (userIds.length === 0) {
            return;
          }
          await publishUserSignal(userIds, "feishu:changed");
        })();
      }
    })();
    signal.throwIfAborted();
    const connection = await set(loadConnection$, ingress.orgId, message);
    signal.throwIfAborted();
    return { ingress, message, installation, connection };
  },
);

const addFeishuThinkingReaction$ = command(
  async (
    { set },
    message: FeishuInboundMessage,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const db = set(writeDb$);
    const creationArgs = {
      installationId: message.installationId,
      messageId: message.messageId,
      emojiType: FEISHU_THINKING_EMOJI,
    };
    const creationSignal = signal;
    const createdReactionId = await tapError(
      (async () => {
        const addReactionContextArgs = creationArgs;
        const addReactionContextSignal = creationSignal;
        const { token, apiOrigin, providerName } = await (async () => {
          const [installation] = await db
            .select()
            .from(feishuOrgInstallations)
            .where(
              eq(
                feishuOrgInstallations.id,
                addReactionContextArgs.installationId,
              ),
            )
            .limit(1);
          addReactionContextSignal.throwIfAborted();
          if (!installation) {
            throw new Error("Bot installation not found");
          }
          if (
            !(await (async () => {
              const plan = feishuInstallationAvailabilityReadPlan(installation);
              if (plan.kind === "resolved") {
                return plan.enabled;
              }
              const rows = await db
                .select(plan.columns)
                .from(userFeatureSwitches)
                .where(plan.condition);
              return feishuInstallationEnabledFromRows(plan.scope, rows);
            })())
          ) {
            throw new FeishuApiError("Lark integration is not enabled", 403);
          }
          const credentials = await resolveFeishuRequestCredentials(
            installation,
            addReactionContextSignal,
          );
          if (credentials.refreshedToken) {
            await db
              .update(feishuOrgInstallations)
              .set(feishuTokenUpdateValues(credentials.refreshedToken))
              .where(
                eq(
                  feishuOrgInstallations.id,
                  addReactionContextArgs.installationId,
                ),
              );
            addReactionContextSignal.throwIfAborted();
          }
          return credentials.context;
        })();
        const response = fetch(
          feishuReactionCreationUrl(apiOrigin, creationArgs.messageId),
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({
              reaction_type: { emoji_type: creationArgs.emojiType },
            }),
          },
        );
        return parseFeishuReactionCreationResponse(
          await readFeishuResponseJson(response, providerName),
          providerName,
        );
      })(),
      (error) => {
        feishuDispatchL.warn("Failed to set Feishu thinking indicator", {
          error,
          messageId: message.messageId,
        });
      },
    );
    signal.throwIfAborted();
    return createdReactionId;
  },
);

const loadFeishuHistory$ = command(
  async (
    { set },
    args: {
      readonly installationId: string;
      readonly containerType: "chat" | "thread";
      readonly containerId: string;
    },
    signal: AbortSignal,
  ): Promise<readonly FeishuHistoryMessage[]> => {
    const history = await tapError(
      (async () => {
        const db = set(writeDb$);
        const historyContextArgs = args;
        const historyContextSignal = signal;
        const { token, apiOrigin, providerName } = await (async () => {
          const [installation] = await db
            .select()
            .from(feishuOrgInstallations)
            .where(
              eq(feishuOrgInstallations.id, historyContextArgs.installationId),
            )
            .limit(1);
          historyContextSignal.throwIfAborted();
          if (!installation) {
            throw new Error("Bot installation not found");
          }
          if (
            !(await (async () => {
              const plan = feishuInstallationAvailabilityReadPlan(installation);
              if (plan.kind === "resolved") {
                return plan.enabled;
              }
              const rows = await db
                .select(plan.columns)
                .from(userFeatureSwitches)
                .where(plan.condition);
              return feishuInstallationEnabledFromRows(plan.scope, rows);
            })())
          ) {
            throw new FeishuApiError("Lark integration is not enabled", 403);
          }
          const credentials = await resolveFeishuRequestCredentials(
            installation,
            historyContextSignal,
          );
          if (credentials.refreshedToken) {
            await db
              .update(feishuOrgInstallations)
              .set(feishuTokenUpdateValues(credentials.refreshedToken))
              .where(
                eq(
                  feishuOrgInstallations.id,
                  historyContextArgs.installationId,
                ),
              );
            historyContextSignal.throwIfAborted();
          }
          return credentials.context;
        })();
        const url = feishuMessageHistoryUrl(apiOrigin, args);
        const response = fetch(url, {
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
        });
        return parseFeishuMessageHistoryResponse(
          await readFeishuResponseJson(response, providerName),
          providerName,
        );
      })(),
      (error) => {
        feishuDispatchL.warn("Failed to load Feishu conversation history", {
          error,
          installationId: args.installationId,
          containerType: args.containerType,
          containerId: args.containerId,
        });
      },
    );
    signal.throwIfAborted();
    return history ?? [];
  },
);

const loadFeishuConversationHistory$ = command(
  async (
    { set },
    args: { readonly message: FeishuInboundMessage },
    signal: AbortSignal,
  ) => {
    const { message } = args;
    const [history, threadHistory] = await Promise.all([
      set(
        loadFeishuHistory$,
        {
          installationId: message.installationId,
          containerType: "chat",
          containerId: message.chatId,
        },
        signal,
      ),
      message.chatType !== "p2p" && message.threadId
        ? set(
            loadFeishuHistory$,
            {
              installationId: message.installationId,
              containerType: "thread",
              containerId: message.threadId,
            },
            signal,
          )
        : Promise.resolve([]),
    ]);
    signal.throwIfAborted();
    return formatFeishuConversationHistory(history, message, threadHistory);
  },
);

const processClaimedIngress$ = command(
  async (
    { set },
    args: {
      readonly ingressId: string;
    },
    signal: AbortSignal,
  ): Promise<PersistedCanonicalFeishuIngress | null> => {
    const db = set(writeDb$);
    const { ingress, message, installation, connection } = await set(
      loadFeishuIngressDispatchContext$,
      args.ingressId,
      signal,
    );
    if (!installation) {
      await set(
        finishUnavailableAgentFeishuIngress$,
        {
          ingressId: ingress.ingressId,
          message,
          status: "not_found",
        },
        signal,
      );
      return null;
    }
    if (!connection) {
      await set(
        finishUnconnectedFeishuIngress$,
        {
          ingressId: ingress.ingressId,
          message,
          botName: installation.botName,
        },
        signal,
      );
      return null;
    }

    const commandHandled = await set(
      dispatchConnectedFeishuCommand$,
      { installation, connection, message },
      signal,
    );
    signal.throwIfAborted();
    if (commandHandled) {
      await db
        .update(feishuChatIngress)
        .set({ status: "processed", lastError: null, updatedAt: nowDate() })
        .where(
          and(
            eq(feishuChatIngress.id, ingress.ingressId),
            eq(feishuChatIngress.status, "processing"),
          ),
        );
      signal.throwIfAborted();
      return null;
    }

    const effectiveAgent = await (async () => {
      const plan = feishuEffectiveAgentReadPlan({ installation, connection });
      const agent = await (async () => {
        const [visibleAgent] = await db
          .select(plan.visibleColumns)
          .from(agents)
          .where(plan.visibleCondition)
          .limit(1);
        return visibleAgent;
      })();
      if (agent) {
        return feishuEffectiveAgentFromRows(agent, undefined);
      }
      const [existing] = await db
        .select(plan.existingColumns)
        .from(agents)
        .where(plan.existingCondition)
        .limit(1);
      return feishuEffectiveAgentFromRows(agent, existing);
    })();
    signal.throwIfAborted();
    if (effectiveAgent.status !== "resolved") {
      await set(
        finishUnavailableAgentFeishuIngress$,
        {
          ingressId: ingress.ingressId,
          message,
          status: effectiveAgent.status,
        },
        signal,
      );
      return null;
    }

    const reactionId =
      ingress.reactionId ??
      (await set(addFeishuThinkingReaction$, message, signal));
    signal.throwIfAborted();
    if (reactionId && reactionId !== ingress.reactionId) {
      await db
        .update(feishuChatIngress)
        .set({ reactionId, updatedAt: nowDate() })
        .where(eq(feishuChatIngress.id, ingress.ingressId));
    }
    const history = await (async () => {
      const read = set(loadFeishuConversationHistory$, { message }, signal);
      const result = await settle(read, signal);
      return resolveOptionalChatEnrichment("feishu", result, () => {
        return { text: "", files: [] };
      });
    })();
    signal.throwIfAborted();
    const persistInput = {
      ingress,
      installation,
      connection,
      message,
      agentId: effectiveAgent.agent.id,
      reactionId,
      launchContext: canonicalFeishuLaunchContext({
        message,
        connectionId: connection.id,
        reactionId,
        conversationHistory: history.text,
        files: history.files,
      }),
    };
    return await set(persistCanonicalFeishuIngress$, persistInput, signal);
  },
);

export const processCanonicalFeishuIngress$ = command(
  async (
    { set },
    args: { readonly ingressId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const claimed = await set(claimIngress$, args.ingressId, nowDate());
    signal.throwIfAborted();
    if (!claimed) {
      return false;
    }

    const result = await settle(
      set(
        processClaimedIngress$,
        {
          ingressId: args.ingressId,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      await set(markIngressFailed$, args.ingressId, result.error);
      signal.throwIfAborted();
      L.error("Failed to process canonical Feishu ingress", {
        ingressId: args.ingressId,
        error: result.error,
      });
      throw result.error;
    }
    if (!result.value) {
      return true;
    }
    L.debug("Canonical Feishu ingress persisted", {
      type: "canonical_feishu_ingress_processing",
      ingressId: args.ingressId,
      endToEndDurationMs: Math.max(
        0,
        now() - result.value.receivedAt.getTime(),
      ),
      success: true,
    });

    const persisted = result.value;
    waitUntil(
      (async () => {
        const picked = await settle(
          set(
            pickEnqueuedChatThread$,
            {
              orgId: persisted.orgId,
              chatThreadId: persisted.chatThreadId,
            },
            signal,
          ),
        );
        await set(
          touchNativeChatThread$,
          {
            chatThreadId: persisted.chatThreadId,
            createdAt: persisted.receivedAt,
            eventId: args.ingressId,
          },
          signal,
        );
        await publishThreadListChangedSafely({
          userId: persisted.userId,
          orgId: persisted.orgId,
        });
        await publishChatThreadMessageCreatedSafely({
          userId: persisted.userId,
          orgId: persisted.orgId,
          threadId: persisted.chatThreadId,
        });
        const noticed = await settle(
          (async () => {
            const pick = await set(
              enqueuedChatQueueWaitReason$,
              {
                orgId: persisted.orgId,
                chatThreadId: persisted.chatThreadId,
                eventId: args.ingressId,
              },
              signal,
            );
            await set(
              notifyFeishuChatQueueWait$,
              {
                ingressId: args.ingressId,
                message: persisted.message,
                reason: pick.reason,
              },
              signal,
            );
          })(),
        );
        if (!picked.ok && !noticed.ok) {
          throw new AggregateError(
            [picked.error, noticed.error],
            "Enqueued chat thread pick and wait notice failed",
          );
        }
        if (!picked.ok) {
          throw picked.error;
        }
        if (!noticed.ok) {
          throw noticed.error;
        }
      })(),
    );
    waitUntil(
      set(notifyRunningChatRunOfPendingInput$, persisted.chatThreadId, signal),
    );
    return true;
  },
);

export const drainStaleCanonicalFeishuIngress$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const staleBefore = new Date(
      nowDate().getTime() - PROCESSING_STALE_AFTER_MS,
    );
    const rows = await db
      .select({ id: feishuChatIngress.id })
      .from(feishuChatIngress)
      .where(
        or(
          inArray(feishuChatIngress.status, ["pending", "failed"]),
          and(
            eq(feishuChatIngress.status, "processing"),
            lt(feishuChatIngress.updatedAt, staleBefore),
          ),
        ),
      )
      .orderBy(
        asc(feishuChatIngress.updatedAt),
        asc(feishuChatIngress.createdAt),
        asc(feishuChatIngress.id),
      )
      .limit(SWEEP_LIMIT);
    signal.throwIfAborted();

    let processed = 0;
    for (const row of rows) {
      const result = await settle(
        set(processCanonicalFeishuIngress$, { ingressId: row.id }, signal),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok && result.value) {
        processed++;
      }
    }
    return processed;
  },
);
