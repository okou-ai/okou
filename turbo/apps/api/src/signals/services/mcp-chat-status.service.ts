import type {
  McpGetChatStatusInput,
  McpChatStatusResult,
} from "@okouai/api-contracts/contracts/mcp-chat-status";
import { command } from "ccstate";
import { agentRunById } from "./agent-runs.service";

/** The ordinary Web Run reader owns visibility and status; MCP adds no lifecycle. */
export const getMcpChatStatus$ = command(
  async (
    { get },
    principal: { readonly userId: string; readonly orgId: string },
    input: McpGetChatStatusInput,
    signal: AbortSignal,
  ): Promise<McpChatStatusResult> => {
    const run = await get(agentRunById({ ...principal, runId: input.runId }));
    signal.throwIfAborted();
    return run
      ? { kind: "ok", data: run }
      : { kind: "not_found", message: "Run not found." };
  },
);
