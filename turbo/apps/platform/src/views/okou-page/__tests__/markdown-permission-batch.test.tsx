import {
  getAction,
  findAction,
} from "./connector-integrations-test-helpers.ts";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorPermissionsContract,
  type ConnectorPermissions,
} from "@okouai/api-contracts/contracts/connector-permissions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";
import { permissionMetadataFixture } from "../../team-page/__tests__/team-page-test-helpers.ts";

const context = testContext();

async function showRequest({
  serviceCount = 2,
  bothSlack = false,
  slackAllowed = false,
  catalogReady,
  saveReady,
}: {
  serviceCount?: number;
  bothSlack?: boolean;
  slackAllowed?: boolean;
  catalogReady?: Promise<void>;
  saveReady?: Promise<void>;
} = {}) {
  const services = [
    permissionMetadataFixture("slack", "Slack", ["files:read", "chat:write"]),
    permissionMetadataFixture("github", "GitHub", ["repos.read"]),
    permissionMetadataFixture("google-drive", "Google Drive", ["files.read"]),
    permissionMetadataFixture("notion", "Notion", ["pages.read"]),
    permissionMetadataFixture("linear", "Linear", ["issues.read"]),
  ];
  const grants = new Map<string, ConnectorPermissions["grants"]>();
  if (slackAllowed) {
    grants.set("slack", [
      { permission: "files:read", action: "allow", expiresAt: null },
    ]);
  }
  context.mocks.api(
    connectorCatalogContract.permissions,
    async ({ params, respond }) => {
      await catalogReady;
      const metadata = services.find((s) => {
        return s.connectorSlug === params.connectorSlug;
      });
      if (!metadata) {
        throw new Error("Unexpected service " + params.connectorSlug);
      }
      return respond(200, { permissions: metadata });
    },
  );
  context.mocks.api(connectorPermissionsContract.get, ({ query, respond }) => {
    return respond(200, {
      target: query,
      grants:
        query.kind === "builtin" ? (grants.get(query.connectorSlug) ?? []) : [],
    });
  });
  context.mocks.api(
    connectorPermissionsContract.apply,
    async ({ body, respond }) => {
      await saveReady;
      if (body.target.kind !== "builtin") {
        throw new Error("Expected a built-in connector");
      }
      const saved = body.grants.map((g) => {
        return {
          action: g.action,
          permission: g.permission,
          expiresAt: null,
        };
      });
      grants.set(body.target.connectorSlug, saved);
      return respond(200, { target: body.target, grants: saved });
    },
  );
  const items = services.slice(0, serviceCount).flatMap((s) => {
    return s.permissions.slice(0, bothSlack ? 2 : 1).map((p) => {
      return { permission: p.name, connectorSlug: s.connectorSlug };
    });
  });
  const chat = createMarkdownChatFixture(context);
  const params = new URLSearchParams({
    items: JSON.stringify(items),
    action: "allow",
  });
  params.set("orgId", "org_default");
  params.set("userId", "test-user-123");
  const link = "/connectors/permissions/batch?" + params;
  chat.install({
    rows: () => {
      return [
        chat.outputMessage(
          "Review the publication access. [Approve services](" + link + ")",
          { seqId: 1 },
        ),
        chat.runCompleted({ seqId: 2 }),
      ];
    },
  });
  await setupPage({
    context,
    path: chat.path,
    featureSwitches: { [FeatureSwitchKey.BatchConnectorPermissions]: true },
  });
}

test("markdown-permission-batch-003 one existing Slack grant reduces the review count", async () => {
  await showRequest({ slackAllowed: true });
  await expect(
    screen.findByText("1 permission to allow"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("1 already allowed")).toBeInTheDocument();
  expect(getAction("button", "Review permissions")).toBeEnabled();
});

test("markdown-permission-batch-002 the service overflow reveals all five names on hover", async () => {
  await showRequest({ serviceCount: 5 });
  await expect(
    screen.findByText("5 permissions to allow"),
  ).resolves.toBeInTheDocument();
  const logos = getAction(
    "button",
    "GitHub, Google Drive, Linear, Notion, Slack",
  );
  expect(logos.querySelectorAll("img")).toHaveLength(3);
  expect(within(logos).getByText("+2")).toBeInTheDocument();
  await userEvent.hover(logos);
  await expect(screen.findByRole("tooltip")).resolves.toHaveTextContent(
    "GitHub, Google Drive, Linear, Notion, Slack",
  );
});

test("markdown-permission-batch-004 review displays the two requested groups before their catalogs arrive", async () => {
  const release = context.mocks.deferred<void>();
  await showRequest({ bothSlack: true, catalogReady: release.promise });
  click(await findAction("button", "Review permissions"));
  const dialog = await screen.findByRole("dialog");
  const view = within(dialog);
  const groups = [...dialog.querySelectorAll('section[aria-hidden="true"]')];
  expect(
    groups
      .map((g) => {
        return g.querySelectorAll("li").length;
      })
      .sort(),
  ).toStrictEqual([1, 2]);
  await waitFor(() => {
    return expect(
      view.getByRole("combobox", { name: "Permission duration" }),
    ).toBeDisabled();
  });
  expect(getAction("button", "Allow all 3 permissions", dialog)).toBeDisabled();
  release.resolve();
  await expect(
    view.findByRole("heading", { name: "Slack" }),
  ).resolves.toBeInTheDocument();
  expect(view.getByRole("heading", { name: "GitHub" })).toBeInTheDocument();
  for (const name of ["chat:write", "files:read", "repos.read"]) {
    expect(view.getByText(name)).toBeInTheDocument();
  }
  expect(getAction("button", "Allow all 3 permissions", dialog)).toBeEnabled();
  expect(
    view.getByRole("combobox", { name: "Permission duration" }),
  ).toBeEnabled();
});

test("markdown-permission-batch-005 the approval dialog shows saved access back on its card", async () => {
  const release = context.mocks.deferred<void>();
  await showRequest({ saveReady: release.promise });
  await screen.findByText("2 permissions to allow");
  click(getAction("button", "Review permissions"));
  const dialog = await screen.findByRole("dialog");
  const view = within(dialog);
  click(getAction("button", "Allow all 2 permissions", dialog));
  await expect(
    findAction("button", "Saving...", dialog),
  ).resolves.toBeDisabled();
  expect(
    view.getByRole("combobox", { name: "Permission duration" }),
  ).toBeDisabled();
  expect(
    screen.getByText("Saving...", { selector: "div" }),
  ).toBeInTheDocument();
  release.resolve();
  await expect(
    view.findByText("Permissions allowed"),
  ).resolves.toBeInTheDocument();
  click(getAction("button", "Close", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(screen.getByText("Permissions allowed")).toBeInTheDocument();
  expect(getAction("button", "View permission details")).toBeEnabled();
});
