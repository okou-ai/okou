import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { command } from "ccstate";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  OrgCreditExpirationRequired,
  pendingOrgCreditExpirationQuery,
  requireNoPendingOrgCreditExpiration,
} from "./org-credit-expiration";
import { expireOrgCredits$ } from "./org-credit-expiration.service";
import {
  slackRewardIdentity,
  slackRewardUnavailableReason,
  slackOrgRewardSql,
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
    const installation = await db.transaction(async (tx) => {
      const orgId = args.orgId;
      if (orgId && args.userId) {
        const [inserted] = await tx
          .insert(orgMetadataCanonicalWrites)
          .values({ orgId })
          .onConflictDoNothing()
          .returning({ orgId: orgMetadata.orgId });
        await tx
          .select({ orgId: orgMetadata.orgId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, orgId))
          .for("update");
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
        .onConflictDoNothing({
          target: [
            getStartedClaims.actorUserId,
            getStartedClaims.questKey,
            getStartedClaims.sourceKey,
          ],
        });
      const [claim] = await tx
        .select()
        .from(getStartedClaims)
        .where(reward.where)
        .for("update");
      if (!claim) {
        throw new Error("Slack completion claim was not persisted");
      }
      if (["granted", "ineligible", "rejected"].includes(claim.status)) {
        return installed;
      }
      const awards = await tx
        .select({ rewardKey: getStartedClaims.rewardKey })
        .from(getStartedClaims)
        .where(reward.awardsWhere)
        .limit(2);
      const reason = slackRewardUnavailableReason(reward.rewardKey, awards);
      if (reason) {
        await tx
          .update(getStartedClaims)
          .set({
            status: "ineligible",
            reason,
            updatedAt: at,
            leaseId: null,
            leaseExpiresAt: null,
          })
          .where(eq(getStartedClaims.id, claim.id));
        return installed;
      }
      const [pending] = await tx
        .select()
        .from(pendingOrgCreditExpirationQuery(orgId, at));
      requireNoPendingOrgCreditExpiration(orgId, pending);
      await tx.execute(slackOrgRewardSql(claim, reward.rewardKey, at));
      signal.throwIfAborted();
      return installed;
    });
    signal.throwIfAborted();
    return installation;
  },
);

/** Installation, permanent eligibility and organization credit publish together. */
export const persistSlackInstallation$ = command(
  async (
    { set },
    args: SlackInstallationWrite,
    signal: AbortSignal,
  ): Promise<SlackInstallation> => {
    for (let attempt = 0; ; attempt++) {
      const result = await settle(set(commitSlackInstallation$, args, signal));
      signal.throwIfAborted();
      if (result.ok) {
        return result.value;
      }
      if (attempt >= 3) {
        throw result.error;
      }
      if (result.error instanceof OrgCreditExpirationRequired) {
        await set(expireOrgCredits$, result.error.orgId, signal);
      } else if (
        !isUniqueViolation(result.error, "uq_get_started_reward_key") &&
        !isUniqueViolation(result.error, "uq_get_started_slack_org")
      ) {
        throw result.error;
      }
    }
  },
);
