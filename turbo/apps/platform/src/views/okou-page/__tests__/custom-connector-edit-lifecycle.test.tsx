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

test("A completed edit preserves a newer connector draft", async () => {
  const connector = customConnector({ displayName: "First API" });
  mockCustomConnectorStory(context, [{ connector }]);
  let saved = connector;
  const started = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [saved] });
  });
  context.mocks.api(
    customConnectorByIdContract.update,
    async ({ body, respond }) => {
      expect(body.displayName).toBe("Saved first API");
      expect(body).toMatchObject({
        prefixTemplates: ["http://api.acme.test/v1/"],
      });
      started.resolve();
      await response.promise;
      saved = {
        ...connector,
        displayName: "Saved first API",
        prefixTemplates: ["http://api.acme.test/v1/"],
      };
      return respond(200, saved);
    },
  );
  await setupPage({ context, path: "/connectors?scope=custom" });
  await waitFor(() => {
    return expect(getConnectorCard("First API")).toBeInTheDocument();
  });
  click(getConnectorAction("button", "More options"));
  const menu = await screen.findByRole("menu");
  click(getConnectorAction("menuitem", "Edit", menu));
  const edit = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  await fill(within(edit).getByLabelText("Display name"), "Saved first API");
  await fill(
    within(edit).getByLabelText(/Prefixes/u),
    "http://api.acme.test/v1/",
  );
  click(getConnectorAction("button", "Save", edit));
  await started.promise;
  click(getConnectorAction("button", "Close", edit));
  await waitFor(() => {
    return expect(edit).not.toBeInTheDocument();
  });
  click(getConnectorAction("button", "New custom connector"));
  const draft = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(draft).getByLabelText("Display name"), "Second API draft");
  response.resolve();
  await screen.findByText("Saved first API");
  await expect(
    screen.findByRole("dialog", { name: "New custom connector" }),
  ).resolves.toBeInTheDocument();
  expect(within(draft).getByLabelText("Display name")).toHaveValue(
    "Second API draft",
  );
});
