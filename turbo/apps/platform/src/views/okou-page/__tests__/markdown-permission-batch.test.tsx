import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import {
  connectorPermissionsResponse,
  type ConnectorPermissionFixture,
} from "../../../__tests__/connector-permissions.ts";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import type { UserPermissionGrantBatchItem } from "@okouai/api-contracts/validators/user-permission-grants";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000071";

const defaultItems = [
  { connectorSlug: "slack", permission: "files:read" },
  { connectorSlug: "github", permission: "repos.read" },
  { connectorSlug: "slack", permission: "files:read" },
] as const;

function batchUrl(
  items: readonly UserPermissionGrantBatchItem[] = defaultItems,
): URL {
  const url = new URL(
    `https://app.okou.ai/agents/${AGENT_ID}/permissions/batch`,
  );
  url.searchParams.set("action", "allow");
  url.searchParams.set("items", JSON.stringify(items));
  return url;
}

async function openMarkdown(source: string, enabled: boolean) {
  const chat = createMarkdownChatFixture(context);
  chat.install({
    rows: () => {
      return [
        chat.outputMessage(source, { seqId: 1 }),
        chat.runCompleted({ seqId: 2 }),
      ];
    },
  });
  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BatchConnectorPermissions]: enabled },
  });
}

function getButton(name: string, container: ParentNode): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!result) {
    throw new Error(`Expected button named "${name}"`);
  }
  return result;
}

test("A markdown batch link renders grouped permissions without duplicate rows", async () => {
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      const github = params.connectorSlug === "github";
      return respond(200, {
        permissions: {
          connectorSlug: params.connectorSlug,
          label: github ? "GitHub" : "Slack",
          icon: {
            url: "https://assets.example.test/connector.svg",
            invertInDarkMode: false,
          },
          permissionCount: 1,
          permissions: [
            {
              name: github ? "repos.read" : "files:read",
              description: github
                ? "Read repositories"
                : "Read workspace files",
            },
          ],
          categories: null,
          defaultPolicy: { permissionDefault: "ask", unknownPolicy: "deny" },
        },
      });
    },
  );
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, connectorPermissionsResponse(query, []));
  });

  await openMarkdown(
    `Review these permissions.\n\n[Authorize tools](${batchUrl().toString()})`,
    true,
  );

  const card = await screen.findByTestId("permission-batch-action-card");
  await expect(
    within(card).findByText("2 permissions to allow"),
  ).resolves.toBeInTheDocument();
  const review = getButton("Review permissions", card);
  expect(review).toBeEnabled();
  click(review);
  const dialog = await screen.findByRole("dialog", {
    name: "Allow the following permissions",
  });
  await expect(
    within(dialog).findByText("Read repositories"),
  ).resolves.toBeInTheDocument();
  await expect(
    within(dialog).findByText("Read workspace files"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getAllByText("files:read")).toHaveLength(1);
  expect(within(dialog).getByText("repos.read")).toBeInTheDocument();
  expect(screen.getByText("Review these permissions.")).toBeInTheDocument();
});

const services = [
  { slug: "slack", label: "Slack" },
  { slug: "github", label: "GitHub" },
  { slug: "google-drive", label: "Google Drive" },
  { slug: "notion", label: "Notion" },
  { slug: "linear", label: "Linear" },
] as const;

function installMetadata(
  items: readonly UserPermissionGrantBatchItem[],
  ready?: Promise<void>,
) {
  context.mocks.api(
    connectorCatalogContract.permissions,
    async ({ params, respond }) => {
      await ready;
      const permissions = items
        .filter((item) => {
          return item.connectorSlug === params.connectorSlug;
        })
        .map((item) => {
          return {
            name: item.permission,
            description: `Description for ${item.permission}`,
          };
        });
      return respond(200, {
        permissions: {
          connectorSlug: params.connectorSlug,
          label:
            services.find((service) => {
              return service.slug === params.connectorSlug;
            })?.label ?? params.connectorSlug,
          icon: {
            url: `https://assets.example.test/${params.connectorSlug}.svg`,
            invertInDarkMode: false,
          },
          permissionCount: permissions.length,
          permissions,
          categories: null,
          defaultPolicy: { permissionDefault: "ask", unknownPolicy: "deny" },
        },
      });
    },
  );
}

test("A batch card shows three service logos and exposes every service in its overflow tooltip", async () => {
  const user = userEvent.setup();
  const items = services.map((service) => {
    return { connectorSlug: service.slug, permission: "files:read" };
  });
  installMetadata(items);
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, connectorPermissionsResponse(query, []));
  });

  await openMarkdown(`[Authorize tools](${batchUrl(items).toString()})`, true);

  const card = await screen.findByTestId("permission-batch-action-card");
  await expect(
    within(card).findByText("5 permissions to allow"),
  ).resolves.toBeInTheDocument();
  const logos = getButton("GitHub, Google Drive, Linear, Notion, Slack", card);
  expect(
    within(logos).getAllByRole("presentation", { hidden: true }),
  ).toHaveLength(3);
  expect(within(logos).getByText("+2", { exact: true })).toBeInTheDocument();
  await user.hover(
    getButton(
      "GitHub, Google Drive, Linear, Notion, Slack",
      screen.getByTestId("permission-batch-action-card"),
    ),
  );
  const tooltip = await screen.findByRole("tooltip");
  for (const service of services) {
    expect(tooltip).toHaveTextContent(service.label);
  }
});

