import { mockAuthorizationCallbackThread } from "../../okou-page/__tests__/authorization-callback-test-helpers.ts";
import {
  getAction,
  queryAction,
  findAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ANALYTICS,
  PERMISSION_NOW,
  mockPermissionCatalog,
  mockPermissionGrants,
  PERMISSION_LATER,
} from "./permission-test-fixtures.ts";

const context = testContext();

function permissionLink(query: Record<string, string>) {
  if (query.threadId) {
    mockAuthorizationCallbackThread(context, query.threadId);
  }
  return (
    "/connectors/permissions?" +
    new URLSearchParams({
      permission: ANALYTICS,
      orgId: "org_default",
      userId: "test-user-123",
      ...query,
    })
  );
}

test.each([
  ["permission-allow-page-009", "not-a-date"],
  ["permission-allow-page-010", PERMISSION_NOW],
])(
  "%s offers a new day of access when the saved grant has no remaining time",
  async (_id, expiresAt) => {
    mockNow(new Date(PERMISSION_NOW), context.signal);
    mockPermissionCatalog(context);
    mockPermissionGrants(context, {
      initial: [{ permission: ANALYTICS, action: "allow", expiresAt }],
    });
    await setupPage({
      context,
      path: permissionLink({
        action: "allow",
        connectorSlug: "slack",
        expiresIn: "24h",
      }),
    });
    await expect(
      screen.findByText(/updating your permissions for/),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Permission duration" }),
    ).toHaveTextContent("24 hours");
    expect(getAction("button", "Confirm")).toBeEnabled();
    expect(screen.queryByText("Already allowed")).toBeNull();
  },
);

test("permission-allow-page-007 a permanent denial needs no confirmation or expiry", async () => {
  mockPermissionCatalog(context);
  mockPermissionGrants(context, {
    initial: [{ permission: ANALYTICS, action: "deny", expiresAt: null }],
  });
  await setupPage({
    context,
    path: permissionLink({ action: "deny", connectorSlug: "slack" }),
  });
  await expect(
    screen.findByText("Already denied"),
  ).resolves.toBeInTheDocument();
  expect(queryAction("button", "Confirm")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText(/expires|expired/i)).toBeNull();
});

test.each([
  ["permission-allow-page-003", "delivered"],
  ["permission-allow-page-004", "rejected"],
])(
  "%s receiving a fresh grant while the chat is pending keeps the decision locked",
  async (_id, outcome) => {
    const threadId = crypto.randomUUID();
    const prompt = "Continue the analytics report";
    mockNow(new Date(PERMISSION_NOW), context.signal);
    mockPermissionCatalog(context);
    const grants = mockPermissionGrants(context);
    const entered = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const savedRead = context.mocks.deferred<void>();
    const refreshed = context.mocks.deferred<void>();
    context.mocks.api(
      connectorPermissionsContract.get,
      ({ query, respond }) => {
        if (
          query.kind === "builtin" &&
          grants.saved.get(query.connectorSlug)?.some((g) => {
            return g.action === "allow";
          })
        ) {
          const read = savedRead.settled() ? refreshed : savedRead;
          if (!read.settled()) {
            read.resolve();
          }
        }
        return respond(200, {
          target: query,
          grants:
            query.kind === "builtin"
              ? (grants.saved.get(query.connectorSlug) ?? [])
              : [],
        });
      },
    );
    context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
      expect(body).toMatchObject({ threadId, prompt });
      entered.resolve();
      await release.promise;
      return outcome === "delivered"
        ? respond(201, { threadId })
        : respond(503, {
            error: { code: "UNAVAILABLE", message: "Chat unavailable" },
          });
    });
    await setupPage({
      context,
      path: permissionLink({
        connectorSlug: "slack",
        action: "allow",
        callbackPrompt: prompt,
        threadId,
      }),
    });
    click(await findAction("button", "Confirm"));
    await entered.promise;
    await savedRead.promise;
    context.mocks.ably.trigger("connectorPermissionUpdated");
    await refreshed.promise;
    await expect(findAction("button", "Saving...")).resolves.toBeDisabled();
    expect(screen.queryByText("Already allowed")).toBeNull();
    expect(screen.queryByText("Permissions updated")).toBeNull();
    release.resolve();
    const delivered = outcome === "delivered";
    await screen.findByText(
      delivered ? "Permissions updated" : "Couldn't update permissions",
    );
    expect(screen.queryByText("Already allowed")).toBeNull();
    const confirm = queryAction("button", "Confirm");
    const duration = screen.queryByRole("combobox", {
      name: "Permission duration",
    });
    expect(confirm?.hasAttribute("disabled") ?? null).toBe(
      delivered ? null : true,
    );
    expect(duration?.hasAttribute("disabled") ?? null).toBe(
      delivered ? null : true,
    );
  },
);

