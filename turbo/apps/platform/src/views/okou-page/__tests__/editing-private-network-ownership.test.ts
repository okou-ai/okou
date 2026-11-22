import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { cloudflareAccessContract } from "@okouai/api-contracts/contracts/cloudflare-access";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  REMOTE_TIMESTAMP,
} from "./connectors-remote-control-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const privatePage = "/connectors?scope=private-network";
function networkSettings(
  provider: "tailscale" | "cloudflare",
  error?: 403 | 409,
) {
  const server = {
    id: remoteId("c", 83),
    name: "Studio office",
    scope: "personal" as "personal" | "organization",
    revision: 6,
    generation: 3,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [{ id: remoteId("b", 72), displayName: "Office build machine" }],
    vncHosts: [],
  };
  const ts = { ...server, tags: ["tag:office"] };
  const cf = { ...server };
  const row = provider === "tailscale" ? ts : cf;
  context.mocks.data.org({
    id: "org_default",
    name: "Engineering",
    role: "admin",
  });
  mockRemoteInventory(
    context,
    provider === "tailscale" ? { tailscale: [ts] } : { cloudflare: [cf] },
  );
  const transfer = context.mocks.deferred<void>(),
    received = context.mocks.deferred<void>();
  async function convert() {
    received.resolve();
    await transfer.promise;
    if (!error) {
      row.scope = "organization";
      row.revision++;
    }
  }
  context.mocks.api(
    tailscaleContract.convertToOrganization,
    async ({ respond }) => {
      await convert();
      return error
        ? respond(error, {
            error: { code: "CONFLICT", message: "Network has changed" },
          })
        : respond(200, ts);
    },
  );
  context.mocks.api(
    cloudflareAccessContract.convertToOrganization,
    async ({ respond }) => {
      await convert();
      return error
        ? respond(error, {
            error: {
              code: "FORBIDDEN",
              message: "Administrative role changed",
            },
          })
        : respond(200, cf);
    },
  );
  context.mocks.api(tailscaleContract.update, ({ body, respond }) => {
    if (body.name) {
      ts.name = body.name;
    }
    ts.revision++;
    return respond(200, ts);
  });
  context.mocks.api(cloudflareAccessContract.update, ({ body, respond }) => {
    if (body.name) {
      cf.name = body.name;
    }
    cf.revision++;
    return respond(200, cf);
  });
  return { row, transfer, received };
}
test.each([
  ["remote-control-guided-setup-133", "tailscale"],
  ["remote-control-guided-setup-134", "cloudflare"],
] as const)(
  "%s An administrator can share the edited %s network with its saved SSH reference intact",
  async (_id, provider) => {
    const { row, received, transfer } = networkSettings(provider);
    try {
      await setupPage({
        context,
        path: privatePage + "&remoteResource=" + provider + ":" + row.id,
      });
      click(await findFastControl("button", "Edit settings"));
      const name = await screen.findByLabelText("Network name");
      await fill(name, "Shared office draft");
      click(await screen.findByRole("radio", { name: /Organization members/ }));
      click(await findFastControl("button", "Save network"));
      await received.promise;
      expect(screen.queryByRole("dialog")).toBeNull();
      transfer.resolve();
      await screen.findByRole("heading", { name: "Shared office draft" });
      expect(
        screen.getByText("Engineering · Organization members"),
      ).toBeVisible();
      await expect(
        screen.findByText("Office build machine"),
      ).resolves.toBeVisible();
    } finally {
      if (!transfer.settled()) {
        transfer.resolve();
      }
    }
  },
);
test.each([
  [
    "remote-control-guided-setup-136",
    "tailscale",
    409,
    /network or its linked connections changed.*draft is kept/i,
  ],
  [
    "remote-control-guided-setup-137",
    "cloudflare",
    403,
    /network is unavailable or you no longer have the required administrator permission/i,
  ],
] as const)(
  "%s A failed %s ownership transfer preserves the unsaved name and disables saving",
  async (_id, provider, status, message) => {
    const { row, transfer, received } = networkSettings(provider, status);
    try {
      await setupPage({
        context,
        path: privatePage + "&network=" + provider + "&networkEdit=" + row.id,
      });
      const name = await screen.findByLabelText("Network name");
      await fill(name, "Retained after sharing failure");
      click(await screen.findByRole("radio", { name: /Organization members/ }));
      const save = await findFastControl("button", "Save network");
      click(save);
      await received.promise;
      transfer.resolve();
      await waitFor(() => {
        return expect(
          screen.getAllByRole("alert").some((el) => {
            return message.test(el.textContent ?? "");
          }),
        ).toBeTruthy();
      });
      expect(name).toHaveValue("Retained after sharing failure");
      expect(save).toBeDisabled();
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      if (!transfer.settled()) {
        transfer.resolve();
      }
    }
  },
);
test("remote-control-guided-setup-048 The deletion explanation identifies the linked hosts and returns focus on dismissal", async () => {
  const { row } = networkSettings("tailscale");
  await setupPage({
    context,
    path: privatePage + "&remoteResource=tailscale:" + row.id,
  });
  const remove = await findFastControl("button", "Delete Tailscale");
  expect(remove).toBeDisabled();
  const info = await findFastControl(
    "button",
    "Why can't I delete this network?",
  );
  click(info);
  const explanation = await screen.findByRole("dialog");
  expect(explanation).toHaveTextContent(/SSH or VNC hosts/i);
  expect(explanation).toHaveTextContent(/rebind|rebound/i);
  expect(explanation).toHaveTextContent(/delet/i);
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(explanation).not.toBeInTheDocument();
  });
  expect(info).toHaveFocus();
  expect(remove).toBeDisabled();
});
