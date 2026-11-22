import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  chatEventsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts";
import type { ComposerWorkflow } from "@okouai/api-contracts/contracts/workflows";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  composerWorkflow,
  findComposerEditor,
  createChatComposerHelpers,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const { mockBillingCapabilities, mockPersonalModelRoutes } =
  createChatComposerHelpers(context);

const THREAD_ID = "b0000000-0000-4000-a000-000000000920";
const BINGJIE = Object.freeze({
  id: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
  fullName: "Bingjie Zang",
  email: "bingjie@okou.ai",
});
const RECENT_WORKFLOWS_KEY = "okou_recent-workflows";

function mockWorkflows(prefix = "") {
  mockPersonalModelRoutes();
  mockBillingCapabilities({ restrictedBuiltInModels: false });
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: "2026-09-07T00:00:00.000Z",
  });
  const workflows = ["zulu", "delta", "echo", "beta", "alpha", "charlie"].map(
    (name) => {
      return composerWorkflow(`${prefix}${name}`, "Usage test workflow");
    },
  );
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, workflows);
  });
  return workflows;
}

/**
 * A workflow row is named by its token; the description after it is not part
 * of what identifies the row.
 */
function buttonLabel(candidate: HTMLElement): string {
  const label =
    candidate.querySelector('[data-slot="slash-workflow-name"]') ?? candidate;
  return (
    candidate.getAttribute("aria-label") ??
    label.textContent ??
    ""
  ).trim();
}

function button(name: string): HTMLElement {
  const match = queryAllByRoleFast("button").find((candidate) => {
    return buttonLabel(candidate) === name;
  });
  if (!match) {
    throw new Error(`Expected button ${name}`);
  }
  return match;
}

function workflowNames(): string[] {
  const menu = screen.getByTestId("slash-workflow-menu");
  return queryAllByRoleFast("button", menu)
    .map(buttonLabel)
    .filter((name) => {
      return name.startsWith("/");
    });
}

function mockLocalHistory(value: string) {
  const values = new Map([
    [RECENT_WORKFLOWS_KEY, value],
    ["okou_other-workspace-data", "keep"],
  ]);
  vi.spyOn(localStorage, "getItem").mockImplementation((key) => {
    return values.get(key) ?? null;
  });
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    values.set(key, value);
  });
  vi.spyOn(localStorage, "removeItem").mockImplementation((key) => {
    values.delete(key);
  });
  return values;
}

function mockHistory(workflows: ComposerWorkflow[], ids: readonly string[]) {
  for (const [index, workflow] of workflows.entries()) {
    const rank = ids.indexOf(workflow.id);
    workflows[index] = {
      ...workflow,
      lastUsedAt:
        rank === -1
          ? null
          : new Date(Date.UTC(2026, 10, 16, 0, 0, 100 - rank)).toISOString(),
    };
  }
}

function mockAcceptedWorkflowUses(
  workflows: ComposerWorkflow[],
  sendGate?: Promise<void>,
) {
  let prompt = "";
  let use = 1000;
  const record = () => {
    for (const [index, workflow] of workflows.entries()) {
      if (prompt.split(/\s/u).includes(`/${workflow.name}`)) {
        workflows[index] = {
          ...workflow,
          lastUsedAt: new Date(
            Date.UTC(2026, 10, 16, 0, 0, use++),
          ).toISOString(),
        };
      }
    }
  };
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    onSendRequest(body) {
      prompt = body.prompt;
      if (!sendGate) {
        record();
      }
    },
    ...(sendGate
      ? {
          sendGate: async () => {
            await sendGate;
            record();
          },
        }
      : {}),
  });
}

async function openComposer(
  path = `/chats/${THREAD_ID}`,
  serverRecency = true,
) {
  await setupPage({
    context,
    path,
    ...(serverRecency ? { auth: { user: BINGJIE } } : {}),
    featureSwitches: { [FeatureSwitchKey.WorkflowRecency]: serverRecency },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toHaveLength(4);
  });
  return editor;
}

test("The overview fills from the alphabet and expanding preserves the visible workflows' order", async () => {
  mockWorkflows();
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await openComposer();
  const overview = ["/alpha", "/beta", "/charlie", "/delta"];
  expect(workflowNames()).toStrictEqual(overview);

  click(button("Show 2 more"));

  expect(workflowNames()).toStrictEqual([...overview, "/echo", "/zulu"]);
});

test("Server recency preserves accepted timestamps within the same millisecond", async () => {
  const workflows = mockWorkflows();
  for (const [index, workflow] of workflows.entries()) {
    if (workflow.name === "zulu" || workflow.name === "alpha") {
      workflows[index] = {
        ...workflow,
        lastUsedAt:
          workflow.name === "zulu"
            ? "2026-11-16T00:00:00.000002Z"
            : "2026-11-16T00:00:00.000001Z",
      };
    }
  }
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await openComposer();
  expect(workflowNames()).toStrictEqual([
    "/zulu",
    "/alpha",
    "/beta",
    "/charlie",
  ]);
});

