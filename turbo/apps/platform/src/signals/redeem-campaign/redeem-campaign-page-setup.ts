import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { billingRedeemContract } from "@okouai/api-contracts/client/billing";
import { RedeemCampaignPage } from "../../views/redeem-campaign-page/redeem-campaign-page.tsx";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { pathParams$, searchParams$ } from "../route.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import {
  setRedeemResponse$,
  setRedeemStripeSuccess$,
} from "./redeem-campaign-signals.ts";

/**
 * Setup command for the unified `/redeem/:campaign` route.
 *
 * Wrapped by `setupAuthPageWrapper`, so this command is only reached for an
 * authenticated user with an active org. We branch on `?stripe=success` first
 * (Stripe's return URL) so a user coming back from Checkout sees the success
 * confirmation without another API call; otherwise we POST once to the new
 * redeem endpoint and stash the discriminated-union response for the view
 * to switch on.
 */
export const setupRedeemCampaignPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(RedeemCampaignPage), "standalone");
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.lifecycle.redeemCampaign.documentTitle;
      }),
    );

    const params = get(pathParams$);
    const campaign =
      typeof params?.campaign === "string" ? params.campaign : "";
    const searchParams = get(searchParams$);
    const stripeSuccess = searchParams.get("stripe") === "success";

    set(setRedeemStripeSuccess$, stripeSuccess);

    if (stripeSuccess) {
      set(setRedeemResponse$, null);
      await set(hideAppSkeleton$, signal);
      return;
    }

    const origin = window.location.origin;
    const successUrl = new URL(
      `/redeem/${encodeURIComponent(campaign)}`,
      origin,
    );
    successUrl.searchParams.set("stripe", "success");
    const cancelUrl = new URL(
      `/redeem/${encodeURIComponent(campaign)}`,
      origin,
    );

    const client = get(apiClient$)(billingRedeemContract);
    const result = await accept(
      client.create({
        params: { campaign },
        body: {
          successUrl: successUrl.toString(),
          cancelUrl: cancelUrl.toString(),
        },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(setRedeemResponse$, result.body);

    await set(hideAppSkeleton$, signal);
  },
);
