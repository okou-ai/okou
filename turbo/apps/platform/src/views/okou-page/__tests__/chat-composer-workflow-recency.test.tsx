import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import {
  screen,
  waitFor,
  act,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  setupPage,
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  createTestRuntime,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  createChatRunFixtures,
  completedEvent,
  promptEvent,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
import {
  workflowOptions,
  slashChoice,
  slashRows,
} from "./workflow-composer-boundary.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  composerWorkflow,
  createChatComposerHelpers,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

function defaultNames() {
  return ["alpha", "beta", "charlie", "delta", "echo", "zulu"];
}
const key = "okou_recent-workflows:org_default:test-user-123";
// A browser-owned storage area shared by the app and the simulated second tab.

function installBrowserStorage() {
  const storage = new Storage();
  vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
  return storage;
}

function order() {
  return slashRows().map((row) => {
    return row.textContent?.slice(1);
  });
}

function message() {
  return screen.findByLabelText("Message");
}

async function reveal() {
  click(await screen.findByText(/Show 2 more/));
}

test("chat-composer-recent-workflows-002 an abandoned Echo selection keeps the four default recommendations", async () => {
  const existing = "b0000000-0000-4000-a000-000000000920";
  const path = "/chats/" + existing;
  createChatRunFixtures(context).installRunChat({ threadId: existing });
  workflowOptions(context, defaultNames());
  await setupPage({ context, path });
  const editor = await message();
  await fill(editor, "/");
  await slashChoice("alpha");
  await reveal();
  click(await slashChoice("echo"));
  expect(editor).toHaveTextContent("/echo");
  await fill(editor, "Next /");
  await slashChoice("alpha");
  expect(order()).toStrictEqual(defaultNames().slice(0, 4));
  expect(location.pathname).toBe(path);
});

test("chat-composer-recent-workflows-008 a pending send cannot reorder an open or expanded overview", async () => {
  const storage = installBrowserStorage();
  const gate = context.mocks.deferred<void>();
  createChatRunFixtures(context).installRunChat({ sendGate: gate.promise });
  const choices = workflowOptions(context, defaultNames());
  await setupPage({ context, path: RUN_PATH });
  const editor = await message();
  await fill(editor, "/zulu");
  click(await slashChoice("zulu"));
  click(await findAction("button", "Send"));
  try {
    await waitFor(() => {
      return expect(editor.textContent?.trim()).toBe("");
    });
    await fill(editor, "/");
    await slashChoice("alpha");
    expect(order()).toStrictEqual(defaultNames().slice(0, 4));
    gate.resolve();
    await waitFor(() => {
      return expect(storage.getItem(key)).toContain(choices[5].id);
    });
    expect(order()).toStrictEqual(defaultNames().slice(0, 4));
    await reveal();
    expect(order()).toStrictEqual(defaultNames());
    await fill(editor, "");
    await fill(editor, "/");
    await slashChoice("zulu");
    expect(order()).toStrictEqual(["zulu", "alpha", "beta", "charlie"]);
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});

test("chat-composer-recent-workflows-009 a send preserves synced history from a second tab", async () => {
  const storage = installBrowserStorage();
  createChatRunFixtures(context).installRunChat();
  const entries = workflowOptions(context, defaultNames());
  const ids = entries.map((w) => {
    return w.id;
  });
  let history: string[] = [ids[5]];
  context.mocks.api(workflowsCollectionContract.recent, ({ respond }) => {
    return respond(200, { workflowIds: history });
  });
  context.mocks.api(
    workflowsCollectionContract.recordRecentUse,
    ({ body, respond }) => {
      history = [...new Set([...body.workflowIds, ...history])];
      return respond(200, { workflowIds: history });
    },
  );
  storage.setItem(key, JSON.stringify(history));
  await setupPage({ context, path: RUN_PATH });
  const editor = await message();
  await fill(editor, "/");
  await slashChoice("zulu");
  expect(order()[0]).toBe("zulu");
  history = [ids[4], ids[5]];
  storage.setItem(key, JSON.stringify(history));
  await fill(editor, "/delta");
  click(await slashChoice("delta"));
  click(await findAction("button", "Send"));
  await waitFor(() => {
    return expect(storage.getItem(key)).toContain(ids[3]);
  });
  await fill(editor, "/");
  await slashChoice("delta");
  expect(order()).toStrictEqual(["delta", "echo", "zulu", "alpha"]);
});

test("chat-composer-recent-workflows-012 prefix, recency and fuzzy matches rank independently before keyboard selection", async () => {
  const storage = installBrowserStorage();
  createChatRunFixtures(context).installRunChat();
  const names = [
    "report",
    "team-pr-auto",
    "pr-auto",
    "pr-auto-deploy",
    "pr-audit",
    "presentation-restart-auto",
  ];
  const entries = workflowOptions(context, names, {
    report: "Publish a pr-auto summary",
  });
  storage.setItem(
    key,
    JSON.stringify(
      entries.slice(0, 4).map((e) => {
        return e.id;
      }),
    ),
  );
  await setupPage({ context, path: RUN_PATH });
  const editor = await message();
  await fill(editor, "/Pr-A");
  await slashChoice("pr-auto");
  expect(order()).toStrictEqual([
    "pr-auto",
    "pr-auto-deploy",
    "pr-audit",
    "team-pr-auto",
    "report",
    "presentation-restart-auto",
  ]);
  await fill(editor, "/pr-auto-deploy");
  await waitFor(() => {
    return expect(order()).toStrictEqual(["pr-auto-deploy"]);
  });
  await userEvent.keyboard("{Enter}");
  expect(editor).toHaveTextContent("/pr-auto-deploy");
  expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
});

test("chat-composer-recent-workflows-013 recent Beta outranks repeated Delta on desktop and mobile", async () => {
  const storage = installBrowserStorage();
  const desktopQuery = "(min-width: 48rem)";
  const media = context.mocks.browser.matchMedia((query) => {
    return query === desktopQuery;
  });
  const entries = workflowOptions(
    context,
    defaultNames().map((n) => {
      return "qz-" + n;
    }),
  );
  createChatRunFixtures(context).installRunChat();
  await setupPage({ context, path: RUN_PATH });
  const editor = await message();
  for (const [index, name] of ["qz-delta", "qz-delta", "qz-beta"].entries()) {
    await fill(editor, "/" + name);
    click(await slashChoice(name));
    await userEvent.setup({ delay: null }).paste(" note " + index);
    click(await findAction("button", "Send"));
    await waitFor(() => {
      return expect(editor.textContent?.trim()).toBe("");
    });
    await screen.findByText(new RegExp("note " + index));
    await waitFor(() => {
      return expect(JSON.parse(storage.getItem(key) ?? "[]")[0]).toBe(
        entries.find((w) => {
          return w.name === name;
        })?.id,
      );
    });
  }
  for (const desktop of [true, false]) {
    media.setMatches((query) => {
      return desktop && query === desktopQuery;
    });
    await fill(editor, "/qz");
    const beta = await slashChoice("qz-beta");
    expect(order()[0]).toBe("qz-beta");
    expect(beta).toHaveAttribute("data-active", "true");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(editor).toHaveTextContent("/qz-delta");
    expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
  }
});

test("chat-composer-recent-workflows-015 keyboard selection survives completion of a pending Delta send", async () => {
  const storage = installBrowserStorage();
  const gate = context.mocks.deferred<void>();
  const names = defaultNames().map((n) => {
    return "qz-" + n;
  });
  const entries = workflowOptions(context, names);
  const past = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    chatEvents: [
      promptEvent({
        id: crypto.randomUUID(),
        runId: past,
        seqId: 1,
        text: "/qz-delta",
      }),
      completedEvent({ id: crypto.randomUUID(), runId: past, seqId: 2 }),
    ],
    sendGate: gate.promise,
  });
  await setupPage({ context, path: RUN_PATH });
  await screen.findByText("/qz-delta");
  const editor = await message();
  await fill(editor, "/qz-delta");
  click(await slashChoice("qz-delta"));
  click(await findAction("button", "Send"));
  try {
    await waitFor(() => {
      return expect(editor.textContent?.trim()).toBe("");
    });
    await fill(editor, "/qz");
    await slashChoice("qz-alpha");
    expect(order()).toStrictEqual(names);
    await userEvent.keyboard("{ArrowDown}");
    const beta = await slashChoice("qz-beta");
    expect(beta).toHaveAttribute("data-active", "true");
    gate.resolve();
    await waitFor(() => {
      return expect(storage.getItem(key)).toContain(entries[3].id);
    });
    expect(order()).toStrictEqual(names);
    expect(beta).toHaveAttribute("data-active", "true");
    await userEvent.keyboard("{Enter}");
    expect(editor).toHaveTextContent("/qz-beta");
    expect(screen.queryByTestId("slash-workflow-menu")).not.toBeInTheDocument();
    await fill(editor, "/qz");
    await slashChoice("qz-delta");
    expect(order()[0]).toBe("qz-delta");
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});

const firstPage = createTestRuntime(context);
const nextPage = createTestRuntime(context);
const { mockBillingCapabilities, mockPersonalModelRoutes } =
  createChatComposerHelpers(context);
const THREAD_ID = "b0000000-0000-4000-a000-000000000921";
const alphabet = Object.freeze([
  "alpha",
  "beta",
  "charlie",
  "delta",
  "echo",
  "zulu",
]);

function installWorkflows() {
  mockPersonalModelRoutes();
  mockBillingCapabilities({ restrictedBuiltInModels: false });
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
  });
  const workflows = alphabet.map((name) => {
    return composerWorkflow(`qz-${name}`, "Usage test workflow");
  });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, workflows);
  });
  mockChatLifecycle(context, { threadId: THREAD_ID });
  return (name: string) => {
    const workflow = workflows.find((workflow) => {
      return workflow.name === `qz-${name}`;
    });
    if (!workflow) {
      throw new Error(`Missing workflow ${name}`);
    }
    return workflow.id;
  };
}

