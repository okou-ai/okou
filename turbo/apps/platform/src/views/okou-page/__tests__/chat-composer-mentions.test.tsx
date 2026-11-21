import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { expect, test } from "vitest";

import {
  fill,
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  continuityDraft,
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { AGENT_ID } from "./chat-composer-test-helpers.ts";

const context = testContext();

const REVIEWER_ID = "e1000000-0000-4000-a000-000000000201";
const ZETA_ID = "e1000000-0000-4000-a000-000000000202";
const PRIVATE_OPS_ID = "e1000000-0000-4000-a000-000000000203";
const SALES_ID = "e1000000-0000-4000-a000-000000000204";
const FINANCE_ID = "e1000000-0000-4000-a000-000000000205";

const SCOUT_AVATAR = "https://cdn.vm7.io/avatars/scout.png";
const REVIEWER_AVATAR = "https://cdn.vm7.io/avatars/reviewer.png";
const ZETA_CURRENT_AVATAR =
  "https://cdn.vm7.io/avatars/zeta-current-avatar.png";

function agent(
  agentId: string,
  displayName: string,
  avatarUrl: string | null,
  visibility: "public" | "private" = "public",
): AgentResponse {
  return {
    isDefaultAgent: false,
    agentId,
    ownerId: "mention-owner",
    displayName,
    description: null,
    sound: null,
    avatarUrl,
    visibility,
  };
}

function installAgents(agents: readonly AgentResponse[]): void {
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, [...agents]);
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const match = agents.find((candidate) => {
      return candidate.agentId === params.id;
    });
    if (!match) {
      return respond(404, {
        error: {
          code: "AGENT_NOT_FOUND",
          message: "Workspace member unavailable.",
        },
      });
    }
    return respond(200, match);
  });
}

async function openConversation(threadId: string): Promise<void> {
  await waitFor(() => {
    expect(continuitySidebarLink(threadId)).toBeVisible();
  });
  click(continuitySidebarLink(threadId));
  await waitFor(() => {
    expect(continuitySidebarLink(threadId)).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      document.querySelector(`[data-chat-thread-container-id="${threadId}"]`),
    ).toBeVisible();
  });
}

function mentionMenu(): HTMLElement {
  return screen.getByTestId("chat-thread-suggestion-menu");
}

function menuButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button", mentionMenu()).find(
    (candidate) => {
      return candidate.textContent?.trim() === name;
    },
  );
  if (!button) {
    throw new Error(`Expected mention suggestion ${name}`);
  }
  return button;
}

function threadMention(
  composer: HTMLElement,
  threadId: string,
): HTMLElement | null {
  return composer.querySelector<HTMLElement>(
    `[data-chat-thread-mention="${threadId}"]`,
  );
}

async function setupMentionSearch(newChat: boolean) {
  const current = continuityThread(61, 1, "Current mention chat");
  const projectBeta = continuityThread(61, 2, "Project Beta");
  const projectBetaFollowUp = continuityThread(61, 4, "Project Beta follow-up");
  const untitled = continuityThread(61, 3, "Untitled");
  const untitledThread = { ...untitled, title: null };
  const workspace = installContinuityWorkspace(context, {
    caseId: 61,
    threads: [current, projectBeta, untitledThread, projectBetaFollowUp],
  });
  installAgents([agent(AGENT_ID, "Scout", SCOUT_AVATAR)]);

  await setupPage({
    context,
    path: newChat ? "/?compose=1" : `/chats/${current.id}`,
    ...workspace.pageOptions,
  });

  const user = userEvent.setup({ delay: null });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await user.click(composer);
  return { composer, user, projectBetaFollowUp };
}

test.each([false, true])(
  "Show matching chat threads in priority order from the top (new chat: %s)",
  async (newChat) => {
    context.mocks.browser.matchMedia(newChat);
    const { composer, user, projectBetaFollowUp } =
      await setupMentionSearch(newChat);
    await user.keyboard("@beta");
    const menu = await screen.findByTestId("chat-thread-suggestion-menu");

    expect(
      queryAllByRoleFast("button", menu).map((button) => {
        return button.textContent?.trim();
      }),
    ).toStrictEqual(["Project Beta follow-up", "Project Beta"]);
    expect(menuButton("Project Beta follow-up")).toHaveAttribute(
      "data-active",
      "true",
    );
    await user.keyboard("{ArrowUp}");
    expect(menuButton("Project Beta follow-up")).toHaveAttribute(
      "data-active",
      "true",
    );
    await user.keyboard("{ArrowDown}");
    expect(menuButton("Project Beta")).toHaveAttribute("data-active", "true");
    await user.keyboard("{ArrowUp}{Enter}");
    await waitFor(() => {
      expect(threadMention(composer, projectBetaFollowUp.id)).toHaveTextContent(
        "Project Beta follow-up",
      );
    });
    expect(screen.queryByTestId("chat-thread-suggestion-menu")).toBeNull();
    expect(composer).toHaveFocus();
  },
);

