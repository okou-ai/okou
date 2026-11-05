import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { connectedConnectorsContract } from "@okouai/api-contracts/contracts/connected-connectors";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  builtinConnector,
  connectorAccount,
  chatConnectorOverviewFixture,
  createComposerConnectorHelpers,
  httpConnector,
  ACME_CONNECTOR_ID,
  SCOUT_THREAD_ID,
  SCOUT_AGENT_ID,
} from "./chat-composer-connectors-test-helpers.ts";
import {
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installComposerConnectorFixture } =
  createComposerConnectorHelpers(context);

function fixture(count: number) {
  const accounts = Array.from({ length: count }, (_, index) => {
    return connectorAccount({
      id: `f0000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`,
      target: {
        kind: "builtin",
        connectorSlug: connectorSlugSchema.parse(
          `probe-${String(index + 1).padStart(2, "0")}`,
        ),
      },
      displayName: `Account ${index + 1}`,
      isDefault: true,
    });
  });
  const catalog = accounts.map((_account, index) => {
    return builtinConnector({
      slug: connectorSlugSchema.parse(
        `probe-${String(index + 1).padStart(2, "0")}`,
      ),
      label: `Probe ${index + 1}`,
    });
  });
  installComposerConnectorFixture({ catalog, accounts });
  const entries = catalog.map((connector) => {
    return chatConnectorOverviewFixture({
      target: { kind: "builtin", connectorSlug: connector.slug },
      label: connector.label,
      icon: connector.icon,
      accounts,
    });
  });
  return { entries, accounts };
}

async function setup(
  draft = false,
  sharedWorkerTestTransport: "direct" | "message-port" = "direct",
) {
  await setupPage({
    context,
    path: draft
      ? `/agents/${SCOUT_AGENT_ID}/chat`
      : `/chats/${SCOUT_THREAD_ID}`,
    locale: "en-US",
    sharedWorkerTestTransport,
    featureSwitches: { [FeatureSwitchKey.ConnectorChatAccountAccess]: true },
  });
  await findComposer();
}

async function openMenu() {
  click(await findFastControl("button", "Connectors"));
  return await screen.findByRole("dialog", { name: "Connectors" });
}

test.each([false, true])(
  "Load 20 connectors once and reuse the Chat cache on reopening (draft=%s)",
  async (draft) => {
    const { entries } = fixture(20);
    let full = 0;
    let target = 0;
    let oldReads = 0;
    context.mocks.api(
      chatConnectorAccessContract.overview,
      ({ query, respond }) => {
        expect(query.threadId).toBe(draft ? undefined : SCOUT_THREAD_ID);
        full += 1;
        return respond(200, entries);
      },
    );
    context.mocks.api(
      chatConnectorAccessContract.overviewTarget,
      ({ respond }) => {
        target += 1;
        return respond(200, { connector: entries[0] });
      },
    );
    context.mocks.api(connectedConnectorsContract.list, ({ respond }) => {
      oldReads += 1;
      return respond(200, { builtinConnectors: [], customConnectors: [] });
    });
    context.mocks.api(
      chatConnectorAccessContract.getThread,
      async ({ never }) => {
        oldReads += 1;
        return await never();
      },
    );
    context.mocks.api(
      chatConnectorAccessContract.accountDefaults,
      async ({ never }) => {
        oldReads += 1;
        return await never();
      },
    );
    context.mocks.api(
      connectorAccountsContract.connection,
      async ({ never }) => {
        oldReads += 1;
        return await never();
      },
    );
    const popup = await openAfterSetup(draft);
    await waitFor(() => {
      return expect(
        queryAllByRoleFast("button", popup).filter((button) => {
          return button.textContent?.includes("Probe ");
        }),
      ).toHaveLength(20);
    });
    expect({ full, target, oldReads }).toStrictEqual({
      full: 1,
      target: 0,
      oldReads: 0,
    });
    click(await findFastControl("button", "Connectors"));
    await waitFor(() => {
      return expect(
        screen.queryByRole("dialog", { name: "Connectors" }),
      ).toBeNull();
    });
    const reopened = await openMenu();
    await waitFor(() => {
      return expect(
        queryAllByRoleFast("button", reopened).filter((button) => {
          return button.textContent?.includes("Probe ");
        }),
      ).toHaveLength(20);
    });
    expect({ full, target, oldReads }).toStrictEqual({
      full: 1,
      target: 0,
      oldReads: 0,
    });
  },
);

