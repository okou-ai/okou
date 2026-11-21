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
  const agentId = context.resourceId;
  context.mocks.data.agents([{ agentId, displayName: "Analytics reviewer" }]);
  return (
    "/agents/" +
    agentId +
    "/permissions?" +
    new URLSearchParams({ permission: ANALYTICS, ...query })
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

test("permission-allow-page-008 a legacy Slack link replaces its saved allow with a permanent denial", async () => {
  mockPermissionCatalog(context);
  const grants = mockPermissionGrants(context, {
    initial: [{ permission: ANALYTICS, action: "allow", expiresAt: null }],
  });
  await setupPage({
    context,
    path: permissionLink({ action: "deny", ref: "slack" }),
  });
  await expect(screen.findByText(ANALYTICS)).resolves.toBeInTheDocument();
  click(getAction("button", "Confirm"));
  await expect(
    screen.findByText("Permissions denied"),
  ).resolves.toBeInTheDocument();
  expect(grants.writes).toStrictEqual([
    {
      target: { kind: "builtin", connectorSlug: "slack" },
      mode: "patch",
      grants: [{ permission: ANALYTICS, action: "deny" }],
    },
  ]);
  expect(grants.saved.get("slack")).toStrictEqual([
    { permission: ANALYTICS, action: "deny", expiresAt: null },
  ]);
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
