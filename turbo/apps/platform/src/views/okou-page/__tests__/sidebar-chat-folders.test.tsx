import { queryAllByRoleFast, fill } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  chatFoldersContract,
  type ChatFolderCatalog,
} from "@okouai/api-contracts/contracts/chat-folders";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { currentChatThreadNavigationList$ } from "../../../signals/chat-page/chat-thread-navigation.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  createSidebarHelpers,
  createThread,
  createDataTransferStub,
  threadRowByTitle,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  menuItemByText,
  openThreadMenu,
  setupSidebarPage,
  sidebar,
} from "./sidebar-test-helpers.tsx";

const context = testContext();
const helpers = createSidebarHelpers(context);
const FOLDER_ID = "f0000000-0000-4000-a000-000000000001";
function staffAuth() {
  return {
    user: {
      id: "user_folder_test",
      fullName: "Folder tester",
      email: "tester@okou.ai",
    },
    organization: {
      activeOrg: { id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe", name: "Okou" },
      memberships: [{ id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe" }],
    },
  };
}

function queryButton(name: string, container: ParentNode = sidebar()) {
  return (
    queryAllByRoleFast("button", container).find((element) => {
      return (
        element.getAttribute("aria-label") === name ||
        element.textContent?.trim() === name
      );
    }) ?? null
  );
}
function button(name: string, container: ParentNode = sidebar()): HTMLElement {
  const element = queryButton(name, container);
  if (!element) {
    throw new Error(`Missing button: ${name}`);
  }
  return element;
}
async function findButton(name: string, container: ParentNode = sidebar()) {
  await waitFor(() => {
    return expect(queryButton(name, container)).toBeInTheDocument();
  });
  return button(name, container);
}
function mockFolders(
  initial: ChatFolderCatalog = { folders: [], memberships: [] },
  createGate?: Promise<void>,
) {
  let catalog = structuredClone(initial);
  context.mocks.api(chatFoldersContract.list, ({ respond }) => {
    return respond(200, catalog);
  });
  context.mocks.api(chatFoldersContract.create, async ({ body, respond }) => {
    if (createGate) {
      await createGate;
    }
    const folder = {
      id: body.id,
      name: body.name,
      sortKey: `a${catalog.folders.length}`,
    };
    catalog = { ...catalog, folders: [...catalog.folders, folder] };
    return respond(201, folder);
  });
  context.mocks.api(chatFoldersContract.rename, ({ params, body, respond }) => {
    catalog = {
      ...catalog,
      folders: catalog.folders.map((folder) => {
        return folder.id === params.id
          ? { ...folder, name: body.name }
          : folder;
      }),
    };
    return respond(204);
  });
  context.mocks.api(chatFoldersContract.delete, ({ params, respond }) => {
    catalog = {
      folders: catalog.folders.filter((folder) => {
        return folder.id !== params.id;
      }),
      memberships: catalog.memberships.filter((row) => {
        return row.folderId !== params.id;
      }),
    };
    return respond(204);
  });
  context.mocks.api(
    chatFoldersContract.moveThread,
    ({ params, body, respond }) => {
      catalog = {
        ...catalog,
        memberships: [
          ...catalog.memberships.filter((row) => {
            return row.chatThreadId !== params.id;
          }),
          ...(body.folderId === null
            ? []
            : [{ chatThreadId: params.id, folderId: body.folderId }]),
        ],
      };
      return respond(204);
    },
  );
  context.mocks.api(
    chatFoldersContract.reorder,
    ({ params, body, respond }) => {
      const moved = catalog.folders.find((folder) => {
        return folder.id === params.id;
      });
      const remaining = catalog.folders.filter((folder) => {
        return folder.id !== params.id;
      });
      if (moved) {
        const index =
          body.afterId === null
            ? remaining.length
            : remaining.findIndex((folder) => {
                return folder.id === body.afterId;
              });
        remaining.splice(index, 0, moved);
        catalog = {
          ...catalog,
          folders: remaining.map((folder, i) => {
            return {
              ...folder,
              sortKey: `a${i}`,
            };
          }),
        };
      }
      return respond(204);
    },
  );
}
async function prepare(initial?: ChatFolderCatalog, enabled = true) {
  helpers.prepareDefaultAgent();
  helpers.mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Launch plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);
  mockFolders(initial);
  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: staffAuth(),
    featureSwitches: { [FeatureSwitchKey.ChatThreadFolders]: enabled },
  });
  await within(sidebar()).findByText("Launch plan");
}
async function createFolder(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(button("Create a folder"));
  const dialog = await screen.findByRole("dialog");
  await user.type(
    within(dialog).getByRole("textbox", { name: "Folder name" }),
    name,
  );
  await user.click(button("Save", dialog));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await findButton(name);
}

