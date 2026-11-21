import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { mockNow } from "../../../lib/time.ts";
import {
  getAction,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { agentFixture } from "../../team-page/__tests__/team-page-test-helpers.ts";
import { mockAuthorizationCallbackThread } from "../../okou-page/__tests__/authorization-callback-test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  PERMISSION_NOW,
  PERMISSION_LATER,
  mockPermissionCatalog,
  mockPermissionGrants,
} from "./permission-test-fixtures.ts";

const context = testContext();
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
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    return params.id !== context.resourceId
      ? respond(404, { error: { code: "NOT_FOUND", message: "Unknown agent" } })
      : respond(200, agentFixture(context.resourceId, "Issue reporter"));
  });
  context.mocks.data.agents([
    { agentId: context.resourceId, displayName: "Issue reporter" },
  ]);
  await setupPage({
    context,
    path: "/agents/" + context.resourceId + "/permissions/batch?" + query,
    featureSwitches: { [FeatureSwitchKey.BatchConnectorPermissions]: true },
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
    featureSwitches: { [FeatureSwitchKey.BatchConnectorPermissions]: true },
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