function mockCache(entries: Record<string, readonly string[]>) {
  const values = new Map(
    Object.entries(entries).map(([key, ids]) => {
      return [key, JSON.stringify(ids)];
    }),
  );
  vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
    return values.get(key) ?? null;
  });
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    values.set(key, value);
  });
  vi.spyOn(localStorage, "removeItem").mockImplementation((key) => {
    values.delete(key);
  });
}

function mockRemote(initial: string[] | null) {
  let workflowIds = initial;
  context.mocks.api(workflowsCollectionContract.recent, ({ respond }) => {
    return respond(200, { workflowIds });
  });
  context.mocks.api(
    workflowsCollectionContract.importRecent,
    ({ body, respond }) => {
      workflowIds ??= body.workflowIds;
      return respond(200, { workflowIds });
    },
  );
  context.mocks.api(
    workflowsCollectionContract.recordRecentUse,
    ({ body, respond }) => {
      workflowIds = [...new Set([...body.workflowIds, ...(workflowIds ?? [])])];
      return respond(200, { workflowIds });
    },
  );
  return {
    replace(ids: string[] | null) {
      workflowIds = ids;
    },
  };
}

function button(name: string): HTMLElement {
  const found = queryAllByRoleFast("button").find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!found) {
    throw new Error(`Expected button ${name}`);
  }
  return found;
}

