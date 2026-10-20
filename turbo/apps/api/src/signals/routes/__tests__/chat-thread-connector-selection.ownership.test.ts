import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { connectorAccountRoutes } from "../connector-accounts";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);

describe("chat-thread connector account ownership", () => {
  it("rejects foreign owners and mismatched authorized targets without replacing selections", async () => {
    const app = setupApp({
      context,
      routes: [
        ...chatThreadCreateRoutes,
        ...chatThreadConnectorSelectionRoutes,
        ...connectorAccountRoutes,
      ],
    });
    const threads = app(chatThreadsContract);
    const selections = app(chatThreadConnectorSelectionContract);
    const accounts = app(connectorAccountsContract);
    const owner = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.ensurePersonalSubscriptionModel(owner);
    const agent = await bdd.createAgent(owner);
    const builtin = await connectors.connectManualGrant(
      owner,
      "openai",
      "api-token",
      { apiKey: "ownership-openai-key" },
      agent.agentId,
    );
    const definition = await connectors.createCustomConnector(
      owner,
      manualHttpCustomConnectorCreateBody({
        slug: `_ownership-${randomUUID()}`,
        displayName: "Selection ownership",
        prefixTemplates: ["https://ownership.example.test/"],
      }),
    );
    const custom = await connectors.setCustomConnectorValues(
      owner,
      definition.id,
      [{ key: "secret", kind: "secret", value: "ownership-custom-key" }],
    );
    if (!custom.connectedAccountId) {
      throw new Error("Expected the API-created custom connector account");
    }
    await connectors.updateAgentCustomConnectors(owner, agent.agentId, [
      definition.id,
    ]);

    const sameOrg = await connectors.connectManualGrant(
      bdd.user({ orgId: owner.orgId }),
      "openai",
      "api-token",
      { apiKey: "other-user-openai-key" },
    );
    const sameUser = await connectors.connectManualGrant(
      bdd.user({ userId: owner.userId }),
      "openai",
      "api-token",
      { apiKey: "other-org-openai-key" },
    );
    mocks.clerk.session(owner.userId, owner.orgId, owner.orgRole);
    const headers = { authorization: "Bearer clerk-session" };
    const builtinTarget = {
      kind: "builtin" as const,
      connectorSlug: "openai" as const,
    };
    const customTarget = {
      kind: "custom" as const,
      customConnectorId: definition.id,
    };
    const requested = [
      { connectionId: builtin.id, target: builtinTarget },
      { connectionId: custom.connectedAccountId, target: customTarget },
    ];
    const createBody = {
      agentId: agent.agentId,
      model: "claude-fable-5-1",
      connectorSelections: requested,
    };
    const created = await accept(
      threads.create({ headers, body: createBody }),
      [201],
    );
    const params = { id: created.body.id };
    const initial = await accept(selections.get({ headers, params }), [200]);
    expect(initial.body.selections).toHaveLength(2);
    expect(initial.body.selections).toStrictEqual(
      expect.arrayContaining(requested),
    );
    const accountResponses = await Promise.all(
      initial.body.selections.map(async (selection) => {
        const account = await accept(
          accounts.connection({
            headers,
            params: { connectionId: selection.connectionId },
            query: selection.target,
          }),
          [200],
        );
        return account.body;
      }),
    );
    expect(initial.body.selectedConnections).toStrictEqual(accountResponses);
    for (const selection of requested) {
      const updated = await accept(
        selections.update({ headers, params, body: selection }),
        [200],
      );
      expect(updated.body).toStrictEqual(selection);
    }

    const rejected = [
      { connectionId: sameOrg.id, target: builtinTarget },
      { connectionId: sameUser.id, target: builtinTarget },
      { connectionId: builtin.id, target: customTarget },
      { connectionId: custom.connectedAccountId, target: builtinTarget },
    ];
    const mismatch = {
      error: {
        code: "BAD_REQUEST",
        message: "Connector account does not match the requested target",
      },
    };
    for (const selection of rejected) {
      const deniedCreate = await accept(
        threads.create({
          headers,
          body: { ...createBody, connectorSelections: [selection] },
        }),
        [400],
      );
      expect(deniedCreate.body).toStrictEqual(mismatch);
      const deniedUpdate = await accept(
        selections.update({ headers, params, body: selection }),
        [400],
      );
      expect(deniedUpdate.body).toStrictEqual(mismatch);
      const retained = await accept(selections.get({ headers, params }), [200]);
      expect(retained.body).toStrictEqual(initial.body);
    }

    for (const actor of [
      bdd.user({ orgId: owner.orgId }),
      bdd.user({ userId: owner.userId }),
    ]) {
      mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const denied = await accept(selections.get({ headers, params }), [404]);
      const missing = await accept(
        selections.get({ headers, params: { id: randomUUID() } }),
        [404],
      );
      expect(denied.body).toStrictEqual(missing.body);
      expect(denied.body.error.message).toBe("Chat thread not found");

      const deniedUpdate = await accept(
        selections.update({
          headers,
          params,
          body: { connectionId: builtin.id, target: builtinTarget },
        }),
        [404],
      );
      const missingUpdate = await accept(
        selections.update({
          headers,
          params: { id: randomUUID() },
          body: { connectionId: builtin.id, target: builtinTarget },
        }),
        [404],
      );
      expect(deniedUpdate.body).toStrictEqual(missingUpdate.body);
      expect(deniedUpdate.body).toStrictEqual(missing.body);

      const deniedClear = await accept(
        selections.clear({ headers, params, body: builtinTarget }),
        [404],
      );
      const missingClear = await accept(
        selections.clear({
          headers,
          params: { id: randomUUID() },
          body: builtinTarget,
        }),
        [404],
      );
      expect(deniedClear.body).toStrictEqual(missingClear.body);
      expect(deniedClear.body).toStrictEqual(missing.body);
    }
    mocks.clerk.session(owner.userId, owner.orgId, owner.orgRole);
    const retained = await accept(selections.get({ headers, params }), [200]);
    expect(retained.body).toStrictEqual(initial.body);

    const renamed = await accept(
      accounts.rename({
        headers,
        params: { connectionId: builtin.id },
        body: { target: builtinTarget, displayName: "Selected work" },
      }),
      [200],
    );
    const refreshed = await accept(selections.get({ headers, params }), [200]);
    expect(refreshed.body).toStrictEqual({
      selections: initial.body.selections,
      selectedConnections: accountResponses.map((account) => {
        return account.id === builtin.id ? renamed.body : account;
      }),
    });

    const deleted = await accept(
      accounts.delete({
        headers,
        params: { connectionId: builtin.id },
        body: { target: builtinTarget },
      }),
      [200],
    );
    expect(deleted.body.deletedConnectionId).toBe(builtin.id);
    const remaining = await accept(selections.get({ headers, params }), [200]);
    expect(remaining.body).toStrictEqual({
      selections: [
        { connectionId: custom.connectedAccountId, target: customTarget },
      ],
      selectedConnections: accountResponses.filter((account) => {
        return account.id === custom.connectedAccountId;
      }),
    });
  });
});
