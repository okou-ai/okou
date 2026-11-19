import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  allowDuration,
  chooseAllowDuration,
  dialogAction,
  expandPermissionGroup,
  mockConnectorPermissionRules,
  openConnectorPermissions,
  permissionRow,
  policyButton,
} from "./permission-editor-test-helpers.ts";
import { permissionMetadataFixture } from "./team-page-test-helpers.ts";

const context = testContext();

const NOW = "2026-08-18T12:00:00.000Z";
const SEVEN_DAYS_LATER = "2026-08-25T12:00:00.000Z";
const SLACK_READ_PERMISSIONS = [
  "bookmarks:read",
  "channels:list",
  "channels:read",
] as const;

function slackReadPolicies(): ReturnType<typeof mockConnectorPermissionRules> {
  mockNow(new Date(NOW), context.signal);
  return mockConnectorPermissionRules(
    context,
    permissionMetadataFixture("slack", "Slack", SLACK_READ_PERMISSIONS, {
      categories: Object.fromEntries(
        SLACK_READ_PERMISSIONS.map((permission) => {
          return [permission, "Read"];
        }),
      ),
      displayOrder: ["Read"],
      permissionDefault: "deny",
      unknownPolicy: "deny",
    }),
    SLACK_READ_PERMISSIONS.map((permission) => {
      return { permission, action: "allow", expiresAt: SEVEN_DAYS_LATER };
    }),
  );
}

async function openSlackReadGroup(): Promise<HTMLElement> {
  const dialog = await openConnectorPermissions(context, "Slack");
  expandPermissionGroup(dialog, "Read", 3);
  await waitFor(() => {
    expect(permissionRow(dialog, "channels:list")).toBeInTheDocument();
  });
  return dialog;
}

test("Apply reflects effective permission-policy changes", async () => {
  const applied = mockConnectorPermissionRules(
    context,
    permissionMetadataFixture("slack", "Slack", SLACK_READ_PERMISSIONS, {
      permissionDefault: "allow",
    }),
    [{ permission: "channels:read", action: "deny", expiresAt: null }],
  );
  const dialog = await openConnectorPermissions(context, "Slack");
  const row = permissionRow(dialog, "channels:read");
  expect(policyButton(row, "Deny")).toHaveAttribute("aria-pressed", "true");
  expect(dialogAction(dialog, "Apply")).toBeDisabled();

  click(policyButton(row, "Allow"));

  await waitFor(() => {
    expect(policyButton(row, "Allow")).toHaveAttribute("aria-pressed", "true");
  });
  expect(policyButton(row, "Deny")).toHaveAttribute("aria-pressed", "false");
  expect(dialogAction(dialog, "Apply")).toBeEnabled();
  expect(applied).toStrictEqual([]);
});

test("A denied permission does not keep the group's expiration", async () => {
  const applied = slackReadPolicies();
  const dialog = await openSlackReadGroup();
  const bookmarks = permissionRow(dialog, "bookmarks:read");
  const channelsList = permissionRow(dialog, "channels:list");
  expect(allowDuration(bookmarks, "bookmarks:read")).toHaveTextContent(
    "7 days",
  );

  click(policyButton(bookmarks, "Deny"));

  await waitFor(() => {
    expect(allowDuration(bookmarks, "bookmarks:read")).toBeNull();
  });
  expect(policyButton(bookmarks, "Deny")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(allowDuration(channelsList, "channels:list")).toHaveTextContent(
    "7 days",
  );

  click(dialogAction(dialog, "Apply"));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(applied).toStrictEqual([
    {
      target: { kind: "builtin", connectorSlug: "slack" },
      mode: "patch",
      grants: [{ permission: "bookmarks:read", action: "deny" }],
    },
  ]);
});

test("An individual permission duration overrides its group", async () => {
  const applied = slackReadPolicies();
  const dialog = await openSlackReadGroup();
  const bookmarks = permissionRow(dialog, "bookmarks:read");
  const channelsList = permissionRow(dialog, "channels:list");

  await chooseAllowDuration(bookmarks, "bookmarks:read", "Allow always");

  await waitFor(() => {
    expect(allowDuration(bookmarks, "bookmarks:read")).toHaveTextContent(
      "Always",
    );
  });
  expect(allowDuration(channelsList, "channels:list")).toHaveTextContent(
    "7 days",
  );
  expect(
    allowDuration(permissionRow(dialog, "channels:read"), "channels:read"),
  ).toHaveTextContent("7 days");

  click(dialogAction(dialog, "Apply"));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(applied).toStrictEqual([
    {
      target: { kind: "builtin", connectorSlug: "slack" },
      mode: "patch",
      grants: [
        { permission: "bookmarks:read", action: "allow", expiresIn: "always" },
      ],
    },
  ]);
});
