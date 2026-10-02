import { testStripeAutomationEventFixtureContract } from "@okouai/api-contracts/contracts/test-stripe-automation-events";
import { stripeWorkflowDeliveries } from "@okouai/db/schema/stripe-automation-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { desc, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const fixtureBody$ = bodyResultOf(
  testStripeAutomationEventFixtureContract.apply,
);

const applyStripeAutomationEventFixture$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(fixtureBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    if (bodyResult.data.action === "clear-automation-account-projection") {
      const [automation] = await db
        .update(workflowAutomations)
        .set({ eventConnectorId: null })
        .where(eq(workflowAutomations.id, bodyResult.data.automation_id))
        .returning({ id: workflowAutomations.id });
      signal.throwIfAborted();
      if (!automation) {
        return testEndpointNotFoundResponse();
      }
      return { status: 200 as const, body: { ok: true as const } };
    }
    const [delivery] = await db
      .select({ id: stripeWorkflowDeliveries.id })
      .from(stripeWorkflowDeliveries)
      .where(
        eq(
          stripeWorkflowDeliveries.automationId,
          bodyResult.data.automation_id,
        ),
      )
      .orderBy(desc(stripeWorkflowDeliveries.createdAt))
      .limit(1);
    signal.throwIfAborted();
    if (!delivery) {
      return testEndpointNotFoundResponse();
    }

    const currentTime = nowDate();
    switch (bodyResult.data.action) {
      case "corrupt-latest-snapshot": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({ snapshot: sql`'{}'::jsonb`, updatedAt: currentTime })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        break;
      }
      case "hold-latest-claim": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({
            claimExpiresAt: new Date(currentTime.getTime() + 300_000),
            updatedAt: currentTime,
          })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        break;
      }
      case "expire-latest-retry-window": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({
            receivedAt: new Date(currentTime.getTime() - 262_800_000),
            claimExpiresAt: null,
            nextAttemptAt: currentTime,
            updatedAt: currentTime,
          })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        break;
      }
      case "make-latest-due": {
        await db
          .update(stripeWorkflowDeliveries)
          .set({
            claimExpiresAt: null,
            nextAttemptAt: currentTime,
            updatedAt: currentTime,
          })
          .where(eq(stripeWorkflowDeliveries.id, delivery.id));
        signal.throwIfAborted();
        break;
      }
    }
    signal.throwIfAborted();
    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testStripeAutomationEventRoutes: readonly RouteEntry[] = [
  {
    route: testStripeAutomationEventFixtureContract.apply,
    handler: applyStripeAutomationEventFixture$,
  },
];