async function openAfterSetup(
  draft = false,
  transport: "direct" | "message-port" = "direct",
) {
  await setup(draft, transport);
  return await openMenu();
}

test("Patch only the notified target while closed and fully calibrate after lost continuity", async () => {
  const { entries } = fixture(2);
  let full = 0;
  let targets = 0;
  let changed = entries[0];
  let removed = false;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    full += 1;
    return respond(200, removed ? [entries[1]] : [changed, entries[1]]);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        kind: "builtin",
        connectorSlug: "probe-01",
        threadId: SCOUT_THREAD_ID,
      });
      targets += 1;
      return respond(200, { connector: removed ? null : changed });
    },
  );
  // Exercise Ably channel continuity through the production worker protocol.
  await openAfterSetup(false, "message-port");
  await findFastControl("button", "Probe 1Account 11 enabled");
  click(await findFastControl("button", "Connectors"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Connectors" }),
    ).toBeNull();
  });
  changed = {
    ...changed,
    accounts: changed.accounts.map((account) => {
      return {
        ...account,
        displayName: "Renamed account",
      };
    }),
  };
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "probe-01",
  });
  await waitFor(() => {
    return expect(targets).toBe(1);
  });
  const reopened = await openMenu();
  await waitFor(() => {
    return expect(reopened).toHaveTextContent("Renamed account");
  });
  expect(full).toBe(1);
  removed = true;
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "probe-01",
  });
  await waitFor(() => {
    return expect({
      full,
      targets,
      rows: queryAllByRoleFast("button", reopened).filter((button) => {
        return button.textContent?.includes("Probe ");
      }).length,
    }).toStrictEqual({ full: 1, targets: 2, rows: 1 });
  });
  expect({ full, targets }).toStrictEqual({ full: 1, targets: 2 });
  context.mocks.ably.triggerConnectionState("suspended");
  context.mocks.ably.triggerConnectionState("connected");
  // Thread and connector subscriptions can each recalibrate after lost
  // continuity, so wait for a full read rather than a transient count.
  await waitFor(() => {
    return expect(full).toBeGreaterThan(1);
  });
  await findFastControl("button", "Probe 2Account 21 enabled");
});

test("Discard an older target response after a Run invalidates the full snapshot", async () => {
  const { entries } = fixture(1);
  let current = entries[0];
  const staleStarted = createDeferredPromise<void>(context.signal);
  const releaseStale = createDeferredPromise<void>(context.signal);
  const nextStarted = createDeferredPromise<void>(context.signal);
  const releaseNext = createDeferredPromise<void>(context.signal);
  let targetReads = 0;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [current]);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    async ({ respond }) => {
      targetReads += 1;
      if (targetReads === 1) {
        staleStarted.resolve();
        await releaseStale.promise;
        return respond(200, { connector: entries[0] });
      }
      nextStarted.resolve();
      await releaseNext.promise;
      return respond(200, { connector: current });
    },
  );
  const popup = await openAfterSetup();
  await findFastControl("button", "Probe 1Account 11 enabled");
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "probe-01",
  });
  await staleStarted.promise;
  current = {
    ...current,
    accounts: current.accounts.map((account) => {
      return {
        ...account,
        displayName: "Run-selected name",
      };
    }),
  };
  context.mocks.ably.trigger(`chatThreadDetailChanged:${SCOUT_THREAD_ID}`);
  await waitFor(() => {
    return expect(popup).toHaveTextContent("Run-selected name");
  });
  releaseStale.resolve();
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "probe-01",
  });
  await nextStarted.promise;
  click(await findFastControl("button", "Connectors"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Connectors" }),
    ).toBeNull();
  });
  const reopened = await openMenu();
  await waitFor(() => {
    return expect(reopened).toHaveTextContent("Run-selected name");
  });
  releaseNext.resolve();
});

