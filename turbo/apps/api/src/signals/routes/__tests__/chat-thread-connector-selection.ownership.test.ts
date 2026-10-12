import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
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
    const app = await setupApp({
      context,
      routes: [
        ...chatThreadCreateRoutes,
        ...chatThreadConnectorSelectionRoutes,
      ],
      isolatePg: true,
    });
    const threads = app(chatThreadsContract);
    const selections = app(chatThreadConnectorSelectionContract);
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
      expect(retained.body.selections).toStrictEqual(initial.body.selections);
    }
  });
});
