import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import {
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadPinOrderContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";
import { menuItemByText } from "./sidebar-test-helpers.tsx";

const context = testContext();
const launchId = "30000000-0000-4000-8000-000000000081";
const researchId = "30000000-0000-4000-8000-000000000082";
const at = "2026-11-02T00:00:00.000Z";

// A Project's rows are siblings in the virtual list, so its group is the
// ordered set of rows that carry its id.
function projectRows(projectId = launchId) {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `[data-project-row-id="${projectId}"]`,
    ),
  ];
}

function button(name: string, containers: readonly ParentNode[] = [document]) {
  const found = containers
    .flatMap((container) => {
      return queryAllByRoleFast("button", container);
    })
    .find((item) => {
      return (
        item.getAttribute("aria-label") === name ||
        item.textContent?.trim() === name
      );
    });
  if (!found) {
    throw new Error(`Button ${name} not found`);
  }
  return found;
}

function hasButton(name: string, containers: readonly ParentNode[]) {
  return containers.some((container) => {
    return queryAllByRoleFast("button", container).some((item) => {
      return item.textContent?.trim() === name;
    });
  });
}

function projectToggle(name: string, projectId = launchId) {
  return button(`Show or hide chats in ${name}`, projectRows(projectId));
}

function projectLink(name: string, projectId = launchId) {
  const link = projectRows(projectId)
    .flatMap((row) => {
      return queryAllByRoleFast("link", row);
    })
    .find((item) => {
      return item.textContent?.trim() === name;
    });
  if (!link) {
    throw new Error(`Project link ${name} not found`);
  }
  return link;
}

function threadLink(threadId: string) {
  return document.querySelector<HTMLAnchorElement>(
    `[data-sidebar-chat-thread-id="${threadId}"]`,
  );
}

// The chats a Project lists, in the order it lists them.
function projectChatTitles(projectId = launchId) {
  return projectRows(projectId).flatMap((row) => {
    return [
      ...row.querySelectorAll<HTMLElement>("[data-sidebar-chat-thread-id]"),
    ].map((link) => {
      return (
        link
          .querySelector('[data-slot="sidebar-thread-title"]')
          ?.textContent?.trim() ?? ""
      );
    });
  });
}

function projectText(projectId = launchId) {
  return projectRows(projectId).map((row) => {
    return row.textContent?.trim() ?? "";
  });
}

function chatMenuButton(threadId: string) {
  const row = threadLink(threadId)?.parentElement;
  if (!row) {
    throw new Error("Chat row not found");
  }
  return button("Open chat menu", [row]);
}

function installProjects(
  projects = [
    { id: launchId, name: "Launch", createdAt: at, updatedAt: at },
    { id: researchId, name: "Research", createdAt: at, updatedAt: at },
  ],
) {
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects,
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(agentDraftContract.patch, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadByIdContract.patch, ({ respond }) => {
    return respond(204);
  });
}

async function openChatList(
  caseId: number,
  threads: Parameters<typeof installContinuityWorkspace>[1]["threads"],
  path: string,
) {
  const workspace = installContinuityWorkspace(context, { caseId, threads });
  installProjects();
  await setupPage({
    context,
    path,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await waitFor(() => {
    expect(projectToggle("Launch")).toBeInTheDocument();
  });
}

test.each([
  { mobile: false, archivedOutside: true },
  { mobile: false, archivedOutside: false },
  { mobile: true, archivedOutside: true },
  { mobile: true, archivedOutside: false },
])(
  "Projects populate the inbox without chats outside them (mobile: $mobile, archived outside: $archivedOutside)",
  async ({ mobile, archivedOutside }) => {
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 48rem)" && !mobile;
    });
    const member = {
      ...continuityThread(301, 1, "Launch planning"),
      projectId: launchId,
    };
    const archived = {
      ...continuityThread(301, 2, "Archived notes"),
      archived: true,
    };
    await openChatList(
      301,
      archivedOutside ? [member, archived] : [member],
      `/agents/${member.agentId}/chat`,
    );

    expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Your inbox is empty")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Start a conversation and it'll show up here"),
    ).not.toBeInTheDocument();
    expect(hasButton("Show archived chats", [document])).toBeFalsy();

    click(projectToggle("Launch"));
    await waitFor(() => {
      expect(projectChatTitles()).toStrictEqual(["Launch planning"]);
    });
    expect(screen.queryByText("Your inbox is empty")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Start a conversation and it'll show up here"),
    ).not.toBeInTheDocument();
    expect(hasButton("Show archived chats", [document])).toBeFalsy();

    click(projectToggle("Research", researchId));
    await waitFor(() => {
      expect(projectText(researchId)).toContain("No chats here yet");
    });
    expect(screen.queryByText("Your inbox is empty")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Start a conversation and it'll show up here"),
    ).not.toBeInTheDocument();
    expect(hasButton("Show archived chats", [document])).toBeFalsy();
  },
);

test.each([false, true])(
  "An inbox without Projects or active chats leads to archived chats (mobile: %s)",
  async (mobile) => {
    context.mocks.browser.matchMedia((query) => {
      return query === "(min-width: 48rem)" && !mobile;
    });
    const archived = {
      ...continuityThread(302, 1, "Archived notes"),
      archived: true,
    };
    const workspace = installContinuityWorkspace(context, {
      caseId: 302,
      threads: [archived],
    });
    installProjects([]);
    await setupPage({
      context,
      path: `/agents/${archived.agentId}/chat`,
      ...workspace.pageOptions,
      featureSwitches: { [FeatureSwitchKey.Projects]: true },
    });

    await expect(
      screen.findByText("Your inbox is empty"),
    ).resolves.toBeInTheDocument();
    click(button("Show archived chats"));
    await waitFor(() => {
      expect(threadLink(archived.id)).toBeInTheDocument();
    });
  },
);

