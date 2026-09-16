import {
  connectorCatalogContract,
  type PublicConnectorCatalogPermissionDetail,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  userPermissionGrantsContract,
  type ApplyUserPermissionGrantsRequest,
  type UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import {
  CAPABILITY_AGENT_ID,
  context,
  completedConversation,
  type CapturedChatSend,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";
import {
  catalogConnector,
  connectorActionUrl,
  manualAuthMethod,
  permissionActionUrl,
  permissionMetadata,
} from "./chat-capability-connector-test-helpers.ts";

function installActionConversation(args: {
  readonly lines: readonly string[];
  readonly sends?: CapturedChatSend[];
}): void {
  installCapabilityChat({
    events: completedConversation(args.lines.join("\n\n")),
    onSend(send) {
      args.sends?.push(send);
    },
  });
}

function normalizedText(element: HTMLElement): string {
  return element.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function queryButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((element) => {
      return (
        element.getAttribute("aria-label") === name ||
        normalizedText(element) === name
      );
    }) ?? null
  );
}

function getButton(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButton(name, container);
  if (!button) {
    throw new Error(`${name} button was not available`);
  }
  return button;
}

function sentPrompts(sends: readonly CapturedChatSend[]): string[] {
  return sends.map((send) => {
    return send.prompt;
  });
}

function activeGrant(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly permission: string;
  readonly action: "allow" | "deny";
  readonly expiresAt?: string | null;
}): UserPermissionGrantResponse {
  return {
    agentId: CAPABILITY_AGENT_ID,
    connectorSlug: args.connectorSlug,
    permission: args.permission,
    action: args.action,
    expiresAt: args.expiresAt ?? null,
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

function permissionCard(description: string): HTMLElement {
  const text = screen.getByText(description);
  const card = text.closest<HTMLElement>(
    '[data-testid="permission-action-card"]',
  );
  if (!card) {
    throw new Error(`Permission card ${description} was not available`);
  }
  return card;
}

function installPermissionMetadata(
  lookup: (
    slug: ConnectorSlug,
  ) => PublicConnectorCatalogPermissionDetail | null,
): void {
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      const metadata = lookup(params.connectorSlug);
      return metadata
        ? respond(200, { permissions: metadata })
        : respond(404, {
            error: {
              code: "NOT_FOUND",
              message: "Permission metadata not found",
            },
          });
    },
  );
}

test.each([
  {
    expiresIn: "24h",
    durationMs: 24 * 60 * 60 * 1000,
    expiryText: "Expires in 24 hours",
  },
  {
    expiresIn: "7d",
    durationMs: 7 * 24 * 60 * 60 * 1000,
    expiryText: "Expires in 7 days",
  },
  {
    expiresIn: "1h",
    durationMs: 60 * 60 * 1000,
    expiryText: null,
  },
] as const)(
  "Keep the $expiresIn permission expiry stable when the browser clock is behind",
  async ({ expiresIn, durationMs, expiryText }) => {
    const connectorSlug = "clock-service";
    const permission = "records.read";
    const grantedAt = new Date("2030-01-01T00:00:00.000Z");
    mockNow(grantedAt.getTime() - 1000, context.signal);
    installPermissionMetadata((slug) => {
      return slug === connectorSlug
        ? permissionMetadata({
            connectorSlug,
            label: "Clock Service",
            permissions: [permission],
          })
        : null;
    });
    let grants: UserPermissionGrantResponse[] = [];
    context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, grants);
    });
    context.mocks.api(
      userPermissionGrantsContract.apply,
      ({ body, respond }) => {
        expect(body.grants).toStrictEqual([
          { permission, action: "allow", expiresIn },
        ]);
        grants = [
          {
            ...activeGrant({
              connectorSlug,
              permission,
              action: "allow",
              expiresAt: new Date(
                grantedAt.getTime() + durationMs,
              ).toISOString(),
            }),
            createdAt: grantedAt.toISOString(),
            updatedAt: grantedAt.toISOString(),
          },
        ];
        return respond(200, grants);
      },
    );
    installActionConversation({
      lines: [permissionActionUrl({ connectorSlug, permission, expiresIn })],
    });

    await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
    await readyChat();
    const card = await screen.findByTestId("permission-action-card");
    const confirm = await waitFor(() => {
      return getButton("Confirm", card);
    });
    click(confirm);

    await expect(
      within(card).findByText("Permissions updated"),
    ).resolves.toBeVisible();
    expect(within(card).queryByText(/Expires in/u)?.textContent ?? null).toBe(
      expiryText,
    );
  },
);

