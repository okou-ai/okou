import { tailscaleContract } from "@okouai/api-contracts/contracts/tailscale";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  mockRemoteInventory,
  remoteId,
  REMOTE_TIMESTAMP,
} from "./connectors-remote-control-test-helpers.ts";
const context = testContext(),
  remote = "/connectors?scope=remote-control";
async function press(name: string | RegExp, box?: HTMLElement) {
  click(await findFastControl("button", name, box));
}
function network() {
  return {
    id: remoteId("a", 79),
    name: "Office network",
    revision: 1,
    generation: 1,
    scope: "personal" as const,
    createdAt: REMOTE_TIMESTAMP,
    updatedAt: REMOTE_TIMESTAMP,
    sshHosts: [],
    vncHosts: [],
  };
}
function field(name: string | RegExp) {
  return screen.getByLabelText(name, { selector: "input" });
}
test("remote-control-guided-setup-016 Adding a computer network retains the selected Tailscale connection through action choice and manual SSH", async () => {
  const inventory = mockRemoteInventory(context, { cloudflare: [network()] });
  context.mocks.api(tailscaleContract.create, ({ body, respond }) => {
    const saved = {
      ...network(),
      id: body.id,
      name: body.name,
      tags: body.tags,
    };
    inventory.tailscale.push(saved);
    return respond(201, saved);
  });
  await setupPage({ context, path: remote + "&setup=computer" });
  await screen.findByText(
    "Set up Tailscale so Okou can connect to your computer.",
  );
  expect(screen.queryByText("Cloudflare Access")).toBeNull();
  await press("Set up Tailscale");
  const guide = await screen.findByRole("dialog");
  await press("Enter existing credentials", guide);
  await fill(field("Network name"), "Home network");
  await fill(field("Client ID"), "local-id");
  await fill(field("Client Secret"), "local-secret");
  await fill(field("Allowed tags"), "tag:okou");
  await press("Save network");
  const next = await findFastControl("button", "Continue with this network");
  expect(next).toBeDisabled();
  const combo = await screen.findByRole("combobox", { name: /network/i });
  await userEvent.setup({ delay: null }).click(combo);
  expect(screen.queryByRole("option", { name: "Office network" })).toBeNull();
  await userEvent
    .setup({ delay: null })
    .click(await screen.findByRole("option", { name: "Home network" }));
  await press("Continue with this network");
  await findFastControl("button", /SSH/);
  expect(queryFastControl("button", "Private networks")).toBeNull();
  await press("Back");
  await expect(screen.findByText("Home network")).resolves.toBeVisible();
  await press("Continue with this network");
  await press(/SSH/);
  await screen.findByLabelText("SSH username");
  expect(field("Device address")).toHaveValue("");
  expect(document.body).toHaveTextContent("Home network");
  expect(
    screen.queryByRole("combobox", { name: "Connection method" }),
  ).toBeNull();
  click(screen.getByText("More settings", { selector: "summary" }));
  expect(
    screen.queryByRole("combobox", { name: "Connection method" }),
  ).toBeNull();
});
