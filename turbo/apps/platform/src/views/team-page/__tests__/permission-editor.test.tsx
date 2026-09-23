import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogPermissionDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  type ApplyUserPermissionGrant,
  type ApplyUserPermissionGrantsRequest,
  type UserPermissionGrantResponse,
  userPermissionGrantsContract,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const AGENT_ID = "10000000-0000-4000-a000-000000000011";
const CONNECTION_ID = "20000000-0000-4000-a000-000000000011";
const NOW_MS = 1_893_456_000_000;
const SEVEN_DAYS_LATER = "2030-01-08T00:00:00.000Z";
const CREATED_AT = "2029-12-01T00:00:00.000Z";

const READ_PERMISSIONS = [
  {
    name: "bookmarks:read",
    description: "List channel bookmarks.",
  },
  {
    name: "channels:list",
    description: "List public channels.",
  },
  {
    name: "channels:history",
    description: "Read channel history.",
  },
] as const;

interface PermissionEditorOptions {
  readonly grouped?: boolean;
  readonly permissionDefault?: "allow" | "deny" | "ask";
  readonly unknownPolicy?: "allow" | "deny" | "ask";
  readonly grants?: readonly UserPermissionGrantResponse[];
  readonly appliedRequests?: ApplyUserPermissionGrantsRequest[];
  readonly onApply?: () => Promise<void>;
}

function agentFixture(): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId: AGENT_ID,
    ownerId: "test-user-123",
    displayName: "Research Bot",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
}

function connectedSlackFixture(): BuiltinConnectorResponse {
  return {
    id: CONNECTION_ID,
    slug: "slack",
    authMethod: "oauth",
    externalId: "slack-workspace-1",
    externalUsername: "permission-editor",
    externalEmail: null,
    oauthScopes: ["bookmarks:read", "channels:read", "channels:history"],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function permissionMetadata({
  grouped = true,
  permissionDefault = "allow",
  unknownPolicy = "deny",
}: Pick<
  PermissionEditorOptions,
  "grouped" | "permissionDefault" | "unknownPolicy"
>): PublicConnectorCatalogPermissionDetail {
  return {
    connectorSlug: "slack",
    label: "Slack",
    icon: {
      url: "https://assets.example.test/slack.svg",
      invertInDarkMode: false,
    },
    permissionCount: READ_PERMISSIONS.length,
    permissions: [...READ_PERMISSIONS],
    categories: grouped
      ? {
          categories: Object.fromEntries(
            READ_PERMISSIONS.map((permission) => {
              return [permission.name, "Read"];
            }),
          ),
          displayOrder: ["Read"],
        }
      : null,
    defaultPolicy: {
      permissionDefault,
      unknownPolicy,
    },
  };
}

function permissionGrant({
  permission,
  action = "allow",
  expiresAt,
}: {
  readonly permission: string;
  readonly action?: "allow" | "deny";
  readonly expiresAt: string | null;
}): UserPermissionGrantResponse {
  return {
    agentId: AGENT_ID,
    connectorSlug: "slack",
    permission,
    action,
    expiresAt,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function setupPermissionEditor(
  options: PermissionEditorOptions,
): Promise<void> {
  const metadata = permissionMetadata(options);
  const grants = [...(options.grants ?? [])];

  mockNow(NOW_MS, context.signal);
  context.mocks.data.agents([agentFixture()]);
  context.mocks.data.connectors([connectedSlackFixture()]);
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    expect(params.id).toBe(AGENT_ID);
    return respond(200, agentFixture());
  });
  context.mocks.api(
    userBuiltinConnectorsContract.get,
    ({ params, respond }) => {
      expect(params.id).toBe(AGENT_ID);
      return respond(200, { enabledConnectorSlugs: ["slack"] });
    },
  );
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      expect(params.connectorSlug).toBe("slack");
      return respond(200, { permissions: metadata });
    },
  );
  context.mocks.api(userPermissionGrantsContract.list, ({ query, respond }) => {
    expect(query.agentId).toBe(AGENT_ID);
    return respond(200, grants);
  });
  context.mocks.api(
    userPermissionGrantsContract.apply,
    async ({ body, respond, withSignal }) => {
      options.appliedRequests?.push(body);
      if (options.onApply) {
        await withSignal(options.onApply());
      }
      return respond(200, []);
    },
  );

  return setupPage({ context, path: `/agents/${AGENT_ID}` });
}

