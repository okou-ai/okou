import {
  tailscaleContract,
  type TailscaleConfig,
  type TailscaleImpactPreview,
} from "@okouai/api-contracts/contracts/tailscale";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getAction } from "./connector-integrations-test-helpers.ts";

const context = testContext();
const orgId = "org_tailscale_parity";
const config: TailscaleConfig = Object.freeze({
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Development network",
  scope: "personal",
  tags: ["tag:okou", "tag:build"],
  revision: 1,
  generation: 1,
  sshHosts: [],
  vncHosts: [],
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
});
const shared: TailscaleConfig = Object.freeze({
  ...config,
  scope: "organization",
});
const impact: TailscaleImpactPreview = Object.freeze({
  expectedRevision: 1,
  ownHostCount: 0,
  otherHostCount: 2,
  affectedOwners: [{ userId: "other-owner", displayName: "Other Owner" }],
  impactSnapshot: "a".repeat(64),
});
const acknowledgement =
  "I understand these members' hosts will remain saved but cannot connect until their owners rebind them.";

beforeEach(() => {
  context.mocks.api(cloudflareAccessContract.list, ({ respond }) => {
    return respond(200, { configs: [] });
  });
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [config] });
  });
});

async function page() {
  context.mocks.data.org({ id: orgId, name: "Engineering", role: "admin" });
  await setupPage({
    context,
    auth: {
      user: { id: "tailscale-owner", fullName: "Tailscale Owner" },
      organization: {
        activeOrg: { id: orgId, name: "Engineering" },
        memberships: [{ id: orgId }],
      },
    },
    path: "/connectors?scope=private-network",
  });
  const section = await screen.findByRole("region", { name: "Tailscale" });
  await within(section).findByText(config.name);
  return section;
}

test("A common SSH notice refreshes network usage and restores deletion after unbinding", async () => {
  let current = config;
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  const section = await page();
  await within(section).findByText("Not used by any of your hosts");
  expect(getAction("button", "Delete Tailscale", section)).toBeEnabled();
  current = {
    ...config,
    sshHosts: [
      {
        id: "b0000000-0000-4000-8000-000000000001",
        displayName: "New private server",
      },
    ],
  };
  await act(() => {
    return context.mocks.ably.trigger("ssh:changed", { orgId });
  });
  await within(section).findByText("New private server");
  expect(getAction("button", "Delete Tailscale", section)).toBeDisabled();
  current = config;
  await act(() => {
    return context.mocks.ably.trigger("ssh:changed", { orgId });
  });
  await within(section).findByText("Not used by any of your hosts");
  expect(within(section).queryByText("New private server")).toBeNull();
  expect(getAction("button", "Delete Tailscale", section)).toBeEnabled();
});

test("Saving unchanged normalized metadata closes the editor even when writes are unavailable", async () => {
  context.mocks.api(tailscaleContract.update, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_ERROR", message: "Writes unavailable" },
    });
  });
  const section = await page();
  click(getAction("button", "Edit Tailscale", section));
  const dialog = await screen.findByRole("dialog");
  await fill(within(dialog).getByLabelText("Name"), `  ${config.name}  `);
  await fill(
    within(dialog).getByLabelText("Registration tags"),
    "tag:okou, tag:build",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(within(section).getByText(config.name)).toBeInTheDocument();
});

test("An intentional tag-order edit is saved against the current revision", async () => {
  let current = config;
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [current] });
  });
  context.mocks.api(tailscaleContract.update, ({ body, respond }) => {
    requests.push(body);
    current = { ...config, tags: body.tags ?? config.tags, revision: 2 };
    return respond(200, current);
  });
  const section = await page();
  click(getAction("button", "Edit Tailscale", section));
  const dialog = await screen.findByRole("dialog");
  await fill(
    within(dialog).getByLabelText("Registration tags"),
    "tag:build, tag:okou",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  await within(section).findByText("tag:build, tag:okou");
  expect(requests).toStrictEqual([
    {
      expectedRevision: 1,
      name: config.name,
      tags: ["tag:build", "tag:okou"],
    },
  ]);
});

