import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  chatEventsContract,
  chatThreadMetadataContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  userPermissionGrantsContract,
  type ApplyUserPermissionGrantsBatchRequest,
  type UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor } from "@testing-library/react";
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

test.each([
  {
    outcome: "success",
    message: "The conversation has continued.",
  },
  {
    outcome: "failure",
    message: /^Permissions allowed, but could not continue\./u,
  },
] as const)(
  "Grouped permissions remain allowed after continuation $outcome",
  async ({ outcome, message }) => {
    const grants = installResources();
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
        context.mocks.ably.trigger("connectorPermissionUpdated");
        return respond(200, grants);
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
  },
);

test.each(["dismissed", "continued"] as const)(
  "Navigating from a %s batch isolates the next agent's permissions and continuation",
  async (firstOutcome) => {
    const nextAgentId = "10000000-0000-4000-a000-000000000002";
    const nextThreadId = "20000000-0000-4000-a000-000000000002";
    const grants = installResources();
    const applied: ApplyUserPermissionGrantsBatchRequest[] = [];
    const sent: ChatEventSendBody[] = [];
    context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        isDefaultAgent: false,
        agentId: params.id,
        ownerId: "test-user-123",
        displayName: params.id === nextAgentId ? "Next Bot" : "Research Bot",
        description: null,
        sound: null,
        avatarUrl: null,
        visibility: "private",
      });
    });
    context.mocks.api(
      userPermissionGrantsContract.list,
      ({ query, respond }) => {
        return respond(
          200,
          grants.filter((grant) => {
            return grant.agentId === query.agentId;
          }),
        );
      },
    );
    context.mocks.api(
      userPermissionGrantsContract.applyBatch,
      ({ body, respond }) => {
        applied.push(body);
        const saved = body.groups.flatMap((group) => {
          return group.grants.map((grant) => {
            return {
              agentId: body.agentId,
              connectorSlug: group.connectorSlug,
              permission: grant.permission,
              action: "allow" as const,
              expiresAt: "2099-01-01T00:00:00.000Z",
              createdAt: "2030-01-01T00:00:00.000Z",
              updatedAt: "2030-01-01T00:00:00.000Z",
            };
          });
        });
        grants.push(...saved);
        context.mocks.ably.trigger("connectorPermissionUpdated");
        return respond(200, saved);
      },
    );
    context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        agentId: params.id === nextThreadId ? nextAgentId : AGENT_ID,
        title: "Review",
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
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      sent.push(body);
      return respond(201, { threadId: body.threadId ?? THREAD_ID });
    });

    await openPage({ callback: true });
    await waitFor(() => {
      expect(button("Allow all 2 permissions")).toBeEnabled();
    });
    click(screen.getByRole("combobox", { name: "Permission duration" }));
    click(await screen.findByRole("option", { name: "24 hours" }));
    if (firstOutcome === "dismissed") {
      click(button("Not now"));
      await screen.findByText("No permissions were changed.");
    } else {
      click(button("Allow all 2 permissions"));
      await screen.findByText("The conversation has continued.");
    }

    const nextParams = new URLSearchParams({
      items: JSON.stringify([items[1]]),
      action: "allow",
      threadId: nextThreadId,
      callbackPrompt: "Continue the next agent's review",
    });
    act(() => {
      window.history.pushState(
        null,
        "",
        `/agents/${nextAgentId}/permissions/batch?${nextParams}`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    await screen.findByText("Next Bot");
    await waitFor(() => {
      expect(button("Allow 1 permission")).toBeEnabled();
    });
    expect(screen.getByText("Description for issues:read")).toBeInTheDocument();
    expect(screen.getByLabelText("Permission duration")).toHaveTextContent(
      "1 hour",
    );
    click(button("Allow 1 permission"));
    await screen.findByText("The conversation has continued.");
    expect(applied.at(-1)).toStrictEqual({
      agentId: nextAgentId,
      groups: [
        {
          connectorSlug: "github",
          grants: [
            { permission: "issues:read", action: "allow", expiresIn: "1h" },
          ],
        },
      ],
    });
    expect(sent.at(-1)).toMatchObject({
      threadId: nextThreadId,
      prompt: "Continue the next agent's review",
    });
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
  expect(button("Allow all 2 permissions")).toBeDisabled();
  expect(
    screen.queryByText("Permissions allowed", { exact: true }),
  ).not.toBeInTheDocument();
});
