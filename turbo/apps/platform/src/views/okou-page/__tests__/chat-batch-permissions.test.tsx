import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  chatEventsContract,
  chatThreadMetadataContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  userPermissionGrantsContract,
  type ApplyUserPermissionGrantsBatchRequest,
  type UserPermissionGrantBatchItem,
  type UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-contracts";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
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
const firstRuntime = createTestRuntime(context);
const reloadedRuntime = createTestRuntime(context);
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
): UserPermissionGrantResponse {
  return {
    ...item,
    agentId: CAPABILITY_AGENT_ID,
    action: "allow",
    expiresAt: "2099-08-01T09:00:00.000Z",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
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

function installGrants(initial: readonly UserPermissionGrantResponse[] = []) {
  let grants = [...initial];
  const applied: ApplyUserPermissionGrantsBatchRequest[] = [];
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, grants);
  });
  context.mocks.api(
    userPermissionGrantsContract.applyBatch,
    ({ body, respond }) => {
      applied.push(body);
      const saved = body.groups.flatMap((group) => {
        return group.grants.map((grant) => {
          return activeGrant({
            connectorSlug: group.connectorSlug,
            permission: grant.permission,
          });
        });
      });
      grants = [...grants, ...saved];
      return respond(200, saved);
    },
  );
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
      agentId: CAPABILITY_AGENT_ID,
      groups: [
        {
          connectorSlug: "calendar-service",
          grants: items.slice(0, 2).map((item) => {
            return {
              permission: item.permission,
              action: "allow",
              expiresIn: "24h",
            };
          }),
        },
        {
          connectorSlug: "reports-service",
          grants: expect.arrayContaining([
            {
              permission: items[2]!.permission,
              action: "allow",
              expiresIn: "24h",
            },
            {
              permission: UNKNOWN_PERMISSION_GRANT,
              action: "allow",
              expiresIn: "24h",
            },
          ]),
        },
      ],
    },
  ]);
  expect(applied[0]!.groups[1]!.grants).toHaveLength(2);
});

