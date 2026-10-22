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
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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

function installMetadata(unavailableSlug?: string): void {
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      if (params.connectorSlug === unavailableSlug) {
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
  installMetadata();
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
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", card)).toBeEnabled();
  });
  for (const label of ["Calendar Service", "Reports Service"]) {
    expect(
      within(card).getByRole("heading", { name: label }),
    ).toBeInTheDocument();
  }
  for (const item of items) {
    const scope = within(card).getByText(item.permission, { exact: true });
    const group = scope.closest("section");
    expect(group).not.toBeNull();
    expect(group).toHaveTextContent(
      item.connectorSlug === "calendar-service"
        ? "Calendar Service"
        : "Reports Service",
    );
    expect(
      within(card).getByText(`Use ${item.permission}.`),
    ).toBeInTheDocument();
  }

  click(within(card).getByRole("combobox", { name: "Permission duration" }));
  click(await screen.findByRole("option", { name: "24 hours" }));
  click(getButton("Allow all 3 permissions", card));

  await expect(
    within(card).findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
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
          grants: [
            {
              permission: items[2]!.permission,
              action: "allow",
              expiresIn: "24h",
            },
          ],
        },
      ],
    },
  ]);
});

test("Retry only the callback after batch approval succeeds but sending fails", async () => {
  installMetadata();
  const applied = installGrants();
  installConversation(
    batchUrl({ callbackPrompt: "Continue preparing the report" }),
  );
  const sends: ChatEventSendBody[] = [];
  let available = false;
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    sends.push(body);
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
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", card)).toBeEnabled();
  });
  click(getButton("Allow all 3 permissions", card));

  await expect(
    within(card).findByText(
      "Permissions allowed, but could not continue. Try continuing again.",
    ),
  ).resolves.toBeInTheDocument();
  expect(within(card).getByText("Permissions allowed")).toBeInTheDocument();
  expect(applied).toHaveLength(1);
  expect(sends).toHaveLength(1);

  available = true;
  click(getButton("Continue", card));

  await expect(
    within(card).findByText("The conversation has continued."),
  ).resolves.toBeInTheDocument();
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
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", card)).toBeEnabled();
  });
  click(getButton("Allow all 3 permissions", card));
  await expect(
    within(card).findByText(
      "Permissions allowed, but could not continue. Try continuing again.",
    ),
  ).resolves.toBeInTheDocument();
  expect(getButton("Continue", card)).toBeEnabled();

  grants = grants.filter((grant) => {
    return grant.connectorSlug !== "reports-service";
  });
  context.mocks.ably.trigger("connectorPermissionUpdated");
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", card)).toBeEnabled();
  });
  expect(
    queryAllByRoleFast("button", card).some((button) => {
      return button.textContent?.trim() === "Continue";
    }),
  ).toBeFalsy();
  expect(prompts).toStrictEqual(["Continue only with current access"]);
  expect(applied).toHaveLength(1);

  available = true;
  click(getButton("Allow all 3 permissions", card));

  await expect(
    within(card).findByText("The conversation has continued."),
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
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", card)).toBeEnabled();
  });
  click(getButton("Allow all 3 permissions", card));

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

test("Keep the whole batch unavailable when one connector's authoritative metadata cannot load", async () => {
  installMetadata("reports-service");
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
  await expect(within(card).findByRole("alert")).resolves.toBeInTheDocument();
  expect(getButton("Allow all 3 permissions", card)).toBeDisabled();
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
  await waitFor(() => {
    expect(getButton("Allow all 3 permissions", firstCard)).toBeEnabled();
  });
  click(getButton("Allow all 3 permissions", firstCard));
  await expect(
    within(firstCard).findByText(
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
  expect(getButton("Continue", card)).toBeEnabled();
  expect(prompts).toStrictEqual(["Continue after reload"]);

  click(getButton("Continue", card));

  await expect(
    within(card).findByText("The conversation has continued."),
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
    expect(getButton("Allow all 3 permissions", batch)).toBeEnabled();
    expect(getButton("Confirm", sibling)).toBeEnabled();
  });
  click(getButton("Allow all 3 permissions", batch));
  await reloadStarted.promise;
  await expect(
    within(batch).findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  expect(
    within(sibling).getByText(`Allow ${items[2]!.permission}`, { exact: true }),
  ).toBeInTheDocument();
  expect(getButton("Confirm", sibling)).toBeEnabled();
  reloadResponse.resolve(undefined);
  await expect(
    within(sibling).findByText("Already allowed"),
  ).resolves.toBeInTheDocument();
});