function roleElementByText(
  role: "button" | "menuitem",
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.textContent?.trim() === text ||
      candidate.getAttribute("aria-label") === text
    );
  });
  if (!element) {
    throw new Error(`${role} not found: ${text}`);
  }
  return element;
}

async function waitForRoleElementByText(
  role: "button" | "menuitem",
  text: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  await waitFor(() => {
    expect(
      queryAllByRoleFast(role, container).some((candidate) => {
        return (
          candidate.textContent?.trim() === text ||
          candidate.getAttribute("aria-label") === text
        );
      }),
    ).toBeTruthy();
  });
  return roleElementByText(role, text, container);
}

async function openPermissionEditor(
  options: PermissionEditorOptions,
): Promise<HTMLElement> {
  await setupPermissionEditor(options);
  const manageButton = await waitForRoleElementByText(
    "button",
    "Manage Slack permissions",
  );
  click(manageButton);

  const description = await screen.findByText(
    "Configure which actions this agent is allowed to perform via this connector.",
  );
  const drawer = description.closest<HTMLElement>('[role="dialog"]');
  if (!drawer) {
    throw new Error("Slack permissions drawer not found");
  }
  if (options.grouped === false) {
    await within(drawer).findByText("bookmarks:read", { selector: "code" });
  } else {
    await waitForRoleElementByText("button", "Read (3)", drawer);
  }
  return drawer;
}

function permissionRow(drawer: HTMLElement, permission: string): HTMLElement {
  const code = within(drawer).getByText(permission, { selector: "code" });
  const row = code.parentElement?.parentElement;
  if (!row) {
    throw new Error(`Permission row not found: ${permission}`);
  }
  return row;
}

function groupHeader(drawer: HTMLElement): HTMLElement {
  const groupButton = roleElementByText("button", "Read (3)", drawer);
  const header = groupButton.parentElement;
  if (!header) {
    throw new Error("Read permission group header not found");
  }
  return header;
}

function unknownPermissionRow(drawer: HTMLElement): HTMLElement {
  const label = within(drawer).getByText("Other endpoints");
  const row = label.parentElement?.parentElement;
  if (!row) {
    throw new Error("Other endpoints row not found");
  }
  return row;
}

function allPermissionsRow(drawer: HTMLElement): HTMLElement {
  const label = within(drawer).getByText("Select all (3)");
  const row = label.parentElement;
  if (!row) {
    throw new Error("All permissions row not found");
  }
  return row;
}

async function expandReadGroup(drawer: HTMLElement): Promise<void> {
  click(roleElementByText("button", "Read (3)", drawer));
  await expect(
    within(drawer).findByText("bookmarks:read", { selector: "code" }),
  ).resolves.toBeInTheDocument();
}

async function chooseDuration(
  drawer: HTMLElement,
  permission: string,
  option: "Allow always" | "Allow for 1h" | "Allow for 7d" | "Allow for 24h",
): Promise<void> {
  click(within(drawer).getByLabelText(`${permission} allow options`));
  const menuItem = await waitForRoleElementByText("menuitem", option);
  click(menuItem);
}

function expectPolicy(container: ParentNode, policy: "Allow" | "Deny"): void {
  expect(roleElementByText("button", policy, container)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
}

function sortedGrants(
  grants: readonly ApplyUserPermissionGrant[],
): ApplyUserPermissionGrant[] {
  return [...grants].sort((left, right) => {
    return left.permission.localeCompare(right.permission);
  });
}

function expectSinglePatch(
  requests: readonly ApplyUserPermissionGrantsRequest[],
  grants: readonly ApplyUserPermissionGrant[],
): void {
  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request).toBeDefined();
  expect({
    ...request,
    grants: sortedGrants(request.grants),
  }).toStrictEqual({
    agentId: AGENT_ID,
    connectorSlug: "slack",
    mode: "patch",
    grants: sortedGrants(grants),
  });
}

