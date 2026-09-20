import { command } from "ccstate";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { feishuChatIngress } from "@okouai/db/schema/feishu-chat-ingress";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { and, asc, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { FeishuPlatform } from "@okouai/api-contracts/contracts/feishu-platform";
import { logger } from "../../lib/log";
import { env } from "../../lib/env";
import { buildFeishuNoticeMessage } from "../../lib/feishu-message-card";
import { inferMimetype } from "../../lib/mimetype";
import {
  formatFeishuMessageContent,
  type FeishuPromptFile,
} from "../../lib/feishu-message-content";
import {
  replyWithFeishuMessage,
  downloadFeishuMessageResource,
} from "../external/feishu-client";
import {
  canonicalInputFilePrompt,
  integrationInputMessageFiles,
  materializeIntegrationInputAssets$,
  readyIntegrationInputAsset,
  type IntegrationInputFile,
  type IntegrationInputAsset,
} from "./integration-input-assets.service";
import { now, nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import {
  isFeishuInstallationEnabled,
  buildFeishuChatOpenUrl,
} from "./feishu-config";
import { ensureFeishuChatThreadRoute } from "./feishu-chat-ingress.service";
import { resolveFeishuCustomConnectorOAuthConnection } from "./feishu-custom-connector.service";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { touchChatThreadLastMessageAt } from "./chat-event-shared.service";
import { insertChatEvent } from "./chat-event.service";
import { chatInputPromptDispatchCondition } from "./chat-event-type.service";
import { createChatEventSourcePart } from "./chat-event-annotation.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import {
  addFeishuThinkingReaction,
  dispatchConnectedFeishuCommand$,
  loadFeishuConversationHistory,
  markFeishuMessageReceived,
  replyFeishuAgentUnavailable,
  replyToUnconnectedFeishuMessage,
  resolveEffectiveFeishuAgent,
  type FeishuDispatchConnection,
  type FeishuDispatchInstallation,
  type FeishuInboundMessage,
} from "./feishu-dispatch.service";
import { integrationDmSessionKey } from "../../lib/integration-dm-session";

const L = logger("CanonicalFeishuIngressProcessor");
const PROCESSING_STALE_AFTER_MS = 5 * 60 * 1000;
const SWEEP_LIMIT = 20;

const feishuPromptFileSchema = z.object({
  fileId: z.string(),
  messageId: z.string(),
  fileKey: z.string(),
  type: z.enum(["file", "image"]),
  filename: z.string(),
});

const feishuInboundMessageSchema = z.object({
  installationId: z.string(),
  eventId: z.string(),
  tenantKey: z.string(),
  appId: z.string(),
  messageId: z.string(),
  chatId: z.string(),
  chatType: z.enum(["group", "p2p", "topic_group"]),
  rootId: z.string().nullable(),
  parentId: z.string().nullable(),
  threadId: z.string().nullable(),
  openId: z.string(),
  text: z.string(),
  promptText: z.string(),
  files: z.array(feishuPromptFileSchema),
});

interface CanonicalFeishuInboundMessage extends FeishuInboundMessage {
  readonly platform: FeishuPlatform;
}

function canonicalThreadId(args: {
  readonly message: CanonicalFeishuInboundMessage;
  readonly agentId: string;
  readonly selectedModel: string | null;
  readonly serviceTier: IntegrationModelRoutePin["serviceTier"];
}): string {
  const { message } = args;
  const replyThreadId =
    message.rootId ?? message.threadId ?? message.parentId ?? null;
  if (message.chatType === "p2p") {
    if (message.threadId) {
      return `thread:${message.threadId}`;
    }
    return integrationDmSessionKey(args);
  }
  return replyThreadId ?? message.messageId;
}

async function claimIngress(
  db: Db,
  ingressId: string,
  currentTime: Date,
): Promise<boolean> {
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
}

async function loadClaimedIngress(db: Db, ingressId: string) {
  const [row] = await db
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
      defaultAgentId: feishuOrgInstallations.defaultAgentId,
      botName: feishuOrgInstallations.botName,
      messageReceivedAt: feishuOrgInstallations.messageReceivedAt,
      publicBrand: feishuChatIngress.publicBrand,
    })
    .from(feishuChatIngress)
    .innerJoin(
      feishuOrgInstallations,
      eq(feishuOrgInstallations.id, feishuChatIngress.installationId),
    )
    .where(
      and(
        eq(feishuChatIngress.id, ingressId),
        eq(feishuChatIngress.status, "processing"),
      ),
    )
    .limit(1);
  return row;
}

