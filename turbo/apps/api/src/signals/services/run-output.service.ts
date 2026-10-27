import { eq, lte, sql } from "drizzle-orm";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";

import { db$, writeDb$ } from "../external/db";
import { command } from "ccstate";
import { nowDate } from "../../lib/time";

export interface RunOutputCandidate {
  readonly sequenceNumber: number;
  readonly content: string;
}

/** The admitted-output owner observes cancellation after recording this attempt. */
export const upsertRunOutputMaterialization$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly latestResult: RunOutputCandidate | null;
      readonly latestOutput: RunOutputCandidate | null;
    },
  ): Promise<void> => {
    const { runId, latestResult, latestOutput } = args;
    if (latestResult !== null || latestOutput !== null) {
      const db = set(writeDb$);
      const updatedAt = nowDate();
      await db
        .insert(runOutputMaterializations)
        .values({
          runId,
          latestResultSequence: latestResult?.sequenceNumber,
          latestResultText: latestResult?.content,
          latestOutputSequence: latestOutput?.sequenceNumber,
          latestOutputText: latestOutput?.content,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: runOutputMaterializations.runId,
          set: {
            latestResultSequence:
              latestResult === null
                ? runOutputMaterializations.latestResultSequence
                : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestResultSequence}, -1)`, latestResult.sequenceNumber)} then ${latestResult.sequenceNumber} else ${runOutputMaterializations.latestResultSequence} end`,
            latestResultText:
              latestResult === null
                ? runOutputMaterializations.latestResultText
                : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestResultSequence}, -1)`, latestResult.sequenceNumber)} then ${latestResult.content} else ${runOutputMaterializations.latestResultText} end`,
            latestOutputSequence:
              latestOutput === null
                ? runOutputMaterializations.latestOutputSequence
                : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestOutputSequence}, -1)`, latestOutput.sequenceNumber)} then ${latestOutput.sequenceNumber} else ${runOutputMaterializations.latestOutputSequence} end`,
            latestOutputText:
              latestOutput === null
                ? runOutputMaterializations.latestOutputText
                : sql`case when ${lte(sql`coalesce(${runOutputMaterializations.latestOutputSequence}, -1)`, latestOutput.sequenceNumber)} then ${latestOutput.content} else ${runOutputMaterializations.latestOutputText} end`,
            updatedAt,
          },
        });
    }
  },
);

export const getRunOutputText$ = command(
  async (
    { get },
    runId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const db = get(db$);
    const [output] = await db
      .select({
        text: runOutputMaterializations.latestOutputText,
      })
      .from(runOutputMaterializations)
      .where(eq(runOutputMaterializations.runId, runId))
      .limit(1);
    signal.throwIfAborted();
    return output?.text ?? undefined;
  },
);
