import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  getBuiltInVendor,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  testSlackStateContract,
  type TestSlackStatePostBody,
} from "@okouai/api-contracts/contracts/test-slack-state";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgCache } from "@okouai/db/schema/org-cache";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { secrets } from "@okouai/db/schema/secret";
import { slackChatIngress } from "@okouai/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { variables } from "@okouai/db/schema/variable";
import { and, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { db$, type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { resolveTestOrgId$, testUserId$ } from "../services/cli-auth.service";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import {
  acquireBuiltInModelKeyFixture,
  releaseBuiltInModelKeyFixture,
} from "../services/built-in-model-key-fixture";
import { chatEventTypeIn } from "../services/chat-event-type.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import type { Tx } from "../../lib/db-types";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "../services/org-plan-entitlements.service";

const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";
const DEFAULT_WORKSPACE_NAME = "E2E Test Workspace";
const DEFAULT_AGENT_NAME = "e2e-slack-agent";
const STARTER_GRANT_AMOUNT = 10_000;
const STARTER_GRANT_SOURCE = "starter_grant";
const SLACK_BOT_SCOPES = JSON.stringify([
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "commands",
  "users:read",
  "users:read.email",
  "reactions:write",
  "files:read",
  "files:write",
]);
const SLACK_E2E_FIXTURES = {
  botUserId: "U_E2E_BOT",
  botToken: "xoxb-e2e-test-bot-token",
} as const;
const slackStateQueueRevoker = alias(chatEvents, "slack_state_queue_revoker");

type StarterGrantTx = Tx;

function isoString(value: Date): string {
  return value.toISOString();
}

interface UpsertSlackInstallationInput {
  readonly slackWorkspaceId: string;
  readonly slackWorkspaceName?: string;
  readonly orgId: string | null;
  readonly botUserId: string;
  readonly botToken: string;
  readonly botScopes?: string | null;
  readonly installedByUserId?: string;
  readonly publicBrand?: PublicBrand;
}

async function upsertSlackInstallation(
  db: Db,
  input: UpsertSlackInstallationInput,
): Promise<typeof slackOrgInstallations.$inferSelect> {
  const encryptedBotToken = await encryptPersistentSecretValue(
    input.botToken,
    input.orgId && input.installedByUserId
      ? { orgId: input.orgId, userId: input.installedByUserId }
      : {},
  );
  const [row] = await db
    .insert(slackOrgInstallations)
    .values({
      slackWorkspaceId: input.slackWorkspaceId,
      slackWorkspaceName: input.slackWorkspaceName,
      orgId: input.orgId,
      encryptedBotToken,
      botUserId: input.botUserId,
      botScopes: input.botScopes ?? null,
      installedByUserId: input.installedByUserId,
      ...(input.publicBrand ? { publicBrand: input.publicBrand } : {}),
    })
    .onConflictDoUpdate({
      target: slackOrgInstallations.slackWorkspaceId,
      set: {
        slackWorkspaceName: input.slackWorkspaceName,
        orgId: input.orgId,
        encryptedBotToken,
        botUserId: input.botUserId,
        botScopes: input.botScopes ?? null,
        installedByUserId: input.installedByUserId,
        ...(input.publicBrand ? { publicBrand: input.publicBrand } : {}),
        updatedAt: nowDate(),
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to upsert Slack installation");
  }
  return row;
}

interface UpsertSlackConnectionInput {
  readonly slackUserId: string;
  readonly slackWorkspaceId: string;
  readonly userId: string;
}

async function insertSlackConnectionIfMissing(
  db: Db,
  input: UpsertSlackConnectionInput,
): Promise<string | undefined> {
  const [row] = await db
    .insert(slackOrgConnections)
    .values({
      slackUserId: input.slackUserId,
      slackWorkspaceId: input.slackWorkspaceId,
      userId: input.userId,
    })
    .onConflictDoNothing()
    .returning({ id: slackOrgConnections.id });
  return row?.id;
}

interface SeedDefaultAgentInput {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly displayName?: string | null;
}

async function seedDefaultAgent(
  db: Db,
  input: SeedDefaultAgentInput,
): Promise<{ agentId: string }> {
  const [inserted] = await db
    .insert(agents)
    .values({
      id: randomUUID(),
      orgId: input.orgId,
      owner: input.userId,
      name: input.name,
      displayName: input.displayName ?? null,
    })
    .onConflictDoNothing({ target: [agents.orgId, agents.name] })
    .returning({ id: agents.id });

  const [agent] = await db
    .update(agents)
    .set({
      owner: input.userId,
      displayName: input.displayName ?? null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        inserted ? eq(agents.id, inserted.id) : sql`true`,
        eq(agents.orgId, input.orgId),
        eq(agents.name, input.name),
      ),
    )
    .returning({ id: agents.id });
  if (!agent) {
    throw new Error("Failed to resolve seeded default agent");
  }

  await db.transaction(async (tx) => {
    await ensureStarterCreditGrant(tx, input.orgId);
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
  });

  await seedBuiltInModelKeys(db, agent.id);

  return { agentId: agent.id };
}

async function seedBuiltInModelKeys(db: Db, agentId: string): Promise<void> {
  await acquireBuiltInModelKeyFixture(
    db,
    agentId,
    builtInModelKeyRows(agentId),
  );
}

function builtInModelKeyRows(agentId: string) {
  return [
    {
      vendor: getBuiltInVendor(DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL),
      apiKey: `built-in-key-default-${agentId}`,
      label: agentId,
    },
    {
      vendor: "anthropic",
      apiKey: `built-in-key-anthropic-${agentId}`,
      label: agentId,
    },
    {
      vendor: "moonshot",
      apiKey: `built-in-key-moonshot-${agentId}`,
      label: agentId,
    },
  ];
}

async function deleteBuiltInModelKeysForSeededDefaultAgent(
  db: Db,
  orgId: string,
): Promise<void> {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.name, DEFAULT_AGENT_NAME)))
    .limit(1);

  if (!agent) {
    return;
  }

  await releaseBuiltInModelKeyFixture(db, agent.id);
}

async function ensureStarterCreditGrant(
  tx: StarterGrantTx,
  orgId: string,
): Promise<void> {
  const [existing] = await tx
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
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
}

async function slackInstallation(db: ReadonlyDb, teamId: string) {
  return (
    (
      await db
        .select({
          slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
          slackWorkspaceName: slackOrgInstallations.slackWorkspaceName,
          orgId: slackOrgInstallations.orgId,
          botUserId: slackOrgInstallations.botUserId,
          botScopes: slackOrgInstallations.botScopes,
          installedByUserId: slackOrgInstallations.installedByUserId,
          publicBrand: slackOrgInstallations.publicBrand,
          createdAt: slackOrgInstallations.createdAt,
        })
        .from(slackOrgInstallations)
        .where(eq(slackOrgInstallations.slackWorkspaceId, teamId))
        .limit(1)
    )[0] ?? null
  );
}

function slackConnections(db: ReadonlyDb, teamId: string) {
  return db
    .select({
      id: slackOrgConnections.id,
      slackUserId: slackOrgConnections.slackUserId,
      userId: slackOrgConnections.userId,
      dmWelcomeSent: slackOrgConnections.dmWelcomeSent,
      createdAt: slackOrgConnections.createdAt,
    })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, teamId));
}