function workflowNames(): string[] {
  return Array.from(
    screen
      .getByTestId("slash-workflow-menu")
      .querySelectorAll('[data-slot="slash-workflow-name"]'),
    (element) => {
      return element.textContent ?? "";
    },
  );
}

function ordered(...first: string[]): string[] {
  return [...new Set([...first, ...alphabet])].map((name) => {
    return `/qz-${name}`;
  });
}

async function openMenu(editor: HTMLElement) {
  await fill(editor, "Draft /qz");
  await waitFor(() => {
    expect(workflowNames()).toHaveLength(alphabet.length);
  });
}

async function openPage(page: TestContext = context) {
  await setupPage({
    context: page,
    path: `/chats/${THREAD_ID}`,
  });
  return await findComposerEditor();
}

function disposeFirstPage() {
  firstPage.dispose();
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

async function sendWorkflow(editor: HTMLElement, name: string) {
  await fill(editor, `/qz-${name}`);
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(editor.textContent).toBe("");
  });
  await fill(editor, "Next draft");
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
}

test("A failed sync reads only the current workspace's saved history", async () => {
  const id = installWorkflows();
  mockCache({
    "okou_recent-workflows:org_default:test-user-123": [id("echo")],
    "okou_recent-workflows:another-workspace:test-user-123": [id("zulu")],
  });
  context.mocks.api(workflowsCollectionContract.recent, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Recency unavailable" },
    });
  });
  const editor = await openPage();
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
  act(() => {
    context.mocks.clerk().organization({
      activeOrg: { id: "another-workspace", name: "Another Workspace" },
      memberships: [{ id: "another-workspace" }],
    });
    context.mocks.clerk().stateChanged();
  });
  await fill(editor, "Next draft");
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("zulu"));
});

test("The first accepted use stays ahead of its initial baseline when persistence fails", async () => {
  const id = installWorkflows();
  mockCache({});
  const reading = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  const writing = context.mocks.deferred<void>();
  context.mocks.api(workflowsCollectionContract.recent, async ({ respond }) => {
    reading.resolve();
    await response.promise;
    return respond(200, { workflowIds: [id("echo")] });
  });
  context.mocks.api(
    workflowsCollectionContract.recordRecentUse,
    ({ respond }) => {
      writing.resolve();
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Recency unavailable",
        },
      });
    },
  );
  const editor = await openPage();
  await sendWorkflow(editor, "zulu");
  await reading.promise;
  response.resolve();
  // Starting persistence means the initial response has already been applied.
  await writing.promise;
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("zulu"));
});

