import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { personalExecutorId } from "../../lib/command/single-agent";
import { isPersonalExecution } from "../../lib/personal-execution";
import { getOkouAgentId, getOkouToken } from "../../lib/okou-env";

// The Web permission action route uses the executor ID as a locator.
export async function resolvePermissionActionAgentId(
  flagAgentId: string | undefined,
): Promise<string | undefined> {
  if (isPersonalExecution()) {
    if (flagAgentId !== undefined)
      throw new Error(
        "Agent selection is unavailable in My Okou. Remove --agent to use your own workspace access.",
      );
    if (decodeSandboxTokenPayload()) {
      const executorId = getOkouAgentId();
      if (!executorId)
        throw new Error(
          "The current Run execution context is unavailable. Do not substitute another executor.",
        );
      return executorId;
    }
    return getOkouToken() ? personalExecutorId() : undefined;
  }
  const runAgentId = getOkouAgentId();
  if (
    runAgentId !== undefined &&
    flagAgentId !== undefined &&
    flagAgentId !== runAgentId
  ) {
    throw new Error(
      `--agent ${flagAgentId} conflicts with the current run's Agent ${runAgentId}. Remove --agent or use --agent ${runAgentId}.`,
    );
  }
  return runAgentId ?? flagAgentId;
}
