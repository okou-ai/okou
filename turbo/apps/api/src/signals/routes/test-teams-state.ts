import { randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  getBuiltInVendor,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  testTeamsStateContract,
  type TestTeamsStatePostBody,
} from "@okouai/api-contracts/contracts/test-teams-state";
import { agents } from "@okouai/db/schema/agent";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { teamsUserAgentPreferences } from "@okouai/db/schema/teams-user-agent-preference";
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { db$, type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { resolveTestOrgId$, testUserId$ } from "../services/cli-auth.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { ensureAgentInstructionsStorageFixture } from "./test-agent-instructions-storage";
import type { Tx } from "../../lib/db-types";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "../services/org-plan-entitlements.service";

const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";
const DEFAULT_TENANT_NAME = "E2E Test Tenant";
const DEFAULT_TEAM_NAME = "E2E Test Team";
const DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const DEFAULT_BOT_ID = "28:e2e-test-bot";
const DEFAULT_BOT_NAME = "Okou";
const DEFAULT_AGENT_NAME = "e2e-teams-agent";
const STARTER_GRANT_AMOUNT = 10_000;
const STARTER_GRANT_SOURCE = "starter_grant";

type StarterGrantTx = Tx;

function isoString(value: Date): string {
  return value.toISOString();
}

function nullableIsoString(value: Date | null): string | null {
  return value ? isoString(value) : null;
}

interface UpsertTeamsInstallationInput {
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly orgId: string | null;
  readonly installedByUserId: string;
  readonly serviceUrl: string;
  readonly botId: string | null;
  readonly botName: string | null;
}

async function upsertTeamsInstallation(
  db: Db,
  input: UpsertTeamsInstallationInput,
): Promise<typeof teamsOrgInstallations.$inferSelect> {
  const [row] = await db
    .insert(teamsOrgInstallations)
    .values({
      teamsTenantId: input.tenantId,
      teamsTenantName: input.tenantName,
      teamsTeamId: input.teamId,
      teamsTeamName: input.teamName,
      orgId: input.orgId,
      installedByUserId: input.installedByUserId,
      serviceUrl: input.serviceUrl,
      botId: input.botId,
      botName: input.botName,
    })
    .onConflictDoUpdate({
      target: teamsOrgInstallations.teamsTenantId,
      set: {
        teamsTenantName: input.tenantName,
        teamsTeamId: input.teamId,
        teamsTeamName: input.teamName,
        orgId: input.orgId,
        installedByUserId: input.installedByUserId,
        serviceUrl: input.serviceUrl,
        botId: input.botId,
        botName: input.botName,
        updatedAt: nowDate(),
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to upsert Teams installation");
  }
  return row;
}

async function findTeamsConnection(
  db: ReadonlyDb,
  args: {
    readonly tenantId: string;
    readonly teamsUserId: string | null | undefined;
    readonly teamsAadObjectId: string | null | undefined;
  },
): Promise<typeof teamsOrgConnections.$inferSelect | undefined> {
  if (args.teamsAadObjectId) {
    const [row] = await db
      .select()
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsTenantId, args.tenantId),
          eq(teamsOrgConnections.teamsAadObjectId, args.teamsAadObjectId),
        ),
      )
      .limit(1);
    if (row) {
      return row;
    }
  }

  if (!args.teamsUserId) {
    return undefined;
  }
  const [row] = await db
    .select()
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.teamsTenantId, args.tenantId),
        eq(teamsOrgConnections.teamsUserId, args.teamsUserId),
      ),
    )
    .limit(1);
  return row;
}

