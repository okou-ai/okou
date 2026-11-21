import {
  connectorPermissionsResponse,
  type ConnectorPermissionFixture,
} from "../../../__tests__/connector-permissions.ts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  chatEventsContract,
  chatThreadMetadataContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  connectorPermissionsContract,
  type ConnectorPermissions,
  type ApplyConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const THREAD_ID = "20000000-0000-4000-a000-000000000001";
const items = [
  { connectorSlug: "slack", permission: "chat:write" },
  { connectorSlug: "github", permission: "issues:read" },
] as const;

function button(text: string) {
  const result = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!result) {
    throw new Error(`Button not found: ${text}`);
  }
  return result;
}

function installResources({
  permissionDefault = "ask",
  failMetadata = false,
}: {
  permissionDefault?: "ask" | "allow" | "deny";
  failMetadata?: boolean;
} = {}) {
  const grants: ConnectorPermissionFixture[] = [];
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, connectorPermissionsResponse(query, grants));
  });
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      if (failMetadata && params.connectorSlug === "github") {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector unavailable" },
        });
      }
      const permissions =
        params.connectorSlug === "neon"
          ? ["branches:create", "branches:delete"]
          : params.connectorSlug === "slack"
            ? ["chat:write"]
            : ["issues:read", "issues:write"];
      return respond(200, {
        permissions: {
          connectorSlug: params.connectorSlug,
          label: params.connectorSlug === "slack" ? "Slack" : "GitHub",
          icon: {
            url: `https://assets.example.test/${params.connectorSlug}.svg`,
            invertInDarkMode: false,
          },
          permissionCount: permissions.length,
          permissions: permissions.map((permission) => {
            return {
              name: permission,
              description: `Description for ${permission}`,
            };
          }),
          categories: null,
          defaultPolicy: { permissionDefault, unknownPolicy: "ask" },
        },
      });
    },
  );
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(200, {
      id: THREAD_ID,
      title: "Review",
      selectedModel: "claude-sonnet-5",
      modelSettings: {},
      serviceTier: null,
      pinnedAt: null,
      archived: false,
      muted: false,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });
  return grants;
}

function openPage({
  callback = false,
  malformed = false,
  memberItems,
}: {
  memberItems?: readonly { connectorSlug: string; permission: string }[];
  callback?: boolean;
  malformed?: boolean;
} = {}) {
  const params = new URLSearchParams({
    items: malformed ? "not-json" : JSON.stringify(memberItems ?? items),
    action: "allow",
  });
  if (callback) {
    params.set("threadId", THREAD_ID);
    params.set("callbackPrompt", "Continue the review");
  }
  return setupPage({
    context,
    host: "app.okou.ai",
    path: `/connectors/permissions/batch?orgId=org_default&userId=test-user-123&${params}`,
    featureSwitches: {
      [FeatureSwitchKey.BatchConnectorPermissions]: true,
    },
  });
}

test.each([
  {
    outcome: "success",
    message: "The chat has continued.",
  },
  {
    outcome: "failure",
    message: /^Permissions allowed, but could not continue\./u,
  },
] as const)(
  "Grouped permissions remain allowed after continuation $outcome",
  async ({ outcome, message }) => {
    installResources();
    const applied: string[] = [];
    const durations: string[] = [];
    const shared = new Map<string, ConnectorPermissions["grants"]>();
    context.mocks.api(
      connectorPermissionsContract.get,
      ({ query, respond }) => {
        return respond(200, {
          target: query,
          grants:
            shared.get(
              query.kind === "builtin"
                ? query.connectorSlug
                : query.customConnectorId,
            ) ?? [],
        });
      },
    );
    context.mocks.api(
      connectorPermissionsContract.apply,
      ({ body, respond }) => {
        if (body.target.kind !== "builtin") {
          throw new Error("Expected builtin target");
        }
        const connectorSlug = body.target.connectorSlug;
        for (const grant of body.grants) {
          durations.push(String(grant.expiresIn));
          applied.push(`${connectorSlug}:${grant.permission}`);
        }
        const saved = body.grants.map((grant) => {
          return {
            permission: grant.permission,
            action: grant.action,
            expiresAt: "2099-01-01T00:00:00.000Z",
          };
        });
        shared.set(connectorSlug, saved);
        return respond(200, {
          target: body.target,
          grants: saved,
        });
      },
    );
    context.mocks.api(chatEventsContract.send, ({ respond }) => {
      return outcome === "success"
        ? respond(201, { threadId: THREAD_ID })
        : respond(500, {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Chat unavailable",
            },
          });
    });
    await openPage({ callback: true });
    await screen.findByText("Description for chat:write");
    const scope =
      "Applies to this connector across your chats in this workspace. Your teammates have their own permissions.";
    expect(screen.getByText(scope)).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Description for issues:read")).toBeInTheDocument();
    expect(screen.getByLabelText("Permission duration")).toHaveTextContent(
      "1 hour",
    );
    await waitFor(() => {
      expect(button("Allow all 2 permissions")).toBeEnabled();
    });
    click(button("Allow all 2 permissions"));
    await screen.findByText("Permissions allowed");
    await expect(screen.findByText(message)).resolves.toBeInTheDocument();
    expect(screen.getByText("2 of 2 permissions allowed")).toBeInTheDocument();
    expect(applied.sort()).toStrictEqual([
      "github:issues:read",
      "slack:chat:write",
    ]);
    expect(durations).toStrictEqual(["1h", "1h"]);
  },
);

