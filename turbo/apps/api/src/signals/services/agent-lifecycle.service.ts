import {
  piStableContextArtifacts,
  piStableContextGenerations,
  piStableContextHeads,
  piStableContextPublications,
} from "@okouai/db/schema/pi-stable-context";
import { asc, eq, or, sql, type SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { ClerkDeletionScope } from "./clerk-lifecycle-plan";

async function deleteStableContextGenerations(
  tx: Tx,
  condition: SQL,
): Promise<void> {
  await tx
    .select({
      orgId: piStableContextGenerations.orgId,
      agentId: piStableContextGenerations.agentId,
      subject: piStableContextGenerations.subject,
    })
    .from(piStableContextGenerations)
    .where(condition)
    .orderBy(
      asc(piStableContextGenerations.orgId),
      asc(piStableContextGenerations.agentId),
      asc(piStableContextGenerations.subject),
    )
    .for("update");
  await tx.delete(piStableContextGenerations).where(condition);
}

async function deleteStableContextHeads(tx: Tx, condition: SQL): Promise<void> {
  await tx
    .select({ id: piStableContextHeads.id })
    .from(piStableContextHeads)
    .where(condition)
    .orderBy(asc(piStableContextHeads.id))
    .for("update");
  await tx.delete(piStableContextHeads).where(condition);
}

export async function deleteAgentStableContextLifecycleData(
  tx: Tx,
  agentId: string,
): Promise<void> {
  await deleteStableContextGenerations(
    tx,
    eq(piStableContextGenerations.agentId, agentId),
  );
  await tx
    .delete(piStableContextPublications)
    .where(eq(piStableContextPublications.agentId, agentId));
  await deleteStableContextHeads(tx, eq(piStableContextHeads.agentId, agentId));
  await tx
    .delete(piStableContextArtifacts)
    .where(eq(piStableContextArtifacts.agentId, agentId));
}

export async function deleteClerkStableContextLifecycleData(
  tx: Tx,
  scope: ClerkDeletionScope,
  agentIds: readonly string[],
): Promise<void> {
  if (scope.kind === "organization") {
    // Publication fences deliberately have no Agent FK, so organization
    // deletion also removes any fence left by an interrupted Agent lifecycle.
    await deleteStableContextGenerations(
      tx,
      eq(piStableContextGenerations.orgId, scope.orgId),
    );
    await tx
      .delete(piStableContextPublications)
      .where(eq(piStableContextPublications.orgId, scope.orgId));
    // The Agent FK cascade has no deterministic row order. Remove its complete
    // head set explicitly after generation locks so archive repair and every
    // lifecycle writer acquire heads in the same UUID order.
    await deleteStableContextHeads(
      tx,
      eq(piStableContextHeads.orgId, scope.orgId),
    );
    return;
  }
  const ownedAgentGenerationCondition =
    agentIds.length === 0
      ? undefined
      : eq(
          piStableContextGenerations.agentId,
          sql`ANY(${sql.param(agentIds)}::uuid[])`,
        );
  const userGenerationCondition = eq(
    piStableContextGenerations.subject,
    scope.userId,
  );
  const generationCondition = ownedAgentGenerationCondition
    ? or(userGenerationCondition, ownedAgentGenerationCondition)
    : userGenerationCondition;
  if (!generationCondition) {
    throw new Error("Stable-context generation cleanup condition is empty");
  }
  await deleteStableContextGenerations(tx, generationCondition);
  await tx
    .delete(piStableContextPublications)
    .where(
      or(
        eq(piStableContextPublications.subject, scope.userId),
        agentIds.length === 0
          ? undefined
          : eq(
              piStableContextPublications.agentId,
              sql`ANY(${sql.param(agentIds)}::uuid[])`,
            ),
      ),
    );
  const ownedAgentHeadCondition =
    agentIds.length === 0
      ? undefined
      : eq(
          piStableContextHeads.agentId,
          sql`ANY(${sql.param(agentIds)}::uuid[])`,
        );
  const userHeadCondition = eq(piStableContextHeads.userId, scope.userId);
  const headCondition = ownedAgentHeadCondition
    ? or(userHeadCondition, ownedAgentHeadCondition)
    : userHeadCondition;
  if (!headCondition) {
    throw new Error("Stable-context head cleanup condition is empty");
  }
  // Stable artifacts are bound to the executing user even when the Agent is
  // public or owned by somebody else. Generation locks come before the full
  // head set. Explicitly delete every audience of an owned Agent in UUID order
  // before its FK cascade; the cascade retains ownership of their artifacts.
  await deleteStableContextHeads(tx, headCondition);
  await tx
    .delete(piStableContextArtifacts)
    .where(eq(piStableContextArtifacts.userId, scope.userId));
}
