import { computed, type Computed } from "ccstate";

import { getDatasetName, queryAxiom } from "../external/axiom";
import { escapeAplString } from "../../lib/axiom-apl";
import { normalizeRunContextSnapshot } from "./run-context-snapshot.service";

export function runContextCliAgentType(
  runId: string,
): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const dataset = getDatasetName("run-context");
    const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| sort by _time desc
| limit 1`;

    const results = (await get(queryAxiom(apl))) as Record<string, unknown>[];
    const snapshot = results[0];
    if (!snapshot) {
      return null;
    }

    return normalizeRunContextSnapshot(snapshot).cliAgentType;
  });
}
