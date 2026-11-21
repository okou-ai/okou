import { getAction } from "./connector-integrations-test-helpers.ts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorPermissionsContract,
  type ApplyConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-contracts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
  CAPABILITY_AGENT_ID,
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);
const NOW = "2026-11-20T08:00:00.000Z";
const CALENDAR = "calendar-service";
const REPORTS = "reports-service";
const SERVICES: Readonly<Record<string, string>> = {
  [CALENDAR]: "Calendar Service",
  [REPORTS]: "Reports Service",
};
const SCOPES: Readonly<Record<string, readonly string[]>> = {
  [CALENDAR]: ["events:read", "events:write"],
  [REPORTS]: ["reports:read", "reports:export"],
};
const ASSISTANT_TEXT = "I need a few permissions to build the weekly report.";

type GrantWrites = Record<string, ApplyConnectorPermissions["grants"]>;

function batchLink(items: readonly unknown[], expiresIn?: string): string {
  const url = new URL(
    `/agents/${CAPABILITY_AGENT_ID}/permissions/batch`,
    "https://app.okou.ai",
  );
  url.searchParams.set("items", JSON.stringify(items));
  url.searchParams.set("action", "allow");
  if (expiresIn) {
    url.searchParams.set("expiresIn", expiresIn);
  }
  return url.href;
}

function mockServiceMetadata(
  respondFor: (connectorSlug: string) => Promise<"ok" | "forbidden"> = () => {
    return Promise.resolve("ok");
  },
): void {
  context.mocks.api(
    connectorCatalogContract.permissions,
    async ({ params, respond }) => {
      const label = SERVICES[params.connectorSlug];
      if (!label) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
      }
      if ((await respondFor(params.connectorSlug)) === "forbidden") {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Metadata unavailable" },
        });
      }
      return respond(200, {
        permissions: permissionMetadata({
          connectorSlug: params.connectorSlug,
          label,
          permissions: SCOPES[params.connectorSlug] ?? [],
        }),
      });
    },
  );
}

/**
 * The member's saved grants. Each write is kept per connector, so a test can
 * read exactly which grants the batch asked the server to change.
 */
function mockSavedGrants(
  initial: readonly ConnectorPermissionFixture[] = [],
): GrantWrites {
  let grants = [...initial];
  const writes: GrantWrites = {};
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, connectorPermissionsResponse(query, grants));
  });
  context.mocks.api(connectorPermissionsContract.apply, ({ body, respond }) => {
    if (body.target.kind !== "builtin") {
      throw new Error("Expected a built-in connector target");
    }
    const { connectorSlug } = body.target;
    writes[connectorSlug] = body.grants;
    grants = [
      ...grants.filter((grant) => {
        return !(
          grant.connectorSlug === connectorSlug &&
          body.grants.some((written) => {
            return written.permission === grant.permission;
          })
        );
      }),
      ...body.grants.map((written) => {
        return {
          connectorSlug,
          permission: written.permission,
          action: written.action,
          expiresAt:
            written.expiresIn === "always" ? null : "2026-11-21T08:00:00.000Z",
        };
      }),
    ];
    return respond(200, connectorPermissionsResponse(body.target, grants));
  });
  return writes;
}

async function openChatWithAction(link: string): Promise<void> {
  mockNow(new Date(NOW), context.signal);
  installCapabilityChat({
    events: completedConversation(`${ASSISTANT_TEXT}\n\n${link}`),
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BatchConnectorPermissions]: true },
  });
  await readyChat();
  await expect(screen.findByText(ASSISTANT_TEXT)).resolves.toBeInTheDocument();
}

async function openBatchCard(link: string): Promise<HTMLElement> {
  await openChatWithAction(link);
  return await screen.findByTestId("permission-batch-action-card");
}

function buttonNamed(
  name: string,
  container: HTMLElement,
): HTMLElement | undefined {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === name;
  });
}

async function openReview(card: HTMLElement): Promise<HTMLElement> {
  const review = await waitFor(() => {
    const found = buttonNamed("Review permissions", card);
    if (!found) {
      throw new Error("Expected the Review permissions button");
    }
    return found;
  });
  click(review);
  return await screen.findByRole("dialog", {
    name: "Allow the following permissions",
  });
}

async function serviceGroup(
  review: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  const heading = await within(review).findByRole("heading", { name });
  const group = heading.closest("section");
  if (!group) {
    throw new Error(`Expected the ${name} permission group`);
  }
  return group;
}

async function allow(review: HTMLElement, name: string): Promise<void> {
  const button = await waitFor(() => {
    const found = buttonNamed(name, review);
    expect(found).toBeEnabled();
    return found as HTMLElement;
  });
  click(button);
  await expect(within(review).findByRole("status")).resolves.toHaveTextContent(
    "Permissions allowed",
  );
}