function slackChatRoutes(db: ReadonlyDb, teamId: string) {
  return db
    .select({
      id: slackChatThreadRoutes.id,
      connectionId: slackChatThreadRoutes.connectionId,
      channelId: slackChatThreadRoutes.channelId,
      threadTs: slackChatThreadRoutes.threadTs,
      userId: slackChatThreadRoutes.userId,
      chatThreadId: slackChatThreadRoutes.chatThreadId,
      createdAt: slackChatThreadRoutes.createdAt,
    })
    .from(slackChatThreadRoutes)
    .innerJoin(
      slackOrgConnections,
      eq(slackChatThreadRoutes.connectionId, slackOrgConnections.id),
    )
    .where(eq(slackOrgConnections.slackWorkspaceId, teamId));
}

function slackChatIngressRows(db: ReadonlyDb, teamId: string) {
  return db
    .select({
      id: slackChatIngress.id,
      routeId: slackChatIngress.routeId,
      eventId: slackChatIngress.eventId,
      payload: slackChatIngress.payload,
      publicBrand: slackChatIngress.publicBrand,
      status: slackChatIngress.status,
      retryCount: slackChatIngress.retryCount,
      lastError: slackChatIngress.lastError,
      createdAt: slackChatIngress.createdAt,
      updatedAt: slackChatIngress.updatedAt,
    })
    .from(slackChatIngress)
    .innerJoin(
      slackChatThreadRoutes,
      eq(slackChatIngress.routeId, slackChatThreadRoutes.id),
    )
    .innerJoin(
      slackOrgConnections,
      eq(slackChatThreadRoutes.connectionId, slackOrgConnections.id),
    )
    .where(eq(slackOrgConnections.slackWorkspaceId, teamId));
}

