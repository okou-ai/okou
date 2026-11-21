import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { permissionMetadataFixture } from "./team-page-test-helpers.ts";
import {
  policyTime,
  expiresInHours,
  memberPolicies,
} from "./member-policy-fixture.ts";
import {
  expandPermissionGroup,
  openConnectorPermissions,
  showPermissionsDialog,
  permissionRow,
  allowDuration,
  policyButton,
  chooseAllowDuration,
  dialogAction,
} from "./permission-editor-test-helpers.ts";

const context = testContext();
test.each([
  { id: "permission-editor-002", action: "deny" },
  { id: "permission-editor-003", action: "allow" },
] as const)(
  "$id changing one saved Slack rule preserves the other seven-day grants",
  async ({ action }) => {
    mockNow(new Date(policyTime), context.signal);
    const names = ["bookmarks:read", "channels:list", "channels:read"];
    const original = names.map((permission) => {
      return {
        permission,
        action: "allow" as const,
        expiresAt: expiresInHours(168),
      };
    });
    const data = memberPolicies(
      context,
      permissionMetadataFixture("slack", "Slack", names, {
        categories: Object.fromEntries(
          names.map((name) => {
            return [name, "Read"];
          }),
        ),
        displayOrder: ["Read"],
      }),
      original,
    );
    const dialog = await openConnectorPermissions(context, "Slack");
    expandPermissionGroup(dialog, "Read", 3);
    const bookmarks = permissionRow(dialog, "bookmarks:read");
    expect(allowDuration(bookmarks, "bookmarks:read")).toHaveTextContent(
      "7 days",
    );
    if (action === "allow") {
      await chooseAllowDuration(bookmarks, "bookmarks:read", "Allow always");
    } else {
      click(policyButton(bookmarks, "Deny"));
    }
    expect(
      policyButton(bookmarks, action === "allow" ? "Allow" : "Deny"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      allowDuration(bookmarks, "bookmarks:read")?.textContent ?? null,
    ).toBe(action === "allow" ? "Always" : null);
    expect(
      allowDuration(permissionRow(dialog, "channels:list"), "channels:list"),
    ).toHaveTextContent("7 days");
    click(dialogAction(dialog, "Apply"));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(data.changes).toStrictEqual([
      {
        target: { kind: "builtin", connectorSlug: "slack" },
        mode: "patch",
        grants: [
          {
            permission: "bookmarks:read",
            action,
            ...(action === "allow" ? { expiresIn: "always" } : {}),
          },
        ],
      },
    ]);
    const reread = await showPermissionsDialog("Slack");
    expandPermissionGroup(reread, "Read", 3);
    expect(
      policyButton(
        permissionRow(reread, "bookmarks:read"),
        action === "allow" ? "Allow" : "Deny",
      ),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      allowDuration(permissionRow(reread, "channels:list"), "channels:list"),
    ).toHaveTextContent("7 days");
    expect([...data.saved.values()]).toStrictEqual([
      { permission: "bookmarks:read", action, expiresAt: null },
      ...original.slice(1),
    ]);
  },
);