test("Fail closed and recover clearly from permission errors", async () => {
  const connectorSlug = "recovery-service";
  const connectorPermission = "records.read";
  const connectorControlSlug = "recovery-control";
  const sends: CapturedChatSend[] = [];
  const permission = permissionMetadata({
    connectorSlug,
    label: "Recovery Service",
    permissions: [connectorPermission],
  });
  let listCalls = 0;
  let applyCalls = 0;
  let refreshPending = false;
  const refreshGate = context.mocks.deferred<void>();
  installPermissionMetadata((slug) => {
    return slug === connectorSlug ? permission : null;
  });
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    return params.connectorSlug === connectorControlSlug
      ? respond(200, {
          connector: catalogConnector({
            slug: connectorControlSlug,
            label: "Recovery Control",
            method: manualAuthMethod(),
          }),
        })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
  });
  context.mocks.api(userPermissionGrantsContract.list, async ({ respond }) => {
    listCalls += 1;
    if (listCalls <= 2) {
      throw new TypeError("Permission service temporarily unavailable");
    }
    if (refreshPending) {
      await refreshGate.promise;
    }
    return respond(200, []);
  });
  context.mocks.api(userPermissionGrantsContract.apply, ({ body, respond }) => {
    applyCalls += 1;
    if (applyCalls === 1) {
      return respond(500, {
        error: { code: "SAVE_FAILED", message: "Permission save failed" },
      });
    }
    refreshPending = true;
    const applied = activeGrant({
      connectorSlug,
      permission: body.grants[0]!.permission,
      action: body.grants[0]!.action,
      expiresAt: "2027-08-01T09:00:00.000Z",
    });
    return respond(200, [applied]);
  });
  installActionConversation({
    lines: [
      permissionActionUrl({
        connectorSlug,
        permission: connectorPermission,
      }),
      connectorActionUrl({ slug: connectorControlSlug, action: "connect" }),
    ],
    sends,
  });

  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });

  await readyChat();
  const card = await screen.findByTestId("permission-action-card");
  const confirm = await waitFor(() => {
    return getButton("Confirm", card);
  });
  expect(listCalls).toBeGreaterThan(2);
  expect(applyCalls).toBe(0);
  expect(sends).toHaveLength(0);

  click(confirm);
  const updateFailure = await within(card).findByText(
    "Couldn't update permissions",
  );
  expect(updateFailure).toBeVisible();
  expect(getButton("Confirm", card)).toBeEnabled();
  expect(
    within(card).queryByText("Permissions updated"),
  ).not.toBeInTheDocument();

  click(getButton("Confirm", card));
  const updated = await within(card).findByText("Permissions updated");
  expect(updated).toBeVisible();
  const connectorCard = await screen.findByTestId("connector-action-card");
  expect(getButton("Connect", connectorCard)).toBeEnabled();
  expect(applyCalls).toBe(2);
  refreshGate.resolve(undefined);
});

