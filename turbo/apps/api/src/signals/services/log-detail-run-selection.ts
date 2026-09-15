import { agentRuns } from "@okouai/db/runtime/agent-run";

export function logDetailRunSelection() {
  return {
    appendSystemPrompt: agentRuns.appendSystemPrompt,
    completedAt: agentRuns.completedAt,
    createdAt: agentRuns.createdAt,
    error: agentRuns.error,
    failureReason: agentRuns.failureReason,
    id: agentRuns.id,
    launchSnapshot: agentRuns.launchSnapshot,
    prompt: agentRuns.prompt,
    result: agentRuns.result,
    startedAt: agentRuns.startedAt,
    status: agentRuns.status,
  };
}
