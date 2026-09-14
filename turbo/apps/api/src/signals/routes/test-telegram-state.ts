import { randomUUID } from "node:crypto";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import { command, computed } from "ccstate";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  getBuiltInVendor,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  testTelegramStateContract,
  type TestTelegramStateActionBody,
} from "@okouai/api-contracts/contracts/test-telegram-state";
import { agents } from "@okouai/db/schema/agent";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { telegramInstallations } from "@okouai/db/schema/telegram-installation";
import { telegramMessages } from "@okouai/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { telegramUserAgentPreferences } from "@okouai/db/schema/telegram-user-agent-preference";
import { telegramUserLinks } from "@okouai/db/schema/telegram-user-link";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { request$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import { resolveTestOrgId$, testUserId$ } from "../services/cli-auth.service";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import {
  normalizeRunMetadata,
  writeRunMetadata,
} from "../services/agent-run-metadata-write.service";
import { tapError } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { ensureAgentInstructionsStorageFixture } from "./test-agent-instructions-storage";
import type { Tx } from "../../lib/db-types";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "../services/org-plan-entitlements.service";

const testTelegramStateQuery$ = queryOf(testTelegramStateContract.get);
const deleteTestTelegramStateQuery$ = queryOf(testTelegramStateContract.delete);
const actionBody$ = bodyResultOf(testTelegramStateContract.action);
const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";
const DEFAULT_TEST_AGENT_NAME = "e2e-slack-agent";
const STARTER_GRANT_AMOUNT = 10_000;
const STARTER_GRANT_SOURCE = "starter_grant";
const TELEGRAM_E2E_FIXTURES = {
  botUsername: "e2e_test_bot",
  botToken: "123456:e2e-test-bot-token",
  webhookSecret: "e2e-telegram-webhook-secret",
} as const;

type StarterGrantTx = Tx;

interface SeedDefaultAgentInput {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}

interface DefaultAgentSeed {
  readonly agentId: string;
}

interface TelegramPostFixtureSeed {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly versionId: string;
  readonly telegramBotId: string;
  readonly webhookSecret: string;
  readonly name: string;
}

async function loadInstallation(db: ReadonlyDb, botId: string) {
  const [installation] = await db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      botUsername: telegramInstallations.botUsername,
      orgId: telegramInstallations.orgId,
      ownerUserId: telegramInstallations.ownerUserId,
      defaultAgentId: telegramInstallations.defaultAgentId,
      publicBrand: telegramInstallations.publicBrand,
      createdAt: telegramInstallations.createdAt,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, botId))
    .limit(1);
  return installation ?? null;
}

function loadLinks(db: ReadonlyDb, botId: string) {
  return db
    .select({
      id: telegramUserLinks.id,
      telegramUserId: telegramUserLinks.telegramUserId,
      telegramUsername: telegramUserLinks.telegramUsername,
      userId: telegramUserLinks.userId,
      dmWelcomeSent: telegramUserLinks.dmWelcomeSent,
      createdAt: telegramUserLinks.createdAt,
    })
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, botId));
}