function memberRequest(orgId: string, userId: string) {
  return (
    "/connectors/permissions?" +
    new URLSearchParams({
      orgId,
      userId,
      connectorSlug: "neon",
      permission: "branches:create",
      action: "allow",
      expiresIn: "1h",
    })
  );
}
test("The signed-in member approves one hour of standalone Neon branch creation", async () => {
  mockNow(new Date(PERMISSION_NOW), context.signal);
  mockPermissionCatalog(context);
  const grants = mockPermissionGrants(context);
  await setupPage({
    context,
    path: memberRequest("org_default", "test-user-123"),
  });
  await screen.findByText(/updating your permissions for Default Org/);
  expect(screen.getByText("Create a Neon branch")).toBeVisible();
  expect(
    screen.getByRole("combobox", { name: "Permission duration" }),
  ).toHaveTextContent("1 hour");
  click(getAction("button", "Confirm"));
  await expect(screen.findByText("Permissions updated")).resolves.toBeVisible();
  expect(grants.writes).toContainEqual({
    target: { kind: "builtin", connectorSlug: "neon" },
    mode: "patch",
    grants: [
      { permission: "branches:create", action: "allow", expiresIn: "1h" },
    ],
  });
});
test.each([
  { org: "other-workspace", user: "test-user-123" },
  { org: "org_default", user: "other-member" },
])(
  "A standalone request for $org and $user cannot be approved outside its membership",
  async ({ org, user }) => {
    await setupPage({ context, path: memberRequest(org, user) });
    await expect(
      screen.findByText("This permission link is invalid or unavailable."),
    ).resolves.toBeVisible();
    expect(queryAction("button", "Confirm")).toBeNull();
  },
);

test("A still-active timed grant shows when access will expire", async () => {
  const now = new Date(PERMISSION_NOW);
  mockNow(now, context.signal);
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  mockPermissionCatalog(context);
  mockPermissionGrants(context, {
    initial: [{ permission: ANALYTICS, action: "allow", expiresAt }],
  });
  await setupPage({
    context,
    path: permissionLink({ action: "allow", connectorSlug: "slack" }),
  });
  await screen.findByText("Already allowed");
  expect(screen.getByText("Expires in 1 hour")).toBeVisible();
  expect(queryAction("button", "Confirm")).toBeNull();
  expect(screen.queryByText(/expired/i)).toBeNull();
});

test("The permission review changes with consecutive Slack grant notifications", async () => {
  mockPermissionCatalog(context);
  const grants = mockPermissionGrants(context);
  const topic = "connectorPermissionUpdated";
  await setupPage({
    context,
    path: permissionLink({ action: "deny", connectorSlug: "slack" }),
  });
  await expect(findAction("button", "Confirm")).resolves.toBeEnabled();
  grants.saved.set("slack", [
    { permission: ANALYTICS, action: "deny", expiresAt: null },
  ]);
  context.mocks.ably.trigger(topic);
  await screen.findByText("Already denied");
  grants.saved.set("slack", []);
  context.mocks.ably.trigger(topic);
  await expect(findAction("button", "Confirm")).resolves.toBeEnabled();
  expect(screen.queryByText("Already denied")).toBeNull();
});

test("permission-allow-page-008 a member denies previously allowed Slack analytics through a ref link", async () => {
  mockPermissionCatalog(context);
  const grants = mockPermissionGrants(context, {
    initial: [{ permission: ANALYTICS, action: "allow", expiresAt: null }],
  });
  await setupPage({
    context,
    path: permissionLink({ ref: "slack", action: "deny" }),
  });

  await screen.findByText("Read workspace analytics");
  expect(screen.getByText("Slack")).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).toBeNull();
  const confirm = getAction("button", "Confirm");
  expect(confirm).toBeEnabled();
  click(confirm);

  await screen.findByText("Permissions denied");
  expect(screen.queryByText(/expir/i)).toBeNull();
  expect(grants.writes).toContainEqual({
    target: { kind: "builtin", connectorSlug: "slack" },
    mode: "patch",
    grants: [{ permission: "admin.analytics:read", action: "deny" }],
  });
});

