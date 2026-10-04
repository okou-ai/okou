import {
  modelCatalog$,
  type ModelCatalog,
} from "../services/model-catalog.service";
import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { billingRunAttributionWrite } from "../services/managed-usage-attribution";
import { pgTextDecoder } from "../../lib/db-structured-result";
import {
  testTelegramStateContract,
  type TestTelegramStateActionBody,
} from "@okouai/api-contracts/contracts/test-telegram-state";
import { agents } from "@okouai/db/schema/agent";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { telegramMessages } from "@okouai/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  acquireBuiltInModelKeyFixture,
  releaseBuiltInModelKeyFixture,
} from "../services/built-in-model-key-fixture";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import {
  normalizeRunMetadata,
  writeRunMetadata$,
} from "../services/agent-run-metadata-write.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { ensureAgentInstructionsStorageFixture } from "./test-agent-instructions-storage";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "../services/org-plan-entitlements.service";
import { loadSystemDefaultBuiltInVendor } from "../services/model-route-capabilities.service";

const actionBody$ = bodyResultOf(testTelegramStateContract.action);

interface TelegramPostFixtureSeed {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly versionId: string;
  readonly name: string;
}

function actionBadRequest(message: string) {
  return { status: 400 as const, body: { error: message } };
}

function actionOk(body: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...body } };
}

function readActionString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  return typeof body[key] === "string" && body[key].length > 0
    ? body[key]
    : null;
}

function readActionOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof body[key] === "string" && body[key].length > 0
    ? body[key]
    : undefined;
}

function readActionNullableString(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in body)) {
    return undefined;
  }
  return typeof body[key] === "string" ? body[key] : null;
}

function readActionStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] {
  const value = body[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => {
        return typeof item === "string" && item.length > 0;
      })
    : [];
}

function readActionBoolean(
  body: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): boolean {
  return typeof body[key] === "boolean" ? body[key] : defaultValue;
}

function readActionRecord(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = body[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredActionStrings(
  body: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = readActionString(body, key);
    if (!value) {
      return null;
    }
    values[key] = value;
  }
  return values;
}

async function seedTelegramAgent(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId?: string;
    readonly agentName?: string;
  },
): Promise<string> {
  const agentId = args.agentId ?? randomUUID();
  const agentName = args.agentName ?? `agent-${agentId.slice(0, 8)}`;

  await db.insert(agents).values({
    id: agentId,
    orgId: args.orgId,
    owner: args.userId,
    name: agentName,
    displayName: agentName,
  });
  return agentId;
}

async function seedOrgDefaultAgentForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, ["org_id", "user_id"]);
  if (!required) {
    return actionBadRequest("org_id and user_id are required");
  }
  const orgId = required.org_id!;
  const userId = required.user_id!;
  const agentId = await seedTelegramAgent(db, {
    orgId,
    userId,
    agentName: readActionOptionalString(body, "agent_name"),
  });
  signal.throwIfAborted();

  await db.transaction(async (tx) => {
    await writeOrgMetadataWithDefaultPlanEntitlement(
      tx,
      orgId,
      async (writeTx) => {
        return await writeTx
          .insert(orgMetadataCanonicalWrites)
          .values({
            orgId,
            defaultAgentId: agentId,
            tier: "limited-free-1",
            credits: 10_000,
          })
          .onConflictDoUpdate({
            target: orgMetadataCanonicalWrites.orgId,
            set: {
              defaultAgentId: agentId,
              tier: "limited-free-1",
              credits: 10_000,
            },
          })
          .returning({
            orgId: orgMetadataCanonicalWrites.orgId,
            tier: orgMetadataCanonicalWrites.tier,
          });
      },
    );
  });
  signal.throwIfAborted();

  return actionOk({ compose_id: agentId });
}

async function seedOfficialUserLinkForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "telegram_user_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "org_id, user_id, and telegram_user_id are required",
    );
  }
  const [row] = await db
    .insert(telegramOfficialUserLinks)
    .values({
      orgId: required.org_id!,
      userId: required.user_id!,
      telegramUserId: required.telegram_user_id!,
      telegramUsername: readActionNullableString(body, "telegram_username"),
      telegramDisplayName: readActionNullableString(
        body,
        "telegram_display_name",
      ),
    })
    .returning({ id: telegramOfficialUserLinks.id });
  signal.throwIfAborted();
  return actionOk({ user_link_id: row?.id ?? null });
}

