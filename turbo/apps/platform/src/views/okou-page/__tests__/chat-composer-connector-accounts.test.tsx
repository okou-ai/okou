import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  chatEventsContract,
  chatThreadsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import type { infer as zInfer } from "zod";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  builtinConnector,
  connectorAccount,
  SCOUT_AGENT_ID,
  createComposerConnectorHelpers,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

const GITHUB_SLUG = "github" as ConnectorSlug;

function githubTarget(): ConnectorAccountTarget {
  return { kind: "builtin", connectorSlug: GITHUB_SLUG };
}

async function loadComposer(): Promise<void> {
  await expect(findComposer()).resolves.toBeVisible();
  await expect(findFastControl("button", "Connectors")).resolves.toBeVisible();
}

async function openConnectors(
  container: ParentNode = document.body,
): Promise<void> {
  click(await findFastControl("button", "Connectors", container));
  await expect(
    findFastControl("button", "Add connectors"),
  ).resolves.toBeEnabled();
}

function enabledSendButton(): Promise<HTMLElement> {
  return waitFor(() => {
    const button = queryAllByRoleFast("button").find((candidate) => {
      return candidate.getAttribute("aria-label") === "Send";
    });
    if (!button) {
      throw new Error("Send button not found");
    }
    expect(button).toBeEnabled();
    return button;
  });
}

function githubAccounts(count = 2) {
  return Array.from({ length: count }, (_, index) => {
    const names = ["Work", "Personal", "Client", "Research", "Open Source"];
    return connectorAccount({
      id: `f0000000-0000-4000-a000-${(index + 91)
        .toString()
        .padStart(12, "0")}`,
      target: githubTarget(),
      displayName: names[index] ?? `Account ${index + 1}`,
      isDefault: index === 0,
    });
  });
}

function pendingChatAccess(accounts: ReturnType<typeof githubAccounts>) {
  return {
    target: githubTarget(),
    available: true,
    currentConnectionId: accounts[1]!.id,
    accounts: accounts.map((account, index) => {
      return {
        connectionId: account.id,
        displayName: account.displayName,
        isDefault: account.isDefault,
        defaultEnabled: true,
        overrideEnabled: index === 0 ? false : null,
        enabled: index > 0,
      };
    }),
  };
}

async function choosePersonalAccount(user: ReturnType<typeof userEvent.setup>) {
  click(await findFastControl("button", /GitHub.*accounts/u));
  const work = await screen.findByRole("switch", { name: "Work access" });
  await user.click(work);
  await waitFor(() => {
    expect(work).not.toBeChecked();
  });
  await user.keyboard("{Escape}{Escape}");
}