function loadRecentRuns(db: ReadonlyDb, orgId: string | undefined) {
  if (!orgId) {
    return [];
  }
  return db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
      triggerSource: agentRuns.triggerSource,
      chatThreadId: agentRuns.chatThreadId,
      userId: agentRuns.userId,
      error: agentRuns.error,
      promptPreview: sql`substring(${agentRuns.prompt}, 1, 200)`.mapWith(
        pgTextDecoder,
      ),
    })
    .from(agentRuns)
    .where(eq(agentRuns.orgId, orgId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(50);
}

async function loadOrgMeta(db: ReadonlyDb, orgId: string | undefined) {
  if (!orgId) {
    return null;
  }
  const [row] = await db
    .select({
      orgId: orgMetadata.orgId,
      defaultAgentId: orgMetadata.defaultAgentId,
      credits: orgMetadata.credits,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row ?? null;
}

async function loadDefaultAgent(
  db: ReadonlyDb,
  defaultAgentId: string | undefined,
) {
  if (!defaultAgentId) {
    return null;
  }
  const [row] = await db
    .select({
      id: agents.id,
      name: agents.name,
      orgId: agents.orgId,
    })
    .from(agents)
    .where(eq(agents.id, defaultAgentId))
    .limit(1);
  return row ?? null;
}

async function countMessages(db: ReadonlyDb, botId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(telegramMessages)
    .where(eq(telegramMessages.installationId, botId));
  return row?.count ?? 0;
}

function loadMessages(db: ReadonlyDb, botId: string) {
  return db
    .select({
      id: telegramMessages.id,
      text: telegramMessages.text,
      isBot: telegramMessages.isBot,
      chatId: telegramMessages.chatId,
      messageId: telegramMessages.messageId,
      createdAt: telegramMessages.createdAt,
    })
    .from(telegramMessages)
    .where(eq(telegramMessages.installationId, botId))
    .orderBy(telegramMessages.createdAt);
}

function loadOfficialMessages(db: ReadonlyDb, orgId: string | undefined) {
  if (!orgId) {
    return [];
  }
  return db
    .select({
      id: telegramMessages.id,
      text: telegramMessages.text,
      isBot: telegramMessages.isBot,
      officialOrgId: telegramMessages.officialOrgId,
      officialUserLinkId: telegramMessages.officialUserLinkId,
      createdAt: telegramMessages.createdAt,
    })
    .from(telegramMessages)
    .where(eq(telegramMessages.officialOrgId, orgId))
    .orderBy(telegramMessages.createdAt);
}

async function loadChatThreadRoutes(db: ReadonlyDb, botId: string) {
  const [customRoutes, officialRoutes] = await Promise.all([
    db
      .select({
        telegramUserLinkId: telegramChatThreadRoutes.telegramUserLinkId,
        telegramOfficialUserLinkId:
          telegramChatThreadRoutes.telegramOfficialUserLinkId,
        chatId: telegramChatThreadRoutes.chatId,
        rootMessageId: telegramChatThreadRoutes.rootMessageId,
        chatThreadId: telegramChatThreadRoutes.chatThreadId,
      })
      .from(telegramChatThreadRoutes)
      .innerJoin(
        telegramUserLinks,
        eq(telegramUserLinks.id, telegramChatThreadRoutes.telegramUserLinkId),
      )
      .where(eq(telegramUserLinks.installationId, botId)),
    db
      .select({
        telegramUserLinkId: telegramChatThreadRoutes.telegramUserLinkId,
        telegramOfficialUserLinkId:
          telegramChatThreadRoutes.telegramOfficialUserLinkId,
        chatId: telegramChatThreadRoutes.chatId,
        rootMessageId: telegramChatThreadRoutes.rootMessageId,
        chatThreadId: telegramChatThreadRoutes.chatThreadId,
      })
      .from(telegramChatThreadRoutes)
      .innerJoin(
        telegramOfficialUserLinks,
        eq(
          telegramOfficialUserLinks.id,
          telegramChatThreadRoutes.telegramOfficialUserLinkId,
        ),
      )
      .innerJoin(
        telegramInstallations,
        eq(telegramInstallations.orgId, telegramOfficialUserLinks.orgId),
      )
      .where(eq(telegramInstallations.telegramBotId, botId)),
  ]);
  return [...customRoutes, ...officialRoutes];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isSeedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function insertTelegramLinkIfMissing(
  db: Db,
  params: {
    readonly installationId: string;
    readonly telegramUserId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const [existing] = await db
    .select({ id: telegramUserLinks.id })
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, params.installationId),
        eq(telegramUserLinks.telegramUserId, params.telegramUserId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (existing) {
    return existing.id;
  }

  const [row] = await db
    .insert(telegramUserLinks)
    .values({
      installationId: params.installationId,
      telegramUserId: params.telegramUserId,
      userId: params.userId,
    })
    .onConflictDoNothing()
    .returning({ id: telegramUserLinks.id });
  signal.throwIfAborted();
  return row?.id ?? null;
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

async function seedTelegramInstallationForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "owner_user_id",
    "telegram_bot_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "org_id, owner_user_id, and telegram_bot_id are required",
    );
  }
  const orgId = required.org_id!;
  const ownerUserId = required.owner_user_id!;
  const telegramBotId = required.telegram_bot_id!;
  const skipCompose = body.skip_compose === true;
  const defaultAgentId = readActionOptionalString(body, "default_agent_id");
  if (skipCompose && !defaultAgentId) {
    return actionBadRequest("default_agent_id is required with skip_compose");
  }
  const agentId = skipCompose
    ? defaultAgentId!
    : await seedTelegramAgent(db, {
        orgId,
        userId:
          readActionOptionalString(body, "compose_user_id") ?? ownerUserId,
        agentId: defaultAgentId,
        agentName: readActionOptionalString(body, "agent_name"),
      });
  signal.throwIfAborted();

  const encryptedBotToken = await encryptPersistentSecretValue(
    readActionOptionalString(body, "bot_token") ?? "test-bot-token",
    { orgId, userId: ownerUserId },
  );
  signal.throwIfAborted();

  await db.insert(telegramInstallations).values({
    telegramBotId,
    publicBrand: PUBLIC_BRAND,
    botUsername:
      readActionNullableString(body, "bot_username") ?? `bot_${telegramBotId}`,
    encryptedBotToken,
    webhookSecret:
      readActionOptionalString(body, "webhook_secret") ?? `whs_${randomUUID()}`,
    defaultAgentId: agentId,
    ownerUserId,
    orgId,
  });
  signal.throwIfAborted();

  return actionOk({ compose_id: agentId, telegram_bot_id: telegramBotId });
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
            tier: "free",
            credits: 10_000,
          })
          .onConflictDoUpdate({
            target: orgMetadataCanonicalWrites.orgId,
            set: { defaultAgentId: agentId, tier: "free", credits: 10_000 },
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

async function seedUserLinkForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "installation_id",
    "telegram_user_id",
    "user_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "installation_id, telegram_user_id, and user_id are required",
    );
  }
  const [row] = await db
    .insert(telegramUserLinks)
    .values({
      installationId: required.installation_id!,
      telegramUserId: required.telegram_user_id!,
      userId: required.user_id!,
      telegramUsername: readActionNullableString(body, "telegram_username"),
      telegramDisplayName: readActionNullableString(
        body,
        "telegram_display_name",
      ),
    })
    .returning({ id: telegramUserLinks.id });
  signal.throwIfAborted();
  return actionOk({ user_link_id: row?.id ?? null });
}

async function seedUserAgentPreferenceForAction(
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
  await db
    .insert(telegramUserAgentPreferences)
    .values({
      orgId: required.org_id!,
      userId: required.user_id!,
      selectedAgentId: required.compose_id!,
    })
    .onConflictDoUpdate({
      target: [
        telegramUserAgentPreferences.userId,
        telegramUserAgentPreferences.orgId,
      ],
      set: { selectedAgentId: required.compose_id! },
    });
  signal.throwIfAborted();
  return actionOk();
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

async function updateRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readActionString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  await writeRunMetadata(db, {
    patch: {
      selectedModel: readActionNullableString(body, "selected_model") ?? null,
    },
    where: eq(agentRuns.id, runId),
  });
  signal.throwIfAborted();
  return actionOk();
}

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
  const telegramBotIds = readActionStringArray(body, "telegram_bot_ids");

  if (telegramBotIds.length > 0) {
    await db
      .delete(telegramMessages)
      .where(inArray(telegramMessages.installationId, telegramBotIds));
    signal.throwIfAborted();
    await db
      .delete(telegramUserLinks)
      .where(inArray(telegramUserLinks.installationId, telegramBotIds));
    signal.throwIfAborted();
    await db
      .delete(telegramInstallations)
      .where(inArray(telegramInstallations.telegramBotId, telegramBotIds));
    signal.throwIfAborted();
  }

  if (orgId) {
    await db
      .delete(telegramMessages)
      .where(eq(telegramMessages.officialOrgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(telegramOfficialUserLinks)
      .where(eq(telegramOfficialUserLinks.orgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(telegramUserAgentPreferences)
      .where(eq(telegramUserAgentPreferences.orgId, orgId));
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
            tier: "free",
            credits: 100_000,
          })
          .onConflictDoUpdate({
            target: orgMetadataCanonicalWrites.orgId,
            set: {
              defaultAgentId: seed.composeId,
              tier: "free",
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
  db: Db,
  seed: TelegramPostFixtureSeed,
  signal: AbortSignal,
): Promise<void> {
  await db
    .insert(builtInModelKeys)
    .values([
      {
        vendor: getBuiltInVendor(DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL),
        apiKey: `built-in-key-default-${seed.composeId}`,
        label: seed.composeId,
      },
      {
        vendor: "anthropic",
        apiKey: `built-in-key-anthropic-${seed.composeId}`,
        label: seed.composeId,
      },
      {
        vendor: "moonshot",
        apiKey: `built-in-key-moonshot-${seed.composeId}`,
        label: seed.composeId,
      },
    ])
    .onConflictDoNothing({ target: builtInModelKeys.vendor });
  signal.throwIfAborted();
}

async function seedTelegramPostInstallation(
  db: Db,
  body: Record<string, unknown>,
  seed: TelegramPostFixtureSeed,
  signal: AbortSignal,
): Promise<void> {
  const encryptedBotToken = await encryptPersistentSecretValue(
    readActionOptionalString(body, "bot_token") ?? "123456:test-bot-token",
    { orgId: seed.orgId, userId: seed.userId },
  );
  signal.throwIfAborted();
  await db.insert(telegramInstallations).values({
    telegramBotId: seed.telegramBotId,
    publicBrand: PUBLIC_BRAND,
    botUsername: `bot_${seed.telegramBotId}`,
    encryptedBotToken,
    webhookSecret: seed.webhookSecret,
    defaultAgentId: seed.composeId,
    ownerUserId: seed.userId,
    orgId: seed.orgId,
  });
  signal.throwIfAborted();
}

async function seedTelegramPostLinks(
  db: Db,
  body: Record<string, unknown>,
  seed: TelegramPostFixtureSeed,
  signal: AbortSignal,
): Promise<string | undefined> {
  const telegramUserId = readActionBoolean(body, "link_telegram_user", false)
    ? "99001"
    : undefined;
  if (telegramUserId) {
    await db.insert(telegramUserLinks).values({
      installationId: seed.telegramBotId,
      telegramUserId,
      telegramUsername: "alice",
      telegramDisplayName: "Alice",
      userId: seed.userId,
    });
    signal.throwIfAborted();
  }

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

  return telegramUserId;
}

async function seedTelegramPostFixtureForAction(
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
    telegramBotId:
      readActionOptionalString(body, "telegram_bot_id") ??
      String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000),
    webhookSecret: `whs_${randomUUID()}`,
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
  await seedTelegramPostModelKeys(db, seed, signal);
  if (readActionBoolean(body, "install_bot", true)) {
    await seedTelegramPostInstallation(db, body, seed, signal);
  }
  const telegramUserId = await seedTelegramPostLinks(db, body, seed, signal);

  return actionOk({
    fixture: {
      org_id: seed.orgId,
      user_id: seed.userId,
      compose_id: seed.composeId,
      version_id: seed.versionId,
      telegram_bot_id: seed.telegramBotId,
      webhook_secret: seed.webhookSecret,
      telegram_user_id: telegramUserId,
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
    "telegram_bot_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "org_id, user_id, compose_id, and telegram_bot_id are required",
    );
  }
  const orgId = required.org_id!;
  const userId = required.user_id!;
  const composeId = required.compose_id!;
  const telegramBotId = required.telegram_bot_id!;

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
  await db
    .delete(builtInModelKeys)
    .where(eq(builtInModelKeys.label, composeId));
  signal.throwIfAborted();
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.installationId, telegramBotId));
  signal.throwIfAborted();
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.officialOrgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(telegramOfficialUserLinks)
    .where(eq(telegramOfficialUserLinks.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, telegramBotId));
  signal.throwIfAborted();
  await db
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, telegramBotId));
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
  const kind = readActionString(body, "kind");
  if (kind === "official") {
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

  const required = requiredActionStrings(body, ["installation_id", "user_id"]);
  if (!required) {
    return actionBadRequest("installation_id and user_id are required");
  }
  const [link] = await db
    .select({ id: telegramUserLinks.id })
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, required.installation_id!),
        eq(telegramUserLinks.userId, required.user_id!),
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
      telegramUserLinkId: telegramChatThreadRoutes.telegramUserLinkId,
      telegramOfficialUserLinkId:
        telegramChatThreadRoutes.telegramOfficialUserLinkId,
      chatId: telegramChatThreadRoutes.chatId,
      rootMessageId: telegramChatThreadRoutes.rootMessageId,
      chatThreadId: telegramChatThreadRoutes.chatThreadId,
    })
    .from(telegramChatThreadRoutes)
    .where(
      and(
        body.owner_kind === "official"
          ? eq(
              telegramChatThreadRoutes.telegramOfficialUserLinkId,
              required.user_link_id!,
            )
          : eq(
              telegramChatThreadRoutes.telegramUserLinkId,
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
  await db.insert(agentRuns).values({
    userId: required.user_id!,
    orgId: required.org_id!,
    sessionId,
    status: "running",
    prompt: "existing running telegram run",
    startedAt,
    lastHeartbeatAt: startedAt,
    ...metadata,
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
      isDefault: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
      createdByUserId: required.user_id!,
      updatedByUserId: required.user_id!,
    },
    {
      orgId: required.org_id!,
      model: "claude-opus-4-8",
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

async function seedPendingUserLinkForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, ["installation_id", "user_id"]);
  if (!required) {
    return actionBadRequest("installation_id and user_id are required");
  }
  await db.insert(telegramUserLinks).values({
    installationId: required.installation_id!,
    telegramUserId: "pending",
    telegramUsername: null,
    telegramDisplayName: null,
    userId: required.user_id!,
  });
  signal.throwIfAborted();
  return actionOk();
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

async function ensureStarterCreditGrant(
  tx: StarterGrantTx,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const [existing] = await tx
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  signal.throwIfAborted();
  if (existing) {
    return;
  }

  const expiresAt = nowDate();
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  const inserted = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId,
      source: STARTER_GRANT_SOURCE,
      stripeInvoiceId: null,
      amount: STARTER_GRANT_AMOUNT,
      remaining: STARTER_GRANT_AMOUNT,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });
  signal.throwIfAborted();

  if (inserted.length === 0) {
    return;
  }

  await writeOrgMetadataWithDefaultPlanEntitlement(
    tx,
    orgId,
    async (writeTx) => {
      return await writeTx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId,
          credits: STARTER_GRANT_AMOUNT,
          tier: "free",
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: {
            credits: sql`${orgMetadata.credits} + ${STARTER_GRANT_AMOUNT}`,
            tier: "free",
            updatedAt: sql`now()`,
          },
        })
        .returning({
          orgId: orgMetadataCanonicalWrites.orgId,
          tier: orgMetadataCanonicalWrites.tier,
        });
    },
  );

  signal.throwIfAborted();
}

async function getOrInsertAgent(
  db: Db,
  input: SeedDefaultAgentInput,
  signal: AbortSignal,
): Promise<{ readonly id: string }> {
  const [inserted] = await db
    .insert(agents)
    .values({
      id: randomUUID(),
      owner: input.userId,
      orgId: input.orgId,
      name: input.name,
    })
    .onConflictDoNothing({
      target: [agents.orgId, agents.name],
    })
    .returning({ id: agents.id });
  signal.throwIfAborted();

  if (inserted) {
    return inserted;
  }

  const [existing] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, input.orgId), eq(agents.name, input.name)))
    .limit(1);
  signal.throwIfAborted();

  if (!existing) {
    throw new Error("Failed to resolve Agent after conflict");
  }
  return existing;
}

