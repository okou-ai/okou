import {
  connectorPermissionsResponse,
  type ConnectorPermissionFixture,
} from "../../../__tests__/connector-permissions.ts";
import {
  connectorPermissionsContract,
  type ApplyConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { UserPermissionGrantBatchItem } from "@okouai/api-contracts/validators/user-permission-grants";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-contracts";
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
import {
  CAPABILITY_AGENT_ID,
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
const featureSwitches = Object.freeze({
  [FeatureSwitchKey.BatchConnectorPermissions]: true,
});
const items: readonly UserPermissionGrantBatchItem[] = [
  {
    connectorSlug: "calendar-service",
    permission: "meeting:read:list_meetings",
  },
  {
    connectorSlug: "calendar-service",
    permission: "meeting:write:create_meeting",
  },
  {
    connectorSlug: "reports-service",
    permission: "reports:read:download_report",
  },
];

function batchUrl(
  args: {
    readonly rows?: readonly unknown[];
    readonly callbackPrompt?: string;
  } = {},
): string {
  const url = new URL(
    `/agents/${CAPABILITY_AGENT_ID}/permissions/batch`,
    "https://app.okou.ai",
  );
  url.searchParams.set("items", JSON.stringify(args.rows ?? items));
  url.searchParams.set("action", "allow");
  url.searchParams.set("expiresIn", "1h");
  if (args.callbackPrompt !== undefined) {
    url.searchParams.set("threadId", RUN_THREAD_ID);
    url.searchParams.set("callbackPrompt", args.callbackPrompt);
  }
  return url.href;
}

function getButton(name: string, container: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

async function openPermissions(
  card: HTMLElement,
  name = "Review permissions",
): Promise<HTMLElement> {
  click(getButton(name, card));
  return await screen.findByRole("dialog", {
    name: "Allow the following permissions",
  });
}

function activeGrant(
  item: UserPermissionGrantBatchItem,
): ConnectorPermissionFixture {
  return {
    ...item,
    action: "allow",
    expiresAt: "2099-08-01T09:00:00.000Z",
  };
}

function installMetadata(): void {
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      return respond(200, {
        permissions: permissionMetadata({
          connectorSlug: params.connectorSlug,
          label:
            params.connectorSlug === "calendar-service"
              ? "Calendar Service"
              : "Reports Service",
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

function installConversation(url: string): void {
  installCapabilityChat({ events: completedConversation(url) });
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

function installGrants(initial: readonly ConnectorPermissionFixture[] = []) {
  let grants = [...initial];
  const applied: ApplyConnectorPermissions[] = [];
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, connectorPermissionsResponse(query, grants));
  });
  context.mocks.api(connectorPermissionsContract.apply, ({ body, respond }) => {
    applied.push(body);
    if (body.target.kind !== "builtin") {
      throw new Error("Expected a builtin connector");
    }
    const { connectorSlug } = body.target;
    const saved = body.grants.map((grant) => {
      return activeGrant({ connectorSlug, permission: grant.permission });
    });
    grants = [...grants, ...saved];
    context.mocks.ably.trigger("connectorPermissionUpdated");
    return respond(200, connectorPermissionsResponse(body.target, grants));
  });
  return applied;
}

test("Review full scopes grouped by connector and apply the selected duration together", async () => {
  const user = userEvent.setup();
  installMetadata();
  const applied = installGrants();
  installConversation(
    batchUrl({
      rows: [
        ...items,
        {
          connectorSlug: "reports-service",
          permission: UNKNOWN_PERMISSION_GRANT,
        },
      ],
    }),
  );

  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches,
  });
  await readyChat();
  const card = await screen.findByTestId("permission-batch-action-card");
  const dialog = await openPermissions(card);
  await waitFor(() => {
    expect(getButton("Allow all 4 permissions", dialog)).toBeEnabled();
  });
  for (const label of ["Calendar Service", "Reports Service"]) {
    expect(
      within(dialog).getByRole("heading", { name: label }),
    ).toBeInTheDocument();
  }
  for (const item of items) {
    const scope = within(dialog).getByText(item.permission, { exact: true });
    const group = scope.closest("section");
    expect(group).not.toBeNull();
    expect(group).toHaveTextContent(
      item.connectorSlug === "calendar-service"
        ? "Calendar Service"
        : "Reports Service",
    );
    expect(
      within(dialog).getByText(`Use ${item.permission}.`),
    ).toBeInTheDocument();
  }
  expect(within(dialog).getByText("other endpoints")).toBeInTheDocument();
  expect(within(dialog).getByText("Other endpoints")).toBeInTheDocument();

  click(within(dialog).getByRole("combobox", { name: "Permission duration" }));
  click(await screen.findByRole("option", { name: "24 hours" }));
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(getButton("Review permissions", card)).toHaveFocus();
  });

  const reopened = await openPermissions(card);
  expect(
    within(reopened).getByRole("combobox", { name: "Permission duration" }),
  ).toHaveTextContent("24 hours");
  click(getButton("Allow all 4 permissions", reopened));

  await expect(
    within(card).findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  expect(within(reopened).getByText("Permissions allowed")).toBeInTheDocument();
  expect(applied).toStrictEqual([
    {
      target: { kind: "builtin", connectorSlug: "calendar-service" },
      mode: "patch",
      grants: items.slice(0, 2).map(({ permission }) => {
        return {
          permission,
          action: "allow",
          expiresIn: "24h",
        };
      }),
    },
    {
      target: { kind: "builtin", connectorSlug: "reports-service" },
      mode: "patch",
      grants: expect.arrayContaining(
        [items[2]!.permission, UNKNOWN_PERMISSION_GRANT].map((permission) => {
          return {
            permission,
            action: "allow",
            expiresIn: "24h",
          };
        }),
      ),
    },
  ]);
  expect(applied[1]!.grants).toHaveLength(2);
});

test("Approve only missing scopes without reapplying or extending active grants", async () => {
  installMetadata();
  const applied = installGrants(items.slice(0, 2).map(activeGrant));
  installConversation(batchUrl());

  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches,
  });
  await readyChat();
  const card = await screen.findByTestId("permission-batch-action-card");
  const dialog = await openPermissions(card);
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", dialog)).toBeEnabled();
  });
  click(getButton("Allow all 3 permissions", dialog));

  await expect(
    within(card).findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  expect(applied).toStrictEqual([
    {
      target: { kind: "builtin", connectorSlug: "reports-service" },
      mode: "patch",
      grants: [
        { permission: items[2]!.permission, action: "allow", expiresIn: "1h" },
      ],
    },
  ]);
});