test("Apply reflects effective permission-policy changes", async () => {
  const drawer = await openPermissionEditor({
    grants: [
      permissionGrant({
        permission: "bookmarks:read",
        action: "deny",
        expiresAt: null,
      }),
    ],
  });
  await expandReadGroup(drawer);
  const bookmarkRow = permissionRow(drawer, "bookmarks:read");
  const applyButton = roleElementByText("button", "Apply", drawer);

  expectPolicy(bookmarkRow, "Deny");
  expect(applyButton).toBeDisabled();
  click(roleElementByText("button", "Allow", bookmarkRow));

  expectPolicy(bookmarkRow, "Allow");
  expect(applyButton).toBeEnabled();
});

test("A denied permission does not keep the group's expiration", async () => {
  const appliedRequests: ApplyUserPermissionGrantsRequest[] = [];
  const drawer = await openPermissionEditor({
    permissionDefault: "deny",
    grants: READ_PERMISSIONS.map((permission) => {
      return permissionGrant({
        permission: permission.name,
        expiresAt: SEVEN_DAYS_LATER,
      });
    }),
    appliedRequests,
  });
  expect(within(groupHeader(drawer)).getByText("7 days")).toBeInTheDocument();
  await expandReadGroup(drawer);
  const bookmarkRow = permissionRow(drawer, "bookmarks:read");
  const channelRow = permissionRow(drawer, "channels:list");

  click(roleElementByText("button", "Deny", bookmarkRow));

  expectPolicy(bookmarkRow, "Deny");
  expect(
    within(bookmarkRow).queryByLabelText("bookmarks:read allow options"),
  ).not.toBeInTheDocument();
  expect(
    within(channelRow).getByLabelText("channels:list allow options"),
  ).toHaveTextContent("7 days");
  click(roleElementByText("button", "Apply", drawer));

  await expect(
    screen.findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
  expectSinglePatch(appliedRequests, [
    { permission: "bookmarks:read", action: "deny" },
  ]);
});

test("An individual permission duration overrides its group", async () => {
  const appliedRequests: ApplyUserPermissionGrantsRequest[] = [];
  const drawer = await openPermissionEditor({
    permissionDefault: "deny",
    grants: READ_PERMISSIONS.map((permission) => {
      return permissionGrant({
        permission: permission.name,
        expiresAt: SEVEN_DAYS_LATER,
      });
    }),
    appliedRequests,
  });
  await expandReadGroup(drawer);
  const bookmarkRow = permissionRow(drawer, "bookmarks:read");
  const channelRow = permissionRow(drawer, "channels:list");

  await chooseDuration(drawer, "bookmarks:read", "Allow always");

  expect(
    within(bookmarkRow).getByLabelText("bookmarks:read allow options"),
  ).toHaveTextContent("Always");
  expect(
    within(channelRow).getByLabelText("channels:list allow options"),
  ).toHaveTextContent("7 days");
  click(roleElementByText("button", "Apply", drawer));

  await expect(
    screen.findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
  expectSinglePatch(appliedRequests, [
    {
      permission: "bookmarks:read",
      action: "allow",
      expiresIn: "always",
    },
  ]);
});

test("Undoing a deny does not create an unnecessary always grant", async () => {
  const appliedRequests: ApplyUserPermissionGrantsRequest[] = [];
  const drawer = await openPermissionEditor({ appliedRequests });
  await expandReadGroup(drawer);
  const bookmarkRow = permissionRow(drawer, "bookmarks:read");
  const applyButton = roleElementByText("button", "Apply", drawer);

  expectPolicy(bookmarkRow, "Allow");
  expect(applyButton).toBeDisabled();
  click(roleElementByText("button", "Deny", bookmarkRow));
  expect(applyButton).toBeEnabled();
  click(roleElementByText("button", "Allow", bookmarkRow));

  expectPolicy(bookmarkRow, "Allow");
  expect(
    within(bookmarkRow).getByLabelText("bookmarks:read allow options"),
  ).toHaveTextContent("Always");
  expect(applyButton).toBeDisabled();
  expect(appliedRequests).toHaveLength(0);
});

test("Undoing a connector restore disables Apply", async () => {
  const drawer = await openPermissionEditor({
    grants: [
      permissionGrant({
        permission: "bookmarks:read",
        action: "deny",
        expiresAt: null,
      }),
    ],
  });
  await expandReadGroup(drawer);
  const bookmarkRow = permissionRow(drawer, "bookmarks:read");
  const applyButton = roleElementByText("button", "Apply", drawer);

  expectPolicy(bookmarkRow, "Deny");
  expect(applyButton).toBeDisabled();
  click(roleElementByText("button", "Restore", drawer));

  expectPolicy(bookmarkRow, "Allow");
  expect(applyButton).toBeEnabled();
  click(roleElementByText("button", "Deny", bookmarkRow));

  expectPolicy(bookmarkRow, "Deny");
  expect(applyButton).toBeDisabled();
});

test("Unknown-permission policy can return to its saved value", async () => {
  const drawer = await openPermissionEditor({
    unknownPolicy: "allow",
    grants: [
      permissionGrant({
        permission: UNKNOWN_PERMISSION_GRANT,
        action: "deny",
        expiresAt: null,
      }),
    ],
  });
  const unknownRow = unknownPermissionRow(drawer);
  const applyButton = roleElementByText("button", "Apply", drawer);

  expectPolicy(unknownRow, "Deny");
  expect(applyButton).toBeDisabled();
  click(roleElementByText("button", "Restore", drawer));

  expectPolicy(unknownRow, "Allow");
  expect(applyButton).toBeEnabled();
  click(roleElementByText("button", "Deny", unknownRow));

  expectPolicy(unknownRow, "Deny");
  expect(applyButton).toBeDisabled();
});

test.each(["click", "Enter", "Space"] as const)(
  "Activating an already allowed bulk policy with %s also allows other endpoints only on Apply",
  async (activation) => {
    const user = userEvent.setup({ delay: null });
    const appliedRequests: ApplyUserPermissionGrantsRequest[] = [];
    const drawer = await openPermissionEditor({
      grouped: false,
      unknownPolicy: "ask",
      appliedRequests,
    });
    const all = allPermissionsRow(drawer);
    const unknown = unknownPermissionRow(drawer);
    const allow = roleElementByText("button", "Allow", all);
    const apply = roleElementByText("button", "Apply", drawer);

    expectPolicy(all, "Allow");
    expect(roleElementByText("button", "Allow", unknown)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(roleElementByText("button", "Deny", unknown)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(apply).toBeDisabled();
    allow.focus();
    await user.keyboard("{ArrowRight}{Tab}");
    expect(roleElementByText("button", "Deny", all)).toHaveFocus();
    expect(apply).toBeDisabled();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(allow).toHaveFocus();

    if (activation === "click") {
      click(allow);
    } else {
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }

    expectPolicy(all, "Allow");
    expectPolicy(unknown, "Allow");
    expect(apply).toBeEnabled();
    expect(appliedRequests).toHaveLength(0);
    click(apply);
    await expect(
      screen.findByText("Permissions updated"),
    ).resolves.toBeInTheDocument();
    expectSinglePatch(appliedRequests, [
      { permission: UNKNOWN_PERMISSION_GRANT, action: "allow" },
    ]);
  },
);

test("Ask and mixed permissions remain distinct while group commands keep their scope", async () => {
  const appliedRequests: ApplyUserPermissionGrantsRequest[] = [];
  const drawer = await openPermissionEditor({
    permissionDefault: "ask",
    unknownPolicy: "ask",
    appliedRequests,
  });
  await expandReadGroup(drawer);
  const group = groupHeader(drawer);
  const bookmark = permissionRow(drawer, "bookmarks:read");
  const unknown = unknownPermissionRow(drawer);
  expect(roleElementByText("button", "Allow", bookmark)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(roleElementByText("button", "Deny", bookmark)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(within(group).queryByText("Mixed")).not.toBeInTheDocument();

  click(roleElementByText("button", "Allow", bookmark));
  expect(within(group).getByText("Mixed")).toBeInTheDocument();
  click(roleElementByText("button", "Allow", group));
  expectPolicy(group, "Allow");
  expect(within(group).queryByText("Mixed")).not.toBeInTheDocument();
  await chooseDuration(drawer, "Read", "Allow for 7d");
  expect(within(group).getByLabelText("Read allow options")).toHaveTextContent(
    "7d",
  );

  click(roleElementByText("button", "Deny", group));
  expectPolicy(group, "Deny");
  expect(
    within(group).queryByLabelText("Read allow options"),
  ).not.toBeInTheDocument();
  for (const permission of READ_PERMISSIONS) {
    const row = permissionRow(drawer, permission.name);
    expectPolicy(row, "Deny");
    expect(
      within(row).queryByLabelText(`${permission.name} allow options`),
    ).not.toBeInTheDocument();
  }
  expect(roleElementByText("button", "Deny", unknown)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(roleElementByText("button", "Allow", unknown)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(appliedRequests).toHaveLength(0);
  click(roleElementByText("button", "Apply", drawer));
  await expect(
    screen.findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
  expectSinglePatch(
    appliedRequests,
    READ_PERMISSIONS.map((permission) => {
      return { permission: permission.name, action: "deny" };
    }),
  );
});

test("Denying other endpoints clears the staged expiration before Apply", async () => {
  const appliedRequests: ApplyUserPermissionGrantsRequest[] = [];
  const drawer = await openPermissionEditor({
    unknownPolicy: "ask",
    appliedRequests,
  });
  const unknown = unknownPermissionRow(drawer);
  click(roleElementByText("button", "Allow", unknown));
  await chooseDuration(drawer, UNKNOWN_PERMISSION_GRANT, "Allow for 7d");
  expect(
    within(unknown).getByLabelText(`${UNKNOWN_PERMISSION_GRANT} allow options`),
  ).toHaveTextContent("7d");
  click(roleElementByText("button", "Deny", unknown));

  expectPolicy(unknown, "Deny");
  expect(
    within(unknown).queryByLabelText(
      `${UNKNOWN_PERMISSION_GRANT} allow options`,
    ),
  ).not.toBeInTheDocument();
  expect(appliedRequests).toHaveLength(0);
  click(roleElementByText("button", "Apply", drawer));
  await expect(
    screen.findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
  expectSinglePatch(appliedRequests, [
    { permission: UNKNOWN_PERMISSION_GRANT, action: "deny" },
  ]);
});

test("Saving disables bulk, individual, and other-endpoint permission commands", async () => {
  const save = context.mocks.deferred<void>();
  const appliedRequests: ApplyUserPermissionGrantsRequest[] = [];
  const drawer = await openPermissionEditor({
    grouped: false,
    permissionDefault: "deny",
    appliedRequests,
    onApply: () => {
      return save.promise;
    },
  });
  const all = allPermissionsRow(drawer);
  click(roleElementByText("button", "Allow", all));
  expectPolicy(all, "Allow");
  click(roleElementByText("button", "Apply", drawer));
  const saving = await waitForRoleElementByText("button", "Saving...", drawer);
  expect(saving).toBeDisabled();
  const rows = [
    all,
    ...READ_PERMISSIONS.map((permission) => {
      return permissionRow(drawer, permission.name);
    }),
    unknownPermissionRow(drawer),
  ];
  for (const row of rows) {
    expect(roleElementByText("button", "Allow", row)).toBeDisabled();
    expect(roleElementByText("button", "Deny", row)).toBeDisabled();
  }

  click(roleElementByText("button", "Deny", all));
  expectPolicy(all, "Allow");
  save.resolve();
  await expect(
    screen.findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
  expectSinglePatch(appliedRequests, [
    ...READ_PERMISSIONS.map((permission) => {
      return { permission: permission.name, action: "allow" as const };
    }),
    { permission: UNKNOWN_PERMISSION_GRANT, action: "allow" },
  ]);
});
