import {
  testEmailOutboxStateContract,
  type TestEmailOutboxStateActionBody,
} from "@okouai/api-contracts/contracts/test-email-outbox-state";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { officialAutomationResultEmailClaims } from "@okouai/db/schema/official-automation-result-email-claim";
import { command } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";

import { now } from "../../lib/time";
import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  cleanupExpiredEmailOutboxItems$,
  drainEmailOutboxItems$,
} from "../services/email-common.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(testEmailOutboxStateContract.action);
const drainBody$ = bodyResultOf(testEmailOutboxStateContract.drain);
const cleanupBody$ = bodyResultOf(testEmailOutboxStateContract.cleanup);

function itemStateSelection() {
  return {
    id: emailOutbox.id,
    from_address: emailOutbox.fromAddress,
    to_addresses: emailOutbox.toAddresses,
    subject: emailOutbox.subject,
    headers: emailOutbox.headers,
    public_brand: emailOutbox.publicBrand,
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
    case "seed-item": {
      const [item] = await db
        .insert(emailOutbox)
        .values({
          fromAddress: "Okou <outbox-fixture@mail.example.com>",
          toAddresses: body.to_address,
          subject: body.subject,
          template: {
            template: "data-export-ready",
            props: {
              downloadUrl: "https://storage.example/email-outbox-fixture.zip",
              expiresAt: "January 1, 2030",
              artifactCount: 1,
            },
          },
          status: body.status,
          attempts: 0,
          createdAt: new Date(body.created_at),
        })
        .returning(itemStateSelection());
      signal.throwIfAborted();
      if (!item) {
        throw new Error("Failed to seed email outbox item");
      }
      return {
        status: 200 as const,
        body: { action: "seed-item" as const, item: itemState(item) },
      };
    }
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
    case "find-source": {
      const [items, claims] = await Promise.all([
        db
          .select(itemStateSelection())
          .from(emailOutbox)
          .where(
            and(
              eq(emailOutbox.sourceRunId, body.source_run_id),
              eq(
                emailOutbox.sourceWorkflowAutomationId,
                body.source_workflow_automation_id,
              ),
            ),
          )
          .orderBy(asc(emailOutbox.createdAt)),
        db
          .select({
            source_run_id: officialAutomationResultEmailClaims.runId,
            source_workflow_automation_id:
              officialAutomationResultEmailClaims.workflowAutomationId,
            email_outbox_id: officialAutomationResultEmailClaims.emailOutboxId,
          })
          .from(officialAutomationResultEmailClaims)
          .where(
            and(
              eq(officialAutomationResultEmailClaims.runId, body.source_run_id),
              eq(
                officialAutomationResultEmailClaims.workflowAutomationId,
                body.source_workflow_automation_id,
              ),
            ),
          )
          .limit(1),
      ]);
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: {
          action: "find-source" as const,
          items: items.map(itemState),
          claim: claims[0] ?? null,
        },
      };
    }
    case "read-items": {
      const items = await db
        .select(itemStateSelection())
        .from(emailOutbox)
        .where(inArray(emailOutbox.id, body.item_ids));
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { action: "read-items" as const, items: items.map(itemState) },
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

const drainTestEmailOutboxState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(drainBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const drained = await set(
      drainEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: bodyResult.data.item_ids },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { drained } };
  },
);

const cleanupTestEmailOutboxState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(cleanupBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const cleaned = await set(
      cleanupExpiredEmailOutboxItems$,
      { currentTimeMs: now(), itemIds: bodyResult.data.item_ids },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { cleaned } };
  },
);

export const testEmailOutboxStateRoutes: readonly RouteEntry[] = [
  {
    route: testEmailOutboxStateContract.action,
    handler: mutateTestEmailOutboxState$,
  },
  {
    route: testEmailOutboxStateContract.drain,
    handler: drainTestEmailOutboxState$,
  },
  {
    route: testEmailOutboxStateContract.cleanup,
    handler: cleanupTestEmailOutboxState$,
  },
];
