import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { apiTestConnectorCatalogWithUnavailableAuthMethods } from "../../../test-fixtures/connector-catalog";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { createPublicConnectorCatalog } from "./helpers/public-connector-catalog";

const context = testContext();
const connectorsApi = createConnectorBddApi(context);

// Each case publishes the generation whose on-demand compatibility it reads.
async function publishWithUnavailableMethod(
  publisher: ReturnType<typeof createPublicConnectorCatalog>,
  connectorSlug: string,
  authMethodId: string,
): Promise<void> {
  await publisher.publish(
    apiTestConnectorCatalogWithUnavailableAuthMethods(
      API_TEST_CONNECTOR_CATALOG_ARTIFACT,
      [{ connectorSlug, authMethodId }],
    ),
  );
}

describe("CONN-02: OAuth device authorization", () => {
  it("returns 403 when the selected device-auth runtime method is unavailable", async () => {
    const publisher = createPublicConnectorCatalog(context);
    await publishWithUnavailableMethod(publisher, "test-oauth-device", "oauth");
    const actor = createBddApi(context).user();

    const response = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "oauth",
      undefined,
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "test-oauth-device connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("returns 403 when a device-auth runtime becomes unavailable before polling", async () => {
    const publisher = createPublicConnectorCatalog(context);
    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    mockTestOAuthDeviceConnectorProvider({ deviceCode: "pending" });
    const actor = createBddApi(context).user();
    const session = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    await publishWithUnavailableMethod(publisher, "test-oauth-device", "oauth");

    const response = await connectorsApi.requestDeviceAuthPoll(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "test-oauth-device connector is not available",
      code: "FORBIDDEN",
    });
  });
});

describe("CONN-02: external-code authorization", () => {
  it("returns 403 when the external-code runtime method is unavailable", async () => {
    const publisher = createPublicConnectorCatalog(context);
    await publishWithUnavailableMethod(publisher, "aws", "cli");
    const actor = createBddApi(context).user();

    const response = await connectorsApi.requestExternalCodeStart(
      actor,
      "aws",
      "cli",
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "aws connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("returns 403 when an external-code runtime becomes unavailable before completion", async () => {
    const publisher = createPublicConnectorCatalog(context);
    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    const actor = createBddApi(context).user();
    const session = await connectorsApi.startExternalCode(actor, "aws", "cli");
    await publishWithUnavailableMethod(publisher, "aws", "cli");

    const response = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: session.sessionId,
        sessionToken: session.sessionToken,
        code: "bdd-code",
      },
      [403],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "aws connector is not available",
      code: "FORBIDDEN",
    });
  });
});
