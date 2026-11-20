import { connectorPermissionsResponse } from "../../../__tests__/connector-permissions.ts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorPermissionsContract,
  type ApplyConnectorPermissions,
  type ConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
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
import { permissionMetadata } from "./chat-capability-connector-test-helpers.ts";
import { getConnectorAction } from "./connector-page-test-helpers.ts";
import {
  CAPABILITY_AGENT_ID,
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const SERVICE_LABELS: Readonly<Record<string, string>> = {
  slack: "Slack",
  github: "GitHub",
  "google-drive": "Google Drive",
  notion: "Notion",
  linear: "Linear",
};

type SavedGrant = ConnectorPermissions["grants"][number] & {
  readonly connectorSlug: string;
};

function batchMarkdown(items: readonly UserPermissionGrantBatchItem[]): string {
  const url = new URL(
    `/agents/${CAPABILITY_AGENT_ID}/permissions/batch`,
    "https://app.okou.ai",
  );
  url.searchParams.set("items", JSON.stringify(items));
  url.searchParams.set("action", "allow");
  url.searchParams.set("expiresIn", "1h");
  return `I need a few more permissions to finish the report.\n\n[Review permissions](${url.href})\n\nI will continue once they are allowed.`;
}

function installBatchConversation(
  items: readonly UserPermissionGrantBatchItem[],
): void {
  installCapabilityChat({
    events: completedConversation(batchMarkdown(items)),
  });
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      agentId: CAPABILITY_AGENT_ID,
      title: "Capability conversation",
      selectedModel: null,
      modelSettings: {},
      serviceTier: null,
      pinnedAt: null,
      archived: false,
      muted: false,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });
}

function installServiceDetails(
  items: readonly UserPermissionGrantBatchItem[],
  beforeResponse?: () => Promise<void>,
): void {
  context.mocks.api(
    connectorCatalogContract.permissions,
    async ({ params, respond }) => {
      await beforeResponse?.();
      return respond(200, {
        permissions: permissionMetadata({
          connectorSlug: params.connectorSlug,
          label: SERVICE_LABELS[params.connectorSlug] ?? params.connectorSlug,
          permissions: items
            .filter((item) => {
              return item.connectorSlug === params.connectorSlug;
            })
            .map((item) => {
              return item.permission;
            }),
        }),
      });
    },
  );
}

function installSavedGrants(
  initial: readonly SavedGrant[],
  beforeApply?: () => Promise<void>,
): ApplyConnectorPermissions[] {
  let grants = [...initial];
  const applied: ApplyConnectorPermissions[] = [];
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, connectorPermissionsResponse(query, grants));
  });
  context.mocks.api(
    connectorPermissionsContract.apply,
    async ({ body, respond }) => {
      applied.push(body);
      await beforeApply?.();
      if (body.target.kind !== "builtin") {
        throw new Error("Expected a built-in connector");
      }
      const { connectorSlug } = body.target;
      grants = [
        ...grants,
        ...body.grants.map((grant) => {
          return {
            connectorSlug,
            permission: grant.permission,
            action: "allow" as const,
            expiresAt: "2099-08-01T09:00:00.000Z",
          };
        }),
      ];
      context.mocks.ably.trigger("connectorPermissionUpdated");
      return respond(200, connectorPermissionsResponse(body.target, grants));
    },
  );
  return applied;
}

async function openBatchCard(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BatchConnectorPermissions]: true },
  });
  await readyChat();
  return await screen.findByTestId("permission-batch-action-card");
}

function cardButton(card: HTMLElement, name: string): HTMLElement {
  const button = queryAllByRoleFast("button", card).find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === name;
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

async function reviewPermissions(card: HTMLElement): Promise<HTMLElement> {
  click(cardButton(card, "Review permissions"));
  return await screen.findByRole("dialog", {
    name: "Allow the following permissions",
  });
}

test("A batch card shows three service logos and exposes every service in its overflow tooltip", async () => {
  const user = userEvent.setup();
  const items = Object.keys(SERVICE_LABELS).map((connectorSlug) => {
    return { connectorSlug, permission: `${connectorSlug}:read` };
  });
  installServiceDetails(items);
  installSavedGrants([]);
  installBatchConversation(items);

  const card = await openBatchCard();

  await expect(
    within(card).findByText("5 permissions to allow"),
  ).resolves.toBeInTheDocument();
  const services = getConnectorAction(
    "button",
    "GitHub, Google Drive, Linear, Notion, Slack",
    card,
  );
  expect(services.querySelectorAll("img")).toHaveLength(3);
  expect(services).toHaveTextContent("+2");

  await user.hover(services);

  await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
    "GitHub, Google Drive, Linear, Notion, Slack",
  );
});

