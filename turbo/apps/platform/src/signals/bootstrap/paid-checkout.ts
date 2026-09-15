import { command } from "ccstate";
import { billingCheckoutContract } from "@okouai/api-contracts/contracts/billing";
import { IN_VITEST } from "../../env.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setLoop } from "../utils.ts";
const CHECKOUT_POLL_LIMIT = IN_VITEST ? 2 : 90;
const CHECKOUT_POLL_INTERVAL_MS = 1000;

export const completePaidCheckout$ = command(
  async (
    { get },
    args: {
      readonly sessionId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(apiClient$)(billingCheckoutContract);
    let attempts = 0;
    await setLoop(
      async (loopSignal) => {
        attempts += 1;
        const result = await accept(
          client.complete({
            body: { sessionId: args.sessionId },
            fetchOptions: { signal: loopSignal },
          }),
          [200],
        );
        loopSignal.throwIfAborted();
        if (result.body.completed) {
          return true;
        }
        if (attempts >= CHECKOUT_POLL_LIMIT) {
          throw new Error("Checkout completion timed out");
        }
        return false;
      },
      CHECKOUT_POLL_INTERVAL_MS,
      signal,
      { retryTransientErrors: false },
    );
  },
);
