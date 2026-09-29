import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { ApiError } from "../../lib/api-error.ts";
import { accept } from "../../lib/accept.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { apiClient$, type ApiClientFactory } from "../api-client.ts";
import { queryChatEventSharedDatabase$ } from "../shared-database.ts";
import { onRef, settle } from "../utils.ts";
import {
  classifyDeliveryFailure,
  deliveryIntentsChanged$,
  listDeliveryIntents,
  removeDeliveryIntent,
  updateDeliveryIntent,
  watchDeliveryIntents$,
  withDeliveryLock,
  type DeliveryIdentity,
  type NewThreadDeliveryIntent,
} from "./chat-delivery-intents.ts";
import { checkAndRetryPromptDelivery$ } from "./chat-event-signals.ts";

/** A failed metadata lookup does not prove that an earlier create or send failed. */
function unverifiedLookupFailure(error: unknown) {
  return {
    status: "uncertain" as const,
    rejection:
      error instanceof ApiError && error.status === 401
        ? ("authentication" as const)
        : null,
  };
}

function savedNewThreadIntent(
  identity: DeliveryIdentity,
  threadId: string,
  eventId: string,
): NewThreadDeliveryIntent | null {
  const found = listDeliveryIntents(identity).find((item) => {
    return item.threadId === threadId && item.clientEventId === eventId;
  });
  return found?.kind === "new-thread" ? found : null;
}

/** A missing row is not permission to resend a prompt; create and prompt are separate phases. */
async function checkCreatedThread(
  createClient: ApiClientFactory,
  intent: NewThreadDeliveryIntent,
  signal: AbortSignal,
): Promise<"present" | "absent" | "conflict"> {
  const result = await accept(
    createClient(chatThreadMetadataContract).get({
      params: { id: intent.threadId },
      fetchOptions: { signal },
    }),
    [200, 404],
    signal,
    { showErrorToast: false },
  );
  signal.throwIfAborted();
  if (result.status === 404) {
    return "absent";
  }
  return result.body.agentId === intent.createBody.agentId
    ? "present"
    : "conflict";
}

