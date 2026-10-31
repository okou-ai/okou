import { workflowAutomationsContract } from "@okouai/api-contracts/client/workflows";
import type { ChatThreadWorkflowAutomation } from "@okouai/api-contracts/contracts/workflows";
import { accept } from "../../lib/accept.ts";
import type { ApiClientFactory } from "../api-client.ts";

/**
 * List workflow automations bound to a chat thread for the workflow sidebar.
 */
export async function listThreadWorkflowAutomations(
  client: ApiClientFactory,
  params: { readonly threadId: string },
  fetchOptions?: RequestInit,
): Promise<ChatThreadWorkflowAutomation[]> {
  const result = await accept(
    client(workflowAutomationsContract).listForChatThread({
      params: { threadId: params.threadId },
      fetchOptions,
    }),
    [200],
  );
  return result.body;
}
