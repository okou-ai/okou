import { computed } from "ccstate";
import { billingInvoicesContract } from "@okouai/api-contracts/contracts/billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { orgInvoices } from "../services/billing-invoices.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can view invoices",
      code: "FORBIDDEN",
    }),
  }),
});

const getInvoicesInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  const invoices = await get(orgInvoices(auth.orgId));
  return { status: 200 as const, body: invoices };
});

export const billingInvoicesRoutes: readonly RouteEntry[] = [
  {
    route: billingInvoicesContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getInvoicesInner$,
    ),
  },
];
