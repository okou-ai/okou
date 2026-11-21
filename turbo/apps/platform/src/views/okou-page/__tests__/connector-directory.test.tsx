import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";
import { findNamedLink } from "./chat-attachment-test-helpers.ts";
import {
  mockSavedConnectorAccounts,
  mockConnectors,
  mockPublicConnectorStatus,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";

const context = testContext();
async function directory() {
  await setupPage({ context, path: "/" });
  click(await findButton("Connectors"));
  click(await findButton("Add connectors"));
  return screen.findByRole("dialog", { name: "Connectors" });
}
test("connector-directory-001 Public Tools has an account and opens its MCP details", async () => {
  const service = {
    ...publicStatusItem({
      connectorSlug: "public-tools",
      label: "Public Tools",
      authMethods: [
        {
          id: "none",
          grantKind: "none",
          label: "Public access",
          description: null,
          supportsRefresh: false,
          manualFields: [],
          startOptions: [],
        },
      ],
      permissionSummary: {
        hasPermissions: true,
        permissionCount: 2,
        hasCategories: false,
        hasDefaultPolicyOverrides: false,
      },
    }),
    mcp: {
      transport: "streamable-http" as const,
      endpoint: "https://public.example.test/tools",
    },
  };
  mockPublicConnectorStatus(context, [service]);
  const connected = connectorAccountFixture(
    { kind: "builtin", connectorSlug: "public-tools" },
    { authMethod: "none" },
  );
  mockSavedConnectorAccounts(context, () => {
    return [connected];
  });
  const catalog = await directory();
  await fill(within(catalog).getByRole("textbox"), "Public Tools");
  click(await findButton("Open Public Tools details"));
  const detail = await screen.findByRole("dialog", { name: "Public Tools" });
  await within(detail).findByText("Connected");
  expect(
    within(detail).queryByRole("heading", { name: "Permissions" }),
  ).not.toBeInTheDocument();
  expect(queryButton("Configure", detail)).toBeNull();
});

test("connector-directory-002 search locates GitHub among connected results", async () => {
  mockConnectors(context, [{ connectorSlug: "github" }]);
  const catalog = await directory();
  await findButton("Connect Notion");
  await expect(findButton("Connect Gmail")).resolves.toBeInTheDocument();
  expect(within(catalog).queryByText("GitHub")).not.toBeInTheDocument();
  await fill(within(catalog).getByRole("textbox"), "GitHub");
  const connected = await within(catalog).findByRole("toolbar", {
    name: "Connected",
  });
  expect(queryButton("Open GitHub details", connected)).toBeInTheDocument();
});

test("connector-directory-003 the email tag narrows the catalog to Gmail", async () => {
  mockPublicConnectorStatus(context, [
    {
      ...publicStatusItem({
        connectorSlug: "gmail",
        label: "Gmail",
        description: "Inbox",
      }),
      tags: ["email"],
    },
    publicStatusItem({
      connectorSlug: "notion",
      label: "Notion",
      description: "Documents",
    }),
  ]);
  const catalog = await directory();
  await findButton("Connect Notion");
  await fill(within(catalog).getByRole("textbox"), "email");
  await within(catalog).findByText("1 match");
  expect(queryButton("Connect Gmail", catalog)).toBeInTheDocument();
  expect(queryButton("Connect Notion", catalog)).toBeNull();
});

test("connector-directory-011 searching ssh offers the remote host manager", async () => {
  const catalog = await directory();
  await findButton("Connect Gmail");
  await fill(within(catalog).getByRole("textbox"), "ssh");
  await within(catalog).findByRole("heading", { name: "Remote access" });
  await expect(
    findNamedLink("Manage SSH hosts", catalog),
  ).resolves.toHaveAttribute(
    "href",
    "/connectors?scope=remote-control&type=ssh",
  );
  expect(
    within(catalog).queryByText("No connector matches “ssh”"),
  ).not.toBeInTheDocument();
});
test("connector-directory-004 GitHub connection details return to the named catalog", async () => {
  mockConnectors(context, [{ connectorSlug: "github" }]);
  const catalog = await directory();
  await fill(within(catalog).getByRole("textbox"), "GitHub");
  click(await findButton("Open GitHub details"));
  const detail = await screen.findByRole("dialog", { name: "GitHub" });
  await within(detail).findByRole("heading", { name: "Connection" });
  click(await findButton("Back"));
  const list = await screen.findByRole("dialog", { name: "Connectors" });
  expect(
    within(list).getByRole("heading", { name: "Connected" }),
  ).toBeInTheDocument();
});
