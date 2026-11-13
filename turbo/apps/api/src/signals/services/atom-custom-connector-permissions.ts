import type { CustomConnectorPermissionBundleRef } from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  ExpandedFirewallConfig,
  FirewallPolicyValue,
} from "@okouai/connectors/firewall-types";

export const ATOM_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF =
  "builtin:atom@1" satisfies CustomConnectorPermissionBundleRef;

type FirewallPermissions = NonNullable<
  ExpandedFirewallConfig["apis"][number]["permissions"]
>;

const readPaths = [
  "/me",
  "/admin/overview",
  "/admin/accounts/lookup",
  "/admin/redeem-codes",
  "/admin/entitlements",
  "/admin/coupons",
  "/admin/coupons/{id}",
  "/admin/invoices",
  "/admin/invoices/{id}",
  "/admin/subscription-grants",
] as const;

// Paths are relative to Atom's /api prefix. Keep the operation inventory exact:
// unknown routes remain denied by the custom permission-bundle runtime policy.
export const ATOM_CUSTOM_CONNECTOR_PERMISSIONS = [
  {
    name: "read",
    description:
      "Read Atom identity, accounts, inventories and operation history.",
    rules: [
      ...readPaths.flatMap((path) => {
        return [`GET ${path}`, `HEAD ${path}`];
      }),
      "POST /admin/coupons/preview",
    ],
  },
  {
    name: "grants:issue",
    description:
      "Create or manage redeem codes, grant plans or credits, issue or enable coupons, and authorize or deliver subscription credentials.",
    rules: [
      "POST /admin/redeem-codes",
      "PATCH /admin/redeem-codes/{code}",
      "DELETE /admin/redeem-codes/{code}",
      // Plans and credits share a body-discriminated endpoint. Both paths need
      // the same firewall approval; Atom additionally checks the exact scope.
      "POST /admin/entitlements",
      "POST /admin/entitlements/credits",
      "POST /admin/coupons",
      "POST /admin/coupons/{id}/issue",
      "POST /admin/coupons/{id}/enabled",
      "POST /admin/subscription-grants",
      "POST /admin/subscription-grants/{id}/complete",
      "POST /admin/subscription-grants/{id}/deliver",
      "POST /admin/subscription-grants/{id}/cancel",
    ],
  },
  {
    name: "plans:cancel",
    description: "Cancel an eligible Custom Plan delivery.",
    rules: ["POST /admin/entitlements/{id}/cancel"],
  },
  {
    name: "invoices:prepare",
    description: "Prepare an invoice confirmation record without charging.",
    rules: ["POST /admin/invoices/preview"],
  },
  {
    name: "invoices:charge",
    description: "Charge or resume an existing prepared invoice operation.",
    rules: ["POST /admin/invoices/{id}/charge"],
  },
] as const satisfies FirewallPermissions;

// Tighten issuing only; preserve the existing policy for other known actions.
export const ATOM_CUSTOM_CONNECTOR_DEFAULT_POLICIES = {
  read: "allow",
  "grants:issue": "deny",
  "plans:cancel": "allow",
  "invoices:prepare": "allow",
  "invoices:charge": "allow",
} as const satisfies Readonly<Record<string, FirewallPolicyValue>>;
