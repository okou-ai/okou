import { command } from "ccstate";
import { billingCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { waitLoopUntil } from "../utils.ts";

const CHECKOUT_POLL_INTERVAL_MS = 1000;

export const completePaidCheckout$ = command(
  async ({ get }, sessionId: string, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(billingCheckoutContract);
    await waitLoopUntil(
      async (loopSignal) => {
        const result = await accept(
          client.complete({
            body: { sessionId },
            fetchOptions: { signal: loopSignal },
          }),
          [200],
        );
        loopSignal.throwIfAborted();
        if (result.body.completed) {
          return true;
        }
        return false;
      },
      CHECKOUT_POLL_INTERVAL_MS,
      signal,
      { retryTransientErrors: false },
    );
  },
);
