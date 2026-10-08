import { testUsageSettlementContract } from "@okouai/api-contracts/contracts/test-usage-settlement";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { createUsagePackCreditGrant } from "../services/usage-pack-credit.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { writeOrgMetadataWithDefaultPlanEntitlement } from "../services/org-plan-entitlements.service";

const setupBody$ = bodyResultOf(testUsageSettlementContract.setup);
const cleanupBody$ = bodyResultOf(testUsageSettlementContract.cleanup);
const createGrantBody$ = bodyResultOf(testUsageSettlementContract.createGrant);

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

export const testUsageSettlementRoutes: readonly RouteEntry[] = [
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
];
