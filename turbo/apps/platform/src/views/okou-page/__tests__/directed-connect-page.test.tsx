import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  builtinConnectorOpenIdStartContract,
  builtinConnectorOauthStartContract,
  builtinConnectorManualGrantContract,
} from "@okouai/api-contracts/contracts/connectors";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetachedBrowserContext } from "happy-dom";
import { test, expect, vi } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  mockSavedConnectorAccounts,
  getConnectorAction,
  publicStatusItem,
} from "./connector-page-test-helpers.ts";
const context = testContext();
function accounts(read: () => ConnectorAccountConnection[]) {
  mockSavedConnectorAccounts(context, read);
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account = read().find((member) => {
        return member.id === params.connectionId;
      });
      return account
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "No such saved account" },
          });
    },
  );
}
function chatReturn(request: string) {
  const thread = crypto.randomUUID();
  const query = new URLSearchParams({
    threadId: thread,
    callbackPrompt: request,
    agentId: crypto.randomUUID(),
  });
  const deliveries: { threadId: string; prompt: string }[] = [];
  const acknowledge = createDeferredPromise<void>(context.signal);
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    if (!body.threadId || !body.prompt) {
      throw new Error("Chat continuation is missing its destination or prompt");
    }
    deliveries.push({ threadId: body.threadId, prompt: body.prompt });

    await acknowledge.promise;
    return respond(201, {
      threadId: body.threadId,
      createdAt: "2026-11-21T10:00:00Z",
    });
  });
  return {
    query,
    deliveries,
    expected: { threadId: thread, prompt: request },
    acknowledge,
  };
}
function enter(path: string) {
  return setupPage({
    context,
    host: "app.okou.ai",
    path,
  });
}
async function action(name: string) {
  const button = await waitFor(() => {
    return getConnectorAction("button", name);
  });
  await waitFor(() => {
    return expect(button).toBeEnabled();
  });
  click(button);
}
test("directed-connect-page-009 Steam OpenID on the connect route returns the requested prompt to its chat", async () => {
  const chat = chatReturn("Continue the Steam inventory report");
  const attempt = crypto.randomUUID();
  const account = connectorAccountFixture(
    { kind: "builtin", connectorSlug: "steam" },
    { authMethod: "openid" },
  );
  const approved = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    async ({ params, respond }) => {
      expect(params.attemptId).toBe(attempt);
      await approved.promise;
      return respond(200, { connectionId: account.id });
    },
  );
  accounts(() => {
    return approved.settled() ? [account] : [];
  });
  const loaded = createDeferredPromise<void>(context.signal);
  const provider = "https://steamcommunity.com/openid/login?session=" + attempt;
  context.mocks.api(
    builtinConnectorOpenIdStartContract.start,
    async ({ params, respond }) => {
      await loaded.promise;
      expect(params.connectorSlug).toBe("steam");
      return respond(200, {
        authorizationUrl: provider,
        oauthAttemptId: attempt,
      });
    },
  );
  context.mocks.http.get(provider, () => {
    return new Response("<button>Confirm Steam sign-in</button>", {
      headers: { "content-type": "text/html" },
    });
  });
  context.mocks.http.get(
    "https://app.okou.ai/connectors/steam/redirecting",
    () => {
      return new Response("<title>Opening Steam</title>", {
        headers: { "content-type": "text/html" },
      });
    },
  );
  // Happy DOM exposes a read-only opener. Production clears it before navigating.
  const nativeOpen = window.open.bind(window);
  vi.spyOn(window, "open").mockImplementation((...args) => {
    const popup = nativeOpen(...args);
    if (popup) {
      Object.defineProperty(popup, "opener", {
        value: null,
        writable: true,
        configurable: true,
      });
    }
    return popup;
  });
  const pages = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
  await enter("/connectors/steam/connect?" + chat.query.toString());
  await action("Connect");
  await waitFor(() => {
    return expect(
      pages.mock.results.at(-1)?.value.mainFrame.document.title,
    ).toBe("Opening Steam");
  });
  loaded.resolve();
  await waitFor(() => {
    return expect(pages.mock.results.at(-1)?.value.url).toBe(provider);
  });
  expect(chat.deliveries).toStrictEqual([]);
  const page = pages.mock.results.at(-1)?.value;
  if (!page) {
    throw new Error("Missing Steam page");
  }
  const confirm = await within(page.mainFrame.document.body).findByText(
    "Confirm Steam sign-in",
  );
  confirm.addEventListener(
    "click",
    () => {
      return approved.resolve();
    },
    { once: true },
  );
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("connector:changed"),
    ).toBeTruthy();
  });
  await userEvent.click(confirm);
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "steam" });
  await waitFor(() => {
    expect(chat.deliveries).toStrictEqual([chat.expected]);
  });
  chat.acknowledge.resolve();
  await expect(
    screen.findByText("Steam connected"),
  ).resolves.toBeInTheDocument();
  for (const { value } of pages.mock.results) {
    await value.close();
  }
  pages.mockRestore();
});
test.each([
  ["013", "Reconnect", "Resume the Axiom audit"],
  ["014", "Connect", "Continue to the new Axiom dataset"],
] as const)(
  "directed-connect-page-%s %s the selected Axiom account before continuing its chat",
  async (_id, actionName, prompt) => {
    const reconnect = actionName === "Reconnect";
    const work = connectorAccountFixture(
      { kind: "builtin", connectorSlug: "axiom" },
      { authMethod: "api-token", displayName: "Work", isDefault: !reconnect },
    );
    const personal = connectorAccountFixture(work.target, {
      authMethod: "api-token",
      displayName: "Personal",
    });
    const chat = chatReturn(prompt);
    let saved = false;
    accounts(() => {
      return reconnect ? [personal, work] : saved ? [work] : [];
    });
    const request = createDeferredPromise<void>(context.signal),
      save = createDeferredPromise<void>(context.signal);
    const writes: unknown[] = [];
    context.mocks.api(
      builtinConnectorManualGrantContract.connect,
      async ({ params, body, respond }) => {
        writes.push({ slug: params.connectorSlug, ...body });
        request.resolve();
        await save.promise;
        saved = true;
        return respond(200, { connectionId: work.id });
      },
    );
    const route = reconnect ? "/reconnect/" + work.id : "/connect";
    await enter("/connectors/axiom" + route + "?" + chat.query.toString());
    await action(actionName);
    const dialog = await screen.findByRole("dialog");
    const token = dialog.querySelector('input[type="password"]');
    if (!(token instanceof HTMLInputElement)) {
      throw new Error("Missing Axiom token field");
    }
    expect(within(dialog).getByText("API Token")).toBeInTheDocument();
    await userEvent.type(token, "test-axiom-input");
    click(getConnectorAction("button", "Save", dialog));
    await request.promise;
    expect(chat.deliveries).toStrictEqual([]);
    expect(writes).toStrictEqual([
      expect.objectContaining({
        slug: "axiom",
        authMethod: "api-token",
        values: { apiToken: "test-axiom-input" },
        account: reconnect
          ? { intent: "reconnect", connectionId: work.id }
          : { intent: "add" },
      }),
    ]);
    save.resolve();
    await waitFor(() => {
      expect(chat.deliveries).toStrictEqual([chat.expected]);
    });
    await expect(
      screen.findByText("Axiom connected successfully"),
    ).resolves.toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    chat.acknowledge.resolve();
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
  },
);
function githubMethods() {
  const github = publicStatusItem({
    connectorSlug: "github",
    label: "GitHub",
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: "Sign in",
        grantKind: "auth-code",
        supportsRefresh: true,
        startOptions: [],
        manualFields: [],
      },
      {
        id: "api-token",
        label: "API Token",
        description: "Use a saved token",
        grantKind: "manual",
        supportsRefresh: false,
        startOptions: [],
        manualFields: [
          {
            id: "token",
            label: "GitHub token",
            placeholder: "Enter your GitHub token",
            required: true,
            inputType: "password",
          },
        ],
      },
    ],
  });
  context.mocks.api(connectorCatalogContract.get, ({ respond }) => {
    return respond(200, { connector: github });
  });
}
test("directed-connect-page-011 The invalid saved GitHub token opens its missing credential field", async () => {
  const account = connectorAccountFixture(
    { kind: "builtin", connectorSlug: "github" },
    {
      authMethod: "api-token",
      connectionStatus: "reconnect-required",
      reconnectReason: "configuration_invalid",
      missingRequiredFields: ["token"],
    },
  );
  accounts(() => {
    return [account];
  });
  githubMethods();
  await enter("/connectors/github/connect");
  await action("Connect");
  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByText("Account status unavailable"),
  ).resolves.toBeInTheDocument();
  expect(within(dialog).queryByText("Connected", { exact: true })).toBeNull();
  expect(
    within(dialog).getByPlaceholderText("Enter your GitHub token"),
  ).toBeInTheDocument();
});

