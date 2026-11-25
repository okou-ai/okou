import userEvent from "@testing-library/user-event";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import {
  browserAuthMethod,
  catalogConnector,
} from "./chat-capability-connector-test-helpers.ts";
import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";
import { findNamedLink } from "./chat-attachment-test-helpers.ts";
import {
  mockSavedConnectorAccounts,
  mockConnectors,
  mockPublicConnectorStatus,
  publicStatusItem,
  getConnectorCard,
  customConnector,
} from "./connector-page-test-helpers.ts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { googleDriveCatalogItem } from "./chat-navigation-artifact-test-helpers.ts";

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

test("Activating Gmail with Enter leaves a provider window that closes with the directory", async () => {
  mockPublicConnectorStatus(context, [
    catalogConnector({
      slug: "gmail",
      label: "Gmail",
      method: browserAuthMethod(),
    }),
  ]);
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  context.mocks.browser.open(popup);
  const destination = "https://accounts.example.test/allow-mail";
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ params, respond }) => {
      return params.connectorSlug === "gmail"
        ? respond(200, {
            authorizationUrl: destination,
            oauthAttemptId: crypto.randomUUID(),
          })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Unknown provider" },
          });
    },
  );
  const dialog = await directory();
  const connect = await findButton("Connect Gmail");
  connect.focus();
  expect(connect).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    return expect(popup.location.href).toBe(destination);
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(popup.closed).toBeTruthy();
  });
  expect(dialog).not.toBeInTheDocument();
});

test("connectors-catalog-008 an incoming Axiom search can be replaced with GitHub and an empty result", async () => {
  await setupPage({ context, path: "/connectors?keywords=axiom" });
  const field = await screen.findByPlaceholderText("Find connectors");
  await findButton("Connect Axiom");
  expect(field).toHaveValue("axiom");
  expect(queryButton("Connect GitHub")).toBeNull();
  await fill(field, "github");
  await findButton("Connect GitHub");
  expect(queryButton("Connect Axiom")).toBeNull();
  expect(new URL(window.location.href).searchParams.get("keywords")).toBe(
    "github",
  );
  await fill(field, "missing-service");
  await expect(
    screen.findByText('No connectors matching "missing-service"'),
  ).resolves.toBeInTheDocument();
});