async function seedAgentRunCallbackForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readActionString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const encryptedSecret = readActionBoolean(body, "persist_secret", true)
    ? await encryptPersistentSecretValue(
        readActionOptionalString(body, "secret") ?? "test-callback-secret",
        {},
      )
    : null;
  signal.throwIfAborted();
  const [row] = await db
    .insert(agentRunCallbacks)
    .values({
      runId,
      url: readActionNullableString(body, "url") ?? null,
      internalKind: readActionNullableString(body, "internal_kind") ?? null,
      encryptedSecret,
      payload: readActionRecord(body, "payload"),
      status:
        readActionOptionalString(body, "status") === "delivered" ||
        readActionOptionalString(body, "status") === "failed"
          ? readActionOptionalString(body, "status")
          : "pending",
    })
    .returning({ id: agentRunCallbacks.id });
  signal.throwIfAborted();
  return actionOk({ callback_id: row?.id ?? null });
}

const updateRunForAction$ = command(
  async ({ set }, body: Record<string, unknown>, signal: AbortSignal) => {
    const runId = readActionString(body, "run_id");
    if (!runId) {
      return actionBadRequest("run_id is required");
    }
    await set(
      writeRunMetadata$,
      {
        patch: {
          selectedModel:
            readActionNullableString(body, "selected_model") ?? null,
        },
        where: eq(agentRuns.id, runId),
      },
      signal,
    );
    signal.throwIfAborted();
    return actionOk();
  },
);

async function getRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readActionString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({
      sessionId: agentRuns.sessionId,
      conversationId: agentSessions.conversationId,
      selectedModel: agentRuns.selectedModel,
      chatThreadId: agentRuns.chatThreadId,
      chatThreadAgentSessionId: chatThreads.agentSessionId,
      chatThreadAgentSessionRunId: chatThreads.agentSessionRunId,
    })
    .from(agentRuns)
    .leftJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .leftJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    run: run
      ? {
          session_id: run.sessionId,
          conversation_id: run.conversationId,
          selected_model: run.selectedModel,
          chat_thread_id: run.chatThreadId,
          chat_thread_agent_session_id: run.chatThreadAgentSessionId,
          chat_thread_agent_session_run_id: run.chatThreadAgentSessionRunId,
        }
      : null,
  });
}