function resolveFeishuIngressPublicBrand(
  ingress: NonNullable<Awaited<ReturnType<typeof loadClaimedIngress>>>,
): PublicBrand {
  if (ingress.publicBrand === null) {
    throw new Error("Canonical Feishu ingress has no public brand");
  }
  return ingress.publicBrand;
}

function parseMatchingMessage(
  ingress: NonNullable<Awaited<ReturnType<typeof loadClaimedIngress>>>,
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

async function loadConnection(
  db: Db,
  orgId: string,
  message: CanonicalFeishuInboundMessage,
): Promise<FeishuDispatchConnection | undefined> {
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
  const connectorId = await resolveFeishuCustomConnectorOAuthConnection(db, {
    orgId,
    userId: connection.userId,
    installationId: message.installationId,
    memberConnectorId: connection.connectorId,
    feishuOpenId: message.openId,
  });
  return connectorId ? { ...connection, connectorId } : undefined;
}

async function markIngressProcessed(db: Db, ingressId: string): Promise<void> {
  await db
    .update(feishuChatIngress)
    .set({ status: "processed", lastError: null, updatedAt: nowDate() })
    .where(
      and(
        eq(feishuChatIngress.id, ingressId),
        eq(feishuChatIngress.status, "processing"),
      ),
    );
}

async function markIngressFailed(
  db: Db,
  ingressId: string,
  error: unknown,
): Promise<void> {
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
}

interface PersistedCanonicalFeishuIngress {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly message: CanonicalFeishuInboundMessage;
  readonly receivedAt: Date;
  readonly publicBrand: PublicBrand;
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
  readonly publicBrand: PublicBrand;
}

function canonicalFeishuLaunchContext(args: {
  readonly message: CanonicalFeishuInboundMessage;
  readonly connectionId: string;
  readonly reactionId: string | undefined;
  readonly conversationHistory: string;
  readonly files: readonly FeishuPromptFile[];
  readonly publicBrand: PublicBrand;
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
    publicBrand: args.publicBrand,
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
  db: Db,
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
      download: (downloadSignal: AbortSignal) => {
        return downloadFeishuMessageResource(
          {
            db: db,
            installationId: message.installationId,
            messageId: file.messageId,
            fileKey: file.fileKey,
            resourceType: file.type,
          },
          downloadSignal,
        );
      },
    };
  });
}

