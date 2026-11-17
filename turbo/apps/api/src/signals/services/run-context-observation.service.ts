import { computed, type Computed } from "ccstate";

import { escapeAplString } from "../../lib/axiom-apl";
import { getDatasetName, queryAxiom } from "../external/axiom";
import {
  normalizeRunContextSnapshot,
  type NormalizedRunContextSnapshot,
} from "./run-context-snapshot.service";

const RUN_CONTEXT_QUERY_PADDING_MS = 60 * 60 * 1000;

/** Diagnostic callers authorize the Run before querying its captured inputs. */
export function runContextObservation(args: {
  readonly runId: string;
  readonly run: Computed<
    Promise<{
      readonly createdAt: Date;
      readonly startedAt: Date | null;
    } | null>
  >;
}): Computed<Promise<NormalizedRunContextSnapshot | null>> {
  return computed(async (get) => {
    const run = await get(args.run);
    if (!run) {
      return null;
    }
    const dataset = getDatasetName("run-context");
    const apl = `['${dataset}']
| where runId == "${escapeAplString(args.runId)}"
| sort by _time desc
| limit 1`;
    const createdAtMs = run.createdAt.getTime();
    const results = await get(
      queryAxiom(apl, {
        // A late snapshot must become visible after a previously empty result.
        noCache: true,
        startTime: new Date(
          createdAtMs - RUN_CONTEXT_QUERY_PADDING_MS,
        ).toISOString(),
        // Include dispatch after a long queue, not just the original creation.
        endTime: new Date(
          Math.max(createdAtMs, run.startedAt?.getTime() ?? createdAtMs) +
            RUN_CONTEXT_QUERY_PADDING_MS,
        ).toISOString(),
      }),
    );
    const snapshot = results[0];
    return snapshot ? normalizeRunContextSnapshot(snapshot) : null;
  });
}