test.each([`/chats/${THREAD_ID}`, `/`])(
  "An abandoned workflow selection at %s does not change recency",
  async (path) => {
    mockWorkflows();
    mockChatLifecycle(context, { threadId: THREAD_ID });
    const editor = await openComposer(path);
    click(button("Show 2 more"));
    click(button("/echo"));
    await fill(editor, "Draft /");
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual([
        "/alpha",
        "/beta",
        "/charlie",
        "/delta",
      ]);
    });
  },
);

test.each([
  {
    path: `/`,
    history: [],
    name: "zulu",
    expected: ["/zulu", "/alpha", "/beta", "/charlie"],
  },
  {
    path: `/chats/${THREAD_ID}`,
    history: [],
    name: "zulu",
    expected: ["/zulu", "/alpha", "/beta", "/charlie"],
  },
  {
    path: `/chats/${THREAD_ID}`,
    history: ["zulu"],
    name: "echo",
    expected: ["/echo", "/zulu", "/alpha", "/beta"],
  },
  {
    path: `/chats/${THREAD_ID}`,
    history: ["echo", "zulu"],
    name: "zulu",
    expected: ["/zulu", "/echo", "/alpha", "/beta"],
  },
])(
  "An accepted $name send at $path promotes the workflow from $history",
  async ({ path, history, name, expected }) => {
    const workflows = mockWorkflows();
    mockHistory(
      workflows,
      history.map((token) => {
        const workflow = workflows.find((workflow) => {
          return workflow.name === token;
        });
        if (!workflow) {
          throw new Error(`Missing workflow ${token}`);
        }
        return workflow.id;
      }),
    );
    mockAcceptedWorkflowUses(workflows);
    let editor = await openComposer(path);
    const names = [name];
    for (const name of names) {
      await fill(editor, `/${name}`);
      await waitFor(() => {
        expect(button("Send")).toBeEnabled();
      });
      click(button("Send"));
      // A new-thread send navigates to a new composer. Type the next draft and
      // wait until sending is available again, proving submission has settled.
      await waitFor(() => {
        expect(window.location.pathname).toMatch(/^\/chats\//u);
      });
      editor = await findComposerEditor();
      await waitFor(() => {
        expect(editor.textContent).toBe("");
      });
      await fill(editor, "Next draft");
      await waitFor(() => {
        expect(button("Send")).toBeEnabled();
      });
    }
    await fill(editor, "Draft /");
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual(expected);
    });
    click(button("Show 2 more"));
    expect(workflowNames().slice(0, 4)).toStrictEqual(expected);
  },
);

test("An open menu keeps its order when an earlier send finishes, then refreshes on reopening", async () => {
  const workflows = mockWorkflows();
  const sendGate = createDeferredPromise<void>(context.signal);
  mockAcceptedWorkflowUses(workflows, sendGate.promise);
  const editor = await openComposer();
  await fill(editor, "/zulu");
  click(button("Send"));
  await waitFor(() => {
    expect(editor.textContent).toBe("");
  });
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/alpha",
      "/beta",
      "/charlie",
      "/delta",
    ]);
  });
  sendGate.resolve();
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Show 2 more"));
  expect(workflowNames()).toStrictEqual([
    "/alpha",
    "/beta",
    "/charlie",
    "/delta",
    "/echo",
    "/zulu",
  ]);
  const user = userEvent.setup();
  await user.keyboard("{Escape}");
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/zulu",
      "/alpha",
      "/beta",
      "/charlie",
    ]);
  });
});

test("An accepted use retains server history written by another device", async () => {
  const workflows = mockWorkflows();
  const [zulu, , echo] = workflows;
  if (!zulu || !echo) {
    throw new Error("Expected workflow fixtures");
  }
  mockHistory(workflows, [zulu.id]);
  mockAcceptedWorkflowUses(workflows);
  const editor = await openComposer();
  // Another device is accepted after this page's first composer read.
  mockHistory(workflows, [echo.id, zulu.id]);
  for (const name of ["delta"]) {
    await fill(editor, `/${name}`);
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
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/delta",
      "/echo",
      "/zulu",
      "/alpha",
    ]);
  });
});

test("Server history is available in a fresh browser session", async () => {
  const workflows = mockWorkflows();
  const echo = workflows[2];
  if (!echo) {
    throw new Error("Expected workflow fixtures");
  }
  mockHistory(workflows, [echo.id]);
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await openComposer();
  expect(workflowNames()).toStrictEqual([
    "/echo",
    "/alpha",
    "/beta",
    "/charlie",
  ]);
});

test("Typed search keeps name matches ahead of more recently used description matches", async () => {
  const workflows = mockWorkflows();
  mockHistory(
    workflows,
    workflows.map((workflow) => {
      return workflow.id;
    }),
  );
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await openComposer();
  const user = userEvent.setup();
  await user.keyboard("a");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/alpha",
      "/delta",
      "/beta",
      "/charlie",
      "/zulu",
      "/echo",
    ]);
  });
});

