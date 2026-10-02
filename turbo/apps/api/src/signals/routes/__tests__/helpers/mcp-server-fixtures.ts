import { randomUUID } from "node:crypto";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { testChatEventSnapshotContract } from "@okouai/api-contracts/contracts/test-chat-event-snapshot";
import { testChatEventSearchProjectionContract } from "@okouai/api-contracts/contracts/test-chat-event-search-projection";
import { onTestFinished } from "vitest";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../../lib/env";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { testChatEventSnapshotRoutes } from "../../test-chat-event-snapshot";
import { testChatEventSearchProjectionRoutes } from "../../test-chat-event-search-projection";
import { createBddApi } from "./api-bdd";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { createChatCallbacksApi } from "./api-bdd-chat-callbacks";
import { createRunsApi } from "./api-bdd-runs";
import { createChatEventsFixture } from "./chat-events-fixture";
import { createMcpServerTestApi } from "./mcp-server";

/**
 * Run-status, cancellation and search scenarios drive chat runs through the
 * native Runner claim protocol. Fable stays off Pi, while the fixture's
 * default Sonnet 5 route now executes API-first.
 */
export const NATIVE_RUNNER_MODEL = "claude-fable-5-1";

export function createMcpServerFixtures(context: TestContext) {
  const { fixture } = createMcpServerTestApi(context);

  async function projectSearchMessages(threadIds: string[]) {
    await accept(
      setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
        testChatEventSearchProjectionContract,
      ).project({ body: { chat_thread_ids: threadIds } }),
      [200],
    );
  }

  async function messageFixture() {
    const f = await threadFixture();
    await createRunsApi(context).ensureOrgModelProvider(f.actor);
    async function send(
      prompt: string,
      threadId?: string,
      userMessage?: UserMessageDocument,
    ) {
      const clientEventId = randomUUID();
      const response = await f.chat.requestSendEvent(
        f.actor,
        {
          agentId: f.agent.agentId,
          prompt,
          threadId,
          userMessage,
          clientEventId,
        },
        [201],
      );
      if (response.status !== 201) {
        throw new Error("Expected an accepted canonical message");
      }
      // A send only enqueues; the background pick rejects this no-credit input
      // without a run. Finish it so later reads, including reads after the
      // history moves into a snapshot, see the rejection.
      await flushWaitUntilForTest();
      return response.body;
    }
    return { ...f, send };
  }

  async function snapshotMessages(threadId: string) {
    await accept(
      setupApp({ context, routes: testChatEventSearchProjectionRoutes })(
        testChatEventSearchProjectionContract,
      ).project({ body: { chat_thread_ids: [threadId] } }),
      [200],
    );
    await accept(
      setupApp({ context, routes: testChatEventSnapshotRoutes })(
        testChatEventSnapshotContract,
      ).snapshot({ body: { chat_thread_ids: [threadId], r2_object_keys: [] } }),
      [200],
    );
  }

  async function threadFixture() {
    const auth = await fixture();
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const actor = bdd.user({ userId: auth.userId, orgId: auth.orgId });
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {
      displayName: "MCP discovery agent",
      visibility: "private",
    });
    return { auth, actor, agent, bdd, chat };
  }

  async function nativeRunnerChatActor(
    f: ReturnType<typeof createChatEventsFixture>,
    auth: { readonly userId: string; readonly orgId: string },
  ) {
    const actor = await f.entitledChatActor({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    await f.api.updateOrgModelPolicies(actor.actor, [
      {
        model: NATIVE_RUNNER_MODEL,
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: actor.providerId,
      },
    ]);
    return actor;
  }

  async function assistantMessagesFixture(
    prompt: string,
    messages: readonly string[],
  ) {
    const auth = fixture();
    const f = createChatEventsFixture(context);
    const actor = await nativeRunnerChatActor(f, auth);
    const sent = await f.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      model: NATIVE_RUNNER_MODEL,
      prompt,
    });
    onTestFinished(async () => {
      await f.cancelChatRun(actor.actor, sent.runId);
    });
    const claimed = await f.claimChatRun(actor.runnerGroup, sent.runId);
    await f.webhooks.requestAgentEvents(
      {
        runId: sent.runId,
        events: messages.map((text, sequenceNumber) => {
          return {
            type: "assistant",
            sequenceNumber,
            message: { content: [{ type: "text", text }] },
          };
        }),
      },
      claimed.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    return {
      auth,
      actor: actor.actor,
      chat: f.chat,
      threadId: sent.threadId,
      runId: sent.runId,
    };
  }

  async function chatRunFixture() {
    const auth = await fixture();
    const bdd = createBddApi(context);
    const chat = createChatFilesBddApi(context);
    const actor = bdd.user({ userId: auth.userId, orgId: auth.orgId });
    const runs = createRunsApi(context);
    const callbacks = createChatCallbacksApi(context);
    runs.configureRunnerGroup();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    callbacks.acceptChatObjectStorage();
    callbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor, { model: NATIVE_RUNNER_MODEL });
    const agent = await bdd.createAgent(actor, {
      displayName: "MCP activity agent",
      visibility: "private",
    });
    return { auth, actor, chat, agent, runs };
  }

  async function creationFixture(options: { withDefaultAgent?: boolean } = {}) {
    const f = await threadFixture();
    const runs = createRunsApi(context);
    const defaultAgentId = options.withDefaultAgent
      ? await f.bdd.bootstrapLimitedFreeOnboarding(f.actor, {
          displayName: "MCP default Agent",
        })
      : null;
    if (defaultAgentId) {
      await runs.grantProEntitlement(f.actor);
    }
    const { providerId } = await runs.ensureOrgModelProvider(f.actor);
    await runs.updateOrgModelPolicies(
      f.actor,
      (["claude-sonnet-5", "claude-opus-5"] as const).map((model) => {
        return {
          model,
          preferred: model === "claude-sonnet-5",
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        };
      }),
    );
    return { ...f, runs, providerId, defaultAgentId };
  }

  return {
    projectSearchMessages,
    messageFixture,
    snapshotMessages,
    threadFixture,
    nativeRunnerChatActor,
    assistantMessagesFixture,
    chatRunFixture,
    creationFixture,
  };
}