test.each([false, true])(
  "An unavailable account keeps the new-chat draft and attachments (edited while creating: %s)",
  async (editWhileCreating) => {
    const user = userEvent.setup({ delay: null });
    const accounts = githubAccounts();
    installComposerConnectorFixture({
      catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
      accounts,
    });
    const started = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    const createRequests: zInfer<typeof chatThreadsContract.create.body>[] = [];
    const sends: ChatEventSendBody[] = [];
    const clearedDrafts: unknown[] = [];
    const message =
      "The selected GitHub account is unavailable. Review the Chat account access and try again.";
    const overrides: {
      threadId: string;
      connectionId: string;
      enabled: boolean | null;
    }[] = [];
    context.mocks.api(
      chatConnectorAccessContract.setThreadOverride,
      async ({ params, body, respond }) => {
        overrides.push({
          threadId: params.threadId,
          connectionId: params.connectionId,
          enabled: body.enabled,
        });
        if (overrides.length === 1) {
          started.resolve();
          await release.promise;
          return respond(404, {
            error: { code: "NOT_FOUND", message },
          });
        }
        return respond(200, pendingChatAccess(accounts));
      },
    );
    context.mocks.api(
      chatConnectorAccessContract.setThreadCurrent,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          target: githubTarget(),
          connectionId: accounts[1]!.id,
        });
        return respond(200, pendingChatAccess(accounts));
      },
    );
    context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
      createRequests.push(body);
      if (!body.clientThreadId) {
        throw new Error("Expected a client thread ID");
      }
      return respond(201, {
        id: body.clientThreadId,
        title: null,
        selectedModel: body.model ?? null,
        serviceTier: body.serviceTier ?? null,
        createdAt: "2026-10-27T00:00:00Z",
      });
    });
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      sends.push(body);
      if (!body.threadId) {
        throw new Error("Expected a created chat thread");
      }
      return respond(201, {
        threadId: body.threadId,
        createdAt: "2026-10-27T00:00:00Z",
      });
    });
    context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
      if (body.draftUserMessage === null) {
        clearedDrafts.push(body);
      }
      return respond(204);
    });
    const filename = "account-selection-notes.txt";
    context.mocks.upload.success({
      id: "f0000000-0000-4000-a000-000000000951",
      filename,
      contentType: "text/plain",
      size: 5,
      url: "https://files.example.test/account-selection-notes.txt",
    });

    const newChatPath = `/agents/${SCOUT_AGENT_ID}/chat`;
    await setupPage({ context, path: newChatPath, locale: "en-US" });
    await loadComposer();
    await openConnectors();
    await choosePersonalAccount(user);
    const composer = await findComposer();
    await fill(composer, "Use my personal GitHub account");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("Expected a composer file input");
    }
    await user.upload(
      fileInput,
      new File(["notes"], filename, { type: "text/plain" }),
    );
    await screen.findByText(filename);
    click(await enabledSendButton());
    await started.promise;
    const retainedPrompt = editWhileCreating
      ? "Keep this newer message while creation is pending"
      : "Use my personal GitHub account";
    if (editWhileCreating) {
      await fill(composer, retainedPrompt);
    }
    release.resolve();
    await screen.findByText(message);

    expect(window.location.pathname).toBe(newChatPath);
    expect(composer).toHaveTextContent(retainedPrompt);
    expect(screen.getByText(filename)).toBeInTheDocument();
    expect(sends).toHaveLength(0);
    expect(clearedDrafts).toHaveLength(0);
    click(await enabledSendButton());
    await waitFor(() => {
      expect(sends).toHaveLength(1);
      expect(window.location.pathname).toBe(
        `/chats/${createRequests[1]!.clientThreadId}`,
      );
    });
    expect(overrides).toStrictEqual(
      createRequests.map((request) => {
        return {
          threadId: request.clientThreadId,
          connectionId: accounts[0]!.id,
          enabled: false,
        };
      }),
    );
    expect(sends[0]).toMatchObject({
      prompt: retainedPrompt,
      userMessage: {
        parts: expect.arrayContaining([
          expect.objectContaining({ type: "file", filenameSnapshot: filename }),
        ]),
      },
    });
  },
);

test("Resending an unconfirmed creation reuses its chat and event identities", async () => {
  const user = userEvent.setup({ delay: null });
  const accounts = githubAccounts();
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: GITHUB_SLUG, label: "GitHub" })],
    accounts,
  });
  context.mocks.api(
    chatConnectorAccessContract.setThreadOverride,
    ({ respond }) => {
      return respond(200, pendingChatAccess(accounts));
    },
  );
  context.mocks.api(
    chatConnectorAccessContract.setThreadCurrent,
    ({ respond }) => {
      return respond(200, pendingChatAccess(accounts));
    },
  );
  const creates: zInfer<typeof chatThreadsContract.create.body>[] = [];
  const sends: ChatEventSendBody[] = [];
  const message = "The create response was interrupted. Please try again.";
  context.mocks.http.post("*/api/chat-threads", async ({ request }) => {
    const body = chatThreadsContract.create.body.parse(await request.json());
    creates.push(body);
    if (creates.length === 1) {
      // A failure after database commit does not establish that creation failed.
      return Response.json(
        { error: { code: "INTERNAL_ERROR", message } },
        { status: 500 },
      );
    }
    return Response.json(
      {
        id: body.clientThreadId,
        title: null,
        selectedModel: body.model ?? null,
        serviceTier: body.serviceTier ?? null,
        createdAt: "2026-10-27T00:00:00Z",
      },
      { status: 201 },
    );
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    sends.push(body);
    if (!body.threadId) {
      throw new Error("Expected a created thread ID");
    }
    return respond(201, {
      threadId: body.threadId,
      createdAt: "2026-10-27T00:00:00Z",
    });
  });

  const newChatPath = `/agents/${SCOUT_AGENT_ID}/chat`;
  await setupPage({ context, path: newChatPath, locale: "en-US" });
  await loadComposer();
  await openConnectors();
  await choosePersonalAccount(user);
  const composer = await findComposer();
  await fill(composer, "Use my personal GitHub account");
  click(await enabledSendButton());
  await screen.findByText(message);
  expect(window.location.pathname).toBe(newChatPath);
  expect(composer).toHaveTextContent("Use my personal GitHub account");
  expect(sends).toHaveLength(0);

  click(await enabledSendButton());
  await waitFor(() => {
    expect(sends).toHaveLength(1);
    expect(window.location.pathname).toBe(
      `/chats/${creates[0]!.clientThreadId}`,
    );
  });
  expect(creates).toHaveLength(2);
  expect(creates[1]).toStrictEqual(creates[0]);
});