test("Review full scopes grouped by connector and apply the selected duration together", async () => {
  const writes = mockSavedGrants();
  mockServiceMetadata();
  const requestedLink = batchLink([
    { connectorSlug: CALENDAR, permission: "events:read" },
    { connectorSlug: REPORTS, permission: "reports:read" },
    { connectorSlug: CALENDAR, permission: "events:write" },
    { connectorSlug: REPORTS, permission: UNKNOWN_PERMISSION_GRANT },
  ]);
  const card = await openBatchCard(requestedLink);
  const review = await openReview(card);
  expect(getAction("link", "View permission details", review)).toHaveAttribute(
    "href",
    requestedLink,
  );

  const calendar = await serviceGroup(review, "Calendar Service");
  expect(within(calendar).getByText("events:read")).toBeInTheDocument();
  expect(within(calendar).getByText("Use events:read.")).toBeInTheDocument();
  expect(within(calendar).getByText("events:write")).toBeInTheDocument();
  expect(within(calendar).getByText("Use events:write.")).toBeInTheDocument();
  const reports = await serviceGroup(review, "Reports Service");
  expect(within(reports).getByText("reports:read")).toBeInTheDocument();
  expect(within(reports).getByText("Use reports:read.")).toBeInTheDocument();
  expect(within(reports).getByText("other endpoints")).toBeInTheDocument();
  expect(within(reports).getByText("Other endpoints")).toBeInTheDocument();

  const user = userEvent.setup();
  const duration = within(review).getByRole("combobox", {
    name: "Permission duration",
  });
  await waitFor(() => {
    expect(duration).toBeEnabled();
  });
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

  await allow(review, "Allow all 4 permissions");

  expect(writes).toStrictEqual({
    [CALENDAR]: [
      { permission: "events:read", action: "allow", expiresIn: "24h" },
      { permission: "events:write", action: "allow", expiresIn: "24h" },
    ],
    [REPORTS]: [
      {
        permission: UNKNOWN_PERMISSION_GRANT,
        action: "allow",
        expiresIn: "24h",
      },
      { permission: "reports:read", action: "allow", expiresIn: "24h" },
    ],
  });
  expect(within(card).getByText("Permissions allowed")).toBeInTheDocument();
});

test("Approve only missing scopes without reapplying or extending active grants", async () => {
  // Both active grants end in 30 minutes; a reapplied one would be extended.
  const writes = mockSavedGrants([
    {
      connectorSlug: CALENDAR,
      permission: "events:read",
      action: "allow",
      expiresAt: "2026-11-20T08:30:00.000Z",
    },
    {
      connectorSlug: REPORTS,
      permission: "reports:read",
      action: "allow",
      expiresAt: "2026-11-20T08:30:00.000Z",
    },
  ]);
  mockServiceMetadata();
  const card = await openBatchCard(
    batchLink([
      { connectorSlug: CALENDAR, permission: "events:read" },
      { connectorSlug: REPORTS, permission: "reports:read" },
      { connectorSlug: REPORTS, permission: "reports:export" },
    ]),
  );
  await expect(
    within(card).findByText("1 permission to allow"),
  ).resolves.toBeInTheDocument();
  const review = await openReview(card);
  await serviceGroup(review, "Reports Service");
  expect(within(review).getAllByText("Already allowed")).toHaveLength(2);

  await allow(review, "Allow all 3 permissions");

  expect(writes).toStrictEqual({
    [REPORTS]: [
      { permission: "reports:export", action: "allow", expiresIn: "1h" },
    ],
  });
  expect(within(card).getByText("Permissions allowed")).toBeInTheDocument();
});

test("Keep the whole batch unavailable when one connector's delayed authoritative metadata fails", async () => {
  // No grant write handler: any write would fail as an unhandled request.
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, connectorPermissionsResponse(query, []));
  });
  const release = context.mocks.deferred<void>();
  mockServiceMetadata(async (connectorSlug) => {
    await release.promise;
    return connectorSlug === REPORTS ? "forbidden" : "ok";
  });
  const card = await openBatchCard(
    batchLink([
      { connectorSlug: CALENDAR, permission: "events:read" },
      { connectorSlug: REPORTS, permission: "reports:read" },
      { connectorSlug: REPORTS, permission: "reports:export" },
    ]),
  );
  const review = await openReview(card);
  expect(buttonNamed("Allow all 3 permissions", review)).toBeDisabled();

  release.resolve();

  await expect(within(review).findByRole("alert")).resolves.toHaveTextContent(
    "Could not verify all requested permissions. No permissions can be changed.",
  );
  expect(buttonNamed("Allow all 3 permissions", review)).toBeDisabled();
  const details = queryAllByRoleFast("link", review).find((link) => {
    return link.textContent?.trim() === "View permission details";
  });
  expect(
    new URL(details?.getAttribute("href") ?? "", "https://app.okou.ai")
      .pathname,
  ).toBe(`/agents/${CAPABILITY_AGENT_ID}/permissions/batch`);
  expect(within(review).queryByRole("status")).not.toBeInTheDocument();
});

test("Reject the entire batch with an invalid original row", async () => {
  // No grant handlers: the unavailable batch neither reads nor writes grants.
  await openChatWithAction(
    batchLink([
      { connectorSlug: CALENDAR, permission: "events:read" },
      { connectorSlug: REPORTS, permission: 42 },
    ]),
  );

  await expect(
    screen.findByText("Action unavailable"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "This action does not belong to this chat or is no longer valid.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByTestId("permission-batch-action-card"),
  ).not.toBeInTheDocument();
  expect(buttonNamed("Review permissions", document.body)).toBeUndefined();
});