function slackPendingChatEventRows(db: ReadonlyDb, teamId: string) {
  return db
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      eventType: chatEvents.eventType,
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .innerJoin(
      slackChatThreadRoutes,
      eq(chatEvents.chatThreadId, slackChatThreadRoutes.chatThreadId),
    )
    .innerJoin(
      slackOrgConnections,
      eq(slackChatThreadRoutes.connectionId, slackOrgConnections.id),
    )
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, teamId),
        chatEventTypeIn(["input.prompt", "input.automation"]),
        isNull(chatEvents.runId),
        notExists(
          db
            .select({ id: slackStateQueueRevoker.id })
            .from(slackStateQueueRevoker)
            .where(eq(slackStateQueueRevoker.revokesEventId, chatEvents.id)),
        ),
      ),
    );
}

function recentSlackRuns(db: ReadonlyDb, orgId: string | null | undefined) {
  if (!orgId) {
    return [];
  }

  return db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
      triggerSource: agentRuns.triggerSource,
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

async function orgMetaFor(db: ReadonlyDb, orgId: string | null | undefined) {
  if (!orgId) {
    return null;
  }

  return (
    (
      await db
        .select({
          orgId: orgMetadata.orgId,
          defaultAgentId: orgMetadata.defaultAgentId,
          credits: orgMetadata.credits,
          tier: orgMetadata.tier,
        })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1)
    )[0] ?? null
  );
}

async function defaultAgentFor(
  db: ReadonlyDb,
  defaultAgentId: string | null | undefined,
) {
  if (!defaultAgentId) {
    return null;
  }

  return (
    (
      await db
        .select({
          id: agents.id,
          name: agents.name,
          orgId: agents.orgId,
        })
        .from(agents)
        .where(eq(agents.id, defaultAgentId))
        .limit(1)
    )[0] ?? null
  );
}

async function upsertOrgCacheForTest(
  db: Db,
  args: {
    readonly orgId: string;
    readonly name?: string;
    readonly createdBy?: string;
  },
): Promise<void> {
  if (!args.name) {
    return;
  }
  await db
    .insert(orgCache)
    .values({
      orgId: args.orgId,
      name: args.name,
      createdBy: args.createdBy,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: {
        name: args.name,
        createdBy: args.createdBy,
        cachedAt: nowDate(),
      },
    });
}

async function seedUserSecretsForTest(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
  },
): Promise<void> {
  for (const name of args.names) {
    await db
      .insert(secrets)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        name,
        encryptedValue: `test-secret-${name}`,
        type: "user",
      })
      .onConflictDoNothing();
  }
}

async function seedUserVariablesForTest(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly variables: Readonly<Record<string, string>>;
  },
): Promise<void> {
  for (const [name, value] of Object.entries(args.variables)) {
    await db
      .insert(variables)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        name,
        value,
        type: "user",
      })
      .onConflictDoUpdate({
        target: [
          variables.orgId,
          variables.userId,
          variables.type,
          variables.name,
        ],
        targetWhere: isNull(variables.connectorId),
        set: { value, updatedAt: nowDate() },
      });
  }
}