test("The pr-a search ranks recently used prefixes above substrings, abbreviations, and descriptions", async () => {
  mockWorkflows();
  const names = [
    "report",
    "team-pr-auto",
    "presentation-restart-auto",
    "pr-auto",
    "pr-auto-deploy",
    "pr-audit",
  ];
  const workflows = names.map((name) => {
    return composerWorkflow(
      name,
      name === "report" ? "Run pr-auto for a pull request" : null,
    );
  });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, workflows);
  });
  mockHistory(
    workflows,
    ["report", "team-pr-auto", "pr-auto", "pr-auto-deploy"].map((name) => {
      const workflow = workflows.find((workflow) => {
        return workflow.name === name;
      });
      if (!workflow) {
        throw new Error(`Missing workflow ${name}`);
      }
      return workflow.id;
    }),
  );
  mockChatLifecycle(context, { threadId: THREAD_ID });
  const editor = await openComposer();
  await fill(editor, "/Pr-A");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/pr-auto",
      "/pr-auto-deploy",
      "/pr-audit",
      "/team-pr-auto",
      "/report",
      "/presentation-restart-auto",
    ]);
  });
  await fill(editor, "/pr-auto-deploy");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual(["/pr-auto-deploy"]);
  });
  await userEvent.setup().keyboard("{Enter}");
  expect(editor).toHaveTextContent(/^\/pr-auto-deploy\s*$/);
  expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
});

async function sendWorkflowPrompt(prompt: string): Promise<HTMLElement> {
  const editor = await findComposerEditor();
  await fill(editor, prompt);
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
  return editor;
}

test("The latest accepted use wins regardless of frequency on desktop and mobile", async () => {
  const workflows = mockWorkflows("qz-");
  mockAcceptedWorkflowUses(workflows);
  await openComposer();
  await sendWorkflowPrompt("/qz-delta");
  await sendWorkflowPrompt("/qz-delta");
  const editor = await sendWorkflowPrompt("/qz-beta");

  for (const desktop of [true, false]) {
    context.mocks.browser.matchMedia(desktop);
    await fill(editor, "Draft /qz");
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual([
        "/qz-beta",
        "/qz-delta",
        "/qz-alpha",
        "/qz-charlie",
        "/qz-echo",
        "/qz-zulu",
      ]);
    });
    expect(button("/qz-beta")).toHaveAttribute("data-active", "true");
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(editor).toHaveTextContent("Draft /qz-delta");
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
  }
});

test("A rejected send does not promote a workflow", async () => {
  mockWorkflows();
  mockChatLifecycle(context, { threadId: THREAD_ID });
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    return respond(400, {
      error: { code: "BAD_REQUEST", message: "Message was not accepted" },
    });
  });
  const editor = await openComposer();
  await fill(editor, "/zulu");
  click(button("Send"));
  await screen.findByText("Message was not accepted");
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/alpha",
      "/beta",
      "/charlie",
      "/delta",
    ]);
  });
});

test.each(["typed", "IME"] as const)(
  "A delayed %s query refresh does not expose another snapshot's selectable rows",
  async (input) => {
    const workflows = mockWorkflows("qz-");
    let refresh: Promise<void> | null = null;
    context.mocks.api(
      workflowsCollectionContract.composer,
      async ({ respond }) => {
        const items = [...workflows];
        await refresh;
        return respond(200, items);
      },
    );
    mockChatLifecycle(context, { threadId: THREAD_ID });
    const editor = await openComposer();
    await fill(editor, "/qz");
    await waitFor(() => {
      expect(workflowNames()).toHaveLength(6);
      expect(
        context.mocks.ably.hasSubscription("userPreferenceChanged"),
      ).toBeTruthy();
    });
    const zulu = workflows.find((workflow) => {
      return workflow.name === "qz-zulu";
    });
    if (!zulu) {
      throw new Error("Expected workflow fixture");
    }
    mockHistory(workflows, [zulu.id]);
    const response = createDeferredPromise<void>(context.signal);
    refresh = response.promise;
    await act(() => {
      context.mocks.ably.trigger("userPreferenceChanged", {
        kinds: ["workflowRecency"],
      });
    });
    if (input === "IME") {
      fireEvent.compositionStart(editor);
    }
    // Neither a notification nor starting composition changes this query.
    expect(workflowNames()).toHaveLength(6);
    if (input === "typed") {
      await fill(editor, "/qz-");
    } else {
      fireEvent(
        editor,
        Object.assign(new Event("compositionupdate", { bubbles: true }), {
          data: "-",
        }),
      );
      const text = document
        .createTreeWalker(editor, NodeFilter.SHOW_TEXT)
        .nextNode();
      if (!(text instanceof Text)) {
        throw new Error("Expected composer text");
      }
      text.data = "/qz-";
      window.getSelection()?.collapse(text, text.length);
      fireEvent.input(editor, {
        data: "-",
        inputType: "insertCompositionText",
        isComposing: true,
      });
    }
    await screen.findByRole("status", { name: "Loading workflows..." });
    expect(workflowNames()).toStrictEqual([]);
    const user = userEvent.setup();
    expect(
      fireEvent.keyDown(editor, {
        key: "ArrowDown",
        ...(input === "IME" ? { isComposing: true, keyCode: 229 } : {}),
      }),
    ).toBe(input === "IME");
    response.resolve();
    await waitFor(() => {
      expect(workflowNames()[0]).toBe("/qz-zulu");
    });
    if (input === "IME") {
      fireEvent.compositionEnd(editor, { data: "-" });
    }
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(editor.textContent).toBe("/qz-zulu ");
    });
  },
);

