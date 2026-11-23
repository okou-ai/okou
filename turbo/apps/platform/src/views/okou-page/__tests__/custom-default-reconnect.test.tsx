import { DetachedBrowserContext } from "happy-dom";
import {
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";

import { expect, test, vi } from "vitest";
import {
  click,
  setupPage,
  startPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  customConnector,
  customConnectorAccount,
  mockCustomConnectorStory,
  mockOAuthCompletions,
  mockSavedConnectorAccounts,
  getConnectorCard,
} from "./connector-page-test-helpers.ts";
const context = testContext(),
  path = "/connectors?scope=custom",
  label = "Harbor Records";
function records() {
  return customConnector({ slug: "_harbor-records", displayName: label });
}
function accountChanges() {
  const changed = new Map<string, unknown>();
  context.mocks.api(
    customConnectorValuesContract.set,
    ({ params, body, respond }) => {
      changed.set(params.id, body.account);
      return respond(400, {
        error: {
          code: "UNEXPECTED_CHANGE",
          message: "Unexpected account update",
        },
      });
    },
  );
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ params, body, respond }) => {
      changed.set(params.id, body.account);
      return respond(400, {
        error: {
          code: "UNEXPECTED_CHANGE",
          message: "Unexpected account authorization",
        },
      });
    },
  );
  return changed;
}
test("custom-default-reconnect-004 the inventory gates Connect until an empty account list settles", async () => {
  const connector = records();
  mockCustomConnectorStory(context, [{ connector }]);
  const changed = accountChanges(),
    gate = context.mocks.deferred<void>(),
    asked = context.mocks.deferred<void>();
  mockSavedConnectorAccounts(context, async () => {
    if (!asked.settled()) {
      asked.resolve();
    }
    await gate.promise;
    return [];
  });
  const app = await startPage({ context, path });
  await asked.promise;
  await screen.findByText(label);
  const before = queryFastControl("button", "Connect " + label);
  expect(before).toBeNull();
  gate.resolve();
  await app.ready;
  await screen.findByText(label);
  const card = getConnectorCard(label);
  const button = await findFastControl("button", "Connect " + label, card);
  expect(button).toBeEnabled();
  expect(card).toHaveTextContent(/no accounts|not connected|0 accounts/i);
  expect(changed.has(connector.id)).toBeFalsy();
});
test("custom-default-reconnect-003 replacing the default secret keeps the healthy sibling on its own account", async () => {
  const connector = records(),
    primary = customConnectorAccount(connector.id, {
      displayName: "Harbor Main",
    }),
    sibling = customConnectorAccount(connector.id, {
      displayName: "Harbor Archive",
      isDefault: false,
    });
  mockCustomConnectorStory(context, [{ connector, account: primary }]);
  mockSavedConnectorAccounts(context, () => {
    return [primary, sibling];
  });
  const saved = context.mocks.deferred<unknown>();
  context.mocks.api(customConnectorValuesContract.set, ({ body, respond }) => {
    saved.resolve(body);
    return respond(200, { ...connector, connectionId: primary.id });
  });
  await setupPage({
    context,
    path: "/connectors/" + connector.slug + "/connect",
  });
  click(await findFastControl("button", "Reconnect"));
  const dialog = await screen.findByRole("dialog");
  const secret = await within(dialog).findByLabelText("Secret", {
    exact: false,
  });
  await fill(secret, "local-replacement");
  click(await findFastControl("button", /save|connect/i, dialog));
  await expect(saved.promise).resolves.toMatchObject({
    account: { intent: "reconnect", connectionId: primary.id },
    values: [{ key: "secret", value: "local-replacement" }],
  });
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
});
const provider = "https://provider.example.test/consent/local",
  oauthPath = "/connectors/_harbor-records/connect";
function providerSetup() {
  return customConnector({
    slug: "_harbor-records",
    displayName: label,
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "local-client",
      authorizationUrl: provider,
      tokenUrl: "https://provider.example.test/token",
      tokenEndpointAuthMethod: "client_secret_basic",
      pkceMethod: "S256",
      scopes: [],
      authorizationParams: {},
    },
  });
}
async function connect() {
  click(await findFastControl("button", "Connect"));
  return await screen.findByRole("dialog");
}
test("custom-default-reconnect-009 a saved account without a default explains why provider authorization cannot proceed", async () => {
  const definition = providerSetup(),
    orphan = customConnectorAccount(definition.id, {
      authMethod: "oauth",
      displayName: "Archive",
      isDefault: false,
    }),
    popup = context.mocks.browser.authWindow();
  Object.defineProperty(popup, "location", { value: { href: "about:blank" } });
  context.mocks.browser.open(popup);
  mockCustomConnectorStory(context, [{ connector: definition }]);
  mockSavedConnectorAccounts(context, () => {
    return [orphan];
  });
  const changed = accountChanges();
  await setupPage({ context, path: oauthPath });
  const dialog = await connect();
  click(await findFastControl("button", "Continue", dialog));
  await expect(
    screen.findByText(/saved accounts.*no default|no default.*saved account/i),
  ).resolves.toBeVisible();
  expect(popup.closed).toBeTruthy();
  expect(popup.location.href).toBe("about:blank");
  expect(changed.has(definition.id)).toBeFalsy();
});

test("custom-default-reconnect-006 closing the provider tab releases the first-account consent action", async () => {
  const service = providerSetup();
  mockCustomConnectorStory(context, [{ connector: service }]);
  mockSavedConnectorAccounts(context, () => {
    return [];
  });
  mockOAuthCompletions(context);
  context.mocks.http.get(provider, () => {
    return new Response("<title>Provider consent</title>", {
      headers: { "Content-Type": "text/html" },
    });
  });
  const intent = context.mocks.deferred<unknown>();
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ body, respond }) => {
      intent.resolve(body.account);
      return respond(200, {
        result: "authorization",
        authorizationUrl: provider,
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  await setupPage({ context, path: oauthPath });
  const prompt = await connect();
  const proceed = await findFastControl("button", "Continue", prompt);
  const pages = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
  const nativeOpen = window.open.bind(window);
  vi.spyOn(window, "open").mockImplementation((url, target, features) => {
    const child = nativeOpen(url, target, features);
    // Happy DOM exposes opener as getter-only. Browsers allow removing it.
    const page = pages.mock.results.at(-1)?.value;
    if (child && page) {
      Object.defineProperty(child, "opener", {
        value: child.opener,
        writable: true,
        configurable: true,
      });
      // The WindowProxy stays open across document replacement until its page closes.
      return new Proxy(child, {
        get(documentWindow, property) {
          if (property === "closed") {
            return page.closed;
          }
          if (property === "close") {
            return documentWindow.close.bind(documentWindow);
          }
          return Reflect.get(documentWindow, property, documentWindow);
        },
      });
    }
    return child;
  });
  click(proceed);
  await waitFor(() => {
    return expect(intent.settled()).toBeTruthy();
  });
  await expect(intent.promise).resolves.toMatchObject({ intent: "add" });
  const tab = pages.mock.results.at(-1)?.value;
  if (!tab) {
    throw new Error("Authorization did not open a browser tab");
  }
  try {
    await waitFor(() => {
      return expect(tab.url).toBe(provider);
    });
    await waitFor(() => {
      return expect(
        within(prompt).getByText(/connecting/i, { selector: "button" }),
      ).toBeDisabled();
    });
  } finally {
    await tab.close();
  }
  await expect(
    findFastControl("button", "Continue", prompt),
  ).resolves.toBeEnabled();
});
