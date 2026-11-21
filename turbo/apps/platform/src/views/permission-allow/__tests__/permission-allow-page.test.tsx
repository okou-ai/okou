import { mockAuthorizationCallbackThread } from "../../okou-page/__tests__/authorization-callback-test-helpers.ts";
import {
  getAction,
  queryAction,
  findAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ANALYTICS,
  PERMISSION_NOW,
  mockPermissionCatalog,
  mockPermissionGrants,
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