test.each(["notification", "continuity gap"] as const)(
  "A %s refresh preserves the open query and updates the next query",
  async (source) => {
    const workflows = mockWorkflows("qz-");
    mockChatLifecycle(context, { threadId: THREAD_ID });
    const editor = await openComposer();
    await fill(editor, "Draft /qz");
    const alphabetical = [
      "/qz-alpha",
      "/qz-beta",
      "/qz-charlie",
      "/qz-delta",
      "/qz-echo",
      "/qz-zulu",
    ];
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual(alphabetical);
      expect(
        context.mocks.ably.hasSubscription("userPreferenceChanged"),
      ).toBeTruthy();
    });
    const zulu = workflows.find((workflow) => {
      return workflow.name === "qz-zulu";
    });
    if (!zulu) {
      throw new Error("Expected workflow fixture");
    }
    mockHistory(workflows, [zulu.id]);
    await act(() => {
      if (source === "notification") {
        context.mocks.ably.trigger("userPreferenceChanged", {
          kinds: ["workflowRecency"],
        });
      } else {
        context.mocks.ably.triggerReconnect();
      }
    });
    expect(workflowNames()).toStrictEqual(alphabetical);
    await fill(editor, "Draft /qz-");
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual([
        "/qz-zulu",
        ...alphabetical.slice(0, -1),
      ]);
    });
  },
);

test.each([false, true])(
  "Typed results keep their order and keyboard selection while an earlier send finishes with server recency %s",
  async (serverRecency) => {
    const workflows = mockWorkflows("qz-");
    const sendGate = createDeferredPromise<void>(context.signal);
    mockAcceptedWorkflowUses(workflows, sendGate.promise);
    const editor = await openComposer(undefined, serverRecency);
    await fill(editor, "/qz-delta");
    click(button("Send"));
    await waitFor(() => {
      expect(editor.textContent).toBe("");
    });
    await fill(editor, "Draft /qz");
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual([
        "/qz-alpha",
        "/qz-beta",
        "/qz-charlie",
        "/qz-delta",
        "/qz-echo",
        "/qz-zulu",
      ]);
    });
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}");
    sendGate.resolve();
    await waitFor(() => {
      expect(button("Send")).toBeEnabled();
    });
    expect(workflowNames()).toStrictEqual([
      "/qz-alpha",
      "/qz-beta",
      "/qz-charlie",
      "/qz-delta",
      "/qz-echo",
      "/qz-zulu",
    ]);
    expect(button("/qz-beta")).toHaveAttribute("data-active", "true");
    await user.keyboard("{Enter}");
    expect(editor).toHaveTextContent("Draft /qz-beta");
    await fill(editor, "Draft /qz");
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual([
        "/qz-delta",
        "/qz-alpha",
        "/qz-beta",
        "/qz-charlie",
        "/qz-echo",
        "/qz-zulu",
      ]);
    });
  },
);

test("Flag OFF keeps browser order and merges accepted sends with the latest unbounded local history", async () => {
  const workflows = mockWorkflows();
  const [zulu, delta, echo] = workflows;
  if (!zulu || !delta || !echo) {
    throw new Error("Expected workflow fixtures");
  }
  const tail = Array.from({ length: 14 }, (_, index) => {
    return `a0000000-0000-4000-a000-${String(index).padStart(12, "0")}`;
  });
  const storage = mockLocalHistory(JSON.stringify([echo.id, ...tail]));
  mockHistory(workflows, [zulu.id]);
  mockAcceptedWorkflowUses(workflows);
  const editor = await openComposer(undefined, false);
  expect(workflowNames()).toStrictEqual([
    "/echo",
    "/alpha",
    "/beta",
    "/charlie",
  ]);
  // A different tab accepted delta after this query was opened.
  storage.set(
    RECENT_WORKFLOWS_KEY,
    JSON.stringify([delta.id, echo.id, ...tail]),
  );
  const next = await sendWorkflowPrompt("/zulu");
  expect(storage.get(RECENT_WORKFLOWS_KEY)).toBe(
    JSON.stringify([zulu.id, delta.id, echo.id, ...tail]),
  );
  await fill(next, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/zulu",
      "/delta",
      "/echo",
      "/alpha",
    ]);
  });
  expect(editor).toBeInTheDocument();
});

