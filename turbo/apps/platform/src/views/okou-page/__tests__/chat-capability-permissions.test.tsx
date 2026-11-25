import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorPermissionsContract,
  type ApplyConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-contracts";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  connectorPermissionsResponse,
  type ConnectorPermissionFixture,
} from "../../../__tests__/connector-permissions.ts";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { permissionMetadata } from "./chat-capability-connector-test-helpers.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-capability-test-helpers.ts";

import { mockAuthorizationCallbackThread } from "./authorization-callback-test-helpers.ts";
const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
const NOW = "2026-11-20T08:00:00.000Z";
const RECORDS = "records-service";
const REPORTS = "reports-service";
const ASSISTANT_TEXT = "I need connector access to prepare the summary.";

type GrantWrite = ApplyConnectorPermissions["grants"][number];

function permissionLink(args: {
  readonly connectorSlug: string;
  readonly permission: string;
  readonly action?: "allow" | "deny";
  readonly expiresIn?: string;
  readonly callbackPrompt?: string;
}): string {
  const url = new URL("/connectors/permissions", "https://app.okou.ai");
  url.searchParams.set("orgId", "org_default");
  url.searchParams.set("userId", "test-user-123");
  url.searchParams.set("connectorSlug", args.connectorSlug);
  url.searchParams.set("permission", args.permission);
  url.searchParams.set("action", args.action ?? "allow");
  if (args.expiresIn) {
    url.searchParams.set("expiresIn", args.expiresIn);
  }
  if (args.callbackPrompt) {
    url.searchParams.set("callbackPrompt", args.callbackPrompt);
    url.searchParams.set("threadId", RUN_THREAD_ID);
  }
  return url.href;
}

function mockConnectorPermissions(
  connectorSlug: string,
  label: string,
  permissions: readonly string[],
): void {
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      if (params.connectorSlug !== connectorSlug) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
      }
      return respond(200, {
        permissions: permissionMetadata({ connectorSlug, label, permissions }),
      });
    },
  );
}

function grantExpiry(write: GrantWrite): string | null {
  const hours = { "1h": 1, "24h": 24, "7d": 168 } as const;
  if (write.action === "deny" || write.expiresIn === "always") {
    return null;
  }
  const duration = hours[write.expiresIn ?? "1h"];
  return new Date(Date.parse(NOW) + duration * 3_600_000).toISOString();
}

interface GrantServer {
  grants: ConnectorPermissionFixture[];
  readable: boolean;
  writable: boolean;
  /** The latest write for each permission. */
  writes: Record<string, GrantWrite>;
  /** Writes for these permissions wait until the test releases them. */
  holds: Map<string, Promise<void>>;
}

/** The member's saved grants for the connectors on the page. */
function mockGrantServer(
  initial: readonly ConnectorPermissionFixture[] = [],
): GrantServer {
  const server: GrantServer = {
    grants: [...initial],
    readable: true,
    writable: true,
    writes: {},
    holds: new Map(),
  };
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    if (!server.readable) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Permission status unavailable" },
      });
    }
    return respond(200, connectorPermissionsResponse(query, server.grants));
  });
  context.mocks.api(
    connectorPermissionsContract.apply,
    async ({ body, respond }) => {
      if (body.target.kind !== "builtin") {
        throw new Error("Expected a built-in connector target");
      }
      const { connectorSlug } = body.target;
      for (const write of body.grants) {
        server.writes[write.permission] = write;
        await server.holds.get(write.permission);
      }
      if (!server.writable) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Permission update rejected" },
        });
      }
      server.grants = [
        ...server.grants.filter((grant) => {
          return !body.grants.some((write) => {
            return (
              grant.connectorSlug === connectorSlug &&
              write.permission === grant.permission
            );
          });
        }),
        ...body.grants.map((write) => {
          return {
            connectorSlug,
            permission: write.permission,
            action: write.action,
            expiresAt: grantExpiry(write),
          };
        }),
      ];
      return respond(
        200,
        connectorPermissionsResponse(body.target, server.grants),
      );
    },
  );
  return server;
}

