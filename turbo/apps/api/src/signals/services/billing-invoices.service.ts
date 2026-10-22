import { computed, type Computed } from "ccstate";
import type { BillingInvoicesResponse } from "@okouai/api-contracts/contracts/billing";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { listStripeInvoices } from "../external/stripe-client";

export function orgInvoices(
  orgId: string,
): Computed<Promise<BillingInvoicesResponse>> {
  return computed(async (get): Promise<BillingInvoicesResponse> => {
    const db = get(db$);

    const [row] = await db
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    if (!row?.stripeCustomerId) {
      return { invoices: [] };
    }

    const result = await listStripeInvoices(row.stripeCustomerId);

    return {
      invoices: result.map((inv) => {
        return {
          id: inv.id,
          number: inv.number,
          date: inv.created,
          amount: inv.amount_paid,
          status: inv.status,
          hostedInvoiceUrl: inv.hosted_invoice_url,
        };
      }),
    };
  });
}