test("Flag OFF preserves an accepted send when the browser history write fails", async () => {
  const workflows = mockWorkflows();
  const echo = workflows[2];
  if (!echo) {
    throw new Error("Expected workflow fixture");
  }
  const legacy = JSON.stringify([echo.id]);
  const storage = mockLocalHistory(legacy);
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key === RECENT_WORKFLOWS_KEY) {
      throw new DOMException(
        "Workflow history storage is full",
        "QuotaExceededError",
      );
    }
    storage.set(key, value);
  });
  mockAcceptedWorkflowUses(workflows);
  await openComposer(undefined, false);

  const editor = await sendWorkflowPrompt("/zulu");
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/echo",
      "/alpha",
      "/beta",
      "/charlie",
    ]);
  });
  expect(storage.get(RECENT_WORKFLOWS_KEY)).toBe(legacy);
});

test("Flag OFF keeps an open local query stable until its query changes", async () => {
  const workflows = mockWorkflows("qz-");
  const [zulu, , echo] = workflows;
  if (!zulu || !echo) {
    throw new Error("Expected workflow fixtures");
  }
  const storage = mockLocalHistory(JSON.stringify([echo.id]));
  mockChatLifecycle(context, { threadId: THREAD_ID });
  const editor = await openComposer(undefined, false);
  await fill(editor, "/qz");
  await waitFor(() => {
    expect(workflowNames()[0]).toBe("/qz-echo");
  });
  storage.set(RECENT_WORKFLOWS_KEY, JSON.stringify([zulu.id]));
  expect(workflowNames()[0]).toBe("/qz-echo");
  click(button("/qz-alpha"));
  await fill(editor, "/qz");
  await waitFor(() => {
    expect(workflowNames()[0]).toBe("/qz-zulu");
  });
});

test("Flag ON imports valid deduplicated legacy IDs and displays only the refetched DB order", async () => {
  const workflows = mockWorkflows();
  const [zulu, , echo] = workflows;
  if (!zulu || !echo) {
    throw new Error("Expected workflow fixtures");
  }
  const legacy = JSON.stringify([
    "invalid",
    zulu.id,
    zulu.id.toUpperCase(),
    42,
    echo.id,
  ]);
  const storage = mockLocalHistory(legacy);
  const imported = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    workflowsCollectionContract.migrateRecency,
    async ({ body, respond }) => {
      expect(body).toStrictEqual({ workflowIds: [zulu.id, echo.id] });
      await imported.promise;
      // Visibility/shadowing and ordering belong to the server, not the raw IDs.
      for (const [index, workflow] of workflows.entries()) {
        workflows[index] = {
          ...workflow,
          lastUsedAt:
            workflow.id === echo.id
              ? "1970-01-01T00:00:00.000010Z"
              : workflow.id === zulu.id
                ? "1970-01-01T00:00:00.000009Z"
                : null,
        };
      }
      return respond(200, { migrated: true });
    },
  );
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    auth: { user: BINGJIE },
    featureSwitches: { [FeatureSwitchKey.WorkflowRecency]: true },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  await screen.findByRole("status", { name: "Loading workflows..." });
  expect(workflowNames()).toStrictEqual([]);
  imported.resolve();
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/echo",
      "/zulu",
      "/alpha",
      "/beta",
    ]);
  });
  expect(storage.get(RECENT_WORKFLOWS_KEY)).toBe(legacy);
  expect(storage.get("okou_other-workspace-data")).toBe("keep");
});

test("The first slash send waits for legacy import before the accepted message", async () => {
  const workflows = mockWorkflows();
  const zulu = workflows[0];
  if (!zulu) {
    throw new Error("Expected workflow fixture");
  }
  const legacy = JSON.stringify([zulu.id]);
  const storage = mockLocalHistory(legacy);
  const importRequested = context.mocks.deferred<void>();
  const imported = context.mocks.deferred<void>();
  context.mocks.api(
    workflowsCollectionContract.migrateRecency,
    async ({ respond }) => {
      importRequested.resolve();
      await imported.promise;
      mockHistory(workflows, [zulu.id]);
      return respond(200, { migrated: true });
    },
  );
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    onSendRequest() {
      expect(imported.settled()).toBeTruthy();
    },
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    auth: { user: BINGJIE },
    featureSwitches: { [FeatureSwitchKey.WorkflowRecency]: true },
  });
  const editor = await findComposerEditor();
  await fill(editor, "/zulu please");
  await importRequested.promise;
  await waitFor(() => {
    expect(button("Send")).toBeEnabled();
  });
  click(button("Send"));
  await waitFor(() => {
    expect(button("Send")).toBeDisabled();
  });
  expect(editor).toHaveTextContent("/zulu please");
  imported.resolve();
  await waitFor(() => {
    expect(editor.textContent).toBe("");
  });
  expect(storage.get(RECENT_WORKFLOWS_KEY)).toBe(legacy);
});

