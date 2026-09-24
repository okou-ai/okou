import { command, state } from "ccstate";
import { z } from "zod";

import { accountErasureStatusContract } from "@okouai/api-contracts/contracts/account-erasure-status";

import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { clerk$ } from "./auth.ts";
import { deleteAccountLocalData$ } from "./external/account-erasure-local-data.ts";
import {
  listLocalStorageEntries,
  localStorageSignals,
} from "./external/local-storage.ts";
import {
  bestEffort,
  jsonParseOr,
  onDomEventFn,
  setLoop,
  settle,
} from "./utils.ts";
import { throttleCommand } from "./command-scheduling.ts";

const CAPABILITY_KEY_PREFIX = "account-erasure-status-capability:";
const capabilitySchema = z.object({
  userId: z.string().min(1),
  token: z.string().min(1),
});
type SavedCapability = z.infer<typeof capabilitySchema>;
const POLL_MS = 60_000;

function capabilityKey(userId: string): string {
  return `${CAPABILITY_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

function savedCapabilities(): SavedCapability[] {
  return listLocalStorageEntries(CAPABILITY_KEY_PREFIX).flatMap((entry) => {
    const parsed = capabilitySchema.safeParse(
      jsonParseOr<unknown>(entry.value, null),
    );
    return parsed.success && entry.key === capabilityKey(parsed.data.userId)
      ? [parsed.data]
      : [];
  });
}

const issueStatusCapability$ = command(
  async (
    { get, set },
    userId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const response = await accept(
      get(apiClient$)(accountErasureStatusContract).capability({
        fetchOptions: { signal, cache: "no-store" },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    // Clerk may switch accounts while the request is in flight. The response
    // belongs to the session that issued it; only retain it for that user.
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (clerk.user?.id !== userId) {
      return false;
    }
    set(
      localStorageSignals(capabilityKey(userId)).set$,
      JSON.stringify({ userId, token: response.body.token }),
    );
    return true;
  },
);

const checkSavedDeletionStatuses$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const saved = savedCapabilities();
    for (const capability of saved) {
      signal.throwIfAborted();
      const response = await accept(
        get(apiClient$)(accountErasureStatusContract, {
          getToken: () => {
            return Promise.resolve(capability.token);
          },
        }).status({ fetchOptions: { signal, cache: "no-store" } }),
        [200, 404],
        signal,
        { showErrorToast: false },
      );
      if (
        response.status !== 200 ||
        response.body.userId !== capability.userId ||
        response.body.status === "active"
      ) {
        continue;
      }
      await set(deleteAccountLocalData$, response.body.userId, signal);
      signal.throwIfAborted();
      // Keep the verified read-only credential after server completion.
      // Another open tab may still recreate account-scoped cache bytes; a
      // later poll or renderer restart must be able to purge them again.
    }
  },
);

const lastIssuedUserId$ = state<string | null>(null);

// Clerk events and the poll share one serialized sync: an idle call starts at
// once and overlapping calls collapse into one trailing run.
const syncDeletionStatus$ = throttleCommand(
  command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const { user } = await get(clerk$);
    signal.throwIfAborted();
    if (user === null) {
      set(lastIssuedUserId$, null);
    } else if (user && user.id !== get(lastIssuedUserId$)) {
      const issued = await settle(
        set(issueStatusCapability$, user.id, signal),
        signal,
      );
      if (issued.ok && issued.value) {
        set(lastIssuedUserId$, user.id);
      }
    }
    await bestEffort(set(checkSavedDeletionStatuses$, signal), signal);
  }),
  0,
);

/** Runs in both browser and Desktop's renderer partition. */
export const setupAccountErasureLocalLifecycle$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const unsubscribe = clerk.addListener(
      onDomEventFn(() => {
        return bestEffort(set(syncDeletionStatus$, signal), signal);
      }),
      { skipInitialEmit: true },
    );
    signal.addEventListener(
      "abort",
      () => {
        unsubscribe();
      },
      { once: true },
    );
    // The loop owns startup and polling off the app's first route: session
    // token reads and a blocked IndexedDB deletion must not hold it.
    setLoop(
      async () => {
        await bestEffort(set(syncDeletionStatus$, signal), signal);
        return false;
      },
      POLL_MS,
      signal,
      { retryTransientErrors: false, testIntervalMs: POLL_MS },
    );
  },
);