async function deleteTelegramFixtureForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readActionString(body, "org_id");
  const composeIds = readActionStringArray(body, "compose_ids");

  if (orgId) {
    await db
      .delete(telegramMessages)
      .where(eq(telegramMessages.officialOrgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(telegramOfficialUserLinks)
      .where(eq(telegramOfficialUserLinks.orgId, orgId));
    signal.throwIfAborted();
    await db.delete(modelProviders).where(eq(modelProviders.orgId, orgId));
    signal.throwIfAborted();
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
    signal.throwIfAborted();
  }

  if (composeIds.length > 0) {
    await db.delete(agents).where(inArray(agents.id, composeIds));
    signal.throwIfAborted();
  }

  return actionOk();
}

async function seedTelegramPostAgent(
  db: Db,
  seed: TelegramPostFixtureSeed,
  signal: AbortSignal,
): Promise<void> {
  await db.insert(agents).values({
    id: seed.composeId,
    owner: seed.userId,
    orgId: seed.orgId,
    name: seed.name,
    displayName: "Telegram Agent",
    visibility: "public",
  });
  signal.throwIfAborted();
}

async function seedTelegramPostDefaultAgent(
  db: Db,
  seed: TelegramPostFixtureSeed,
  signal: AbortSignal,
): Promise<void> {
  await db.transaction(async (tx) => {
    await writeOrgMetadataWithDefaultPlanEntitlement(
      tx,
      seed.orgId,
      async (writeTx) => {
        return await writeTx
          .insert(orgMetadataCanonicalWrites)
          .values({
            orgId: seed.orgId,
            defaultAgentId: seed.composeId,
            tier: "limited-free-1",
            credits: 100_000,
          })
          .onConflictDoUpdate({
            target: orgMetadataCanonicalWrites.orgId,
            set: {
              defaultAgentId: seed.composeId,
              tier: "limited-free-1",
              credits: 100_000,
            },
          })
          .returning({
            orgId: orgMetadataCanonicalWrites.orgId,
            tier: orgMetadataCanonicalWrites.tier,
          });
      },
    );
  });
  signal.throwIfAborted();
}

async function seedTelegramPostModelKeys(
  catalogSnapshot: ModelCatalog,
  db: Db,
  seed: TelegramPostFixtureSeed,
  signal: AbortSignal,
): Promise<void> {
  await acquireBuiltInModelKeyFixture(db, seed.composeId, [
    {
      vendor: await loadSystemDefaultBuiltInVendor(catalogSnapshot),
      apiKey: `built-in-key-default-${seed.composeId}`,
    },
    {
      vendor: "anthropic",
      apiKey: `built-in-key-anthropic-${seed.composeId}`,
    },
    {
      vendor: "moonshot",
      apiKey: `built-in-key-moonshot-${seed.composeId}`,
    },
  ]);
  signal.throwIfAborted();
}

async function seedTelegramPostLinks(
  db: Db,
  body: Record<string, unknown>,
  seed: TelegramPostFixtureSeed,
  signal: AbortSignal,
): Promise<void> {
  if (readActionBoolean(body, "seed_official_link", false)) {
    await db.insert(telegramOfficialUserLinks).values({
      orgId: seed.orgId,
      userId: seed.userId,
      telegramUserId: "99002",
      telegramUsername: "bob",
      telegramDisplayName: "Bob",
    });
    signal.throwIfAborted();
  }
}

async function seedTelegramPostFixtureForAction(
  catalogSnapshot: ModelCatalog,
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId =
    readActionOptionalString(body, "org_id") ??
    `org_${randomUUID().slice(0, 8)}`;
  const userId =
    readActionOptionalString(body, "user_id") ??
    `user_${randomUUID().slice(0, 8)}`;
  const composeId = randomUUID();
  const seed: TelegramPostFixtureSeed = {
    orgId,
    userId,
    composeId,
    versionId: randomUUID(),
    name: `telegram-agent-${composeId.slice(0, 8)}`,
  };

  await seedTelegramPostAgent(db, seed, signal);
  await ensureAgentInstructionsStorageFixture(
    db,
    {
      orgId: seed.orgId,
      userId: seed.userId,
      agentName: seed.name,
    },
    signal,
  );
  if (readActionBoolean(body, "seed_default_agent", true)) {
    await seedTelegramPostDefaultAgent(db, seed, signal);
  }
  await seedTelegramPostModelKeys(catalogSnapshot, db, seed, signal);
  await seedTelegramPostLinks(db, body, seed, signal);

  return actionOk({
    fixture: {
      org_id: seed.orgId,
      user_id: seed.userId,
      compose_id: seed.composeId,
      version_id: seed.versionId,
    },
  });
}

async function deleteTelegramPostFixtureForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "compose_id",
  ]);
  if (!required) {
    return actionBadRequest("org_id, user_id, and compose_id are required");
  }
  const orgId = required.org_id!;
  const userId = required.user_id!;
  const composeId = required.compose_id!;

  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.userId, userId)));
  signal.throwIfAborted();
  const runIds = runRows.map((row) => {
    return row.id;
  });
  if (runIds.length > 0) {
    await db
      .delete(runnerJobQueue)
      .where(inArray(runnerJobQueue.runId, runIds));
    signal.throwIfAborted();
    await db
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
    signal.throwIfAborted();
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    signal.throwIfAborted();
  }

  await db
    .delete(agentSessions)
    .where(
      and(eq(agentSessions.orgId, orgId), eq(agentSessions.userId, userId)),
    );
  signal.throwIfAborted();
  await db.delete(orgModelPolicies).where(eq(orgModelPolicies.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    );
  signal.throwIfAborted();
  await releaseBuiltInModelKeyFixture(db, composeId);
  signal.throwIfAborted();
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.officialOrgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(telegramOfficialUserLinks)
    .where(eq(telegramOfficialUserLinks.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(agents).where(eq(agents.id, composeId));
  signal.throwIfAborted();
  return actionOk();
}

async function getTelegramPostRunStateForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, ["org_id", "user_id"]);
  if (!required) {
    return actionBadRequest("org_id and user_id are required");
  }
  const prompt = readActionOptionalString(body, "prompt");
  const runId = readActionOptionalString(body, "run_id");
  const conditions = [
    eq(agentRuns.orgId, required.org_id!),
    eq(agentRuns.userId, required.user_id!),
  ];
  if (runId) {
    conditions.push(eq(agentRuns.id, runId));
  }
  if (prompt) {
    conditions.push(eq(agentRuns.prompt, prompt));
  }
  const [run] = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      error: agentRuns.error,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      continuedFromSessionId: agentRuns.continuedFromSessionId,
      sessionId: agentRuns.sessionId,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(and(...conditions))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  signal.throwIfAborted();

  if (!run) {
    return actionOk({
      run: null,
      agent_run: null,
      callbacks: [],
      job_exists: false,
    });
  }

  const [[agentRun], callbacks, [job]] = await Promise.all([
    db
      .select({
        id: agentRuns.id,
        triggerSource: agentRuns.triggerSource,
        chatThreadId: agentRuns.chatThreadId,
        modelProvider: agentRuns.modelProvider,
        selectedModel: agentRuns.selectedModel,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, run.id), isNotNull(agentRuns.triggerSource)))
      .limit(1),
    db
      .select({
        id: agentRunCallbacks.id,
        url: agentRunCallbacks.url,
        internalKind: agentRunCallbacks.internalKind,
        encryptedSecret: agentRunCallbacks.encryptedSecret,
        payload: agentRunCallbacks.payload,
        status: agentRunCallbacks.status,
        attempts: agentRunCallbacks.attempts,
        lastError: agentRunCallbacks.lastError,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, run.id)),
    db
      .select({ runId: runnerJobQueue.runId })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, run.id))
      .limit(1),
  ]);
  signal.throwIfAborted();

  return actionOk({
    run,
    agent_run: agentRun ?? null,
    callbacks: callbacks.map((callback) => {
      return {
        id: callback.id,
        url: callback.url,
        internalKind: callback.internalKind,
        hasEncryptedSecret: callback.encryptedSecret !== null,
        payload: callback.payload,
        status: callback.status,
        attempts: callback.attempts,
        lastError: callback.lastError,
      };
    }),
    job_exists: job !== undefined,
  });
}