test("connectors-catalog-009 remote Slack search preserves the total size of the catalog", async () => {
  const git = publicStatusItem({ connectorSlug: "github", label: "GitHub" });
  const slack = publicStatusItem({ connectorSlug: "slack", label: "Slack" });
  context.mocks.api(
    connectorCatalogContract.discovery,
    ({ query, respond }) => {
      return respond(200, {
        connectors:
          query.keyword === "Slack" ? [slack] : query.keyword ? [] : [git],
        totalConnectorCount: 1234,
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  await findButton("Connect GitHub");
  const total = await screen.findByText(/Connect 1,234 services/);
  await fill(screen.getByPlaceholderText("Find connectors"), "Slack");
  await findButton("Connect Slack");
  expect(queryButton("Connect GitHub")).toBeNull();
  expect(total).toBeInTheDocument();
});

test("connectors-catalog-013 a revoked Gmail authorization remains a manageable connected account", async () => {
  mockConnectors(context, [
    {
      connectorSlug: "gmail",
      connectionStatus: "reconnect-required",
      reconnectReason: "authorization_expired_or_revoked",
    },
  ]);
  await setupPage({ context, path: "/connectors" });
  await expect(findButton("Manage Gmail accounts")).resolves.toBeEnabled();
  const scope = queryAllByRoleFast("radio").find((item) => {
    return item.textContent === "Connected1";
  });
  expect(scope).toBeInTheDocument();
});

test("connectors-catalog-015 the Custom scope offers Acme Search and custom creation", async () => {
  mockConnectors(context, [{ connectorSlug: "github" }]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, {
      connectors: [customConnector({ displayName: "Acme Search" })],
    });
  });
  await setupPage({ context, path: "/connectors" });
  await findButton("Manage GitHub accounts");
  expect(screen.queryByText("Acme Search")).not.toBeInTheDocument();
  click(screen.getByText("Custom", { selector: '[role="radio"]' }));
  await screen.findByText("Acme Search");
  expect(queryButton("Filter connectors")).toBeNull();
  expect(screen.queryAllByTestId(/^connector-shelf-/)).toHaveLength(0);
  await expect(findButton("New custom connector")).resolves.toBeEnabled();
});

test("connectors-catalog-010 the unconnected GitHub catalog card launches its OAuth destination", async () => {
  const github = publicStatusItem({
    connectorSlug: "github",
    label: "GitHub",
    description: "Track pull requests in shared repositories.",
    authMethods: [browserAuthMethod()],
    singleAuthCodeAuthMethodId: "oauth",
  });
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, { connector: github });
  });
  mockPublicConnectorStatus(context, [github]);
  const popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  context.mocks.browser.open(popup);
  const destination = "https://github.example.test/connect/workspace";
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ params, respond }) => {
      return respond(200, {
        authorizationUrl:
          params.connectorSlug === "github" ? destination : "about:blank",
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  await setupPage({ context, path: "/connectors" });
  const connect = await findButton("Connect GitHub");
  const card = getConnectorCard("GitHub");
  expect(card).toHaveTextContent(github.description!);
  expect(card).not.toHaveTextContent("No accounts");
  expect(queryButton("Manage GitHub access", card)).toBeNull();
  click(connect);
  await waitFor(() => {
    return expect(popup.location.href).toBe(destination);
  });
  popup.close();
});

test("connectors-category-filter-001 the open filter orders the whole catalog's positive categories and shows each total", async () => {
  const discovery = context.mocks.deferred<void>();
  context.mocks.api(connectorCatalogContract.discovery, async ({ respond }) => {
    await discovery.promise;
    return respond(200, {
      connectors: [
        {
          ...googleDriveCatalogItem("not-connected"),
          category: "docs-files-knowledge",
        },
      ],
      totalConnectorCount: 55,
      categoryConnectorCounts: {
        "meetings-scheduling": 0,
        "future-category": 3,
        "docs-files-knowledge": 40,
        "communication-collaboration": 12,
      },
    });
  });
  await setupPage({ context, host: "app.okou.ai", path: "/connectors" });
  const filters = await waitFor(() => {
    const button = queryAllByRoleFast("button").find((item) => {
      return item.getAttribute("aria-label") === "Filter connectors";
    });
    expect(button).toBeEnabled();
    return button!;
  });
  click(filters);
  const menu = await screen.findByRole("menu");
  discovery.resolve();
  await waitFor(() => {
    const options = queryAllByRoleFast("menuitem", menu);
    expect(
      options.map((option) => {
        return option.textContent?.trim();
      }),
    ).toStrictEqual([
      "All",
      "Communication12",
      "Documents40",
      "Future Category3",
    ]);
  });
});

test("connectors-category-virtualization-001 the open category reserves space for its unmounted services", async () => {
  const category = "communication-collaboration";
  const services = Array.from({ length: 300 }, (_, i) => {
    return publicStatusItem({
      connectorSlug: "service-" + i,
      label: "Messaging service " + i,
      category,
    });
  });
  mockPublicConnectorStatus(context, services, { [category]: 300 });
  await setupPage({ context, path: "/connectors?category=" + category });
  const grid = await screen.findByTestId("connector-category-grid");
  const mounted = within(grid).getAllByText(/^Messaging service \d+$/);
  expect(mounted.length).toBeGreaterThan(0);
  expect(mounted.length).toBeLessThan(300);
  const reserved = within(grid).getAllByTestId(
    "connector-category-reserved-rows",
  );
  expect(
    reserved.some((row) => {
      return /^span [1-9]\d*$/.test(row.style.gridRow);
    }),
  ).toBeTruthy();
});
