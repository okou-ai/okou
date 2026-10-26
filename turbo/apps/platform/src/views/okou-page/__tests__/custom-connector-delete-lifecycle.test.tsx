import {
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
  mockCustomConnectorStory,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test("A completed deletion preserves a newer connector draft", async () => {
  const connector = customConnector({ displayName: "First API" });
  mockCustomConnectorStory(context, [{ connector }]);
  let deleted = false;
  const started = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: deleted ? [] : [connector] });
  });
  context.mocks.api(customConnectorByIdContract.delete, async ({ respond }) => {
    started.resolve();
    await response.promise;
    deleted = true;
    return respond(204);
  });
  await setupPage({ context, path: "/connectors?scope=custom" });
  await waitFor(() => {
    return expect(getConnectorCard("First API")).toBeInTheDocument();
  });
  click(getConnectorAction("button", "More options"));
  const menu = await screen.findByRole("menu");
  click(getConnectorAction("menuitem", "Delete", menu));
  const deletion = await screen.findByRole("dialog", {
    name: "Delete First API?",
  });
  click(getConnectorAction("button", "Delete", deletion));
  await started.promise;
  click(getConnectorAction("button", "Close", deletion));
  await waitFor(() => {
    return expect(deletion).not.toBeInTheDocument();
  });
  click(getConnectorAction("button", "New custom connector"));
  const draft = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(draft).getByLabelText("Display name"), "Second API draft");
  response.resolve();
  await screen.findByText(
    "Add an HTTP API or MCP server for your organization to use.",
  );
  await expect(
    screen.findByRole("dialog", { name: "New custom connector" }),
  ).resolves.toBeInTheDocument();
  expect(within(draft).getByLabelText("Display name")).toHaveValue(
    "Second API draft",
  );
});