test("A Stripe credential connects before its originating chat continues", async () => {
  const chat = chatReturn("Resume my invoices");
  const account = connectorAccountFixture(
    { kind: "builtin", connectorSlug: "stripe" },
    { authMethod: "api-token" },
  );
  const grant = context.mocks.deferred<void>();
  const submitted = context.mocks.deferred<{ slug: string; method: string }>();
  accounts(() => {
    return grant.settled() ? [account] : [];
  });
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    async ({ params, body, respond }) => {
      submitted.resolve({
        slug: params.connectorSlug,
        method: body.authMethod,
      });
      await grant.promise;
      return respond(200, { connectionId: account.id });
    },
  );
  await enter("/connectors/stripe/connect?" + chat.query.toString());
  await action("Connect");
  const dialog = await screen.findByRole("dialog");
  const field = dialog.querySelector<HTMLInputElement>(
    'input[type="password"]',
  );
  if (!field) {
    throw new Error("Missing Stripe credential field");
  }
  await userEvent.type(field, "local-stripe-fixture");
  click(getConnectorAction("button", "Save", dialog));
  try {
    await expect(submitted.promise).resolves.toStrictEqual({
      slug: "stripe",
      method: "api-token",
    });
    expect(chat.deliveries).toStrictEqual([]);
    grant.resolve();
    await waitFor(() => {
      return expect(chat.deliveries).toStrictEqual([chat.expected]);
    });
    chat.acknowledge.resolve();
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
  } finally {
    if (!grant.settled()) {
      grant.resolve();
    }
    if (!chat.acknowledge.settled()) {
      chat.acknowledge.resolve();
    }
  }
});

