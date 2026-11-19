import { agentsByIdContract } from "@okouai/api-contracts/client/agents";
import { chatEventsContract } from "@okouai/api-contracts/client/chat-event-send";
import { chatThreadMetadataContract } from "@okouai/api-contracts/client/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  APPROVING_AGENT,
  PERMISSION_NOW,
  mockPermissionCatalog,
  mockPermissionGrants,
  permissionButton,
} from "./permission-test-fixtures.ts";

const context = testContext();
const secondAgent = "c0000000-0000-4000-a000-000000000002";
const threadId = "a0000000-0000-4000-a000-000000000001";
const secondThread = "a0000000-0000-4000-a000-000000000002";
const requested = [
  { connectorSlug: "slack", permission: "chat:write" },
  { connectorSlug: "github", permission: "issues:read" },
];

function batchPath(
  options: {
    agent?: string;
    items?: typeof requested;
    thread?: string;
    prompt?: string;
    duration?: string;
  } = {},
) {
  const query = new URLSearchParams({
    items: JSON.stringify(options.items ?? requested),
    action: "allow",
    expiresIn: options.duration ?? "1h",
  });
  if (options.thread && options.prompt) {
    query.set("threadId", options.thread);
    query.set("callbackPrompt", options.prompt);
  }
  return `/agents/${options.agent ?? APPROVING_AGENT}/permissions/batch?${query}`;
}

function mockCallbackTargets() {
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    return respond(200, {
      id: params.id,
      agentId: params.id === secondThread ? secondAgent : APPROVING_AGENT,
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
}

async function openBatch(path = batchPath()) {
  mockNow(new Date(PERMISSION_NOW), context.signal);
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.BatchConnectorPermissions]: true,
      [FeatureSwitchKey.SingleAgent]: false,
    },
  });
}

async function confirmGroupedPermissions(
  outcome: "succeeds" | "fails",
  resultMessage: string,
) {
  mockPermissionCatalog(context);
  const { writes, saved } = mockPermissionGrants(context);
  mockCallbackTargets();
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body).toMatchObject({
      agentId: APPROVING_AGENT,
      threadId,
      prompt: "Continue the investigation",
    });
    expect(saved.get("slack")).toMatchObject([
      { permission: "chat:write", action: "allow" },
    ]);
    expect(saved.get("github")).toMatchObject([
      { permission: "issues:read", action: "allow" },
    ]);
    if (outcome === "fails") {
      return respond(500, {
        error: { code: "INTERNAL_SERVER_ERROR", message: "Chat unavailable" },
      });
    }
    return respond(201, { threadId });
  });

  await openBatch(
    batchPath({ thread: threadId, prompt: "Continue the investigation" }),
  );
  expect(
    screen.getByText(
      "Applies to this connector across all your chats and agents.",
    ),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(permissionButton("Allow all 2 permissions")).toBeEnabled(),
  );
  click(permissionButton("Allow all 2 permissions"));

  await expect(screen.findByText(resultMessage)).resolves.toBeInTheDocument();
  expect(screen.getByText("2 of 2 permissions allowed")).toBeInTheDocument();
  expect(writes).toHaveLength(2);
  for (const item of requested) {
    expect(writes).toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: item.connectorSlug },
        grants: [
          { permission: item.permission, action: "allow", expiresIn: "1h" },
        ],
      }),
    );
  }
}

test("Grouped grants remain allowed when chat continuation succeeds", async () => {
  await confirmGroupedPermissions("succeeds", "The chat has continued.");
  expect(screen.getByText("Permissions allowed")).toBeInTheDocument();
});

test("Grouped grants remain allowed when chat continuation fails", async () => {
  await confirmGroupedPermissions(
    "fails",
    "Permissions allowed, but could not continue.",
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Permissions allowed, but could not continue.",
  );
  expect(screen.queryByText("The chat has continued.")).not.toBeInTheDocument();
});

test("Dismissing a batch leaves a second agent's request and chat continuation independent", async () => {
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    return respond(200, {
      agentId: params.id,
      isDefaultAgent: false,
      ownerId: "test-user-123",
      displayName:
        params.id === secondAgent ? "Second reviewer" : "First reviewer",
      description: null,
      avatarUrl: null,
      sound: null,
      visibility: "private",
    });
  });
  mockPermissionCatalog(context);
  const { writes } = mockPermissionGrants(context);
  mockCallbackTargets();
  const continuations: unknown[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    continuations.push(body);
    return respond(201, { threadId: secondThread });
  });

  await openBatch(
    batchPath({
      items: requested.slice(0, 1),
      thread: threadId,
      prompt: "First report",
      duration: "24h",
    }),
  );
  await waitFor(() => expect(permissionButton("Not now")).toBeEnabled());
  click(permissionButton("Not now"));
  await expect(
    screen.findByText("No permissions were changed."),
  ).resolves.toBeInTheDocument();

  const next = batchPath({
    agent: secondAgent,
    items: requested.slice(1),
    thread: secondThread,
    prompt: "Second report",
  });
  await act(() => {
    window.history.pushState(null, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByText("Second reviewer");
  await waitFor(() =>
    expect(permissionButton("Allow 1 permission")).toBeEnabled(),
  );
  expect(
    screen.getByRole("combobox", { name: "Permission duration" }),
  ).toHaveTextContent("1 hour");
  click(permissionButton("Allow 1 permission"));

  await expect(
    screen.findByText("The chat has continued."),
  ).resolves.toBeInTheDocument();
  expect(writes).toMatchObject([
    {
      target: { kind: "builtin", connectorSlug: "github" },
      grants: [{ permission: "issues:read", action: "allow", expiresIn: "1h" }],
    },
  ]);
  expect(continuations).toMatchObject([
    {
      agentId: secondAgent,
      threadId: secondThread,
      prompt: "Second report",
    },
  ]);
});

test("Permissions allowed by policy appear complete without a new grant", async () => {
  mockPermissionCatalog(context, "allow");
  const { writes } = mockPermissionGrants(context);

  await openBatch();

  await expect(
    screen.findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Send Slack messages")).toBeInTheDocument();
  expect(writes).toHaveLength(0);
});

test("Missing metadata prevents approval and still lets the user dismiss the request", async () => {
  mockPermissionCatalog(context, "ask", "github");
  const { writes } = mockPermissionGrants(context);

  await openBatch();

  await expect(
    screen.findByText(
      "Could not verify all requested permissions. No permissions can be changed.",
    ),
  ).resolves.toBeInTheDocument();
  expect(permissionButton("Allow all 2 permissions")).toBeDisabled();
  click(permissionButton("Not now"));

  await expect(
    screen.findByText("No permissions were changed."),
  ).resolves.toBeInTheDocument();
  expect(writes).toHaveLength(0);
});

test("An unacknowledged grant cannot continue the chat", async () => {
  mockPermissionCatalog(context);
  mockPermissionGrants(context, { acknowledge: false });
  mockCallbackTargets();
  const continuations: unknown[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    continuations.push(body);
    return respond(201, { threadId });
  });

  await openBatch(
    batchPath({ thread: threadId, prompt: "Continue the report" }),
  );
  await waitFor(() =>
    expect(permissionButton("Allow all 2 permissions")).toBeEnabled(),
  );
  click(permissionButton("Allow all 2 permissions"));

  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Couldn't update permissions",
  );
  expect(screen.getByText("0 of 2 permissions allowed")).toBeInTheDocument();
  expect(permissionButton("Allow all 2 permissions")).toBeDisabled();
  expect(screen.queryByText("Permissions allowed")).not.toBeInTheDocument();
  expect(continuations).toHaveLength(0);
});
