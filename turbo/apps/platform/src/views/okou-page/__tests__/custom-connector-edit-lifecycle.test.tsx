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
test("custom-connector-edit-lifecycle-002 a late edit result updates the directory while preserving the new form", async () => {
  const first = customConnector({ displayName: "First API" });
  let entries = [first];
  const release = context.mocks.deferred<void>();
  const received = context.mocks.deferred<void>();
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: entries });
  });
  context.mocks.api(
    customConnectorByIdContract.update,
    async ({ params, body, respond }) => {
      received.resolve();
      await release.promise;
      const item = customConnector({
        id: params.id,
        displayName: body.displayName,
        prefixTemplates: body.kind === "mcp" ? [] : body.prefixTemplates,
      });
      entries = [item];
      return respond(200, item);
    },
  );
  await setupPage({ context, path });
  await screen.findByText("First API");
  click(await findFastControl("button", "More options"));
  click(await screen.findByText("Edit", { selector: '[role="menuitem"]' }));
  const editor = await screen.findByRole("dialog");
  await fill(
    within(editor).getByPlaceholderText("Acme API"),
    "Saved first API",
  );
  await fill(
    within(editor).getByPlaceholderText("https://api.acme.com/v1/"),
    "http://api.acme.test/v1/",
  );
  click(await findFastControl("button", "Save", editor));
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
  await screen.findByText("Saved first API");
  expect(next).toBeInTheDocument();
  expect(field).toHaveValue("Second API draft");
});
