import { testContext } from "../../../__tests__/test-context";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import {
  API_TEST_CONNECTOR_CATALOG,
  catalogWithAuthMethod,
  createPublicConnectorCatalog,
} from "./helpers/public-connector-catalog";

const context = testContext();

const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);

describe("GET /api/connectors/:connectorSlug/scope-diff", () => {
  it("returns 404 when the stored connector runtime method is unavailable", async () => {
    const actor = bdd.user();
    if (actor.orgId === null) {
      throw new Error("Expected test actor organization");
    }
    const catalog = createPublicConnectorCatalog(context, { isolatePg: true });
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
    await catalog.publish(API_TEST_CONNECTOR_CATALOG);

    const response = await connectorsApi.requestScopeDiff(
      actor,
      "openai",
      [404],
    );

    expectApiError(response.body);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