test("Retry a failed initial overview without keeping an unusable cached request", async () => {
  const { entries } = fixture(1);
  let full = 0;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    full += 1;
    return full === 1
      ? respond(503, {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Catalog unavailable",
          },
        })
      : respond(200, entries);
  });
  const popup = await openAfterSetup();
  click(await findFastControl("button", "Try again", popup));
  await findFastControl("button", "Probe 1Account 11 enabled", popup);
  expect(full).toBe(2);
});

test("Recover from an initial subscription failure through the overview retry", async () => {
  const { entries } = fixture(1);
  let full = 0;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    full += 1;
    return respond(200, entries);
  });
  const rejected = context.mocks.ably.rejectSubscribe(
    "connector:changed",
    "Subscription unavailable",
  );
  const popup = await openAfterSetup(false, "message-port");
  await rejected;
  const retry = await findFastControl("button", "Try again", popup);
  expect(full).toBe(0);
  click(retry);
  await findFastControl("button", "Probe 1Account 11 enabled", popup);
  expect(full).toBe(1);
});

test("Expose a failed target refresh and keep notifications working after retry", async () => {
  const { entries } = fixture(2);
  let current = entries[0];
  let full = 0;
  let targets = 0;
  let fail = true;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    full += 1;
    return respond(200, [current, entries[1]]);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ query, respond }) => {
      targets += 1;
      if (query.kind === "builtin" && query.connectorSlug === "probe-02") {
        return respond(200, { connector: entries[1] });
      }
      return fail
        ? respond(503, {
            error: {
              code: "PROVIDER_UNAVAILABLE",
              message: "Catalog unavailable",
            },
          })
        : respond(200, { connector: current });
    },
  );
  const popup = await openAfterSetup(false, "message-port");
  await findFastControl("button", "Probe 1Account 11 enabled", popup);
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "probe-01",
  });
  await findFastControl("button", "Try again", popup);
  expect(popup).toHaveTextContent("Account 1");
  expect({ full, targets }).toStrictEqual({ full: 1, targets: 1 });
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "probe-02",
  });
  await waitFor(() => {
    return expect(targets).toBe(2);
  });
  await findFastControl("button", "Probe 2Account 21 enabled", popup);
  const retry = await findFastControl("button", "Try again", popup);
  fail = false;
  click(retry);
  await findFastControl("button", "Probe 1Account 11 enabled", popup);
  await waitFor(() => {
    return expect(
      queryAllByRoleFast("button", popup).some((button) => {
        return button.textContent === "Try again";
      }),
    ).toBeFalsy();
  });
  expect(full).toBe(2);
  current = {
    ...current,
    accounts: current.accounts.map((account) => {
      return { ...account, displayName: "Updated after recovery" };
    }),
  };
  context.mocks.ably.trigger("connector:changed", {
    connectorSlug: "probe-01",
  });
  await findFastControl(
    "button",
    "Probe 1Updated after recovery1 enabled",
    popup,
  );
  expect({ full, targets }).toStrictEqual({ full: 2, targets: 3 });
});

