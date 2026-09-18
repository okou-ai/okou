import { screen, waitFor } from "@testing-library/react";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogPermissionDetail,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-contracts";
import {
  userPermissionGrantsContract,
  type ApplyUserPermissionGrantsRequest,
  type UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  RESEARCH_AGENT_ID,
  catalogConnectorFixture,
  permissionGrantFixture,
  permissionMetadataFixture,
  setupTeamPage,
} from "./team-page-test-helpers.ts";

const context = testContext();
const FIXED_NOW_ISO = "2026-08-18T12:00:00.000Z";

interface PermissionSurfaceOptions {
  readonly connector: PublicConnectorCatalogStatusItem;
  readonly metadata: PublicConnectorCatalogPermissionDetail;
  readonly initialGrants?: readonly UserPermissionGrantResponse[];
  readonly onApply?: (request: ApplyUserPermissionGrantsRequest) => void;
}

function expiresAtFor(expiresIn: "1h" | "24h" | "7d" | "always" | undefined) {
  switch (expiresIn) {
    case "1h": {
      return "2026-08-18T13:00:00.000Z";
    }
    case "24h": {
      return "2026-08-19T12:00:00.000Z";
    }
    case "7d": {
      return "2026-08-25T12:00:00.000Z";
    }
    case "always":
    case undefined: {
      return null;
    }
  }
}

function mockPermissionSurface(
  testContextValue: TestContext,
  options: PermissionSurfaceOptions,
): void {
  let grants = [...(options.initialGrants ?? [])];
  testContextValue.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [options.connector] });
  });
  testContextValue.mocks.api(
    connectorCatalogContract.permissions,
    ({ respond }) => {
      return respond(200, { permissions: options.metadata });
    },
  );
  testContextValue.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [] });
  });
  testContextValue.mocks.api(
    userBuiltinConnectorsContract.get,
    ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: [] });
    },
  );
  testContextValue.mocks.api(
    agentCustomConnectorsContract.get,
    ({ respond }) => {
      return respond(200, { grants: [] });
    },
  );
  testContextValue.mocks.api(
    userPermissionGrantsContract.list,
    ({ query, respond }) => {
      return respond(
        200,
        grants.filter((grant) => {
          return grant.agentId === query.agentId;
        }),
      );
    },
  );
  testContextValue.mocks.api(
    userPermissionGrantsContract.apply,
    ({ body, respond }) => {
      options.onApply?.(body);
      const incoming = body.grants.map((grant) => {
        return permissionGrantFixture(
          body.connectorSlug,
          grant.permission,
          grant.action,
          grant.action === "allow" ? expiresAtFor(grant.expiresIn) : null,
        );
      });
      if (body.mode === "replace") {
        grants = [
          ...grants.filter((grant) => {
            return grant.connectorSlug !== body.connectorSlug;
          }),
          ...incoming,
        ];
      } else {
        const updatedNames = new Set(
          incoming.map((grant) => {
            return grant.permission;
          }),
        );
        grants = [
          ...grants.filter((grant) => {
            return (
              grant.connectorSlug !== body.connectorSlug ||
              !updatedNames.has(grant.permission)
            );
          }),
          ...incoming,
        ];
      }
      return respond(200, grants);
    },
  );
}

