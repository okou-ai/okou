import { command } from "ccstate";
import { z } from "zod";

import { accountErasureStatusContract } from "@okouai/api-contracts/contracts/account-erasure-status";

import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { clerk$ } from "./auth.ts";
import { deleteAccountLocalData$ } from "./external/account-erasure-local-data.ts";
import { localStorageSignals } from "./external/local-storage.ts";
import {
  bestEffort,
  detach,
  jsonParseOr,
  onDomEventFn,
  Reason,
  setLoop,
  settle,
  withCleanup,
} from "./utils.ts";

const capabilityStorage = localStorageSignals(
  "account-erasure-status-capabilities",
);
const capabilitySchema = z.object({
  userId: z.string().min(1),
  token: z.string().min(1),
});
type SavedCapability = z.infer<typeof capabilitySchema>;
const capabilitiesSchema = z.array(capabilitySchema).max(64);
const POLL_MS = 60_000;

function savedCapabilities(raw: string | null): SavedCapability[] {
  const parsed = capabilitiesSchema.safeParse(
    raw === null ? [] : jsonParseOr<unknown>(raw, null),
  );
  return parsed.success ? parsed.data : [];
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
    set(capabilityStorage.refresh$);
    const prior = savedCapabilities(get(capabilityStorage.get$));
    set(
      capabilityStorage.set$,
      JSON.stringify([
        ...prior.filter((saved) => {
          return saved.userId !== userId;
        }),
        {
          userId,
          token: response.body.token,
        },
      ]),
    );
    return true;
  },
);

const checkSavedDeletionStatuses$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(capabilityStorage.refresh$);
    const saved = savedCapabilities(get(capabilityStorage.get$));
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

/** Runs in both browser and Desktop's renderer partition. */
export const setupAccountErasureLocalLifecycle$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    let lastIssuedUserId: string | null = null;
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) {
        return;
      }
      checking = true;
      await withCleanup(
        bestEffort(set(checkSavedDeletionStatuses$, signal), signal),
        () => {
          checking = false;
        },
      );
    };
    const sync = async (): Promise<void> => {
      signal.throwIfAborted();
      const user = clerk.user;
      if (user !== undefined) {
        if (user && user.id !== lastIssuedUserId) {
          const issued = await settle(
            set(issueStatusCapability$, user.id, signal),
            signal,
          );
          if (issued.ok && issued.value) {
            lastIssuedUserId = user.id;
          }
        } else if (user === null) {
          lastIssuedUserId = null;
        }
      }
      // A blocked IndexedDB deletion must not hold the app's initial route.
      detach(check(), Reason.Daemon, "account erasure local cleanup");
    };
    const unsubscribe = clerk.addListener(onDomEventFn(sync));
    signal.addEventListener(
      "abort",
      () => {
        unsubscribe();
      },
      { once: true },
    );
    await sync();
    signal.throwIfAborted();
    setLoop(
      async () => {
        await sync();
        return false;
      },
      POLL_MS,
      signal,
      { retryTransientErrors: false, testIntervalMs: POLL_MS },
    );
  },
);
