/**
 * Test fixtures for the run video-model snapshot.
 *
 * Retired member defaults cannot be written through the current endpoint, and
 * endpoint tests need controlled legacy null and pinned run snapshots. These
 * historical-input and snapshot cases therefore need direct DB access.
 */
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "../lib/db";

export async function setOrgMemberVideoModelFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly selectedVideoModel: string;
}): Promise<void> {
  await db()
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      selectedVideoModel: args.selectedVideoModel,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedVideoModel: args.selectedVideoModel,
        updatedAt: sql`now()`,
      },
    });
}

export async function readRunVideoModelFixture(
  runId: string,
): Promise<string | null> {
  return (await readRunRow(runId)).selectedVideoModel;
}

/** Confirms a run really is threadless before asserting how it resolved. */
export async function readRunChatThreadIdFixture(
  runId: string,
): Promise<string | null> {
  return (await readRunRow(runId)).chatThreadId;
}

async function readRunRow(runId: string): Promise<{
  readonly selectedVideoModel: string | null;
  readonly chatThreadId: string | null;
}> {
  const [run] = await db()
    .select({
      selectedVideoModel: agentRuns.selectedVideoModel,
      chatThreadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  if (!run) {
    throw new Error("Expected a product run row for the video model snapshot");
  }
  return run;
}