async function upsertTeamsConnection(
  db: Db,
  args: {
    readonly tenantId: string;
    readonly teamsUserId: string | null | undefined;
    readonly teamsAadObjectId: string | null | undefined;
    readonly userId: string;
    readonly displayName: string | null | undefined;
    readonly principalName: string | null | undefined;
  },
): Promise<string> {
  const [inserted] = await db
    .insert(teamsOrgConnections)
    .values({
      teamsTenantId: args.tenantId,
      teamsUserId: args.teamsUserId ?? null,
      teamsAadObjectId: args.teamsAadObjectId ?? null,
      userId: args.userId,
      teamsUserDisplayName: args.displayName ?? null,
      teamsUserPrincipalName: args.principalName ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: teamsOrgConnections.id });
  if (inserted) {
    return inserted.id;
  }

  const existing = await findTeamsConnection(db, args);
  if (!existing) {
    throw new Error("Failed to resolve Teams connection after conflict");
  }

  await db
    .update(teamsOrgConnections)
    .set({
      teamsUserId: args.teamsUserId ?? existing.teamsUserId,
      teamsAadObjectId: args.teamsAadObjectId ?? existing.teamsAadObjectId,
      userId: args.userId,
      teamsUserDisplayName: args.displayName ?? existing.teamsUserDisplayName,
      teamsUserPrincipalName:
        args.principalName ?? existing.teamsUserPrincipalName,
      updatedAt: nowDate(),
    })
    .where(eq(teamsOrgConnections.id, existing.id));
  return existing.id;
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
  signal: AbortSignal,
): Promise<{ agentId: string }> {
  const [agent] = await db
    .insert(agents)
    .values({
      id: randomUUID(),
      orgId: input.orgId,
      owner: input.userId,
      name: input.name,
      displayName: input.displayName ?? null,
    })
    .onConflictDoUpdate({
      target: [agents.orgId, agents.name],
      set: {
        owner: input.userId,
        displayName: input.displayName ?? null,
        updatedAt: nowDate(),
      },
    })
    .returning({ id: agents.id });
  if (!agent) {
    throw new Error("Failed to resolve seeded default Agent");
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

async function seedBuiltInModelKeys(db: Db, agentId: string): Promise<void> {
  await db.delete(builtInModelKeys).where(eq(builtInModelKeys.label, agentId));
  await db
    .insert(builtInModelKeys)
    .values(builtInModelKeyRows(agentId))
    .onConflictDoNothing({ target: builtInModelKeys.vendor });
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

  const apiKeys = builtInModelKeyRows(agent.id).map((row) => {
    return row.apiKey;
  });
  await db
    .delete(builtInModelKeys)
    .where(
      and(
        eq(builtInModelKeys.label, agent.id),
        inArray(builtInModelKeys.apiKey, apiKeys),
      ),
    );
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

async function teamsInstallation(db: ReadonlyDb, tenantId: string) {
  const [installation] = await db
    .select({
      teamsTenantId: teamsOrgInstallations.teamsTenantId,
      teamsTenantName: teamsOrgInstallations.teamsTenantName,
      teamsTeamId: teamsOrgInstallations.teamsTeamId,
      teamsTeamName: teamsOrgInstallations.teamsTeamName,
      teamsAppId: teamsOrgInstallations.teamsAppId,
      botId: teamsOrgInstallations.botId,
      botName: teamsOrgInstallations.botName,
      serviceUrl: teamsOrgInstallations.serviceUrl,
      orgId: teamsOrgInstallations.orgId,
      installedByUserId: teamsOrgInstallations.installedByUserId,
      createdAt: teamsOrgInstallations.createdAt,
    })
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId))
    .limit(1);
  return installation ?? null;
}

function teamsConnections(db: ReadonlyDb, tenantId: string) {
  return db
    .select({
      id: teamsOrgConnections.id,
      teamsUserId: teamsOrgConnections.teamsUserId,
      teamsAadObjectId: teamsOrgConnections.teamsAadObjectId,
      userId: teamsOrgConnections.userId,
      teamsUserDisplayName: teamsOrgConnections.teamsUserDisplayName,
      teamsUserPrincipalName: teamsOrgConnections.teamsUserPrincipalName,
      dmWelcomeSent: teamsOrgConnections.dmWelcomeSent,
      createdAt: teamsOrgConnections.createdAt,
    })
    .from(teamsOrgConnections)
    .where(eq(teamsOrgConnections.teamsTenantId, tenantId));
}

function teamsRoutes(db: ReadonlyDb, connectionIds: readonly string[]) {
  if (connectionIds.length === 0) {
    return [];
  }
  return db
    .select({
      id: teamsChatThreadRoutes.id,
      connectionId: teamsChatThreadRoutes.connectionId,
      conversationId: teamsChatThreadRoutes.conversationId,
      threadId: teamsChatThreadRoutes.threadId,
      userId: teamsChatThreadRoutes.userId,
      chatThreadId: teamsChatThreadRoutes.chatThreadId,
      createdAt: teamsChatThreadRoutes.createdAt,
    })
    .from(teamsChatThreadRoutes)
    .where(inArray(teamsChatThreadRoutes.connectionId, [...connectionIds]));
}

function recentTeamsRuns(db: ReadonlyDb, orgId: string | null | undefined) {
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

function recentTeamsCallbacks(
  db: ReadonlyDb,
  orgId: string | null | undefined,
) {
  if (!orgId) {
    return [];
  }
  return db
    .select({
      id: agentRunCallbacks.id,
      runId: agentRunCallbacks.runId,
      status: agentRunCallbacks.status,
      internalKind: agentRunCallbacks.internalKind,
      attempts: agentRunCallbacks.attempts,
      lastError: agentRunCallbacks.lastError,
      createdAt: agentRunCallbacks.createdAt,
      lastAttemptAt: agentRunCallbacks.lastAttemptAt,
      deliveredAt: agentRunCallbacks.deliveredAt,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        or(
          eq(agentRunCallbacks.internalKind, "teams:chat"),
          and(
            eq(agentRunCallbacks.internalKind, "chat"),
            isNotNull(sql`${agentRunCallbacks.payload}->'teamsDelivery'`),
          ),
        ),
      ),
    )
    .orderBy(desc(agentRunCallbacks.createdAt))
    .limit(50);
}

async function orgMetaFor(db: ReadonlyDb, orgId: string | null | undefined) {
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

async function defaultAgentFor(
  db: ReadonlyDb,
  defaultAgentId: string | null | undefined,
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

const getTeamsState$ = computed(async (get) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testTeamsStateContract.get));
  if (!query.tenant_id && !query.org_id) {
    return {
      status: 400 as const,
      body: { error: "tenant_id or org_id query param is required" },
    };
  }

  const db = get(db$);
  const installationRow = query.tenant_id
    ? await teamsInstallation(db, query.tenant_id)
    : null;
  const connections = query.tenant_id
    ? await teamsConnections(db, query.tenant_id)
    : [];
  const routes = await teamsRoutes(
    db,
    connections.map((connection) => {
      return connection.id;
    }),
  );
  const stateOrgId = query.org_id ?? installationRow?.orgId;
  const recentRuns = await recentTeamsRuns(db, stateOrgId);
  const orgMeta = await orgMetaFor(db, stateOrgId);
  const defaultAgent = await defaultAgentFor(db, orgMeta?.defaultAgentId);
  const callbacks = await recentTeamsCallbacks(db, stateOrgId);

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
        return { ...connection, createdAt: isoString(connection.createdAt) };
      }),
      routes: routes.map((route) => {
        return { ...route, createdAt: isoString(route.createdAt) };
      }),
      recent_runs: recentRuns.map((run) => {
        return { ...run, createdAt: isoString(run.createdAt) };
      }),
      recent_callbacks: callbacks.map((callback) => {
        return {
          ...callback,
          createdAt: isoString(callback.createdAt),
          lastAttemptAt: nullableIsoString(callback.lastAttemptAt),
          deliveredAt: nullableIsoString(callback.deliveredAt),
        };
      }),
      org_metadata: orgMeta,
      default_agent: defaultAgent,
    },
  };
});