async function openPermissionChat(links: readonly string[]): Promise<void> {
  mockNow(new Date(NOW), context.signal);
  installCapabilityChat({
    events: completedConversation([ASSISTANT_TEXT, ...links].join("\n\n")),
  });
  mockAuthorizationCallbackThread(context, RUN_THREAD_ID);
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  await expect(screen.findByText(ASSISTANT_TEXT)).resolves.toBeInTheDocument();
}

async function findCard(request: string): Promise<HTMLElement> {
  const description = await screen.findByText(request);
  const card = description.closest<HTMLElement>(
    '[data-testid="permission-action-card"]',
  );
  if (!card) {
    throw new Error(`Expected the permission card for ${request}`);
  }
  return card;
}

function cardButton(card: HTMLElement, name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button", card).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

async function confirm(card: HTMLElement): Promise<void> {
  const button = await waitFor(() => {
    const found = cardButton(card, "Confirm");
    expect(found).toBeEnabled();
    return found as HTMLElement;
  });
  click(button);
}

test("Fail closed on permission load and save errors", async () => {
  const followUp = "Records access is ready. Continue the summary.";
  const server = mockGrantServer();
  server.readable = false;
  server.writable = false;
  mockConnectorPermissions(RECORDS, "Records Service", ["records.read"]);
  await openPermissionChat([
    permissionLink({
      connectorSlug: RECORDS,
      permission: "records.read",
      callbackPrompt: followUp,
    }),
  ]);
  const card = await findCard("Allow records.read");

  await expect(
    within(card).findByText("Couldn't load permission status"),
  ).resolves.toBeInTheDocument();
  expect(cardButton(card, "Confirm")).toBeUndefined();
  expect(screen.queryByText(followUp)).not.toBeInTheDocument();

  // The permission service recovers and announces fresh permission status.
  server.readable = true;
  context.mocks.ably.trigger("connectorPermissionUpdated");
  await confirm(card);

  await expect(
    within(card).findByText("Couldn't update permissions"),
  ).resolves.toBeInTheDocument();
  expect(within(card).queryByText("Permissions updated")).toBeNull();
  expect(screen.queryByText(followUp)).not.toBeInTheDocument();
});

test("Reflect current connector permission decisions", async () => {
  const server = mockGrantServer([
    {
      connectorSlug: RECORDS,
      permission: "records.read",
      action: "allow",
      expiresAt: "2027-06-01T00:00:00.000Z",
    },
    {
      connectorSlug: RECORDS,
      permission: "records.write",
      action: "deny",
      expiresAt: null,
    },
    {
      connectorSlug: RECORDS,
      permission: "records.archive",
      action: "allow",
      expiresAt: "2025-06-01T00:00:00.000Z",
    },
  ]);
  mockConnectorPermissions(RECORDS, "Records Service", [
    "records.read",
    "records.write",
    "records.archive",
  ]);
  await openPermissionChat([
    permissionLink({ connectorSlug: RECORDS, permission: "records.read" }),
    permissionLink({
      connectorSlug: RECORDS,
      permission: "records.write",
      action: "deny",
    }),
    permissionLink({ connectorSlug: RECORDS, permission: "records.archive" }),
  ]);

  const read = await findCard("Allow records.read");
  await expect(
    within(read).findByText("Already allowed"),
  ).resolves.toBeInTheDocument();
  expect(cardButton(read, "Confirm")).toBeUndefined();
  const write = await findCard("Deny records.write");
  await expect(
    within(write).findByText("Already denied"),
  ).resolves.toBeInTheDocument();
  const archive = await findCard("Allow records.archive");
  await expect(
    within(archive).findByText("Expired"),
  ).resolves.toBeInTheDocument();
  expect(cardButton(archive, "Confirm")).toBeEnabled();

  // Another tab allows the archive permission until 2027.
  server.grants = server.grants.map((grant) => {
    return grant.permission === "records.archive"
      ? { ...grant, expiresAt: "2027-06-01T00:00:00.000Z" }
      : grant;
  });
  context.mocks.ably.trigger("connectorPermissionUpdated");

  await expect(
    within(archive).findByText("Already allowed"),
  ).resolves.toBeInTheDocument();
  expect(cardButton(archive, "Confirm")).toBeUndefined();
});

test("Permission cards keep the full operation pending and expose callback failure", async () => {
  const followUp = "Reports access is ready. Continue the summary.";
  mockGrantServer();
  mockConnectorPermissions(REPORTS, "Reports Service", ["reports.read"]);
  await openPermissionChat([
    permissionLink({
      connectorSlug: REPORTS,
      permission: "reports.read",
      callbackPrompt: followUp,
    }),
  ]);
  const continuation: { prompt?: string } = {};
  const release = context.mocks.deferred<void>();
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    continuation.prompt = body.prompt;
    await release.promise;
    return respond(503, {
      error: { code: "SERVICE_UNAVAILABLE", message: "Run dispatch busy" },
    });
  });
  const card = await findCard("Allow reports.read");

  await confirm(card);

  // The grant is saved and the follow-up chat request is now pending.
  await waitFor(() => {
    expect(continuation.prompt).toBe(followUp);
  });
  expect(cardButton(card, "Saving...")).toBeDisabled();
  expect(within(card).queryByText("Permissions updated")).toBeNull();

  release.resolve();

  await expect(
    within(card).findByText("Couldn't update permissions"),
  ).resolves.toBeInTheDocument();
  expect(within(card).queryByText("Permissions updated")).toBeNull();
});