const persistCanonicalFeishuIngress$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly ingress: NonNullable<
        Awaited<ReturnType<typeof loadClaimedIngress>>
      >;
      readonly installation: FeishuDispatchInstallation;
      readonly connection: FeishuDispatchConnection;
      readonly message: CanonicalFeishuInboundMessage;
      readonly agentId: string;
      readonly selectedModel: string | null;
      readonly serviceTier: IntegrationModelRoutePin["serviceTier"];
      readonly reactionId: string | undefined;
      readonly launchContext: CanonicalFeishuLaunchContext;
    },
    signal: AbortSignal,
  ): Promise<PersistedCanonicalFeishuIngress> => {
    const routeThreadId = canonicalThreadId({
      message: args.message,
      agentId: args.agentId,
      selectedModel: args.selectedModel,
      serviceTier: args.serviceTier,
    });
    const route = await ensureFeishuChatThreadRoute(args.db, {
      connectionId: args.connection.id,
      chatId: args.message.chatId,
      threadId: routeThreadId,
      userId: args.connection.userId,
      orgId: args.installation.orgId,
      agentId: args.agentId,
      selectedModel: args.selectedModel,
      serviceTier: args.serviceTier,
      currentTime: args.ingress.createdAt,
    });
    signal.throwIfAborted();

    const assets = await set(
      materializeIntegrationInputAssets$,
      {
        userId: args.connection.userId,
        orgId: args.installation.orgId,
        chatThreadId: route.chatThreadId,
        publicBrand: args.installation.publicBrand,
        files: feishuInputFiles(args.db, args.message, args.ingress.platform),
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

    await args.db.transaction(async (tx) => {
      const chatOpenUrl = buildFeishuChatOpenUrl(
        args.message.chatId,
        args.message.platform,
      );
      const inserted = await insertChatEvent(
        tx,
        {
          id: args.ingress.ingressId,
          chatThreadId: route.chatThreadId,
          eventType: "input.prompt",
          userMessage: feishuInboundUserMessage(
            args.message,
            chatOpenUrl,
            assets,
          ),
          runId: null,
          feishuContext: {
            ...args.launchContext,
            messageText,
          },
          createdAt: args.ingress.createdAt,
        },
        "id",
      );
      signal.throwIfAborted();
      if (!inserted) {
        throw new Error("Canonical Feishu ingress message already exists");
      }
      await touchChatThreadLastMessageAt(
        tx,
        route.chatThreadId,
        args.ingress.createdAt,
        args.ingress.ingressId,
      );
      signal.throwIfAborted();
      await tx
        .update(feishuChatIngress)
        .set({ status: "processed", lastError: null, updatedAt: nowDate() })
        .where(
          and(
            eq(feishuChatIngress.id, args.ingress.ingressId),
            eq(feishuChatIngress.status, "processing"),
          ),
        );
    });
    signal.throwIfAborted();
    return {
      orgId: args.installation.orgId,
      userId: args.connection.userId,
      chatThreadId: route.chatThreadId,
      message: args.message,
      receivedAt: args.ingress.createdAt,
      publicBrand: args.installation.publicBrand,
    };
  },
);

async function notifyQueuedFeishuRun(
  args: {
    readonly db: Db;
    readonly ingressId: string;
    readonly message: CanonicalFeishuInboundMessage;
  },
  signal: AbortSignal,
): Promise<void> {
  const [run] = await args.db
    .select({ status: agentRuns.status })
    .from(chatEvents)
    .innerJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
    .where(chatInputPromptDispatchCondition({ eventId: args.ingressId }))
    .limit(1);
  signal.throwIfAborted();
  if (run?.status !== "queued") {
    return;
  }
  const message = buildFeishuNoticeMessage({
    title: "Run queued",
    text: `Concurrency limit reached. Will start automatically when a slot is available.\n\n[View queue](${env("APP_URL")}/?queue=1)`,
    kind: "warning",
  });
  await replyWithFeishuMessage(
    {
      db: args.db,
      installationId: args.message.installationId,
      messageId: args.message.messageId,
      message,
      replyInThread: true,
      idempotencyKey: `queued-${args.ingressId}`,
    },
    signal,
  );
}

async function finishUnconnectedFeishuIngress(
  args: {
    readonly db: Db;
    readonly ingressId: string;
    readonly message: CanonicalFeishuInboundMessage;
    readonly publicBrand: PublicBrand;
    readonly botName: string | null;
  },
  signal: AbortSignal,
): Promise<void> {
  await replyToUnconnectedFeishuMessage(
    {
      db: args.db,
      message: args.message,
      publicBrand: args.publicBrand,
      botName: args.botName,
    },
    signal,
  );
  signal.throwIfAborted();
  await markIngressProcessed(args.db, args.ingressId);
}

async function finishUnavailableAgentFeishuIngress(
  args: {
    readonly db: Db;
    readonly ingressId: string;
    readonly message: CanonicalFeishuInboundMessage;
    readonly status: "not_accessible" | "not_found";
  },
  signal: AbortSignal,
): Promise<void> {
  await replyFeishuAgentUnavailable(
    { db: args.db, message: args.message, status: args.status },
    signal,
  );
  signal.throwIfAborted();
  await markIngressProcessed(args.db, args.ingressId);
}

async function loadFeishuIngressDispatchContext(
  db: Db,
  ingressId: string,
  signal: AbortSignal,
) {
  const ingress = await loadClaimedIngress(db, ingressId);
  signal.throwIfAborted();
  if (!ingress) {
    throw new Error("Canonical Feishu ingress is unavailable");
  }
  if (!(await isFeishuInstallationEnabled(db, ingress))) {
    throw new Error("Lark integration is not enabled");
  }
  const message = parseMatchingMessage(ingress);
  const publicBrand = resolveFeishuIngressPublicBrand(ingress);
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
    publicBrand,
  };
  await markFeishuMessageReceived({ db, installation, message }, signal);
  const connection = await loadConnection(db, ingress.orgId, message);
  signal.throwIfAborted();
  return { ingress, message, installation, connection };
}