test("An unfolded Project without chats offers the archived ones it holds", async () => {
  const ordinary = continuityThread(303, 1, "Ordinary chat");
  const archived = {
    ...continuityThread(303, 2, "Archived research"),
    projectId: launchId,
    archived: true,
  };
  await openChatList(303, [ordinary, archived], `/chats/${ordinary.id}`);
  const user = userEvent.setup({ delay: null });

  // Research holds no chat at all, so it only says so.
  await user.click(projectToggle("Research", researchId));
  expect(projectText(researchId)).toContain("No chats here yet");
  expect(hasButton("Show archived chats", projectRows(researchId))).toBeFalsy();

  await user.click(projectToggle("Launch"));
  expect(projectText()).toContain("No chats here yet");
  await user.click(button("Show archived chats", projectRows()));
  await waitFor(() => {
    expect(projectChatTitles()).toStrictEqual(["Archived research"]);
  });
  expect(location.pathname).toBe(`/chats/${ordinary.id}`);
});

test("A Project lists every chat it holds", async () => {
  const ordinary = continuityThread(304, 1, "Ordinary chat");
  const members = Array.from({ length: 21 }, (_, index) => {
    const timestamp = `2026-08-05T01:${index.toString().padStart(2, "0")}:00.000Z`;
    return chatListThread(30_400 + index, `Member ${index + 1}`, {
      projectId: launchId,
      sortAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
  await openChatList(304, [ordinary, ...members], `/chats/${ordinary.id}`);

  await userEvent.setup({ delay: null }).click(projectToggle("Launch"));
  const titles = projectChatTitles();
  expect(titles).toHaveLength(21);
  // The most recently active chat leads and the oldest one closes the list.
  expect(titles.at(0)).toBe("Member 21");
  expect(titles.at(-1)).toBe("Member 1");
});

test("Pinned chats in a Project move among themselves", async () => {
  const pinnedAt = "2026-09-01T00:00:00Z";
  // Its rank falls between the Project's pins, which it does not join.
  const outside = {
    ...continuityThread(305, 1, "Outside pin"),
    pinnedAt,
    pinOrder: "a0V",
  };
  const first = {
    ...continuityThread(305, 2, "First pin"),
    projectId: launchId,
    pinnedAt,
    pinOrder: "a0",
  };
  const second = {
    ...continuityThread(305, 3, "Second pin"),
    projectId: launchId,
    pinnedAt,
    pinOrder: "a1",
  };
  const regular = {
    ...continuityThread(305, 4, "Regular chat"),
    projectId: launchId,
  };
  const reordered: string[] = [];
  context.mocks.api(
    chatThreadPinOrderContract.reorder,
    ({ params, respond }) => {
      reordered.push(params.id);
      return respond(204);
    },
  );
  await openChatList(
    305,
    [outside, first, second, regular],
    `/chats/${outside.id}`,
  );
  await userEvent.setup({ delay: null }).click(projectToggle("Launch"));
  expect(projectChatTitles()).toStrictEqual([
    "First pin",
    "Second pin",
    "Regular chat",
  ]);

  click(chatMenuButton(second.id));
  await screen.findByRole("menu");
  click(menuItemByText("Move up"));
  await waitFor(() => {
    expect(projectChatTitles()).toStrictEqual([
      "Second pin",
      "First pin",
      "Regular chat",
    ]);
  });
  expect(reordered).toStrictEqual([second.id]);

  click(chatMenuButton(second.id));
  await screen.findByRole("menu");
  click(menuItemByText("Move down"));
  await waitFor(() => {
    expect(projectChatTitles()).toStrictEqual([
      "First pin",
      "Second pin",
      "Regular chat",
    ]);
  });
});

test("A pinned chat moves past another Agent's pin in the same Project", async () => {
  const pinnedAt = "2026-09-01T00:00:00Z";
  const ordinary = continuityThread(307, 1, "Ordinary chat");
  const first = {
    ...continuityThread(307, 2, "Other Agent pin"),
    projectId: launchId,
    agentId: "c7000000-0000-4000-a000-000000000009",
    pinnedAt,
    pinOrder: "a0",
  };
  const second = {
    ...continuityThread(307, 3, "Second pin"),
    projectId: launchId,
    pinnedAt,
    pinOrder: "a1",
  };
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  await openChatList(307, [ordinary, first, second], `/chats/${ordinary.id}`);
  await userEvent.setup({ delay: null }).click(projectToggle("Launch"));
  expect(projectChatTitles()).toStrictEqual(["Other Agent pin", "Second pin"]);

  click(chatMenuButton(second.id));
  await screen.findByRole("menu");
  click(menuItemByText("Move up"));
  await waitFor(() => {
    expect(projectChatTitles()).toStrictEqual([
      "Second pin",
      "Other Agent pin",
    ]);
  });
});

test("Double-clicking a Project's name opens its page and leaves its chats unfolded", async () => {
  const ordinary = continuityThread(306, 1, "Ordinary chat");
  const member = {
    ...continuityThread(306, 2, "Launch planning"),
    projectId: launchId,
  };
  // A Project page lists the default Agent's chats, so these belong to it.
  context.mocks.data.onboardingStatus({ defaultAgentId: ordinary.agentId });
  await openChatList(306, [ordinary, member], `/chats/${ordinary.id}`);
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "false");

  await userEvent.setup({ delay: null }).dblClick(projectLink("Launch"));
  await waitFor(() => {
    expect(location.pathname).toBe(`/projects/${launchId}`);
  });
  expect(projectToggle("Launch")).toHaveAttribute("aria-expanded", "true");
  expect(projectChatTitles()).toStrictEqual(["Launch planning"]);
});