test("Policy-allowed batches show their completed state without requiring a grant", async () => {
  installResources({ permissionDefault: "allow" });
  await openPage();
  await screen.findByText("Permissions allowed");
  expect(screen.getByText("Description for chat:write")).toBeInTheDocument();
});

test("Missing connector metadata fails closed and Not now dismisses without changing permissions", async () => {
  installResources({ failMetadata: true });
  await openPage();
  await screen.findByText(
    "Could not verify all requested permissions. No permissions can be changed.",
  );
  expect(button("Allow all 2 permissions")).toBeDisabled();
  click(button("Not now"));
  await screen.findByText("No permissions were changed.");
});

const neonBranchItems = [
  { connectorSlug: "neon", permission: "branches:create" },
  { connectorSlug: "neon", permission: "branches:delete" },
] as const;

test("The requesting member confirms both Neon permissions for one hour before the originating chat continues", async () => {
  const startedAt = Date.parse("2026-11-05T12:00:00Z");
  mockNow(startedAt, context.signal);
  const grants = installResources({ permissionDefault: "deny" });
  const writes: ApplyConnectorPermissions[] = [];
  const callbacks: ChatEventSendBody[] = [];
  context.mocks.api(connectorPermissionsContract.apply, ({ body, respond }) => {
    writes.push(body);
    for (const item of neonBranchItems) {
      grants.push({
        ...item,
        action: "allow",
        expiresAt: new Date(startedAt + 60 * 60 * 1000).toISOString(),
      });
    }
    return respond(200, connectorPermissionsResponse(body.target, grants));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    callbacks.push(body);
    return respond(201, { threadId: THREAD_ID });
  });
  await openPage({ callback: true, memberItems: neonBranchItems });
  await screen.findByText("Description for branches:delete");
  expect(writes).toHaveLength(0);
  expect(callbacks).toHaveLength(0);
  const duration = screen.getByRole("combobox", {
    name: "Permission duration",
  });
  click(duration);
  click(await screen.findByRole("option", { name: "24 hours" }));
  click(duration);
  click(await screen.findByRole("option", { name: "1 hour" }));
  expect(duration).toHaveTextContent("1 hour");
  click(button("Allow all 2 permissions"));
  await screen.findByText("The chat has continued.");
  expect(writes).toStrictEqual([
    {
      target: { kind: "builtin", connectorSlug: "neon" },
      mode: "patch",
      grants: neonBranchItems.map(({ permission }) => {
        return {
          permission,
          action: "allow",
          expiresIn: "1h",
        };
      }),
    },
  ]);
  expect(callbacks).toMatchObject([
    { threadId: THREAD_ID, prompt: "Continue the review" },
  ]);
});

test.each([
  { offset: -1, summary: "2 of 2 permissions allowed" },
  { offset: 0, summary: "0 of 2 permissions allowed" },
])(
  "Both temporary Neon grants reflect the one-hour boundary at offset $offset",
  async ({ offset, summary }) => {
    const deadline = Date.parse("2026-11-05T13:00:00Z");
    mockNow(deadline + offset, context.signal);
    const grants = installResources({ permissionDefault: "deny" });
    for (const item of neonBranchItems) {
      grants.push({
        ...item,
        action: "allow",
        expiresAt: new Date(deadline).toISOString(),
      });
    }
    await openPage({ memberItems: neonBranchItems });
    await screen.findByText("Description for branches:create");
    await expect(screen.findByText(summary)).resolves.toBeInTheDocument();
  },
);

test("An unavailable callback Chat prevents a member batch from being confirmed", async () => {
  installResources();
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
  });
  await openPage({ callback: true, memberItems: items });
  await screen.findByText(
    "Could not verify all requested permissions. No permissions can be changed.",
  );
  expect(
    queryAllByRoleFast("button").some((element) => {
      return (
        element.textContent?.trim() === "Allow all 2 permissions" &&
        !element.hasAttribute("disabled")
      );
    }),
  ).toBeFalsy();
});

test("A member cannot confirm after losing access to the callback Chat", async () => {
  installResources();
  await openPage({ callback: true, memberItems: items });
  await screen.findByText("Description for chat:write");
  const confirm = button("Allow all 2 permissions");
  await waitFor(() => {
    expect(confirm).toBeEnabled();
  });
  let writes = 0;
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Chat thread not found" },
    });
  });
  context.mocks.api(connectorPermissionsContract.apply, ({ respond }) => {
    writes++;
    return respond(200, {
      target: { kind: "builtin", connectorSlug: "slack" },
      grants: [],
    });
  });
  click(confirm);
  await screen.findByRole("alert");
  expect(writes).toBe(0);
});

test("A malformed batch URL renders an unavailable page", async () => {
  await openPage({ malformed: true });
  await expect(
    screen.findByText("This permission link is invalid or unavailable."),
  ).resolves.toBeInTheDocument();
});

test("A successful HTTP response without all grant acknowledgments cannot continue", async () => {
  installResources();
  context.mocks.api(connectorPermissionsContract.apply, ({ body, respond }) => {
    return respond(200, connectorPermissionsResponse(body.target, []));
  });
  await openPage({ callback: true });
  await screen.findByText("Description for chat:write");
  await waitFor(() => {
    expect(button("Allow all 2 permissions")).toBeEnabled();
  });
  click(button("Allow all 2 permissions"));
  await screen.findByRole("alert");
  expect(screen.getByText("0 of 2 permissions allowed")).toBeInTheDocument();
  expect(button("Allow all 2 permissions")).toBeDisabled();
  expect(
    screen.queryByText("Permissions allowed", { exact: true }),
  ).not.toBeInTheDocument();
});
