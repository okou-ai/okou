import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  chatEventsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogPermissionDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  type ApplyUserPermissionGrantsRequest,
  type UserPermissionGrantResponse,
  userPermissionGrantsContract,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-contracts";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const AGENT_ID = "10000000-0000-4000-a000-000000000001";
const THREAD_ID = "20000000-0000-4000-a000-000000000001";
const NOW_MS = 1_893_456_000_000;
const CREATED_AT = "2029-12-01T00:00:00.000Z";

interface PermissionPageOptions {
  readonly userName: string;
  readonly agentName: string;
  readonly connectorSlug?: string;
  readonly connectorLabel?: string;
  readonly permission?: string;
  readonly permissionDescription?: string;
  readonly action?: string;
  readonly expiresIn?: "1h" | "24h" | "7d" | "always";
  readonly connectorParam?: "connectorSlug" | "ref";
  readonly grants?: readonly UserPermissionGrantResponse[];
  readonly grantLoadError?: boolean;
  readonly connectorAvailable?: boolean;
  readonly permissionDefault?: "allow" | "deny" | "ask";
  readonly permissionOverrides?: Readonly<
    Partial<Record<"allow" | "deny" | "ask", readonly string[]>>
  >;
  readonly unknownPolicy?: "allow" | "deny" | "ask";
  readonly callback?: {
    readonly prompt: string;
    readonly threadId: string;
  };
}

function agentFixture(displayName: string): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId: AGENT_ID,
    ownerId: "test-user-123",
    displayName,
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
}

