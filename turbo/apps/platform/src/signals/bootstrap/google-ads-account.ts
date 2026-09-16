import { command } from "ccstate";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { googleAdsAccountForAttribution } from "@okouai/core/google-ads-account";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  createAttributionRequest,
  readAttributionContext$,
  type AttributionContext,
} from "./attribution-request.ts";

const fetchGoogleAdsAccount$ = command(
  async (
    { get },
    context: AttributionContext,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const client = get(apiClient$)(acquisitionAttributionContract, {
      getTokenGuard: context.getTokenGuard,
    });
    const result = await accept(
      client.resolveGoogleAdsAccount({
        body: {
          attribution: context.attribution,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return result.body.googleAdsAccountId;
  },
);

const accountRequest = createAttributionRequest(
  fetchGoogleAdsAccount$,
  (id) => {
    return id !== null;
  },
);

export const invalidateGoogleAdsAccount$ = accountRequest.invalidate$;

export const resolveGoogleAdsAccount$ = command(
  async ({ set }, signal: AbortSignal): Promise<string | null> => {
    const context = await set(readAttributionContext$, signal);
    if (!context.user) {
      return googleAdsAccountForAttribution(context.attribution);
    }
    return await set(accountRequest.request$, context, signal);
  },
);
