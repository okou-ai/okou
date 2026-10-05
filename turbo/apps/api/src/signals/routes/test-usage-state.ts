import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  testUsageStateContract,
  type TestUsageStateActionBody,
} from "@okouai/api-contracts/contracts/test-usage-state";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
  usageAllowanceAllocations,
} from "@okouai/db/schema/org-usage-allowance";
import { secrets } from "@okouai/db/schema/secret";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { userBuiltinConnectors } from "@okouai/db/schema/user-connector";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { variables } from "@okouai/db/schema/variable";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
  sum,
} from "drizzle-orm";

import { nowDate } from "../../lib/time";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { billingRunAttributionWrite } from "../services/managed-usage-attribution";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { compactUsageEvents$ } from "../services/cron-compact-usage-events.service";
import { normalizeRunMetadata } from "../services/agent-run-metadata-write.service";
import { deleteUsageData$ } from "../services/usage-event-cleanup.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { ensureOrgMetadataPlanEntitlement } from "../services/org-plan-entitlements.service";

const actionBody$ = bodyResultOf(testUsageStateContract.action);
const compactBody$ = bodyResultOf(testUsageStateContract.compact);
const compactOwnedUsage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(compactBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const result = await set(
      compactUsageEvents$,
      bodyResult.data.orgId,
      signal,
    );
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

interface UsageStateFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface SeedRunArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly triggerSource?: string;
  readonly chatThreadId?: string;
  readonly status?: string;
  readonly prompt?: string;
  readonly createdAt?: Date;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly continuedFromSessionId?: string | null;
  readonly sandboxReuseResult?: string | null;
  readonly workspaceReuseResult?: string | null;
  readonly result?: Record<string, unknown> | null;
  readonly error?: string | null;
  readonly lastEventSequence?: number | null;
  readonly selectedModel?: string | null;
  readonly lifecycleOnly?: boolean;
}

type UsageStateAction<Action extends TestUsageStateActionBody["action"]> =
  Extract<TestUsageStateActionBody, { readonly action: Action }>;

type UsageStateFixtureAction = UsageStateAction<
  "seed-fixture" | "delete-fixture" | "seed-compose"
>;

type UsageStateRunAction = UsageStateAction<"seed-chat-thread">;

type UsageStateEventWriteAction = UsageStateAction<
  | "attach-usage-allowance"
  | "read-allowance-window-state"
  | "read-usage-event-state"
>;

type UsageStateEventMaterializationAction = UsageStateAction<
  "delete-run" | "delete-billing-attribution" | "read-usage-storage-counts"
>;

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  return new Date(value);
}

function parseMaybeDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  return new Date(value);
}

function fixtureToWire(fixture: UsageStateFixture) {
  return { org_id: fixture.orgId, user_id: fixture.userId };
}

function fixtureFromWire(fixture: {
  readonly org_id: string;
  readonly user_id: string;
}): UsageStateFixture {
  return { orgId: fixture.org_id, userId: fixture.user_id };
}

async function seedUsageStateFixture(db: Db): Promise<UsageStateFixture> {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  await db.transaction(async (tx) => {
    const metadataRows = await tx
      .insert(orgMetadataCanonicalWrites)
      .values({
        orgId: fixture.orgId,
        tier: "limited-free-1",
        credits: 10_000,
      })
      .returning({
        orgId: orgMetadataCanonicalWrites.orgId,
        tier: orgMetadataCanonicalWrites.tier,
      });
    for (const metadata of metadataRows) {
      await ensureOrgMetadataPlanEntitlement(tx, metadata);
    }
  });
  return fixture;
}

