import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { workflowAutomationsRoutes } from "../../workflow-automations";
import { createChatEventsFixture } from "./chat-events-fixture";
import type { publicChatActor } from "./public-chat-actor";
import { createRouteMocks } from "./route-test";

type Owner = Awaited<ReturnType<typeof publicChatActor>>;
interface PublicBudgetRun {
  readonly runId: string;
  readonly threadId: string;
  readonly token: string;
  readonly agentId: string;
}

/** Issue credentials through a real claim, then release the Run's live slot. */
export async function claimBudgetRun(
  context: TestContext,
  owned: Owner,
  run: {
    readonly runId: string;
    readonly threadId: string;
    readonly agentId?: string;
  },
): Promise<PublicBudgetRun> {
  const { claim, sandboxHeaders } = await owned.claimChatRun(
    owned.runnerGroup,
    run.runId,
  );
  const token = claim.platformEnvironment.OKOU_TOKEN;
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

/** Prove an exact budget by real descendants followed by public rejection. */
export async function exerciseAutonomyBudget(
  context: TestContext,
  owned: Owner,
  source: PublicBudgetRun,
  budget: number,
): Promise<ReadonlyMap<number, PublicBudgetRun>> {
  const fixture = createChatEventsFixture(context);
  const sources = new Map<number, PublicBudgetRun>([[budget, source]]);
  let current = source;
  for (let remaining = budget; remaining >= 0; remaining -= 1) {
    const clientEventId = randomUUID();
    const submitted = await owned.requestSendEventWithBearer(
      current.token,
      {
        agentId: current.agentId,
        threadId: current.threadId,
        clientEventId,
        prompt: `Delegate with ${remaining} remaining hops`,
      },
      [201],
    );
    if (submitted.status !== 201) {
      throw new Error("Expected a queued delegation request");
    }
    expect(submitted.body.runId).toBeNull();
    const events = await owned.run(async () => {
      await flushWaitUntilForTest();
      return await fixture.chat.listThreadEvents(
        owned.actor,
        submitted.body.threadId,
      );
    });
    const results = events.events.filter((event) => {
      return event.revokesEventId === clientEventId;
    });
    expect(results).toHaveLength(1);
    const [result] = results;
    if (remaining === 0) {
      expect(result).toMatchObject({
        eventType: "input.rejected",
        error: "autonomy_budget_exhausted",
      });
      expect(result?.runId).toBeUndefined();
    } else {
      expect(result).toMatchObject({ eventType: "input.prompt" });
      if (!result?.runId) {
        throw new Error("Expected an actual descendant Run");
      }
      expect(result.runId).not.toBe(current.runId);
      current = await claimBudgetRun(context, owned, {
        runId: result.runId,
        threadId: submitted.body.threadId,
        agentId: current.agentId,
      });
      sources.set(remaining - 1, current);
    }
  }
  return sources;
}

/** Start an Automation normally; claim the new Run rather than an older event. */
export async function startBudgetAutomation(
  context: TestContext,
  owned: Owner,
  automationId: string,
  token?: string,
  agentId = owned.agentId,
): Promise<PublicBudgetRun> {
  const fixture = createChatEventsFixture(context);
  const client = setupApp({ context, routes: workflowAutomationsRoutes })(
    workflowAutomationsContract,
  );
  const submitted = await owned.run(async () => {
    createRouteMocks(context).clerk.session(
      owned.actor.userId,
      owned.actor.orgId,
      owned.actor.orgRole,
    );
    return await accept(
      client.run({
        headers: {
          authorization: token ? `Bearer ${token}` : "Bearer clerk-session",
        },
        params: { id: automationId },
      }),
      [201],
    );
  });
  expect(submitted.body.runId).toBeNull();
  const events = await owned.run(async () => {
    await flushWaitUntilForTest();
    return await fixture.chat.listThreadEvents(
      owned.actor,
      submitted.body.chatThreadId,
    );
  });
  const latest = events.events
    .filter((event) => {
      return event.eventType === "input.prompt" && event.runId;
    })
    .at(-1);
  if (!latest?.runId) {
    throw new Error("Expected the Automation's actual Run");
  }
  await owned.run(async () => {
    await expect(
      fixture.api.readRun(owned.actor, latest.runId!),
    ).resolves.toMatchObject({ status: "pending" });
  });
  return await claimBudgetRun(context, owned, {
    runId: latest.runId,
    threadId: submitted.body.chatThreadId,
    agentId,
  });
}
