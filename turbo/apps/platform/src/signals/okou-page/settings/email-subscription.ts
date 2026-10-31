import { emailSubscriptionContract } from "@okouai/api-contracts/client/email-subscription";
import { command, computed, state } from "ccstate";

import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";

const emailSubscriptionVersion$ = state(0);

export const emailSubscription$ = computed(async (get) => {
  get(emailSubscriptionVersion$);
  const client = get(apiClient$)(emailSubscriptionContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});

export const invalidateEmailSubscription$ = command(({ set }) => {
  set(emailSubscriptionVersion$, (version) => {
    return version + 1;
  });
});

export const updateEmailSubscription$ = command(
  async ({ get, set }, subscribed: boolean, signal: AbortSignal) => {
    const client = get(apiClient$)(emailSubscriptionContract);
    await accept(
      client.update({ body: { subscribed }, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(invalidateEmailSubscription$);
  },
);
