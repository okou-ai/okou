import { command } from "ccstate";
import {
  marketingCheckoutContract,
  type MarketingCheckoutRequest,
} from "@okouai/api-contracts/contracts/marketing-checkout";
import {
  initClient,
  trpcRestFetchApi,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { nowDate } from "../../lib/time.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { apiClientRuntime$ } from "../api-client-runtime.ts";
import { rootSignal$ } from "../root-signal.ts";
import { bestEffort, setDaemon } from "../utils.ts";

const sendMarketingCheckoutStart$ = command(
  async ({ get }, event: MarketingCheckoutRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    const token = await get(apiClientRuntime$).getToken(signal);
    signal.throwIfAborted();
    if (!token) {
      return;
    }
    const client = initClient(marketingCheckoutContract, {
      baseUrl: resolveApiBaseForTarget("www"),
      api: (args) => {
        return trpcRestFetchApi(args, { parseResponseBody: false });
      },
    });
    await client.record({
      headers: { authorization: `Bearer ${token}` },
      body: event,
      fetchOptions: { credentials: "include", keepalive: true, signal },
    });
  },
);

/** One event per redirect action, independent of legacy gtag session dedupe. */
export const recordMarketingCheckoutStart$ = command(
  (
    { get, set },
    checkoutSource: MarketingCheckoutRequest["checkoutSource"],
  ) => {
    const event: MarketingCheckoutRequest = {
      eventId: crypto.randomUUID(),
      occurredAt: nowDate().toISOString(),
      checkoutSource,
    };
    // The root owns this bounded request; Stripe navigation never awaits it.
    setDaemon(async (ownerSignal) => {
      const requestSignal = AbortSignal.any([
        ownerSignal,
        AbortSignal.timeout(10_000),
      ]);
      await bestEffort(
        set(sendMarketingCheckoutStart$, event, requestSignal),
        ownerSignal,
      );
    }, get(rootSignal$));
  },
);