test("An agent-owned Slack ref link opens the recovery page before any grant can be confirmed", async () => {
  const query = new URLSearchParams({
    ref: "slack",
    permission: ANALYTICS,
    action: "deny",
  });
  await setupPage({
    context,
    path: `/agents/22334455-e10a-40a3-ae19-dfbef88d2310/permissions?${query}`,
  });

  await screen.findByText("That page isn't here.");
  expect(screen.getByText("Back to home").closest("a")).toHaveAttribute(
    "href",
    "/",
  );
  expect(queryAction("button", "Confirm")).toBeNull();
});

async function openReview(continuation = false) {
  const items = [
    { connectorSlug: "github", permission: "issues:read" },
    { connectorSlug: "slack", permission: "chat:write" },
  ];
  const query = new URLSearchParams({
    action: "allow",
    items: JSON.stringify(items),
  });
  if (continuation) {
    mockAuthorizationCallbackThread(
      context,
      "2e6d73b1-23cd-42b0-beaa-f1aad7bc766c",
    );
    query.set("threadId", "2e6d73b1-23cd-42b0-beaa-f1aad7bc766c");
    query.set("callbackPrompt", "Publish the issue summary");
  }
  query.set("orgId", "org_default");
  query.set("userId", "test-user-123");
  await setupPage({
    context,
    path: "/connectors/permissions/batch?" + query,
  });
  return within(screen.getByRole("main"));
}