test.each([
  { remote: ["zulu", "echo"], expected: ["zulu", "echo"] },
  { remote: [], expected: [] },
])(
  "An initialized remote $remote overrides the browser history on refresh",
  async ({ remote, expected }) => {
    const id = installWorkflows();
    mockCache({
      "okou_recent-workflows": [id("delta")],
      "okou_recent-workflows:org_default:test-user-123": [id("beta")],
    });
    const server = mockRemote(remote.map(id));
    let editor = await openPage(firstPage);
    await openMenu(editor);
    expect(workflowNames()).toStrictEqual(ordered(...expected));
    disposeFirstPage();

    server.replace([id("charlie"), id("zulu")]);
    editor = await openPage(nextPage);
    await openMenu(editor);
    expect(workflowNames()).toStrictEqual(ordered("charlie", "zulu"));
  },
);

test("A null history imports normalized legacy IDs and displays the canonical import result", async () => {
  const id = installWorkflows();
  mockCache({
    "okou_recent-workflows": [
      ` ${id("zulu").toUpperCase()} `,
      id("zulu"),
      "deleted-workflow",
      id("echo"),
    ],
  });
  context.mocks.api(workflowsCollectionContract.recent, ({ respond }) => {
    return respond(200, { workflowIds: null });
  });
  const imports: string[][] = [];
  context.mocks.api(
    workflowsCollectionContract.importRecent,
    ({ body, respond }) => {
      imports.push(body.workflowIds);
      // A competing device initialized after the read; the atomic import returns
      // that device's canonical value, not the proposed browser order.
      return respond(200, { workflowIds: [id("echo")] });
    },
  );
  const editor = await openPage();
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
  expect(imports).toStrictEqual([[id("zulu"), id("echo")]]);
});

test("A fresh empty browser leaves null available for a later legacy import", async () => {
  const id = installWorkflows();
  mockCache({});
  mockRemote(null);
  const editor = await openPage(firstPage);
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered());
  disposeFirstPage();

  // Model opening an older browser that still has valuable pre-sync history.
  mockCache({ "okou_recent-workflows": [id("zulu")] });
  const legacyEditor = await openPage(nextPage);
  await openMenu(legacyEditor);
  expect(workflowNames()).toStrictEqual(ordered("zulu"));
});

test("A failed read retains local history and does not authorize a legacy import", async () => {
  const id = installWorkflows();
  mockCache({ "okou_recent-workflows": [id("zulu")] });
  mockRemote(null);
  context.mocks.api(workflowsCollectionContract.recent, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Recency unavailable" },
    });
  });
  const editor = await openPage(firstPage);
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("zulu"));
  disposeFirstPage();

  // A failed read on a fresh page must still preserve the browser history.
  const localEditor = await openPage(nextPage);
  await openMenu(localEditor);
  expect(workflowNames()).toStrictEqual(ordered("zulu"));
});

test("Accepted sending completes while initialization waits, and the new use wins the initial-read race", async () => {
  const id = installWorkflows();
  mockCache({ "okou_recent-workflows": [id("echo")] });
  const reading = context.mocks.deferred<void>();
  const readGate = context.mocks.deferred<void>();
  const writing = context.mocks.deferred<void>();
  context.mocks.api(workflowsCollectionContract.recent, async ({ respond }) => {
    reading.resolve();
    await readGate.promise;
    return respond(200, { workflowIds: [id("zulu")] });
  });
  context.mocks.api(
    workflowsCollectionContract.recordRecentUse,
    ({ body, respond }) => {
      writing.resolve();
      return respond(200, { workflowIds: [...body.workflowIds, id("zulu")] });
    },
  );
  const editor = await openPage();
  await fill(editor, "Draft");
  await reading.promise;
  await sendWorkflow(editor, "delta");
  // The accepted send and next draft are usable before optional HTTP settles.
  expect(editor.textContent).toBe("Next draft");
  readGate.resolve();
  await writing.promise;
  await openMenu(editor);
  expect(workflowNames()[0]).toBe("/qz-delta");
});

