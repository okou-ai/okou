import { httpConnectorFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
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
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test("A completed edit preserves a newer connector draft", async () => {
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
  const updates: UpdateCustomConnectorBody[] = [];
  const updateStarted = context.mocks.deferred<void>();
  const releaseUpdate = context.mocks.deferred<void>();
  context.mocks.api(
    customConnectorByIdContract.update,
    async ({ body, respond }) => {
      updates.push(body);
      updateStarted.resolve();
      await releaseUpdate.promise;
      const updated = httpConnectorFixture({ ...firstApi, ...body });
      connectors = [updated];
      return respond(200, updated);
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
      return getConnectorAction("menuitem", "Edit");
    }),
  );
  const editor = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  await fill(within(editor).getByLabelText("Display name"), "Saved first API");
  await fill(
    within(editor).getByLabelText(/^Prefixes/u),
    "http://api.acme.test/v1/",
  );

  click(getConnectorAction("button", "Save", editor));
  await updateStarted.promise;
  click(getConnectorAction("button", "Close", editor));
  await waitFor(() => {
    expect(editor).not.toBeInTheDocument();
  });
  click(getConnectorAction("button", "New custom connector"));
  const draft = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(draft).getByLabelText("Display name"), "Second API draft");
  releaseUpdate.resolve();

  await waitFor(() => {
    expect(queryConnectorCard("Saved first API")).not.toBeNull();
  });
  expect(updates).toMatchObject([
    {
      displayName: "Saved first API",
      prefixTemplates: ["http://api.acme.test/v1/"],
    },
  ]);
  expect(draft).toBeInTheDocument();
  expect(within(draft).getByLabelText("Display name")).toHaveValue(
    "Second API draft",
  );
});