test("zero folders, filing, collapse and deleting the last folder retain every conversation", async () => {
  const user = userEvent.setup();
  await prepare();
  expect(within(sidebar()).getByText("Chats")).toBeInTheDocument();
  await createFolder(user, "Product");
  expect(within(sidebar()).getByText("Unfiled")).toBeInTheDocument();
  openThreadMenu("Launch plan");
  await screen.findByRole("menu");
  await user.click(menuItemByText("Move to…"));
  const chooser = await screen.findByRole("dialog");
  await user.click(button("Product", chooser));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(within(sidebar()).getAllByText("Launch plan")).toHaveLength(1);
  await user.click(button("Product", sidebar()));
  await waitFor(() => {
    return expect(
      within(sidebar()).queryByText("Launch plan"),
    ).not.toBeInTheDocument();
  });
  expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  await expect(
    context.store.get(currentChatThreadNavigationList$),
  ).resolves.toStrictEqual({
    orderedThreadIds: [EXISTING_THREAD_ID, INCIDENT_THREAD_ID],
    listedThreadIds: [INCIDENT_THREAD_ID],
  });
  await user.click(button("Product", sidebar()));
  await within(sidebar()).findByText("Launch plan");
  await user.click(button("Actions for Product", sidebar()));
  await screen.findByRole("menu");
  await user.click(menuItemByText("Delete folder"));
  const confirmation = await screen.findByRole("dialog");
  expect(
    within(confirmation).getByText(/Your conversations will be kept/),
  ).toBeInTheDocument();
  await user.click(button("Delete folder", confirmation));
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(within(sidebar()).getByText("Chats")).toBeInTheDocument();
  expect(within(sidebar()).getByText("Launch plan")).toBeInTheDocument();
  expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
});

test("folder names and keyboard-accessible order changes update the grouped navigation", async () => {
  const user = userEvent.setup();
  await prepare({
    folders: [{ id: FOLDER_ID, name: "Product", sortKey: "a0" }],
    memberships: [],
  });
  await createFolder(user, "Customers");
  await user.click(button("Actions for Customers", sidebar()));
  await screen.findByRole("menu");
  await user.click(menuItemByText("Move folder up"));
  await waitFor(() => {
    const buttons = queryAllByRoleFast("button", sidebar()).filter((button) => {
      return ["Product", "Customers"].includes(
        button.textContent?.trim() ?? "",
      );
    });
    expect(
      buttons.map((button) => {
        return button.textContent?.trim();
      }),
    ).toStrictEqual(["Customers", "Product"]);
  });
  await user.click(button("Actions for Customers", sidebar()));
  await screen.findByRole("menu");
  await user.click(menuItemByText("Rename folder"));
  const dialog = await screen.findByRole("dialog");
  const name = within(dialog).getByRole("textbox", { name: "Folder name" });
  await fill(name, "Customer work");
  await user.click(button("Save", dialog));
  await findButton("Customer work", sidebar());
});

test("switch-off keeps the complete flat list even when server membership exists", async () => {
  await prepare(
    {
      folders: [{ id: FOLDER_ID, name: "Hidden folder", sortKey: "a0" }],
      memberships: [{ chatThreadId: EXISTING_THREAD_ID, folderId: FOLDER_ID }],
    },
    false,
  );
  expect(within(sidebar()).getByText("Launch plan")).toBeInTheDocument();
  expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  expect(queryButton("Create a folder", sidebar())).not.toBeInTheDocument();
});

test("dragging a thread files it and dragging it back to Unfiled preserves a single visible copy", async () => {
  const user = userEvent.setup();
  await prepare({
    folders: [{ id: FOLDER_ID, name: "Product", sortKey: "a0" }],
    memberships: [],
  });
  const dataTransfer = {
    ...createDataTransferStub(),
    types: ["application/x-okou-chat-thread-folder"],
  };
  const target = button("Product").parentElement!;
  fireEvent.dragStart(threadRowByTitle("Launch plan"), { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
  await waitFor(() => {
    return expect(
      within(sidebar()).queryByText("No chats yet"),
    ).not.toBeInTheDocument();
  });
  await user.click(button("Product", sidebar()));
  await waitFor(() => {
    return expect(
      within(sidebar()).queryByText("Launch plan"),
    ).not.toBeInTheDocument();
  });
  await user.click(button("Product", sidebar()));
  await within(sidebar()).findByText("Launch plan");
  fireEvent.dragStart(threadRowByTitle("Launch plan"), { dataTransfer });
  fireEvent.drop(within(sidebar()).getByText("Unfiled"), { dataTransfer });
  await within(sidebar()).findByText("No chats yet");
  await user.click(button("Product", sidebar()));
  expect(within(sidebar()).getAllByText("Launch plan")).toHaveLength(1);
});

test("search labels and reveals a conversation inside a collapsed folder", async () => {
  const user = userEvent.setup();
  await prepare({
    folders: [{ id: FOLDER_ID, name: "Product", sortKey: "a0" }],
    memberships: [{ chatThreadId: EXISTING_THREAD_ID, folderId: FOLDER_ID }],
  });
  await user.click(button("Product", sidebar()));
  await waitFor(() => {
    return expect(
      within(sidebar()).queryByText("Launch plan"),
    ).not.toBeInTheDocument();
  });
  await user.click(
    await screen.findByLabelText("Search workspace", { selector: "button" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Search workspace...",
  });
  await within(dialog).findByText("Product");
  await user.click(within(dialog).getByText("Launch plan"));
  await waitFor(() => {
    return expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
  });
  await within(sidebar()).findByText("Launch plan");
  expect(button("Product", sidebar())).toHaveAttribute("aria-expanded", "true");
});

test("an older API with no folder switch keeps staff on the complete flat list", async () => {
  helpers.prepareDefaultAgent();
  helpers.mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Launch plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);
  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: staffAuth(),
    featureSwitches: {},
  });
  await within(sidebar()).findByText("Launch plan");
  expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  expect(queryButton("Create a folder", sidebar())).not.toBeInTheDocument();
});

