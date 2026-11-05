import { listAgents } from "../../lib/api/domains/agents";
import { singleAgentEnabled } from "../../lib/api/single-agent";

export async function workflowAgentScope(
  agent?: string,
): Promise<string | undefined> {
  if (!(await singleAgentEnabled())) return agent;
  if (agent)
    throw new Error(
      "Workflow Agent targets are unavailable in My Okou. Use the current workspace or an explicit Workflow ID",
    );
  return await workspaceWorkflowAgentId();
}

export async function workspaceWorkflowAgentId(): Promise<string> {
  const agent = (await listAgents()).find((candidate) => {
    return candidate.isDefaultAgent;
  });
  if (!agent) throw new Error("Workspace default executor is unavailable");
  return agent.agentId;
}

let workspaceMode = false;
export function setWorkflowHelpMode(enabled: boolean): void {
  workspaceMode = enabled;
}
export function workflowHelp(legacy: string): string {
  if (!workspaceMode) return legacy;
  return legacy
    .replace(
      /^.*Copy onto another agent:.*$/gm,
      "  Make private copy:       okou workflow copy <workflow>",
    )
    .replace(/ --to-agent <[^>]+>/g, "")
    .replace(/ --agent <[^>]+>/g, "")
    .replace(
      /^.*A workflow belongs to exactly one agent.*$/gm,
      "  - Workflows belong to the current workspace; names resolve your private copy first",
    )
    .replace(/Create under an agent:/g, "Create a workflow:")
    .replace(/Copy onto another agent/g, "Make private copy");
}
