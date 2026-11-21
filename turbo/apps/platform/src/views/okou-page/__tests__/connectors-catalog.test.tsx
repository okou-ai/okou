import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  mockConnectors,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";
const context = testContext();
test("connectors-catalog-008 an incoming Axiom search can be replaced with GitHub and an empty result", async () => {
  await setupPage({ context, path: "/connectors?keywords=axiom" });
  const field = await screen.findByPlaceholderText("Find connectors");
  await findButton("Connect Axiom");
  expect(field).toHaveValue("axiom");
  expect(queryButton("Connect GitHub")).toBeNull();
  await fill(field, "github");
  await findButton("Connect GitHub");
  expect(queryButton("Connect Axiom")).toBeNull();
  expect(new URL(window.location.href).searchParams.get("keywords")).toBe(
    "github",
  );
  await fill(field, "missing-service");
  await expect(
    screen.findByText('No connectors matching "missing-service"'),
  ).resolves.toBeInTheDocument();
});

test("connectors-catalog-009 remote Slack search preserves the total size of the catalog", async () => {
  const git = publicStatusItem({ connectorSlug: "github", label: "GitHub" });
  const slack = publicStatusItem({ connectorSlug: "slack", label: "Slack" });
  context.mocks.api(
    connectorCatalogContract.discovery,
    ({ query, respond }) => {
      return respond(200, {
        connectors:
          query.keyword === "Slack" ? [slack] : query.keyword ? [] : [git],
        totalConnectorCount: 1234,
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  await findButton("Connect GitHub");
  const total = await screen.findByText(/Connect 1,234 services/);
  await fill(screen.getByPlaceholderText("Find connectors"), "Slack");
  await findButton("Connect Slack");
  expect(queryButton("Connect GitHub")).toBeNull();
  expect(total).toBeInTheDocument();
});

test("connectors-catalog-013 a revoked Gmail authorization remains a manageable connected account", async () => {
  mockConnectors(context, [
    {
      connectorSlug: "gmail",
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    },
  ]);
  await setupPage({ context, path: "/connectors" });
  await expect(findButton("Manage Gmail accounts")).resolves.toBeEnabled();
  const scope = queryAllByRoleFast("radio").find((item) => {
    return item.textContent === "Connected1";
  });
  expect(scope).toBeInTheDocument();
});

test("connectors-catalog-015 the Custom scope offers Acme Search and custom creation", async () => {
  mockConnectors(context, [{ connectorSlug: "github" }]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [customConnector({ displayName: "Acme Search" })],
    });
  });
  await setupPage({ context, path: "/connectors" });
  await findButton("Manage GitHub accounts");
  expect(screen.queryByText("Acme Search")).not.toBeInTheDocument();
  click(screen.getByText("Custom", { selector: '[role="radio"]' }));
  await screen.findByText("Acme Search");
  expect(queryButton("Filter connectors")).toBeNull();
  expect(screen.queryAllByTestId(/^connector-shelf-/)).toHaveLength(0);
  await expect(findButton("New custom connector")).resolves.toBeEnabled();
});