const postTeamsStateBody$ = bodyResultOf(testTeamsStateContract.post);

function postTeamsStateValidationError(
  body: TestTeamsStatePostBody,
): string | null {
  if (!body.tenant_id && !body.seed_default_agent && !body.org_id) {
    return "tenant_id is required unless seeding an org-scoped test fixture";
  }
  if (
    body.seed_connection &&
    (!body.tenant_id || (!body.teams_user_id && !body.teams_aad_object_id))
  ) {
    return "tenant_id and teams_user_id or teams_aad_object_id are required to seed a connection";
  }
  return null;
}

async function maybeUpsertTeamsInstallationForPost(
  db: Db,
  body: TestTeamsStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  if (!body.tenant_id) {
    return;
  }
  await upsertTeamsInstallation(db, {
    tenantId: body.tenant_id,
    tenantName: body.tenant_name ?? DEFAULT_TENANT_NAME,
    teamId: body.team_id ?? null,
    teamName: body.team_name ?? DEFAULT_TEAM_NAME,
    orgId:
      body.installation_org_id === undefined
        ? actor.orgId
        : body.installation_org_id,
    installedByUserId: actor.userId,
    serviceUrl: body.service_url ?? DEFAULT_SERVICE_URL,
    botId: body.bot_id ?? DEFAULT_BOT_ID,
    botName: body.bot_name ?? DEFAULT_BOT_NAME,
  });
}

