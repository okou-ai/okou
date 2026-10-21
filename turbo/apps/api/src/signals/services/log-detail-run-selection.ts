import { agentRuns } from "@okouai/db/runtime/agent-run";

export function logDetailRunSelection() {
  return {
    appendSystemPrompt: agentRuns.appendSystemPrompt,
    completedAt: agentRuns.completedAt,
    createdAt: agentRuns.createdAt,
    error: agentRuns.error,
    failureReason: agentRuns.failureReason,
    id: agentRuns.id,
    frameworkSessionId: agentRuns.frameworkSessionId,
    launchSnapshot: agentRuns.launchSnapshot,
    prompt: agentRuns.prompt,
    startedAt: agentRuns.startedAt,
    status: agentRuns.status,
  };
}
