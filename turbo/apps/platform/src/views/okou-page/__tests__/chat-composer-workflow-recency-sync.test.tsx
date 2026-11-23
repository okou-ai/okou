import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  composerWorkflow,
  createChatComposerHelpers,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const firstPage = createTestRuntime(context);
const nextPage = createTestRuntime(context);
const { mockBillingCapabilities, mockPersonalModelRoutes } =
  createChatComposerHelpers(context);
const THREAD_ID = "b0000000-0000-4000-a000-000000000921";
const features = Object.freeze({
  [FeatureSwitchKey.WorkflowRecencySync]: true,
});
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

async function openPage(
  page: TestContext = context,
  enabled = true,
  labEnabled = false,
) {
  await setupPage({
    context: page,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.WorkflowRecencySync]: enabled,
      [FeatureSwitchKey.Lab]: labEnabled,
    },
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

async function setSyncInLab(enabled: boolean) {
  let switches: Record<string, boolean> = {
    [FeatureSwitchKey.Lab]: true,
    [FeatureSwitchKey.WorkflowRecencySync]: !enabled,
  };
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches, effectiveSwitches: switches });
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    switches = { ...switches, ...body.switches };
    return respond(200, { switches, effectiveSwitches: switches });
  });
  const user = userEvent.setup({ delay: null });
  await user.click(button("Test User"));
  const lab = queryAllByRoleFast("menuitem").find((item) => {
    return item.textContent?.trim() === "Lab";
  });
  if (!lab) {
    throw new Error("Lab menu item not found");
  }
  await user.click(lab);
  await screen.findByRole("heading", { name: "Lab" });
  const row = screen.getByText("Workflow recency sync").closest("li");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Workflow recency switch row not found");
  }
  const control = within(row).getByRole("switch");
  expect(control).toHaveAttribute("aria-checked", String(!enabled));
  await user.click(control);
  await waitFor(() => {
    expect(control).toHaveAttribute("aria-checked", String(enabled));
  });
  act(() => {
    window.history.back();
  });
  return await findComposerEditor();
}

test("Disabling sync after initialization keeps the same history and local-only uses", async () => {
  const id = installWorkflows();
  mockCache({ "okou_recent-workflows": [id("delta")] });
  mockRemote([id("echo")]);
  let editor = await openPage(firstPage, true, true);
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));

  editor = await setSyncInLab(false);
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
  await sendWorkflow(editor, "zulu");
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("zulu", "echo"));

  editor = await setSyncInLab(true);
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("zulu", "echo"));
  disposeFirstPage();

  // Browser-only uses are not replayed when synchronization is enabled again.
  editor = await openPage(nextPage);
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
});

test("A fresh browser-only page reads only the current workspace's saved history", async () => {
  const id = installWorkflows();
  mockCache({
    "okou_recent-workflows:org_default:test-user-123": [id("echo")],
    "okou_recent-workflows:another-workspace:test-user-123": [id("zulu")],
  });
  const editor = await openPage(context, false);
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

test("Re-enabling sync cannot apply an older read over an accepted browser-only use", async () => {
  installWorkflows();
  mockCache({});
  const reading = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(workflowsCollectionContract.recent, async ({ respond }) => {
    reading.resolve();
    await response.promise;
    return respond(200, { workflowIds: [] });
  });
  await openPage(context, true, true);
  await reading.promise;
  let editor = await setSyncInLab(false);
  await sendWorkflow(editor, "zulu");
  editor = await setSyncInLab(true);
  response.resolve();
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("zulu"));
});

test("Disabling sync in Lab preserves browser-only history when an earlier read finishes", async () => {
  const id = installWorkflows();
  mockCache({ "okou_recent-workflows": [id("zulu")] });
  const reading = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(workflowsCollectionContract.recent, async ({ respond }) => {
    reading.resolve();
    await response.promise;
    return respond(200, { workflowIds: [] });
  });
  await openPage(context, true, true);
  await reading.promise;
  const editor = await setSyncInLab(false);
  await act(async () => {
    response.resolve();
    await response.promise;
  });
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("zulu"));
});

test("Disabling sync in Lab preserves new browser-only uses when an earlier write finishes", async () => {
  const id = installWorkflows();
  mockRemote([id("echo")]);
  const writing = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.api(
    workflowsCollectionContract.recordRecentUse,
    async ({ body, respond }) => {
      writing.resolve();
      await response.promise;
      return respond(200, { workflowIds: [...body.workflowIds, id("echo")] });
    },
  );
  let editor = await openPage(context, true, true);
  await sendWorkflow(editor, "delta");
  await writing.promise;
  editor = await setSyncInLab(false);
  await sendWorkflow(editor, "zulu");
  await act(async () => {
    response.resolve();
    await response.promise;
  });
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("zulu", "delta", "echo"));
});

test("Enabling sync in Lab keeps the first accepted use ahead of its initial baseline when persistence fails", async () => {
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
  await openPage(context, false, true);
  const editor = await setSyncInLab(true);
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
  const editor = await openPage(context, true, true);
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
  expect(imports).toStrictEqual([[id("zulu"), id("echo")]]);

  // Disabling remote synchronization keeps this identity's canonical cache.
  const offlineEditor = await setSyncInLab(false);
  await openMenu(offlineEditor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
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

  // If failure had been treated as null + successful import, the compatibility
  // key would have been cleared and this existing OFF path would lose its order.
  const localEditor = await openPage(nextPage, false);
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
  await openPage(firstPage);
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
    featureSwitches: features,
  });
  const editor = await findComposerEditor();
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
  response.resolve();
  await userEvent.setup().keyboard("{Escape}");
  await openMenu(editor);
  expect(workflowNames()).toStrictEqual(ordered("echo"));
});
