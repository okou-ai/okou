/**
 * Test fixtures for image-model states that production APIs cannot expose.
 *
 * Canonical member defaults and thread pins must use their production routes.
 * The routes intentionally reject retired IDs, and endpoint fallback tests
 * need run snapshot states without a public setter. Only those transition and
 * endpoint cases use controlled direct database access.
 */
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "../lib/db";

export async function setRetiredOrgMemberImageModelFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly retiredImageModel: string;
}): Promise<void> {
  await db()
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      selectedImageModel: args.retiredImageModel,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedImageModel: args.retiredImageModel,
        updatedAt: sql`now()`,
      },
    });
}

export async function setRetiredChatThreadImageModelFixture(
  chatThreadId: string,
  retiredImageModel: string,
): Promise<void> {
  await db()
    .update(chatThreads)
    .set({ selectedImageModel: retiredImageModel })
    .where(eq(chatThreads.id, chatThreadId));
}

export async function readRunImageModelSnapshotFixture(
  runId: string,
): Promise<string | null> {
  const [run] = await db()
    .select({ selectedImageModel: agentRuns.selectedImageModel })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  if (!run) {
    throw new Error("Expected a product run row for the image model snapshot");
  }
  return run.selectedImageModel;
}

export async function setRunImageModelFixture(
  runId: string,
  selectedImageModel: string | null,
): Promise<void> {
  await db()
    .update(agentRuns)
    .set({ selectedImageModel })
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)));
}
