import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatEventsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  AGENT_ID,
  composerWorkflow,
  findComposerEditor,
  createChatComposerHelpers,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const { mockAgent, mockBillingCapabilities, mockPersonalModelRoutes } =
  createChatComposerHelpers(context);

const THREAD_ID = "b0000000-0000-4000-a000-000000000920";

function mockWorkflows(prefix = "") {
  mockAgent();
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

function mockHistory(ids: readonly string[]) {
  const values = new Map([["okou_recent-workflows", JSON.stringify(ids)]]);
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

async function openComposer(path = `/chats/${THREAD_ID}`) {
  await setupPage({
    context,
    path,
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

test.each([`/chats/${THREAD_ID}`, `/agents/${AGENT_ID}/chat`])(
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
    path: `/agents/${AGENT_ID}/chat`,
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
    mockChatLifecycle(context, { threadId: THREAD_ID });
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
  mockWorkflows();
  const sendGate = createDeferredPromise<void>(context.signal);
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    sendGate: sendGate.promise,
  });
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

test("An accepted use retains history written by another browser tab", async () => {
  const workflows = mockWorkflows();
  const [zulu, , echo] = workflows;
  if (!zulu || !echo) {
    throw new Error("Expected workflow fixtures");
  }
  const history = mockHistory([zulu.id]);
  mockChatLifecycle(context, { threadId: THREAD_ID });
  const editor = await openComposer();
  // The page has read the first accepted use; another tab writes before the next send.
  history.set("okou_recent-workflows", JSON.stringify([echo.id, zulu.id]));
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

test("Persisted local recency ignores unavailable workflow ids", async () => {
  const workflows = mockWorkflows();
  const echo = workflows[2];
  if (!echo) {
    throw new Error("Expected workflow fixtures");
  }
  mockHistory(["deleted-workflow", echo.id]);
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
  mockWorkflows("qz-");
  mockChatLifecycle(context, { threadId: THREAD_ID });
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

test("Typed results keep their order and keyboard selection while an earlier send finishes", async () => {
  mockWorkflows("qz-");
  const sendGate = createDeferredPromise<void>(context.signal);
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    sendGate: sendGate.promise,
  });
  const editor = await openComposer();
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
});