test("mobile Web uses the same folders without losing virtualized touch rows", async () => {
  const user = userEvent.setup();
  context.mocks.browser.matchMedia(() => {
    return false;
  });
  helpers.prepareDefaultAgent();
  helpers.mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Launch plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);
  mockFolders({
    folders: [{ id: FOLDER_ID, name: "Product", sortKey: "a0" }],
    memberships: [{ chatThreadId: EXISTING_THREAD_ID, folderId: FOLDER_ID }],
  });
  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: staffAuth(),
    featureSwitches: {
      [FeatureSwitchKey.ChatThreadFolders]: true,
      [FeatureSwitchKey.PwaNavigation]: true,
    },
  });
  const list = await screen.findByLabelText("Chat threads");
  await within(list).findByText("Launch plan");
  await user.click(button("Product", list));
  await waitFor(() => {
    return expect(
      within(list).queryByText("Launch plan"),
    ).not.toBeInTheDocument();
  });
  expect(within(list).getByText("Incident notes")).toBeInTheDocument();
  await user.click(button("Product", list));
  await within(list).findByText("Launch plan");
  await user.click(button("Create a folder", document.body));
  const dialog = await screen.findByRole("dialog");
  await fill(
    within(dialog).getByRole("textbox", { name: "Folder name" }),
    "Mobile work",
  );
  await user.click(button("Save", dialog));
  await findButton("Mobile work", document.body);
});

test("a failed catalog read can be refreshed without hiding the failure or replaying a mutation", async () => {
  const user = userEvent.setup();
  helpers.prepareDefaultAgent();
  helpers.mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Launch plan"),
  ]);
  context.mocks.api(chatFoldersContract.list, ({ respond }) => {
    return respond(403, {
      error: {
        code: "FORBIDDEN",
        message: "Folders are temporarily unavailable",
      },
    });
  });
  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: staffAuth(),
    featureSwitches: { [FeatureSwitchKey.ChatThreadFolders]: true },
  });
  await within(sidebar()).findByRole("alert");
  context.mocks.api(chatFoldersContract.list, ({ respond }) => {
    return respond(200, { folders: [], memberships: [] });
  });
  await user.click(button("Refresh folders"));
  await within(sidebar()).findByText("Launch plan");
  expect(within(sidebar()).getByText("Chats")).toBeInTheDocument();
});

test("a completed save does not dismiss a newer folder dialog", async () => {
  const user = userEvent.setup();
  const gate = context.mocks.deferred<void>();
  helpers.prepareDefaultAgent();
  helpers.mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Launch plan"),
  ]);
  mockFolders(undefined, gate.promise);
  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    auth: staffAuth(),
    featureSwitches: { [FeatureSwitchKey.ChatThreadFolders]: true },
  });
  await within(sidebar()).findByText("Launch plan");
  await user.click(button("Create a folder"));
  const firstDialog = await screen.findByRole("dialog");
  await fill(
    within(firstDialog).getByRole("textbox", { name: "Folder name" }),
    "First folder",
  );
  await user.click(button("Save", firstDialog));
  await waitFor(() => {
    return expect(button("Save", firstDialog)).toBeDisabled();
  });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  await user.click(button("Create a folder"));
  const nextDialog = await screen.findByRole("dialog");
  await fill(
    within(nextDialog).getByRole("textbox", { name: "Folder name" }),
    "Second folder",
  );
  gate.resolve();
  await within(sidebar()).findByText("First folder");
  expect(
    within(screen.getByRole("dialog")).getByRole("textbox", {
      name: "Folder name",
    }),
  ).toHaveValue("Second folder");
});
