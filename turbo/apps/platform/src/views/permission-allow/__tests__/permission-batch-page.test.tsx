import {
  getAction,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import { agentsByIdContract } from "@okouai/api-contracts/contracts/agents";
import { agentFixture } from "../../team-page/__tests__/team-page-test-helpers.ts";
import { mockAuthorizationCallbackThread } from "../../okou-page/__tests__/authorization-callback-test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
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
