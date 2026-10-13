import { workflowsCollectionContract } from "@okouai/api-contracts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  AGENT_ID,
  composerWorkflow,
  context,
  findComposerEditor,
  mockAgent,
  mockBillingCapabilities,
  mockPersonalModelRoutes,
} from "./chat-composer-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const THREAD_ID = "b0000000-0000-4000-a000-000000000920";

function mockWorkflows() {
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
      return composerWorkflow(name, "Recency test workflow");
    },
  );
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, workflows);
  });
  return workflows;
}

function button(name: string): HTMLElement {
  const match = queryAllByRoleFast("button").find((candidate) => {
    return (
      (
        candidate.getAttribute("aria-label") ?? candidate.textContent
      )?.trim() === name
    );
  });
  if (!match) {
    throw new Error(`Expected button ${name}`);
  }
  return match;
}

function workflowNames(): string[] {
  const menu = screen.getByTestId("slash-workflow-menu");
  return queryAllByRoleFast("button", menu)
    .map((candidate) => {
      return candidate.textContent?.trim() ?? "";
    })
    .filter((name) => {
      return name.startsWith("/");
    });
}

function seedHistory(
  ids: readonly string[],
  user = "test-user-123",
  org = "org_default",
) {
  // Browser storage is the external persistence boundary, not composer state.
  const storage = localStorageSignals(`recent-workflows:${user}:${org}`);
  context.store.set(storage.set$, JSON.stringify(ids));
}

async function openComposer(enabled = true, path = `/chats/${THREAD_ID}`) {
  await setupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.ComposerAnchoredSuggestions]: enabled,
    },
  });
  const editor = await findComposerEditor();
  await fill(editor, "Draft /");
  await waitFor(() => {
    expect(workflowNames()).toHaveLength(enabled ? 4 : 6);
  });
  return editor;
}

test("The overview fills from the alphabet and expanding preserves the visible workflows' order", async () => {
  mockWorkflows();
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await openComposer();
  const overview = ["/alpha", "/beta", "/charlie", "/delta"];
  expect(workflowNames()).toStrictEqual(overview);

  click(button("Show all workflows"));

  expect(workflowNames()).toStrictEqual([...overview, "/echo", "/zulu"]);
});

test.each([`/chats/${THREAD_ID}`, `/agents/${AGENT_ID}/chat`])(
  "Accepted sends at %s promote workflows by recency, while abandoned selections do not",
  async (path) => {
    mockWorkflows();
    mockChatLifecycle(context, { threadId: THREAD_ID });
    let editor = await openComposer(true, path);
    click(button("Show all workflows"));
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

    const names = path.startsWith("/agents/")
      ? ["zulu"]
      : ["zulu", "echo", "zulu"];
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
    const expected = path.startsWith("/agents/")
      ? ["/zulu", "/alpha", "/beta", "/charlie"]
      : ["/zulu", "/echo", "/alpha", "/beta"];
    await waitFor(() => {
      expect(workflowNames()).toStrictEqual(expected);
    });
    click(button("Show all workflows"));
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
  click(button("Show all workflows"));
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

test("Persisted recency is isolated by user and workspace and ignores unavailable workflow ids", async () => {
  const workflows = mockWorkflows();
  const [zulu, , echo, , alpha] = workflows;
  if (!zulu || !echo || !alpha) {
    throw new Error("Expected workflow fixtures");
  }
  seedHistory(["deleted-workflow", echo.id]);
  seedHistory([zulu.id], "another-user");
  seedHistory([alpha.id], "test-user-123", "another-org");
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await openComposer();
  expect(workflowNames()).toStrictEqual([
    "/echo",
    "/alpha",
    "/beta",
    "/charlie",
  ]);
});

test("Recency leaves typed search order unchanged", async () => {
  const workflows = mockWorkflows();
  seedHistory(
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
      "/charlie",
      "/beta",
      "/delta",
      "/alpha",
    ]);
  });
});

test("Disabling anchored suggestions retains the original full workflow order", async () => {
  const workflows = mockWorkflows();
  seedHistory(
    [...workflows].reverse().map((workflow) => {
      return workflow.id;
    }),
  );
  mockChatLifecycle(context, { threadId: THREAD_ID });
  await openComposer(false);
  expect(workflowNames()).toStrictEqual([
    "/zulu",
    "/delta",
    "/echo",
    "/beta",
    "/alpha",
    "/charlie",
  ]);
});