async function seedDefaultAgent(
  db: Db,
  input: SeedDefaultAgentInput,
  signal: AbortSignal,
): Promise<DefaultAgentSeed> {
  const agent = await getOrInsertAgent(db, input, signal);
  signal.throwIfAborted();

  await db.transaction(async (tx) => {
    await ensureStarterCreditGrant(tx, input.orgId, signal);
    signal.throwIfAborted();
    await writeOrgMetadataWithDefaultPlanEntitlement(
      tx,
      input.orgId,
      async (writeTx) => {
        return await writeTx
          .insert(orgMetadataCanonicalWrites)
          .values({ orgId: input.orgId, defaultAgentId: agent.id })
          .onConflictDoUpdate({
            target: orgMetadataCanonicalWrites.orgId,
            set: { defaultAgentId: agent.id, updatedAt: nowDate() },
          })
          .returning({
            orgId: orgMetadataCanonicalWrites.orgId,
            tier: orgMetadataCanonicalWrites.tier,
          });
      },
    );

    signal.throwIfAborted();
  });
  signal.throwIfAborted();

  await ensureAgentInstructionsStorageFixture(
    db,
    {
      orgId: input.orgId,
      userId: input.userId,
      agentName: input.name,
    },
    signal,
  );

  return { agentId: agent.id };
}

