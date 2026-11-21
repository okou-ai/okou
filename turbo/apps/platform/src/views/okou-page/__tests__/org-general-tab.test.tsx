import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { orgLogoContract } from "@okouai/api-contracts/contracts/org-logo";
import { cleanup, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { action, findAction } from "./workspace-billing-fixtures.ts";
const context = testContext();
const workspace = {
  id: "org_foundry",
  name: "Old Name",
  role: "admin",
} as const;
const logo = "https://images.example.org/foundry.png";
function general() {
  context.mocks.data.org(workspace);
  return visitGeneral(context);
}
async function visitGeneral(runtime: typeof context) {
  await setupPage({
    context: runtime,
    path: "/?settings=general",
    auth: {
      user: { id: "manager", fullName: "Marin" },
      organization: {
        activeOrg: workspace,
        memberships: [{ id: workspace.id, role: "org:admin" }],
      },
    },
    sharedWorkerTestTransport: "message-port",
  });
  return screen.findByPlaceholderText("Workspace name");
}
function existingLogo() {
  context.mocks.api(orgLogoContract.get, ({ respond }) => {
    return respond(200, { logoUrl: logo, hasImage: true });
  });
}
test("org-general-tab-005 A discarded rename leaves the published profile intact until Save", async () => {
  existingLogo();
  let profile = { ...workspace, name: "Old Name" };
  const edits: string[] = [];
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, profile);
  });
  context.mocks.api(orgContract.update, ({ body, respond }) => {
    edits.push(body.name ?? "");
    profile = { ...profile, name: body.name ?? profile.name };
    return respond(200, profile);
  });
  const field = await visitGeneral(context);
  expect(field).toHaveValue("Old Name");
  await expect(
    within(screen.getByRole("dialog")).findByRole("img", {
      name: "Old Name",
    }),
  ).resolves.toHaveAttribute("src", logo);
  await fill(field, "New Name");
  click(await action("Discard"));
  expect(field).toHaveValue("Old Name");
  expect(edits).toStrictEqual([]);
  await fill(field, "New Name");
  click(await action("Save changes"));
  await expect(
    screen.findByText("Workspace updated"),
  ).resolves.toBeInTheDocument();
  expect(field).toHaveValue("New Name");
  cleanup();
  const reloaded = await visitGeneral(createTestRuntime(context));
  await waitFor(() => {
    expect(reloaded).toHaveValue("New Name");
  });
});
test("org-general-tab-006 A rejected rename keeps the draft available for retry", async () => {
  context.mocks.api(orgContract.update, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Profile service unavailable",
      },
    });
  });
  const field = await general();
  expect(field).toHaveValue("Old Name");
  await fill(field, "New Name");
  click(await action("Save changes"));
  await expect(
    screen.findByText(/Profile service unavailable/),
  ).resolves.toBeInTheDocument();
  expect(field).toHaveValue("New Name");
  await expect(action("Save changes")).resolves.toBeEnabled();
  expect(screen.queryByText("Workspace updated")).toBeNull();
});
test("org-general-tab-008 Invalid logo files leave the published workspace image in place", async () => {
  existingLogo();
  context.mocks.browser.imageDimensions([
    null,
    { width: 80, height: 80 },
    { width: 5000, height: 5000 },
  ]);
  await general();
  const settings = screen.getByRole("dialog");
  const current = await within(settings).findByRole("img", {
    name: "Old Name",
  });
  for (const [file, message] of [
    ["broken", /Could not read image file/],
    ["tiny", /80×80px.*100×100px/],
    ["huge", /5000×5000px.*4096×4096px/],
  ] as const) {
    await userEvent.upload(
      within(settings).getByLabelText("Upload logo"),
      new File([file], file + ".png", { type: "image/png" }),
    );
    await expect(screen.findByText(message)).resolves.toBeInTheDocument();
    expect(current).toHaveAttribute("src", logo);
    expect(current).toBeInTheDocument();
    expect(findAction("Save changes", settings)).toBeUndefined();
  }
});
async function deletePrompt() {
  click(await action("Delete"));
  return screen.findByRole("dialog", { name: "Delete workspace?" });
}
test("org-general-tab-010 Cancelling clears permission to delete before the next confirmation", async () => {
  await general();
  const prompt = await deletePrompt();
  const text = within(prompt).getByRole("textbox");
  await fill(text, "confirm");
  await expect(action("Delete workspace", prompt)).resolves.toBeEnabled();
  click(await action("Cancel", prompt));
  expect(text).toHaveValue("");
  await waitFor(() => {
    return expect(prompt).not.toBeInTheDocument();
  });
  const reopened = await deletePrompt();
  expect(within(reopened).getByRole("textbox")).toHaveValue("");
  await expect(action("Delete workspace", reopened)).resolves.toBeDisabled();
});
test("org-general-tab-011 Only a literal confirm authorizes deleting the workspace and returning to organization selection", async () => {
  await general();
  const prompt = await deletePrompt();
  const submit = await action("Delete workspace", prompt);
  expect(submit).toBeDisabled();
  const input = within(prompt).getByRole("textbox");
  await fill(input, "confirm");
  expect(submit).toBeEnabled();
  for (const typo of ["Confirm", "confirm "]) {
    await fill(input, typo);
    expect(submit).toBeDisabled();
  }
  await fill(input, "confirm");
  expect(submit).toBeEnabled();
  click(submit);
  await expect(
    screen.findByText("Workspace deleted"),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/sign-in/tasks/choose-organization");
});