test("Keep archived chats in @ mention suggestions when archiving is enabled", async () => {
  const current = continuityThread(64, 1, "Current mention chat");
  const archived = {
    ...continuityThread(64, 2, "Archived mention context"),
    archived: true,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 64,
    threads: [current, archived],
  });
  installAgents([agent(AGENT_ID, "Scout", SCOUT_AVATAR)]);
  await setupPage({
    context,
    path: `/chats/${current.id}`,
    ...workspace.pageOptions,
  });

  await waitFor(() => {
    expect(screen.queryByText("Archived mention context")).toBeNull();
  });

  const user = userEvent.setup({ delay: null });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await user.click(composer);
  await user.keyboard("@archived");

  const menu = await screen.findByTestId("chat-thread-suggestion-menu");
  expect(within(menu).getByText("Archived mention context")).toBeVisible();
});

async function openAgentMentionWorkspace(newChat = false) {
  const current = continuityThread(62, 1, "Scout planning");
  const matchingThread = continuityThread(62, 2, "Zeta launch notes");
  const savedMentionThread = continuityThread(62, 3, "Saved Zeta mention");
  const agents = [
    agent(AGENT_ID, "Scout", SCOUT_AVATAR),
    agent(REVIEWER_ID, "Reviewer", REVIEWER_AVATAR),
    agent(PRIVATE_OPS_ID, "Private Ops", null, "private"),
    agent(ZETA_ID, "Zeta Agent", ZETA_CURRENT_AVATAR),
    agent(SALES_ID, "Sales Agent", null),
    agent(FINANCE_ID, "Finance Agent", null, "private"),
  ];
  const workspace = installContinuityWorkspace(context, {
    caseId: 62,
    threads: [current, matchingThread, savedMentionThread],
    drafts: new Map([
      [
        savedMentionThread.id,
        continuityDraft([
          {
            type: "agent",
            agentId: ZETA_ID,
            nameSnapshot: "Zeta Agent",
          },
        ]),
      ],
    ]),
  });
  installAgents(agents);
  // My Okou always chats with the default agent, at `/` for a new chat.

  await setupPage({
    context,
    path: newChat ? "/?compose=1" : `/chats/${current.id}`,
    ...workspace.pageOptions,
  });
  return { current, savedMentionThread, workspace };
}

test.each([false, true])(
  "Show the @ search hint until typing, selection or dismissal (new chat: %s)",
  async (newChat) => {
    await openAgentMentionWorkspace(newChat);
    const composer = await screen.findByRole("textbox", { name: "Message" });
    const user = userEvent.setup({ delay: null });
    const hint = () => {
      return composer.querySelector(
        '[data-placeholder=" Search chats or projects…"]',
      );
    };

    await fill(composer, "Draft @");
    await waitFor(() => {
      expect(hint()).toBeInTheDocument();
    });
    expect(composer.textContent).toBe("Draft @");
    expect(composer).toHaveFocus();

    fireEvent.compositionStart(composer, { data: "中文" });
    expect(hint()).toBeNull();
    fireEvent.keyDown(composer, {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(mentionMenu()).toBeInTheDocument();
    expect(composer.textContent).toBe("Draft @");
    fireEvent.compositionEnd(composer, { data: "中文" });
    await waitFor(() => {
      expect(hint()).toBeInTheDocument();
    });

    await user.keyboard("launch");
    expect(hint()).toBeNull();
    await waitFor(() => {
      expect(menuButton("Zeta launch notes")).toHaveAttribute(
        "data-active",
        "true",
      );
    });
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(
        composer.querySelector("[data-chat-thread-mention]"),
      ).toBeInTheDocument();
    });
    expect(hint()).toBeNull();

    await fill(composer, "Draft @");
    await waitFor(() => {
      expect(hint()).toBeInTheDocument();
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("chat-thread-suggestion-menu")).toBeNull();
      expect(hint()).toBeNull();
    });
    expect(composer.textContent).toBe("Draft @");
    expect(composer).toHaveFocus();
  },
);