function permissionMetadata({
  connectorSlug,
  connectorLabel,
  permission,
  permissionDescription,
  permissionDefault,
  permissionOverrides,
  unknownPolicy,
}: Required<
  Pick<
    PermissionPageOptions,
    | "connectorSlug"
    | "connectorLabel"
    | "permission"
    | "permissionDescription"
    | "permissionDefault"
    | "unknownPolicy"
  >
> &
  Pick<
    PermissionPageOptions,
    "permissionOverrides"
  >): PublicConnectorCatalogPermissionDetail {
  const permissions =
    permission === UNKNOWN_PERMISSION_GRANT
      ? []
      : [{ name: permission, description: permissionDescription }];
  const mutablePermissionOverrides = permissionOverrides
    ? Object.fromEntries(
        Object.entries(permissionOverrides).flatMap(([action, patterns]) => {
          return patterns ? [[action, [...patterns]]] : [];
        }),
      )
    : undefined;
  return {
    connectorSlug,
    label: connectorLabel,
    icon: {
      url: `https://assets.example.test/${connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    permissionCount: permissions.length,
    permissions,
    categories: null,
    defaultPolicy: {
      permissionDefault,
      ...(mutablePermissionOverrides
        ? { permissionOverrides: mutablePermissionOverrides }
        : {}),
      unknownPolicy,
    },
  };
}

function permissionGrant({
  connectorSlug = "slack",
  permission = "admin.analytics:read",
  action = "allow",
  expiresAt,
}: {
  readonly connectorSlug?: string;
  readonly permission?: string;
  readonly action?: "allow" | "deny";
  readonly expiresAt: string | null;
}): UserPermissionGrantResponse {
  return {
    agentId: AGENT_ID,
    connectorSlug,
    permission,
    action,
    expiresAt,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === text ||
      candidate.getAttribute("aria-label") === text
    );
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

function setupPermissionPage(options: PermissionPageOptions): Promise<void> {
  const connectorSlug = options.connectorSlug ?? "slack";
  const connectorLabel = options.connectorLabel ?? "Slack";
  const permission = options.permission ?? "admin.analytics:read";
  const permissionDescription =
    options.permissionDescription ?? "Access workspace analytics data";
  const permissionDefault = options.permissionDefault ?? "deny";
  const unknownPolicy = options.unknownPolicy ?? "deny";
  const connectorParam = options.connectorParam ?? "connectorSlug";

  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    expect(params.id).toBe(AGENT_ID);
    return respond(200, agentFixture(options.agentName));
  });
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      expect(params.connectorSlug).toBe(connectorSlug);
      if (options.connectorAvailable === false) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
      }
      return respond(200, {
        permissions: permissionMetadata({
          connectorSlug,
          connectorLabel,
          permission,
          permissionDescription,
          permissionDefault,
          permissionOverrides: options.permissionOverrides,
          unknownPolicy,
        }),
      });
    },
  );
  context.mocks.api(userPermissionGrantsContract.list, ({ query, respond }) => {
    expect(query.agentId).toBe(AGENT_ID);
    if (options.grantLoadError) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Permission grants unavailable" },
      });
    }
    return respond(200, [...(options.grants ?? [])]);
  });

  const params = new URLSearchParams({
    [connectorParam]: connectorSlug,
    permission,
    action: options.action ?? "allow",
  });
  if (options.expiresIn) {
    params.set("expiresIn", options.expiresIn);
  }
  if (options.callback) {
    params.set("threadId", options.callback.threadId);
    params.set("callbackPrompt", options.callback.prompt);
  }

  return setupPage({
    context,
    path: `/agents/${AGENT_ID}/permissions?${params.toString()}`,
    auth: {
      user: {
        id: "test-user-123",
        fullName: options.userName,
        firstName: options.userName,
      },
    },
  });
}

test("A user grants a time-limited connector permission and resumes the chat", async () => {
  mockNow(NOW_MS, context.signal);
  let applied: ApplyUserPermissionGrantsRequest | null = null;
  let resumedChat: ChatEventSendBody | null = null;
  context.mocks.api(userPermissionGrantsContract.apply, ({ body, respond }) => {
    applied = body;
    return respond(200, [
      permissionGrant({
        connectorSlug: "slack",
        permission: "catalog.analytics:read",
        expiresAt: "2030-01-02T00:00:00.000Z",
      }),
    ]);
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    resumedChat = body;
    return respond(201, {
      runId: "30000000-0000-4000-a000-000000000001",
      threadId: THREAD_ID,
    });
  });

  await setupPermissionPage({
    userName: "Dana",
    agentName: "Research Bot",
    connectorLabel: "Catalog Slack",
    permission: "catalog.analytics:read",
    permissionDescription: "Read catalog analytics",
    expiresIn: "24h",
    callback: {
      prompt: "Continue the analytics review",
      threadId: THREAD_ID,
    },
  });

  await expect(
    screen.findByText(
      "Hey Dana, you're updating your permissions for Research Bot.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Research Bot").length).toBeGreaterThan(0);
  expect(screen.getByText("Catalog Slack")).toBeInTheDocument();
  expect(screen.getByText("catalog.analytics:read")).toBeInTheDocument();
  expect(screen.getByText("Read catalog analytics")).toBeInTheDocument();
  expect(screen.getByLabelText("Permission duration")).toHaveTextContent(
    "24 hours",
  );

  click(buttonByText("Confirm"));

  await expect(
    screen.findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Expires in 24 hours")).toBeInTheDocument();
  await waitFor(() => {
    expect(resumedChat).not.toBeNull();
  });
  expect(applied).toStrictEqual({
    agentId: AGENT_ID,
    connectorSlug: "slack",
    mode: "patch",
    grants: [
      {
        permission: "catalog.analytics:read",
        action: "allow",
        expiresIn: "24h",
      },
    ],
  });
  expect(resumedChat).toStrictEqual(
    expect.objectContaining({
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      prompt: "Continue the analytics review",
    }),
  );
});

test("A user can allow a connector's uncatalogued endpoints without exposing an internal token", async () => {
  let applied: ApplyUserPermissionGrantsRequest | null = null;
  context.mocks.api(userPermissionGrantsContract.apply, ({ body, respond }) => {
    applied = body;
    return respond(200, [
      permissionGrant({
        connectorSlug: "cloudflare",
        permission: UNKNOWN_PERMISSION_GRANT,
        expiresAt: "2030-01-01T01:00:00.000Z",
      }),
    ]);
  });

  await setupPermissionPage({
    userName: "Casey",
    agentName: "Cloudflare Bot",
    connectorSlug: "cloudflare",
    connectorLabel: "Cloudflare",
    permission: UNKNOWN_PERMISSION_GRANT,
    permissionDescription: "Other endpoints",
    expiresIn: "1h",
  });

  await expect(
    screen.findByText(
      "Hey Casey, you're updating your permissions for Cloudflare Bot.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Cloudflare")).toBeInTheDocument();
  expect(screen.getByText("Other endpoints")).toBeInTheDocument();
  expect(screen.queryByText(UNKNOWN_PERMISSION_GRANT)).not.toBeInTheDocument();

  click(buttonByText("Confirm"));

  await expect(
    screen.findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
  expect(applied).toStrictEqual({
    agentId: AGENT_ID,
    connectorSlug: "cloudflare",
    mode: "patch",
    grants: [
      {
        permission: UNKNOWN_PERMISSION_GRANT,
        action: "allow",
        expiresIn: "1h",
      },
    ],
  });
});

test("An already effective permission does not ask for confirmation again", async () => {
  mockNow(NOW_MS, context.signal);
  await setupPermissionPage({
    userName: "Dana",
    agentName: "Research Bot",
    permission: "bookmarks:read",
    permissionDescription: "List channel bookmarks",
    permissionDefault: "allow",
    grants: [
      permissionGrant({
        permission: "bookmarks:read",
        expiresAt: "2029-12-31T23:00:00.000Z",
      }),
    ],
  });

  await expect(
    screen.findByText("Already allowed"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Duration")).not.toBeInTheDocument();
  expect(screen.queryByText("Expired")).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Confirm";
    }),
  ).toBeUndefined();
});

test("An already denied permission does not ask for denial again", async () => {
  await setupPermissionPage({
    userName: "Jordan",
    agentName: "Review Bot",
    action: "deny",
    grants: [permissionGrant({ action: "deny", expiresAt: null })],
  });

  await expect(
    screen.findByText("Already denied"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Duration")).not.toBeInTheDocument();
  expect(screen.queryByText(/Expires in/u)).not.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Confirm";
    }),
  ).toBeUndefined();
});

test("An older permission link can still deny connector access safely", async () => {
  let applied: ApplyUserPermissionGrantsRequest | null = null;
  context.mocks.api(userPermissionGrantsContract.apply, ({ body, respond }) => {
    applied = body;
    return respond(200, [permissionGrant({ action: "deny", expiresAt: null })]);
  });
  await setupPermissionPage({
    userName: "Morgan",
    agentName: "Ops Bot",
    connectorParam: "ref",
    action: "deny",
    grants: [permissionGrant({ expiresAt: null })],
  });

  await expect(
    screen.findByText(
      "Hey Morgan, you're updating your permissions for Ops Bot.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("Slack")).toBeInTheDocument();
  expect(
    screen.getByText("Access workspace analytics data"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Duration")).not.toBeInTheDocument();

  click(buttonByText("Confirm"));

  await expect(
    screen.findByText("Permissions denied"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(/Expires in/u)).not.toBeInTheDocument();
  expect(applied).toStrictEqual({
    agentId: AGENT_ID,
    connectorSlug: "slack",
    mode: "patch",
    grants: [{ permission: "admin.analytics:read", action: "deny" }],
  });
});

test.each(["not-a-date", new Date(NOW_MS).toISOString()])(
  "An expired or invalid allow grant (%s) requires fresh confirmation",
  async (expiresAt) => {
    mockNow(NOW_MS, context.signal);
    await setupPermissionPage({
      userName: "Taylor",
      agentName: "Research Bot",
      expiresIn: "24h",
      grants: [permissionGrant({ expiresAt })],
    });

    await expect(
      screen.findByText(
        "Hey Taylor, you're updating your permissions for Research Bot.",
      ),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Already allowed")).not.toBeInTheDocument();
    expect(buttonByText("Confirm")).toBeEnabled();
    expect(screen.getByLabelText("Permission duration")).toHaveTextContent(
      "24 hours",
    );
  },
);

test("Permission grants that cannot be loaded fail closed", async () => {
  await setupPermissionPage({
    userName: "Avery",
    agentName: "Load Error Bot",
    grantLoadError: true,
  });

  await expect(
    screen.findByText("Failed to load permission grants"),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Confirm";
    }),
  ).toBeUndefined();
});

test("A missing connector cannot be authorized", async () => {
  await setupPermissionPage({
    userName: "Dana",
    agentName: "Hidden Connector Bot",
    connectorSlug: "hidden-connector",
    connectorLabel: "Hidden Connector",
    permission: "hidden.permission",
    permissionDescription: "Hidden permission",
    connectorAvailable: false,
  });

  await expect(
    screen.findByText("Unknown connector: hidden-connector"),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Confirm";
    }),
  ).toBeUndefined();
});

test("An unsupported permission action fails closed", async () => {
  await setupPermissionPage({
    userName: "Dana",
    agentName: "Research Bot",
    action: "approve",
  });

  await expect(
    screen.findByText("Unknown permission action: approve"),
  ).resolves.toBeInTheDocument();
  expect(
    queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Confirm";
    }),
  ).toBeUndefined();
});
