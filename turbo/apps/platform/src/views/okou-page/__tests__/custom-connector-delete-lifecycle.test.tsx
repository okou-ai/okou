import {
  type CustomConnectorResponse,
  customConnectorByIdContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorAction,
  getConnectorCard,
  mockSavedConnectorAccounts,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test("A completed deletion preserves a newer connector draft", async () => {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
  const firstApi = customConnector({
    displayName: "First API",
    prefixTemplates: ["https://api.acme.test/v1/"],
  });
  let connectors: CustomConnectorResponse[] = [firstApi];
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors });
  });
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  const deletes: string[] = [];
  const deleteStarted = context.mocks.deferred<void>();
  const releaseDelete = context.mocks.deferred<void>();
  context.mocks.api(
    customConnectorByIdContract.delete,
    async ({ params, respond }) => {
      deletes.push(params.id);
      deleteStarted.resolve();
      await releaseDelete.promise;
      connectors = connectors.filter((connector) => {
        return connector.id !== params.id;
      });
      return respond(204);
    },
  );
  await setupPage({ context, path: "/connectors?scope=custom" });
  const row = await waitFor(() => {
    const card = getConnectorCard("First API").parentElement;
    if (!card) {
      throw new Error("Expected First API card row");
    }
    return card;
  });

  click(getConnectorAction("button", "More options", row));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Delete");
    }),
  );
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete First API?",
  });
  click(getConnectorAction("button", "Delete", confirmation));
  await deleteStarted.promise;
  click(getConnectorAction("button", "Close", confirmation));
  await waitFor(() => {
    expect(confirmation).not.toBeInTheDocument();
  });
  click(getConnectorAction("button", "New custom connector"));
  const draft = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(draft).getByLabelText("Display name"), "Second API draft");

  releaseDelete.resolve();

  await expect(
    screen.findByText(
      "Add an HTTP API or MCP server for your organization to use.",
    ),
  ).resolves.toBeInTheDocument();
  expect(deletes).toStrictEqual([firstApi.id]);
  expect(draft).toBeInTheDocument();
  expect(within(draft).getByLabelText("Display name")).toHaveValue(
    "Second API draft",
  );
});