test.each([false, true])(
  "Show the @ hint before adjacent text and preserve it when inserting a mention (new chat: %s)",
  async (newChat) => {
    await openAgentMentionWorkspace(newChat);
    const composer = await screen.findByRole("textbox", { name: "Message" });
    const user = userEvent.setup({ delay: null });
    const hint = () => {
      return composer.querySelector(
        '[data-placeholder=" Search chats or projects…"]',
      );
    };

    await fill(composer, "1231");
    const text = composer.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) {
      throw new Error("Composer text is unavailable");
    }
    window.getSelection()?.collapse(text, 0);
    fireEvent(document, new Event("selectionchange"));
    await user.keyboard("@");
    await waitFor(() => {
      expect(hint()).toBeInTheDocument();
    });
    expect(hint()?.nextSibling?.textContent).toBe("1231");
    expect(composer.textContent).toBe("@1231");
    expect(composer).toHaveFocus();

    await user.keyboard("launch");
    expect(hint()).toBeNull();
    await waitFor(() => {
      expect(menuButton("Zeta launch notes")).toHaveAttribute(
        "data-active",
        "true",
      );
    });
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(
        composer.querySelector("[data-chat-thread-mention]"),
      ).toBeInTheDocument();
    });
    expect(composer.textContent).toBe("Zeta launch notes 1231");
    expect(hint()).toBeNull();
  },
);

test.each([false, true])(
  "Composer-anchored mentions keep priority order and select the top candidate by default (new chat: %s)",
  async (newChat) => {
    context.mocks.browser.matchMedia(false);
    await openAgentMentionWorkspace(newChat);
    const composer = await screen.findByRole("textbox", { name: "Message" });
    const user = userEvent.setup({ delay: null });
    await user.click(composer);
    await user.keyboard("@");
    const menu = await screen.findByTestId("chat-thread-suggestion-menu");
    const buttons = queryAllByRoleFast("button", menu);
    expect(
      buttons.slice(0, 3).map((button) => {
        return button.textContent?.trim();
      }),
    ).toStrictEqual([
      "Saved Zeta mention",
      "Zeta launch notes",
      "Scout planning",
    ]);
    expect(within(menu).queryByText("Agents")).not.toBeInTheDocument();
    expect(menuButton("Saved Zeta mention")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(within(menu).queryByText("Scout")).toBeNull();
    expect(within(menu).getByText("Zeta launch notes")).toBeInTheDocument();
    expect(composer).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(menuButton("Saved Zeta mention")).toHaveAttribute(
      "data-active",
      "true",
    );
    await user.keyboard("{ArrowDown}");
    expect(menuButton("Zeta launch notes")).toHaveAttribute(
      "data-active",
      "true",
    );
    await user.keyboard("{ArrowUp}{Enter}");
    await waitFor(() => {
      expect(
        composer.querySelector("[data-chat-thread-mention]"),
      ).toHaveTextContent("Saved Zeta mention");
    });
    expect(screen.queryByTestId("chat-thread-suggestion-menu")).toBeNull();
    expect(composer).toHaveFocus();
  },
);

test("Composer-anchored mentions open above the centred start page composer too", async () => {
  // A wide window centres the start page's composer; the menu still opens
  // above it, with the most relevant row at the top of the menu.
  context.mocks.browser.matchMedia(true);
  await openAgentMentionWorkspace(true);
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  await user.click(composer);
  await user.keyboard("@");
  const menu = await screen.findByTestId("chat-thread-suggestion-menu");
  expect(menu).toHaveAttribute("data-side", "top");
  expect(
    queryAllByRoleFast("button", menu)
      .slice(0, 3)
      .map((button) => {
        return button.textContent?.trim();
      }),
  ).toStrictEqual([
    "Saved Zeta mention",
    "Zeta launch notes",
    "Scout planning",
  ]);
  expect(menuButton("Saved Zeta mention")).toHaveAttribute(
    "data-active",
    "true",
  );
  await user.keyboard("{ArrowUp}");
  expect(menuButton("Saved Zeta mention")).toHaveAttribute(
    "data-active",
    "true",
  );
  await user.keyboard("{ArrowDown}");
  expect(menuButton("Zeta launch notes")).toHaveAttribute(
    "data-active",
    "true",
  );
});

test("Composer-anchored mentions navigate downward and insert the visual target", async () => {
  await openAgentMentionWorkspace();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  await user.click(composer);
  await user.keyboard("@");
  const menu = await screen.findByTestId("chat-thread-suggestion-menu");
  const buttons = queryAllByRoleFast("button", menu);
  const threadTarget = buttons[1];
  if (!threadTarget?.textContent) {
    throw new Error("Expected a second chat suggestion");
  }
  const threadTitle = threadTarget.textContent.trim();
  await user.keyboard("{ArrowDown}");
  expect(threadTarget).toHaveAttribute("data-active", "true");
  await user.keyboard("{Tab}");
  await waitFor(() => {
    expect(
      composer.querySelector("[data-chat-thread-mention]"),
    ).toHaveTextContent(threadTitle);
  });
  expect(screen.queryByTestId("chat-thread-suggestion-menu")).toBeNull();
});

test.each([false, true])(
  "Composer-anchored mentions reset after filtering and preserve IME confirmation and Escape (new chat: %s)",
  async (newChat) => {
    context.mocks.browser.matchMedia(false);
    await openAgentMentionWorkspace(newChat);
    const composer = await screen.findByRole("textbox", { name: "Message" });
    const user = userEvent.setup({ delay: null });
    await user.click(composer);
    await user.keyboard("@");
    await screen.findByTestId("chat-thread-suggestion-menu");
    await user.keyboard("{ArrowDown}");
    expect(menuButton("Zeta launch notes")).toHaveAttribute(
      "data-active",
      "true",
    );
    await fill(composer, "@zeta");
    await waitFor(() => {
      expect(menuButton("Saved Zeta mention")).toHaveAttribute(
        "data-active",
        "true",
      );
    });
    fireEvent.compositionStart(composer, { data: "中文" });
    fireEvent.keyDown(composer, {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(mentionMenu()).toBeInTheDocument();
    expect(composer.querySelector("[data-chat-thread-mention]")).toBeNull();
    expect(composer).toHaveTextContent("@zeta");
    fireEvent.compositionEnd(composer, { data: "中文" });
    await user.keyboard("{ArrowDown}");
    expect(menuButton("Saved Zeta mention")).not.toHaveAttribute("data-active");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("chat-thread-suggestion-menu")).toBeNull();
    });
    expect(composer).toHaveTextContent("@zeta");
    await user.click(composer);
    await screen.findByTestId("chat-thread-suggestion-menu");
    expect(menuButton("Saved Zeta mention")).toHaveAttribute(
      "data-active",
      "true",
    );
  },
);

