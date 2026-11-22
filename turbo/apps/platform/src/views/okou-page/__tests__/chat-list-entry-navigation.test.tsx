import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListThread,
  installChatListStream,
  installActiveChatBoundaries,
  sidebarThreadLinks,
} from "./chat-list-test-helpers.ts";
const context = testContext();
const history = [
  chatListThread(2, "Field notes"),
  chatListThread(7, "Design notes"),
  chatListThread(19, "Release notes"),
] as const;
const [older, middle, newest] = history;
async function openHistory(path: string, forYou: boolean) {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  installActiveChatBoundaries(context);
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    const row = history.find((item) => {
      return item.id === params.id;
    });
    if (!row) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Unknown thread" },
      });
    }
    return respond(200, {
      ...row,
      selectedModel: row.selectedModel ?? null,
      serviceTier: null,
      modelSettings: {},
      muted: false,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });
  installChatListStream(context, { caseId: 288, snapshot: history });
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: forYou },
  });
  await waitFor(() => {
    expect(sidebarThreadLinks()[0]).toHaveAttribute(
      "href",
      `/chats/${newest.id}`,
    );
  });
}
const up = "{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}";
const down = "{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}";

test("chat-list-entry-navigation-002 traverses New chat and the most recent thread in both directions", async () => {
  await openHistory(`/chats/${newest.id}`, false);
  const user = userEvent.setup({ delay: null });
  await screen.findByText("Release notes", {
    selector: '[data-testid="chat-thread-header-title"]',
  });
  await user.keyboard(up);
  await waitFor(() => {
    expect(location.pathname).toBe("/");
    expect(
      screen.getByText("New chat", { selector: '[aria-current="page"] *' }),
    ).toBeInTheDocument();
  });
  await user.keyboard(down);
  await waitFor(() => {
    expect(sidebarThreadLinks()[0]).toHaveAttribute("aria-current", "page");
    expect(location.pathname).toBe(`/chats/${newest.id}`);
  });
});

test("chat-list-entry-navigation-003 moves the focused side chat while keeping the main conversation open", async () => {
  const path = `/chats/${older.id}`;
  await openHistory(`${path}?sidebar=${newest.id}`, true);
  const user = userEvent.setup({ delay: null });
  const sideTitle = await screen.findByText("Release notes", {
    selector: '[data-testid="chat-thread-header-title"]',
  });
  const pane = sideTitle.closest<HTMLElement>('[aria-label="Chat thread"]')!;
  const composer = await within(pane).findByRole("textbox", {
    name: "Message",
  });
  await user.click(composer);
  await user.keyboard(up);
  expect(location.pathname).toBe(path);
  expect(new URL(location.href).searchParams.get("sidebar")).toBe(newest.id);
  await user.keyboard(down);
  await waitFor(() => {
    expect(new URL(location.href).searchParams.get("sidebar")).toBe(middle.id);
    expect(
      screen.getByText("Design notes", {
        selector: '[data-testid="chat-thread-header-title"]',
      }),
    ).toBeInTheDocument();
  });
  expect(location.pathname).toBe(path);
  expect(
    sidebarThreadLinks().find((link) => {
      return link.pathname === path;
    }),
  ).toHaveAttribute("aria-current", "page");
});
