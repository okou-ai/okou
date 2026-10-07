import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { command } from "ccstate";
import { and, inArray } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  morningBriefEnrollmentWhere,
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";

/** Complete a still-pending enrollment; a concurrent user cancellation wins. */
export const completeMorningBriefEnrollment$ = command(
  async (
    { set },
    owner: MorningBriefMemberIdentity,
    workflowId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    await set(writeDb$)
      .update(morningBriefEnrollments)
      .set({
        state: "completed",
        workflowId,
        lastError: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          morningBriefEnrollmentWhere(owner),
          inArray(morningBriefEnrollments.state, ["checking", "pending"]),
        ),
      );
    signal.throwIfAborted();
  },
);
