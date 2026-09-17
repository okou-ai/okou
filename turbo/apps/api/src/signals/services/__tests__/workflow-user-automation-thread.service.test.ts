import {
  chatThreadByIdContract,
  chatThreadMetadataContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import {
  clearChatThreadProvenanceFixture,
  readChatThreadProvenanceFixture,
  readMorningBriefBindingThreadFixture,
  seedMorningBriefChatMemberFixture,
} from "../../../test-fixtures/morning-brief-chat-collection";
import {
  holdWorkflowAutomationThreadBindingFixture,
  type WorkflowAutomationThreadLockWaiter,
} from "../../../test-fixtures/workflow-automation-thread-binding-lock";
import { writeDb$ } from "../../external/db";
import { chatThreadDeleteRoutes } from "../../routes/chat-threads-delete";
import { chatThreadGetRoutes } from "../../routes/chat-threads-get";
import { createRouteMocks } from "../../routes/__tests__/helpers/route-test";
import { settleIncludingAbort } from "../../utils";
import { ensureWorkflowUserAutomationThread } from "../workflow-user-automation-thread.service";

const BINDING_LOCK_STATEMENT = 'from "workflow_user_automation_threads"';
const THREAD_LOCK_STATEMENT = 'from "chat_threads"';

/**
 * The lock order Morning Brief thread reuse shares with thread deletion.
 *
 * Reuse stamps the sticky exclusion on the thread its binding already points
 * at, and `DELETE /api/chat-threads/:id` disables that binding while holding
 * the same thread. Taking the binding first and the thread second closed a
 * cycle with that order, and both callers deadlocked whenever a member fired
 * Morning Brief while deleting its destination.
 *
 * Deletion is the real endpoint in every case here. The reuse side is the
 * binding transaction `POST /api/workflow-automations/:id/run` opens, because
 * no endpoint stops there: that route goes on to insert the automation's queue
 * event once the transaction commits, and a deletion already queued on the
 * destination wins the row at that moment, so driving the whole route would
 * assert a separate ingress race instead of the lock order this owns. The
 * route suite covers the reuse branch end to end. Holding the binding row is
 * infrastructure scheduling only; no endpoint parks a transaction between the
 * two rows whose order is under test.
 */
describe("workflow automation chat thread binding lock order", () => {
  const context = testContext();
  const store = createStore();

  function authHeaders() {
    return { authorization: "Bearer clerk-session" };
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

  function authenticate(member: {
    readonly orgId: string;
    readonly userId: string;
  }) {
    createRouteMocks(context).clerk.session(member.userId, member.orgId);
  }

  function deleteThread(threadId: string) {
    return threadsClient().delete({
      headers: authHeaders(),
      params: { id: threadId },
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

  /** The binding transaction `POST /api/workflow-automations/:id/run` opens. */
  function fireBindingTransaction(member: BriefMember) {
    return store.set(writeDb$).transaction(async (tx) => {
      return await ensureWorkflowUserAutomationThread(tx, {
        orgId: member.orgId,
        userId: member.userId,
        workflowId: member.workflowId,
        agentId: member.agentId,
        workflowTitle: "Okou Morning Brief",
        currentTime: nowDate(),
      });
    });
  }

  async function readBoundThread(member: BriefMember) {
    return await readMorningBriefBindingThreadFixture({
      orgId: member.orgId,
      userId: member.userId,
      workflowId: member.workflowId,
    });
  }

  /** A member whose Morning Brief already owns the destination it created. */
  async function briefWithBoundThread() {
    const member = await seedMorningBriefChatMemberFixture();
    authenticate(member);
    const chatThreadId = await fireBindingTransaction(member);
    await expect(readBoundThread(member)).resolves.toBe(chatThreadId);
    await expect(readChatThreadProvenanceFixture(chatThreadId)).resolves.toBe(
      "morning_brief",
    );
    return { member, chatThreadId };
  }

  async function holdBinding(member: BriefMember) {
    const held = await holdWorkflowAutomationThreadBindingFixture(
      {
        orgId: member.orgId,
        userId: member.userId,
        workflowId: member.workflowId,
      },
      context.signal,
    );
    const done = settleIncludingAbort(held.done);
    onTestFinished(async () => {
      held.release();
      await done;
    });
    return held;
  }

  async function waitForWaiters(
    held: {
      readonly waiters: () => Promise<
        readonly WorkflowAutomationThreadLockWaiter[]
      >;
    },
    count: number,
  ) {
    await expect
      .poll(
        async () => {
          return (await held.waiters()).length;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(count);
    return (await held.waiters()).map((waiter) => {
      return waiter.query.toLowerCase();
    });
  }

  it("keeps a reused destination while a deletion waits for that same thread", async () => {
    const { member, chatThreadId } = await briefWithBoundThread();
    await clearChatThreadProvenanceFixture(chatThreadId);
    const held = await holdBinding(member);

    // Reuse parks on the binding lock already owning the destination row, so
    // the deletion has to wait for that row instead of holding it and queueing
    // here. Taking them the other way round deadlocked the two callers.
    const reusing = fireBindingTransaction(member);
    const reuseSettled = settleIncludingAbort(reusing);
    onTestFinished(async () => {
      held.release();
      await reuseSettled;
    });
    await waitForWaiters(held, 1);

    const deleting = deleteThread(chatThreadId);
    const deleteSettled = settleIncludingAbort(deleting);
    onTestFinished(async () => {
      held.release();
      await deleteSettled;
    });
    const waiting = await waitForWaiters(held, 2);

    held.release();
    await held.done;

    await expect(reusing).resolves.toBe(chatThreadId);
    await accept(deleting, [204]);

    // Both callers queued behind the same binding, and the one waiting on the
    // destination row was the deletion, not the reuse.
    expect(waiting).toHaveLength(2);
    expect(
      waiting.filter((statement) => {
        return statement.includes(BINDING_LOCK_STATEMENT);
      }),
    ).toHaveLength(1);
    expect(
      waiting.filter((statement) => {
        return statement.includes(THREAD_LOCK_STATEMENT);
      }),
    ).toHaveLength(1);

    await accept(readThread(chatThreadId), [404]);
    await expect(readBoundThread(member)).resolves.toBeNull();
  }, 60_000);

  it("rebinds a fresh excluded destination when the deletion wins that same thread", async () => {
    const { member, chatThreadId } = await briefWithBoundThread();
    const held = await holdBinding(member);

    // Deletion owns the destination first here, so reuse waits for it and then
    // revalidates the binding instead of resurrecting the deleted thread.
    const deleting = deleteThread(chatThreadId);
    const deleteSettled = settleIncludingAbort(deleting);
    onTestFinished(async () => {
      held.release();
      await deleteSettled;
    });
    await waitForWaiters(held, 1);

    const reusing = fireBindingTransaction(member);
    const reuseSettled = settleIncludingAbort(reusing);
    onTestFinished(async () => {
      held.release();
      await reuseSettled;
    });
    const waiting = await waitForWaiters(held, 2);

    held.release();
    await held.done;

    await accept(deleting, [204]);
    const rebound = await reusing;
    expect(rebound).not.toBe(chatThreadId);

    expect(waiting).toHaveLength(2);
    expect(
      waiting.filter((statement) => {
        return statement.includes(THREAD_LOCK_STATEMENT);
      }),
    ).toHaveLength(1);

    await accept(readThread(chatThreadId), [404]);
    await accept(readThread(rebound), [200]);
    await expect(readBoundThread(member)).resolves.toBe(rebound);
    await expect(readChatThreadProvenanceFixture(rebound)).resolves.toBe(
      "morning_brief",
    );
  }, 60_000);

  it("resolves one destination when two fires race an empty binding", async () => {
    const member = await seedMorningBriefChatMemberFixture();
    authenticate(member);

    const [first, second] = await Promise.all([
      fireBindingTransaction(member),
      fireBindingTransaction(member),
    ]);

    expect(second).toBe(first);
    await expect(readBoundThread(member)).resolves.toBe(first);
    await expect(readChatThreadProvenanceFixture(first)).resolves.toBe(
      "morning_brief",
    );
    await accept(readThread(first), [200]);
  }, 60_000);

  it("leaves another owner's destination and binding untouched", async () => {
    const { member, chatThreadId } = await briefWithBoundThread();
    const neighbour = await briefWithBoundThread();
    const held = await holdBinding(member);

    const reusing = fireBindingTransaction(member);
    const reuseSettled = settleIncludingAbort(reusing);
    onTestFinished(async () => {
      held.release();
      await reuseSettled;
    });
    await waitForWaiters(held, 1);

    // The neighbour's own reuse and deletion never queue behind this binding.
    authenticate(neighbour.member);
    await expect(fireBindingTransaction(neighbour.member)).resolves.toBe(
      neighbour.chatThreadId,
    );
    await accept(deleteThread(neighbour.chatThreadId), [204]);
    await accept(readThread(neighbour.chatThreadId), [404]);
    await expect(readBoundThread(neighbour.member)).resolves.toBeNull();

    held.release();
    await held.done;
    await expect(reusing).resolves.toBe(chatThreadId);

    authenticate(member);
    await accept(readThread(chatThreadId), [200]);
    await expect(readBoundThread(member)).resolves.toBe(chatThreadId);
    await expect(readChatThreadProvenanceFixture(chatThreadId)).resolves.toBe(
      "morning_brief",
    );
  }, 60_000);

  it("leaves no exclusion behind when the producer rolls back", async () => {
    const { member, chatThreadId } = await briefWithBoundThread();
    await clearChatThreadProvenanceFixture(chatThreadId);

    const producerFailure = new Error("producer rolled back");
    await expect(
      store.set(writeDb$).transaction(async (tx) => {
        await ensureWorkflowUserAutomationThread(tx, {
          orgId: member.orgId,
          userId: member.userId,
          workflowId: member.workflowId,
          agentId: member.agentId,
          workflowTitle: "Okou Morning Brief",
          currentTime: nowDate(),
        });
        throw producerFailure;
      }),
    ).rejects.toBe(producerFailure);

    await expect(
      readChatThreadProvenanceFixture(chatThreadId),
    ).resolves.toBeNull();
    await expect(readBoundThread(member)).resolves.toBe(chatThreadId);
    await accept(readThread(chatThreadId), [200]);
  }, 60_000);
});