/** Read-only refresh: never submit a second request because a response was lost. */
export const reconcileNewThreadDeliveries$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(watchDeliveryIntents$, signal);
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const createClient = get(apiClient$);
    for (const saved of listDeliveryIntents(identity)) {
      if (saved.kind !== "new-thread") {
        continue;
      }
      signal.throwIfAborted();
      let intent = saved;
      const thread = await settle(
        checkCreatedThread(createClient, intent, signal),
      );
      signal.throwIfAborted();
      if (!thread.ok) {
        if (intent.status === "prepared" || intent.status === "uncertain") {
          updateDeliveryIntent(
            identity,
            intent.clientEventId,
            unverifiedLookupFailure(thread.error),
          );
          set(deliveryIntentsChanged$);
        }
        continue;
      }
      if (thread.value === "conflict") {
        updateDeliveryIntent(identity, intent.clientEventId, {
          status: "rejected",
          rejection: "rejected",
        });
        set(deliveryIntentsChanged$);
        continue;
      }
      if (thread.value === "absent" && intent.phase === "prompt") {
        if (intent.status !== "rejected") {
          updateDeliveryIntent(identity, intent.clientEventId, {
            status: "uncertain",
            rejection: null,
          });
          set(deliveryIntentsChanged$);
        }
        continue;
      }
      if (thread.value === "absent") {
        if (intent.status === "prepared") {
          updateDeliveryIntent(identity, intent.clientEventId, {
            status: "uncertain",
            rejection: null,
          });
          set(deliveryIntentsChanged$);
        }
        continue;
      }
      if (intent.phase === "create") {
        updateDeliveryIntent(identity, intent.clientEventId, {
          phase: "prompt",
          status: "uncertain",
          rejection: null,
        });
        set(deliveryIntentsChanged$);
        intent = {
          ...intent,
          phase: "prompt",
          status: "uncertain",
          rejection: null,
        };
      }
      const check = await settle(
        set(
          queryChatEventSharedDatabase$,
          {
            dataKey: { kind: "chat-event", threadId: intent.threadId },
            afterSeqId: null,
            consistency: "catch-up",
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      if (
        check.ok &&
        check.value.some((row) => {
          return row.id === intent.clientEventId;
        })
      ) {
        removeDeliveryIntent(identity, intent.clientEventId);
        set(deliveryIntentsChanged$);
      } else if (intent.status === "prepared") {
        updateDeliveryIntent(identity, intent.clientEventId, {
          status: "uncertain",
          rejection: null,
        });
        set(deliveryIntentsChanged$);
      }
    }
  },
);

/** User-initiated retry: hold the create lock, check ownership, replay its fixed ID, then use the shared prompt retry. */
export const retryNewThreadDelivery$ = command(
  // oxlint-disable-next-line max-lines-per-function -- Keep both guarded phases and same-ID transitions in one retry operation.
  async (
    { get, set },
    threadId: string,
    eventId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const current = savedNewThreadIntent(identity, threadId, eventId);
    if (!current || !navigator.locks) {
      return false;
    }
    if (current.phase === "create") {
      const createClient = get(apiClient$);
      const locked = await settle(
        withDeliveryLock(identity, eventId, "create", signal, async () => {
          const latest = savedNewThreadIntent(identity, threadId, eventId);
          if (!latest || latest.phase !== "create") {
            return false;
          }
          const check = await settle(
            checkCreatedThread(createClient, latest, signal),
          );
          signal.throwIfAborted();
          if (!check.ok) {
            if (latest.status !== "rejected") {
              updateDeliveryIntent(
                identity,
                eventId,
                unverifiedLookupFailure(check.error),
              );
              set(deliveryIntentsChanged$);
            }
            return false;
          }
          if (check.value === "conflict") {
            updateDeliveryIntent(identity, eventId, {
              status: "rejected",
              rejection: "rejected",
            });
            set(deliveryIntentsChanged$);
            return false;
          }
          if (check.value === "absent") {
            const verified = await settle(get(authenticatedIdentity$));
            signal.throwIfAborted();
            if (
              !verified.ok ||
              verified.value.userId !== identity.userId ||
              verified.value.orgId !== identity.orgId
            ) {
              updateDeliveryIntent(identity, eventId, {
                status: "rejected",
                rejection: "authentication",
              });
              set(deliveryIntentsChanged$);
              return false;
            }
            const create = await settle(
              accept(
                createClient(chatThreadsContract).create({
                  body: latest.createBody,
                  fetchOptions: { signal },
                }),
                [201],
                signal,
                { showErrorToast: false },
              ),
            );
            signal.throwIfAborted();
            if (!create.ok) {
              updateDeliveryIntent(
                identity,
                eventId,
                classifyDeliveryFailure(create.error),
              );
              set(deliveryIntentsChanged$);
              return false;
            }
          }
          updateDeliveryIntent(identity, eventId, {
            phase: "prompt",
            status: "prepared",
            rejection: null,
          });
          set(deliveryIntentsChanged$);
          return true;
        }),
      );
      signal.throwIfAborted();
      if (!locked.ok || !locked.value) {
        return false;
      }
    } else {
      const checked = await settle(
        checkCreatedThread(get(apiClient$), current, signal),
      );
      signal.throwIfAborted();
      if (!checked.ok) {
        if (current.status !== "rejected" && current.status !== "accepted") {
          updateDeliveryIntent(
            identity,
            eventId,
            unverifiedLookupFailure(checked.error),
          );
          set(deliveryIntentsChanged$);
        }
        return false;
      }
      if (checked.value !== "present") {
        if (checked.value === "conflict" || current.status !== "rejected") {
          updateDeliveryIntent(identity, eventId, {
            status: checked.value === "conflict" ? "rejected" : "uncertain",
            rejection: checked.value === "conflict" ? "rejected" : null,
          });
          set(deliveryIntentsChanged$);
        }
        toast.error(
          checked.value === "absent"
            ? i18n.t(($) => {
                return $.chat.newThreadDelivery.missingChat;
              })
            : i18n.t(($) => {
                return $.chat.newThreadDelivery.agentConflict;
              }),
        );
        return false;
      }
    }
    return await set(
      checkAndRetryPromptDelivery$,
      { threadId, clientEventId: eventId },
      signal,
    );
  },
);

export const newThreadDeliveryOnRef$ = onRef(
  command(({ set }, _node: HTMLSpanElement, signal: AbortSignal) => {
    return set(reconcileNewThreadDeliveries$, signal);
  }),
);
