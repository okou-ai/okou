import { cleanup, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatThreadDraftContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const firstPage = createTestRuntime(context);
const nextPage = createTestRuntime(context);
const PROJECT_ID = "30000000-0000-4000-8000-000000000071";
const CREATED_AT = "2026-11-02T00:00:00.000Z";

function installWorkspace() {
  const thread = continuityThread(121, 1, "Planning conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 121,
    threads: [thread],
  });
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  return {
    ...workspace.pageOptions,
    path: `/chats/${thread.id}`,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
    sharedWorkerTestTransport: "message-port" as const,
  };
}

function snapshot(name = "Launch", seqId = 1) {
  return {
    projects: [
      { id: PROJECT_ID, name, createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ],
    latestEventId: null,
    latestSeqId: seqId,
  };
}

function renamed(seqId: number, name: string) {
  return {
    id: `30000000-0000-4000-8000-${seqId.toString().padStart(12, "0")}`,
    seqId,
    projectId: PROJECT_ID,
    kind: "renamed" as const,
    name,
    createdAt: CREATED_AT,
  };
}

function installMetadata() {
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, snapshot());
  });
  context.mocks.api(projectsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
}

function disposeFirstPage() {
  firstPage.dispose();
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
}

test("Projects load and catch up on a browser without Symbol.dispose", async () => {
  const options = installWorkspace();
  installMetadata();
  const nativeSymbol = Symbol;
  const descriptors = Object.fromEntries(
    Object.entries(Object.getOwnPropertyDescriptors(nativeSymbol)).filter(
      ([key]) => {
        return key !== "dispose" && key !== "asyncDispose";
      },
    ),
  );
  const browserSymbol = Object.defineProperties(function Symbol(
    description?: string | number,
  ) {
    return nativeSymbol(description);
  }, descriptors);
  vi.stubGlobal("Symbol", browserSymbol);
  context.mocks.api(projectsContract.events, ({ query, respond }) => {
    return query.sinceSeqId === 1
      ? respond(200, { events: [renamed(2, "Launch draft")], hasMore: true })
      : respond(200, { events: [renamed(3, "Launch ready")], hasMore: false });
  });

  await setupPage({ context, ...options });

  const list = screen.getByTestId("sidebar-chat-threads-virtual-list");
  expect(within(list).getByText("Launch ready")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
});

test("An empty cached chat list discovers a newly published snapshot", async () => {
  const options = installWorkspace();
  installMetadata();
  const thread = continuityThread(121, 1, "Planning conversation");
  let published = false;
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: published ? [thread] : [],
        latestEventId: published
          ? "30000000-0000-4000-8000-000000000005"
          : null,
        latestSeqId: published ? 5 : null,
      }),
    );
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  await setupPage({
    context,
    ...options,
    path: `/agents/${thread.agentId}/chat`,
    cachedChatThreadEvents: {
      snapshot: { chatThreads: [], latestEventId: null, latestSeqId: null },
      events: [],
    },
  });
  expect(screen.getByText("Launch")).toBeInTheDocument();

  published = true;
  context.mocks.ably.trigger("threadListChanged");

  await expect(
    screen.findByText("Planning conversation"),
  ).resolves.toBeInTheDocument();
});

test.each(["open", "read", "write"] as const)(
  "Projects remain available online when IndexedDB cannot %s",
  async (operation) => {
    const options = installWorkspace();
    installMetadata();
    if (operation === "open") {
      vi.spyOn(indexedDB, "open").mockImplementation(() => {
        throw new DOMException("Browser storage disabled", "SecurityError");
      });
    } else {
      const transaction = IDBDatabase.prototype.transaction;
      vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(
        function (this: IDBDatabase, names, mode, settings) {
          if (mode === (operation === "read" ? "readonly" : "readwrite")) {
            throw new DOMException(
              "Browser storage unavailable",
              operation === "read" ? "InvalidStateError" : "QuotaExceededError",
            );
          }
          return transaction.call(this, names, mode, settings);
        },
      );
    }

    await setupPage({ context, ...options });

    expect(
      within(screen.getByTestId("sidebar-chat-threads-virtual-list")).getByText(
        "Launch",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
  },
);

test("Projects restore persisted events before an expired cursor is rebuilt", async () => {
  const options = installWorkspace();
  installMetadata();
  context.mocks.api(projectsContract.events, ({ respond }) => {
    return respond(200, {
      events: [renamed(2, "Launch ready")],
      hasMore: false,
    });
  });
  await setupPage({ context: firstPage, ...options });
  expect(screen.getByText("Launch ready")).toBeInTheDocument();
  disposeFirstPage();

  const resume = context.mocks.deferred<void>();
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, snapshot("Launch restored", 5));
  });
  context.mocks.api(projectsContract.events, async ({ query, respond }) => {
    await resume.promise;
    return query.sinceSeqId === 2
      ? respond(410, {
          error: {
            code: "PROJECT_EVENTS_EXPIRED",
            message: "Refresh snapshot",
          },
        })
      : respond(200, { events: [], hasMore: false });
  });
  const page = await startPage({ context: nextPage, ...options });
  await page.content;
  await expect(screen.findByText("Launch ready")).resolves.toBeInTheDocument();

  resume.resolve();
  await page.ready;
  await expect(
    screen.findByText("Launch restored"),
  ).resolves.toBeInTheDocument();
});

test.each(["account", "workspace"] as const)(
  "Project cache stays private when another %s opens the same browser",
  async (scope) => {
    const options = installWorkspace();
    installMetadata();
    await setupPage({ context: firstPage, ...options });
    expect(screen.getByText("Launch")).toBeInTheDocument();
    disposeFirstPage();

    const requested = context.mocks.deferred<void>();
    const resume = context.mocks.deferred<void>();
    context.mocks.api(projectsContract.snapshot, async ({ respond }) => {
      if (!requested.settled()) {
        requested.resolve();
      }
      await resume.promise;
      return respond(200, snapshot("Other owner's Project"));
    });
    const auth = options.auth;
    const page = await startPage({
      context: nextPage,
      ...options,
      auth: {
        ...auth,
        ...(scope === "account"
          ? { user: { ...auth.user, id: "other-project-cache-user" } }
          : {
              organization: {
                activeOrg: {
                  id: "other-project-cache-org",
                  name: "Other workspace",
                },
                memberships: [{ id: "other-project-cache-org" }],
              },
            }),
      },
    });
    await page.content;
    await requested.promise;
    expect(screen.queryByText("Launch")).not.toBeInTheDocument();

    resume.resolve();
    await page.ready;
    await expect(
      screen.findByText("Other owner's Project"),
    ).resolves.toBeInTheDocument();
  },
);
