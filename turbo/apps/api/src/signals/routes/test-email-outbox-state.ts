import {
  testEmailOutboxStateContract,
  type TestEmailOutboxStateActionBody,
} from "@okouai/api-contracts/contracts/test-email-outbox-state";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { command } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(testEmailOutboxStateContract.action);

function itemStateSelection() {
  return {
    id: emailOutbox.id,
    from_address: emailOutbox.fromAddress,
    to_addresses: emailOutbox.toAddresses,
    subject: emailOutbox.subject,
    headers: emailOutbox.headers,
    template: emailOutbox.template,
    source_run_id: emailOutbox.sourceRunId,
    source_workflow_automation_id: emailOutbox.sourceWorkflowAutomationId,
    status: emailOutbox.status,
    attempts: emailOutbox.attempts,
    last_error: emailOutbox.lastError,
    resend_id: emailOutbox.resendId,
    provider_idempotency_key: emailOutbox.providerIdempotencyKey,
    provider_request: emailOutbox.providerRequest,
  };
}

/**
 * Report whether the immutable provider request is committed without exposing
 * the rendered message body through a test endpoint.
 */
function itemState<Item extends { readonly provider_request: unknown }>(
  item: Item,
): Omit<Item, "provider_request"> & {
  readonly has_provider_request: boolean;
} {
  const { provider_request: providerRequest, ...state } = item;
  return { ...state, has_provider_request: providerRequest !== null };
}

async function applyAction(
  db: Db,
  body: TestEmailOutboxStateActionBody,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "find-item": {
      const items = await db
        .select(itemStateSelection())
        .from(emailOutbox)
        .where(
          and(
            eq(emailOutbox.toAddresses, body.to_address),
            eq(emailOutbox.subject, body.subject),
          ),
        )
        .orderBy(asc(emailOutbox.createdAt));
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "find-item" as const, items: items.map(itemState) },
      };
    }
    case "delete-items": {
      const deleted = await db
        .delete(emailOutbox)
        .where(inArray(emailOutbox.id, body.item_ids))
        .returning({ id: emailOutbox.id });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "delete-items" as const, deleted: deleted.length },
      };
    }
  }
}

const mutateTestEmailOutboxState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await applyAction(set(writeDb$), bodyResult.data, signal);
  },
);

export const testEmailOutboxStateRoutes: readonly RouteEntry[] = [
  {
    route: testEmailOutboxStateContract.action,
    handler: mutateTestEmailOutboxState$,
  },
];
