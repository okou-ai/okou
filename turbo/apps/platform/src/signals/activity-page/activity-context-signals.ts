import { computed } from "ccstate";
import { runContextContract } from "@okouai/api-contracts/contracts/run-routes";
import {
  normalizeActivityRunContext,
  type ActivityRunContext,
} from "./run-context.ts";
import { apiClient$ } from "../api-client.ts";
import { currentRunId$ } from "./activity-signals.ts";
import { accept } from "../../lib/accept.ts";

interface ActivityContext {
  runId: string;
  context: ActivityRunContext | null;
}

/**
 * Run context snapshot fetched from Axiom via the context API.
 * Returns null if context is not available (old runs or ingestion delay).
 */
export const activityContext$ = computed(async (get) => {
  const runId = get(currentRunId$);
  if (!runId) {
    return null;
  }

  const client = get(apiClient$)(runContextContract);
  const result = await accept(
    client.getContext({ params: { id: runId } }),
    [200, 404],
  );
  if (result.status === 404) {
    return {
      runId,
      context: null,
    } satisfies ActivityContext;
  }
  return {
    runId,
    context: normalizeActivityRunContext(result.body),
  } satisfies ActivityContext;
});
