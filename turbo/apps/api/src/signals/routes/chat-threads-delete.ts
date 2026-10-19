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
import { dispatchCancelSideEffects$ } from "../services/run-cancel.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route-entry";

const L = logger("ChatThreadDelete");

function chatThreadNotFound() {
  return notFound("Chat thread not found");
}

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadByIdContract.delete));
  const query = get(queryOf(chatThreadByIdContract.delete));

  if (
    await set(
      isOfficialWorkflowThread$,
      { threadId: params.id, userId: auth.userId, orgId: auth.orgId },
      signal,
    )
  ) {
    return chatThreadNotFound();
  }
  const result = await set(
    deleteChatThread$,
    {
      threadId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
      eventId: query?.eventId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!result.deleted) {
    return chatThreadNotFound();
  }

  await set(stopThreadBrowsers$, { chatThreadId: params.id }, signal);
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

  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
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