const getSlackState$ = computed(async (get) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testSlackStateContract.get));
  const lookupEmptyTeamId = query.empty_team_id === "1";
  if (!query.team_id && !query.org_id && !lookupEmptyTeamId) {
    return {
      status: 400 as const,
      body: { error: "team_id or org_id query param is required" },
    };
  }

  const db = get(db$);
  const teamId = lookupEmptyTeamId ? "" : (query.team_id ?? "");
  const hasTeamIdLookup = Boolean(query.team_id) || lookupEmptyTeamId;
  const installationRow = hasTeamIdLookup
    ? await slackInstallation(db, teamId)
    : null;
  const connections = hasTeamIdLookup ? await slackConnections(db, teamId) : [];
  const chatThreadRoutes = hasTeamIdLookup
    ? await slackChatRoutes(db, teamId)
    : [];
  const chatIngress = hasTeamIdLookup
    ? await slackChatIngressRows(db, teamId)
    : [];
  const pendingChatEvents = hasTeamIdLookup
    ? await slackPendingChatEventRows(db, teamId)
    : [];
  const stateOrgId = query.org_id ?? installationRow?.orgId;
  const recentRuns = await recentSlackRuns(db, stateOrgId);
  const orgMeta = await orgMetaFor(db, stateOrgId);
  const defaultAgent = await defaultAgentFor(db, orgMeta?.defaultAgentId);
  return {
    status: 200 as const,
    body: {
      installation: installationRow
        ? {
            ...installationRow,
            createdAt: isoString(installationRow.createdAt),
          }
        : null,
      connections: connections.map((connection) => {
        return {
          ...connection,
          createdAt: isoString(connection.createdAt),
        };
      }),
      chat_thread_routes: chatThreadRoutes.map((route) => {
        return { ...route, createdAt: isoString(route.createdAt) };
      }),
      chat_ingress: chatIngress.map((ingress) => {
        return {
          ...ingress,
          createdAt: isoString(ingress.createdAt),
          updatedAt: isoString(ingress.updatedAt),
        };
      }),
      pending_chat_events: pendingChatEvents.map((item) => {
        return { ...item, createdAt: isoString(item.createdAt) };
      }),
      recent_runs: recentRuns.map((run) => {
        return {
          ...run,
          createdAt: isoString(run.createdAt),
        };
      }),
      org_metadata: orgMeta,
      default_agent: defaultAgent,
    },
  };
});

const postSlackStateBody$ = bodyResultOf(testSlackStateContract.post);

function postSlackStateValidationError(
  body: TestSlackStatePostBody,
): string | null {
  if (!body.team_id && !body.seed_default_agent && !body.org_id) {
    return "team_id is required unless seeding an org-scoped test fixture";
  }
  if (body.seed_connection && (!body.team_id || !body.slack_user_id)) {
    return "team_id and slack_user_id are required to seed a connection";
  }
  return null;
}

async function maybeUpsertSlackInstallationForPost(
  db: Db,
  body: TestSlackStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  if (!shouldUpsertSlackInstallationForPost(body)) {
    return;
  }
  if (body.seed_connection && !hasExplicitSlackInstallationFields(body)) {
    const existing = await slackInstallation(db, body.team_id!);
    if (existing) {
      return;
    }
  }
  await upsertSlackInstallation(db, {
    slackWorkspaceId: body.team_id!,
    slackWorkspaceName: body.workspace_name ?? DEFAULT_WORKSPACE_NAME,
    orgId:
      body.installation_org_id === undefined
        ? actor.orgId
        : body.installation_org_id,
    botUserId: body.bot_user_id ?? SLACK_E2E_FIXTURES.botUserId,
    botToken: body.bot_token ?? SLACK_E2E_FIXTURES.botToken,
    botScopes:
      body.bot_scopes === undefined ? SLACK_BOT_SCOPES : body.bot_scopes,
    installedByUserId: actor.userId,
    publicBrand: body.public_brand,
  });
}

function hasExplicitSlackInstallationFields(body: TestSlackStatePostBody) {
  return (
    body.workspace_name !== undefined ||
    body.bot_user_id !== undefined ||
    body.bot_scopes !== undefined ||
    body.bot_token !== undefined ||
    body.public_brand !== undefined ||
    body.installation_org_id !== undefined
  );
}