test("Two mounted composers keep independent queries while sharing a pending import", async () => {
  const workflows = mockWorkflows();
  const zulu = workflows[0];
  if (!zulu) {
    throw new Error("Expected workflow fixture");
  }
  mockLocalHistory(JSON.stringify([zulu.id]));
  const main = continuityThread(872, 1, "Main workflow conversation");
  const side = continuityThread(872, 2, "Side workflow conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 872,
    threads: [main, side],
    chatEventRows: [],
  });
  const importRequested = context.mocks.deferred<void>();
  const imported = context.mocks.deferred<void>();
  context.mocks.api(
    workflowsCollectionContract.migrateRecency,
    async ({ respond }) => {
      importRequested.resolve();
      await imported.promise;
      mockHistory(workflows, [zulu.id]);
      return respond(200, { migrated: true });
    },
  );
  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    ...workspace.pageOptions,
    auth: { ...workspace.pageOptions.auth, user: BINGJIE },
    featureSwitches: { [FeatureSwitchKey.WorkflowRecency]: true },
  });
  const editors = await waitFor(() => {
    const elements = document.querySelectorAll<HTMLElement>(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    expect(elements).toHaveLength(2);
    return [...elements];
  });
  const [mainEditor, sideEditor] = editors;
  if (!mainEditor || !sideEditor) {
    throw new Error("Expected both composer editors");
  }
  await fill(mainEditor, "/zu");
  await importRequested.promise;
  await screen.findByRole("status", { name: "Loading workflows..." });
  await fill(sideEditor, "/ec");
  await screen.findByRole("status", { name: "Loading workflows..." });
  expect(workflowNames()).toStrictEqual([]);
  imported.resolve();
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual(["/echo"]);
  });
  await userEvent.setup().keyboard("{Enter}");
  expect(sideEditor).toHaveTextContent("/echo");
  expect(mainEditor).toHaveTextContent("/zu");
  await fill(mainEditor, "/zu");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual(["/zulu"]);
  });
  await userEvent.setup().keyboard("{Enter}");
  expect(mainEditor).toHaveTextContent("/zulu");
  expect(sideEditor).toHaveTextContent("/echo");
});

test("Refocusing each composer highlights the authorized names refreshed by another composer", async () => {
  const original = mockWorkflows()[0];
  if (!original) {
    throw new Error("Expected workflow fixture");
  }
  mockLocalHistory("[]");
  let catalog = [original];
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, catalog);
  });
  const main = continuityThread(873, 1, "Main workflow conversation");
  const side = continuityThread(873, 2, "Side workflow conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 873,
    threads: [main, side],
    chatEventRows: [],
  });
  await setupPage({
    context,
    path: `/chats/${main.id}?sidebar=${side.id}`,
    ...workspace.pageOptions,
    auth: { ...workspace.pageOptions.auth, user: BINGJIE },
    featureSwitches: { [FeatureSwitchKey.WorkflowRecency]: true },
  });
  const editors = await waitFor(() => {
    const elements = document.querySelectorAll<HTMLElement>(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    expect(elements).toHaveLength(2);
    return [...elements];
  });
  const [mainEditor, sideEditor] = editors;
  if (!mainEditor || !sideEditor) {
    throw new Error("Expected both composer editors");
  }
  const highlightedNames = (editor: HTMLElement) => {
    return Array.from(
      editor.querySelectorAll("span.text-brand-text"),
      (span) => {
        return span.textContent;
      },
    );
  };
  const draft = "Run /zulu and /renamed please";
  await fill(mainEditor, draft);
  await waitFor(() => {
    expect(highlightedNames(mainEditor)).toStrictEqual(["/zulu"]);
  });
  await fill(sideEditor, draft);
  await waitFor(() => {
    expect(highlightedNames(sideEditor)).toStrictEqual(["/zulu"]);
  });

  // A remote rename is discovered by a genuine query opening, not local CRUD.
  catalog = [{ ...original, name: "renamed" }];
  const user = userEvent.setup();
  await user.keyboard(" /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual(["/renamed"]);
  });
  click(button("/renamed"));
  expect(sideEditor).toHaveTextContent(`${draft} /renamed`);

  await user.click(mainEditor);
  await waitFor(() => {
    expect(highlightedNames(mainEditor)).toStrictEqual(["/renamed"]);
  });
  await user.keyboard(" again");
  expect(highlightedNames(mainEditor)).toStrictEqual(["/renamed"]);

  await user.click(sideEditor);
  await waitFor(() => {
    expect(highlightedNames(sideEditor)).toStrictEqual([
      "/renamed",
      "/renamed",
    ]);
  });
});

