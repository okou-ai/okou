import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";
import { command } from "ccstate";
import { badRequestMessage } from "../../lib/error";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";

// Old open App pages can still submit a code. Remove after the replacement App
// is live and its client-version floor excludes those pages: #47009.
const redeemCode$ = authRoute(
  { requireOrganization: true, missingOrganizationStatus: 401 },
  command(() => {
    return badRequestMessage(
      "Invite codes are no longer available. Refresh this page to continue onboarding without a code.",
    );
  }),
);

export const billingRedeemCodeRoutes: readonly RouteEntry[] = [
  { route: billingRedeemCodeContract.create, handler: redeemCode$ },
];
