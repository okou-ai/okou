import {
  runPhaseMarkResultSchema,
  runPhaseTimingContract,
  type RunPhaseMark,
  type RunPhaseMarkResult,
} from "@okouai/api-contracts/contracts/run-phase-timing";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { getClientConfig } from "../core/client-factory";

type PhaseMarkOutcome =
  | RunPhaseMarkResult
  | {
      readonly schemaVersion: 2;
      readonly status: "unavailable";
      readonly reason:
        | "http-error"
        | "invalid-response"
        | "timeout-delivery-unknown"
        | "transport-error";
    };

/** Best-effort telemetry: one bounded HTTP attempt and no automatic retry. */
export async function markRunPhase(
  body: RunPhaseMark,
): Promise<PhaseMarkOutcome> {
  const signal = AbortSignal.timeout(500);
  try {
    const client = initClient(runPhaseTimingContract, await getClientConfig());
    const result = await client.mark({
      headers: {},
      body,
      fetchOptions: { signal },
    });
    if (result.status !== 202)
      return { schemaVersion: 2, status: "unavailable", reason: "http-error" };
    const parsed = runPhaseMarkResultSchema.safeParse(result.body);
    return parsed.success
      ? parsed.data
      : { schemaVersion: 2, status: "unavailable", reason: "invalid-response" };
  } catch {
    return {
      schemaVersion: 2,
      status: "unavailable",
      reason: signal.aborted ? "timeout-delivery-unknown" : "transport-error",
    };
  }
}
