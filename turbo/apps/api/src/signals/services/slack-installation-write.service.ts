import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { command } from "ccstate";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { expireOrgCredits$ } from "./org-credit-expiration.service";
import {
  settleSlackRewardClaim,
  slackRewardIdentity,
  slackRewardWalletEntitlement,
} from "./slack-installation-reward";

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;
interface SlackInstallationWrite {
  readonly fields: Pick<
    SlackInstallation,
    "encryptedBotToken" | "botUserId" | "slackWorkspaceName" | "botScopes"
  >;
  readonly workspaceId: string;
  readonly orgId: string | null;
  readonly userId: string | null;
  readonly mode: "install" | "reinstall" | "connect";
}

const commitSlackInstallation$ = command(
  async (
    { set },
    args: SlackInstallationWrite,
    signal: AbortSignal,
  ): Promise<SlackInstallation> => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0247; new non-billing transactions are prohibited.
    const installation = await db.transaction(async (tx) => {
      const orgId = args.orgId;
      if (orgId && args.userId) {
        const [inserted] = await tx
          .insert(orgMetadataCanonicalWrites)
          .values({ orgId })
          .onConflictDoNothing()
          .returning({ orgId: orgMetadata.orgId });
        if (inserted) {
          await tx
            .insert(orgPlanEntitlements)
            .values(slackRewardWalletEntitlement(orgId))
            .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
        }
      }
      const allowedOwner = args.orgId
        ? or(
            eq(slackOrgInstallations.orgId, args.orgId),
            isNull(slackOrgInstallations.orgId),
          )
        : undefined;
      const [installed] =
        args.mode === "reinstall"
          ? await tx
              .update(slackOrgInstallations)
              .set({ ...args.fields, updatedAt: nowDate() })
              .where(
                and(
                  eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId),
                  allowedOwner,
                ),
              )
              .returning()
          : await tx
              .insert(slackOrgInstallations)
              .values({
                ...args.fields,
                slackWorkspaceId: args.workspaceId,
                orgId: args.orgId && args.userId ? args.orgId : null,
                installedByUserId:
                  args.orgId && args.userId ? args.userId : null,
              })
              .onConflictDoUpdate({
                target: slackOrgInstallations.slackWorkspaceId,
                set: {
                  ...args.fields,
                  orgId: args.orgId,
                  installedByUserId: args.userId,
                  updatedAt: nowDate(),
                },
                setWhere: args.mode === "connect" ? allowedOwner : sql`false`,
              })
              .returning();
      if (!installed) {
        throw new Error("Slack installation upsert did not return a row");
      }
      if (!orgId || !args.userId || installed.orgId !== orgId) {
        return installed;
      }
      const at = nowDate();
      const reward = slackRewardIdentity(
        orgId,
        args.userId,
        args.workspaceId,
        at,
      );
      await tx
        .insert(getStartedClaims)
        .values(reward.values)
        .onConflictDoNothing(reward.conflict);
      // Every Slack reward writer first writes this workspace's installation
      // row, so the implicit row lock of that write orders claims per source.
      await settleSlackRewardClaim(tx, reward, at);
      signal.throwIfAborted();
      return installed;
    });
    signal.throwIfAborted();
    return installation;
  },
);

/**
 * Installation, permanent eligibility and organization credit publish together.
 * Due credit lots are expired first so the reward is not deferred by them; the
 * installation then commits once with one deterministic reward outcome.
 */
export const persistSlackInstallation$ = command(
  async (
    { set },
    args: SlackInstallationWrite,
    signal: AbortSignal,
  ): Promise<SlackInstallation> => {
    if (args.orgId && args.userId) {
      await set(expireOrgCredits$, args.orgId, signal);
    }
    return await set(commitSlackInstallation$, args, signal);
  },
);
