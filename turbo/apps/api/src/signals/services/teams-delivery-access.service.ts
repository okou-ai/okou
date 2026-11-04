import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { command } from "ccstate";
import { teamsOrgConnections } from "@okouai/db/runtime/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { checkTeamsConversationMember } from "../external/teams-bot-client";
import { teamsAccountOwnerCondition } from "./teams-workspace-identity.service";

/** Revalidate a persisted automatic reply without opening another conversation. */
export const teamsDeliveryAccess$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly tenantId: string;
      readonly connectionId: string;
      readonly teamsUserId: string;
      readonly conversationId: string;
    },
    signal: AbortSignal,
  ) => {
    const [binding] = await get(db$)
      .select({
        serviceUrl: teamsOrgInstallations.serviceUrl,
        aadObjectId: teamsOrgConnections.teamsAadObjectId,
      })
      .from(teamsOrgConnections)
      .innerJoin(
        teamsOrgInstallations,
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
      )
      .where(
        and(
          teamsAccountOwnerCondition(args),
          eq(teamsOrgConnections.id, args.connectionId),
          eq(teamsOrgConnections.teamsTenantId, args.tenantId),
          eq(teamsOrgConnections.teamsUserId, args.teamsUserId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!binding?.serviceUrl) {
      return false;
    }
    const member = await set(
      getMemberRoleAndUpdateCache$,
      args.orgId,
      args.userId,
      signal,
    );
    if (member.kind !== "member") {
      return false;
    }
    const membership = await checkTeamsConversationMember(
      {
        serviceUrl: binding.serviceUrl,
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        teamsUserId: args.teamsUserId,
        ...(binding.aadObjectId ? { aadObjectId: binding.aadObjectId } : {}),
      },
      signal,
    );
    if (membership.kind === "teams-error") {
      throw new Error(`Microsoft Teams API error: ${membership.error}`);
    }
    return membership.kind === "allowed";
  },
);