const getTestTelegramState$ = computed(async (get) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(testTelegramStateQuery$);
  if (!query.bot_id) {
    return {
      status: 400 as const,
      body: { error: "bot_id query param is required" },
    };
  }

  const db = get(db$);
  const installation = await loadInstallation(db, query.bot_id);
  const [
    links,
    recentRuns,
    orgMeta,
    defaultAgent,
    messageCount,
    messages,
    officialMessages,
    routes,
  ] = await Promise.all([
    loadLinks(db, query.bot_id),
    loadRecentRuns(db, installation?.orgId),
    loadOrgMeta(db, installation?.orgId),
    loadDefaultAgent(db, installation?.defaultAgentId ?? undefined),
    countMessages(db, query.bot_id),
    loadMessages(db, query.bot_id),
    loadOfficialMessages(db, installation?.orgId),
    loadChatThreadRoutes(db, query.bot_id),
  ]);
  return {
    status: 200 as const,
    body: {
      installation,
      links,
      message_count: messageCount,
      recent_runs: recentRuns,
      org_metadata: orgMeta,
      default_agent: defaultAgent,
      messages,
      official_messages: officialMessages,
      routes,
    },
  };
});

const postTestTelegramState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const rawBody: unknown = (await tapError(request.json())) ?? null;
    signal.throwIfAborted();
    const body = isSeedRecord(rawBody) ? rawBody : {};
    const botId = readString(body.bot_id);
    const telegramUserId = readString(body.telegram_user_id);
    if (!botId || !telegramUserId) {
      return {
        status: 400 as const,
        body: { error: "bot_id and telegram_user_id are required" },
      };
    }

    const email = readOptionalString(body.email) ?? DEFAULT_TEST_EMAIL;
    const userId = await set(testUserId$, { email, refresh: false }, signal);
    signal.throwIfAborted();
    const orgId = await set(resolveTestOrgId$, userId, signal);
    signal.throwIfAborted();

    const db = set(writeDb$);
    const defaultAgent = await seedDefaultAgent(
      db,
      {
        orgId,
        userId,
        name: DEFAULT_TEST_AGENT_NAME,
      },
      signal,
    );
    signal.throwIfAborted();

    const encryptedBotToken = await encryptPersistentSecretValue(
      TELEGRAM_E2E_FIXTURES.botToken,
      { orgId, userId },
    );
    signal.throwIfAborted();
    await db
      .insert(telegramInstallations)
      .values({
        telegramBotId: botId,
        botUsername:
          readOptionalString(body.bot_username) ??
          TELEGRAM_E2E_FIXTURES.botUsername,
        encryptedBotToken,
        webhookSecret:
          readOptionalString(body.webhook_secret) ??
          TELEGRAM_E2E_FIXTURES.webhookSecret,
        defaultAgentId: defaultAgent.agentId,
        ownerUserId: userId,
        orgId,
      })
      .onConflictDoUpdate({
        target: telegramInstallations.telegramBotId,
        set: {
          botUsername:
            readOptionalString(body.bot_username) ??
            TELEGRAM_E2E_FIXTURES.botUsername,
          encryptedBotToken,
          webhookSecret:
            readOptionalString(body.webhook_secret) ??
            TELEGRAM_E2E_FIXTURES.webhookSecret,
          defaultAgentId: defaultAgent.agentId,
          ownerUserId: userId,
          orgId,
          updatedAt: nowDate(),
        },
      });
    signal.throwIfAborted();

    const linkId =
      body.seed_link === false
        ? null
        : await insertTelegramLinkIfMissing(
            db,
            {
              installationId: botId,
              telegramUserId,
              userId: userId,
            },
            signal,
          );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true,
        bot_id: botId,
        org_id: orgId,
        user_id: userId,
        user_link_id: linkId,
        default_agent_id: defaultAgent.agentId,
      },
    };
  },
);

