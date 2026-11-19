import { waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, fill } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  allowDuration,
  chooseAllowDuration,
  dialogAction,
  mockConnectorPermissionRules,
  openConnectorPermissions,
  otherEndpoints,
  permissionRow,
  policyButton,
  queryPermissionRow,
} from "./permission-editor-test-helpers.ts";
import { permissionMetadataFixture } from "./team-page-test-helpers.ts";

const context = testContext();

const NOW = "2026-08-18T12:00:00.000Z";
const ONE_HOUR_LATER = "2026-08-18T13:00:00.000Z";
const TWO_DAYS_LATER = "2026-08-20T12:00:00.000Z";
const ONE_HOUR_EARLIER = "2026-08-18T11:00:00.000Z";

/** 110 permissions that sort ahead of memberships.read, which comes last. */
function cloudflarePermissions(): string[] {
  return [
    ...Array.from({ length: 110 }, (_, index) => {
      return `accounts.item${String(index + 1).padStart(3, "0")}.read`;
    }),
    "memberships.read",
  ];
}

test("A user can apply a temporary connector policy", async () => {
  const applied = mockConnectorPermissionRules(
    context,
    permissionMetadataFixture(
      "axiom",
      "Axiom",
      ["annotations|create", "datasets|read"],
      { permissionDefault: "allow" },
    ),
    [{ permission: "annotations|create", action: "deny", expiresAt: null }],
  );
  const dialog = await openConnectorPermissions(context, "Axiom");
  const annotations = permissionRow(dialog, "annotations|create");
  expect(policyButton(annotations, "Deny")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  click(policyButton(annotations, "Allow"));
  await chooseAllowDuration(annotations, "annotations|create", "Allow for 24h");
  await waitFor(() => {
    expect(allowDuration(annotations, "annotations|create")).toHaveTextContent(
      "24h",
    );
  });
  click(dialogAction(dialog, "Apply"));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(applied).toStrictEqual([
    {
      target: { kind: "builtin", connectorSlug: "axiom" },
      mode: "patch",
      grants: [
        { permission: "annotations|create", action: "allow", expiresIn: "24h" },
      ],
    },
  ]);
});

test("A user can change one connector permission from temporary to permanent", async () => {
  mockNow(new Date(NOW), context.signal);
  const applied = mockConnectorPermissionRules(
    context,
    permissionMetadataFixture(
      "axiom",
      "Axiom",
      ["annotations|create", "datasets|read", "expired|read"],
      { permissionDefault: "deny" },
    ),
    [
      {
        permission: "annotations|create",
        action: "allow",
        expiresAt: ONE_HOUR_LATER,
      },
      {
        permission: "datasets|read",
        action: "allow",
        expiresAt: TWO_DAYS_LATER,
      },
      { permission: "retired|write", action: "deny", expiresAt: null },
      {
        permission: "expired|read",
        action: "allow",
        expiresAt: ONE_HOUR_EARLIER,
      },
    ],
  );
  const dialog = await openConnectorPermissions(context, "Axiom");
  const annotations = permissionRow(dialog, "annotations|create");
  expect(allowDuration(annotations, "annotations|create")).toHaveTextContent(
    "1 hour",
  );

  await chooseAllowDuration(annotations, "annotations|create", "Allow always");
  await waitFor(() => {
    expect(allowDuration(annotations, "annotations|create")).toHaveTextContent(
      "Always",
    );
  });
  click(dialogAction(dialog, "Apply"));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(applied).toStrictEqual([
    {
      target: { kind: "builtin", connectorSlug: "axiom" },
      mode: "patch",
      grants: [
        {
          permission: "annotations|create",
          action: "allow",
          expiresIn: "always",
        },
      ],
    },
  ]);
});

test("A user can find and save a permission beyond the initially visible list", async () => {
  const applied = mockConnectorPermissionRules(
    context,
    permissionMetadataFixture(
      "cloudflare",
      "Cloudflare",
      cloudflarePermissions(),
      {
        permissionDefault: "allow",
      },
    ),
    [],
  );
  const dialog = await openConnectorPermissions(context, "Cloudflare");
  expect(permissionRow(dialog, "accounts.item001.read")).toBeInTheDocument();
  expect(queryPermissionRow(dialog, "memberships.read")).toBeNull();

  await fill(
    within(dialog).getByRole("textbox", { name: "Find permissions" }),
    "memberships.read",
  );
  const memberships = await waitFor(() => {
    return permissionRow(dialog, "memberships.read");
  });
  expect(policyButton(memberships, "Allow")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(policyButton(memberships, "Deny"));
  await waitFor(() => {
    expect(dialogAction(dialog, "Apply")).toBeEnabled();
  });
  click(dialogAction(dialog, "Apply"));

  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(applied).toStrictEqual([
    {
      target: { kind: "builtin", connectorSlug: "cloudflare" },
      mode: "patch",
      grants: [{ permission: "memberships.read", action: "deny" }],
    },
  ]);
});

test("Other endpoints starts from and can return to the connector default", async () => {
  const applied = mockConnectorPermissionRules(
    context,
    permissionMetadataFixture(
      "cloudflare",
      "Cloudflare",
      ["accounts.read", "zones.read"],
      { permissionDefault: "allow", unknownPolicy: "deny" },
    ),
    [],
  );
  const dialog = await openConnectorPermissions(context, "Cloudflare");
  const unknown = otherEndpoints(dialog);
  expect(policyButton(unknown, "Deny")).toHaveAttribute("aria-pressed", "true");
  expect(policyButton(unknown, "Allow")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(dialogAction(dialog, "Restore")).toBeDisabled();

  click(policyButton(unknown, "Allow"));
  await waitFor(() => {
    expect(dialogAction(dialog, "Restore")).toBeEnabled();
  });
  expect(policyButton(otherEndpoints(dialog), "Allow")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  click(dialogAction(dialog, "Restore"));
  await waitFor(() => {
    expect(dialogAction(dialog, "Restore")).toBeDisabled();
  });
  expect(policyButton(otherEndpoints(dialog), "Deny")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(policyButton(otherEndpoints(dialog), "Allow")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(applied).toStrictEqual([]);
});