test("Review and confirm connector permissions individually", async () => {
  const followUp = "Exports are allowed. Continue the report.";
  const server = mockGrantServer();
  const exportHold = context.mocks.deferred<void>();
  server.holds.set("exports.run", exportHold.promise);
  mockConnectorPermissions(REPORTS, "Reports Service", [
    "reports.read",
    "reference.read",
    "exports.run",
  ]);
  await openPermissionChat([
    permissionLink({
      connectorSlug: REPORTS,
      permission: "reports.read",
      expiresIn: "7d",
    }),
    permissionLink({
      connectorSlug: REPORTS,
      permission: UNKNOWN_PERMISSION_GRANT,
    }),
    permissionLink({
      connectorSlug: REPORTS,
      permission: "reference.read",
      action: "deny",
    }),
    permissionLink({
      connectorSlug: REPORTS,
      permission: "exports.run",
      callbackPrompt: followUp,
    }),
  ]);

  const reports = await findCard("Allow reports.read");
  const duration = await within(reports).findByRole("combobox", {
    name: "Permission duration",
  });
  expect(duration).toHaveTextContent("7 days");
  const user = userEvent.setup({ delay: null });
  await user.click(duration);
  const day = await waitFor(() => {
    const option = queryAllByRoleFast("option").find((candidate) => {
      return candidate.textContent?.trim() === "24 hours";
    });
    if (!option) {
      throw new Error("Expected the 24 hours option");
    }
    return option;
  });
  await user.click(day);
  await waitFor(() => {
    expect(duration).toHaveTextContent("24 hours");
  });
  await confirm(reports);
  await expect(
    within(reports).findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();

  const unknown = await findCard("Allow other endpoints");
  await confirm(unknown);
  await expect(
    within(unknown).findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();

  const reference = await findCard("Deny reference.read");
  await confirm(reference);
  await expect(
    within(reference).findByText("Permission denied"),
  ).resolves.toBeInTheDocument();

  const exportsCard = await findCard("Allow exports.run");
  await confirm(exportsCard);
  await waitFor(() => {
    expect(cardButton(exportsCard, "Saving...")).toBeDisabled();
  });
  expect(screen.queryByText(followUp)).not.toBeInTheDocument();

  exportHold.resolve();

  await expect(screen.findByText(followUp)).resolves.toBeInTheDocument();
  await expect(
    within(exportsCard).findByText("Permissions updated"),
  ).resolves.toBeInTheDocument();
  expect(server.writes).toStrictEqual({
    "reports.read": {
      permission: "reports.read",
      action: "allow",
      expiresIn: "24h",
    },
    [UNKNOWN_PERMISSION_GRANT]: {
      permission: UNKNOWN_PERMISSION_GRANT,
      action: "allow",
      expiresIn: "1h",
    },
    "reference.read": { permission: "reference.read", action: "deny" },
    "exports.run": {
      permission: "exports.run",
      action: "allow",
      expiresIn: "1h",
    },
  });
});
