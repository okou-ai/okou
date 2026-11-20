import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { workspaceExecutorId } from "../../lib/command/workspace-executor";
import { getOkouAgentId, getOkouToken } from "../../lib/okou-env";

// The Web permission action route uses the executor ID as a locator.
export async function resolvePermissionActionAgentId(): Promise<
  string | undefined
> {
  if (decodeSandboxTokenPayload()) {
    const executorId = getOkouAgentId();
    if (!executorId)
      throw new Error("The current Run execution context is unavailable.");
    return executorId;
  }
  return (
    getOkouAgentId() ?? (getOkouToken() ? workspaceExecutorId() : undefined)
  );
}
