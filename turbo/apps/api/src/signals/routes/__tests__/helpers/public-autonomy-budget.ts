import type { TestContext } from "../../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { createChatEventsFixture } from "./chat-events-fixture";
import type { publicChatActor } from "./public-chat-actor";

type Owner = Awaited<ReturnType<typeof publicChatActor>>;
interface PublicBudgetRun {
  readonly runId: string;
  readonly threadId: string;
  readonly token: string;
  readonly agentId: string;
}

/** Issue execution credentials, then release the Run's live slot. */
export async function launchBudgetRun(
  context: TestContext,
  owned: Owner,
  run: {
    readonly runId: string;
    readonly threadId: string;
    readonly agentId?: string;
  },
): Promise<PublicBudgetRun> {
  const { execution, sandboxHeaders } = await owned.runExecution(run.runId);
  const token = execution.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the Runner to issue an agent token");
  }
  await owned.run(async () => {
    await createChatEventsFixture(context).failChatRun(
      run.runId,
      sandboxHeaders,
      "Delegation boundary inspected",
    );
    await flushWaitUntilForTest();
  });
  return { ...run, token, agentId: run.agentId ?? owned.agentId };
}
