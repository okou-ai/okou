import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { permissionMetadataFixture } from "./team-page-test-helpers.ts";
import {
  memberPolicies,
  policyTime,
  expiresInHours,
} from "./member-policy-fixture.ts";
import {
  mockConnectorPermissionRules,
  openConnectorPermissions,
  showPermissionsDialog,
  permissionRow,
  allowDuration,
  policyButton,
  chooseAllowDuration,
  dialogAction,
  otherEndpoints,
} from "./permission-editor-test-helpers.ts";

const context = testContext();
const annotation = "annotations|create";
test.each([
  {
    id: "team-permissions-001",
    initial: "deny",
    duration: "24h",
    label: "Allow for 24h",
  },
  {
    id: "team-permissions-006",
    initial: "allow",
    duration: "always",
    label: "Allow always",
  },
] as const)(
  "$id applying an Axiom duration changes only the annotation rule",
  async ({ initial, duration, label }) => {
    mockNow(new Date(policyTime), context.signal);
    const others =
      initial === "deny"
        ? []
        : [
            {
              permission: "datasets|read",
              action: "allow" as const,
              expiresAt: expiresInHours(48),
            },
            {
              permission: "retired|write",
              action: "deny" as const,
              expiresAt: null,
            },
            {
              permission: "expired|read",
              action: "allow" as const,
              expiresAt: expiresInHours(-24),
            },
          ];
    const data = memberPolicies(
      context,
      permissionMetadataFixture("axiom", "Axiom", [
        annotation,
        "datasets|read",
      ]),
      [
        {
          permission: annotation,
          action: initial,
          expiresAt: initial === "allow" ? expiresInHours(1) : null,
        },
        ...others,
      ],
    );
    const dialog = await openConnectorPermissions(context, "Axiom");
    const row = permissionRow(dialog, annotation);
    expect(
      policyButton(row, initial === "deny" ? "Deny" : "Allow"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(allowDuration(row, annotation)?.textContent ?? null).toBe(
      initial === "allow" ? "1 hour" : null,
    );
    if (initial === "deny") {
      click(policyButton(row, "Allow"));
    }
    await chooseAllowDuration(row, annotation, label);
    click(dialogAction(dialog, "Apply"));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(data.changes).toStrictEqual([
      {
        target: { kind: "builtin", connectorSlug: "axiom" },
        mode: "patch",
        grants: [
          { permission: annotation, action: "allow", expiresIn: duration },
        ],
      },
    ]);
    const savedDialog = await showPermissionsDialog("Axiom");
    expect(
      allowDuration(permissionRow(savedDialog, annotation), annotation),
    ).toHaveTextContent(duration === "24h" ? "24 hours" : "Always");
    expect([...data.saved.values()]).toStrictEqual([
      {
        permission: annotation,
        action: "allow",
        expiresAt: duration === "always" ? null : expiresInHours(24),
      },
      ...others,
    ]);
  },
);

test("team-permissions-008 restoring unknown Cloudflare endpoints returns to their own deny default", async () => {
  const metadata = permissionMetadataFixture(
    "cloudflare",
    "Cloudflare",
    ["zones.read"],
    { permissionDefault: "allow", unknownPolicy: "deny" },
  );
  mockConnectorPermissionRules(context, metadata, []);
  const dialog = await openConnectorPermissions(context, "Cloudflare");
  const known = policyButton(permissionRow(dialog, "zones.read"), "Allow");
  const endpoints = otherEndpoints(dialog);
  const allow = policyButton(endpoints, "Allow");
  const deny = policyButton(endpoints, "Deny");
  const restore = dialogAction(dialog, "Restore");
  expect(known).toHaveAttribute("aria-pressed", "true");
  expect(restore).toBeDisabled();
  expect(allow).toHaveAttribute("aria-pressed", "false");
  expect(deny).toHaveAttribute("aria-pressed", "true");
  click(allow);
  expect(restore).toBeEnabled();
  expect(allow).toHaveAttribute("aria-pressed", "true");
  expect(known).toHaveAttribute("aria-pressed", "true");
  click(restore);
  expect(restore).toBeDisabled();
  expect(deny).toHaveAttribute("aria-pressed", "true");
  expect(allow).toHaveAttribute("aria-pressed", "false");
  expect(known).toHaveAttribute("aria-pressed", "true");
});
