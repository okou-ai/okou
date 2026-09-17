import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { purgeExpiredMorningBriefGenerations } from "./morning-brief-generation-store.service";

/**
 * The bounded maintenance consumer for expired Morning Brief result content.
 *
 * Retention that only runs when an owner comes back is not a bound: an owner
 * who invokes the preview once and never again would keep source-derived title
 * and Markdown indefinitely. This worker is what actually removes them, and it
 * is joined to an existing maintenance tick rather than to a new queue,
 * scheduler or recovery poller.
 *
 * It is deliberately modest. Each pass takes a small, ordered, `SKIP LOCKED`
 * batch of already expired rows, stops as soon as a batch comes back short, and
 * stops unconditionally at a batch count and a wall-clock budget — so a large
 * backlog is drained across ticks instead of inside one request. Whatever it
 * leaves behind is unreadable in the meantime: the release fence refuses a
 * result at its deadline, so purge latency delays physical removal, never
 * accessibility.
 */

/** Rows one pass removes per statement. Small enough to never hold locks long. */
const GENERATION_PURGE_BATCH_SIZE = 200;

/** Passes one tick may run. Bounds the work a single maintenance call does. */
const GENERATION_PURGE_MAX_BATCHES = 10;

/** The wall-clock budget one tick may spend, whatever the batches cost. */
const GENERATION_PURGE_BUDGET_MS = 5000;

export const executeMorningBriefGenerationRetentionWork$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const deadline = nowDate().getTime() + GENERATION_PURGE_BUDGET_MS;
    let purged = 0;
    for (let pass = 0; pass < GENERATION_PURGE_MAX_BATCHES; pass += 1) {
      signal.throwIfAborted();
      const removed = await purgeExpiredMorningBriefGenerations(
        db,
        nowDate(),
        GENERATION_PURGE_BATCH_SIZE,
      );
      signal.throwIfAborted();
      purged += removed;
      // A short batch means the expired set is drained, or the rest is locked
      // by a live attempt that will expire again on its own.
      if (removed < GENERATION_PURGE_BATCH_SIZE) {
        break;
      }
      if (nowDate().getTime() >= deadline) {
        break;
      }
    }
    signal.throwIfAborted();
    return purged;
  },
);
