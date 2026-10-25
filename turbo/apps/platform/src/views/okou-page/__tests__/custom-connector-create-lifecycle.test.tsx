import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorAction,
  mockCustomConnectorStory,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test("A completed creation preserves a newer connector draft and directory search", async () => {
  mockCustomConnectorStory(context);
  const connector = customConnector({ displayName: "First API" });
  const started = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  let created = false;
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: created ? [connector] : [] });
  });
  context.mocks.api(
    customConnectorsContract.create,
    async ({ body, respond }) => {
      expect(body.displayName).toBe("First API");
      started.resolve();
      await response.promise;
      created = true;
      return respond(201, connector);
    },
  );
  await setupPage({ context, path: "/connectors?scope=custom" });
  await waitFor(() => {
    return expect(
      getConnectorAction("button", "New custom connector"),
    ).toBeEnabled();
  });
  click(getConnectorAction("button", "New custom connector"));
  const create = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(create).getByLabelText("Display name"), "First API");
  await fill(
    within(create).getByLabelText(/Prefixes/u),
    "https://api.acme.test/v1/",
  );
  click(getConnectorAction("button", "Add authentication", create));
  const menu = await screen.findByRole("menu");
  click(getConnectorAction("menuitem", "API authentication", menu));
  click(getConnectorAction("button", "Create", create));
  await started.promise;
  click(getConnectorAction("button", "Close", create));
  await waitFor(() => {
    return expect(create).not.toBeInTheDocument();
  });
  await fill(screen.getByPlaceholderText("Find custom connectors"), "first");
  click(getConnectorAction("button", "New custom connector"));
  const draft = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(draft).getByLabelText("Display name"), "Second API draft");
  response.resolve();
  await screen.findByText("First API");
  await expect(
    screen.findByRole("dialog", { name: "New custom connector" }),
  ).resolves.toBeInTheDocument();
  expect(within(draft).getByLabelText("Display name")).toHaveValue(
    "Second API draft",
  );
  expect(screen.getByPlaceholderText("Find custom connectors")).toHaveValue(
    "first",
  );
});
