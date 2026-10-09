import { randomUUID } from "node:crypto";

import {
  connectorCheckContract,
  type ConnectorCheckRequestBody,
} from "@okouai/api-contracts/contracts/connector-check";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorCheckRoutes } from "../connector-check";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);

async function check(actor: ApiTestUser, body: ConnectorCheckRequestBody) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return await accept(
    setupApp({ context, routes: connectorCheckRoutes })(
      connectorCheckContract,
    ).check({ headers: { authorization: "Bearer clerk-session" }, body }),
    [200],
  );
}

beforeEach(() => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
});

describe("stored Connector diagnostic account selection", () => {
  it("keeps missing builtin groups unresolved despite a connected custom account", async () => {
    const actor = bdd.user();
    mockClerkMembership(context, actor, "org:admin");
    const host = `${randomUUID()}.reap.example.test`;
    const customBody = manualHttpCustomConnectorCreateBody({
      displayName: "Custom diagnostic account",
      prefixTemplates: ["https://{{variables.host}}/v1/"],
    });
    const custom = await connectorsApi.createCustomConnector(actor, {
      ...customBody,
      fields: [
        ...customBody.fields,
        { key: "host", label: "Host", kind: "variable", required: true },
      ],
    });
    onTestFinished(async () => {
      await connectorsApi.deleteCustomConnector(actor, custom.id, [204]);
    });
    await connectorsApi.setCustomConnectorValues(actor, custom.id, [
      { key: "secret", kind: "secret", value: "custom-diagnostic-secret" },
      { key: "host", kind: "variable", value: host },
    ]);

    const missing = await check(actor, {
      mode: "url",
      method: "GET",
      url: `https://${host}/v1/users`,
      connectorSlug: "reap",
    });
    expect(missing.body).toMatchObject({
      outcome: "unresolved-dynamic-base",
      connector: { connectorSlug: "reap" },
    });
    const customTarget = await check(actor, {
      mode: "url",
      method: "GET",
      url: `https://${host}/v1/users`,
      target: { kind: "custom", customConnectorId: custom.id },
    });
    expect(customTarget.body).toStrictEqual({
      outcome: "no-match",
      scope: "catalog",
    });
    const staticConnector = await check(actor, {
      mode: "url",
      method: "GET",
      url: "https://api.github.com/repos/okou-ai/okou",
    });
    expect(staticConnector.body).toMatchObject({
      outcome: "resolved",
      connector: { connectorSlug: "github" },
      run: { status: "not-scoped" },
    });
  });

  it("uses only the selected default account and follows public account changes", async () => {
    const actor = bdd.user();
    mockClerkMembership(context, actor, "org:admin");
    const bases = [
      `https://${randomUUID()}.reap.example.test/v1`,
      `https://${randomUUID()}.reap.example.test/v1`,
    ];
    const accounts: { readonly id: string }[] = [];
    for (const base of bases) {
      const account = await connectorsApi.connectManualGrant(
        actor,
        "reap",
        "api-token",
        { apiKey: `secret-${randomUUID()}`, apiBaseUrl: base },
      );
      accounts.push(account);
      onTestFinished(async () => {
        await connectorsApi.deleteBuiltinConnectorAccount(
          actor,
          "reap",
          account.id,
        );
      });
    }
    async function diagnostic(base: string) {
      return await check(actor, {
        mode: "url",
        method: "GET",
        url: `${base}/users`,
        connectorSlug: "reap",
      });
    }
    for (const [index, selected] of accounts.entries()) {
      await connectorsApi.setDefaultBuiltinConnectorAccount(
        actor,
        "reap",
        selected.id,
      );
      for (const [baseIndex, base] of bases.entries()) {
        const response = await diagnostic(base);
        if (baseIndex === index) {
          expect(response.body).toMatchObject({
            outcome: "resolved",
            connector: { connectorSlug: "reap" },
            base,
            relativePath: "/users",
            run: { status: "not-scoped" },
          });
        } else {
          expect(response.body).toStrictEqual({
            outcome: "no-match",
            scope: "catalog",
          });
        }
        expect(JSON.stringify(response.body)).not.toContain(selected.id);
      }
    }
  });
});
