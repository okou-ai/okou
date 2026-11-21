import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  customConnector,
  chooseConnectorAuthentication,
} from "./connector-page-test-helpers.ts";
const context = testContext();
const path = "/connectors?scope=custom";
test("custom-connector-create-lifecycle-001 a late create result updates the directory while preserving the new form", async () => {
  let entries: ReturnType<typeof customConnector>[] = [];
  const release = context.mocks.deferred<void>();
  const received = context.mocks.deferred<void>();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: entries });
  });
  context.mocks.api(
    customConnectorsContract.create,
    async ({ body, respond }) => {
      received.resolve();
      await release.promise;
      const item = customConnector({
        displayName: body.displayName,
        prefixTemplates: body.kind === "mcp" ? [] : body.prefixTemplates,
      });
      entries = [item];
      return respond(201, item);
    },
  );
  await setupPage({ context, path });
  await screen.findByText(
    "Add an HTTP API or MCP server for your organization to use.",
  );
  click(await findFastControl("button", "New custom connector"));
  const form = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(form).getByPlaceholderText("Acme API"), "First API");
  await fill(
    within(form).getByPlaceholderText("https://api.acme.com/v1/"),
    "http://api.acme.test/v1/",
  );
  await chooseConnectorAuthentication(form, "API authentication");
  click(await findFastControl("button", "Create", form));
  await received.promise;
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  const search = await screen.findByPlaceholderText("Find custom connectors");
  await fill(search, "first");
  click(await findFastControl("button", "New custom connector"));
  const next = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  const field = within(next).getByPlaceholderText("Acme API");
  await fill(field, "Second API draft");
  release.resolve();
  await screen.findByText("First API");
  expect(next).toBeInTheDocument();
  expect(field).toHaveValue("Second API draft");
  expect(search).toHaveValue("first");
});
