import { agentRuns } from "@okouai/db/runtime/agent-run";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { modelProviderAuthSessions } from "@okouai/db/schema/model-provider-auth-session";
import { command } from "ccstate";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { conflict } from "../../lib/error";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishPersonalModelProvidersChangedSafely } from "../external/realtime";
import { settle } from "../utils";
import { invalidateCodexResetCreditExpiry } from "./codex-reset-credit-expiry.service";

interface Cancellation {
  readonly grantId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly provider: "claude-code" | "codex";
}

const candidate = alias(modelProviderAccounts, "replacement_account");
const active = alias(modelProviderAccounts, "active_account");
const PROVIDER_TYPES = {
  codex: "codex-oauth-token",
  "claude-code": "claude-code-oauth-token",
} as const;

function grantedAccountCondition(args: Cancellation, accountId: string) {
  return and(
    eq(modelProviderAccounts.id, accountId),
    eq(modelProviderAccounts.atomGrantId, args.grantId),
    eq(modelProviderAccounts.orgId, args.orgId),
    eq(modelProviderAccounts.userId, args.userId),
    eq(modelProviderAccounts.type, PROVIDER_TYPES[args.provider]),
  );
}

const cancelGrantReceipt$ = command(
  async ({ set }, args: Cancellation, signal: AbortSignal) => {
    const db = set(writeDb$);
    const type = PROVIDER_TYPES[args.provider];
    const at = nowDate();
    // Cancellation can arrive before an uncertain delivery. Keep a receipt so
    // a later delivery of the same grant cannot publish credentials.
    await db
      .insert(modelProviderAuthSessions)
      .values({
        id: args.grantId,
        orgId: args.orgId,
        userId: args.userId,
        connectorType: type,
        source: "atom-subscription-grant",
        status: "cancelled",
        cancelledAt: at,
        expiresAt: at,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();

    // Commit this fence before reading the account: a concurrent delivery may
    // have committed while this UPDATE waited. The next statement sees it.
    // Retrying cancellation finishes cleanup if the response or request is lost.
    const [grant] = await db
      .update(modelProviderAuthSessions)
      .set({
        status: "cancelled",
        cancelledAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(modelProviderAuthSessions.id, args.grantId),
          eq(modelProviderAuthSessions.orgId, args.orgId),
          eq(modelProviderAuthSessions.userId, args.userId),
          eq(modelProviderAuthSessions.connectorType, type),
          eq(modelProviderAuthSessions.source, "atom-subscription-grant"),
          or(
            ne(modelProviderAuthSessions.status, "imported"),
            isNotNull(modelProviderAuthSessions.modelProviderAccountId),
          ),
        ),
      )
      .returning({
        accountId: modelProviderAuthSessions.modelProviderAccountId,
      });
    signal.throwIfAborted();
    return (
      grant ??
      conflict(
        "Grant does not match the recipient or has no recorded subscription account; disconnect legacy subscriptions in Settings",
      )
    );
  },
);

export const cancelAtomSubscriptionGrant$ = command(
  async ({ set }, args: Cancellation, signal: AbortSignal) => {
    const grant = await set(cancelGrantReceipt$, args, signal);
    if ("status" in grant) {
      return grant;
    }
    const db = set(writeDb$);
    const at = nowDate();
    const type = PROVIDER_TYPES[args.provider];
    if (grant.accountId) {
      const ownedAccount = grantedAccountCondition(args, grant.accountId);
      await db
        .update(modelProviderAccounts)
        .set({
          isActive: false,
          disconnectedAt: at,
          updatedAt: at,
        })
        .where(and(ownedAccount, isNull(modelProviderAccounts.disconnectedAt)));
      signal.throwIfAborted();
      // Repair from a fresh snapshot so concurrent cancellations cannot promote
      // a disconnected sibling. Retries also repair after an interrupted request.
      const result = await settle(
        db
          .update(modelProviderAccounts)
          .set({
            isActive: true,
            updatedAt: at,
          })
          .where(
            and(
              isNull(modelProviderAccounts.disconnectedAt),
              inArray(
                modelProviderAccounts.id,
                db
                  .select({ id: candidate.id })
                  .from(candidate)
                  .where(
                    and(
                      eq(candidate.orgId, args.orgId),
                      eq(candidate.userId, args.userId),
                      eq(candidate.type, type),
                      isNull(candidate.disconnectedAt),
                      notExists(
                        db
                          .select({ id: active.id })
                          .from(active)
                          .where(
                            and(
                              eq(
                                active.modelProviderId,
                                candidate.modelProviderId,
                              ),
                              eq(active.isActive, true),
                              isNull(active.disconnectedAt),
                            ),
                          ),
                      ),
                    ),
                  )
                  .orderBy(
                    asc(candidate.needsReconnect),
                    asc(candidate.createdAt),
                    asc(candidate.id),
                  )
                  .limit(1),
              ),
            ),
          ),
      );
      signal.throwIfAborted();
      if (!result.ok) {
        if (isUniqueViolation(result.error)) {
          return conflict(
            "Subscription accounts changed concurrently; retry cancellation",
          );
        }
        throw result.error;
      }

      // Preserve captured credentials for already pending/running work, as with
      // the normal disconnect flow. Otherwise remove the credentials now.
      await db.delete(modelProviderAccounts).where(
        and(
          ownedAccount,
          isNotNull(modelProviderAccounts.disconnectedAt),
          notExists(
            db
              .select({ id: agentRuns.id })
              .from(agentRuns)
              .where(
                and(
                  eq(agentRuns.modelProviderId, modelProviderAccounts.id),
                  eq(agentRuns.orgId, args.orgId),
                  eq(agentRuns.userId, args.userId),
                  inArray(agentRuns.status, ["pending", "running"]),
                ),
              ),
          ),
        ),
      );
      signal.throwIfAborted();
      await db
        .delete(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, args.orgId),
            eq(modelProviders.userId, args.userId),
            eq(modelProviders.type, type),
            notExists(
              db
                .select({ id: modelProviderAccounts.id })
                .from(modelProviderAccounts)
                .where(
                  eq(modelProviderAccounts.modelProviderId, modelProviders.id),
                ),
            ),
          ),
        );
      signal.throwIfAborted();
      if (type === "codex-oauth-token") {
        invalidateCodexResetCreditExpiry(args, { binding: grant.accountId });
        invalidateCodexResetCreditExpiry(args, { binding: null });
      }
    }
    await publishPersonalModelProvidersChangedSafely(args.userId);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { grantId: args.grantId, status: "cancelled" as const },
    };
  },
);
