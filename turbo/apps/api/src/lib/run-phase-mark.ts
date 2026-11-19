import type { RunPhaseMark } from "@okouai/api-contracts/contracts/run-phase-timing";

export function runPhaseMarkEvent(
  identity: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
  },
  mark: RunPhaseMark | { readonly phase: "completion-callback" },
  receivedAt: Date,
) {
  const event = {
    _time: receivedAt.toISOString(),
    schema_version: 2 as const,
    type: "run_phase_mark" as const,
    source: "callback" as const,
    run_id: identity.runId,
    user_id: identity.userId,
    org_id: identity.orgId,
  };
  if (mark.phase === "generation-start") {
    return {
      ...event,
      phase: mark.phase,
      generation_kind: mark.kind,
      research_skipped: mark.skipResearch,
    };
  }
  return { ...event, phase: mark.phase };
}
