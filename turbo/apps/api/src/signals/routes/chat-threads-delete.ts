import { synchronizeUserPushBadge$ } from "../services/push-notifications.service";
import { isOfficialWorkflowThread$ } from "../services/official-workflow-policy.service";
import { command } from "ccstate";
import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { deleteChatThread$ } from "../services/chat-thread.service";
import { stopThreadBrowsers$ } from "../services/browser.service";
import { reconcileSharedBrowsers$ } from "../services/browser-shared-reconcile.service";
import { dispatchCancelSideEffects$ } from "../services/run-cancel.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route-entry";

const L = logger("ChatThreadDelete");

function chatThreadNotFound() {
  return notFound("Chat thread not found");
}

interface DeleteThreadArgs {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly eventId?: string;
}

/** Once admitted, deletion owns its finite post-commit cleanup. */
const deleteAndCleanUp$ = command(
  async ({ set }, args: DeleteThreadArgs, signal: AbortSignal) => {
    const result = await set(
      deleteChatThread$,
      {
        threadId: args.threadId,
        userId: args.userId,
        orgId: args.orgId,
        eventId: args.eventId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.deleted) {
      return chatThreadNotFound();
    }

    waitUntil(
      set(synchronizeUserPushBadge$, args.userId, new AbortController().signal),
    );

    await set(stopThreadBrowsers$, { chatThreadId: args.threadId }, signal);
    signal.throwIfAborted();

    // Dispatch post-cancel side effects (runner halt, queue drain, credit
    // reconciliation) for every run we stopped while tearing down the thread.
    for (const cancelled of result.cancelledRuns) {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        tapError(
          set(dispatchCancelSideEffects$, cancelled, backgroundSignal),
          (error) => {
            L.error("dispatchCancelSideEffects failed", {
              runId: cancelled.runId,
              error,
            });
          },
        ),
      );
    }

    await set(reconcileSharedBrowsers$, args, signal);
    signal.throwIfAborted();

    await publishThreadListChanged({ userId: args.userId, orgId: args.orgId });
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadByIdContract.delete));
  const query = get(queryOf(chatThreadByIdContract.delete));
  const args = {
    threadId: params.id,
    userId: auth.userId,
    orgId: auth.orgId,
    eventId: query?.eventId,
  };
  if (await set(isOfficialWorkflowThread$, args, signal)) {
    return chatThreadNotFound();
  }
  signal.throwIfAborted();

  // A submitted statement may commit before instance cancellation is observed.
  // Register its entire deletion/cleanup owner before awaiting that statement,
  // so committed Run cancellation receipts retain a finite completion owner.
  const completion = set(deleteAndCleanUp$, args, new AbortController().signal);
  waitUntil(completion);
  const result = await completion;
  signal.throwIfAborted();
  return result;
});

export const chatThreadDeleteRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadByIdContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteInner$,
    ),
  },
];