test("A partially allowed batch shows the remaining permission count", async () => {
  installMetadata(defaultItems.slice(0, 2));
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(
      200,
      connectorPermissionsResponse(query, [
        {
          connectorSlug: "slack",
          permission: "files:read",
          action: "allow",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ]),
    );
  });

  await openMarkdown(`[Authorize tools](${batchUrl().toString()})`, true);
  const card = await screen.findByTestId("permission-batch-action-card");
  await expect(
    within(card).findByText("1 permission to allow"),
  ).resolves.toBeInTheDocument();
  expect(within(card).getByText("1 already allowed")).toBeInTheDocument();
  expect(getButton("Review permissions", card)).toBeEnabled();
});

test("A batch stays reviewable while service details load and enables duration only when ready", async () => {
  const metadata = context.mocks.deferred<void>();
  const items = [
    { connectorSlug: "slack", permission: "files:read" },
    { connectorSlug: "slack", permission: "chat:write" },
    { connectorSlug: "github", permission: "repos.read" },
  ];
  installMetadata(items, metadata.promise);
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, connectorPermissionsResponse(query, []));
  });

  await openMarkdown(`[Authorize tools](${batchUrl(items).toString()})`, true);
  const card = await screen.findByTestId("permission-batch-action-card");
  expect(
    within(card).getByRole("status", { name: "Loading permissions" }),
  ).toBeInTheDocument();
  click(getButton("Review permissions", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Allow the following permissions",
  });
  expect(
    within(dialog).getByRole("status", { name: "Loading permissions" }),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("combobox", { name: "Permission duration" }),
  ).toBeDisabled();
  expect(getButton("Allow all 3 permissions", dialog)).toBeDisabled();
  const loadingGroups = within(dialog).getAllByRole("list", { hidden: true });
  expect(loadingGroups).toHaveLength(2);
  expect(
    loadingGroups
      .map((group) => {
        return within(group).getAllByRole("listitem", { hidden: true }).length;
      })
      .sort(),
  ).toStrictEqual([1, 2]);

  metadata.resolve();
  await expect(
    within(dialog).findByText("0 of 3 permissions allowed"),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).getByRole("heading", { name: "Slack" }),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole("heading", { name: "GitHub" }),
  ).toBeInTheDocument();
  for (const item of items) {
    expect(
      within(dialog).getByText(item.permission, { exact: true }),
    ).toBeInTheDocument();
  }
  expect(
    within(dialog).getByRole("combobox", { name: "Permission duration" }),
  ).toBeEnabled();
  expect(getButton("Allow all 3 permissions", dialog)).toBeEnabled();
});

test("A batch card reports saving and then allowed after the user confirms", async () => {
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    return respond(200, {
      isDefaultAgent: false,
      agentId: params.id,
      ownerId: "test-user-123",
      displayName: "Markdown Agent",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "private",
    });
  });
  const save = context.mocks.deferred<void>();
  const items = defaultItems.slice(0, 2);
  installMetadata(items);
  const grants: ConnectorPermissionFixture[] = [];
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, connectorPermissionsResponse(query, grants));
  });
  context.mocks.api(
    connectorPermissionsContract.apply,
    async ({ body, respond }) => {
      await save.promise;
      if (body.target.kind !== "builtin") {
        throw new Error("Expected a builtin connector");
      }
      const { connectorSlug } = body.target;
      grants.push(
        ...body.grants.map((grant) => {
          return {
            connectorSlug,
            permission: grant.permission,
            action: "allow" as const,
            expiresAt: "2099-01-01T00:00:00.000Z",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
          };
        }),
      );
      context.mocks.ably.trigger("connectorPermissionUpdated");
      return respond(200, connectorPermissionsResponse(body.target, grants));
    },
  );

  await openMarkdown(`[Authorize tools](${batchUrl(items).toString()})`, true);
  const card = await screen.findByTestId("permission-batch-action-card");
  await within(card).findByText("2 permissions to allow");
  click(getButton("Review permissions", card));
  const dialog = await screen.findByRole("dialog", {
    name: "Allow the following permissions",
  });
  await waitFor(() => {
    expect(getButton("Allow all 2 permissions", dialog)).toBeEnabled();
  });
  click(getButton("Allow all 2 permissions", dialog));
  await waitFor(() => {
    expect(
      within(screen.getByTestId("permission-batch-action-card")).getByText(
        "Saving...",
      ),
    ).toBeInTheDocument();
  });
  await waitFor(() => {
    expect(
      within(
        screen.getByRole("dialog", { name: "Allow the following permissions" }),
      ).getByRole("combobox", { name: "Permission duration" }),
    ).toBeDisabled();
  });

  save.resolve();
  await waitFor(() => {
    expect(
      within(screen.getByTestId("permission-batch-action-card")).getByText(
        "Permissions allowed",
      ),
    ).toBeInTheDocument();
  });
  click(getButton("Close", dialog));
  await waitFor(() => {
    expect(
      getButton(
        "View permission details",
        screen.getByTestId("permission-batch-action-card"),
      ),
    ).toBeEnabled();
  });
});

test("An invalid batch query renders the unavailable action instead of partial permissions", async () => {
  const url = batchUrl();
  url.searchParams.append("action", "allow");
  await openMarkdown(`[Authorize tools](${url.toString()})`, true);
  await expect(
    screen.findByTestId("unavailable-action-card"),
  ).resolves.toBeInTheDocument();
});

test("A batch link stays an ordinary markdown link while the feature is disabled", async () => {
  const href = batchUrl().toString();
  await openMarkdown(`[Authorize tools](${href})`, false);
  await screen.findByText("Authorize tools");
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent === "Authorize tools";
  });
  expect(link).toHaveAttribute("href", href);
});