async function maybeDeleteTeamsConnectionForPost(
  db: Db,
  body: TestTeamsStatePostBody,
): Promise<void> {
  if (!body.delete_connection || !body.tenant_id) {
    return;
  }
  if (body.user_id) {
    await db
      .delete(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsTenantId, body.tenant_id),
          eq(teamsOrgConnections.userId, body.user_id),
        ),
      );
    return;
  }
  await db
    .delete(teamsOrgConnections)
    .where(eq(teamsOrgConnections.teamsTenantId, body.tenant_id));
}

async function maybeSeedTeamsConnectionForPost(
  db: Db,
  body: TestTeamsStatePostBody,
  userId: string,
): Promise<string | undefined> {
  if (!body.seed_connection) {
    return undefined;
  }
  return await upsertTeamsConnection(db, {
    tenantId: body.tenant_id!,
    teamsUserId: body.teams_user_id,
    teamsAadObjectId: body.teams_aad_object_id,
    userId: userId,
    displayName: body.teams_user_display_name,
    principalName: body.teams_user_principal_name,
  });
}

async function maybeSeedDefaultAgentForPost(
  db: Db,
  body: TestTeamsStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
  signal: AbortSignal,
): Promise<{ readonly agentId: string } | undefined> {
  if (!body.seed_default_agent) {
    return undefined;
  }
  return await seedDefaultAgent(
    db,
    {
      orgId: actor.orgId,
      userId: actor.userId,
      name: body.default_agent_name ?? DEFAULT_AGENT_NAME,
      displayName: body.default_agent_display_name,
    },
    signal,
  );
}

const postTeamsState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const bodyResult = await get(postTeamsStateBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const validationError = postTeamsStateValidationError(body);
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
  await maybeUpsertTeamsInstallationForPost(db, body, actor);
  signal.throwIfAborted();
  await maybeDeleteTeamsConnectionForPost(db, body);
  signal.throwIfAborted();
  const connectionId = await maybeSeedTeamsConnectionForPost(
    db,
    body,
    actor.userId,
  );
  signal.throwIfAborted();
  const defaultAgent = await maybeSeedDefaultAgentForPost(
    db,
    body,
    actor,
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      tenant_id: body.tenant_id ?? "",
      org_id: actor.orgId,
      user_id: actor.userId,
      connection_id: connectionId ?? null,
      default_agent_id: defaultAgent?.agentId ?? null,
    },
  };
});