async function getTelegramLinkIdForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, ["org_id", "user_id"]);
  if (!required) {
    return actionBadRequest("org_id and user_id are required");
  }
  const [link] = await db
    .select({ id: telegramOfficialUserLinks.id })
    .from(telegramOfficialUserLinks)
    .where(
      and(
        eq(telegramOfficialUserLinks.orgId, required.org_id!),
        eq(telegramOfficialUserLinks.userId, required.user_id!),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ link_id: link?.id ?? null });
}

async function findChatThreadRouteForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "user_link_id",
    "chat_id",
    "root_message_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "user_link_id, chat_id, and root_message_id are required",
    );
  }
  const [route] = await db
    .select({
      telegramOfficialUserLinkId:
        telegramChatThreadRoutes.telegramOfficialUserLinkId,
      chatId: telegramChatThreadRoutes.chatId,
      rootMessageId: telegramChatThreadRoutes.rootMessageId,
      chatThreadId: telegramChatThreadRoutes.chatThreadId,
    })
    .from(telegramChatThreadRoutes)
    .where(
      and(
        eq(
          telegramChatThreadRoutes.telegramOfficialUserLinkId,
          required.user_link_id!,
        ),
        eq(telegramChatThreadRoutes.chatId, required.chat_id!),
        eq(telegramChatThreadRoutes.rootMessageId, required.root_message_id!),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ route: route ?? null });
}

async function insertAgentSessionForAction(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const [session] = await db
    .insert(agentSessions)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
    })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  return session?.id ?? null;
}

async function seedRunningRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "version_id",
    "compose_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "org_id, user_id, version_id, and compose_id are required",
    );
  }
  const sessionId = await insertAgentSessionForAction(
    db,
    {
      orgId: required.org_id!,
      userId: required.user_id!,
      agentId: required.compose_id!,
    },
    signal,
  );
  if (!sessionId) {
    return actionBadRequest("failed to seed agent session");
  }
  const startedAt = nowDate();
  const metadata = normalizeRunMetadata({ triggerSource: "telegram" });
  const run = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(agentRuns)
      .values({
        userId: required.user_id!,
        orgId: required.org_id!,
        sessionId,
        status: "running",
        prompt: "existing running telegram run",
        startedAt,
        ...metadata,
      })
      .returning({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        startedAt: sql`${agentRuns.createdAt}::text`.mapWith(pgTextDecoder),
        triggerSource: agentRuns.triggerSource,
        threadId: agentRuns.chatThreadId,
      });
    signal.throwIfAborted();
    if (!created) {
      return undefined;
    }
    const capture = billingRunAttributionWrite(created);
    await tx
      .insert(billingRunAttribution)
      .values(capture.values)
      .onConflictDoNothing();
    signal.throwIfAborted();
    return created;
  });
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("failed to seed running agent run");
  }
  await db.insert(activeAgentRuns).values({
    runId: run.id,
    orgId: required.org_id!,
    userId: required.user_id!,
    lastHeartbeatAt: startedAt,
  });
  signal.throwIfAborted();
  return actionOk({ agent_session_id: sessionId });
}

