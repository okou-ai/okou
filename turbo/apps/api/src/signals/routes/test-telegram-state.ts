import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { eq, inArray } from "drizzle-orm";
import {
  testTelegramStateContract,
  type TestTelegramStateActionBody,
} from "@okouai/api-contracts/contracts/test-telegram-state";
import { agents } from "@okouai/db/schema/agent";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { telegramMessages } from "@okouai/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "../services/org-plan-entitlements.service";

const actionBody$ = bodyResultOf(testTelegramStateContract.action);

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

  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0035; new non-billing transactions are prohibited.
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

type TelegramStateActionHandler = (
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

const telegramStateActionHandlers = {
  "seed-org-default-agent": seedOrgDefaultAgentForAction,
  "seed-official-user-link": seedOfficialUserLinkForAction,
  "seed-agent-run-callback": seedAgentRunCallbackForAction,
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
    route: testTelegramStateContract.action,
    handler: mutateTestTelegramState$,
  },
];