test("A saved mention keeps its name when the draft reopens", async () => {
  const { savedMentionThread } = await openAgentMentionWorkspace();
  await openConversation(savedMentionThread.id);
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Zeta Agent",
    );
  });
});

test("Mention a chat thread from any agent", async () => {
  const projectAlpha = continuityThread(63, 1, "Project Alpha");
  const otherAlpha = continuityThread(63, 2, "Other Alpha");
  const workspace = installContinuityWorkspace(context, {
    caseId: 63,
    threads: [projectAlpha, otherAlpha],
  });
  installAgents([
    agent(AGENT_ID, "Scout", SCOUT_AVATAR),
    agent(REVIEWER_ID, "Reviewer", REVIEWER_AVATAR),
  ]);

  await setupPage({
    context,
    path: `/chats/${projectAlpha.id}`,
    ...workspace.pageOptions,
  });

  const user = userEvent.setup();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await user.click(composer);
  await user.keyboard("Review @alpha");
  await screen.findByTestId("chat-thread-suggestion-menu");
  const projectSuggestion = menuButton("Project Alpha");
  const otherSuggestion = menuButton("Other Alpha");

  expect(projectSuggestion).toBeVisible();
  expect(otherSuggestion).toBeVisible();

  await user.click(otherSuggestion);

  await waitFor(() => {
    const mention = threadMention(composer, otherAlpha.id);
    expect(mention).toBeVisible();
    expect(mention).toHaveTextContent("Other Alpha");
    expect(
      workspace.draftPatches.some((patch) => {
        return patch.draftUserMessage?.parts.some((part) => {
          return part.type === "chat_thread" && part.threadId === otherAlpha.id;
        });
      }),
    ).toBeTruthy();
  });
});

test("Personal Okou mentions preserve authorized chat references without Agent destinations", async () => {
  await openAgentMentionWorkspace(true);
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "Review @Zeta");
  const chat = await waitFor(() => {
    return menuButton("Zeta launch notes");
  });
  expect(
    within(mentionMenu()).queryByText("Zeta Agent"),
  ).not.toBeInTheDocument();
  click(chat);
  await waitFor(() => {
    expect(composer).toHaveTextContent("Review Zeta launch notes");
  });
  expect(
    composer.querySelector("[data-chat-thread-mention]"),
  ).toHaveTextContent("Zeta launch notes");
});
