import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadRoutes } from "../chat-threads";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const { api, chat, connectors, cancelChatRun, sessionHeaders } =
  createChatEventsFixture(context);
function selectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

describe("thread connector selection", () => {
  it("keeps active Run accounts and uses an allowed replacement for queued input", async () => {
    const {
      actor,
      run: own,
      sendChatRun,
      sendWaitingChatInput,
      runExecution,
    } = await publicChatActor(context);
    await own(() => {
      return api.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    const defaultConnection = await own(() => {
      return connectors.connectManualGrant(actor, "openai", "api-token", {
        apiKey: "thread-openai-key",
      });
    });
    const connection = await own(() => {
      return connectors.connectManualGrant(
        actor,
        "openai",
        "api-token",
        { apiKey: "thread-selected-openai-key" },
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
      return connectors.connectManualGrant(actor, "runtime", "api-token", {
        apiKey: "thread-runtime-key",
      });
    });
    const thread = await own(() => {
      return chat.createThread(actor, {
        title: "Selected connector thread",
      });
    });
    const access = setupApp({ context, routes: chatConnectorAccessRoutes })(
      chatConnectorAccessContract,
    );
    const openAITarget = { kind: "builtin", connectorSlug: "openai" } as const;
    await own(() => {
      return accept(
        access.setThreadCurrent({
          headers: sessionHeaders(actor),
          params: { threadId: thread.id },
          body: {
            connectionId: connection.id,
            target: openAITarget,
          },
        }),
        [200],
      );
    });
    await own(() => {
      return accept(
        access.setThreadCurrent({
          headers: sessionHeaders(actor),
          params: { threadId: thread.id },
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
        target: openAITarget,
      },
      {
        connectionId: runtimeConnection.id,
        target: { kind: "builtin", connectorSlug: "runtime" },
      },
    ]);
    const run = await sendChatRun(actor, {
      threadId: thread.id,
      prompt: "Continue with the selected connections",
    });
    expect(run.threadId).toBe(thread.id);
    const execution = await runExecution(run.runId);
    expect(execution.execution.environment).toMatchObject({
      OPENAI_TOKEN: expect.stringMatching(/.+/),
      RUNTIME_API_KEY: expect.stringMatching(/.+/),
    });
    for (const key of ["thread-selected-openai-key", "thread-runtime-key"]) {
      expect(JSON.stringify(execution.execution)).not.toContain(key);
    }
    expect(
      execution.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({
      sourceType: "connector",
      sourceId: connection.id,
    });
    expect(
      execution.execution.secretConnectorMetadataMap?.RUNTIME_API_KEY,
    ).toMatchObject({
      sourceType: "connector",
      sourceId: runtimeConnection.id,
    });
    const selectedAuth = await own(() => {
      return createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${execution.execution.firewallToken}` },
        {
          secretConnectorMap:
            execution.execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.execution.secretConnectorMetadataMap ?? undefined,
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
            "X-Runtime-Key": secretTemplate("RUNTIME_API_KEY"),
          },
        },
        [200],
      );
    });
    expect(selectedAuth.body).toMatchObject({
      headers: {
        Authorization: "Bearer thread-selected-openai-key",
        "X-Runtime-Key": "thread-runtime-key",
      },
    });
    // The active run keeps its own account snapshot, but queued input must
    // observe thread selections during its later successful preparation.
    const waiting = await sendWaitingChatInput(actor, {
      threadId: thread.id,
      prompt: "Use the account allowed when this queued input is picked",
    });
    const override = await own(() => {
      return accept(
        access.setThreadOverride({
          headers: sessionHeaders(actor),
          params: { threadId: thread.id, connectionId: connection.id },
          body: { target: openAITarget, enabled: false },
        }),
        [200],
      );
    });
    expect(override.body.currentConnectionId).toBe(defaultConnection.id);
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
      { connectionId: defaultConnection.id, target: openAITarget },
      {
        connectionId: runtimeConnection.id,
        target: { kind: "builtin", connectorSlug: "runtime" },
      },
    ]);
    await own(() => {
      return connectors.connectManualGrant(
        actor,
        "runtime",
        "api-token",
        { apiKey: "thread-runtime-key-updated" },
        { intent: "reconnect", connectionId: runtimeConnection.id },
      );
    });
    await own(() => {
      return cancelChatRun(actor, run.runId, execution.sandboxHeaders);
    });
    const promoted = await own(() => {
      return waiting.launchedRun();
    });
    expect(promoted.threadId).toBe(thread.id);
    const next = await runExecution(promoted.runId);
    expect(next.execution.environment).toMatchObject({
      OPENAI_TOKEN: expect.stringMatching(/.+/),
      RUNTIME_API_KEY: expect.stringMatching(/.+/),
    });
    for (const key of ["thread-openai-key", "thread-runtime-key-updated"]) {
      expect(JSON.stringify(next.execution)).not.toContain(key);
    }
    expect(
      next.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({
      sourceType: "connector",
      sourceId: defaultConnection.id,
    });
    expect(
      next.execution.secretConnectorMetadataMap?.RUNTIME_API_KEY,
    ).toMatchObject({
      sourceType: "connector",
      sourceId: runtimeConnection.id,
    });
    const promotedAuth = await own(() => {
      return createFirewallApi(context).requestFirewallAuth(
        { authorization: `Bearer ${next.execution.firewallToken}` },
        {
          secretConnectorMap: next.execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            next.execution.secretConnectorMetadataMap ?? undefined,
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
            "X-Runtime-Key": secretTemplate("RUNTIME_API_KEY"),
          },
        },
        [200],
      );
    });
    expect(promotedAuth.body).toMatchObject({
      headers: {
        Authorization: "Bearer thread-openai-key",
        "X-Runtime-Key": "thread-runtime-key-updated",
      },
    });
    await own(() => {
      return cancelChatRun(actor, promoted.runId, next.sandboxHeaders);
    });
  });
});