test("Hide confirmation when connector permission details are invalid", async () => {
  const forbiddenSlug = "forbidden-service";
  const incompleteSlug = "incomplete-service";
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      if (params.connectorSlug === forbiddenSlug) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Permission details forbidden" },
        });
      }
      return respond(200, {
        permissions: permissionMetadata({
          connectorSlug: incompleteSlug,
          label: "Incomplete Service",
          permissions: ["known.operation"],
        }),
      });
    },
  );
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });
  installActionConversation({
    lines: [
      permissionActionUrl({
        connectorSlug: forbiddenSlug,
        permission: "records.read",
      }),
      permissionActionUrl({
        connectorSlug: incompleteSlug,
        permission: "missing.operation",
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const loadFailure = await screen.findByText(
    "Couldn't load permission status",
  );
  const unknownPermission = await screen.findByText("Unknown permission");
  const forbiddenCard = loadFailure.closest<HTMLElement>(
    '[data-testid="permission-action-card"]',
  );
  const incompleteCard = unknownPermission.closest<HTMLElement>(
    '[data-testid="permission-action-card"]',
  );
  expect(forbiddenCard).not.toBeNull();
  expect(incompleteCard).not.toBeNull();
  expect(queryButton("Confirm", forbiddenCard!)).not.toBeInTheDocument();
  expect(queryButton("Confirm", incompleteCard!)).not.toBeInTheDocument();
});

test("Reflect current connector permission decisions", async () => {
  const connectorSlug = "decision-service";
  let grants: UserPermissionGrantResponse[] = [
    activeGrant({
      connectorSlug,
      permission: "records.read",
      action: "allow",
      expiresAt: "2027-08-01T09:00:00.000Z",
    }),
    activeGrant({
      connectorSlug,
      permission: "records.write",
      action: "deny",
    }),
    activeGrant({
      connectorSlug,
      permission: "records.archive",
      action: "allow",
      expiresAt: "2025-08-01T09:00:00.000Z",
    }),
  ];
  installPermissionMetadata((slug) => {
    return slug === connectorSlug
      ? permissionMetadata({
          connectorSlug,
          label: "Decision Service",
          permissions: ["records.read", "records.write", "records.archive"],
        })
      : null;
  });
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, grants);
  });
  installActionConversation({
    lines: [
      permissionActionUrl({
        connectorSlug,
        permission: "records.read",
      }),
      permissionActionUrl({
        connectorSlug,
        permission: "records.write",
        action: "deny",
      }),
      permissionActionUrl({
        connectorSlug,
        permission: "records.archive",
      }),
    ],
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  const allowCard = permissionCard("Allow records.read");
  const denyCard = permissionCard("Deny records.write");
  const expiredCard = permissionCard("Allow records.archive");
  const allowed = await within(allowCard).findByText("Already allowed");
  expect(allowed).toBeVisible();
  expect(within(denyCard).getByText("Already denied")).toBeVisible();
  expect(within(expiredCard).getByText("Expired")).toBeVisible();
  expect(getButton("Confirm", expiredCard)).toBeEnabled();

  grants = [
    ...grants.filter((grant) => {
      return grant.permission !== "records.archive";
    }),
    activeGrant({
      connectorSlug,
      permission: "records.archive",
      action: "allow",
      expiresAt: "2027-08-01T09:00:00.000Z",
    }),
  ];
  context.mocks.ably.trigger("connectorPermissionUpdated");

  const externallyAllowed =
    await within(expiredCard).findByText("Already allowed");
  expect(externallyAllowed).toBeVisible();
  expect(queryButton("Confirm", expiredCard)).not.toBeInTheDocument();
});

test("Review and confirm connector permissions individually", async () => {
  const connectorSlug = "cloud-records";
  const sends: CapturedChatSend[] = [];
  const applyRequests: ApplyUserPermissionGrantsRequest[] = [];
  const followupGate = context.mocks.deferred<void>();
  let grants: UserPermissionGrantResponse[] = [];
  installPermissionMetadata((slug) => {
    return slug === connectorSlug
      ? permissionMetadata({
          connectorSlug,
          label: "Cloud Records",
          permissions: ["reports.read", "reference.read", "exports.run"],
        })
      : null;
  });
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, grants);
  });
  context.mocks.api(
    userPermissionGrantsContract.apply,
    async ({ body, respond }) => {
      applyRequests.push(body);
      const requested = body.grants[0]!;
      if (requested.permission === "exports.run") {
        await followupGate.promise;
      }
      const applied = activeGrant({
        connectorSlug,
        permission: requested.permission,
        action: requested.action,
        expiresAt:
          requested.action === "allow" ? "2027-08-01T09:00:00.000Z" : null,
      });
      grants = [
        ...grants.filter((grant) => {
          return grant.permission !== requested.permission;
        }),
        applied,
      ];
      return respond(200, [applied]);
    },
  );
  installActionConversation({
    lines: [
      permissionActionUrl({
        connectorSlug,
        permission: "reports.read",
        expiresIn: "7d",
      }),
      permissionActionUrl({
        connectorSlug,
        permission: "__unknown__",
      }),
      permissionActionUrl({
        connectorSlug,
        permission: "reference.read",
        action: "deny",
      }),
      permissionActionUrl({
        connectorSlug,
        permission: "exports.run",
        callbackPrompt: "Continue after export access",
      }),
    ],
    sends,
  });

  await setupPage({ context, path: RUN_PATH });

  await readyChat();
  await screen.findAllByTestId("permission-action-card");
  const reportsCard = permissionCard("Allow reports.read");
  const unknownCard = permissionCard("Allow other endpoints");
  const denyCard = permissionCard("Deny reference.read");
  const exportCard = permissionCard("Allow exports.run");

  click(
    within(reportsCard).getByRole("combobox", {
      name: "Permission duration",
    }),
  );
  click(await screen.findByRole("option", { name: "24 hours" }));
  click(getButton("Confirm", reportsCard));
  const reportsUpdated = await within(reportsCard).findByText(
    "Permissions updated",
  );
  expect(reportsUpdated).toBeVisible();
  expect(applyRequests[0]).toMatchObject({
    connectorSlug,
    grants: [{ permission: "reports.read", action: "allow", expiresIn: "24h" }],
  });
  expect(getButton("Confirm", unknownCard)).toBeEnabled();

  click(getButton("Confirm", unknownCard));
  const unknownUpdated = await within(unknownCard).findByText(
    "Permissions updated",
  );
  expect(unknownUpdated).toBeVisible();
  expect(applyRequests[1]).toMatchObject({
    grants: [{ permission: "__unknown__", action: "allow" }],
  });

  click(getButton("Confirm", denyCard));
  const denied = await within(denyCard).findByText("Permission denied");
  expect(denied).toBeVisible();
  expect(applyRequests[2]).toMatchObject({
    grants: [{ permission: "reference.read", action: "deny" }],
  });

  click(getButton("Confirm", exportCard));
  const saving = await waitFor(() => {
    return getButton("Saving...", exportCard);
  });
  expect(saving).toBeDisabled();
  expect(sends).toHaveLength(0);
  followupGate.resolve(undefined);
  await waitFor(() => {
    expect(sentPrompts(sends)).toStrictEqual(["Continue after export access"]);
  });
});