const deleteTestTelegramState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const query = get(deleteTestTelegramStateQuery$);
    if (!query.bot_id) {
      return {
        status: 400 as const,
        body: { error: "bot_id query param is required" },
      };
    }

    const botId = query.bot_id;
    const db = set(writeDb$);
    const [existing] = await db
      .select({ orgId: telegramInstallations.orgId })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId))
      .limit(1);
    signal.throwIfAborted();

    await db
      .delete(telegramMessages)
      .where(eq(telegramMessages.installationId, botId));
    signal.throwIfAborted();

    await db
      .delete(telegramUserLinks)
      .where(eq(telegramUserLinks.installationId, botId));
    signal.throwIfAborted();

    await db
      .delete(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId));
    signal.throwIfAborted();

    if (existing?.orgId) {
      const telegramAgentRuns = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, existing.orgId),
            eq(agentRuns.triggerSource, "telegram"),
          ),
        );
      signal.throwIfAborted();

      const ids = telegramAgentRuns.map((run) => {
        return run.id;
      });

      if (ids.length > 0) {
        await db.delete(agentRuns).where(inArray(agentRuns.id, ids));
        signal.throwIfAborted();
      }
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

type TelegramStateActionHandler = (
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

const telegramStateActionHandlers = {
  "seed-installation": seedTelegramInstallationForAction,
  "seed-org-default-agent": seedOrgDefaultAgentForAction,
  "seed-official-user-link": seedOfficialUserLinkForAction,
  "seed-user-link": seedUserLinkForAction,
  "seed-user-agent-preference": seedUserAgentPreferenceForAction,
  "seed-agent-run-callback": seedAgentRunCallbackForAction,
  "seed-post-fixture": seedTelegramPostFixtureForAction,
  "delete-post-fixture": deleteTelegramPostFixtureForAction,
  "get-post-run-state": getTelegramPostRunStateForAction,
  "get-telegram-link-id": getTelegramLinkIdForAction,
  "seed-running-run": seedRunningRunForAction,
  "seed-model-policies": seedModelPoliciesForAction,
  "get-selected-model": getSelectedModelForAction,
  "seed-pending-user-link": seedPendingUserLinkForAction,
  "update-run-callback": updateRunCallbackForAction,
  "update-run": updateRunForAction,
  "get-run": getRunForAction,
  "find-chat-thread-route": findChatThreadRouteForAction,
  "delete-fixture": deleteTelegramFixtureForAction,
} satisfies Record<
  TestTelegramStateActionBody["action"],
  TelegramStateActionHandler
>;

async function mutateTestTelegramStateAction(
  db: Db,
  body: Record<string, unknown>,
  action: TestTelegramStateActionBody["action"],
  signal: AbortSignal,
) {
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
    return await mutateTestTelegramStateAction(
      set(writeDb$),
      body,
      bodyResult.data.action,
      signal,
    );
  },
);

export const testTelegramStateRoutes: readonly RouteEntry[] = [
  {
    route: testTelegramStateContract.get,
    handler: getTestTelegramState$,
  },
  {
    route: testTelegramStateContract.post,
    handler: postTestTelegramState$,
  },
  {
    route: testTelegramStateContract.delete,
    handler: deleteTestTelegramState$,
  },
  {
    route: testTelegramStateContract.action,
    handler: mutateTestTelegramState$,
  },
];
