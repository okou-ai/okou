import {
  customConnectorsContract,
  customConnectorByIdContract,
  customConnectorValuesContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  customConnector,
  chooseConnectorAuthentication,
  customConnectorAccount,
  getConnectorAction,
  mockCustomConnectorStory,
} from "./connector-page-test-helpers.ts";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";

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

const CONNECTION_ID = "e0000000-0000-4000-a000-000000000e51";

async function openConnect(): Promise<HTMLElement> {
  const connect = await waitFor(() => {
    return getConnectorAction("button", "Connect Acme Search");
  });
  click(connect);
  return await screen.findByRole("dialog", { name: "Connect Acme Search" });
}

test("Cancel a pending custom connection and connect another account", async () => {
  const connector = customConnector();
  mockCustomConnectorStory(context, [{ connector }]);
  const first = {
    started: context.mocks.deferred<void>(),
    aborted: context.mocks.deferred<void>(),
    release: context.mocks.deferred<void>(),
    answered: context.mocks.deferred<void>(),
  };
  context.mocks.api(
    customConnectorValuesContract.set,
    async ({ body, request, respond }) => {
      const secret = body.values.find((value) => {
        return value.key === "secret";
      })?.value;
      if (secret === "first-secret") {
        request.signal.addEventListener(
          "abort",
          () => {
            first.aborted.resolve();
          },
          { once: true },
        );
        first.started.resolve();
        await first.release.promise;
        first.answered.resolve();
        return respond(200, {
          ...connector,
          connectionId: "e0000000-0000-4000-a000-000000000e52",
        });
      }
      return respond(200, { ...connector, connectionId: CONNECTION_ID });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      return respond(
        200,
        customConnectorAccount(connector.id, { id: params.connectionId }),
      );
    },
  );
  await setupPage({ context, path: "/connectors?scope=custom" });
  const firstDialog = await openConnect();
  await fill(within(firstDialog).getByLabelText("Secret"), "first-secret");
  click(getConnectorAction("button", "Save", firstDialog));
  await first.started.promise;

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(firstDialog).not.toBeInTheDocument();
  });
  await first.aborted.promise;

  const secondDialog = await openConnect();
  const secret = within(secondDialog).getByLabelText("Secret");
  expect(secret).toHaveValue("");
  await fill(secret, "second-secret");
  first.release.resolve();
  await first.answered.promise;
  expect(within(secondDialog).getByLabelText("Secret")).toHaveValue(
    "second-secret",
  );

  click(getConnectorAction("button", "Save", secondDialog));

  await expect(
    screen.findByRole("dialog", { name: "Name your Acme Search account" }),
  ).resolves.toBeInTheDocument();
  expect(secondDialog).not.toBeInTheDocument();
});

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
