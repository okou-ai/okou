import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { expireOrgCredits$ } from "./org-credit-expiration.service";
import {
  settleSlackRewardClaim,
  slackRewardIdentity,
  slackRewardWalletEntitlement,
} from "./slack-installation-reward";
import {
  connectedSlackWorkspace,
  slackConnectionAdmission,
  slackConnectionValues,
  slackWorkspaceAdmission,
  type SlackWorkspaceConnection,
  type SlackWorkspaceConnectionResult,
} from "./slack-workspace-write-plan";

const SLACK_CONNECTION_WORKSPACE_FK =
  "slack_org_connections_slack_workspace_id_slack_org_installation";

type SlackWorkspaceConnectionDenial = Extract<
  SlackWorkspaceConnectionResult,
  { readonly message: string }
>;

/** Rolls back the connection writes when a concurrent binder won the workspace. */
class SlackWorkspaceConnectionDenied extends Error {
  constructor(readonly result: SlackWorkspaceConnectionDenial) {
    super(result.message);
    this.name = "SlackWorkspaceConnectionDenied";
  }
}

/** The installation was deleted after admission; the connection FK rejected it. */
function isDeletedInstallationReference(error: unknown): boolean {
  return (
    isForeignKeyViolation(error) &&
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause &&
    error.cause.constraint === SLACK_CONNECTION_WORKSPACE_FK
  );
}

function installationWhere(workspaceId: string) {
  return eq(slackOrgInstallations.slackWorkspaceId, workspaceId);
}

const slackAccountTaken = {
  kind: "forbidden",
  message: "This Slack account is already connected to another user.",
} as const;

/** A concurrent binder won; only a binding to this organization may proceed. */
function readmitBoundInstallation(
  args: SlackWorkspaceConnection,
  winner: typeof slackOrgInstallations.$inferSelect | undefined,
  connectionId: string,
  replaced: readonly { readonly slackUserId: string }[],
): SlackWorkspaceConnectionResult {
  const readmission = slackWorkspaceAdmission(args, winner);
  if (readmission.kind !== "allowed") {
    throw new SlackWorkspaceConnectionDenied(readmission);
  }
  if (readmission.installation.orgId !== args.orgId) {
    throw new SlackWorkspaceConnectionDenied({
      kind: "not_found",
      message: "Workspace not found. Please install the Slack app first.",
    });
  }
  return connectedSlackWorkspace(
    args,
    readmission.installation,
    connectionId,
    replaced,
  );
}

const commitSlackWorkspaceConnection$ = command(
  async (
    { set },
    args: SlackWorkspaceConnection,
    signal: AbortSignal,
  ): Promise<SlackWorkspaceConnectionResult> => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0248; new non-billing transactions are prohibited.
    const result = await db.transaction(
      async (tx): Promise<SlackWorkspaceConnectionResult> => {
        const [inserted] = await tx
          .insert(orgMetadataCanonicalWrites)
          .values({ orgId: args.orgId })
          .onConflictDoNothing()
          .returning({ orgId: orgMetadata.orgId });
        if (inserted) {
          await tx
            .insert(orgPlanEntitlements)
            .values(slackRewardWalletEntitlement(args.orgId))
            .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
        }
        const [currentInstallation] = await tx
          .select()
          .from(slackOrgInstallations)
          .where(installationWhere(args.workspaceId));
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
          return slackAccountTaken;
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
          const [winner] = await tx
            .select()
            .from(slackOrgInstallations)
            .where(installationWhere(args.workspaceId));
          return readmitBoundInstallation(
            args,
            winner,
            connection.id,
            replaced,
          );
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
        await settleSlackRewardClaim(tx, reward, at);
        signal.throwIfAborted();
        return connectedSlackWorkspace(args, bound, connection.id, replaced);
      },
    );
    signal.throwIfAborted();
    return result;
  },
);

/**
 * Workspace binding, account switch and its permanent reward receipt commit
 * together. Due credit lots are expired first so the reward is not deferred by
 * them; the connection then commits once and every lost race maps to one
 * deterministic result.
 */
export const connectSlackWorkspace$ = command(
  async (
    { set },
    args: SlackWorkspaceConnection,
    signal: AbortSignal,
  ): Promise<SlackWorkspaceConnectionResult> => {
    await set(expireOrgCredits$, args.orgId, signal);
    const result = await settle(
      set(commitSlackWorkspaceConnection$, args, signal),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return result.value;
    }
    if (result.error instanceof SlackWorkspaceConnectionDenied) {
      return result.error.result;
    }
    if (isDeletedInstallationReference(result.error)) {
      return {
        kind: "not_found",
        message: "Workspace not found. Please install the Slack app first.",
      };
    }
    throw result.error;
  },
);