test("permission-batch-page-008 policy grants complete review on arrival", async () => {
  mockPermissionCatalog(context, "allow");
  const { writes } = mockPermissionGrants(context);
  const review = await openReview();
  await expect(
    review.findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  expect(review.getByText("Send Slack messages")).toBeInTheDocument();
  expect(review.getByText("2 of 2 permissions allowed")).toBeInTheDocument();
  expect(
    queryAction("button", "Allow all 2 permissions", screen.getByRole("main")),
  ).toBeNull();
  expect(writes).toStrictEqual([]);
});

test("permission-batch-page-009 a missing GitHub catalog prevents changing either permission", async () => {
  mockPermissionCatalog(context, "ask", "github");
  const { writes } = mockPermissionGrants(context);
  const review = await openReview();
  await expect(review.findByRole("alert")).resolves.toHaveTextContent(
    "Could not verify all requested permissions. No permissions can be changed.",
  );
  expect(
    getAction("button", "Allow all 2 permissions", screen.getByRole("main")),
  ).toBeDisabled();
  click(getAction("button", "Not now", screen.getByRole("main")));
  await expect(
    review.findByText("No permissions were changed."),
  ).resolves.toBeInTheDocument();
  expect(writes).toStrictEqual([]);
});

test("permission-batch-page-011 a save without acknowledgments leaves both permissions unapproved", async () => {
  mockPermissionCatalog(context);
  const { writes } = mockPermissionGrants(context, { acknowledge: false });
  const review = await openReview(true);
  await expect(
    review.findByText("Send Slack messages"),
  ).resolves.toBeInTheDocument();
  click(
    getAction("button", "Allow all 2 permissions", screen.getByRole("main")),
  );
  await expect(review.findByRole("alert")).resolves.toHaveTextContent(
    "Couldn't update permissions",
  );
  expect(writes).toStrictEqual(
    ["github", "slack"].map((slug) => {
      return {
        mode: "patch",
        target: { kind: "builtin", connectorSlug: slug },
        grants: [
          {
            permission: slug === "github" ? "issues:read" : "chat:write",
            action: "allow",
            expiresIn: "1h",
          },
        ],
      };
    }),
  );
  expect(review.getByText("0 of 2 permissions allowed")).toBeInTheDocument();
  expect(
    getAction("button", "Allow all 2 permissions", screen.getByRole("main")),
  ).toBeDisabled();
  expect(review.queryByText("Permissions allowed")).toBeNull();
  expect(review.queryByText("The chat has continued.")).toBeNull();
});

const branchPermissions = ["branches:create", "branches:delete"] as const;
const callbackPrompt = "Resume my branch review";
async function openMemberReview(threadId?: string) {
  const params = new URLSearchParams({
    orgId: "org_default",
    userId: "test-user-123",
    action: "allow",
    items: JSON.stringify(
      branchPermissions.map((permission) => {
        return {
          connectorSlug: "neon",
          permission,
        };
      }),
    ),
  });
  if (threadId) {
    params.set("threadId", threadId);
    params.set("callbackPrompt", callbackPrompt);
  }
  await setupPage({
    context,
    path: "/connectors/permissions/batch?" + params,
  });
}
test("Saving both Neon grants for one hour allows the member's originating chat to continue", async () => {
  mockNow(new Date(PERMISSION_NOW), context.signal);
  mockPermissionCatalog(context, "deny");
  const { saved, writes } = mockPermissionGrants(context);
  const thread = crypto.randomUUID();
  mockAuthorizationCallbackThread(context, thread);
  const receipt = context.mocks.deferred<void>();
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body).toMatchObject({ threadId: thread, prompt: callbackPrompt });
    expect(saved.get("neon")).toStrictEqual(
      branchPermissions.map((permission) => {
        return {
          permission,
          action: "allow",
          expiresAt: PERMISSION_LATER,
        };
      }),
    );
    receipt.resolve();
    return respond(201, { threadId: thread });
  });
  await openMemberReview(thread);
  await screen.findByText("Delete a Neon branch");
  const duration = screen.getByRole("combobox", {
    name: "Permission duration",
  });
  for (const option of ["24 hours", "1 hour"]) {
    click(duration);
    click(await screen.findByRole("option", { name: option }));
  }
  expect(duration).toHaveTextContent("1 hour");
  expect(saved.has("neon")).toBeFalsy();
  click(getAction("button", "Allow all 2 permissions"));
  await receipt.promise;
  await expect(
    screen.findByText("The chat has continued."),
  ).resolves.toBeVisible();
  expect(writes).toContainEqual({
    target: { kind: "builtin", connectorSlug: "neon" },
    mode: "patch",
    grants: branchPermissions.map((permission) => {
      return {
        permission,
        action: "allow",
        expiresIn: "1h",
      };
    }),
  });
});
test.each([
  { offset: -1, allowed: 2 },
  { offset: 0, allowed: 0 },
])(
  "Member sees $allowed current grants at the Neon expiry boundary ($offset ms)",
  async ({ offset, allowed }) => {
    mockNow(Date.parse(PERMISSION_LATER) + offset, context.signal);
    mockPermissionCatalog(context, "deny");
    const grants = mockPermissionGrants(context);
    grants.saved.set(
      "neon",
      branchPermissions.map((permission) => {
        return {
          permission,
          expiresAt: PERMISSION_LATER,
          action: "allow",
        };
      }),
    );
    await openMemberReview();
    await screen.findByText("Create a Neon branch");
    await expect(
      screen.findByText(allowed + " of 2 permissions allowed"),
    ).resolves.toBeVisible();
  },
);

test("A missing originating chat prevents reviewing member batch grants", async () => {
  const thread = crypto.randomUUID();
  mockAuthorizationCallbackThread(context, thread, () => {
    return false;
  });
  mockPermissionCatalog(context);
  const grants = mockPermissionGrants(context);
  await openMemberReview(thread);
  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Could not verify all requested permissions. No permissions can be changed.",
  );
  expect(
    queryAction("button", "Allow all 2 permissions")?.hasAttribute(
      "disabled",
    ) ?? true,
  ).toBeTruthy();
  expect(grants.saved.has("neon")).toBeFalsy();
});
test("Member approval rechecks chat access before changing any Neon grants", async () => {
  const thread = crypto.randomUUID();
  let accessible = true;
  mockAuthorizationCallbackThread(context, thread, () => {
    return accessible;
  });
  mockPermissionCatalog(context);
  const grants = mockPermissionGrants(context);
  await openMemberReview(thread);
  await screen.findByText("Create a Neon branch");
  const confirm = getAction("button", "Allow all 2 permissions");
  await waitFor(() => {
    return expect(confirm).toBeEnabled();
  });
  accessible = false;
  click(confirm);
  await expect(screen.findByRole("alert")).resolves.toBeVisible();
  expect(confirm).toBeDisabled();
  expect(grants.saved.has("neon")).toBeFalsy();
});
