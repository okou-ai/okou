import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  setupPage,
  click,
  fill,
  swipeBack,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const launch = "66666666-0000-4000-8000-000000000019";
const timestamp = "2026-06-02T11:30:00Z";
async function projectWorkspace(start: "outside" | "member" | "home") {
  const planning = chatListThread(4, "Campaign planning", {
    projectId: launch,
  });
  const outside = chatListThread(2, "Other conversation");
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 199,
    threads: [outside, planning],
  });
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [
        {
          id: launch,
          name: "Launch",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      latestEventId: null,
      latestSeqId: 0,
    });
  });
  await setupPage({
    context,
    ...pageOptions,
    path:
      start === "home"
        ? "/projects/" + launch
        : "/chats/" + (start === "member" ? planning.id : outside.id),
  });
  const toggle = await findFastControl("button", /Launch/);
  const home = await findFastControl("link", "New chat in Launch");
  return {
    toggle,
    home,
    outside: "/chats/" + outside.id,
    member: "/chats/" + planning.id,
  };
}
async function fold(toggle: HTMLElement, expanded: boolean) {
  if (toggle.getAttribute("aria-expanded") !== String(expanded)) {
    click(toggle);
  }
  await waitFor(() => {
    expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
  });
}
function member() {
  return queryFastControl("link", "Campaign planning");
}
async function at(path: string) {
  await waitFor(() => {
    expect(location.pathname).toBe(path);
  });
}
async function arrow(direction: "Up" | "Down", expected: string) {
  const composer = await findComposerEditor();
  composer.focus();
  fireEvent.keyDown(composer, {
    key: "Arrow" + direction,
    ctrlKey: true,
    shiftKey: true,
  });
  await at(expected);
}
test("projects-014 The title folds Launch in place and its separate home link preserves the expanded project across Back", async () => {
  const p = await projectWorkspace("outside");
  await fold(p.toggle, false);
  click(p.toggle);
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  expect(location.pathname).toBe(p.outside);
  click(p.toggle);
  await waitFor(() => {
    expect(member()).toBeNull();
  });
  expect(location.pathname).toBe(p.outside);
  click(p.home);
  await at("/projects/" + launch);
  expect(p.home).toHaveAttribute("aria-current", "page");
  await fold(p.toggle, true);
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  swipeBack();
  await at(p.outside);
  expect(p.toggle).toHaveAttribute("aria-expanded", "true");
  expect(member()).toBeVisible();
});
test("projects-015 The title handles Enter and Space without navigating and Tab reaches the project home", async () => {
  const p = await projectWorkspace("member");
  await fold(p.toggle, true);
  const user = userEvent.setup({ delay: null });
  p.toggle.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(p.toggle).toHaveAttribute("aria-expanded", "false");
  });
  expect(location.pathname).toBe(p.member);
  await user.keyboard(" ");
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  expect(location.pathname).toBe(p.member);
  await user.keyboard("{Tab}");
  expect(p.home).toHaveFocus();
  await user.keyboard("{Enter}");
  await at("/projects/" + launch);
  expect(p.toggle).toHaveAttribute("aria-expanded", "true");
});
test("projects-012 Up enters the last visible Project chat and Down returns to the outside conversation", async () => {
  const p = await projectWorkspace("outside");
  await fold(p.toggle, true);
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  await arrow("Up", p.member);
  await arrow("Down", p.outside);
});
test("projects-013 Chat navigation skips a folded project member and returns to its folded Project page", async () => {
  const p = await projectWorkspace("member");
  await fold(p.toggle, false);
  await arrow("Down", p.outside);
  await arrow("Up", "/projects/" + launch);
  expect(p.toggle).toHaveAttribute("aria-expanded", "false");
  expect(member()).toBeNull();
});
test("projects-020 Opening Launch changes where ArrowDown goes from its Project home", async () => {
  const p = await projectWorkspace("home");
  await fold(p.toggle, false);
  await arrow("Down", p.outside);
  await arrow("Up", "/projects/" + launch);
  await fold(p.toggle, true);
  await arrow("Down", p.member);
  await waitFor(() => {
    expect(member()).toHaveAttribute("aria-current", "page");
  });
});
test("projects-021 A nonempty draft protects the Project fold while the empty composer handles both shortcuts", async () => {
  const p = await projectWorkspace("member");
  await fold(p.toggle, true);
  const editor = await findComposerEditor();
  editor.focus();
  const move = (key: string) => {
    fireEvent.keyDown(editor, { key, ctrlKey: true, shiftKey: true });
  };
  move("ArrowLeft");
  await waitFor(() => {
    expect(p.toggle).toHaveAttribute("aria-expanded", "false");
  });
  expect(location.pathname).toBe(p.member);
  move("ArrowRight");
  await waitFor(() => {
    expect(member()).toBeVisible();
  });
  await fill(editor, "Draft");
  move("ArrowLeft");
  expect(editor).toHaveTextContent("Draft");
  expect(p.toggle).toHaveAttribute("aria-expanded", "true");
  expect(location.pathname).toBe(p.member);
});