test("Load full readiness only for an opened panel's selected off-page account", async () => {
  const target = { kind: "builtin", connectorSlug: "github" } as const;
  const work = connectorAccount({
    id: "f0000000-0000-4000-a000-000000000091",
    target,
    displayName: "Work",
    isDefault: true,
  });
  const selected = {
    ...connectorAccount({
      id: "f0000000-0000-4000-a000-000000000092",
      target,
      displayName: "Off-page current",
      isDefault: false,
    }),
    connectionStatus: "reconnect-required" as const,
    reconnectReason: "credential_expired" as const,
  };
  installComposerConnectorFixture({
    catalog: [builtinConnector({ slug: "github", label: "GitHub" })],
    accounts: [work, selected],
  });
  const entry = chatConnectorOverviewFixture({
    target,
    label: "GitHub",
    accounts: [work, selected],
  });
  let details = 0;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    return respond(200, [{ ...entry, currentConnectionId: selected.id }]);
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, {
      connections: [work],
      nextCursor: "next-page",
      defaultConnection: work,
    });
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      expect(params.connectionId).toBe(selected.id);
      details += 1;
      return respond(200, selected);
    },
  );
  const popup = await openAfterSetup();
  const row = await findFastControl(
    "button",
    "GitHubOff-page current2 enabled",
    popup,
  );
  expect(details).toBe(0);
  click(row);
  const radio = await findFastControl("radio", "Off-page current", popup);
  expect(radio).toHaveAttribute("aria-disabled", "true");
  expect(radio).toBeChecked();
  expect(details).toBe(1);
});

test("Release the cached subscription on navigation and reload the returning Chat", async () => {
  const { entries } = fixture(1);
  let full = 0;
  let targets = 0;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    full += 1;
    return respond(200, entries);
  });
  context.mocks.api(
    chatConnectorAccessContract.overviewTarget,
    ({ respond }) => {
      targets += 1;
      return respond(200, { connector: entries[0] });
    },
  );
  await openAfterSetup();
  await findFastControl("button", "Probe 1Account 11 enabled");
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", "New chat"));
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/agents/${SCOUT_AGENT_ID}/chat`);
  });
  await findComposer();
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("connector:changed"),
    ).toBeFalsy();
  });
  window.history.back();
  await waitFor(() => {
    expect(window.location.pathname).toBe(`/chats/${SCOUT_THREAD_ID}`);
  });
  await findComposer();
  const reopened = await openMenu();
  await findFastControl("button", "Probe 1Account 11 enabled", reopened);
  expect({ full, targets }).toStrictEqual({ full: 2, targets: 0 });
});

test("Calibrate custom account changes on focus while keeping ordinary reopenings cached", async () => {
  const target = {
    kind: "custom",
    customConnectorId: ACME_CONNECTOR_ID,
  } as const;
  let accounts = [
    connectorAccount({
      id: "f0000000-0000-4000-a000-000000000093",
      target,
      displayName: "Before external change",
      isDefault: true,
    }),
  ];
  installComposerConnectorFixture({
    customConnectors: [
      httpConnector({
        id: ACME_CONNECTOR_ID,
        slug: "cached-custom",
        displayName: "Cached custom",
        hasAccount: true,
        authMode: "none",
      }),
    ],
    accounts,
  });
  let full = 0;
  context.mocks.api(chatConnectorAccessContract.overview, ({ respond }) => {
    full += 1;
    return respond(200, [
      chatConnectorOverviewFixture({
        target,
        label: "Cached custom",
        accounts,
      }),
    ]);
  });
  const popup = await openAfterSetup();
  await findFastControl(
    "button",
    "CCached customBefore external change1 enabled",
    popup,
  );
  click(await findFastControl("button", "Connectors"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Connectors" }),
    ).toBeNull();
  });
  accounts = accounts.map((account) => {
    return { ...account, displayName: "After external change" };
  });
  window.dispatchEvent(new Event("focus"));
  const reopened = await openMenu();
  await findFastControl(
    "button",
    "CCached customAfter external change1 enabled",
    reopened,
  );
  expect(full).toBe(2);
  click(await findFastControl("button", "Connectors"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Connectors" }),
    ).toBeNull();
  });
  const cached = await openMenu();
  await findFastControl(
    "button",
    "CCached customAfter external change1 enabled",
    cached,
  );
  expect(full).toBe(2);
});