test("Flag ON existing DB history ignores local priority and accepted sends leave legacy storage unchanged", async () => {
  const workflows = mockWorkflows();
  const [zulu, , echo] = workflows;
  if (!zulu || !echo) {
    throw new Error("Expected workflow fixtures");
  }
  const legacy = JSON.stringify([zulu.id]);
  const storage = mockLocalHistory(legacy);
  mockHistory(workflows, [echo.id]);
  mockAcceptedWorkflowUses(workflows);
  const editor = await openComposer();
  expect(workflowNames()[0]).toBe("/echo");
  await sendWorkflowPrompt("/delta");
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/delta",
      "/echo",
      "/alpha",
      "/beta",
    ]);
  });
  expect(storage.get(RECENT_WORKFLOWS_KEY)).toBe(legacy);
});

test.each(["[]", "{malformed", '{"ids":[]}', '[null,42,"not-a-uuid"]'])(
  "Flag ON safely ignores unusable legacy storage %s without importing it",
  async (legacy) => {
    mockWorkflows();
    const storage = mockLocalHistory(legacy);
    mockChatLifecycle(context, { threadId: THREAD_ID });
    await openComposer();
    expect(workflowNames()).toStrictEqual([
      "/alpha",
      "/beta",
      "/charlie",
      "/delta",
    ]);
    expect(storage.get(RECENT_WORKFLOWS_KEY)).toBe(legacy);
  },
);

test("Flag ON sends at most the first 1000 valid distinct legacy IDs in newest-first order", async () => {
  const workflows = mockWorkflows();
  const zulu = workflows[0];
  if (!zulu) {
    throw new Error("Expected workflow fixture");
  }
  const ids = [
    zulu.id,
    ...Array.from({ length: 1004 }, (_, index) => {
      return `a0000000-0000-4000-a000-${String(index).padStart(12, "0")}`;
    }),
  ];
  mockLocalHistory(JSON.stringify(["invalid", ids[0], ...ids]));
  context.mocks.api(
    workflowsCollectionContract.migrateRecency,
    ({ body, respond }) => {
      expect(body).toStrictEqual({ workflowIds: ids.slice(0, 1000) });
      return respond(200, { migrated: false });
    },
  );
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await openComposer();
  expect(workflowNames()[0]).toBe("/alpha");
});

test("Flag ON remembers a no-op import when the visible catalog has no timestamps", async () => {
  const workflows = mockWorkflows();
  const zulu = workflows[0];
  if (!zulu) {
    throw new Error("Expected workflow fixture");
  }
  mockLocalHistory(JSON.stringify([zulu.id]));
  let imported = false;
  context.mocks.api(
    workflowsCollectionContract.migrateRecency,
    ({ respond }) => {
      if (imported) {
        throw new Error("An acknowledged no-op migration must not be repeated");
      }
      imported = true;
      // The server already has recency for a workflow outside this catalog.
      return respond(200, { migrated: false });
    },
  );
  mockChatLifecycle(context, { threadId: THREAD_ID });
  const editor = await openComposer();
  expect(workflowNames()[0]).toBe("/alpha");
  await userEvent.setup().keyboard("{Escape}");
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/alpha",
      "/beta",
      "/charlie",
      "/delta",
    ]);
  });
});

test("A failed ON import surfaces its error without local fallback and retries on the next opening", async () => {
  const workflows = mockWorkflows();
  const zulu = workflows[0];
  if (!zulu) {
    throw new Error("Expected workflow fixture");
  }
  const legacy = JSON.stringify([zulu.id]);
  const storage = mockLocalHistory(legacy);
  let failed = true;
  context.mocks.http.post("*/api/workflows/recency/migrate", () => {
    return failed
      ? Response.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Recency storage unavailable",
            },
          },
          { status: 500 },
        )
      : Response.json({ migrated: false });
  });
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    auth: { user: BINGJIE },
    featureSwitches: { [FeatureSwitchKey.WorkflowRecency]: true },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  await screen.findByText("Recency storage unavailable");
  expect(workflowNames()).toStrictEqual([]);
  expect(storage.get(RECENT_WORKFLOWS_KEY)).toBe(legacy);
  failed = false;
  await userEvent.setup().keyboard("{Escape}");
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toStrictEqual([
      "/alpha",
      "/beta",
      "/charlie",
      "/delta",
    ]);
  });
});

test.each([false, true])(
  "A failed workflow read recovers on reopening with server recency %s",
  async (serverRecency) => {
    mockLocalHistory("[]");
    const workflows = mockWorkflows();
    let failed = true;
    context.mocks.http.get("*/api/workflows/for-composer", () => {
      return failed
        ? Response.json(
            {
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "Workflow catalog unavailable",
              },
            },
            { status: 500 },
          )
        : Response.json(workflows);
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });
    await setupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      ...(serverRecency ? { auth: { user: BINGJIE } } : {}),
      featureSwitches: { [FeatureSwitchKey.WorkflowRecency]: serverRecency },
    });
    const editor = await findComposerEditor();
    await fill(editor, "Draft /");
    await screen.findByText("Workflow catalog unavailable");

    failed = false;
    await userEvent.setup().keyboard("{Escape}");
    await fill(editor, "Draft /");
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual([
        "/alpha",
        "/beta",
        "/charlie",
        "/delta",
      ]);
    });
  },
);

