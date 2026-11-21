import {
  customConnectorsContract,
  customConnectorByIdContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { customConnector } from "./connector-page-test-helpers.ts";
const context = testContext();
const path = "/connectors?scope=custom";
test("custom-connector-delete-lifecycle-001 a late delete result updates the directory while preserving the new form", async () => {
  const first = customConnector({ displayName: "First API" });
  let entries = [first];
  const release = context.mocks.deferred<void>();
  const received = context.mocks.deferred<void>();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: entries });
  });
  context.mocks.api(
    customConnectorByIdContract.delete,
    async ({ params, respond }) => {
      received.resolve();
      await release.promise;
      entries = entries.filter((item) => {
        return item.id !== params.id;
      });
      return respond(204);
    },
  );
  await setupPage({ context, path });
  await screen.findByText("First API");
  click(await findFastControl("button", "More options"));
  click(await screen.findByText("Delete", { selector: '[role="menuitem"]' }));
  const confirmation = await screen.findByRole("dialog");
  click(await findFastControl("button", "Delete", confirmation));
  await received.promise;
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(await findFastControl("button", "New custom connector"));
  const next = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  const field = within(next).getByPlaceholderText("Acme API");
  await fill(field, "Second API draft");
  release.resolve();
  await screen.findByText(
    "Add an HTTP API or MCP server for your organization to use.",
  );
  expect(next).toBeInTheDocument();
  expect(field).toHaveValue("Second API draft");
});
