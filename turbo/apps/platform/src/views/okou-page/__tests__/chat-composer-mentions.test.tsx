import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import type { ChatThreadSnapshotProjection } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
import { AGENT_ID, context } from "./chat-composer-test-helpers.ts";

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
        error: { code: "AGENT_NOT_FOUND", message: "Agent not found" },
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

function buttonAvatar(button: HTMLElement): HTMLImageElement {
  const image = button.querySelector("img");
  if (!(image instanceof HTMLImageElement)) {
    throw new Error(`Expected avatar in ${button.textContent ?? "suggestion"}`);
  }
  return image;
}

function agentMention(
  composer: HTMLElement,
  agentId: string,
): HTMLElement | null {
  return composer.querySelector<HTMLElement>(
    `[data-agent-mention="${agentId}"]`,
  );
}

function threadMention(
  composer: HTMLElement,
  threadId: string,
): HTMLElement | null {
  return composer.querySelector<HTMLElement>(
    `[data-chat-thread-mention="${threadId}"]`,
  );
}

function withAgent(
  thread: ChatThreadSnapshotProjection,
  agentId: string,
): ChatThreadSnapshotProjection {
  return { ...thread, agentId };
}

async function setupMentionSearch(newChat: boolean) {
  const current = withAgent(
    continuityThread(61, 1, "Current mention chat"),
    AGENT_ID,
  );
  const projectBeta = withAgent(
    continuityThread(61, 2, "Project Beta"),
    AGENT_ID,
  );
  const projectBetaFollowUp = withAgent(
    continuityThread(61, 4, "Project Beta follow-up"),
    AGENT_ID,
  );
  const untitled = withAgent(continuityThread(61, 3, "Untitled"), AGENT_ID);
  const untitledThread = { ...untitled, title: null };
  const workspace = installContinuityWorkspace(context, {
    caseId: 61,
    threads: [current, projectBeta, untitledThread, projectBetaFollowUp],
  });
  installAgents([agent(AGENT_ID, "Scout", SCOUT_AVATAR)]);

  await setupPage({
    context,
    path: newChat ? `/agents/${AGENT_ID}/chat` : `/chats/${current.id}`,
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
    expect(within(menu).queryByText("New chat")).toBeNull();
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
  const current = withAgent(
    continuityThread(64, 1, "Current mention chat"),
    AGENT_ID,
  );
  const archived = withAgent(
    { ...continuityThread(64, 2, "Archived mention context"), archived: true },
    AGENT_ID,
  );
  const workspace = installContinuityWorkspace(context, {
    caseId: 64,
    threads: [current, archived],
  });
  installAgents([agent(AGENT_ID, "Scout", SCOUT_AVATAR)]);
  await setupPage({
    context,
    path: `/chats/${current.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.ChatThreadArchiving]: true },
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
  const current = withAgent(
    continuityThread(62, 1, "Scout planning"),
    AGENT_ID,
  );
  const matchingThread = withAgent(
    continuityThread(62, 2, "Zeta launch notes"),
    REVIEWER_ID,
  );
  const savedMentionThread = withAgent(
    continuityThread(62, 3, "Saved Zeta mention"),
    AGENT_ID,
  );
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

  await setupPage({
    context,
    path: newChat ? `/agents/${AGENT_ID}/chat` : `/chats/${current.id}`,
    ...workspace.pageOptions,
  });
  return { current, savedMentionThread, workspace };
}

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
    ).toStrictEqual(["Reviewer", "Private Ops", "Zeta Agent"]);
    expect(
      within(menu)
        .getByText("Agents")
        .compareDocumentPosition(within(menu).getByText("Chat threads")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(menuButton("Reviewer")).toHaveAttribute("data-active", "true");
    expect(within(menu).queryByText("Scout")).toBeNull();
    expect(within(menu).getByText("Zeta launch notes")).toBeInTheDocument();
    expect(composer).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(menuButton("Reviewer")).toHaveAttribute("data-active", "true");
    await user.keyboard("{ArrowDown}");
    expect(menuButton("Private Ops")).toHaveAttribute("data-active", "true");
    await user.keyboard("{ArrowUp}{Enter}");
    await waitFor(() => {
      expect(agentMention(composer, REVIEWER_ID)).toHaveTextContent("Reviewer");
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
  ).toStrictEqual(["Reviewer", "Private Ops", "Zeta Agent"]);
  expect(menuButton("Reviewer")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowUp}");
  expect(menuButton("Reviewer")).toHaveAttribute("data-active", "true");
  await user.keyboard("{ArrowDown}");
  expect(menuButton("Private Ops")).toHaveAttribute("data-active", "true");
});

test("Composer-anchored mentions navigate downward across groups and insert the visual target", async () => {
  await openAgentMentionWorkspace();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  await user.click(composer);
  await user.keyboard("@");
  const menu = await screen.findByTestId("chat-thread-suggestion-menu");
  const buttons = queryAllByRoleFast("button", menu);
  const threadTarget = buttons[3];
  if (!threadTarget?.textContent) {
    throw new Error("Expected a thread immediately below the agent group");
  }
  const threadTitle = threadTarget.textContent.trim();
  await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
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
    expect(menuButton("Private Ops")).toHaveAttribute("data-active", "true");
    await fill(composer, "@zeta");
    await waitFor(() => {
      expect(menuButton("Zeta Agent")).toHaveAttribute("data-active", "true");
    });
    fireEvent.compositionStart(composer, { data: "中文" });
    fireEvent.keyDown(composer, {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(mentionMenu()).toBeInTheDocument();
    expect(agentMention(composer, ZETA_ID)).toBeNull();
    expect(composer).toHaveTextContent("@zeta");
    fireEvent.compositionEnd(composer, { data: "中文" });
    await user.keyboard("{ArrowDown}");
    expect(menuButton("Zeta Agent")).not.toHaveAttribute("data-active");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("chat-thread-suggestion-menu")).toBeNull();
    });
    expect(composer).toHaveTextContent("@zeta");
    await user.click(composer);
    await screen.findByTestId("chat-thread-suggestion-menu");
    expect(menuButton("Zeta Agent")).toHaveAttribute("data-active", "true");
  },
);

test("Save a selected agent mention and retain it when returning to the chat", async () => {
  const { current, savedMentionThread, workspace } =
    await openAgentMentionWorkspace();
  const user = userEvent.setup({ delay: null });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "@zeta");
  const zetaSuggestion = await waitFor(() => {
    return menuButton("Zeta Agent");
  });
  expect(buttonAvatar(zetaSuggestion)).toHaveAttribute(
    "src",
    ZETA_CURRENT_AVATAR,
  );
  await user.click(zetaSuggestion);

  await waitFor(() => {
    const mention = agentMention(composer, ZETA_ID);
    expect(mention).toBeVisible();
    expect(mention).toHaveTextContent("Zeta Agent");
    expect(mention).toHaveAttribute(
      "data-agent-avatar-url",
      ZETA_CURRENT_AVATAR,
    );
  });
  await waitFor(() => {
    expect(
      workspace.draftPatches.some((patch) => {
        return patch.draftUserMessage?.parts.some((part) => {
          return part.type === "agent" && part.agentId === ZETA_ID;
        });
      }),
    ).toBeTruthy();
  });
  await openConversation(savedMentionThread.id);
  await screen.findByRole("textbox", { name: "Message" });
  await openConversation(current.id);
  const retainedComposer = await screen.findByRole("textbox", {
    name: "Message",
  });
  await waitFor(() => {
    expect(agentMention(retainedComposer, ZETA_ID)).toBeVisible();
  });
});

test("Mention a chat thread from any agent", async () => {
  const projectAlpha = withAgent(
    continuityThread(63, 1, "Project Alpha"),
    AGENT_ID,
  );
  const otherAlpha = withAgent(
    continuityThread(63, 2, "Other Alpha"),
    REVIEWER_ID,
  );
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

  expect(buttonAvatar(projectSuggestion)).toHaveAttribute("src", SCOUT_AVATAR);
  expect(buttonAvatar(otherSuggestion)).toHaveAttribute("src", REVIEWER_AVATAR);

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