const processClaimedIngress$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly ingressId: string;
    },
    signal: AbortSignal,
  ): Promise<PersistedCanonicalFeishuIngress | null> => {
    const { ingress, message, installation, connection } =
      await loadFeishuIngressDispatchContext(args.db, args.ingressId, signal);
    if (!installation) {
      await finishUnavailableAgentFeishuIngress(
        {
          db: args.db,
          ingressId: ingress.ingressId,
          message,
          status: "not_found",
        },
        signal,
      );
      return null;
    }
    if (!connection) {
      await finishUnconnectedFeishuIngress(
        {
          db: args.db,
          ingressId: ingress.ingressId,
          message,
          publicBrand: installation.publicBrand,
          botName: installation.botName,
        },
        signal,
      );
      return null;
    }

    const commandHandled = await set(
      dispatchConnectedFeishuCommand$,
      { db: args.db, installation, connection, message },
      signal,
    );
    signal.throwIfAborted();
    if (commandHandled) {
      await markIngressProcessed(args.db, ingress.ingressId);
      signal.throwIfAborted();
      return null;
    }

    const effectiveAgent = await resolveEffectiveFeishuAgent({
      db: args.db,
      installation,
      connection,
    });
    signal.throwIfAborted();
    if (effectiveAgent.status !== "resolved") {
      await finishUnavailableAgentFeishuIngress(
        {
          db: args.db,
          ingressId: ingress.ingressId,
          message,
          status: effectiveAgent.status,
        },
        signal,
      );
      return null;
    }

    const modelRoute = await set(
      resolveIntegrationModelRouteForUser$,
      { orgId: installation.orgId, userId: connection.userId },
      signal,
    );
    signal.throwIfAborted();
    const selectedModel = modelRoute?.selectedModel ?? null;
    const reactionId =
      ingress.reactionId ??
      (await addFeishuThinkingReaction(
        {
          db: args.db,
          message,
        },
        signal,
      ));
    signal.throwIfAborted();
    if (reactionId && reactionId !== ingress.reactionId) {
      await args.db
        .update(feishuChatIngress)
        .set({ reactionId, updatedAt: nowDate() })
        .where(eq(feishuChatIngress.id, ingress.ingressId));
    }
    const history = await loadFeishuConversationHistory(
      {
        db: args.db,
        message,
      },
      signal,
    );
    signal.throwIfAborted();
    const persistInput = {
      db: args.db,
      ingress,
      installation,
      connection,
      message,
      agentId: effectiveAgent.agent.id,
      selectedModel,
      serviceTier: modelRoute?.serviceTier ?? null,
      reactionId,
      launchContext: canonicalFeishuLaunchContext({
        message,
        connectionId: connection.id,
        reactionId,
        conversationHistory: history.text,
        files: history.files,
        publicBrand: installation.publicBrand,
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
    const db = set(writeDb$);
    const claimed = await claimIngress(db, args.ingressId, nowDate());
    signal.throwIfAborted();
    if (!claimed) {
      return false;
    }

    const result = await settle(
      set(
        processClaimedIngress$,
        {
          db,
          ingressId: args.ingressId,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      await markIngressFailed(db, args.ingressId, result.error);
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

    await publishChatThreadMessageCreatedSafely({
      userId: result.value.userId,
      orgId: result.value.orgId,
      threadId: result.value.chatThreadId,
    });
    signal.throwIfAborted();
    await publishThreadListChanged({
      userId: result.value.userId,
      orgId: result.value.orgId,
    });
    signal.throwIfAborted();
    await set(
      drainChatThreadQueueForThread$,
      {
        chatThreadId: result.value.chatThreadId,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();
    await notifyQueuedFeishuRun(
      {
        db,
        ingressId: args.ingressId,
        message: result.value.message,
      },
      signal,
    );
    signal.throwIfAborted();
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
