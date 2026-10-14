import type { TestContext } from "../../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";

/** Complete the actual Claude Code identity through the Sandbox protocol. */
export async function completePublicClaudeRun(
  context: TestContext,
  run: { readonly runId: string; readonly threadId: string },
  headers: { readonly authorization: string },
  content: string,
) {
  const webhooks = createWebhookCallbackApi(context);
  await webhooks.requestAgentEvents(
    {
      runId: run.runId,
      events: [
        {
          type: "system",
          subtype: "init",
          session_id: run.threadId,
          sequenceNumber: 0,
        },
        {
          type: "assistant",
          sequenceNumber: 1,
          message: { content: [{ type: "text", text: content }] },
        },
        { type: "result", sequenceNumber: 2, result: content },
      ],
    },
    headers,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: run.runId,
      exitCode: 0,
      lastEventSequence: 2,
      completion: {
        cliAgentType: "claude-code",
        cliAgentSessionId: run.threadId,
        cliAgentSessionHistoryDisposition: "native_only",
      },
    },
    headers,
    [200],
  );
  await flushWaitUntilForTest();
}
