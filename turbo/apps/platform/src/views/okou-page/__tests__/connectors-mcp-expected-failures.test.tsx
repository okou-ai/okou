import { getAction } from "./connector-integrations-test-helpers.ts";
import {
  customConnectorsContract,
  customConnectorOAuth2Contract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mcpCustomConnector,
  getConnectorCard,
  mockSavedConnectorAccounts,
} from "./connector-page-test-helpers.ts";

const context = testContext();
test.each([
  {
    id: "connectors-mcp-expected-failures-001",
    status: 400,
    code: "MCP_OAUTH_DISCOVERY_INVALID",
    notice:
      "The MCP server's OAuth discovery metadata is incomplete or inconsistent. Fix the advertised metadata if you manage the server, or contact the server administrator.",
  },
  {
    id: "connectors-mcp-expected-failures-002",
    status: 502,
    code: "MCP_OAUTH_PROVIDER_UNAVAILABLE",
    notice:
      "The MCP OAuth provider is temporarily unavailable or rate-limited. Check the provider's availability.",
  },
] as const)(
  "$id an unsuccessful OAuth start leaves Acme MCP available to retry",
  async ({ status, code, notice }) => {
    const definition = mcpCustomConnector({
      authMode: "automatic",
      fields: [],
      headerInjections: [],
      account: { missingRequiredFields: [], configuredFieldKeys: [] },
    });
    context.mocks.data.org({
      id: "org_review",
      name: "Review workspace",
      role: "admin",
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [definition] });
    });
    mockSavedConnectorAccounts(context, () => {
      return [];
    });
    const release = context.mocks.deferred<void>();
    const popup = context.mocks.browser.authWindow();
    const open = context.mocks.browser.open(popup);
    const telemetry = context.mocks.sentry();
    context.mocks.api(
      customConnectorOAuth2Contract.start,
      async ({ params, respond }) => {
        expect(params.id).toBe(definition.id);
        await release.promise;
        return respond(status, {
          error: { code, message: "Upstream discovery failed" },
        });
      },
    );
    await setupPage({ context, path: "/connectors?scope=custom" });
    await screen.findByText("Acme MCP");
    const cardElement = getConnectorCard("Acme MCP");
    const card = within(cardElement);
    click(getAction("button", "Connect Acme MCP", cardElement));
    await waitFor(() => {
      return expect(open.calls).toHaveLength(1);
    });
    expect(popup.closed).toBeFalsy();
    release.resolve();
    await expect(screen.findByText(notice)).resolves.toBeInTheDocument();
    expect(popup.closed).toBeTruthy();
    expect(getAction("button", "Connect Acme MCP", cardElement)).toBeEnabled();
    expect(card.getByText("No accounts")).toBeInTheDocument();
    expect(
      telemetry.reports.filter((item) => {
        return item.type === "exception";
      }),
    ).toStrictEqual([]);
  },
);
