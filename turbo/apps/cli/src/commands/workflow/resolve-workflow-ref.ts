import { listWorkflows } from "../../lib/api/domains/workflows";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function isWorkflowName(ref: string): boolean {
  return ref.length >= 2 && ref.length <= 64 && WORKFLOW_NAME_RE.test(ref);
}

export async function resolveWorkflowRef(ref: string): Promise<string> {
  if (UUID_RE.test(ref)) {
    return ref;
  }

  if (!isWorkflowName(ref)) {
    throw new Error(
      `Invalid workflow ref: "${ref}". Use a workflow ID or a slug name like "tell-a-joke"`,
    );
  }

  const workflows = await listWorkflows();
  const matches = workflows.filter((workflow) => {
    return workflow.name === ref;
  });
  if (matches.length === 0) {
    throw new Error(`Workflow not found: "${ref}" in the current workspace`);
  }

  // Private records visible to this caller are their own.
  const privateMatches = matches.filter((workflow) => {
    return workflow.visibility === "private";
  });
  const winners = privateMatches.length > 0 ? privateMatches : matches;
  const [winner] = winners;
  if (winners.length !== 1 || !winner) {
    throw new Error(
      `Workflow name "${ref}" did not resolve to exactly one workflow in the workspace. Use the Workflow ID`,
    );
  }
  return winner.id;
}
