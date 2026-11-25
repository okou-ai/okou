import { vncConnectionsContract } from "@okouai/api-contracts/contracts/vnc-connections";
import { HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockRemoteInventory } from "./connectors-remote-control-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const route = "/connectors?scope=remote-control&setup=vnc&step=profile",
  host = "screen.example.com",
  name = "Review station",
  secret = "Testvnc7";
const rejected =
  "Enter a valid hostname or IP address without a URL, username, or port.";
const button = (name: string | RegExp) => {
  return findFastControl("button", name);
};
async function press(name: string | RegExp) {
  click(await button(name));
}
function field(label: string | RegExp) {
  return screen.getByLabelText(label, { selector: "input" });
}
async function review() {
  mockRemoteInventory(context);
  await setupPage({ context, path: route });
  await screen.findByText("Choose a VNC login method");
  await press("Continue");
  await screen.findByText("Connect a device");
  await fill(field("Device address"), host);
  await press("Continue");
  await screen.findByText("Enter device login information");
  await fill(field("VNC password"), secret);
  await fill(field(/^Connection name/), name);
  await press("Continue");
  await screen.findByText("Review and save");
}
function invalidHost() {
  context.mocks.api(vncConnectionsContract.create, ({ respond }) => {
    return respond(400, {
      error: { code: "VNC_INVALID_HOST", message: "Invalid origin host" },
    });
  });
}
async function rejectedReview() {
  await review();
  invalidHost();
  await press("Save");
  await screen.findByText(rejected);
}
test("remote-control-guided-setup-056 An edited certificate name clears the first validation alert and a second rejection is visible", async () => {
  await rejectedReview();
  await fill(field("VNC certificate name"), "internal.example.com");
  await waitFor(() => {
    return expect(screen.queryByText(rejected)).toBeNull();
  });
  await press("Save");
  await screen.findByText(rejected);
  expect(screen.queryByText("Connection added")).toBeNull();
});
test("remote-control-guided-setup-058 An invalid-host alert clears on earlier steps while the name and address survive a second review", async () => {
  await rejectedReview();
  await press("Back");
  await screen.findByText("Enter device login information");
  expect(screen.queryByText(rejected)).toBeNull();
  expect(field(/^Connection name/)).toHaveValue(name);
  await press("Back");
  await screen.findByText("Connect a device");
  expect(field("Device address")).toHaveValue(host);
  expect(screen.queryByText(rejected)).toBeNull();
  await press("Continue");
  expect(field(/^Connection name/)).toHaveValue(name);
  await press("Continue");
  await screen.findByText("Review and save");
  expect(screen.queryByText(rejected)).toBeNull();
  await press("Save");
  await screen.findByText(rejected);
  expect(screen.queryByText("Connection added")).toBeNull();
});
test("remote-control-guided-setup-059 A rejection arriving after Back unlocks the earlier step and preserves the original hostname", async () => {
  await review();
  const held = context.mocks.deferred<void>(),
    arrived = context.mocks.deferred<void>();
  context.mocks.api(vncConnectionsContract.create, async ({ respond }) => {
    arrived.resolve();
    await held.promise;
    return respond(400, {
      error: { code: "VNC_INVALID_HOST", message: "Invalid origin host" },
    });
  });
  try {
    await press("Save");
    await arrived.promise;
    await expect(button(/Saving/)).resolves.toBeDisabled();
    await press("Back");
    await screen.findByText("Enter device login information");
    expect(field(/^Connection name/)).toBeDisabled();
    held.resolve();
    await waitFor(() => {
      return expect(field(/^Connection name/)).toBeEnabled();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    await press("Back");
    await screen.findByText("Connect a device");
    expect(field("Device address")).toHaveValue(host);
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    if (!held.settled()) {
      held.resolve();
    }
  }
});
test("remote-control-guided-setup-062 An uncertain service error stays attached to the locked review after backward and forward navigation", async () => {
  await review();
  context.mocks.api(vncConnectionsContract.create, ({ respond }) => {
    return respond(500, {
      error: { code: "SERVER_ERROR", message: "Failed to commit desktop" },
    });
  });
  await press("Save");
  await screen.findByText("Save failed.");
  await press("Back");
  await screen.findByText("Enter device login information");
  expect(screen.queryByText("Save failed.")).toBeNull();
  expect(field(/^Connection name/)).toHaveValue(name);
  expect(field(/^Connection name/)).toBeDisabled();
  await press("Continue");
  await screen.findByText("Review and save");
  await screen.findByText("Save failed.");
  await expect(button("Save")).resolves.toBeDisabled();
});
test("remote-control-guided-setup-065 Back retains an encrypted desktop draft and a new setup starts with blank fields", async () => {
  await review();
  await press("Back");
  await screen.findByText("Enter device login information");
  expect(field(/^Connection name/)).toHaveValue(name);
  expect(field("VNC password")).toHaveValue(secret);
  await press("Back");
  expect(field("Device address")).toHaveValue(host);
  await press("Remote control");
  await screen.findByText("No devices added yet");
  await press("Add connection");
  await press(/^VNC/);
  await screen.findByText("Choose a VNC login method");
  await press("Continue");
  expect(field("Device address")).toHaveValue("");
  await fill(field("Device address"), "new-screen.example.com");
  await press("Continue");
  await screen.findByText("Enter device login information");
  expect(field(/^Connection name/)).toHaveValue("");
  expect(field("VNC password")).toHaveValue("");
});
test("vnc-settings-051 A lost create response preserves and locks the reviewed password and device name", async () => {
  await review();
  context.mocks.http.post("*/api/vnc/connections", () => {
    return HttpResponse.error();
  });
  await press("Save");
  await screen.findByText("Save failed.");
  await expect(button("Save")).resolves.toBeDisabled();
  await press("Back");
  await screen.findByText("Enter device login information");
  expect(field(/^Connection name/)).toHaveValue(name);
  expect(field(/^Connection name/)).toBeDisabled();
  expect(field("VNC password")).toHaveValue(secret);
  expect(field("VNC password")).toBeDisabled();
});