function shouldUpsertSlackInstallationForPost(
  body: TestSlackStatePostBody,
): boolean {
  if (!body.team_id) {
    return false;
  }

  if (body.seed_connection || !body.delete_connection) {
    return true;
  }

  return hasExplicitSlackInstallationFields(body);
}

async function maybeDeleteSlackConnectionForPost(
  db: Db,
  body: TestSlackStatePostBody,
): Promise<void> {
  if (!body.delete_connection || !body.team_id) {
    return;
  }
  if (body.user_id) {
    await db
      .delete(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, body.team_id),
          eq(slackOrgConnections.userId, body.user_id),
        ),
      );
    return;
  }
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, body.team_id));
}

async function maybeSeedSlackConnectionForPost(
  db: Db,
  body: TestSlackStatePostBody,
  userId: string,
): Promise<string | undefined> {
  if (!body.seed_connection) {
    return undefined;
  }
  return await insertSlackConnectionIfMissing(db, {
    slackUserId: body.slack_user_id!,
    slackWorkspaceId: body.team_id!,
    userId: userId,
  });
}

async function maybeSeedDefaultAgentForPost(
  db: Db,
  body: TestSlackStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
): Promise<{ readonly agentId: string } | undefined> {
  if (!body.seed_default_agent) {
    return undefined;
  }
  const defaultAgent = await seedDefaultAgent(db, {
    orgId: actor.orgId,
    userId: actor.userId,
    name: body.default_agent_name ?? DEFAULT_AGENT_NAME,
    displayName: body.default_agent_display_name,
  });
  return defaultAgent;
}

async function seedPostSlackUserData(
  db: Db,
  body: TestSlackStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  if (body.seed_secret_names) {
    await seedUserSecretsForTest(db, {
      orgId: actor.orgId,
      userId: actor.userId,
      names: body.seed_secret_names,
    });
  }
  if (body.seed_variables) {
    await seedUserVariablesForTest(db, {
      orgId: actor.orgId,
      userId: actor.userId,
      variables: body.seed_variables,
    });
  }
}

