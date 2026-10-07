import { beforeEach, afterEach, describe, expect, it } from "vitest";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createPublicFirewallConnections } from "./helpers/public-firewall-connections";
import {
  API_TEST_CONNECTOR_CATALOG,
  catalogWithAuthMethod,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";

/**
 * HOOK-02 / FW: firewall auth template resolution and connector refresh
 * through POST /api/webhooks/agent/firewall/auth.
 *
 * Given state is constructed through public routes. The narrow test-only
 * connector credential state route is used only for persisted metadata that
 * an old deployment can leave behind but no production API exposes.
 *
 * Unreachable through public APIs (kept out of this file deliberately):
 * - TOKEN_ACCESS_RESOLUTION_FAILED needs a current token whose backing secret
 *   row is missing; public seeding writes both atomically.
 * - The 402/5s low-credit billable lease needs a public API that drains an
 *   org's credits below the threshold while keeping the tier active.
 */

const context = testContext();

beforeEach(async () => {
  await setupApp({ context, routes: [], isolatePg: true });
});

const publicConnections = createPublicFirewallConnections(context);

async function exactSecretConnectorSources(
  actor: ApiTestUser,
  sources: Readonly<Record<string, ConnectorSlug>>,
  platformSecretNames: readonly string[] = [],
): Promise<{
  readonly secretConnectorMap: Readonly<Record<string, ConnectorSlug>>;
  readonly secretConnectorMetadataMap: Readonly<
    Record<
      string,
      | { readonly sourceType: "connector"; readonly sourceId: string }
      | { readonly sourceType: "platform-secret" }
    >
  >;
}> {
  const connectors = createConnectorBddApi(context);
  const entries = await Promise.all(
    Object.entries(sources).map(async ([secretName, connectorSlug]) => {
      const metadata = !platformSecretNames.includes(secretName)
        ? {
            sourceType: "connector" as const,
            sourceId: (
              await connectors.readConnectorBySlug(actor, connectorSlug)
            ).id,
          }
        : { sourceType: "platform-secret" as const };
      return [secretName, { connectorSlug, metadata }] as const;
    }),
  );
  return {
    secretConnectorMap: Object.fromEntries(
      entries.map(([secretName, source]) => {
        return [secretName, source.connectorSlug];
      }),
    ),
    secretConnectorMetadataMap: Object.fromEntries(
      entries.map(([secretName, source]) => {
        return [secretName, source.metadata];
      }),
    ),
  };
}

describe("FW-4: connector refresh and replacement snapshots", () => {
  afterEach(publicConnections.cleanup);

  it("does not call the provider for a known storage version mismatch", async () => {
    const fw = createFirewallApi(context);
    const connectors = createConnectorBddApi(context);
    const catalog = createPublicConnectorCatalog(context);
    const versionTwo = catalogWithAuthMethod(
      { connectorSlug: "test-oauth", authMethodId: "oauth" },
      (method) => {
        return { ...method, storage: { ...method.storage, version: 2 } };
      },
    );
    await catalog.publish(versionTwo);
    const { actor, headers } = await publicConnections.run();
    catalog.onCleanup(async () => {
      await publicConnections.cleanup();
      await catalog.publish(versionTwo);
      await connectors.deleteDefaultBuiltinConnectorAccount(
        actor,
        "test-oauth",
      );
      await connectors.deleteFeatureSwitches(actor);
    });
    await publicConnections.testOAuth(actor, {
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresIn: -60,
    });
    // Publishing changes the selected method, not the account's stored version.
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);
    let providerCalls = 0;
    fw.mockTestOauthTokenRefresh(() => {
      providerCalls += 1;
      return fw.oauthTokenResponse({
        accessToken: "must-not-be-written",
        expiresIn: 3600,
      });
    });

    const response = await fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({
          TEST_OAUTH_TOKEN: "stale-access",
        }),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
        },
        ...(await exactSecretConnectorSources(actor, {
          TEST_OAUTH_TOKEN: "test-oauth",
        })),
      },
      [424],
    );
    if (response.status !== 424) {
      throw new Error("Expected mismatched storage version to be unavailable");
    }
    expect(response.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
    expect(providerCalls).toBe(0);
    await catalog.cleanup();
  });
});
