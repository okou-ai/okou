import { command } from "ccstate";
import {
  INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { officialWorkflowCatalogState } from "@okouai/db/schema/official-workflow-catalog";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, exists, lte } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { API_INVOCATION_MAX_DURATION_SECONDS } from "../../lib/invocation-budget";
import { nowDate } from "../../lib/time";

/** The catalog sync owns the cutover because it publishes the executable bundle. */
export const upgradeMorningBriefInstallations$ = command(
  async ({ set }, releaseId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    // The production cron first sees this catalog after traffic promotion. An
    // outgoing invocation can still validate a queued input against its old name.
    const drainedBy = new Date(
      currentTime.getTime() - API_INVOCATION_MAX_DURATION_SECONDS * 1000,
    );
    const accepted = db
      .select({ id: officialWorkflowCatalogState.acceptedReleaseId })
      .from(officialWorkflowCatalogState)
      .where(
        and(
          eq(officialWorkflowCatalogState.acceptedReleaseId, releaseId),
          lte(officialWorkflowCatalogState.updatedAt, drainedBy),
        ),
      );
    await db
      .update(workflows)
      .set({
        name: MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
        officialDefinitionName: MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(
            workflows.officialDefinitionName,
            INTERNAL_TEST_MORNING_BRIEF_DEFINITION_NAME,
          ),
          exists(accepted),
        ),
      );
    signal.throwIfAborted();
  },
);
