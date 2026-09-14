import { command } from "ccstate";
import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { googleAdsAccountForAttribution } from "@okouai/core/google-ads-account";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { user$ } from "../auth.ts";
import { readStoredAdAttributionMetadata$ } from "./ad-attribution.ts";

export const resolveGoogleAdsAccount$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<string | null> => {
    const user = await get(user$);
    signal.throwIfAborted();
    const attribution = set(readStoredAdAttributionMetadata$);
    if (!user) {
      return googleAdsAccountForAttribution(attribution);
    }
    const client = get(apiClient$)(acquisitionAttributionContract);
    const result = await accept(
      client.resolveGoogleAdsAccount({
        body: {
          attribution,
        },
        fetchOptions: { signal },
      }),
      [200, 404],
    );
    signal.throwIfAborted();
    // During mixed-version rollout an older API cannot prove ownership.
    return result.status === 200 ? result.body.googleAdsAccountId : null;
  },
);
