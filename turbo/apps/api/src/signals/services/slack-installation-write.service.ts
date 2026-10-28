import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { command } from "ccstate";
import { eq, isNull, or, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { pendingOrgCreditExpirationQuery } from "./org-credit-expiration";
import { expireOrgCredits$ } from "./org-credit-expiration.service";
import {
  claimNeedsSlackReward,
  slackOrgRewardSql,
  slackRewardGrantFailureReason,
  slackRewardIneligibleValues,
  slackRewardUnavailableReason,
  unsettledSlackClaim,
  slackRewardIdentity,
  slackRewardWalletEntitlement,
} from "./slack-installation-reward";

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;
interface SlackInstallationFields {
  readonly fields: Pick<
    SlackInstallation,
    "encryptedBotToken" | "botUserId" | "slackWorkspaceName" | "botScopes"
  >;
  readonly workspaceId: string;
}

type AnonymousSlackInstallationWrite = SlackInstallationFields & {
  readonly orgId: null;
  readonly userId: null;
  readonly mode: "install" | "reinstall";
};

type ConnectedSlackInstallationWrite = SlackInstallationFields & {
  readonly orgId: string;
  readonly userId: string;
  readonly mode: "connect";
};

type SlackInstallationWrite =
  AnonymousSlackInstallationWrite | ConnectedSlackInstallationWrite;

const commitAnonymousSlackInstallation$ = command(
  async (
    { set },
    args: AnonymousSlackInstallationWrite,
    signal: AbortSignal,
  ): Promise<SlackInstallation> => {
    const db = set(writeDb$);
    const [installed] =
      args.mode === "reinstall"
        ? await db
            .update(slackOrgInstallations)
            .set({ ...args.fields, updatedAt: nowDate() })
            .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
            .returning()
        : await db
            .insert(slackOrgInstallations)
            .values({
              ...args.fields,
              slackWorkspaceId: args.workspaceId,
              orgId: null,
              installedByUserId: null,
            })
            .onConflictDoUpdate({
              target: slackOrgInstallations.slackWorkspaceId,
              set: {
                ...args.fields,
                orgId: null,
                installedByUserId: null,
                updatedAt: nowDate(),
              },
              setWhere: sql`false`,
            })
            .returning();
    if (!installed) {
      throw new Error("Slack installation upsert did not return a row");
    }
    signal.throwIfAborted();
    return installed;
  },
);

const commitSlackInstallation$ = command(
  async (
    { set },
    args: ConnectedSlackInstallationWrite,
    signal: AbortSignal,
  ): Promise<SlackInstallation> => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Billing atomicity: workspace installation, its permanent reward receipt, credit lot and wallet increment must commit together; single-statement alternative: reward-key or organization-award conflicts must roll back only the attempted grant, then mark the claim ineligible while preserving installation, requiring savepoint recovery and later statement snapshots.
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
      const [installed] = await tx
        .insert(slackOrgInstallations)
        .values({
          ...args.fields,
          slackWorkspaceId: args.workspaceId,
          orgId: args.orgId && args.userId ? args.orgId : null,
          installedByUserId: args.orgId && args.userId ? args.userId : null,
        })
        .onConflictDoUpdate({
          target: slackOrgInstallations.slackWorkspaceId,
          set: {
            ...args.fields,
            orgId: args.orgId,
            installedByUserId: args.userId,
            updatedAt: nowDate(),
          },
          setWhere: allowedOwner,
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
      const [claim] = await tx
        .select()
        .from(getStartedClaims)
        .where(reward.where);
      if (claimNeedsSlackReward(claim)) {
        const awards = await tx
          .select({ rewardKey: getStartedClaims.rewardKey })
          .from(getStartedClaims)
          .where(reward.awardsWhere)
          .limit(2);
        let reason = slackRewardUnavailableReason(reward.rewardKey, awards);
        const [pending] = reason
          ? []
          : await tx
              .select()
              .from(pendingOrgCreditExpirationQuery(claim.orgId, at));
        if (!reason && !pending) {
          const granted = await settle(
            // eslint-disable-next-line api/no-db-transaction -- Billing atomicity: a duplicate Slack reward must roll back its credit lot and wallet increment while preserving installation; single-statement alternative: the grant CTE can fail either reward uniqueness check and PostgreSQL requires a savepoint to recover the surrounding transaction.
            tx.transaction(async (grantTx) => {
              await grantTx.execute(
                slackOrgRewardSql(claim, reward.rewardKey, at),
              );
            }),
          );
          reason = slackRewardGrantFailureReason(granted);
        }
        if (reason) {
          await tx
            .update(getStartedClaims)
            .set(slackRewardIneligibleValues(reason, at))
            .where(unsettledSlackClaim(claim.id));
        }
      }
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
    if (args.orgId === null) {
      return await set(commitAnonymousSlackInstallation$, args, signal);
    }
    if (args.orgId && args.userId) {
      await set(expireOrgCredits$, args.orgId, signal);
    }
    return await set(commitSlackInstallation$, args, signal);
  },
);