const postSlackState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const bodyResult = await get(postSlackStateBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const validationError = postSlackStateValidationError(body);
  if (validationError) {
    return {
      status: 400 as const,
      body: { error: validationError },
    };
  }

  let actor: { readonly orgId: string; readonly userId: string };
  if (body.org_id && !body.user_id && !body.email) {
    actor = {
      orgId: body.org_id,
      userId: `user_${body.org_id.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    };
  } else {
    const userId =
      body.user_id ??
      (await set(
        testUserId$,
        { email: body.email ?? DEFAULT_TEST_EMAIL, refresh: false },
        signal,
      ));
    signal.throwIfAborted();
    const orgId = body.org_id ?? (await set(resolveTestOrgId$, userId, signal));
    actor = { orgId, userId };
  }
  signal.throwIfAborted();

  const db = set(writeDb$);
  await upsertOrgCacheForTest(db, {
    orgId: actor.orgId,
    name: body.org_name,
    createdBy: actor.userId,
  });
  signal.throwIfAborted();

  await maybeUpsertSlackInstallationForPost(db, body, actor);
  signal.throwIfAborted();
  await maybeDeleteSlackConnectionForPost(db, body);
  signal.throwIfAborted();
  const connectionId = await maybeSeedSlackConnectionForPost(
    db,
    body,
    actor.userId,
  );
  signal.throwIfAborted();
  const defaultAgent = await maybeSeedDefaultAgentForPost(db, body, actor);
  signal.throwIfAborted();
  await seedPostSlackUserData(db, body, actor);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      team_id: body.team_id ?? "",
      org_id: actor.orgId,
      user_id: actor.userId,
      connection_id: connectionId ?? null,
      default_agent_id: defaultAgent?.agentId ?? null,
    },
  };
});

interface SlackStateDeleteQuery {
  readonly team_id?: string;
  readonly org_id?: string;
}

interface SlackInstallationDeleteRow {
  readonly slackWorkspaceId: string;
  readonly orgId: string | null;
}

async function slackInstallationRowsForDelete(
  db: Db,
  query: SlackStateDeleteQuery,
): Promise<readonly SlackInstallationDeleteRow[]> {
  if (query.team_id) {
    return await db
      .select({
        slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
        orgId: slackOrgInstallations.orgId,
      })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, query.team_id));
  }
  if (query.org_id) {
    return await db
      .select({
        slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
        orgId: slackOrgInstallations.orgId,
      })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, query.org_id));
  }
  return [];
}

function orgIdsForSlackStateDelete(
  rows: readonly SlackInstallationDeleteRow[],
  orgId: string | undefined,
): Set<string> {
  const orgIds = new Set(
    rows.flatMap((row) => {
      return row.orgId ? [row.orgId] : [];
    }),
  );
  if (orgId) {
    orgIds.add(orgId);
  }
  return orgIds;
}

function teamIdsForSlackStateDelete(
  rows: readonly SlackInstallationDeleteRow[],
  teamId: string | undefined,
): string[] {
  const teamIds = rows.map((row) => {
    return row.slackWorkspaceId;
  });
  if (teamId && !teamIds.includes(teamId)) {
    teamIds.push(teamId);
  }
  return teamIds;
}

async function deleteSlackTeamsForState(
  db: Db,
  teamIds: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (teamIds.length === 0) {
    return;
  }
  await db
    .delete(slackOrgConnections)
    .where(inArray(slackOrgConnections.slackWorkspaceId, teamIds));
  signal.throwIfAborted();

  await db
    .delete(slackOrgInstallations)
    .where(inArray(slackOrgInstallations.slackWorkspaceId, teamIds));
  signal.throwIfAborted();
}

async function deleteSlackRunsForOrg(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const slackAgentRuns = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.orgId, orgId), eq(agentRuns.triggerSource, "slack")),
    );
  signal.throwIfAborted();

  const runIds = slackAgentRuns.map((run) => {
    return run.id;
  });
  if (runIds.length === 0) {
    return;
  }
  await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  signal.throwIfAborted();
}

async function deleteSlackAgentsForOrg(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const agentRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.orgId, orgId));
  signal.throwIfAborted();
  const agentIds = agentRows.map((row) => {
    return row.id;
  });
  if (agentIds.length === 0) {
    return;
  }
  await db.delete(agents).where(inArray(agents.id, agentIds));
  signal.throwIfAborted();
}

async function deleteSlackOrgState(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  await db.delete(secrets).where(eq(secrets.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(variables).where(eq(variables.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(orgCache).where(eq(orgCache.orgId, orgId));
  signal.throwIfAborted();
  await deleteSlackAgentsForOrg(db, orgId, signal);
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
}

const deleteSlackState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testSlackStateContract.delete));
  if (!query.team_id && !query.org_id) {
    return {
      status: 400 as const,
      body: { error: "team_id or org_id query param is required" },
    };
  }

  const db = set(writeDb$);
  const teamId = query.team_id;
  const orgId = query.org_id;
  const installationRows = await slackInstallationRowsForDelete(db, query);
  signal.throwIfAborted();
  const orgIds = orgIdsForSlackStateDelete(installationRows, orgId);
  for (const seededOrgId of orgIds) {
    await deleteBuiltInModelKeysForSeededDefaultAgent(db, seededOrgId);
    signal.throwIfAborted();
  }

  await deleteSlackTeamsForState(
    db,
    teamIdsForSlackStateDelete(installationRows, teamId),
    signal,
  );

  for (const seededOrgId of orgIds) {
    await deleteSlackRunsForOrg(db, seededOrgId, signal);
  }

  if (orgId) {
    await deleteSlackOrgState(db, orgId, signal);
  }

  return {
    status: 200 as const,
    body: { ok: true as const },
  };
});

export const testSlackStateRoutes: readonly RouteEntry[] = [
  {
    route: testSlackStateContract.get,
    handler: getSlackState$,
  },
  {
    route: testSlackStateContract.post,
    handler: postSlackState$,
  },
  {
    route: testSlackStateContract.delete,
    handler: deleteSlackState$,
  },
];