test("The expired GitHub OAuth account offers reconnection without switching to token entry", async () => {
  const expired = connectorAccountFixture(
    { kind: "builtin", connectorSlug: "github" },
    {
      authMethod: "oauth",
      connectionStatus: "reconnect-required",
      reconnectReason: "credential_expired",
    },
  );
  const completed = context.mocks.deferred<void>();
  accounts(() => {
    return [
      completed.settled()
        ? { ...expired, connectionStatus: "connected", reconnectReason: null }
        : expired,
    ];
  });
  githubMethods();
  const target = context.mocks.deferred<unknown>();
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "about:blank" },
  });
  context.mocks.browser.open(authWindow);
  const destination = "https://github.example.test/authorize/dispatch";
  const attemptId = crypto.randomUUID();
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, respond }) => {
      target.resolve(body.account);
      return respond(200, {
        authorizationUrl: destination,
        oauthAttemptId: attemptId,
      });
    },
  );
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    async ({ params, respond }) => {
      expect(params.attemptId).toBe(attemptId);
      await completed.promise;
      return respond(200, { connectionId: expired.id });
    },
  );
  const originalAgent = crypto.randomUUID();
  await enter("/connectors/github/connect?agentId=" + originalAgent);
  await action("Connect");
  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByText("Connection expired"),
  ).resolves.toBeVisible();
  expect(
    within(dialog).queryByPlaceholderText("Enter your GitHub token"),
  ).toBeNull();
  click(getConnectorAction("button", "Reconnect", dialog));
  await expect(target.promise).resolves.toStrictEqual({
    intent: "reconnect",
    connectionId: expired.id,
  });
  await waitFor(() => {
    return expect(authWindow.location.href).toBe(destination);
  });
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("connector:changed"),
    ).toBeTruthy();
  });
  completed.resolve();
  context.mocks.ably.trigger("connector:changed", { connectorSlug: "github" });
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  authWindow.close();
});