test("A failed recency write keeps the accepted send and its local promotion", async () => {
  const id = installWorkflows();
  mockRemote([id("echo")]);
  const failure = context.mocks.deferred<void>();
  context.mocks.api(
    workflowsCollectionContract.recordRecentUse,
    ({ respond }) => {
      failure.resolve();
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Recency unavailable",
        },
      });
    },
  );
  const editor = await openPage();
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
  await sendWorkflow(editor, "delta");
  await failure.promise;
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("delta", "echo"));
  expect(button("Send")).toBeEnabled();
});

test("Earlier use responses cannot erase a newer local use or reorder an open query during IME", async () => {
  const id = installWorkflows();
  mockRemote([id("echo")]);
  const firstWrite = context.mocks.deferred<void>();
  const firstResponse = context.mocks.deferred<void>();
  const secondWrite = context.mocks.deferred<void>();
  const secondResponse = context.mocks.deferred<void>();
  context.mocks.api(
    workflowsCollectionContract.recordRecentUse,
    async ({ body, respond }) => {
      if (body.workflowIds.includes(id("delta"))) {
        firstWrite.resolve();
        await firstResponse.promise;
        return respond(200, { workflowIds: [id("delta"), id("echo")] });
      }
      secondWrite.resolve();
      await secondResponse.promise;
      return respond(200, {
        workflowIds: [id("zulu"), id("delta"), id("echo")],
      });
    },
  );
  const editor = await openPage();
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
  await sendWorkflow(editor, "delta");
  await firstWrite.promise;
  await sendWorkflow(editor, "zulu");
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("zulu", "delta", "echo"));
  const user = userEvent.setup();
  await user.keyboard("{ArrowDown}");
  fireEvent.compositionStart(editor);
  firstResponse.resolve();
  await secondWrite.promise;
  expect(workflowNames()).toStrictEqual(ordered("zulu", "delta", "echo"));
  expect(
    fireEvent.keyDown(editor, {
      key: "Enter",
      keyCode: 229,
      isComposing: true,
    }),
  ).toBeTruthy();
  expect(editor.textContent).toBe("Draft /qz");
  secondResponse.resolve();
  fireEvent.compositionEnd(editor, { data: "qz" });
  expect(
    fireEvent.keyDown(editor, { key: "Enter", keyCode: 229 }),
  ).toBeTruthy();
  expect(editor.textContent).toBe("Draft /qz");
});

test("A workspace switch during token acquisition cannot send the old workflow use", async () => {
  installWorkflows();
  const reading = context.mocks.deferred<void>();
  const readResponse = context.mocks.deferred<void>();
  context.mocks.api(workflowsCollectionContract.recent, async ({ respond }) => {
    reading.resolve();
    await readResponse.promise;
    return respond(200, { workflowIds: [] });
  });
  const uses: string[][] = [];
  context.mocks.api(
    workflowsCollectionContract.recordRecentUse,
    ({ body, respond }) => {
      uses.push(body.workflowIds);
      return respond(200, { workflowIds: body.workflowIds });
    },
  );
  const editor = await openPage();
  await fill(editor, "Draft");
  await reading.promise;
  await sendWorkflow(editor, "delta");
  const tokenRequested = context.mocks.deferred<void>();
  const token = context.mocks.deferred<string>();
  mockedClerk.sessionGetToken.mockImplementationOnce(() => {
    tokenRequested.resolve();
    return token.promise;
  });
  readResponse.resolve();
  await tokenRequested.promise;
  act(() => {
    context.mocks.clerk().organization({
      activeOrg: { id: "another-workspace", name: "Another Workspace" },
      memberships: [{ id: "another-workspace" }],
    });
    context.mocks.clerk().stateChanged();
  });
  await act(async () => {
    token.resolve("old-workspace-token");
    await token.promise;
  });
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered());
  expect(uses).toStrictEqual([]);
  // The accepted send remains a usable draft surface after optional cancellation.
  expect(button("Send")).toBeEnabled();
});

test("A late read from a disposed session cannot overwrite the current session's cache", async () => {
  const id = installWorkflows();
  const reading = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(workflowsCollectionContract.recent, async ({ respond }) => {
    reading.resolve();
    await response.promise;
    return respond(200, { workflowIds: [id("zulu")] });
  });
  await fill(await openPage(firstPage), "Draft");
  await reading.promise;
  disposeFirstPage();
  mockRemote([id("echo")]);
  await setupPage({
    context: nextPage,
    path: `/chats/${THREAD_ID}`,
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      session: { token: "another-session-token", id: "another-session" },
    },
  });
  const editor = await findComposerEditor();
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
  response.resolve();
  await userEvent.setup().keyboard("{Escape}");
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
});
