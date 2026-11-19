import { chatEventsContract } from "@okouai/api-contracts/client/chat-event-send";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ANALYTICS,
  APPROVING_AGENT,
  PERMISSION_LATER,
  PERMISSION_NOW,
  mockPermissionCatalog,
  mockPermissionGrants,
  permissionButton,
} from "./permission-test-fixtures.ts";

const context = testContext();
const threadId = "a0000000-0000-4000-a000-000000000001";

async function openPermission(
  options: {
    action?: "allow" | "deny";
    legacyRef?: boolean;
    callback?: boolean;
  } = {},
) {
  const query = new URLSearchParams({
    [options.legacyRef ? "ref" : "connectorSlug"]: "slack",
    permission: ANALYTICS,
    action: options.action ?? "allow",
    expiresIn: "24h",
  });
  if (options.callback) {
    query.set("threadId", threadId);
    query.set("callbackPrompt", "Continue the report");
  }
  await setupPage({
    context,
    path: `/agents/${APPROVING_AGENT}/permissions?${query}`,
  });
}

async function confirmWhileChatIsPending(outcome: "succeeds" | "fails") {
  mockNow(new Date(PERMISSION_NOW), context.signal);
  mockPermissionCatalog(context);
  const { writes } = mockPermissionGrants(context);
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    chatEventsContract.send,
    async ({ body, respond, withSignal }) => {
      expect(body).toMatchObject({
        agentId: APPROVING_AGENT,
        threadId,
        prompt: "Continue the report",
      });
      started.resolve(undefined);
      await withSignal(release.promise);
      if (outcome === "fails") {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Chat unavailable",
          },
        });
      }
      return respond(201, { threadId });
    },
  );

  await openPermission({ callback: true });
  await waitFor(() => {
    expect(permissionButton("Confirm")).toBeEnabled();
    expect(
      context.mocks.ably.hasSubscription("connectorPermissionUpdated"),
    ).toBeTruthy();
  });
  click(permissionButton("Confirm"));
  await started.promise;
  await act(() => {
    context.mocks.ably.trigger("connectorPermissionUpdated");
  });
  expect(permissionButton("Saving...")).toBeDisabled();
  expect(screen.queryByText("Permissions updated")).not.toBeInTheDocument();
  expect(screen.queryByText("Already allowed")).not.toBeInTheDocument();
  expect(writes).toMatchObject([
    {
      target: { kind: "builtin", connectorSlug: "slack" },
      grants: [{ permission: ANALYTICS, action: "allow", expiresIn: "24h" }],
    },
  ]);

  release.resolve(undefined);
}

test("The approval stays pending after a grant event until its chat continuation succeeds", async () => {
  await confirmWhileChatIsPending("succeeds");
  await expect(
    screen.findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
});

test("The approval stays pending after a grant event until its chat continuation fails", async () => {
  await confirmWhileChatIsPending("fails");
  await expect(
    screen.findByText("Couldn't update permissions"),
  ).resolves.toBeInTheDocument();
  expect(permissionButton("Confirm")).toBeDisabled();
  expect(
    screen.getByRole("combobox", { name: "Permission duration" }),
  ).toBeDisabled();
  expect(screen.queryByText("Already allowed")).not.toBeInTheDocument();
});

test.each([
  { action: "allow", title: "Already allowed", expiresAt: PERMISSION_LATER },
  { action: "deny", title: "Already denied", expiresAt: null },
] as const)(
  "An existing $action grant needs no confirmation",
  async ({ action, title, expiresAt }) => {
    mockNow(new Date(PERMISSION_NOW), context.signal);
    mockPermissionCatalog(context, action === "allow" ? "allow" : "ask");
    mockPermissionGrants(context, {
      initial: [{ permission: ANALYTICS, action, expiresAt }],
    });

    await openPermission({ action });

    await expect(screen.findByText(title)).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Permission duration" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Expired")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button", document.body).some(
        (button) => button.textContent?.trim() === "Confirm",
      ),
    ).toBeFalsy();
  },
);

test("An older permission link can replace a Slack allow with a permanent denial", async () => {
  mockNow(new Date(PERMISSION_NOW), context.signal);
  mockPermissionCatalog(context);
  const { writes } = mockPermissionGrants(context, {
    initial: [
      { permission: ANALYTICS, action: "allow", expiresAt: PERMISSION_LATER },
    ],
  });

  await openPermission({ action: "deny", legacyRef: true });
  await waitFor(() => expect(permissionButton("Confirm")).toBeEnabled());
  click(permissionButton("Confirm"));

  await expect(
    screen.findByText("Permissions denied"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(/expires in/i)).not.toBeInTheDocument();
  expect(writes).toMatchObject([
    {
      target: { kind: "builtin", connectorSlug: "slack" },
      grants: [{ permission: ANALYTICS, action: "deny" }],
    },
  ]);
  expect(writes).not.toMatchObject([
    { grants: [{ expiresIn: expect.anything() }] },
  ]);
});

test.each(["not-a-date", PERMISSION_NOW])(
  "An expired or invalid grant (%s) requires fresh confirmation",
  async (expiresAt) => {
    mockNow(new Date(PERMISSION_NOW), context.signal);
    mockPermissionCatalog(context);
    mockPermissionGrants(context, {
      initial: [{ permission: ANALYTICS, action: "allow", expiresAt }],
    });

    await openPermission();

    const duration = await screen.findByRole("combobox", {
      name: "Permission duration",
    });
    expect(duration).toHaveTextContent("24 hours");
    expect(permissionButton("Confirm")).toBeEnabled();
    expect(screen.queryByText("Already allowed")).not.toBeInTheDocument();
  },
);
