import type {
  McpGetRunStatusInput,
  McpRunStatusResult,
} from "@okouai/api-contracts/contracts/mcp-run-status";
import { command } from "ccstate";
import { agentRunById } from "./agent-runs.service";

/** The ordinary Web Run reader owns visibility and status; MCP adds no lifecycle. */
export const getMcpRunStatus$ = command(
  async (
    { get },
    principal: { readonly userId: string; readonly orgId: string },
    input: McpGetRunStatusInput,
    signal: AbortSignal,
  ): Promise<McpRunStatusResult> => {
    const run = await get(agentRunById({ ...principal, runId: input.runId }));
    signal.throwIfAborted();
    return run
      ? { kind: "ok", data: run }
      : { kind: "not_found", message: "Run not found." };
  },
);
