import { eq } from "drizzle-orm";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";

import { db$ } from "../external/db";
import { command } from "ccstate";

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
    return output?.text === null || output?.text === undefined
      ? undefined
      : visiblePiMemoryCitationText(output.text);
  },
);
