import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadRoutes } from "../chat-threads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const runs = createRunsApi(context);
const { api, chat, connectors, cancelChatRun, sessionHeaders } =
  createChatEventsFixture(context);
function selectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

describe("thread connector selection", () => {
  it("retains both selected accounts for a Run and clears only the requested selection", async () => {
    const {
      actor,
      agentId,
      runnerGroup,
      run: own,
      sendChatRun,
      claimChatRun,
    } = await publicChatActor(context);
    await own(() => {
      return api.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    const defaultConnection = await own(() => {
      return connectors.connectManualGrant(
        actor,
        "openai",
        "api-token",
        { apiKey: "thread-openai-key" },
        agentId,
      );
    });
    const connection = await own(() => {
      return connectors.connectManualGrant(
        actor,
        "openai",
        "api-token",
        { apiKey: "thread-selected-openai-key" },
        agentId,
        { intent: "add", displayName: "Selected sibling" },
      );
    });
    const accounts = await own(() => {
      return connectors.listBuiltinConnectorAccounts(actor, "openai");
    });
    expect(
      accounts.find((account) => {
        return account.id === defaultConnection.id;
      }),
    ).toMatchObject({ isDefault: true });
    expect(
      accounts.find((account) => {
        return account.id === connection.id;
      }),
    ).toMatchObject({ isDefault: false });
    const runtimeConnection = await own(() => {
      return connectors.connectManualGrant(
        actor,
        "runtime",
        "api-token",
        { apiKey: "thread-runtime-key" },
        agentId,
      );
    });
    const thread = await own(() => {
      return chat.createThread(actor, {
        agentId,
        title: "Selected connector thread",
      });
    });
    await own(() => {
      return accept(
        selectionsClient().update({
          headers: sessionHeaders(actor),
          params: { id: thread.id },
          body: {
            connectionId: connection.id,
            target: { kind: "builtin", connectorSlug: "openai" },
          },
        }),
        [200],
      );
    });
    await own(() => {
      return accept(
        selectionsClient().update({
          headers: sessionHeaders(actor),
          params: { id: thread.id },
          body: {
            connectionId: runtimeConnection.id,
            target: { kind: "builtin", connectorSlug: "runtime" },
          },
        }),
        [200],
      );
    });
    const selections = await own(() => {
      return accept(
        selectionsClient().get({
          headers: sessionHeaders(actor),
          params: { id: thread.id },
        }),
        [200],
      );
    });
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: connection.id,
        target: { kind: "builtin", connectorSlug: "openai" },
      },
      {
        connectionId: runtimeConnection.id,
        target: { kind: "builtin", connectorSlug: "runtime" },
      },
    ]);
    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Continue with the selected connections",
    });
    expect(run.threadId).toBe(thread.id);
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const targets = [
      {
        kind: "builtin" as const,
        connectorSlug: "openai",
        sourceId: connection.id,
      },
      {
        kind: "builtin" as const,
        connectorSlug: "runtime",
        sourceId: runtimeConnection.id,
      },
    ];
    for (const target of targets) {
      expect(claimed.claim.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining(target),
      );
    }
    const synced = await own(() => {
      return runs.syncConnectorRuntime(run.runId, { targets });
    });
    expect(
      synced.map(({ target, state }) => {
        return { target, state };
      }),
    ).toStrictEqual([
      {
        target: { kind: "builtin", connectorSlug: "openai" },
        state: "available",
      },
      {
        target: { kind: "builtin", connectorSlug: "runtime" },
        state: "available",
      },
    ]);
    await own(() => {
      return accept(
        selectionsClient().clear({
          headers: sessionHeaders(actor),
          params: { id: thread.id },
          body: { kind: "builtin", connectorSlug: "openai" },
        }),
        [204],
      );
    });
    const remaining = await own(() => {
      return accept(
        selectionsClient().get({
          headers: sessionHeaders(actor),
          params: { id: thread.id },
        }),
        [200],
      );
    });
    expect(remaining.body.selections).toStrictEqual([
      {
        connectionId: runtimeConnection.id,
        target: { kind: "builtin", connectorSlug: "runtime" },
      },
    ]);
    await own(() => {
      return cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    });
  });
});
