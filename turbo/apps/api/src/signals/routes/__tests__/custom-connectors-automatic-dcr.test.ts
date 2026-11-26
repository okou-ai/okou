import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

const LIFETIME_SECONDS = 600;

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return state;
}

/** The provider at `time` issues each registration a secret that lives ten minutes. */
function providerAt(endpoint: string, time: number) {
  mockNow(time);
  return mockAutomaticMcpOAuthProvider(context, {
    registration: "dcr",
    authentication: "oauth",
    endpoint,
    dcrClientSecretExpiresAt: Math.floor(time / 1000) + LIFETIME_SECONDS,
  });
}

/** An admin with an automatic DCR MCP connector and no connected accounts. */
async function automaticDcrConnector() {
  const start = now();
  const endpoint = `https://automatic-mcp-${randomUUID()}.example.test/server`;
  const first = providerAt(endpoint, start);
  const admin = bdd.user();
  const connector = await connectors.createCustomConnector(admin, {
    kind: "mcp",
    displayName: "Automatic research",
    endpoint: first.endpoint,
    transport: "streamable-http",
    authMode: "automatic",
    fields: [],
    headerInjections: [],
    queryInjections: [],
  });
  return { start, endpoint, first, admin, connector };
}

describe("Custom Automatic OAuth DCR retirement", () => {
  it("custom-connectors-automatic-dcr-001 (1/3) registers once on the first start without linking an account", async () => {
    const { first, admin, connector } = await automaticDcrConnector();

    await connectors.startCustomConnectorOAuth2(admin, connector.id);

    expect(first.registrationBodies).toHaveLength(1);
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toStrictEqual([]);
  });

  it("custom-connectors-automatic-dcr-001 (2/3) replaces the expired first registration once without linking an account", async () => {
    const { start, endpoint, admin, connector } = await automaticDcrConnector();
    await connectors.startCustomConnectorOAuth2(admin, connector.id);

    const replacement = providerAt(
      endpoint,
      start + (LIFETIME_SECONDS + 1) * 1000,
    );
    await connectors.startCustomConnectorOAuth2(admin, connector.id);
    expect(replacement.registrationBodies).toHaveLength(1);
    await expect(
      connectors.listCustomConnectorAccounts(admin, connector.id),
    ).resolves.toStrictEqual([]);
  });

  it("custom-connectors-automatic-dcr-001 (3/3) replaces the second registration once and connects on completion", async () => {
    const { start, endpoint, first, admin, connector } =
      await automaticDcrConnector();
    await connectors.startCustomConnectorOAuth2(admin, connector.id);
    const replacement = providerAt(
      endpoint,
      start + (LIFETIME_SECONDS + 1) * 1000,
    );
    await connectors.startCustomConnectorOAuth2(admin, connector.id);

    const final = providerAt(
      endpoint,
      start + (LIFETIME_SECONDS * 2 + 2) * 1000,
    );
    const authorizationUrl = await connectors.startCustomConnectorOAuth2(
      admin,
      connector.id,
    );
    expect(final.registrationBodies).toHaveLength(1);
    expect(first.registrationBodies).toHaveLength(1);
    expect(replacement.registrationBodies).toHaveLength(1);
    const completed =
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        state: stateOf(authorizationUrl),
        code: `code-${randomUUID()}`,
        iss: final.issuer,
      });
    expect(completed.body.status).toBe("success");
    const accounts = await connectors.listCustomConnectorAccounts(
      admin,
      connector.id,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      connectionStatus: "connected",
      reconnectReason: null,
    });
  });
});
