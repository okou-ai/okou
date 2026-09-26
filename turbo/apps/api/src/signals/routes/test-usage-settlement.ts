import { testUsageSettlementContract } from "@okouai/api-contracts/contracts/test-usage-settlement";
import { usageChatProjectionWork } from "@okouai/db/schema/usage-chat-projection-work";
import { randomUUID } from "node:crypto";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { command } from "ccstate";
import { asc, eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import type { RouteEntry } from "../route-entry";
import { checkBillableOperationCredits$ } from "../services/billable-operation-admission.service";
import { createUsagePackCreditGrant } from "../services/usage-pack-credit.service";
import {
  processOrgUsageEvents$,
  processOrgUsageEventsInTransaction,
} from "../services/credit-usage.service";
import { checkOrgCreditsForRunAdmission } from "../services/run-admission.service";
import { maybeEmitRunUsageEvent$ } from "../services/chat-usage-event.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "../services/org-plan-entitlements.service";
import { settle } from "../utils";

const body$ = bodyResultOf(testUsageSettlementContract.process);
const rollbackBody$ = bodyResultOf(testUsageSettlementContract.rollback);
const withoutProjectionBody$ = bodyResultOf(
  testUsageSettlementContract.processWithoutProjection,
);
const projectionFaultBody$ = bodyResultOf(
  testUsageSettlementContract.projectionFault,
);
const legacyProjectBody$ = bodyResultOf(
  testUsageSettlementContract.legacyProject,
);
const setupBody$ = bodyResultOf(testUsageSettlementContract.setup);
const cleanupBody$ = bodyResultOf(testUsageSettlementContract.cleanup);
const createGrantBody$ = bodyResultOf(testUsageSettlementContract.createGrant);
const stateBody$ = bodyResultOf(testUsageSettlementContract.state);
const admissionBody$ = bodyResultOf(testUsageSettlementContract.admission);

const processUsageSettlement$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(body$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    await set(processOrgUsageEvents$, bodyResult.data.org_id, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

// The response is lost between COMMIT and the optional postcommit callback.
// This route exists only in tests; the durable cron must reconstruct the card.
const processWithoutProjection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(withoutProjectionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    const pricingResolution = get(usagePricingResolution$);
    await db.transaction(async (tx) => {
      await processOrgUsageEventsInTransaction(
        tx,
        bodyResult.data.org_id,
        pricingResolution,
        signal,
      );
    });
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

// These failure states cannot be triggered through a production endpoint.
// Test-only routes preserve the Hono boundary without importing a DB handle
// or internal consumer into an API behavior test.
const injectProjectionFault$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(projectionFaultBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { run_id: runId, mode } = bodyResult.data;
    const db = set(writeDb$);
    if (mode === "drop-ack") {
      // Re-create only the missing acknowledgement, not a new charge or card.
      // Completed epochs are normally removed to avoid permanent work rows.
      const [created] = await db
        .insert(usageChatProjectionWork)
        .values({ runId, availableAt: new Date(0) })
        .onConflictDoNothing({ target: usageChatProjectionWork.runId })
        .returning({ runId: usageChatProjectionWork.runId });
      signal.throwIfAborted();
      if (!created) {
        throw new Error("Expected a completed projection epoch");
      }
    } else {
      const values =
        mode === "expire-lease"
          ? {
              leaseId: randomUUID(),
              leaseExpiresAt: new Date(0),
              availableAt: new Date(0),
            }
          : { availableAt: new Date(0) };
      const [updated] = await db
        .update(usageChatProjectionWork)
        .set(values)
        .where(eq(usageChatProjectionWork.runId, runId))
        .returning({ runId: usageChatProjectionWork.runId });
      signal.throwIfAborted();
      if (!updated) {
        throw new Error("Expected committed projection work");
      }
    }
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

const legacyUsageProjection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(legacyProjectBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    await set(maybeEmitRunUsageEvent$, bodyResult.data.run_id, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

class IntentionalUsageSettlementRollback extends Error {}

const rollbackUsageSettlement$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(rollbackBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const pricingResolution = get(usagePricingResolution$);
    const result = await settle(
      db.transaction(async (tx) => {
        await processOrgUsageEventsInTransaction(
          tx,
          bodyResult.data.org_id,
          pricingResolution,
          signal,
        );
        // The same financial operation has run, but its transaction has not
        // committed. Throwing here must roll back event, window and wallet.
        throw new IntentionalUsageSettlementRollback();
      }),
      signal,
    );
    if (
      result.ok ||
      !(result.error instanceof IntentionalUsageSettlementRollback)
    ) {
      throw result.ok
        ? new Error("Expected usage settlement rollback")
        : result.error;
    }
    signal.throwIfAborted();
    return { status: 200 as const, body: { rolled_back: true as const } };
  },
);

const setupUsageSettlement$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(setupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      await writeOrgMetadataWithDefaultPlanEntitlement(
        tx,
        bodyResult.data.org_id,
        async (writeTx) => {
          return await writeTx
            .insert(orgMetadataCanonicalWrites)
            .values({
              orgId: bodyResult.data.org_id,
              credits: bodyResult.data.credits,
            })
            .onConflictDoUpdate({
              target: orgMetadataCanonicalWrites.orgId,
              set: { credits: bodyResult.data.credits },
            })
            .returning({
              orgId: orgMetadataCanonicalWrites.orgId,
              tier: orgMetadataCanonicalWrites.tier,
            });
        },
      );
    });
    signal.throwIfAborted();
    await db
      .insert(orgPlanEntitlements)
      .values({
        orgId: bodyResult.data.org_id,
        planKey: "usage-pack-test",
        planRank: 1,
        source: "test_fixture",
        status: "active",
        restrictedBuiltInModels: false,
      })
      .onConflictDoUpdate({
        target: orgPlanEntitlements.orgId,
        set: {
          status: "active",
          restrictedBuiltInModels: false,
        },
      });
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

const cleanupUsageSettlement$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(cleanupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    await db
      .delete(usagePackCreditGrants)
      .where(eq(usagePackCreditGrants.orgId, bodyResult.data.org_id));
    signal.throwIfAborted();
    await db
      .delete(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, bodyResult.data.org_id));
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

const createUsagePackGrant$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(createGrantBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await createUsagePackCreditGrant(set(writeDb$), {
      orgId: bodyResult.data.org_id,
      userId: bodyResult.data.user_id,
      grantType: bodyResult.data.grant_type,
      idempotencyKey: bodyResult.data.idempotency_key,
      amount: bodyResult.data.amount,
      expiresAt: new Date(bodyResult.data.expires_at),
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { grant_id: result.id, created: result.created },
    };
  },
);

const readUsageSettlementState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(stateBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const [metadata] = await db
      .select({ credits: orgMetadata.credits })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, bodyResult.data.org_id))
      .limit(1);
    signal.throwIfAborted();
    const grants = await db
      .select({
        id: usagePackCreditGrants.id,
        userId: usagePackCreditGrants.userId,
        grantType: usagePackCreditGrants.grantType,
        idempotencyKey: usagePackCreditGrants.idempotencyKey,
        originalAmount: usagePackCreditGrants.originalAmount,
        remainingAmount: usagePackCreditGrants.remainingAmount,
        expiresAt: usagePackCreditGrants.expiresAt,
      })
      .from(usagePackCreditGrants)
      .where(eq(usagePackCreditGrants.orgId, bodyResult.data.org_id))
      .orderBy(
        asc(usagePackCreditGrants.createdAt),
        asc(usagePackCreditGrants.id),
      );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        org_credits: metadata?.credits ?? 0,
        grants: grants.map((grant) => {
          return {
            id: grant.id,
            user_id: grant.userId,
            grant_type: grant.grantType,
            idempotency_key: grant.idempotencyKey,
            original_amount: grant.originalAmount,
            remaining_amount: grant.remainingAmount,
            expires_at: grant.expiresAt.toISOString(),
          };
        }),
      },
    };
  },
);

