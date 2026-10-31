import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/client/third-party-subscriptions";
import { command, computed, state } from "ccstate";
import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { invalidateAvailableRunModels$ } from "./run-models.ts";

const internalReloadThirdPartySubscriptions$ = state(0);

/** Account reads outside the shared list share its mutation invalidation. */
export const personalModelProviderAccountRevision$ = computed((get) => {
  return get(internalReloadThirdPartySubscriptions$);
});

/** Reuse recent upstream usage reads for opportunistic UI refreshes. */
const THIRD_PARTY_SUBSCRIPTIONS_STALE_MS = 60_000;
const internalThirdPartySubscriptionsRefreshedAt$ = state<number | null>(null);

/** Mutations and realtime updates bypass the opportunistic refresh window. */
export const reloadThirdPartySubscriptions$ = command(({ set }) => {
  set(invalidateAvailableRunModels$);
  set(internalThirdPartySubscriptionsRefreshedAt$, now());
  set(internalReloadThirdPartySubscriptions$, (value) => {
    return value + 1;
  });
});

export const thirdPartySubscriptions$ = computed(async (get) => {
  get(internalReloadThirdPartySubscriptions$);
  const createClient = get(apiClient$);
  const client = createClient(thirdPartySubscriptionsMainContract);
  const result = await accept(client.list(), [200]);
  return result.body;
});

export const refreshThirdPartySubscriptionsIfStale$ = command(
  ({ get, set }) => {
    const refreshedAt = get(internalThirdPartySubscriptionsRefreshedAt$);
    if (
      refreshedAt !== null &&
      now() - refreshedAt < THIRD_PARTY_SUBSCRIPTIONS_STALE_MS
    ) {
      return;
    }
    set(reloadThirdPartySubscriptions$);
  },
);