test("A partially allowed batch shows the remaining permission count", async () => {
  const items = [
    { connectorSlug: "slack", permission: "files:read" },
    { connectorSlug: "github", permission: "repos.read" },
  ];
  installServiceDetails(items);
  installSavedGrants([
    {
      connectorSlug: "slack",
      permission: "files:read",
      action: "allow",
      expiresAt: "2099-08-01T09:00:00.000Z",
    },
  ]);
  installBatchConversation(items);

  const card = await openBatchCard();

  await expect(
    within(card).findByText("1 permission to allow"),
  ).resolves.toBeInTheDocument();
  expect(within(card).getByText("1 already allowed")).toBeInTheDocument();
  expect(cardButton(card, "Review permissions")).toBeEnabled();
});

test("A batch stays reviewable while service details load and enables duration only when ready", async () => {
  const items = [
    { connectorSlug: "slack", permission: "files:read" },
    { connectorSlug: "slack", permission: "chat:write" },
    { connectorSlug: "github", permission: "repos.read" },
  ];
  const details = context.mocks.deferred<void>();
  installServiceDetails(items, () => {
    return details.promise;
  });
  installSavedGrants([]);
  installBatchConversation(items);

  const card = await openBatchCard();
  expect(within(card).getByText("Loading permissions")).toBeInTheDocument();
  expect(cardButton(card, "Review permissions")).toBeEnabled();

  const dialog = await reviewPermissions(card);
  expect(within(dialog).getByText("Loading permissions")).toBeInTheDocument();
  const loadingGroups = Array.from(dialog.querySelectorAll("section")).map(
    (group) => {
      return group.querySelectorAll("li").length;
    },
  );
  expect(loadingGroups).toHaveLength(2);
  expect(loadingGroups).toStrictEqual(expect.arrayContaining([2, 1]));
  expect(
    within(dialog).getByRole("combobox", { name: "Permission duration" }),
  ).toBeDisabled();
  expect(cardButton(dialog, "Allow all 3 permissions")).toBeDisabled();

  details.resolve();

  await waitFor(() => {
    expect(cardButton(dialog, "Allow all 3 permissions")).toBeEnabled();
  });
  expect(
    within(dialog).getByRole("combobox", { name: "Permission duration" }),
  ).toBeEnabled();
  for (const label of ["Slack", "GitHub"]) {
    expect(
      within(dialog).getByRole("heading", { name: label }),
    ).toBeInTheDocument();
  }
  for (const item of items) {
    expect(
      within(dialog).getByText(item.permission, { exact: true }),
    ).toBeInTheDocument();
  }
  expect(within(dialog).queryByText("Loading permissions")).toBeNull();
});

test("A batch card reports saving and then allowed after the user confirms", async () => {
  const items = [
    { connectorSlug: "slack", permission: "files:read" },
    { connectorSlug: "slack", permission: "chat:write" },
  ];
  const saved = context.mocks.deferred<void>();
  installServiceDetails(items);
  const applied = installSavedGrants([], () => {
    return saved.promise;
  });
  installBatchConversation(items);

  const card = await openBatchCard();
  const dialog = await reviewPermissions(card);
  await waitFor(() => {
    expect(cardButton(dialog, "Allow all 2 permissions")).toBeEnabled();
  });

  click(cardButton(dialog, "Allow all 2 permissions"));

  await expect(
    within(card).findByText("Saving..."),
  ).resolves.toBeInTheDocument();
  expect(
    within(dialog).getByRole("combobox", { name: "Permission duration" }),
  ).toBeDisabled();
  expect(applied).toHaveLength(1);

  saved.resolve();

  await expect(
    within(card).findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  click(getConnectorAction("button", "Close", dialog));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(cardButton(card, "View permission details")).toBeEnabled();
});
