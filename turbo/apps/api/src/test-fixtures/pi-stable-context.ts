import { randomUUID } from "node:crypto";

import { piStableContextPublications } from "@okouai/db/schema/pi-stable-context";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { writeDb$ } from "../signals/external/db";
import {
  clearStableAgentPromptBuildHookForTest,
  setStableAgentPromptBuildHookForTest,
} from "../signals/services/agent-runs-create.service";
import { beginPiStableContextPublication } from "../signals/services/pi-stable-context-generation.service";

const store = createStore();

export async function seedAgentStableContextPublicationFixture(args: {
  readonly orgId: string;
  readonly agentId: string;
}): Promise<void> {
  await store
    .set(writeDb$)
    .insert(piStableContextPublications)
    .values({
      orgId: args.orgId,
      agentId: args.agentId,
      subject: "@agent",
      publicationKey: `workflow:${randomUUID()}`,
      generation: 2,
      token: randomUUID(),
    });
}

export async function beginWorkflowStableContextPublicationFixture(args: {
  readonly orgId: string;
  readonly userId?: string;
  readonly agentId: string;
  readonly workflowId: string;
}): Promise<void> {
  await beginPiStableContextPublication(
    store.set(writeDb$),
    {
      orgId: args.orgId,
      agentId: args.agentId,
      ...(args.userId ? { userId: args.userId } : {}),
    },
    `workflow:${args.workflowId}`,
  );
}

export async function countAgentStableContextPublicationsFixture(
  agentId: string,
): Promise<number> {
  const rows = await store
    .set(writeDb$)
    .select({ token: piStableContextPublications.token })
    .from(piStableContextPublications)
    .where(eq(piStableContextPublications.agentId, agentId));
  return rows.length;
}

export async function withStableAgentPromptBuildCountFixture<T>(
  work: () => Promise<T>,
): Promise<{ readonly buildCount: number; readonly result: T }> {
  let buildCount = 0;
  setStableAgentPromptBuildHookForTest(() => {
    buildCount += 1;
  });
  onTestFinished(() => {
    clearStableAgentPromptBuildHookForTest();
  });
  const result = await work();
  clearStableAgentPromptBuildHookForTest();
  return { buildCount, result };
}