test("Review every scope in a large batch as metadata and grants arrive separately", async () => {
  const metadataResponse = context.mocks.deferred<void>();
  const grantsResponse = context.mocks.deferred<void>();
  const largeBatch = Array.from({ length: 20 }, (_, index) => {
    return {
      connectorSlug: index < 10 ? "calendar-service" : "reports-service",
      permission: `records:read:download_record_${index + 1}`,
    };
  });
  context.mocks.api(
    connectorCatalogContract.permissions,
    async ({ params, respond }) => {
      await metadataResponse.promise;
      return respond(200, {
        permissions: permissionMetadata({
          connectorSlug: params.connectorSlug,
          label:
            params.connectorSlug === "calendar-service"
              ? "Calendar Service"
              : "Reports Service",
          permissions: largeBatch
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
  let grants: UserPermissionGrantResponse[] = [];
  const applied: ApplyUserPermissionGrantsBatchRequest[] = [];
  context.mocks.api(userPermissionGrantsContract.list, async ({ respond }) => {
    await grantsResponse.promise;
    return respond(200, grants);
  });
  context.mocks.api(
    userPermissionGrantsContract.applyBatch,
    ({ body, respond }) => {
      applied.push(body);
      grants = largeBatch.map(activeGrant);
      return respond(200, grants);
    },
  );
  installConversation(batchUrl({ rows: largeBatch }));

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
  expect(getButton("Allow all 20 permissions", dialog)).toBeDisabled();

  metadataResponse.resolve(undefined);
  await expect(
    within(dialog).findByText(largeBatch[19]!.permission, { exact: true }),
  ).resolves.toBeInTheDocument();
  for (const item of largeBatch) {
    expect(
      within(dialog).getByText(item.permission, { exact: true }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(`Use ${item.permission}.`),
    ).toBeInTheDocument();
  }
  expect(getButton("Allow all 20 permissions", dialog)).toBeDisabled();

  grantsResponse.resolve(undefined);
  await waitFor(() => {
    expect(getButton("Allow all 20 permissions", dialog)).toBeEnabled();
  });
  const duration = within(dialog).getByRole("combobox", {
    name: "Permission duration",
  });
  click(duration);
  click(await screen.findByRole("option", { name: "Always" }));
  await expect(
    within(dialog).findByText(
      "These permissions stay allowed until you change or revoke them.",
    ),
  ).resolves.toBeInTheDocument();
  expect(duration).toHaveTextContent("Always");
  click(getButton("Allow all 20 permissions", dialog));

  await expect(
    within(card).findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Permissions allowed")).toBeInTheDocument();
  expect(applied).toStrictEqual([
    {
      agentId: CAPABILITY_AGENT_ID,
      groups: ["calendar-service", "reports-service"].map((connectorSlug) => {
        return {
          connectorSlug,
          grants: expect.arrayContaining(
            largeBatch
              .filter((item) => {
                return item.connectorSlug === connectorSlug;
              })
              .map((item) => {
                return {
                  permission: item.permission,
                  action: "allow",
                  expiresIn: "always",
                };
              }),
          ),
        };
      }),
    },
  ]);
  for (const group of applied[0]!.groups) {
    expect(group.grants).toHaveLength(10);
  }
});

test("Reopen approved permissions and retry only the failed callback", async () => {
  const user = userEvent.setup();
  installMetadata();
  const saveResponse = context.mocks.deferred<void>();
  const callbackResponse = context.mocks.deferred<void>();
  const grants: UserPermissionGrantResponse[] = [];
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, grants);
  });
  const applied: ApplyUserPermissionGrantsBatchRequest[] = [];
  context.mocks.api(
    userPermissionGrantsContract.applyBatch,
    async ({ body, respond }) => {
      applied.push(body);
      await saveResponse.promise;
      grants.push(...items.map(activeGrant));
      return respond(200, grants);
    },
  );
  installConversation(
    batchUrl({ callbackPrompt: "Continue preparing the report" }),
  );
  const sends: ChatEventSendBody[] = [];
  let available = false;
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    sends.push(body);
    await callbackResponse.promise;
    return available
      ? respond(201, { threadId: RUN_THREAD_ID })
      : respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Chat unavailable" },
        });
  });

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
  await waitFor(() => {
    expect(getButton("Saving...", dialog)).toBeDisabled();
  });
  expect(within(dialog).getByText(items[2]!.permission)).toBeInTheDocument();

  saveResponse.resolve(undefined);
  await expect(
    within(card).findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  expect(getButton("Continuing…", dialog)).toBeDisabled();
  expect(within(dialog).getByText(items[2]!.permission)).toBeInTheDocument();

  callbackResponse.resolve(undefined);
  await expect(
    within(dialog).findByText(
      "Permissions allowed, but could not continue. Try continuing again.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getByText("Permissions allowed")).toBeInTheDocument();
  expect(
    within(card).getByText(
      "Permissions allowed, but could not continue. Try continuing again.",
    ),
  ).toBeInTheDocument();
  expect(applied).toHaveLength(1);
  expect(sends).toHaveLength(1);

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(getButton("View permission details", card)).toHaveFocus();
  });
  const reopened = await openPermissions(card, "View permission details");
  expect(
    within(reopened).getByText(
      "Permissions allowed, but could not continue. Try continuing again.",
    ),
  ).toBeInTheDocument();
  expect(getButton("Continue", reopened)).toBeEnabled();

  available = true;
  click(getButton("Continue", reopened));

  await expect(
    within(reopened).findByText("The conversation has continued."),
  ).resolves.toBeInTheDocument();
  expect(
    within(card).getByText("The conversation has continued."),
  ).toBeInTheDocument();
  for (const container of [card, reopened]) {
    expect(
      within(container).queryByText(
        "Permissions allowed, but could not continue. Try continuing again.",
      ),
    ).not.toBeInTheDocument();
  }
  expect(applied).toHaveLength(1);
  expect(sends).toHaveLength(2);
  expect(sends[1]).toMatchObject({
    prompt: "Continue preparing the report",
    threadId: RUN_THREAD_ID,
    clientEventId: sends[0]!.clientEventId,
    chatThreadSortEventId: sends[0]!.chatThreadSortEventId,
  });
});

test("Reauthorize revoked scopes after a callback failure instead of retrying with stale approval", async () => {
  installMetadata();
  let grants: UserPermissionGrantResponse[] = [];
  const applied: ApplyUserPermissionGrantsBatchRequest[] = [];
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, grants);
  });
  context.mocks.api(
    userPermissionGrantsContract.applyBatch,
    ({ body, respond }) => {
      applied.push(body);
      const saved = body.groups.flatMap((group) => {
        return group.grants.map((grant) => {
          return activeGrant({
            connectorSlug: group.connectorSlug,
            permission: grant.permission,
          });
        });
      });
      grants = [...grants, ...saved];
      return respond(200, saved);
    },
  );
  installConversation(
    batchUrl({ callbackPrompt: "Continue only with current access" }),
  );
  let available = false;
  const prompts: (string | undefined)[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    prompts.push(body.prompt);
    return available
      ? respond(201, { threadId: RUN_THREAD_ID })
      : respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Chat unavailable" },
        });
  });

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
    within(dialog).findByText(
      "Permissions allowed, but could not continue. Try continuing again.",
    ),
  ).resolves.toBeInTheDocument();
  expect(getButton("Continue", dialog)).toBeEnabled();

  grants = grants.filter((grant) => {
    return grant.connectorSlug !== "reports-service";
  });
  context.mocks.ably.trigger("connectorPermissionUpdated");
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", dialog)).toBeEnabled();
  });
  expect(
    queryAllByRoleFast("button", dialog).some((button) => {
      return button.textContent?.trim() === "Continue";
    }),
  ).toBeFalsy();
  expect(prompts).toStrictEqual(["Continue only with current access"]);
  expect(applied).toHaveLength(1);

  available = true;
  click(getButton("Allow all 3 permissions", dialog));

  await expect(
    within(dialog).findByText("The conversation has continued."),
  ).resolves.toBeInTheDocument();
  expect(applied).toHaveLength(2);
  expect(applied[1]).toStrictEqual({
    agentId: CAPABILITY_AGENT_ID,
    groups: [
      {
        connectorSlug: "reports-service",
        grants: [
          {
            permission: items[2]!.permission,
            action: "allow",
            expiresIn: "1h",
          },
        ],
      },
    ],
  });
  expect(prompts).toStrictEqual([
    "Continue only with current access",
    "Continue only with current access",
  ]);
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
      agentId: CAPABILITY_AGENT_ID,
      groups: [
        {
          connectorSlug: "reports-service",
          grants: [
            {
              permission: items[2]!.permission,
              action: "allow",
              expiresIn: "1h",
            },
          ],
        },
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

test("Reload from persisted grants with independent callback continuation and no renewed approval", async () => {
  installMetadata();
  const applied = installGrants();
  installConversation(batchUrl({ callbackPrompt: "Continue after reload" }));
  let available = false;
  const prompts: (string | undefined)[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    prompts.push(body.prompt);
    return available
      ? respond(201, { threadId: RUN_THREAD_ID })
      : respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Chat unavailable" },
        });
  });

  await setupPage({
    context: firstRuntime,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches,
  });
  await readyChat();
  const firstCard = await screen.findByTestId("permission-batch-action-card");
  const firstDialog = await openPermissions(firstCard);
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", firstDialog)).toBeEnabled();
  });
  click(getButton("Allow all 3 permissions", firstDialog));
  await expect(
    within(firstDialog).findByText(
      "Permissions allowed, but could not continue. Try continuing again.",
    ),
  ).resolves.toBeInTheDocument();

  firstRuntime.dispose();
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  available = true;
  await setupPage({
    context: reloadedRuntime,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches,
  });
  await readyChat();
  const card = await screen.findByTestId("permission-batch-action-card");
  await expect(
    within(card).findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  const dialog = await openPermissions(card, "View permission details");
  expect(getButton("Continue", dialog)).toBeEnabled();
  expect(prompts).toStrictEqual(["Continue after reload"]);

  click(getButton("Continue", dialog));

  await expect(
    within(dialog).findByText("The conversation has continued."),
  ).resolves.toBeInTheDocument();
  expect(prompts).toStrictEqual([
    "Continue after reload",
    "Continue after reload",
  ]);
  expect(applied).toHaveLength(1);
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

test("A batch save does not empty sibling permission cards during a grants reload", async () => {
  installMetadata();
  const reloadStarted = context.mocks.deferred<void>();
  const reloadResponse = context.mocks.deferred<void>();
  let refreshing = false;
  let grants: UserPermissionGrantResponse[] = [];
  context.mocks.api(userPermissionGrantsContract.list, async ({ respond }) => {
    if (refreshing) {
      // Each card owns a grants read, so the shared reload starts multiple requests.
      if (!reloadStarted.settled()) {
        reloadStarted.resolve(undefined);
      }
      await reloadResponse.promise;
    }
    return respond(200, grants);
  });
  context.mocks.api(
    userPermissionGrantsContract.applyBatch,
    ({ body, respond }) => {
      grants = body.groups.flatMap((group) => {
        return group.grants.map((grant) => {
          return activeGrant({
            connectorSlug: group.connectorSlug,
            permission: grant.permission,
          });
        });
      });
      refreshing = true;
      return respond(200, grants);
    },
  );
  const single = new URL(
    `/agents/${CAPABILITY_AGENT_ID}/permissions`,
    "https://app.okou.ai",
  );
  single.searchParams.set("connectorSlug", "reports-service");
  single.searchParams.set("permission", items[2]!.permission);
  single.searchParams.set("action", "allow");
  installConversation(`${batchUrl()}\n\n${single.href}`);
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches,
  });
  await readyChat();
  const batch = await screen.findByTestId("permission-batch-action-card");
  const sibling = await screen.findByTestId("permission-action-card");
  await waitFor(() => {
    expect(getButton("Confirm", sibling)).toBeEnabled();
  });
  const dialog = await openPermissions(batch);
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", dialog)).toBeEnabled();
  });
  click(getButton("Allow all 3 permissions", dialog));
  await reloadStarted.promise;
  await expect(
    within(batch).findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  click(getButton("Close", dialog));
  await waitFor(() => {
    expect(getButton("Confirm", sibling)).toBeEnabled();
  });
  expect(
    within(sibling).getByText(`Allow ${items[2]!.permission}`, { exact: true }),
  ).toBeInTheDocument();
  reloadResponse.resolve(undefined);
  await expect(
    within(sibling).findByText("Already allowed"),
  ).resolves.toBeInTheDocument();
});
