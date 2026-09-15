import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import {
  createGetStartedClaim,
  getStartedRewardsEnabled,
} from "./get-started-rewards.service";

/** Snapshot provenance with the queued input, before it can start or be deleted. */
export async function recordGetStartedWorkflow(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly workflowId: string;
    readonly sourceEventId: string;
  },
): Promise<void> {
  if (!getStartedRewardsEnabled(args.orgId)) {
    return;
  }
  const [workflow] = await tx
    .select({
      createdBy: workflows.createdBy,
      officialDefinitionName: workflows.officialDefinitionName,
    })
    .from(workflows)
    .where(
      and(eq(workflows.id, args.workflowId), eq(workflows.orgId, args.orgId)),
    )
    .limit(1);
  if (!workflow || workflow.officialDefinitionName !== null) {
    return;
  }
  const [alreadyGranted] = await tx
    .select({ id: getStartedClaims.id })
    .from(getStartedClaims)
    .where(eq(getStartedClaims.rewardKey, `workflow:${workflow.createdBy}`))
    .limit(1);
  if (alreadyGranted) {
    return;
  }
  await createGetStartedClaim(tx, {
    ...args,
    userId: workflow.createdBy,
    actorUserId: args.userId,
    questKey: "workflow",
    sourceKey: args.sourceEventId,
  });
}