function exactButton(name: string, container: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function labelledButton(name: string, container: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
  if (!button) {
    throw new Error(`Labelled button not found: ${name}`);
  }
  return button;
}

function exactMenuItem(name: string) {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Menu item not found: ${name}`);
  }
  return item;
}

function permissionRow(name: string): HTMLElement {
  const label = screen.getByText(name, { selector: "code" });
  const row = label.parentElement?.parentElement;
  if (!row) {
    throw new Error(`Permission row not found: ${name}`);
  }
  return row;
}

function otherEndpointsRow(): HTMLElement {
  const label = screen.getByText("Other endpoints");
  const row = label.parentElement?.parentElement;
  if (!row) {
    throw new Error("Other endpoints row not found");
  }
  return row;
}

function categoryRow(name: string): HTMLElement {
  const toggle = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim().startsWith(`${name} (`) ?? false;
  });
  const row = toggle?.parentElement;
  if (!row) {
    throw new Error(`Permission category not found: ${name}`);
  }
  return row;
}

function policyButton(row: HTMLElement, policy: "Allow" | "Deny") {
  return exactButton(policy, row);
}

function expectPolicy(
  row: HTMLElement,
  policy: "Allow" | "Deny",
  pressed: boolean,
): void {
  expect(policyButton(row, policy)).toHaveAttribute(
    "aria-pressed",
    String(pressed),
  );
}

function chooseDuration(permission: string, option: string): void {
  click(labelledButton(`${permission} allow options`));
  click(exactMenuItem(option));
}

async function openPermissions(connectorName: string): Promise<void> {
  await screen.findByRole("heading", { name: "Research Agent" });
  await screen.findByText(connectorName);
  click(labelledButton(`Manage ${connectorName} permissions`));
  await screen.findByRole("heading", {
    name: (accessibleName) => {
      return accessibleName.startsWith(`${connectorName} permissions`);
    },
  });
}

function startPermissionPage(
  connector: PublicConnectorCatalogStatusItem,
  metadata: PublicConnectorCatalogPermissionDetail,
  options: Omit<PermissionSurfaceOptions, "connector" | "metadata"> = {},
): Promise<void> {
  mockNow(new Date(FIXED_NOW_ISO), context.signal);
  mockPermissionSurface(context, { connector, metadata, ...options });
  return setupTeamPage({
    context,
    path: `/agents/${RESEARCH_AGENT_ID}`,
  });
}

test("A user can apply connector policies and later restore their saved baseline", async () => {
  const requests: ApplyUserPermissionGrantsRequest[] = [];
  const connector = catalogConnectorFixture("axiom", "Axiom");
  const metadata = permissionMetadataFixture(
    "axiom",
    "Axiom",
    ["annotations|create"],
    { permissionDefault: "allow", unknownPolicy: "deny" },
  );
  await startPermissionPage(connector, metadata, {
    initialGrants: [
      permissionGrantFixture("axiom", "annotations|create", "deny", null),
      permissionGrantFixture("axiom", UNKNOWN_PERMISSION_GRANT, "allow", null),
    ],
    onApply: (request) => {
      requests.push(request);
    },
  });

  await openPermissions("Axiom");
  const annotation = permissionRow("annotations|create");
  click(policyButton(annotation, "Allow"));
  chooseDuration("annotations|create", "Allow for 24h");
  click(exactButton("Apply"));
  await waitFor(() => {
    expect(screen.getByText("Permissions updated")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: /^Axiom permissions\b/u }),
    ).not.toBeInTheDocument();
  });
  expect(requests[0]?.grants).toStrictEqual([
    {
      permission: "annotations|create",
      action: "allow",
      expiresIn: "24h",
    },
  ]);

  click(labelledButton("Manage Axiom permissions"));
  await screen.findByRole("heading", { name: /^Axiom permissions\b/u });
  click(policyButton(permissionRow("annotations|create"), "Deny"));
  click(policyButton(otherEndpointsRow(), "Deny"));
  click(exactButton("Restore"));

  expectPolicy(permissionRow("annotations|create"), "Allow", true);
  expectPolicy(otherEndpointsRow(), "Deny", true);
  expect(exactButton("Apply")).toBeEnabled();
  click(exactButton("Apply"));
  await waitFor(() => {
    expect(requests).toHaveLength(2);
    expect(
      screen.queryByRole("heading", { name: /^Axiom permissions\b/u }),
    ).not.toBeInTheDocument();
  });
  expect(requests[1]).toMatchObject({
    connectorSlug: "axiom",
    mode: "replace",
    grants: [],
  });
});

test("Closing connector permissions discards unapplied changes", async () => {
  const requests: ApplyUserPermissionGrantsRequest[] = [];
  const connector = catalogConnectorFixture("axiom", "Axiom");
  const metadata = permissionMetadataFixture(
    "axiom",
    "Axiom",
    ["annotations|create"],
    { permissionDefault: "deny" },
  );
  await startPermissionPage(connector, metadata, {
    initialGrants: [
      permissionGrantFixture("axiom", "annotations|create", "deny", null),
    ],
    onApply: (request) => {
      requests.push(request);
    },
  });

  await openPermissions("Axiom");
  click(policyButton(permissionRow("annotations|create"), "Allow"));
  chooseDuration("annotations|create", "Allow for 24h");
  click(exactButton("Cancel"));
  await waitFor(() => {
    expect(
      screen.queryByRole("heading", { name: /^Axiom permissions\b/u }),
    ).not.toBeInTheDocument();
  });
  expect(requests).toStrictEqual([]);

  click(labelledButton("Manage Axiom permissions"));
  await screen.findByRole("heading", { name: /^Axiom permissions\b/u });
  const reopened = permissionRow("annotations|create");
  expectPolicy(reopened, "Deny", true);
  expect(reopened).not.toHaveTextContent("24h");
  expect(exactButton("Apply")).toBeDisabled();
});

test.each([
  { durationMs: 60 * 60 * 1000, durationLabel: "1 hour" },
  { durationMs: 24 * 60 * 60 * 1000, durationLabel: "24 hours" },
  { durationMs: 7 * 24 * 60 * 60 * 1000, durationLabel: "7 days" },
])(
  "Saved $durationLabel permissions share one countdown in settings",
  async ({ durationMs, durationLabel }) => {
    const connector = catalogConnectorFixture("slack", "Slack", {
      permissionCount: 2,
    });
    const metadata = permissionMetadataFixture(
      "slack",
      "Slack",
      ["records|read", "records|write"],
      {
        categories: { "records|read": "Records", "records|write": "Records" },
        displayOrder: ["Records"],
        permissionDefault: "deny",
      },
    );
    const grantedAtMs = Date.parse(FIXED_NOW_ISO) + 1000;
    const expiresAt = new Date(grantedAtMs + durationMs).toISOString();
    await startPermissionPage(connector, metadata, {
      initialGrants: [
        "records|read",
        "records|write",
        UNKNOWN_PERMISSION_GRANT,
      ].map((permission, index) => {
        const updatedAt = new Date(
          grantedAtMs -
            (index === 0 ? 7 * 24 * 60 * 60 * 1000 - durationMs : 0),
        ).toISOString();
        return {
          ...permissionGrantFixture("slack", permission, "allow", expiresAt),
          createdAt: updatedAt,
          updatedAt,
        };
      }),
    });

    await openPermissions("Slack");
    expect(categoryRow("Records")).toHaveTextContent(durationLabel);
    click(exactButton("Records (2)"));
    expect(permissionRow("records|read")).toHaveTextContent(durationLabel);
    expect(permissionRow("records|write")).toHaveTextContent(durationLabel);
    expect(otherEndpointsRow()).toHaveTextContent(durationLabel);
  },
);

test("An expired allow grant falls back to the connector's current default", async () => {
  const connector = catalogConnectorFixture("slack", "Slack");
  const metadata = permissionMetadataFixture(
    "slack",
    "Slack",
    ["channels:join"],
    {
      categories: { "channels:join": "Misc" },
      displayOrder: ["Misc"],
      permissionDefault: "deny",
    },
  );
  await startPermissionPage(connector, metadata, {
    initialGrants: [
      permissionGrantFixture(
        "slack",
        "channels:join",
        "allow",
        "2026-08-18T11:59:00.000Z",
      ),
    ],
  });

  await openPermissions("Slack");
  click(exactButton("Misc (1)"));
  const row = permissionRow("channels:join");
  expectPolicy(row, "Deny", true);
  expectPolicy(row, "Allow", false);
  expect(exactButton("Restore")).toBeDisabled();
});

test("Group and individual connector policies stay understandable while editing", async () => {
  const requests: ApplyUserPermissionGrantsRequest[] = [];
  const connector = catalogConnectorFixture("slack", "Slack", {
    permissionCount: 5,
  });
  const metadata = permissionMetadataFixture(
    "slack",
    "Slack",
    [
      "bookmarks:read",
      "channels:read",
      "messages:write",
      "channels:join",
      "pins:add",
    ],
    {
      categories: {
        "bookmarks:read": "Read",
        "channels:read": "Read",
        "messages:write": "Write",
        "channels:join": "Misc",
        "pins:add": "Misc",
      },
      displayOrder: ["Read", "Write", "Misc"],
      permissionDefault: "deny",
    },
  );
  await startPermissionPage(connector, metadata, {
    initialGrants: [
      permissionGrantFixture("slack", "channels:read", "allow", null),
    ],
    onApply: (request) => {
      requests.push(request);
    },
  });

  await openPermissions("Slack");
  const readCategory = categoryRow("Read");
  click(policyButton(readCategory, "Allow"));
  chooseDuration("Read", "Allow for 7d");
  expect(readCategory).toHaveTextContent("Allow");
  expect(readCategory).toHaveTextContent("7d");

  click(exactButton("Read (2)"));
  chooseDuration("bookmarks:read", "Allow for 1h");
  expect(readCategory).toHaveTextContent("Mixed");
  expect(readCategory).not.toHaveTextContent("7d");

  chooseDuration("bookmarks:read", "Allow for 7d");
  expect(readCategory).toHaveTextContent("Allow");
  expect(readCategory).toHaveTextContent("7d");

  click(exactButton("Misc (2)"));
  const channelsJoin = permissionRow("channels:join");
  click(policyButton(channelsJoin, "Allow"));
  chooseDuration("channels:join", "Allow for 7d");
  expect(channelsJoin).toHaveTextContent("7d");
  click(policyButton(channelsJoin, "Deny"));
  expect(channelsJoin).not.toHaveTextContent("7d");
  click(policyButton(channelsJoin, "Allow"));
  chooseDuration("channels:join", "Allow always");
  expect(channelsJoin).toHaveTextContent("Always");
  expect(channelsJoin).not.toHaveTextContent("7d");

  const other = otherEndpointsRow();
  click(policyButton(other, "Allow"));
  chooseDuration(UNKNOWN_PERMISSION_GRANT, "Allow for 1h");
  click(exactButton("Apply"));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
    expect(screen.getByText("Permissions updated")).toBeVisible();
  });
  expect(
    new Set(
      requests[0]?.grants.map((grant) => {
        return grant.permission;
      }),
    ),
  ).toStrictEqual(
    new Set([
      "bookmarks:read",
      "channels:read",
      "channels:join",
      UNKNOWN_PERMISSION_GRANT,
    ]),
  );
  expect(requests[0]?.grants).toContainEqual({
    permission: UNKNOWN_PERMISSION_GRANT,
    action: "allow",
    expiresIn: "1h",
  });
});

test("A user can change one connector permission from temporary to permanent", async () => {
  const requests: ApplyUserPermissionGrantsRequest[] = [];
  const connector = catalogConnectorFixture("axiom", "Axiom", {
    permissionCount: 2,
  });
  const metadata = permissionMetadataFixture(
    "axiom",
    "Axiom",
    ["annotations|create", "datasets|read"],
    { permissionDefault: "deny" },
  );
  await startPermissionPage(connector, metadata, {
    initialGrants: [
      permissionGrantFixture(
        "axiom",
        "annotations|create",
        "allow",
        "2026-08-18T12:30:00.000Z",
      ),
      permissionGrantFixture(
        "axiom",
        "datasets|read",
        "allow",
        "2026-08-20T12:00:00.000Z",
      ),
      permissionGrantFixture("axiom", "retired|write", "deny", null),
      permissionGrantFixture(
        "axiom",
        "expired|read",
        "allow",
        "2026-08-18T11:00:00.000Z",
      ),
    ],
    onApply: (request) => {
      requests.push(request);
    },
  });

  await openPermissions("Axiom");
  const annotation = permissionRow("annotations|create");
  expect(annotation).toHaveTextContent("1 hour");
  chooseDuration("annotations|create", "Allow always");
  click(exactButton("Apply"));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
    expect(screen.getByText("Permissions updated")).toBeVisible();
  });
  expect(requests[0]).toMatchObject({
    connectorSlug: "axiom",
    mode: "patch",
    grants: [
      {
        permission: "annotations|create",
        action: "allow",
        expiresIn: "always",
      },
    ],
  });
});

test("A user can find and save a permission beyond the initially visible list", async () => {
  const requests: ApplyUserPermissionGrantsRequest[] = [];
  const permissionNames = Array.from({ length: 110 }, (_, index) => {
    return `catalog.${String(index + 1).padStart(3, "0")}.read`;
  });
  permissionNames.push("memberships.read");
  const connector = catalogConnectorFixture("cloudflare", "Cloudflare", {
    permissionCount: permissionNames.length,
  });
  const metadata = permissionMetadataFixture(
    "cloudflare",
    "Cloudflare",
    permissionNames,
    { permissionDefault: "allow" },
  );
  await startPermissionPage(connector, metadata, {
    onApply: (request) => {
      requests.push(request);
    },
  });

  await openPermissions("Cloudflare");
  expect(screen.queryByText("memberships.read")).not.toBeInTheDocument();
  await fill(screen.getByLabelText("Find permissions"), "memberships.read");
  const membership = await screen.findByText("memberships.read");
  expect(membership).toBeVisible();
  click(policyButton(permissionRow("memberships.read"), "Deny"));
  click(exactButton("Apply"));
  await waitFor(() => {
    expect(requests).toHaveLength(1);
    expect(screen.getByText("Permissions updated")).toBeVisible();
  });
  expect(requests[0]).toMatchObject({
    agentId: RESEARCH_AGENT_ID,
    connectorSlug: "cloudflare",
    mode: "patch",
    grants: [
      {
        permission: "memberships.read",
        action: "deny",
      },
    ],
  });
});

test("Other endpoints starts from and can return to the connector default", async () => {
  const connector = catalogConnectorFixture("cloudflare", "Cloudflare");
  const metadata = permissionMetadataFixture(
    "cloudflare",
    "Cloudflare",
    ["memberships.read"],
    { permissionDefault: "allow", unknownPolicy: "deny" },
  );
  await startPermissionPage(connector, metadata);

  await openPermissions("Cloudflare");
  const other = otherEndpointsRow();
  expectPolicy(other, "Deny", true);
  expectPolicy(other, "Allow", false);
  expect(exactButton("Restore")).toBeDisabled();

  click(policyButton(other, "Allow"));
  expectPolicy(other, "Allow", true);
  expect(exactButton("Restore")).toBeEnabled();

  click(exactButton("Restore"));
  expectPolicy(otherEndpointsRow(), "Deny", true);
  expect(exactButton("Restore")).toBeDisabled();
});
