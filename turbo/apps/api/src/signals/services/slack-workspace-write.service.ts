import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { isUniqueViolation } from "../../lib/pg-errors";
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
  slackRewardIneligibleValues,
} from "./slack-installation-reward";
import {
  connectedSlackWorkspace,
  slackConnectionAdmission,
  slackConnectionValues,
  slackWorkspaceAdmission,
  type SlackWorkspaceConnection,
  type SlackWorkspaceConnectionResult,
} from "./slack-workspace-write-plan";

const commitSlackWorkspaceConnection$ = command(
  async (
    { set },
    args: SlackWorkspaceConnection,
    signal: AbortSignal,
  ): Promise<SlackWorkspaceConnectionResult> => {
    const db = set(writeDb$);
    const result = await db.transaction(
      async (tx): Promise<SlackWorkspaceConnectionResult> => {
        const [inserted] = await tx
          .insert(orgMetadataCanonicalWrites)
          .values({ orgId: args.orgId })
          .onConflictDoNothing()
          .returning({ orgId: orgMetadata.orgId });
        await tx
          .select({ orgId: orgMetadata.orgId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, args.orgId))
          .for("update");
        if (inserted) {
          await tx
            .insert(orgPlanEntitlements)
            .values(slackRewardWalletEntitlement(args.orgId))
            .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
        }
        const [currentInstallation] = await tx
          .select()
          .from(slackOrgInstallations)
          .where(eq(slackOrgInstallations.slackWorkspaceId, args.workspaceId))
          .for("update");
        const admission = slackWorkspaceAdmission(args, currentInstallation);
        if (admission.kind !== "allowed") {
          return admission;
        }
        const installation = admission.installation;
        const plan = slackConnectionValues(args);
        const current = await tx
          .select({
            userId: slackOrgConnections.userId,
            slackUserId: slackOrgConnections.slackUserId,
          })
          .from(slackOrgConnections)
          .where(plan.currentWhere);
        const connectionDenied = slackConnectionAdmission(args, current);
        if (connectionDenied) {
          return connectionDenied;
        }
        const [connection] = await tx
          .insert(slackOrgConnections)
          .values(plan.values)
          .onConflictDoUpdate(plan.conflict)
          .returning({ id: slackOrgConnections.id });
        if (!connection) {
          return {
            kind: "forbidden",
            message: "This Slack account is already connected to another user.",
          };
        }
        const replaced = await tx
          .delete(slackOrgConnections)
          .where(plan.staleWhere)
          .returning({ slackUserId: slackOrgConnections.slackUserId });
        if (installation.orgId !== null) {
          return connectedSlackWorkspace(
            args,
            installation,
            connection.id,
            replaced,
          );
        }
        const at = nowDate();
        const [bound] = await tx
          .update(slackOrgInstallations)
          .set({
            orgId: args.orgId,
            installedByUserId: args.userId,
            updatedAt: at,
          })
          .where(plan.bindWhere)
          .returning();
        if (!bound) {
          throw new Error("Locked Slack installation could not be bound");
        }
        const reward = slackRewardIdentity(
          args.orgId,
          args.userId,
          args.workspaceId,
          at,
        );
        await tx
          .insert(getStartedClaims)
          .values(reward.values)
          .onConflictDoNothing(reward.conflict);
        const [claim] = await tx
          .select()
          .from(getStartedClaims)
          .where(reward.where)
          .for("update");
        if (!claim) {
          throw new Error("Slack completion claim was not persisted");
        }
        if (!["granted", "ineligible", "rejected"].includes(claim.status)) {
          const awards = await tx
            .select({ rewardKey: getStartedClaims.rewardKey })
            .from(getStartedClaims)
            .where(reward.awardsWhere)
            .limit(2);
          const reason = slackRewardUnavailableReason(reward.rewardKey, awards);
          if (reason) {
            await tx
              .update(getStartedClaims)
              .set(slackRewardIneligibleValues(reason, at))
              .where(eq(getStartedClaims.id, claim.id));
          } else {
            const [pending] = await tx
              .select()
              .from(pendingOrgCreditExpirationQuery(args.orgId, at));
            requireNoPendingOrgCreditExpiration(args.orgId, pending);
            await tx.execute(slackOrgRewardSql(claim, reward.rewardKey, at));
          }
        }
        signal.throwIfAborted();
        return connectedSlackWorkspace(args, bound, connection.id, replaced);
      },
    );
    signal.throwIfAborted();
    return result;
  },
);

/** Workspace binding, account switch and its permanent reward receipt commit together. */
export const connectSlackWorkspace$ = command(
  async (
    { set },
    args: SlackWorkspaceConnection,
    signal: AbortSignal,
  ): Promise<SlackWorkspaceConnectionResult> => {
    for (let attempt = 0; ; attempt++) {
      const result = await settle(
        set(commitSlackWorkspaceConnection$, args, signal),
      );
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
