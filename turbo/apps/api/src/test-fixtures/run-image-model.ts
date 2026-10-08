// The image-generation endpoint suite is outside this PR's scoped
// pick/preparation governance. Preserve its existing snapshot-state setter.
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../lib/db";

export async function setRunImageModelFixture(
  runId: string,
  selectedImageModel: string | null,
): Promise<void> {
  await db()
    .update(agentRuns)
    .set({ selectedImageModel })
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)));
}
