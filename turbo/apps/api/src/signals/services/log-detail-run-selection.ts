import { agentRuns } from "@okouai/db/runtime/agent-run";

export function logDetailRunSelection() {
  return {
    completedAt: agentRuns.completedAt,
    createdAt: agentRuns.createdAt,
    failureReason: agentRuns.failureReason,
    id: agentRuns.id,
    frameworkSessionId: agentRuns.frameworkSessionId,
    launchSnapshot: agentRuns.launchSnapshot,
    prompt: agentRuns.prompt,
    startedAt: agentRuns.startedAt,
    status: agentRuns.status,
  };
}
