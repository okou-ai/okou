import { randomUUID } from "node:crypto";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsRoutes } from "../connectors";
import { connectorAccountRoutes } from "../connector-accounts";
import { mockAutomaticMcpOAuthProvider } from "./helpers/api-bdd-connectors";
import {
  automaticMcpCatalogFixture,
  buildAutomaticMcpCatalog,
  installAutomaticMcpCatalog,
} from "./helpers/connector-automatic-catalog";
import { createPublicAutomaticCatalog } from "./helpers/public-automatic-catalog";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const mocks = createRouteMocks(context);
const headers = { authorization: "Bearer clerk-session" } as const;
const routes = [
  ...builtinConnectorsAutomaticRoutes,
  ...builtinConnectorsRoutes,
  ...connectorAccountRoutes,
] as const;

function automatic() {
  return setupApp({ context, routes })(builtinConnectorAutomaticContract);
}

function accounts() {
  return setupApp({ context, routes })(connectorAccountsContract);
}

async function fixture(legacyCatalog = false) {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(actor.userId, actor.orgId);
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  const catalog = legacyCatalog
    ? await installAutomaticMcpCatalog()
    : automaticMcpCatalogFixture();
  onTestFinished(async () => {
    if (legacyCatalog) {
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", catalog.bucket);
    }
    mocks.clerk.session(actor.userId, actor.orgId);
    const result = await accept(
      accounts().connections({ headers, query: catalog.target }),
      [200],
    );
    for (const account of result.body.connections) {
      await accept(
        accounts().delete({
          headers,
          params: { connectionId: account.id },
          body: { target: catalog.target },
        }),
        [200],
      );
    }
  });
  return { ...actor, ...catalog };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function start(f: Fixture, connectionId?: string) {
  return automatic().start({
    headers,
    params: { connectorSlug: f.slug },
    body: {
      authMethod: f.methodId,
      account: connectionId
        ? { intent: "reconnect", connectionId }
        : { intent: "add" },
    },
  });
}

async function oauthStart(f: Fixture, connectionId?: string) {
  const response = await accept(start(f, connectionId), [200]);
  if (response.body.result !== "authorization") {
    throw new Error("Expected OAuth authorization");
  }
  const state = new URL(response.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  return { state, attemptId: response.body.oauthAttemptId };
}

async function callback(state: string, issuer: string) {
  return await accept(
    automatic().callback({
      query: {
        state,
        iss: issuer,
        code: "authorized-code",
        responseMode: "json",
      },
    }),
    [200],
  );
}

function receipt(f: Fixture, attemptId: string) {
  return accounts().oauthCompletion({
    headers,
    params: { attemptId },
    query: f.target,
  });
}

describe("builtin Automatic account and consent ownership", () => {
  it("completes consent after a trusted catalog endpoint changes", async () => {
    const f = createPublicAutomaticCatalog(context, { isolatePg: true });
    await f.run(async () => {
      await f.publish();
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: "cimd",
      });
      const started = await oauthStart(f);
      await f.publish(
        buildAutomaticMcpCatalog({
          slug: f.slug,
          methodId: f.methodId,
          endpoint: "https://replacement.example.test/mcp",
        }).catalog,
      );
      expect((await callback(started.state, provider.issuer)).body.status).toBe(
        "success",
      );
      const completion = await accept(receipt(f, started.attemptId), [200]);
      expect(
        (
          await accept(
            accounts().connections({ headers, query: f.target }),
            [200],
          )
        ).body.connections,
      ).toContainEqual(
        expect.objectContaining({
          id: completion.body.connectionId,
          connectionStatus: "connected",
        }),
      );
    });
  });
});