const checkUsageSettlementAdmission$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(admissionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const args = {
      orgId: bodyResult.data.org_id,
      userId: bodyResult.data.user_id,
    };
    const allowed =
      bodyResult.data.kind === "run"
        ? (await checkOrgCreditsForRunAdmission({
            db: set(writeDb$),
            ...args,
            modelProviderType: "built-in",
          })) === undefined
        : await set(checkBillableOperationCredits$, args, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body: { allowed } };
  },
);

export const testUsageSettlementRoutes: readonly RouteEntry[] = [
  {
    route: testUsageSettlementContract.process,
    handler: processUsageSettlement$,
  },
  {
    route: testUsageSettlementContract.processWithoutProjection,
    handler: processWithoutProjection$,
  },
  {
    route: testUsageSettlementContract.projectionFault,
    handler: injectProjectionFault$,
  },
  {
    route: testUsageSettlementContract.legacyProject,
    handler: legacyUsageProjection$,
  },
  {
    route: testUsageSettlementContract.rollback,
    handler: rollbackUsageSettlement$,
  },
  {
    route: testUsageSettlementContract.setup,
    handler: setupUsageSettlement$,
  },
  {
    route: testUsageSettlementContract.cleanup,
    handler: cleanupUsageSettlement$,
  },
  {
    route: testUsageSettlementContract.createGrant,
    handler: createUsagePackGrant$,
  },
  {
    route: testUsageSettlementContract.state,
    handler: readUsageSettlementState$,
  },
  {
    route: testUsageSettlementContract.admission,
    handler: checkUsageSettlementAdmission$,
  },
];
