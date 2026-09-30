import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { command } from "ccstate";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { expireOrgCredits$ } from "./org-credit-expiration.service";
import {
  orgCreditInvoiceGrantSql,
  pendingOrgCreditExpirationQuery,
  requireNoPendingOrgCreditExpiration,
  trialCreditExtensionWhere,
} from "./org-credit-expiration";
import {
  legacyPlanEntitlementIsCurrent,
  legacyPlanEntitlementOwnerQuery,
  legacyPlanInvoiceAdmission,
  legacyPlanInvoiceEntitlement,
  legacyPlanInvoiceMetadata,
  legacyPlanMemberPackQuery,
  legacyPlanOmittedTrialQuery,
  legacyPlanTrialHistoryQuery,
  LegacyPlanInvoiceConflict,
  legacyPlanInvoiceWalletWhere,
  replacedLegacyPlanSubscriptionId,
  type LegacyPlanInvoice,
} from "./legacy-plan-invoice";

interface LegacyPlanInvoiceResult {
  readonly processed: boolean;
  readonly cancelReplaced: boolean;
  readonly replacedSubscriptionId: string | null;
}

const commitLegacyPlanInvoice$ = command(
  async (
    { set },
    input: {
      readonly invoice: LegacyPlanInvoice;
      readonly trialIds: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<LegacyPlanInvoiceResult> => {
    const db = set(writeDb$);
    const args = input.invoice;
    return await db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId));
      if (!wallet || legacyPlanInvoiceAdmission(wallet, args) === "rejected") {
        return {
          processed: false,
          cancelReplaced: false,
          replacedSubscriptionId: null,
        };
      }
      let writeMetadata =
        legacyPlanInvoiceAdmission(wallet, args) === "publish";
      let writeEntitlement =
        writeMetadata || legacyPlanEntitlementIsCurrent(wallet, args);
      if (writeEntitlement) {
        // The admission decision is a function of these wallet columns. This
        // conditional transition is the linearization point: it succeeds only
        // if they are unchanged, and its implicit row lock orders any later
        // plan writer after this commit. Zero rows rejects the stale read.
        const [claimed] = await tx
          .update(orgMetadata)
          .set({ updatedAt: sql`${orgMetadata.updatedAt}` })
          .where(legacyPlanInvoiceWalletWhere(args.orgId, wallet))
          .returning({ orgId: orgMetadata.orgId });
        if (!claimed) {
          throw new LegacyPlanInvoiceConflict(args.invoiceId);
        }
      }
      let cancelReplaced = true;
      if (writeMetadata) {
        const [pending] = await tx
          .select()
          .from(pendingOrgCreditExpirationQuery(args.orgId, nowDate()));
        requireNoPendingOrgCreditExpiration(args.orgId, pending);
        const [trial] = await tx
          .select()
          .from(legacyPlanTrialHistoryQuery(args));
        const extendTrial =
          args.details.credits > 0 &&
          args.details.subscription.status === "trialing" &&
          legacyPlanEntitlementIsCurrent(wallet, args) &&
          trial !== undefined;
        if (extendTrial) {
          const [omitted] = await tx
            .select()
            .from(legacyPlanOmittedTrialQuery(args, input.trialIds));
          if (omitted) {
            throw new Error(
              "Trial credit history changed during invoice publication",
            );
          }
          if (input.trialIds.length > 0) {
            await tx
              .update(creditExpiresRecord)
              .set({ expiresAt: args.details.expiresAt })
              .where(
                and(
                  trialCreditExtensionWhere(args.orgId, args.details.credits),
                  inArray(creditExpiresRecord.id, [...input.trialIds]),
                ),
              );
          }
          cancelReplaced = false;
        } else if (args.details.credits > 0) {
          const grantCount = (
            await tx.execute(
              orgCreditInvoiceGrantSql(
                args.orgId,
                {
                  source: "subscription_renewal",
                  stripeInvoiceId: args.invoiceId,
                  amount: args.details.credits,
                  expiresAt: args.details.expiresAt,
                },
                nowDate(),
              ),
            )
          ).rowCount;
          if (grantCount !== 1) {
            writeMetadata = false;
            writeEntitlement = legacyPlanEntitlementIsCurrent(wallet, args);
            cancelReplaced = false;
          }
        }
      }
      if (writeMetadata) {
        await tx
          .update(orgMetadata)
          .set(legacyPlanInvoiceMetadata(args, nowDate()))
          .where(eq(orgMetadata.orgId, args.orgId));
      }
      if (writeEntitlement) {
        const [memberPack] = await tx
          .select()
          .from(legacyPlanMemberPackQuery(args));
        const [stripeOwner] = await tx
          .select()
          .from(legacyPlanEntitlementOwnerQuery(args.subscriptionId));
        const values = legacyPlanInvoiceEntitlement(
          args,
          memberPack !== undefined,
          stripeOwner?.orgId,
        );
        await tx.insert(orgPlanEntitlements).values(values).onConflictDoUpdate({
          target: orgPlanEntitlements.orgId,
          set: values,
        });
      }
      signal.throwIfAborted();
      return {
        processed: true,
        cancelReplaced,
        replacedSubscriptionId: replacedLegacyPlanSubscriptionId(wallet, args),
      };
    });
  },
);

/** Provider details are ordinary input; every financial statement has one owner. */
export const publishLegacyPlanInvoice$ = command(
  async (
    { set },
    invoice: LegacyPlanInvoice,
    signal: AbortSignal,
  ): Promise<LegacyPlanInvoiceResult> => {
    const db = set(writeDb$);
    const [wallet] = await db
      .select()
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, invoice.orgId));
    signal.throwIfAborted();
    if (wallet && legacyPlanInvoiceAdmission(wallet, invoice) === "publish") {
      await set(expireOrgCredits$, invoice.orgId, signal);
    }
    const trialRows =
      invoice.details.subscription.status === "trialing" &&
      invoice.details.credits > 0
        ? await db
            .select({ id: creditExpiresRecord.id })
            .from(creditExpiresRecord)
            .where(
              trialCreditExtensionWhere(invoice.orgId, invoice.details.credits),
            )
            .orderBy(asc(creditExpiresRecord.id))
        : [];
    signal.throwIfAborted();
    const trialIds = trialRows.map(({ id }) => {
      return id;
    });
    for (let attempt = 0; ; attempt++) {
      const outcome = await settle(
        set(commitLegacyPlanInvoice$, { invoice, trialIds }, signal),
        signal,
      );
      if (outcome.ok) {
        return outcome.value;
      }
      // The whole commit rolled back; decide again from the current wallet.
      if (outcome.error instanceof LegacyPlanInvoiceConflict && attempt < 3) {
        continue;
      }
      throw outcome.error;
    }
  },
);
