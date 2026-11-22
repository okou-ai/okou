import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import type { ProjectEvent } from "@okouai/api-contracts/validators/projects";
import {
  chatThreadByIdContract,
  chatThreadsContract,
  chatThreadDraftContract,
  chatThreadPinOrderContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { menuItemByText } from "./sidebar-test-helpers.tsx";

const context = testContext();
const at = "2026-11-02T00:00:00.000Z";
const ids = [
  "30000000-0000-4000-8000-000000000091",
  "30000000-0000-4000-8000-000000000092",
  "30000000-0000-4000-8000-000000000093",
] as const;
const initialNames = ["Launch", "Research", "Campaign"] as const;

function button(name: string) {
  const found = queryAllByRoleFast("button").find((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      item.textContent?.trim() === name
    );
  });
  if (!found) {
    throw new Error(`Expected button ${name}`);
  }
  return found;
}
function toggle(name: string) {
  return button(`Show or hide chats in ${name}`);
}
function projectNames() {
  return queryAllByRoleFast("button")
    .map((item) => {
      return item.getAttribute("aria-label");
    })
    .filter((label): label is string => {
      return label?.startsWith("Show or hide chats in ") ?? false;
    })
    .map((label) => {
      return label.slice("Show or hide chats in ".length);
    });
}
async function expectProjects(names: readonly string[]) {
  await waitFor(() => {
    expect(projectNames()).toStrictEqual(names);
  });
}
function threadLink(id: string) {
  const link = document.querySelector<HTMLElement>(
    `[data-sidebar-chat-thread-id="${id}"]`,
  );
  if (!link) {
    throw new Error("Expected chat link");
  }
  return link;
}
function rootChatNames() {
  return [...document.querySelectorAll("[data-sidebar-chat-thread-id]")].map(
    (link) => {
      return link
        .querySelector('[data-slot="sidebar-thread-title"]')
        ?.textContent?.trim();
    },
  );
}
function dispatchMove(
  target: HTMLElement,
  key = "ArrowUp",
  extra: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key,
    altKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  fireEvent(target, event);
  return event;
}
async function prepare(projectPage = false, configure?: () => void) {
  const first = {
    ...continuityThread(341, 1, "First pin"),
    pinnedAt: at,
    pinOrder: "a0",
  };
  const second = {
    ...continuityThread(341, 2, "Second pin"),
    pinnedAt: at,
    pinOrder: "a1",
  };
  const child = {
    ...continuityThread(341, 3, "Research notes"),
    projectId: ids[1],
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 341,
    threads: [first, second, child],
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: { [child.id]: "unread" },
      unreadAt: { [child.id]: at },
    });
  });
  let events: ProjectEvent[] = [];
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: ids.map((id, index) => {
        return {
          id,
          name: initialNames[index]!,
          sortOrder: `a${index}`,
          createdAt: at,
          updatedAt: at,
        };
      }),
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return respond(200, {
      events: events.filter((event) => {
        return event.seqId > query.sinceSeqId;
      }),
      hasMore: false,
    });
  });
  context.mocks.api(projectsContract.reorder, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadPinOrderContract.reorder, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(composerDraftContract.patch, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(chatThreadByIdContract.patch, ({ respond }) => {
    return respond(204);
  });
  configure?.();
  await setupPage({
    context,
    path: projectPage ? `/projects/${ids[1]}` : `/chats/${second.id}`,
    ...workspace.pageOptions,
  });
  await expectProjects(initialNames);
  return {
    first,
    second,
    publish: (value: ProjectEvent[]) => {
      events = value;
    },
  };
}

test("Project menus move optimistically, reconcile remote events and retain group folding above root chats", async () => {
  const request = context.mocks.deferred<{
    eventId: string;
    targetId: string;
    side: string;
  }>();
  const response = context.mocks.deferred<void>();
  const { first, publish } = await prepare(false, () => {
    context.mocks.api(
      projectsContract.reorder,
      async ({ params, body, respond }) => {
        expect(params.id).toBe(ids[1]);
        request.resolve(body);
        await response.promise;
        return respond(204);
      },
    );
  });
  click(toggle("Research"));
  await waitFor(() => {
    expect(toggle("Research")).toHaveAttribute("aria-expanded", "true");
  });
  click(button("Options for Launch"));
  await screen.findByRole("menu");
  expect(menuItemByText("Move up")).toHaveAttribute("aria-disabled", "true");
  await userEvent.setup().keyboard("{Escape}");
  click(button("Options for Research"));
  await screen.findByRole("menu");
  click(menuItemByText("Move up"));
  const operation = await request.promise;
  expect(operation).toMatchObject({ targetId: ids[0], side: "before" });
  await expectProjects(["Research", "Launch", "Campaign"]);
  expect(toggle("Research")).toHaveAttribute("aria-expanded", "true");
  expect(toggle("Launch")).toHaveAttribute("aria-expanded", "false");
  expect(
    toggle("Campaign").compareDocumentPosition(threadLink(first.id)) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  // Another client moves the Project again after our accepted operation. The
  // confirmed local rank must no longer mask that later canonical event.
  publish([
    {
      id: operation.eventId,
      seqId: 2,
      projectId: ids[1],
      kind: "sort_updated",
      name: null,
      sortOrder: "Zz",
      createdAt: at,
    },
    {
      id: "30000000-0000-4000-8000-000000000094",
      seqId: 3,
      projectId: ids[1],
      kind: "sort_updated",
      name: null,
      sortOrder: "a3",
      createdAt: at,
    },
  ]);
  response.resolve();
  await expectProjects(["Launch", "Campaign", "Research"]);
  click(button("Options for Research"));
  await screen.findByRole("menu");
  expect(menuItemByText("Move down")).toHaveAttribute("aria-disabled", "true");
});

test("The focused Project row and menu own reorder keys instead of the current pinned chat", async () => {
  const { second } = await prepare();
  const user = userEvent.setup();
  toggle("Research").focus();
  await user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
  await expectProjects(["Research", "Launch", "Campaign"]);
  expect(rootChatNames()).toStrictEqual(["First pin", "Second pin"]);
  expect(toggle("Research")).toHaveFocus();
  expect(location.pathname).toBe(`/chats/${second.id}`);

  click(button("Options for Research"));
  await screen.findByRole("menu");
  menuItemByText("Move down").focus();
  await user.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}");
  await expectProjects(initialNames);
  // Base UI returns focus to the owning trigger when Alt is pressed.
  expect(button("Options for Research")).toHaveFocus();
  await user.keyboard("{Escape}");

  threadLink(second.id).focus();
  await user.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
  await waitFor(() => {
    expect(rootChatNames()).toStrictEqual(["Second pin", "First pin"]);
  });
  expect(projectNames()).toStrictEqual(initialNames);
});

test("Project page reorder preserves composer text and ignores composition, repeats and other modifiers", async () => {
  await prepare(true);
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "Unsent Project draft");
  expect(
    dispatchMove(composer, "ArrowUp", { isComposing: true }).defaultPrevented,
  ).toBeFalsy();
  expect(
    dispatchMove(composer, "ArrowUp", { repeat: true }).defaultPrevented,
  ).toBeFalsy();
  expect(
    dispatchMove(composer, "ArrowUp", { metaKey: true }).defaultPrevented,
  ).toBeFalsy();
  expect(dispatchMove(composer).defaultPrevented).toBeTruthy();
  await expectProjects(["Research", "Launch", "Campaign"]);
  expect(composer).toHaveTextContent("Unsent Project draft");
  expect(composer).toHaveFocus();
  expect(location.pathname).toBe(`/projects/${ids[1]}`);
  click(button("Open chat list menu"));
  await screen.findByRole("menu");
  const inbox = menuItemByText("Inbox");
  inbox.focus();
  // The open menu owns ArrowDown; its preventDefault is not a Project move.
  dispatchMove(inbox, "ArrowDown");
  expect(projectNames()).toStrictEqual(["Research", "Launch", "Campaign"]);
});

