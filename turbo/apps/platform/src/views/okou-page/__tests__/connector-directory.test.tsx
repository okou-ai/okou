import { sshConnectionsContract } from "@okouai/api-contracts/contracts/ssh-connections";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  builtinConnector,
  createComposerConnectorHelpers,
  noAuthMethod,
  oauthAuthMethod,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

const GITHUB = "github" as ConnectorSlug;
const GMAIL = "gmail" as ConnectorSlug;
const NOTION = "notion" as ConnectorSlug;
const PUBLIC_TOOLS = "public-tools" as ConnectorSlug;

async function openConnectorCatalog(): Promise<HTMLElement> {
  await setupPage({ context, path: `/agents/${SCOUT_AGENT_ID}/chat` });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "Add connectors"));
  const search = await screen.findByPlaceholderText("Find connectors...");
  const catalog = search.closest('[role="dialog"]');
  if (!(catalog instanceof HTMLElement)) {
    throw new Error("Connector catalog dialog not found");
  }
  return catalog;
}

async function searchCatalog(
  catalog: HTMLElement,
  keyword: string,
): Promise<void> {
  await fill(
    within(catalog).getByPlaceholderText("Find connectors..."),
    keyword,
  );
}

test("Show builtin tool service details without HTTP permission controls", async () => {
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: PUBLIC_TOOLS,
        label: "Public Tools",
        authMethods: [noAuthMethod()],
        hasPermissions: true,
        mcp: {
          transport: "streamable-http",
          endpoint: "https://tools.example.test/mcp",
        },
      }),
    ],
  });
  const catalog = await openConnectorCatalog();

  await searchCatalog(catalog, "Public Tools");
  click(await findFastControl("button", "Open Public Tools details", catalog));

  const details = await screen.findByRole("dialog", { name: "Public Tools" });
  expect(
    within(details).getByRole("heading", { name: "Connection" }),
  ).toBeInTheDocument();
  expect(within(details).getByText("Public access")).toBeInTheDocument();
  expect(
    within(details).queryByRole("heading", { name: "Permissions" }),
  ).toBeNull();
  expect(queryFastControl("button", "Configure", details)).toBeNull();
});

test("Offer the catalog for adding, and find a connected connector by name", async () => {
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: GITHUB, label: "GitHub" }),
      builtinConnector({ slug: GMAIL, label: "Gmail", hasAccount: false }),
      builtinConnector({ slug: NOTION, label: "Notion", hasAccount: false }),
    ],
  });
  const catalog = await openConnectorCatalog();

  await expect(
    findFastControl("button", "Connect Gmail", catalog),
  ).resolves.toBeInTheDocument();
  expect(queryFastControl("button", "Connect Notion", catalog)).not.toBeNull();
  expect(within(catalog).queryByText("GitHub")).toBeNull();

  await searchCatalog(catalog, "GitHub");

  const connected = await within(catalog).findByRole("toolbar", {
    name: "Connected",
  });
  expect(
    queryFastControl("button", "Open GitHub details", connected),
  ).toBeInTheDocument();
});

test("Find a connector by a tag that is not in its name", async () => {
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: GMAIL,
        label: "Gmail",
        hasAccount: false,
        tags: ["email"],
      }),
      builtinConnector({ slug: NOTION, label: "Notion", hasAccount: false }),
    ],
  });
  const catalog = await openConnectorCatalog();
  await expect(
    findFastControl("button", "Connect Notion", catalog),
  ).resolves.toBeInTheDocument();

  await searchCatalog(catalog, "email");

  await waitFor(() => {
    expect(queryFastControl("button", "Connect Notion", catalog)).toBeNull();
  });
  expect(
    queryFastControl("button", "Connect Gmail", catalog),
  ).toBeInTheDocument();
});

test("Open connector detail and step back to the list", async () => {
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: GITHUB, label: "GitHub" }),
      builtinConnector({ slug: NOTION, label: "Notion", hasAccount: false }),
    ],
  });
  const catalog = await openConnectorCatalog();
  await searchCatalog(catalog, "GitHub");

  click(await findFastControl("button", "Open GitHub details", catalog));

  const details = await screen.findByRole("dialog", { name: "GitHub" });
  expect(
    within(details).getByRole("heading", { name: "Connection" }),
  ).toBeInTheDocument();

  click(await findFastControl("button", "Back", details));

  const restored = await screen.findByRole("dialog", { name: "Connectors" });
  await expect(
    within(restored).findByRole("heading", { name: "Connected" }),
  ).resolves.toBeInTheDocument();
  expect(
    queryFastControl("button", "Open GitHub details", restored),
  ).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "GitHub" })).toBeNull();
});

test("Open one provider authorization window from a focused card with Enter", async () => {
  const user = userEvent.setup({ delay: null });
  const fixture = installComposerConnectorFixture({
    catalog: [
      builtinConnector({
        slug: GMAIL,
        label: "Gmail",
        hasAccount: false,
        authMethods: [oauthAuthMethod()],
      }),
    ],
  });
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "about:blank" },
  });
  const opened = context.mocks.browser.open(authWindow);
  const catalog = await openConnectorCatalog();
  const connect = await findFastControl("button", "Connect Gmail", catalog);

  connect.focus();
  expect(connect).toHaveFocus();
  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://accounts.example.test/gmail",
    );
  });
  expect(opened.calls).toHaveLength(1);
  expect(fixture.oauthConnectionRequests).toHaveLength(1);
  expect(fixture.oauthConnectionRequests[0]).toMatchObject({
    connectorSlug: GMAIL,
    authMethod: "oauth",
  });

  click(await findFastControl("button", "Close", catalog));

  await waitFor(() => {
    expect(authWindow.closed).toBeTruthy();
  });
  expect(screen.queryByPlaceholderText("Find connectors...")).toBeNull();
});

test("Keep remote access results outside connector action navigation", async () => {
  installComposerConnectorFixture({
    catalog: [
      builtinConnector({ slug: GMAIL, label: "Gmail", hasAccount: false }),
    ],
  });
  context.mocks.api(sshConnectionsContract.summary, ({ respond }) => {
    return respond(200, { configuredCount: 0 });
  });
  const catalog = await openConnectorCatalog();
  await expect(
    findFastControl("button", "Connect Gmail", catalog),
  ).resolves.toBeInTheDocument();

  await searchCatalog(catalog, "ssh");

  const manage = await findFastControl("link", "Manage SSH hosts", catalog);
  expect(
    within(catalog).getByRole("heading", { name: "Remote access" }),
  ).toBeInTheDocument();
  expect(manage).toHaveAttribute(
    "href",
    "/connectors?scope=remote-control&type=ssh",
  );
  expect(within(catalog).queryByText(/No connector matches/u)).toBeNull();
});
