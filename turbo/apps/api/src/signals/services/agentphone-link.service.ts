import { agentphoneConnectionCodes } from "@okouai/db/schema/agentphone-connection-code";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { command } from "ccstate";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  normalizeAgentPhoneHandle,
  type AgentPhoneChannel,
  type AgentPhoneUserLink,
} from "./agentphone-shared.service";
import {
  completedGetStartedQuestSql,
  memberRewardWalletQuery,
} from "./get-started-member-reward";
import { slackRewardWalletEntitlement } from "./slack-installation-reward";

type LinkResult =
  | { readonly kind: "invalid" }
  | {
      readonly kind: "conflict";
      readonly reason: "phone-handle-linked" | "org-linked" | "conflict";
    }
  | { readonly kind: "linked"; readonly userLink: AgentPhoneUserLink };
type LinkSource =
  | { readonly kind: "direct"; readonly orgId: string; readonly userId: string }
  | { readonly kind: "code"; readonly codeHash: string };

function existingLinkResult(
  rows: readonly AgentPhoneUserLink[],
  identity: { readonly orgId: string; readonly userId: string },
  phoneHandle: string,
): LinkResult | null {
  const phone = rows.find((row) => {
    return row.phoneHandle === phoneHandle;
  });
  if (phone) {
    return phone.orgId === identity.orgId && phone.userId === identity.userId
      ? { kind: "linked", userLink: phone }
      : { kind: "conflict", reason: "phone-handle-linked" };
  }
  const member = rows.find((row) => {
    return row.orgId === identity.orgId && row.userId === identity.userId;
  });
  return member ? { kind: "conflict", reason: "org-linked" } : null;
}

/** Link, optional one-time code consumption, and its reward are one finite commit. */
export const linkAgentPhoneIdentity$ = command(
  async (
    { set },
    args: {
      readonly phoneHandle: string;
      readonly channel: AgentPhoneChannel;
      readonly source: LinkSource;
    },
    signal: AbortSignal,
  ): Promise<LinkResult> => {
    const db = set(writeDb$);
    const phoneHandle = normalizeAgentPhoneHandle(
      args.phoneHandle,
      args.channel,
    );
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0052; new non-billing transactions are prohibited.
    const result = await db.transaction(async (tx) => {
      const at = nowDate();
      // Consuming the one active code is the conditional write itself: a
      // concurrent consumer re-checks consumed_at after the first commits and
      // gets zero rows (invalid). An ambiguous hash still consumes nothing.
      const codes =
        args.source.kind === "code"
          ? await tx
              .update(agentphoneConnectionCodes)
              .set({
                consumedAt: at,
                consumedPhoneHandle: phoneHandle,
                updatedAt: at,
              })
              .where(
                and(
                  eq(agentphoneConnectionCodes.codeHash, args.source.codeHash),
                  isNull(agentphoneConnectionCodes.consumedAt),
                  gt(agentphoneConnectionCodes.expiresAt, at),
                  sql`(SELECT count(*) FROM (SELECT 1 FROM ${agentphoneConnectionCodes} AS active_code
                    WHERE active_code.code_hash = ${args.source.codeHash}
                      AND active_code.consumed_at IS NULL
                      AND active_code.expires_at > ${sql.param(at, agentphoneConnectionCodes.expiresAt)}
                    LIMIT 2) AS matching) = 1`,
                ),
              )
              .returning()
          : [];
      const code = codes.length === 1 ? codes[0] : undefined;
      const identity = args.source.kind === "direct" ? args.source : code;
      if (!identity) {
        return { kind: "invalid" } as const;
      }
      const [insertedWallet] = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({ orgId: identity.orgId })
        .onConflictDoNothing()
        .returning({ orgId: orgMetadata.orgId });
      await tx.select().from(memberRewardWalletQuery(identity.orgId));
      if (insertedWallet) {
        await tx
          .insert(orgPlanEntitlements)
          .values(slackRewardWalletEntitlement(identity.orgId))
          .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
      }
      const rows = await tx
        .select()
        .from(agentphoneUserLinks)
        .where(
          or(
            eq(agentphoneUserLinks.phoneHandle, phoneHandle),
            and(
              eq(agentphoneUserLinks.userId, identity.userId),
              eq(agentphoneUserLinks.orgId, identity.orgId),
            ),
          ),
        )
        .limit(2);
      let linked = existingLinkResult(rows, identity, phoneHandle);
      if (!linked) {
        const [inserted] = await tx
          .insert(agentphoneUserLinks)
          .values({
            phoneHandle,
            userId: identity.userId,
            orgId: identity.orgId,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          await tx.execute(
            completedGetStartedQuestSql(
              {
                orgId: identity.orgId,
                userId: identity.userId,
                questKey: "imessage",
                sourceKey: "agentphone-link",
              },
              at,
            ),
          );
          linked = { kind: "linked", userLink: inserted };
        } else {
          linked = { kind: "conflict", reason: "conflict" };
        }
      }
      signal.throwIfAborted();
      return linked;
    });
    signal.throwIfAborted();
    return result;
  },
);