test("Keep the whole batch unavailable when one connector's delayed authoritative metadata fails", async () => {
  const metadataResponse = context.mocks.deferred<void>();
  context.mocks.api(
    connectorCatalogContract.permissions,
    async ({ params, respond }) => {
      await metadataResponse.promise;
      if (params.connectorSlug === "reports-service") {
        return respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Permission details unavailable",
          },
        });
      }
      return respond(200, {
        permissions: permissionMetadata({
          connectorSlug: params.connectorSlug,
          label: "Calendar Service",
          permissions: items.slice(0, 2).map((item) => {
            return item.permission;
          }),
        }),
      });
    },
  );
  const applied = installGrants();
  installConversation(batchUrl());

  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches,
  });
  await readyChat();
  const card = await screen.findByTestId("permission-batch-action-card");
  const dialog = await openPermissions(card);
  await expect(
    within(dialog).findByLabelText("Loading permissions"),
  ).resolves.toBeInTheDocument();
  expect(getButton("Allow all 3 permissions", dialog)).toBeDisabled();

  metadataResponse.resolve(undefined);
  await expect(within(dialog).findByRole("alert")).resolves.toBeInTheDocument();
  expect(
    within(dialog).getByText("Allow the following permissions"),
  ).toBeInTheDocument();
  expect(
    queryAllByRoleFast("link", dialog).find((link) => {
      return link.textContent?.trim() === "View permission details";
    }),
  ).toBeInTheDocument();
  expect(getButton("Allow all 3 permissions", dialog)).toBeDisabled();
  expect(applied).toHaveLength(0);
});

test("Reject the entire batch with an invalid original row", async () => {
  const url = batchUrl({
    rows: [items[0], { ...items[0], permission: 42 }],
  });
  installMetadata();
  const applied = installGrants();
  installConversation(url);

  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches,
  });
  await readyChat();
  await expect(
    screen.findByTestId("unavailable-action-card"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByTestId("permission-batch-action-card"),
  ).not.toBeInTheDocument();
  expect(applied).toHaveLength(0);
});
