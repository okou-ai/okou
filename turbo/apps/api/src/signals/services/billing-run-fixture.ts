import { agentRuns } from "@okouai/db/runtime/agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { inArray, sql } from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import { billingRunAttributionWrite } from "./managed-usage-attribution";

type WriteTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Called only in the same transaction that inserts these fresh fixture Runs. */
export async function captureFixtureRunBillings(
  tx: Pick<WriteTx, "select" | "insert">,
  runIds: readonly string[],
): Promise<void> {
  if (runIds.length === 0) {
    return;
  }
  const rows = await tx
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      startedAt: sql`${agentRuns.createdAt}::text`.mapWith(pgTextDecoder),
      triggerSource: agentRuns.triggerSource,
      threadId: agentRuns.chatThreadId,
    })
    .from(agentRuns)
    .where(inArray(agentRuns.id, [...runIds]));
  if (rows.length !== runIds.length) {
    throw new Error("Fixture Run is missing during billing capture");
  }
  for (let offset = 0; offset < rows.length; offset += 500) {
    const batch = rows.slice(offset, offset + 500);
    const inserted = await tx
      .insert(billingRunAttribution)
      .values(
        batch.map((run) => {
          return billingRunAttributionWrite(run).values;
        }),
      )
      .returning({ runId: billingRunAttribution.runId });
    if (inserted.length !== batch.length) {
      throw new Error("Fixture Run billing capture is incomplete");
    }
  }
}

export async function captureFixtureRunBilling(
  tx: Pick<WriteTx, "select" | "insert">,
  runId: string,
): Promise<void> {
  await captureFixtureRunBillings(tx, [runId]);
}
