import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  testTelegramStateContract,
  type TestTelegramStateActionBody,
} from "@okouai/api-contracts/contracts/test-telegram-state";
import { agents } from "@okouai/db/schema/agent";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { telegramMessages } from "@okouai/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  acquireBuiltInModelKeyFixture,
  releaseBuiltInModelKeyFixture,
} from "../services/built-in-model-key-fixture";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { ensureAgentInstructionsStorageFixture } from "./test-agent-instructions-storage";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "../services/org-plan-entitlements.service";
import { AUTO_RUN_KEY_VENDOR } from "@okouai/core/auto-run-model";

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
  db: Db,
  seed: TelegramPostFixtureSeed,
  signal: AbortSignal,
): Promise<void> {
  await acquireBuiltInModelKeyFixture(db, seed.composeId, [
    {
      vendor: AUTO_RUN_KEY_VENDOR,
      apiKey: `built-in-key-default-${seed.composeId}`,
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
  await seedTelegramPostModelKeys(db, seed, signal);
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
  "delete-fixture": deleteTelegramFixtureForAction,
} satisfies Record<
  Exclude<TestTelegramStateActionBody["action"], "seed-post-fixture">,
  TelegramStateActionHandler
>;

async function mutateTestTelegramStateAction(
  db: Db,
  body: Record<string, unknown>,
  action: TestTelegramStateActionBody["action"],
  signal: AbortSignal,
) {
  if (action === "seed-post-fixture") {
    return await seedTelegramPostFixtureForAction(db, body, signal);
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
    route: testTelegramStateContract.action,
    handler: mutateTestTelegramState$,
  },
];
