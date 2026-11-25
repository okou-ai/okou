import {
  customConnectorByIdContract,
  customConnectorsContract,
  type UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  customConnector,
  mcpCustomConnector,
  mockSavedConnectorAccounts,
  getConnectorCard,
  mockCustomConnectorStory,
  customConnectorAccount,
  chooseConnectorAuthentication,
} from "./connector-page-test-helpers.ts";
const context = testContext();
const path = "/connectors?scope=custom";

test("connectors-custom-003 switching HTTP authentication preserves its draft before creating a public connector", async () => {
  mockCustomConnectorStory(context);
  await setupPage({ context, path });
  click(await findFastControl("button", "New custom connector"));
  const form = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(form).getByPlaceholderText("Acme API"), "Guest data");
  await fill(
    within(form).getByPlaceholderText("https://api.acme.com/v1/"),
    "https://public.example.test/",
  );
  await chooseConnectorAuthentication(form, "API authentication");
  const header = within(form).getByPlaceholderText("Authorization");
  await fill(header, "X-Public-Key");
  click(within(form).getByRole("combobox", { name: "Authentication" }));
  expect(
    screen.queryByRole("option", { name: "Automatic" }),
  ).not.toBeInTheDocument();
  click(await screen.findByRole("option", { name: "No authentication" }));
  expect(
    within(form).queryByPlaceholderText("Authorization"),
  ).not.toBeInTheDocument();
  await chooseConnectorAuthentication(form, "API authentication");
  expect(within(form).getByPlaceholderText("Authorization")).toHaveValue(
    "X-Public-Key",
  );
  await chooseConnectorAuthentication(form, "No authentication");
  const create = await findFastControl("button", "Create", form);
  expect(create).toBeEnabled();
  click(create);
  await screen.findByText("Guest data");
});
test("connectors-custom-011 renaming the connected API preserves its prefix until deletion", async () => {
  const api = customConnector({ displayName: "Acme API" });
  mockCustomConnectorStory(context, [
    { connector: api, account: customConnectorAccount(api.id) },
  ]);
  await setupPage({ context, path });
  await screen.findByText("Acme API");
  click(await findFastControl("button", "More options"));
  click(await screen.findByText("Edit", { selector: '[role="menuitem"]' }));
  const form = await screen.findByRole("dialog");
  await fill(within(form).getByPlaceholderText("Acme API"), "Acme Billing API");
  click(await findFastControl("button", "Save", form));
  await screen.findByText("Acme Billing API");
  const card = getConnectorCard("Acme Billing API");
  expect(card).toHaveTextContent("Connected");
  expect(card).toHaveTextContent("https://api.acme.test/v1/");
  click(await findFastControl("button", "More options"));
  click(await screen.findByText("Delete", { selector: '[role="menuitem"]' }));
  click(
    await findFastControl(
      "button",
      "Delete",
      await screen.findByRole("dialog"),
    ),
  );
  await screen.findByText(
    "Add an HTTP API or MCP server for your organization to use.",
  );
});
test("connectors-custom-021 saving the advanced query-key definition retains its injection", async () => {
  let update: { id: string; body: UpdateCustomConnectorBody } | undefined;
  const api = customConnector({
    headerInjections: [],
    queryInjections: [{ name: "api_key", valueTemplate: "{{secrets.secret}}" }],
  });
  mockCustomConnectorStory(context, [{ connector: api }]);
  context.mocks.api(
    customConnectorByIdContract.update,
    ({ params, body, respond }) => {
      update = { id: params.id, body };
      return respond(200, api);
    },
  );
  await setupPage({ context, path });
  await screen.findByText(api.displayName);
  click(await findFastControl("button", "More options"));
  click(await screen.findByText("Edit", { selector: '[role="menuitem"]' }));
  const editor = await screen.findByRole("dialog");
  await within(editor).findByText(
    "Advanced API fields and injections are preserved when you save.",
  );
  click(await findFastControl("button", "Save", editor));
  await waitFor(() => {
    return expect(editor).not.toBeInTheDocument();
  });
  expect(update).toMatchObject({
    id: api.id,
    body: {
      prefixTemplates: api.prefixTemplates,
      headerInjections: [],
      queryInjections: api.queryInjections,
    },
  });
});
test("connectors-custom-024 the unconnected API separates card activation from definition actions", async () => {
  const api = customConnector();
  mockCustomConnectorStory(context, [{ connector: api }]);
  await setupPage({ context, path });
  await screen.findByText(api.displayName);
  const card = getConnectorCard(api.displayName);
  expect(card).toHaveTextContent("HTTP API");
  expect(card).toHaveTextContent("No accounts");
  expect(card).toHaveTextContent(api.prefixTemplates[0]!);
  await expect(
    findFastControl("button", "Connect Acme Search", card),
  ).resolves.toBeEnabled();
  expect(
    within(card).queryByLabelText("Manage Acme Search access"),
  ).not.toBeInTheDocument();
  click(await findFastControl("button", "More options"));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("Edit")).toBeInTheDocument();
  expect(within(menu).getByText("Delete")).toBeInTheDocument();
  expect(within(menu).queryByText("Connect")).not.toBeInTheDocument();
});

test("connectors-custom-017 connected filters retain a service whose nondefault OAuth accounts are healthy", async () => {
  const configured = mcpCustomConnector();
  const empty = mcpCustomConnector({
    id: crypto.randomUUID(),
    slug: "_empty",
    displayName: "Empty MCP",
  });
  const primary = customConnectorAccount(configured.id, {
    authMethod: "oauth",
    displayName: "Original default",
    connectionStatus: "reconnect-required",
    reconnectReason: "authorization_expired_or_revoked",
  });
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [configured, empty] });
  });
  const accounts = [
    primary,
    ...["Work", "Personal"].map((displayName) => {
      return customConnectorAccount(configured.id, {
        authMethod: "oauth",
        displayName,
        isDefault: false,
      });
    }),
  ];
  mockSavedConnectorAccounts(context, () => {
    return accounts;
  });
  await setupPage({ context, path });
  await screen.findByText("Empty MCP");
  const unused = getConnectorCard("Empty MCP");
  expect(unused).toHaveTextContent("No accounts");
  await expect(
    findFastControl("button", "Connect Empty MCP", unused),
  ).resolves.toBeEnabled();
  expect(getConnectorCard("Acme MCP")).toHaveTextContent("Connected");
  click(await findFastControl("radio", /^Connected/));
  await waitFor(() => {
    return expect(screen.queryByText("Empty MCP")).toBeNull();
  });
  const service = getConnectorCard("Acme MCP");
  click(await findFastControl("button", /manage.*accounts/i, service));
  const dialog = within(await screen.findByRole("dialog"));
  const row = await dialog.findByRole("group", { name: "Original default" });
  expect(row).toHaveTextContent(/default/i);
  await expect(
    findFastControl("button", "Reconnect", row),
  ).resolves.toBeEnabled();
  for (const name of ["Work", "Personal"]) {
    expect(dialog.getByText(name)).toBeInTheDocument();
  }
});
