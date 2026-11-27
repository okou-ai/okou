import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click, fill } from "../../__tests__/page-helper.ts";
import { mockedClerk } from "../../__tests__/mock-auth.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "../okou-page/__tests__/chat-message-experience-test-helpers.ts";

const context = testContext();
const member = "member-navigation";
const personal = "/?settings=my-okou&focus=instructions";
async function start(path = personal) {
  const workspaces = [
    { id: "org_alpha", name: "Alpha" },
    { id: "org_beta", name: "Beta" },
  ];
  const memberships = workspaces.map((w) => {
    return {
      id: "membership-" + w.id,
      organization: w,
      role: "org:member",
    };
  });
  let active = workspaces[0]!;
  const clerk = context.mocks.clerk();
  mockedClerk.setActive.mockImplementation(({ organization }) => {
    const next = workspaces.find((w) => {
      return w.id === organization;
    });
    if (!next) {
      throw new Error("Unknown workspace");
    }
    active = next;
    mockedClerk.sessionGetToken.mockResolvedValue(next.id);
    clerk.organization({ activeOrg: active, memberships });
    clerk.stateChanged();
    return Promise.resolve();
  });
  context.mocks.api(instructionsContract.get, ({ respond }) => {
    return respond(200, {
      orgId: active.id,
      userId: member,
      content: active.name + " saved instructions",
      version: "saved-" + active.id,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
  });
  await setupPage({
    context,
    path,
    auth: {
      user: { id: member, fullName: "Taylor Member" },
      organization: { activeOrg: active, memberships },
    },
  });
}
const editor = () => {
  return screen.findByLabelText("Instructions", {
    selector: "[contenteditable]",
  });
};
async function dismiss() {
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).toBeNull();
  });
}
async function reopen(container?: HTMLElement) {
  click(await findFastControl("button", "My Okou", container));
  click(await findFastControl("tab", "Instructions", container));
  return editor();
}
async function changeWorkspace(name: string) {
  click(await screen.findByLabelText("Switch workspace"));
  const menu = await screen.findByRole("menu");
  click(await within(menu).findByText(name, { exact: true }));
  await waitFor(() => {
    return expect(menu).not.toBeInTheDocument();
  });
}
test("my-okou-007 A personal draft survives leaving its section and dismissing Settings", async () => {
  await start();
  await screen.findByText("Alpha saved instructions");
  await fill(await editor(), "Keep the release notes short.");
  let panel = await screen.findByRole("dialog");
  click(await findFastControl("button", "Chat", panel));
  await waitFor(() => {
    return expect(
      screen.queryByLabelText("Instructions", {
        selector: "[contenteditable]",
      }),
    ).toBeNull();
  });
  await expect(reopen(panel)).resolves.toHaveTextContent(
    "Keep the release notes short.",
  );
  await dismiss();
  await expect(reopen()).resolves.toHaveTextContent(
    "Keep the release notes short.",
  );
  panel = await screen.findByRole("dialog");
  expect(within(panel).getByText("Unsaved changes")).toBeInTheDocument();
});
test("my-okou-010 Switching back to Alpha restores only its personal Instructions draft", async () => {
  await start();
  await screen.findByText("Alpha saved instructions");
  await fill(await editor(), "Alpha local draft");
  await dismiss();
  await changeWorkspace("Beta");
  await reopen();
  await screen.findByText("Beta saved instructions");
  await fill(await editor(), "Beta local draft");
  await screen.findByText("Unsaved changes");
  await dismiss();
  await changeWorkspace("Alpha");
  await expect(reopen()).resolves.toHaveTextContent("Alpha local draft");
  await expect(editor()).resolves.not.toHaveTextContent("Beta local draft");
});

test("A retired agent profile link offers Home, where the member can open personal Instructions", async () => {
  await start("/agents/c0000000-0000-4000-a000-000000000001?tab=profile");
  await screen.findByText("That page isn't here.");
  expect(screen.queryByRole("dialog")).toBeNull();
  click(await screen.findByText("Back to home"));
  await screen.findByLabelText("Switch workspace");
  await expect(reopen()).resolves.toHaveTextContent("Alpha saved instructions");
  expect(location.pathname).toBe("/");
});