async function deleteUsageStateFixtureUsageData(
  db: Db,
  fixture: UsageStateFixture,
  signal: AbortSignal,
): Promise<void> {
  const ownedRaw = and(
    eq(usageEvent.orgId, fixture.orgId),
    eq(usageEvent.userId, fixture.userId),
  );
  const rawRows = await db
    .select({ id: usageEvent.id })
    .from(usageEvent)
    .where(ownedRaw);
  signal.throwIfAborted();
  // This fixture has no live raw producer during cleanup. Compaction may only
  // consume its existing rows. Each delete commits separately: cleanup never
  // holds one raw row while waiting for another row held by the compactor.
  // Do not wrap this loop in a transaction or replace it with a bulk delete.
  for (const row of rawRows) {
    await db
      .delete(usageEvent)
      .where(and(ownedRaw, eq(usageEvent.id, row.id)));
    signal.throwIfAborted();
  }
  // Raw deletion waits for any winning compaction to commit. This subsequent
  // READ COMMITTED statement then removes its new hourly facts as well.
  await db
    .delete(usageEventHourlyRollup)
    .where(
      and(
        eq(usageEventHourlyRollup.orgId, fixture.orgId),
        eq(usageEventHourlyRollup.userId, fixture.userId),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, fixture.orgId));
  signal.throwIfAborted();
}

async function deleteUsageStateFixture(
  db: Db,
  fixture: UsageStateFixture,
  signal: AbortSignal,
): Promise<void> {
  const orgId = fixture.orgId;
  const userId = fixture.userId;

  await deleteUsageStateFixtureUsageData(db, fixture, signal);

  await db
    .delete(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, orgId),
        eq(userPermissionGrants.userId, userId),
      ),
    );
  signal.throwIfAborted();

  await db
    .delete(userBuiltinConnectors)
    .where(
      and(
        eq(userBuiltinConnectors.orgId, orgId),
        eq(userBuiltinConnectors.userId, userId),
      ),
    );
  signal.throwIfAborted();

  await db
    .delete(connectors)
    .where(and(eq(connectors.orgId, orgId), eq(connectors.userId, userId)));
  signal.throwIfAborted();

  await db.delete(secrets).where(eq(secrets.orgId, orgId));
  signal.throwIfAborted();

  await db.delete(variables).where(eq(variables.orgId, orgId));
  signal.throwIfAborted();

  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();

  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.userId, userId)));
  signal.throwIfAborted();
  const runIds = runRows.map((row) => {
    return row.id;
  });
  if (runIds.length > 0) {
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    signal.throwIfAborted();
  }

  await db
    .delete(agentSessions)
    .where(
      and(eq(agentSessions.orgId, orgId), eq(agentSessions.userId, userId)),
    );
  signal.throwIfAborted();

  await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
  signal.throwIfAborted();

  await db
    .delete(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.owner, userId)));
  signal.throwIfAborted();

  const storageRows = await db
    .select({ id: storages.id })
    .from(storages)
    .where(eq(storages.orgId, orgId));
  signal.throwIfAborted();
  const storageIds = storageRows.map((row) => {
    return row.id;
  });
  if (storageIds.length > 0) {
    await db
      .update(storages)
      .set({ headVersionId: null })
      .where(inArray(storages.id, storageIds));
    signal.throwIfAborted();
    await db
      .delete(storageVersions)
      .where(inArray(storageVersions.storageId, storageIds));
    signal.throwIfAborted();
    await db.delete(storages).where(eq(storages.orgId, orgId));
    signal.throwIfAborted();
  }
}

