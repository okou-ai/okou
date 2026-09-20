import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import { currentMembershipId$ } from "./morning-brief-collection-executor.service";
import {
  bringMorningBriefNativeObligationForward,
  type MorningBriefBringForwardResult,
} from "./morning-brief-native-schedule.service";

/**
 * The shortest gap the debug trigger allows between two claimed slots.
 *
 * Native execution is platform-funded: one admitted slot performs five real
 * source collections, one model request, one real Chat message and one real
 * email. The interval is derived from the owner's most recent `claimed_at`, so
 * it also counts a scheduled brief that has just run and needs no new column.
 */
export const MORNING_BRIEF_DEBUG_TRIGGER_MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Bring the caller's own native Morning Brief obligation forward to now.
 *
 * The live membership generation is resolved before the transaction opens, as
 * every native admission boundary does, and the transaction revalidates it
 * against the durable row under that row's lock.
 */
export const triggerMorningBriefNativeRun$ = command(
  async (
    { set },
    owner: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ): Promise<MorningBriefBringForwardResult> => {
    const db = set(writeDb$);
    const membershipId = await set(currentMembershipId$, owner, signal);
    signal.throwIfAborted();
    if (membershipId === null) {
      return { kind: "refused", reason: "membership-generation" };
    }
    const at = nowDate();
    return await db.transaction(async (tx) => {
      return await bringMorningBriefNativeObligationForward(tx, owner, {
        at,
        membershipId,
        minimumIntervalMs: MORNING_BRIEF_DEBUG_TRIGGER_MIN_INTERVAL_MS,
      });
    });
  },
);
