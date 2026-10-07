import { randomUUID } from "node:crypto";
import { builtinConnectorAutomaticContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
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

beforeEach(async () => {
  await setupApp({
    context,
    routes: builtinConnectorsAutomaticRoutes,
    isolatePg: true,
  });
});

const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...builtinConnectorsAutomaticRoutes,
  ...builtinConnectorsSlugCallbackRoutes,
  ...connectorAccountRoutes,
]);

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
    const existing = await accept(
      accounts().connections({ headers, query: catalog.target }),
      [200],
    );
    for (const account of existing.body.connections) {
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
  return { ...catalog, ...actor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function begin(f: Fixture, connectionId?: string) {
  return await accept(
    automatic().start({
      headers,
      params: { connectorSlug: f.slug },
      body: {
        authMethod: f.methodId,
        account: connectionId
          ? { intent: "reconnect", connectionId }
          : { intent: "add" },
      },
    }),
    [200],
  );
}

async function beginOAuth(f: Fixture, connectionId?: string) {
  const response = await begin(f, connectionId);
  if (response.body.result !== "authorization") {
    throw new Error("Expected authorization handoff");
  }
  const url = new URL(response.body.authorizationUrl);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected authorization state");
  }
  return { ...response.body, url, state };
}

async function callback(state: string, issuer: string) {
  return await accept(
    automatic().callback({
      query: {
        state,
        code: "authorized-code",
        iss: issuer,
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

describe("builtin MCP automatic authentication", () => {
  it("rejects an in-flight callback when its catalog storage contract changes", async () => {
    const f = createPublicAutomaticCatalog(context);
    await f.run(async () => {
      await f.publish();
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: "cimd",
      });
      const started = await beginOAuth(f);
      await f.publish(
        buildAutomaticMcpCatalog({
          slug: f.slug,
          methodId: f.methodId,
          storageVersion: 2,
        }).catalog,
      );
      expect((await callback(started.state, provider.issuer)).body.status).toBe(
        "error",
      );
      await accept(receipt(f, started.oauthAttemptId), [404]);
      expect(
        (
          await accept(
            accounts().connections({ headers, query: f.target }),
            [200],
          )
        ).body.connections,
      ).toStrictEqual([]);
    });
  });
});