test("A failed request retains the optimistic move until a later confirmed move reconciles it", async () => {
  const response = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  const { publish } = await prepare(false, () => {
    context.mocks.api(projectsContract.reorder, async ({ respond }) => {
      requested.resolve();
      await response.promise;
      // Only the persistent stream settles local optimistic events.
      return respond(409, {
        error: { code: "CONFLICT", message: "Move confirmation unavailable" },
      });
    });
  });
  click(button("Options for Research"));
  await screen.findByRole("menu");
  click(menuItemByText("Move up"));
  await requested.promise;
  await expectProjects(["Research", "Launch", "Campaign"]);
  response.resolve();
  const errorToast = await screen.findByText("Move confirmation unavailable");
  expect(errorToast).toBeInTheDocument();
  expect(projectNames()).toStrictEqual(["Research", "Launch", "Campaign"]);

  // A subsequent accepted move settles its failed predecessor. A later remote
  // move must then win over both local optimistic projections.
  context.mocks.api(projectsContract.reorder, ({ body, respond }) => {
    publish([
      {
        id: body.eventId,
        seqId: 2,
        projectId: ids[1],
        kind: "sort_updated",
        name: null,
        sortOrder: "a1",
        createdAt: at,
      },
      {
        id: "30000000-0000-4000-8000-000000000095",
        seqId: 3,
        projectId: ids[1],
        kind: "sort_updated",
        name: null,
        sortOrder: "a3",
        createdAt: at,
      },
    ]);
    return respond(204);
  });
  click(button("Options for Research"));
  await screen.findByRole("menu");
  click(menuItemByText("Move down"));
  await expectProjects(["Launch", "Campaign", "Research"]);
});