async function seedModelPoliciesForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "compose_id",
  ]);
  if (!required) {
    return actionBadRequest("org_id, user_id, and compose_id are required");
  }
  await db.insert(orgModelPolicies).values([
    {
      orgId: required.org_id!,
      model: "claude-sonnet-5",
      defaultProviderType: "built-in",
      credentialScope: "org",
      createdByUserId: required.user_id!,
      updatedByUserId: required.user_id!,
    },
    {
      orgId: required.org_id!,
      model: "claude-opus-5",
      defaultProviderType: "built-in",
      credentialScope: "org",
      createdByUserId: required.user_id!,
      updatedByUserId: required.user_id!,
    },
    {
      orgId: required.org_id!,
      model: "deepseek-v4-flash",
      defaultProviderType: "built-in",
      credentialScope: "org",
      createdByUserId: required.user_id!,
      updatedByUserId: required.user_id!,
    },
  ]);
  signal.throwIfAborted();
  await db
    .insert(builtInModelKeys)
    .values({
      vendor: "anthropic",
      apiKey: "built-in-key-anthropic",
      label: required.compose_id!,
    })
    .onConflictDoNothing({ target: builtInModelKeys.vendor });
  signal.throwIfAborted();
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId: required.org_id!,
      userId: required.user_id!,
      selectedModel: readActionNullableString(body, "selected_model") ?? null,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedModel: readActionNullableString(body, "selected_model") ?? null,
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function getSelectedModelForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, ["org_id", "user_id"]);
  if (!required) {
    return actionBadRequest("org_id and user_id are required");
  }
  const [row] = await db
    .select({ selectedModel: orgMembersMetadata.selectedModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, required.org_id!),
        eq(orgMembersMetadata.userId, required.user_id!),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ selected_model: row?.selectedModel ?? null });
}

async function updateRunCallbackForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readActionString(body, "run_id");
  const callbackId = readActionString(body, "callback_id");
  const callbackCondition = callbackId
    ? eq(agentRunCallbacks.id, callbackId)
    : runId
      ? eq(agentRunCallbacks.runId, runId)
      : null;
  if (!callbackCondition) {
    return actionBadRequest("run_id or callback_id is required");
  }
  const encryptedSecret = await encryptPersistentSecretValue(
    readActionOptionalString(body, "secret") ?? "test-callback-secret",
    {},
  );
  signal.throwIfAborted();
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({
      url: readActionNullableString(body, "url") ?? null,
      internalKind: readActionNullableString(body, "internal_kind") ?? null,
      payload: readActionRecord(body, "payload"),
      encryptedSecret,
    })
    .where(callbackCondition)
    .returning({ callbackId: agentRunCallbacks.id });
  signal.throwIfAborted();
  return actionOk({ callback_id: callback?.callbackId ?? null });
}

type TelegramStateActionHandler = (
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

const telegramStateActionHandlers = {
  "seed-org-default-agent": seedOrgDefaultAgentForAction,
  "seed-official-user-link": seedOfficialUserLinkForAction,
  "seed-agent-run-callback": seedAgentRunCallbackForAction,
  "delete-post-fixture": deleteTelegramPostFixtureForAction,
  "get-post-run-state": getTelegramPostRunStateForAction,
  "get-telegram-link-id": getTelegramLinkIdForAction,
  "seed-running-run": seedRunningRunForAction,
  "seed-model-policies": seedModelPoliciesForAction,
  "get-selected-model": getSelectedModelForAction,
  "update-run-callback": updateRunCallbackForAction,
  "get-run": getRunForAction,
  "find-chat-thread-route": findChatThreadRouteForAction,
  "delete-fixture": deleteTelegramFixtureForAction,
} satisfies Record<
  Exclude<
    TestTelegramStateActionBody["action"],
    "seed-post-fixture" | "update-run"
  >,
  TelegramStateActionHandler
>;

async function mutateTestTelegramStateAction(
  catalogSnapshot: ModelCatalog,
  db: Db,
  body: Record<string, unknown>,
  action: Exclude<TestTelegramStateActionBody["action"], "update-run">,
  signal: AbortSignal,
) {
  if (action === "seed-post-fixture") {
    return await seedTelegramPostFixtureForAction(
      catalogSnapshot,
      db,
      body,
      signal,
    );
  }
  return await telegramStateActionHandlers[action](db, body, signal);
}

const mutateTestTelegramState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data as Record<string, unknown>;
    if (bodyResult.data.action === "update-run") {
      return await set(updateRunForAction$, body, signal);
    }
    return await mutateTestTelegramStateAction(
      await get(modelCatalog$),
      set(writeDb$),
      body,
      bodyResult.data.action,
      signal,
    );
  },
);

export const testTelegramStateRoutes: readonly RouteEntry[] = [
  {
    route: testTelegramStateContract.action,
    handler: mutateTestTelegramState$,
  },
];
