import { randomUUID } from "node:crypto";

import { builtinConnectorScopeDiffContract } from "@okouai/api-contracts/contracts/connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import {
  API_TEST_CONNECTOR_CATALOG,
  catalogWithAuthMethod,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";
import { builtinConnectorsRoutes } from "../connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);

describe("GET /api/connectors/:connectorSlug/scope-diff", () => {
  it("returns 404 when the stored connector runtime method is unavailable", async () => {
    const actor = bdd.user();
    if (actor.orgId === null) {
      throw new Error("Expected test actor organization");
    }
    const catalog = createPublicConnectorCatalog(context);
    const available = catalogWithAuthMethod(
      { connectorSlug: "openai", authMethodId: "api-token" },
      (method) => {
        return { ...method, id: "unavailable-method" };
      },
    );
    await catalog.publish(available);
    await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "unavailable-method",
      {
        apiKey: "unavailable-method-secret",
      },
    );
    catalog.onCleanup(async () => {
      await catalog.publish(available);
      await connectorsApi.deleteDefaultBuiltinConnectorAccount(actor, "openai");
    });
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);

    const response = await connectorsApi.requestScopeDiff(
      actor,
      "openai",
      [404],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_FOUND");
    await catalog.cleanup();
  });
});