interface TeamsStateDeleteQuery {
  readonly tenant_id?: string;
  readonly org_id?: string;
}

interface TeamsInstallationDeleteRow {
  readonly teamsTenantId: string;
  readonly orgId: string | null;
}

async function teamsInstallationRowsForDelete(
  db: Db,
  query: TeamsStateDeleteQuery,
): Promise<readonly TeamsInstallationDeleteRow[]> {
  if (query.tenant_id) {
    return await db
      .select({
        teamsTenantId: teamsOrgInstallations.teamsTenantId,
        orgId: teamsOrgInstallations.orgId,
      })
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.teamsTenantId, query.tenant_id));
  }
  if (query.org_id) {
    return await db
      .select({
        teamsTenantId: teamsOrgInstallations.teamsTenantId,
        orgId: teamsOrgInstallations.orgId,
      })
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, query.org_id));
  }
  return [];
}

function orgIdsForTeamsStateDelete(
  rows: readonly TeamsInstallationDeleteRow[],
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

function tenantIdsForTeamsStateDelete(
  rows: readonly TeamsInstallationDeleteRow[],
  tenantId: string | undefined,
): string[] {
  const tenantIds = rows.map((row) => {
    return row.teamsTenantId;
  });
  if (tenantId && !tenantIds.includes(tenantId)) {
    tenantIds.push(tenantId);
  }
  return tenantIds;
}

async function deleteTeamsTenantsForState(
  db: Db,
  tenantIds: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (tenantIds.length === 0) {
    return;
  }
  await db
    .delete(teamsOrgConnections)
    .where(inArray(teamsOrgConnections.teamsTenantId, tenantIds));
  signal.throwIfAborted();
  await db
    .delete(teamsOrgInstallations)
    .where(inArray(teamsOrgInstallations.teamsTenantId, tenantIds));
  signal.throwIfAborted();
}

async function deleteTeamsRunsForOrg(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const teamsAgentRuns = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.orgId, orgId), eq(agentRuns.triggerSource, "teams")),
    );
  signal.throwIfAborted();

  const runIds = teamsAgentRuns.map((run) => {
    return run.id;
  });
  if (runIds.length === 0) {
    return;
  }
  await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  signal.throwIfAborted();
}

async function deleteTeamsAgentsForOrg(
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

async function deleteTeamsOrgState(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(teamsUserAgentPreferences)
    .where(eq(teamsUserAgentPreferences.orgId, orgId));
  signal.throwIfAborted();
  await deleteTeamsAgentsForOrg(db, orgId, signal);
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
}

const deleteTeamsState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testTeamsStateContract.delete));
  if (!query.tenant_id && !query.org_id) {
    return {
      status: 400 as const,
      body: { error: "tenant_id or org_id query param is required" },
    };
  }

  const db = set(writeDb$);
  const installationRows = await teamsInstallationRowsForDelete(db, query);
  signal.throwIfAborted();
  const orgIds = orgIdsForTeamsStateDelete(installationRows, query.org_id);
  for (const orgId of orgIds) {
    await deleteBuiltInModelKeysForSeededDefaultAgent(db, orgId);
    signal.throwIfAborted();
  }

  await deleteTeamsTenantsForState(
    db,
    tenantIdsForTeamsStateDelete(installationRows, query.tenant_id),
    signal,
  );

  for (const orgId of orgIds) {
    await deleteTeamsRunsForOrg(db, orgId, signal);
  }

  if (query.org_id) {
    await deleteTeamsOrgState(db, query.org_id, signal);
  }

  return {
    status: 200 as const,
    body: { ok: true as const },
  };
});

export const testTeamsStateRoutes: readonly RouteEntry[] = [
  {
    route: testTeamsStateContract.get,
    handler: getTeamsState$,
  },
  {
    route: testTeamsStateContract.post,
    handler: postTeamsState$,
  },
  {
    route: testTeamsStateContract.delete,
    handler: deleteTeamsState$,
  },
];
