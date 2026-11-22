import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  projectMenuItem,
  project,
  projectEditor,
  chooseProject,
} from "./project-editor-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
const context = testContext();
async function confirmSent(
  workspace: Awaited<ReturnType<typeof projectEditor>>,
  projectId: string | null,
  message: string,
) {
  const send = await waitFor(async () => {
    const btn = await findFastControl("button", "Send");
    expect(btn).toBeEnabled();
    return btn;
  });
  click(send);
  const posted = await workspace.created;
  expect(posted.project).toBe(projectId);
  await expect(workspace.sent).resolves.toContain(message);
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + posted.id);
  });
  await expect(screen.findByText(message)).resolves.toBeVisible();
}
test("projects-043 The composer preserves its message while changing from Launch to Campaign and sends to Campaign", async () => {
  const launch = project("Launch"),
    campaign = project("Campaign");
  const ws = await projectEditor(context, [launch, campaign]);
  const text = "Plan the launch";
  await fill(await findComposerEditor(), text);
  await chooseProject(launch.name);
  await screen.findByLabelText("Remove Launch");
  await clickComposerAddMenuItem("Project");
  const current = await projectMenuItem("Launch");
  expect(current).toHaveAttribute("aria-disabled", "true");
  click(await projectMenuItem("Campaign"));
  await screen.findByLabelText("Remove Campaign");
  await expect(findComposerEditor()).resolves.toHaveTextContent(text);
  await confirmSent(ws, campaign.id, text);
});
test("projects-044 Removing the Launch chip keeps the message and sends it outside any Project", async () => {
  const launch = project("Launch");
  const ws = await projectEditor(context, [launch], {
    path: "/projects/" + launch.id,
  });
  const text = "Outside the launch";
  await fill(await findComposerEditor(), text);
  click(await screen.findByLabelText("Remove Launch"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  expect(screen.queryByLabelText("Remove Launch")).toBeNull();
  await expect(findComposerEditor()).resolves.toHaveTextContent(text);
  await confirmSent(ws, null, text);
});
test("projects-045 The Coffee chip and current menu option display the folder emoji separately from its name", async () => {
  const coffee = project("☕ Coffee");
  await projectEditor(context, [coffee], { path: "/projects/" + coffee.id });
  const remove = await screen.findByLabelText("Remove ☕ Coffee"),
    chip = remove.parentElement!;
  expect(within(chip).getByText("☕")).toBeVisible();
  expect(within(chip).getByText("Coffee")).toBeVisible();
  await clickComposerAddMenuItem("Project");
  const selected = await screen.findByText("Coffee", {
    selector: '[role="menuitem"] span.truncate',
  });
  const row = selected.closest('[role="menuitem"]')!;
  expect(within(row as HTMLElement).getByText("☕")).toBeVisible();
  expect(row).toHaveAttribute("aria-disabled", "true");
});
test("projects-046 A message entered on Home waits for its new Campaign project to be confirmed before sending", async () => {
  const gate = context.mocks.deferred<void>();
  const ws = await projectEditor(context, [], { createGate: gate.promise });
  const text = "Kick off the campaign";
  await fill(await findComposerEditor(), text);
  await chooseProject("New Project");
  const dialog = await screen.findByRole("dialog", { name: "Create Project" });
  await fill(within(dialog).getByRole("textbox"), "Campaign");
  click(await findFastControl("button", "Save", dialog));
  const id = await ws.creating;
  await waitFor(() => {
    return expect(location.pathname).toBe("/projects/" + id);
  });
  await screen.findByLabelText("Remove Campaign");
  await expect(findComposerEditor()).resolves.toHaveTextContent(text);
  const sending = await findFastControl("button", "Send");
  expect(sending).toBeDisabled();
  click(sending);
  expect(location.pathname).toBe("/projects/" + id);
  gate.resolve();
  await waitFor(() => {
    return expect(
      document.querySelector('button[aria-label="Send"]'),
    ).toBeEnabled();
  });
  await confirmSent(ws, id, text);
});
test("projects-029 Messages composed on the optimistic project home can be sent after creation is confirmed", async () => {
  const gate = context.mocks.deferred<void>();
  const ws = await projectEditor(context, [], { createGate: gate.promise });
  const text = "Confirm the campaign schedule";
  click(await findFastControl("button", "Create Project"));
  const dialog = await screen.findByRole("dialog", { name: "Create Project" });
  await fill(within(dialog).getByRole("textbox"), "Campaign");
  click(await findFastControl("button", "Save", dialog));
  const id = await ws.creating;
  click(await findFastControl("link", "New chat in Campaign"));
  await screen.findByLabelText("Remove Campaign");
  await fill(await findComposerEditor(), text);
  const send = await findFastControl("button", "Send");
  expect(send).toBeDisabled();
  gate.resolve();
  await waitFor(() => {
    return expect(
      document.querySelector('button[aria-label="Send"]'),
    ).toBeEnabled();
  });
  await confirmSent(ws, id, text);
});