test.each(["account", "workspace", "session"] as const)(
  "A delayed workflow token cannot cross a %s change before Clerk notifies the app",
  async (scope) => {
    const workflows = mockWorkflows("first-");
    mockChatLifecycle(context, { threadId: THREAD_ID });
    const editor = await openComposer();
    await userEvent.setup().keyboard("{Escape}");
    const tokenRequested = context.mocks.deferred<void>();
    const token = context.mocks.deferred<string>();
    const requestedTokens: (string | null)[] = [];
    context.mocks.api(
      workflowsCollectionContract.composer,
      ({ request, respond }) => {
        requestedTokens.push(request.headers.get("authorization"));
        return respond(200, workflows);
      },
    );
    mockedClerk.sessionGetToken.mockImplementationOnce(() => {
      tokenRequested.resolve();
      return token.promise;
    });
    await fill(editor, "/first");
    await tokenRequested.promise;
    await screen.findByRole("status", { name: "Loading workflows..." });
    const clerk = context.mocks.clerk();
    act(() => {
      if (scope === "workspace") {
        clerk.organization({
          activeOrg: { id: "delayed-token-org", name: "Next Workspace" },
          memberships: [{ id: "delayed-token-org" }],
        });
      } else {
        clerk.user(
          scope === "account"
            ? { id: "delayed-token-user", fullName: "Next User" }
            : BINGJIE,
          { id: "delayed-token-session", token: "next-token" },
        );
      }
      // Deliberately delay the SDK notification: token guards must inspect
      // actual Clerk resources rather than only the reactive session key.
    });
    token.resolve("old-owner-token");
    await waitFor(() => {
      expect(
        screen.queryByRole("status", { name: "Loading workflows..." }),
      ).not.toBeInTheDocument();
    });
    expect(workflowNames()).toStrictEqual([]);
    expect(requestedTokens).toStrictEqual([]);
    act(() => {
      clerk.stateChanged();
    });
    const nextEditor = await findComposerEditor();
    await fill(nextEditor, "/first");
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual([
        "/first-alpha",
        "/first-beta",
        "/first-charlie",
        "/first-delta",
        "/first-echo",
        "/first-zulu",
      ]);
    });
    expect(requestedTokens).not.toContain("Bearer old-owner-token");
  },
);

test.each(["account", "workspace", "session"] as const)(
  "A pending ON legacy import cannot cross a %s change",
  async (scope) => {
    const first = mockWorkflows("first-");
    const next = first.map((workflow) => {
      return {
        ...workflow,
        id: crypto.randomUUID(),
        name: workflow.name.replace("first-", "next-"),
      };
    });
    const oldResponse = createDeferredPromise<void>(context.signal);
    const requested = createDeferredPromise<void>(context.signal);
    let current = first;
    const zulu = first[0];
    if (!zulu) {
      throw new Error("Expected workflow fixture");
    }
    mockLocalHistory(JSON.stringify([zulu.id]));
    context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
      return respond(200, [...current]);
    });
    context.mocks.api(
      workflowsCollectionContract.migrateRecency,
      async ({ respond }) => {
        const oldOwner = current === first;
        if (oldOwner) {
          requested.resolve();
          await oldResponse.promise;
        }
        return respond(200, { migrated: oldOwner });
      },
    );
    mockChatLifecycle(context, { threadId: THREAD_ID });
    await setupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      auth: { user: BINGJIE },
      featureSwitches: { [FeatureSwitchKey.WorkflowRecency]: true },
    });
    let editor = await findComposerEditor();
    await fill(editor, "/first");
    await requested.promise;
    await screen.findByRole("status", { name: "Loading workflows..." });
    current = next;
    const clerk = context.mocks.clerk();
    act(() => {
      if (scope === "workspace") {
        clerk.organization({
          activeOrg: { id: "other-recency-org", name: "Other Workspace" },
          memberships: [{ id: "other-recency-org" }],
        });
      } else {
        clerk.user(
          scope === "account"
            ? { id: "another-recency-user", fullName: "Another User" }
            : BINGJIE,
          { id: "another-recency-session", token: "another-token" },
        );
      }
      clerk.stateChanged();
    });
    oldResponse.resolve();
    editor = await findComposerEditor();
    await fill(editor, "/next");
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual([
        "/next-alpha",
        "/next-beta",
        "/next-charlie",
        "/next-delta",
        "/next-echo",
        "/next-zulu",
      ]);
    });
    expect(screen.queryByText("/first-zulu")).not.toBeInTheDocument();
  },
);