async function seedCompose(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly name?: string;
    readonly displayName?: string | null;
    readonly visibility?: "public" | "private";
  },
): Promise<{ composeId: string; agentId: string }> {
  const name = args.name ?? `compose-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(agents)
    .values({
      id: randomUUID(),
      owner: args.userId,
      orgId: args.orgId,
      name,
      displayName: args.displayName ?? null,
      visibility: args.visibility ?? "public",
    })
    .returning({ id: agents.id });
  if (!row) {
    throw new Error("seedCompose: insert returned no row");
  }
  return { composeId: row.id, agentId: row.id };
}

const seedRun$ = command(
  async (
    { set },
    args: SeedRunArgs,
    signal: AbortSignal,
  ): Promise<{ runId: string }> => {
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
      const [session] = await tx
        .insert(agentSessions)
        .values({
          userId: args.userId,
          orgId: args.orgId,
          agentId: args.agentId,
        })
        .returning({ id: agentSessions.id });
      signal.throwIfAborted();
      if (!session) {
        throw new Error("seedRun: session insert returned no row");
      }
      const metadata = args.lifecycleOnly
        ? null
        : normalizeRunMetadata({
            triggerSource: args.triggerSource ?? "test",
            chatThreadId: args.chatThreadId,
            selectedModel: args.selectedModel,
          });
      const [run] = await tx
        .insert(agentRuns)
        .values({
          userId: args.userId,
          orgId: args.orgId,
          prompt: args.prompt ?? "test prompt",
          status: args.status ?? "pending",
          sessionId: session.id,
          createdAt: args.createdAt,
          startedAt: args.startedAt,
          completedAt: args.completedAt,
          continuedFromSessionId: args.continuedFromSessionId,
          sandboxReuseResult: args.sandboxReuseResult ?? null,
          workspaceReuseResult: args.workspaceReuseResult ?? null,
          result: args.result ?? null,
          error: args.error ?? null,
          lastEventSequence: args.lastEventSequence ?? null,
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
      if (!run) {
        throw new Error("seedRun: run insert returned no row");
      }
      const capture = billingRunAttributionWrite(run);
      const [captured] = await tx
        .insert(billingRunAttribution)
        .values(capture.values)
        .onConflictDoUpdate(capture.conflict)
        .returning({ runId: billingRunAttribution.runId });
      if (!captured) {
        throw new Error("Fixture Run billing identity conflicts with history");
      }
      signal.throwIfAborted();
      return { runId: run.id };
    });
    signal.throwIfAborted();
    return result;
  },
);

async function seedChatThread(
  db: Db,
  args: {
    readonly userId: string;
    readonly agentId: string;
    readonly title?: string;
  },
  signal: AbortSignal,
): Promise<string> {
  const [row] = await db
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentId: args.agentId,
      title: args.title ?? null,
    })
    .returning({ id: chatThreads.id });
  signal.throwIfAborted();
  if (!row) {
    throw new Error("seedChatThread: insert returned no row");
  }
  return row.id;
}

function buildGenericUsageRows(args: {
  readonly orgId: string;
  readonly userId?: string;
  readonly runId?: string | null;
  readonly kind?: string;
  readonly provider?: string;
  readonly category?: string;
  readonly quantity?: number;
  readonly status?: string;
  readonly creditsCharged?: number;
  readonly idempotencyKey?: string;
  readonly billingError?: string | null;
  readonly createdAt?: Date;
  readonly processedAt?: Date | null;
  readonly count?: number;
}) {
  const status = args.status ?? "pending";
  const processedAt =
    args.processedAt !== undefined
      ? args.processedAt
      : status === "processed"
        ? nowDate()
        : null;
  const count = args.count ?? 1;
  const values = Array.from({ length: count }, () => {
    return {
      runId: args.runId ?? null,
      orgId: args.orgId,
      userId: args.userId ?? "test-user",
      kind: args.kind ?? "connector",
      provider: args.provider ?? "x",
      category: args.category ?? "tweet.read",
      quantity: args.quantity ?? 1,
      status,
      creditsCharged: args.creditsCharged ?? null,
      billingError: args.billingError ?? null,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
      createdAt: args.createdAt ?? nowDate(),
      processedAt,
    };
  });
  return values;
}

type UsageInsertAction = UsageStateAction<"insert-usage-event">;

function buildFixtureUsageRows(body: UsageInsertAction) {
  const processedAt =
    body.processed_at === undefined
      ? undefined
      : parseOptionalDate(body.processed_at);
  return buildGenericUsageRows({
    orgId: body.org_id,
    userId: body.user_id,
    runId: body.run_id,
    kind: body.kind,
    provider: body.provider,
    category: body.category,
    quantity: body.quantity,
    status: body.status,
    creditsCharged: body.credits_charged,
    idempotencyKey: body.idempotency_key,
    billingError: body.billing_error,
    createdAt: parseMaybeDate(body.created_at),
    processedAt,
    count: body.count,
  });
}

const insertFixtureUsage$ = command(
  async ({ set }, body: UsageInsertAction, signal: AbortSignal) => {
    const db = set(writeDb$);
    const values = buildFixtureUsageRows(body);
    let firstId: string | undefined;
    for (let offset = 0; offset < values.length; offset += 500) {
      const batch = values.slice(offset, offset + 500);
      const ids = await db.transaction(async (tx) => {
        const runId = body.run_id ?? null;
        if (runId) {
          const [run] = await tx
            .select({
              id: agentRuns.id,
              orgId: agentRuns.orgId,
              userId: agentRuns.userId,
              startedAt: sql`${agentRuns.createdAt}::text`.mapWith(
                pgTextDecoder,
              ),
              triggerSource: agentRuns.triggerSource,
              threadId: agentRuns.chatThreadId,
            })
            .from(agentRuns)
            .where(eq(agentRuns.id, runId));
          signal.throwIfAborted();
          if (run) {
            const capture = billingRunAttributionWrite(run);
            const [captured] = await tx
              .insert(billingRunAttribution)
              .values(capture.values)
              .onConflictDoUpdate(capture.conflict)
              .returning({ runId: billingRunAttribution.runId });
            if (!captured) {
              throw new Error(
                "Fixture usage identity conflicts with Run history",
              );
            }
          }
        }
        const [attribution] = await tx
          .select({
            orgId: billingRunAttribution.orgId,
            userId: billingRunAttribution.userId,
            anchor: sql`${billingRunAttribution.runStartedAt}::text`.mapWith(
              pgTextDecoder,
            ),
          })
          .from(billingRunAttribution)
          .where(runId ? eq(billingRunAttribution.runId, runId) : sql`false`);
        signal.throwIfAborted();
        if (
          attribution &&
          (attribution.orgId !== body.org_id ||
            attribution.userId !== (body.user_id ?? "test-user"))
        ) {
          throw new Error("Fixture usage owner conflicts with Run history");
        }
        const inserted = await tx
          .insert(usageEvent)
          .values(
            batch.map((row) => {
              return {
                ...row,
                billingRunId: runId,
                // A fixture's NULL legacy link does not prove intentional runless usage.
                billingContext: attribution
                  ? "run"
                  : runId
                    ? "missing_run"
                    : "legacy_unknown",
                billingAnchorAt: attribution
                  ? sql`${attribution.anchor}::timestamp`
                  : null,
              };
            }),
          )
          .returning({ id: usageEvent.id });
        if (runId) {
          await tx
            .update(billingRunAttribution)
            .set({ usageObserved: true })
            .where(
              and(
                eq(billingRunAttribution.runId, runId),
                eq(billingRunAttribution.usageObserved, false),
              ),
            );
        }
        signal.throwIfAborted();
        return inserted;
      });
      signal.throwIfAborted();
      firstId ??= ids[0]?.id;
    }
    if (!firstId) {
      throw new Error("Fixture usage insert returned no row");
    }
    return {
      status: 200 as const,
      body: { ok: true as const, usage_event_id: firstId },
    };
  },
);

async function attachUsageAllowance(
  db: Db,
  args: {
    readonly orgId: string;
    readonly runId: string | null;
    readonly usageEventId: string;
    readonly unitsApplied: number;
    readonly consumedUnits: number;
  },
): Promise<{
  readonly shortWindowId: string;
  readonly weeklyWindowId: string;
}> {
  let [entitlement] = await db
    .select({ id: orgUsageAllowanceEntitlements.id })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, args.orgId))
    .limit(1);
  if (!entitlement) {
    [entitlement] = await db
      .insert(orgUsageAllowanceEntitlements)
      .values({
        orgId: args.orgId,
        shortWindowSeconds: 3600,
        shortWindowUnits: 1_000_000,
        weeklyWindowUnits: 1_000_000,
        effectiveAt: new Date("2000-01-01T00:00:00.000Z"),
      })
      .returning({ id: orgUsageAllowanceEntitlements.id });
  }
  if (!entitlement) {
    throw new Error("attachUsageAllowance: entitlement insert returned no row");
  }

  const windowLimit = Math.max(args.consumedUnits, args.unitsApplied) + 100;
  // Each attached pair is a distinct window identity (entitlement, kind,
  // start), so successive fixture pairs start one second apart.
  const [existing] = await db
    .select({ windows: count() })
    .from(orgUsageAllowanceWindows)
    .where(eq(orgUsageAllowanceWindows.entitlementId, entitlement.id));
  const startsAt = new Date(
    Date.UTC(2000, 0, 1) + (existing?.windows ?? 0) * 1000,
  );
  const windows = await db
    .insert(orgUsageAllowanceWindows)
    .values([
      {
        orgId: args.orgId,
        entitlementId: entitlement.id,
        kind: "short",
        startsAt,
        expiresAt: new Date("3000-01-01T00:00:00.000Z"),
        unitLimit: windowLimit,
        consumedUnits: args.consumedUnits,
        createdByRunId: args.runId,
      },
      {
        orgId: args.orgId,
        entitlementId: entitlement.id,
        kind: "weekly",
        startsAt,
        expiresAt: new Date("3000-01-01T00:00:00.000Z"),
        unitLimit: windowLimit,
        consumedUnits: args.consumedUnits,
        createdByRunId: args.runId,
      },
    ])
    .returning({
      id: orgUsageAllowanceWindows.id,
      kind: orgUsageAllowanceWindows.kind,
    });
  const shortWindow = windows.find((window) => {
    return window.kind === "short";
  });
  const weeklyWindow = windows.find((window) => {
    return window.kind === "weekly";
  });
  if (!shortWindow || !weeklyWindow) {
    throw new Error("attachUsageAllowance: window insert returned no pair");
  }

  await db.insert(usageAllowanceAllocations).values({
    usageEventId: args.usageEventId,
    orgId: args.orgId,
    runId: args.runId,
    shortWindowId: shortWindow.id,
    weeklyWindowId: weeklyWindow.id,
    unitsApplied: args.unitsApplied,
  });
  return {
    shortWindowId: shortWindow.id,
    weeklyWindowId: weeklyWindow.id,
  };
}

async function readAllowanceWindowState(
  db: Db,
  args: {
    readonly shortWindowId: string;
    readonly weeklyWindowId: string;
  },
) {
  const [[shortWindow], [weeklyWindow], [raw], [hourly]] = await Promise.all([
    db
      .select({ consumedUnits: orgUsageAllowanceWindows.consumedUnits })
      .from(orgUsageAllowanceWindows)
      .where(eq(orgUsageAllowanceWindows.id, args.shortWindowId))
      .limit(1),
    db
      .select({ consumedUnits: orgUsageAllowanceWindows.consumedUnits })
      .from(orgUsageAllowanceWindows)
      .where(eq(orgUsageAllowanceWindows.id, args.weeklyWindowId))
      .limit(1),
    db
      .select({
        allowanceUnits: sum(usageAllowanceAllocations.unitsApplied),
        allocationCount: count(),
      })
      .from(usageAllowanceAllocations)
      .where(
        and(
          eq(usageAllowanceAllocations.shortWindowId, args.shortWindowId),
          eq(usageAllowanceAllocations.weeklyWindowId, args.weeklyWindowId),
        ),
      ),
    db
      .select({
        allowanceUnits: sum(usageEventHourlyRollup.allowanceUnits),
      })
      .from(usageEventHourlyRollup)
      .where(
        and(
          eq(usageEventHourlyRollup.shortWindowId, args.shortWindowId),
          eq(usageEventHourlyRollup.weeklyWindowId, args.weeklyWindowId),
        ),
      ),
  ]);
  if (!shortWindow || !weeklyWindow || !raw || !hourly) {
    throw new Error(
      "readAllowanceWindowState: state query returned incomplete results",
    );
  }
  return {
    shortWindowConsumedUnits: String(shortWindow.consumedUnits),
    weeklyWindowConsumedUnits: String(weeklyWindow.consumedUnits),
    rawAllowanceUnits: raw.allowanceUnits ?? "0",
    hourlyAllowanceUnits: hourly.allowanceUnits ?? "0",
    allocationCount: raw.allocationCount,
  };
}

async function deleteRun(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  await db.delete(agentRuns).where(eq(agentRuns.id, runId));
  signal.throwIfAborted();
}

/** Reproduces a run whose usage predates the billing attribution table. */
async function deleteBillingAttribution(
  db: Db,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(billingRunAttribution)
    .where(eq(billingRunAttribution.runId, runId));
  signal.throwIfAborted();
}

const materializeHourlyUsage$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | null;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    // One transaction over the whole finite fixture scope, as on main; no
    // row lock and no paging loop.
    const materialized = await db.transaction(async (tx) => {
      const runPredicate =
        args.runId === null
          ? isNull(usageEvent.runId)
          : eq(usageEvent.runId, args.runId);
      const rows = await tx
        .select({
          id: usageEvent.id,
          processedHour: sql`date_trunc('hour', ${usageEvent.processedAt})`
            .mapWith(usageEvent.createdAt)
            .as("processed_hour"),
          orgId: usageEvent.orgId,
          userId: usageEvent.userId,
          runId: usageEvent.runId,
          billingRunId: usageEvent.billingRunId,
          billingContext: usageEvent.billingContext,
          billingAnchorAt: sql`${usageEvent.billingAnchorAt}::text`.mapWith(
            nullableDriverValueDecoder(pgTextDecoder),
          ),
          kind: usageEvent.kind,
          provider: usageEvent.provider,
          category: usageEvent.category,
          shortWindowId: usageAllowanceAllocations.shortWindowId,
          weeklyWindowId: usageAllowanceAllocations.weeklyWindowId,
          quantity: usageEvent.quantity,
          creditsCharged: usageEvent.creditsCharged,
          allowanceUnits: usageAllowanceAllocations.unitsApplied,
        })
        .from(usageEvent)
        .leftJoin(
          usageAllowanceAllocations,
          eq(usageAllowanceAllocations.usageEventId, usageEvent.id),
        )
        .where(
          and(
            eq(usageEvent.orgId, args.orgId),
            eq(usageEvent.userId, args.userId),
            runPredicate,
            eq(usageEvent.status, "processed"),
            isNotNull(usageEvent.processedAt),
          ),
        )
        .orderBy(usageEvent.id);
      signal.throwIfAborted();

      if (rows.length === 0) {
        return 0;
      }

      await tx.insert(usageEventHourlyRollup).values(
        rows.map((row) => {
          return {
            processedHour: row.processedHour,
            orgId: row.orgId,
            userId: row.userId,
            runId: row.runId,
            billingRunId: row.billingRunId,
            billingContext: row.billingContext,
            billingAnchorAt:
              row.billingAnchorAt === null
                ? null
                : sql`${row.billingAnchorAt}::timestamp`,
            kind: row.kind,
            provider: row.provider,
            category: row.category,
            shortWindowId: row.shortWindowId,
            weeklyWindowId: row.weeklyWindowId,
            quantity: row.quantity,
            creditsCharged: row.creditsCharged ?? 0,
            allowanceUnits: row.allowanceUnits ?? 0,
          };
        }),
      );
      signal.throwIfAborted();

      const observedIds = rows.flatMap((row) => {
        return row.billingRunId ? [row.billingRunId] : [];
      });
      if (observedIds.length > 0) {
        await tx
          .update(billingRunAttribution)
          .set({ usageObserved: true })
          .where(
            and(
              inArray(billingRunAttribution.runId, observedIds),
              eq(billingRunAttribution.usageObserved, false),
            ),
          );
      }
      await tx.delete(usageEvent).where(
        inArray(
          usageEvent.id,
          rows.map((row) => {
            return row.id;
          }),
        ),
      );
      signal.throwIfAborted();
      return rows.length;
    });
    signal.throwIfAborted();
    return materialized;
  },
);

async function readUsageStorageCounts(
  db: Db,
  args: {
    readonly scope: "organization" | "user";
    readonly id: string;
  },
): Promise<{
  readonly raw: number;
  readonly processedRaw: number;
  readonly hourly: number;
}> {
  const rawPredicate =
    args.scope === "organization"
      ? eq(usageEvent.orgId, args.id)
      : eq(usageEvent.userId, args.id);
  const hourlyPredicate =
    args.scope === "organization"
      ? eq(usageEventHourlyRollup.orgId, args.id)
      : eq(usageEventHourlyRollup.userId, args.id);
  const [[raw], [processedRaw], [hourly]] = await Promise.all([
    db.select({ value: count() }).from(usageEvent).where(rawPredicate),
    db
      .select({ value: count() })
      .from(usageEvent)
      .where(and(rawPredicate, eq(usageEvent.status, "processed"))),
    db
      .select({ value: count() })
      .from(usageEventHourlyRollup)
      .where(hourlyPredicate),
  ]);
  return {
    raw: raw?.value ?? 0,
    processedRaw: processedRaw?.value ?? 0,
    hourly: hourly?.value ?? 0,
  };
}

async function readUsageEventState(
  db: Db,
  idempotencyKey: string,
): Promise<{
  readonly id: string;
  readonly status: string;
  readonly creditsCharged: number | null;
  readonly billingError: string | null;
  readonly shortWindowId: string | null;
  readonly weeklyWindowId: string | null;
  readonly allowanceUnits: number | null;
}> {
  const [event] = await db
    .select({
      id: usageEvent.id,
      status: usageEvent.status,
      creditsCharged: usageEvent.creditsCharged,
      billingError: usageEvent.billingError,
      shortWindowId: usageAllowanceAllocations.shortWindowId,
      weeklyWindowId: usageAllowanceAllocations.weeklyWindowId,
      allowanceUnits: usageAllowanceAllocations.unitsApplied,
    })
    .from(usageEvent)
    .leftJoin(
      usageAllowanceAllocations,
      eq(usageAllowanceAllocations.usageEventId, usageEvent.id),
    )
    .where(eq(usageEvent.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!event) {
    throw new Error("readUsageEventState: usage event not found");
  }
  return event;
}

async function mutateUsageStateFixtureState(
  db: Db,
  body: UsageStateFixtureAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-fixture": {
      const fixture = await seedUsageStateFixture(db);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { ok: true as const, fixture: fixtureToWire(fixture) },
      };
    }
    case "delete-fixture": {
      await deleteUsageStateFixture(db, fixtureFromWire(body.fixture), signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "seed-compose": {
      const result = await seedCompose(db, {
        orgId: body.org_id,
        userId: body.user_id,
        name: body.name,
        displayName: body.display_name,
        visibility: body.visibility,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          compose_id: result.composeId,
          agent_id: result.agentId,
        },
      };
    }
  }
}

const seedUsageRunState$ = command(
  async ({ set }, body: UsageStateAction<"seed-run">, signal: AbortSignal) => {
    const result = await set(
      seedRun$,
      {
        orgId: body.org_id,
        userId: body.user_id,
        agentId: body.compose_id,
        triggerSource: body.trigger_source,
        chatThreadId: body.chat_thread_id,
        status: body.status,
        prompt: body.prompt,
        createdAt: parseMaybeDate(body.created_at),
        startedAt:
          body.started_at === undefined
            ? undefined
            : parseOptionalDate(body.started_at),
        completedAt:
          body.completed_at === undefined
            ? undefined
            : parseOptionalDate(body.completed_at),
        continuedFromSessionId: body.continued_from_session_id,
        sandboxReuseResult: body.sandbox_reuse_result,
        workspaceReuseResult: body.workspace_reuse_result,
        result: body.result,
        error: body.error,
        lastEventSequence: body.last_event_sequence,
        selectedModel: body.selected_model,
        lifecycleOnly: body.lifecycle_only,
      },
      signal,
    );
    return {
      status: 200 as const,
      body: { ok: true as const, run_id: result.runId },
    };
  },
);

async function mutateUsageStateRunState(
  db: Db,
  body: UsageStateRunAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-chat-thread": {
      const threadId = await seedChatThread(
        db,
        {
          userId: body.user_id,
          agentId: body.compose_id,
          title: body.title,
        },
        signal,
      );
      return {
        status: 200 as const,
        body: { ok: true as const, chat_thread_id: threadId },
      };
    }
  }
}

async function mutateUsageStateEventWriteState(
  db: Db,
  body: UsageStateEventWriteAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "attach-usage-allowance": {
      const windows = await attachUsageAllowance(db, {
        orgId: body.org_id,
        runId: body.run_id,
        usageEventId: body.usage_event_id,
        unitsApplied: body.units_applied,
        consumedUnits: body.consumed_units,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          short_window_id: windows.shortWindowId,
          weekly_window_id: windows.weeklyWindowId,
        },
      };
    }
    case "read-allowance-window-state": {
      const state = await readAllowanceWindowState(db, {
        shortWindowId: body.short_window_id,
        weeklyWindowId: body.weekly_window_id,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          short_window_consumed_units: state.shortWindowConsumedUnits,
          weekly_window_consumed_units: state.weeklyWindowConsumedUnits,
          raw_allowance_units: state.rawAllowanceUnits,
          hourly_allowance_units: state.hourlyAllowanceUnits,
          allocation_count: state.allocationCount,
        },
      };
    }
    case "read-usage-event-state": {
      const event = await readUsageEventState(db, body.idempotency_key);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          usage_event_id: event.id,
          usage_event_status: event.status,
          usage_event_credits_charged: event.creditsCharged,
          usage_event_billing_error: event.billingError,
          usage_event_short_window_id: event.shortWindowId,
          usage_event_weekly_window_id: event.weeklyWindowId,
          usage_event_allowance_units: event.allowanceUnits,
        },
      };
    }
  }
}

async function mutateUsageStateEventMaterializationState(
  db: Db,
  body: UsageStateEventMaterializationAction,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "delete-run": {
      await deleteRun(db, body.run_id, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "delete-billing-attribution": {
      await deleteBillingAttribution(db, body.run_id, signal);
      return { status: 200 as const, body: { ok: true as const } };
    }
    case "read-usage-storage-counts": {
      const counts = await readUsageStorageCounts(db, {
        scope: body.scope,
        id: body.id,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          ok: true as const,
          raw_count: counts.raw,
          processed_raw_count: counts.processedRaw,
          hourly_count: counts.hourly,
        },
      };
    }
  }
}

async function mutateUsageState(
  db: Db,
  body: Exclude<
    TestUsageStateActionBody,
    {
      action:
        | "delete-usage-data"
        | "seed-run"
        | "insert-usage-event"
        | "materialize-hourly-usage";
    }
  >,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-fixture":
    case "delete-fixture":
    case "seed-compose": {
      return await mutateUsageStateFixtureState(db, body, signal);
    }
    case "seed-chat-thread": {
      return await mutateUsageStateRunState(db, body, signal);
    }
    case "attach-usage-allowance":
    case "read-allowance-window-state":
    case "read-usage-event-state": {
      return await mutateUsageStateEventWriteState(db, body, signal);
    }
    case "delete-run":
    case "delete-billing-attribution":
    case "read-usage-storage-counts": {
      return await mutateUsageStateEventMaterializationState(db, body, signal);
    }
  }
}

const mutateUsageState$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  const bodyResult = await get(actionBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  if (bodyResult.data.action === "delete-usage-data") {
    await set(
      deleteUsageData$,
      { scope: bodyResult.data.scope, id: bodyResult.data.id },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  }
  if (bodyResult.data.action === "seed-run") {
    return await set(seedUsageRunState$, bodyResult.data, signal);
  }
  if (bodyResult.data.action === "insert-usage-event") {
    return await set(insertFixtureUsage$, bodyResult.data, signal);
  }
  if (bodyResult.data.action === "materialize-hourly-usage") {
    const body = bodyResult.data;
    const hourlyCount = await set(
      materializeHourlyUsage$,
      {
        orgId: body.org_id,
        userId: body.user_id,
        runId: body.run_id,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { ok: true as const, hourly_count: hourlyCount },
    };
  }
  return await mutateUsageState(set(writeDb$), bodyResult.data, signal);
});

export const testUsageStateRoutes: readonly RouteEntry[] = [
  { route: testUsageStateContract.compact, handler: compactOwnedUsage$ },
  {
    route: testUsageStateContract.action,
    handler: mutateUsageState$,
  },
];