test("A new Project stays at the tail before and after its creation is confirmed", async () => {
  const response = context.mocks.deferred<void>();
  const { publish } = await prepare(false, () => {
    context.mocks.api(projectsContract.create, async ({ body, respond }) => {
      await response.promise;
      publish([
        {
          id: body.eventId,
          seqId: 2,
          projectId: body.id,
          kind: "created",
          name: body.name,
          sortOrder: "a3",
          createdAt: at,
        },
        {
          id: "30000000-0000-4000-8000-000000000096",
          seqId: 3,
          projectId: body.id,
          kind: "renamed",
          name: "Notes confirmed",
          sortOrder: "a3",
          createdAt: at,
        },
      ]);
      return respond(201, {
        id: body.id,
        name: body.name,
        sortOrder: "a3",
        createdAt: at,
        updatedAt: at,
      });
    });
  });
  click(button("Create Project"));
  await fill(
    await screen.findByRole("textbox", { name: "Project name" }),
    "Notes",
  );
  click(button("Save"));
  await expectProjects([...initialNames, "Notes"]);
  expect(toggle("Notes")).toHaveAttribute("aria-expanded", "true");
  response.resolve();
  await expectProjects([...initialNames, "Notes confirmed"]);
});

test("Filtered lists keep canonical Project order and hide reorder actions", async () => {
  await prepare();
  click(button("Open chat list menu"));
  await screen.findByRole("menu");
  click(menuItemByText("Unread"));
  await expectProjects(["Research"]);
  click(button("Options for Research"));
  const menu = await screen.findByRole("menu");
  expect(
    queryAllByRoleFast("menuitem", menu).map((item) => {
      return item.textContent?.trim();
    }),
  ).toContain("Rename");
  expect(
    queryAllByRoleFast("menuitem", menu).some((item) => {
      return item.getAttribute("aria-label") === "Move up";
    }),
  ).toBeFalsy();
  await userEvent.setup().keyboard("{Escape}");
  toggle("Research").focus();
  expect(dispatchMove(toggle("Research")).defaultPrevented).toBeFalsy();
  // Changing back reveals the same canonical order for hidden Projects.
  click(button("Open chat list menu"));
  await screen.findByRole("menu");
  click(menuItemByText("Inbox"));
  await expectProjects(initialNames);
  click(button("Options for Research"));
  await screen.findByRole("menu");
  expect(menuItemByText("Move up")).toHaveAttribute(
    "aria-keyshortcuts",
    "Alt+Shift+ArrowUp",
  );
});
