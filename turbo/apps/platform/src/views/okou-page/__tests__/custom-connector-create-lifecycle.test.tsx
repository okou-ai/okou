import { httpConnectorFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chooseConnectorAuthentication,
  getConnectorAction,
  mockSavedConnectorAccounts,
  queryConnectorCard,
} from "./connector-page-test-helpers.ts";

const context = testContext();

test("A completed creation preserves a newer connector draft and directory search", async () => {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
  let connectors: CustomConnectorResponse[] = [];
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors });
  });
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  const creates: CreateCustomConnectorBody[] = [];
  const createStarted = context.mocks.deferred<void>();
  const releaseCreate = context.mocks.deferred<void>();
  context.mocks.api(
    customConnectorsContract.create,
    async ({ body, respond }) => {
      creates.push(body);
      createStarted.resolve();
      await releaseCreate.promise;
      const created = httpConnectorFixture({
        ...body,
        kind: "http",
        id: "55555555-5555-4555-8555-555555555555",
        slug: "_first-api",
        createdAt: "2026-02-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
      });
      connectors = [...connectors, created];
      return respond(201, created);
    },
  );
  await setupPage({ context, path: "/connectors?scope=custom" });
  await expect(
    screen.findByText(
      "Add an HTTP API or MCP server for your organization to use.",
    ),
  ).resolves.toBeInTheDocument();

  click(getConnectorAction("button", "New custom connector"));
  const first = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(first).getByLabelText("Display name"), "First API");
  await fill(
    within(first).getByLabelText(/^Prefixes/u),
    "http://api.acme.test/v1/",
  );
  await chooseConnectorAuthentication(first, "API authentication");
  click(getConnectorAction("button", "Create", first));
  await createStarted.promise;
  click(getConnectorAction("button", "Close", first));
  await waitFor(() => {
    expect(first).not.toBeInTheDocument();
  });
  const search = screen.getByPlaceholderText("Find custom connectors");
  await fill(search, "first");
  click(getConnectorAction("button", "New custom connector"));
  const second = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(second).getByLabelText("Display name"), "Second API draft");

  releaseCreate.resolve();

  await waitFor(() => {
    expect(queryConnectorCard("First API")).not.toBeNull();
  });
  expect(creates).toMatchObject([
    {
      displayName: "First API",
      prefixTemplates: ["http://api.acme.test/v1/"],
      authMode: "manual",
    },
  ]);
  expect(second).toBeInTheDocument();
  expect(within(second).getByLabelText("Display name")).toHaveValue(
    "Second API draft",
  );
  expect(search).toHaveValue("first");
});