test("Affected members expose identifiers only for ambiguous or unavailable names", async () => {
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
    return respond(200, {
      ...impact,
      otherHostCount: 4,
      affectedOwners: [
        { userId: "user_unique", displayName: "Unique Member" },
        { userId: "user_alpha_12345678", displayName: "Same Name" },
        { userId: "user_beta_12345678", displayName: "Same Name" },
        { userId: "user_gamma_87654321", displayName: null },
      ],
    });
  });
  const section = await page();
  click(getAction("button", "Make personal", section));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Unique Member");
  expect(dialog.textContent).not.toContain("user_unique");
  expect(dialog.textContent).toContain("Same Name (ID user_alpha_12345678)");
  expect(dialog.textContent).toContain("Same Name (ID user_beta_12345678)");
  expect(dialog.textContent).toContain("Name unavailable (ID …87654321)");
  expect(dialog.textContent).not.toContain("user_gamma");
});

test.each([
  { operation: "delete", label: "Delete Tailscale" },
  { operation: "adopt", label: "Make personal" },
] as const)(
  "A zero-impact $operation needs no other-owner acknowledgement",
  async ({ operation, label }) => {
    const requests: unknown[] = [];
    context.mocks.api(tailscaleContract.list, ({ respond }) => {
      return respond(200, { configs: [shared] });
    });
    context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
      return respond(200, {
        ...impact,
        otherHostCount: 0,
        affectedOwners: [],
      });
    });
    if (operation === "delete") {
      context.mocks.api(tailscaleContract.delete, ({ body, respond }) => {
        requests.push(body);
        return respond(204);
      });
    } else {
      context.mocks.api(
        tailscaleContract.convertToPersonal,
        ({ body, respond }) => {
          requests.push(body);
          return respond(200, {
            ...shared,
            scope: "personal",
            revision: 2,
            generation: 2,
          });
        },
      );
    }
    const section = await page();
    click(getAction("button", label, section));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      return expect(getAction("button", label, dialog)).toBeEnabled();
    });
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).queryByText(/Affected:/u)).toBeNull();
    click(getAction("button", label, dialog));
    await waitFor(() => {
      return expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(requests).toStrictEqual([
      { expectedRevision: 1, impactSnapshot: impact.impactSnapshot },
    ]);
  },
);

test("An uncertain shared conversion requires reviewing and acknowledging fresh impact before retry", async () => {
  let currentImpact = impact;
  const requests: unknown[] = [];
  context.mocks.api(tailscaleContract.list, ({ respond }) => {
    return respond(200, { configs: [shared] });
  });
  context.mocks.api(tailscaleContract.impactPreview, ({ respond }) => {
    return respond(200, currentImpact);
  });
  context.mocks.api(
    tailscaleContract.convertToPersonal,
    ({ body, respond }) => {
      requests.push(body);
      if (requests.length === 1) {
        currentImpact = {
          ...impact,
          expectedRevision: 2,
          otherHostCount: 3,
          impactSnapshot: "b".repeat(64),
        };
        return respond(500, {
          error: { code: "INTERNAL_ERROR", message: "provider-secret-canary" },
        });
      }
      return respond(200, { ...shared, scope: "personal", revision: 3 });
    },
  );
  const section = await page();
  click(getAction("button", "Make personal", section));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("Other Owner");
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  click(getAction("button", "Make personal", dialog));
  await within(dialog).findByText(
    "We could not confirm the conversion. Review the latest configuration before trying again.",
  );
  expect(getAction("button", "Make personal", dialog)).toBeDisabled();
  expect(dialog.textContent).not.toContain("provider-secret-canary");
  click(getAction("button", "Review latest impact", dialog));
  await within(dialog).findByText(/Affected: 1 member and 3 hosts\./u);
  expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
  expect(getAction("button", "Make personal", dialog)).toBeDisabled();
  expect(requests).toStrictEqual([
    { expectedRevision: 1, impactSnapshot: "a".repeat(64) },
  ]);
  await userEvent.click(
    within(dialog).getByRole("checkbox", { name: acknowledgement }),
  );
  click(getAction("button", "Make personal", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(requests).toStrictEqual([
    { expectedRevision: 1, impactSnapshot: "a".repeat(64) },
    { expectedRevision: 2, impactSnapshot: "b".repeat(64) },
  ]);
});
