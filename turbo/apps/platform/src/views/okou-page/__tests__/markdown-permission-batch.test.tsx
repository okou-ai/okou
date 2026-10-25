import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000071";

function batchUrl(): URL {
  const url = new URL(
    `https://app.okou.ai/agents/${AGENT_ID}/permissions/batch`,
  );
  url.searchParams.set("action", "allow");
  url.searchParams.set(
    "items",
    JSON.stringify([
      { connectorSlug: "slack", permission: "files:read" },
      { connectorSlug: "github", permission: "repos.read" },
      { connectorSlug: "slack", permission: "files:read" },
    ]),
  );
  return url;
}

async function openMarkdown(source: string, enabled: boolean) {
  const chat = createMarkdownChatFixture(context);
  chat.install({
    rows: () => {
      return [
        chat.outputMessage(source, { seqId: 1 }),
        chat.runCompleted({ seqId: 2 }),
      ];
    },
  });
  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BatchConnectorPermissions]: enabled },
  });
}

test("A markdown batch link renders grouped permissions without duplicate rows", async () => {
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      const github = params.connectorSlug === "github";
      return respond(200, {
        permissions: {
          connectorSlug: params.connectorSlug,
          label: github ? "GitHub" : "Slack",
          icon: {
            url: "https://assets.example.test/connector.svg",
            invertInDarkMode: false,
          },
          permissionCount: 1,
          permissions: [
            {
              name: github ? "repos.read" : "files:read",
              description: github
                ? "Read repositories"
                : "Read workspace files",
            },
          ],
          categories: null,
          defaultPolicy: { permissionDefault: "ask", unknownPolicy: "deny" },
        },
      });
    },
  );
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, []);
  });

  await openMarkdown(
    `Review these permissions.\n\n[Authorize tools](${batchUrl().toString()})`,
    true,
  );

  const card = await screen.findByTestId("permission-batch-action-card");
  const review = queryAllByRoleFast("button", card).find((button) => {
    return button.textContent?.trim() === "Review permissions";
  });
  expect(review).toBeEnabled();
  click(review!);
  const dialog = await screen.findByRole("dialog", {
    name: "Allow the following permissions",
  });
  await expect(
    within(dialog).findByText("Read repositories"),
  ).resolves.toBeInTheDocument();
  await expect(
    within(dialog).findByText("Read workspace files"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).getAllByText("files:read")).toHaveLength(1);
  expect(within(dialog).getByText("repos.read")).toBeInTheDocument();
  expect(screen.getByText("Review these permissions.")).toBeInTheDocument();
});

test("An invalid batch query renders the unavailable action instead of partial permissions", async () => {
  const url = batchUrl();
  url.searchParams.append("action", "allow");
  await openMarkdown(`[Authorize tools](${url.toString()})`, true);
  await expect(
    screen.findByTestId("unavailable-action-card"),
  ).resolves.toBeInTheDocument();
});

test("A batch link stays an ordinary markdown link while the feature is disabled", async () => {
  const href = batchUrl().toString();
  await openMarkdown(`[Authorize tools](${href})`, false);
  await screen.findByText("Authorize tools");
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent === "Authorize tools";
  });
  expect(link).toHaveAttribute("href", href);
});
