import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  chatEventsContract,
  chatThreadMetadataContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  userPermissionGrantsContract,
  type UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const AGENT_ID = "10000000-0000-4000-a000-000000000001";
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
}: { permissionDefault?: "ask" | "allow"; failMetadata?: boolean } = {}) {
  const grants: UserPermissionGrantResponse[] = [];
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, {
      isDefaultAgent: false,
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Research Bot",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "private",
    });
  });
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, grants);
  });
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      if (failMetadata && params.connectorSlug === "github") {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector unavailable" },
        });
      }
      const permission =
        params.connectorSlug === "slack" ? "chat:write" : "issues:read";
      return respond(200, {
        permissions: {
          connectorSlug: params.connectorSlug,
          label: params.connectorSlug === "slack" ? "Slack" : "GitHub",
          icon: {
            url: `https://assets.example.test/${params.connectorSlug}.svg`,
            invertInDarkMode: false,
          },
          permissionCount: 1,
          permissions: [
            { name: permission, description: `Description for ${permission}` },
          ],
          categories: null,
          defaultPolicy: { permissionDefault, unknownPolicy: "ask" },
        },
      });
    },
  );
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(200, {
      id: THREAD_ID,
      agentId: AGENT_ID,
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
}: { callback?: boolean; malformed?: boolean } = {}) {
  const params = new URLSearchParams({
    items: malformed ? "not-json" : JSON.stringify(items),
    action: "allow",
  });
  if (callback) {
    params.set("threadId", THREAD_ID);
    params.set("callbackPrompt", "Continue the review");
  }
  return setupPage({
    context,
    host: "app.okou.ai",
    path: `/agents/${AGENT_ID}/permissions/batch?${params}`,
    featureSwitches: { [FeatureSwitchKey.BatchConnectorPermissions]: true },
  });
}

test("A user allows grouped permissions once and retries only a failed continuation", async () => {
  const grants = installResources();
  const callbackResponse = context.mocks.deferred<void>();
  let firstCallback = true;
  const sent: ChatEventSendBody[] = [];
  const applied: string[] = [];
  context.mocks.api(
    userPermissionGrantsContract.applyBatch,
    ({ body, respond }) => {
      for (const group of body.groups) {
        for (const grant of group.grants) {
          expect(grant.expiresIn).toBe("1h");
          applied.push(`${group.connectorSlug}:${grant.permission}`);
          grants.push({
            agentId: AGENT_ID,
            connectorSlug: group.connectorSlug,
            permission: grant.permission,
            action: "allow",
            expiresAt: "2099-01-01T00:00:00.000Z",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z",
          });
        }
      }
      return respond(200, grants);
    },
  );
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    sent.push(body);
    if (firstCallback) {
      firstCallback = false;
      await callbackResponse.promise;
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Try again" },
      });
    }
    return respond(201, { threadId: THREAD_ID });
  });
  await openPage({ callback: true });
  await screen.findByText("Description for chat:write");
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
  // Save success is visible while the callback is still pending.
  callbackResponse.resolve(undefined);
  await screen.findByText(
    "Permissions allowed, but could not continue. Try continuing again.",
  );
  click(button("Continue"));
  await screen.findByText("The conversation has continued.");
  expect(applied.sort()).toStrictEqual([
    "github:issues:read",
    "slack:chat:write",
  ]);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toStrictEqual(sent[0]);
});

test("A fresh revoked grant list supersedes save success after a callback failure", async () => {
  const grants = installResources();
  let revoked = false;
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, revoked ? [] : grants);
  });
  context.mocks.api(
    userPermissionGrantsContract.applyBatch,
    ({ body, respond }) => {
      grants.push(
        ...body.groups.flatMap((group) => {
          return group.grants.map((grant) => {
            return {
              agentId: AGENT_ID,
              connectorSlug: group.connectorSlug,
              permission: grant.permission,
              action: "allow" as const,
              expiresAt: "2099-01-01T00:00:00.000Z",
              createdAt: "2030-01-01T00:00:00.000Z",
              updatedAt: "2030-01-01T00:00:00.000Z",
            };
          });
        }),
      );
      return respond(200, grants);
    },
  );
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Try again" },
    });
  });
  await openPage({ callback: true });
  await screen.findByText("Description for chat:write");
  await waitFor(() => {
    expect(button("Allow all 2 permissions")).toBeEnabled();
  });
  click(button("Allow all 2 permissions"));
  await screen.findByText(
    "Permissions allowed, but could not continue. Try continuing again.",
  );
  expect(screen.getByText("2 of 2 permissions allowed")).toBeInTheDocument();
  revoked = true;
  click(button("Continue"));
  await screen.findByText("0 of 2 permissions allowed");
  await waitFor(() => {
    expect(button("Allow all 2 permissions")).toBeEnabled();
  });
});

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

test("A malformed batch URL renders an unavailable page", async () => {
  await openPage({ malformed: true });
  await expect(
    screen.findByText("This permission link is invalid or unavailable."),
  ).resolves.toBeInTheDocument();
});

test("A successful HTTP response without all grant acknowledgments cannot continue", async () => {
  installResources();
  context.mocks.api(userPermissionGrantsContract.applyBatch, ({ respond }) => {
    return respond(200, []);
  });
  await openPage({ callback: true });
  await screen.findByText("Description for chat:write");
  await waitFor(() => {
    expect(button("Allow all 2 permissions")).toBeEnabled();
  });
  click(button("Allow all 2 permissions"));
  await screen.findByRole("alert");
  expect(screen.getByText("0 of 2 permissions allowed")).toBeInTheDocument();
  expect(button("Allow all 2 permissions")).toBeEnabled();
  expect(
    screen.queryByText("Permissions allowed", { exact: true }),
  ).not.toBeInTheDocument();
});
