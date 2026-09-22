import {
  cloudflareAccessContract,
  type CloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { screen, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const timestamp = "2026-09-22T00:00:00.000Z";
const config: CloudflareAccessConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Protected applications",
  revision: 1,
  generation: 1,
  sshHosts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});

beforeEach(() => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
});

async function page(path = "/connectors/cloudflare-access") {
  await setupPage({ context, path });
}

test("Cloudflare Access has a standalone connector detail page", async () => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
  await page();
  await expect(
    screen.findByRole("heading", { name: "Cloudflare Access" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText(
      "Access protected applications with Cloudflare Access Service Tokens.",
    ),
  ).toBeInTheDocument();
  expect(getAction("link", "Connectors")).toHaveAttribute(
    "href",
    "/connectors",
  );
  expect(screen.getByText(config.name)).toBeInTheDocument();
  expect(screen.queryByText("Direct")).toBeNull();
  expect(screen.queryByText("Add access")).toBeNull();
  expect(document.title).toContain("Cloudflare Access");
});

test("The directory add intent is consumed and creates through the canonical API", async () => {
  let configs: CloudflareAccessConfig[] = [];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  context.mocks.api(cloudflareAccessContract.create, ({ body, respond }) => {
    const created = { ...config, id: body.id, name: body.name };
    configs = [created];
    return respond(201, created);
  });
  await page("/connectors/cloudflare-access?add=1");
  const dialog = await screen.findByRole("dialog", {
    name: "Add Cloudflare Access",
  });
  expect(window.location.search).toBe("");
  await fill(within(dialog).getByLabelText("Name"), config.name);
  await fill(
    within(dialog).getByLabelText("Service Token Client ID"),
    "client-id",
  );
  await fill(
    within(dialog).getByLabelText("Service Token Client Secret"),
    "client-secret",
  );
  click(getAction("button", "Save", dialog));
  await expect(screen.findByText(config.name)).resolves.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("The standalone page refreshes from the neutral realtime event", async () => {
  const orgId = "org_cloudflare_access";
  let configs: CloudflareAccessConfig[] = [config];
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs });
  });
  await setupPage({
    context,
    path: "/connectors/cloudflare-access",
    auth: {
      user: { id: "access-owner", fullName: "Access Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
  });
  await screen.findByText(config.name);
  configs = [{ ...config, name: "Updated applications", revision: 2 }];
  context.mocks.ably.trigger("cloudflare-access:changed", { orgId });
  await expect(
    screen.findByText("Updated applications"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(config.name)).toBeNull();
});
