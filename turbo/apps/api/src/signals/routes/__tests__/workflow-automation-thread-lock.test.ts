import {
  chatThreadByIdContract,
  chatThreadMetadataContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  clearChatThreadProvenanceFixture,
  readChatThreadProvenanceFixture,
  readMorningBriefBindingThreadFixture,
  seedMorningBriefChatMemberFixture,
  startActiveChatRunFixture$,
} from "../../../test-fixtures/morning-brief-chat-collection";
import { chatThreadDeleteRoutes } from "../chat-threads-delete";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { createRouteMocks } from "./helpers/route-test";

/**
 * Firing Morning Brief into a destination it already owns.
 *
 * `POST /api/workflow-automations/:id/run` is the only endpoint that reaches an
 * existing Morning Brief binding, so it is the ingress that has to keep the
 * sticky exclusion on a destination the brief has used before, including a
 * thread that predates the classification column. The row-lock order it shares
 * with thread deletion is covered where a transaction can be suspended between
 * the two rows.
 */
describe("POST /api/workflow-automations/:id/run reusing a Morning Brief destination", () => {
  const context = testContext();
  const store = createStore();

  function authHeaders() {
    return { authorization: "Bearer clerk-session" };
  }

  function automationsClient() {
    return setupApp({ context, routes: workflowAutomationsRoutes })(
      workflowAutomationsContract,
    );
  }

  function threadsClient() {
    return setupApp({ context, routes: chatThreadDeleteRoutes })(
      chatThreadByIdContract,
    );
  }

  function threadMetadataClient() {
    return setupApp({ context, routes: chatThreadGetRoutes })(
      chatThreadMetadataContract,
    );
  }

  function fireAutomation(automationId: string) {
    return automationsClient().run({
      headers: authHeaders(),
      params: { id: automationId },
    });
  }

  function readThread(threadId: string) {
    return threadMetadataClient().get({
      headers: authHeaders(),
      params: { id: threadId },
    });
  }

  type BriefMember = Awaited<
    ReturnType<typeof seedMorningBriefChatMemberFixture>
  >;

  async function readBoundThread(member: BriefMember) {
    return await readMorningBriefBindingThreadFixture({
      orgId: member.orgId,
      userId: member.userId,
      workflowId: member.workflowId,
    });
  }

  /**
   * A member whose Morning Brief already owns a destination, created by firing
   * the automation through its own route.
   *
   * That first fire's launch is rejected because this suite seeds no Official
   * Workflow catalog; its binding transaction has already committed by then, so
   * the destination under test is the one production creates. The Run left
   * running afterwards keeps every later fire waiting at the queue, which is
   * what lets the reuse cases below assert a completed request.
   */
  async function briefWithBoundThread() {
    const member = await seedMorningBriefChatMemberFixture();
    createRouteMocks(context).clerk.session(member.userId, member.orgId);
    await accept(fireAutomation(member.automationId), [409]);
    const chatThreadId = await readBoundThread(member);
    if (!chatThreadId) {
      throw new Error("Expected the fired automation's bound destination");
    }
    await accept(readThread(chatThreadId), [200]);
    await store.set(startActiveChatRunFixture$, chatThreadId, context.signal);
    return { member, chatThreadId };
  }

  it("excludes a reused destination that predates the classification", async () => {
    const { member, chatThreadId } = await briefWithBoundThread();
    await clearChatThreadProvenanceFixture(chatThreadId);

    const replayed = await accept(fireAutomation(member.automationId), [201]);

    expect(replayed.body.chatThreadId).toBe(chatThreadId);
    await expect(readChatThreadProvenanceFixture(chatThreadId)).resolves.toBe(
      "morning_brief",
    );

    // Replaying the same fire keeps the exclusion the thread already carries.
    const again = await accept(fireAutomation(member.automationId), [201]);
    expect(again.body.chatThreadId).toBe(chatThreadId);
    await expect(readChatThreadProvenanceFixture(chatThreadId)).resolves.toBe(
      "morning_brief",
    );
  }, 60_000);

  it("binds a fresh excluded destination after the previous one is deleted", async () => {
    const { member, chatThreadId } = await briefWithBoundThread();

    await accept(
      threadsClient().delete({
        headers: authHeaders(),
        params: { id: chatThreadId },
      }),
      [204],
    );
    await expect(readBoundThread(member)).resolves.toBeNull();

    // The next fire creates its own destination; its launch is rejected for the
    // same missing catalog, after the binding transaction has committed.
    await accept(fireAutomation(member.automationId), [409]);

    const rebound = await readBoundThread(member);
    expect(rebound).not.toBe(chatThreadId);
    if (!rebound) {
      throw new Error("Expected the refired automation's bound destination");
    }
    await accept(readThread(rebound), [200]);
    await accept(readThread(chatThreadId), [404]);
    await expect(readChatThreadProvenanceFixture(rebound)).resolves.toBe(
      "morning_brief",
    );
  }, 60_000);
});
