import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

const dismissed = localStorageSignals(
  "subscription-hint-dismissed:test-user-123",
);
const otherDismissed = localStorageSignals(
  "subscription-hint-dismissed:another-user",
);

function action(
  name: string,
  role: "button" | "menuitem" = "button",
  container: ParentNode = document,
): HTMLElement {
  const element = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      (
        candidate.getAttribute("aria-label") ?? candidate.textContent
      )?.trim() === name
    );
  });
  if (!element) {
    throw new Error(`Expected ${role}: ${name}`);
  }
  return element;
}

async function openAccountMenu(): Promise<HTMLElement> {
  const rail = await screen.findByTestId("labeled-nav-rail");
  const trigger = await within(rail).findByLabelText("Test User");
  click(trigger);
  return await screen.findByRole("menu");
}

function connectedCodex(needsReconnect = false): ModelProviderResponse {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "codex-oauth-token",
    framework: "codex",
    isActive: true,
    accountEmail: "member@example.com",
    workspaceName: "member@example.com",
    planType: "pro",
    needsReconnect,
    lastRefreshErrorCode: needsReconnect ? "OAUTH_REFRESH_FAILED" : null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 100,
        remainingPercent: 0,
        resetAt: "2030-01-01T05:00:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: null,
    },
  };
}

async function setupLinking(options?: {
  readonly accounts?: readonly ModelProviderResponse[];
  readonly enabled?: boolean;
  readonly path?: string;
  readonly mobile?: boolean;
}) {
  mockTemplateChat({ tier: "limited-free-1" });
  context.mocks.data.personalModelProviders([...(options?.accounts ?? [])]);
  if (options?.mobile) {
    context.mocks.browser.matchMedia(() => {
      return false;
    });
  }
  await setupPage({
    context,
    path: options?.path ?? `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.SubscriptionLinkingEntry]: options?.enabled ?? true,
      [FeatureSwitchKey.SidebarSubscriptionUsage]: false,
      [FeatureSwitchKey.PwaNavigation]: options?.mobile ?? false,
    },
  });
}

async function openHintChooser() {
  const hint = await screen.findByTestId("subscription-linking-hint");
  click(action("Connect subscription", "button", hint));
  return await screen.findByRole("dialog", {
    name: "Connect your subscription",
  });
}

test("A Free member sees the hint below the composer alongside task chips", async () => {
  await setupLinking();
  const editor = await findComposerEditor();
  const hint = await screen.findByTestId("subscription-linking-hint");
  expect(
    editor.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(hint.closest("[data-chat-composer]")).toContainElement(editor);
  expect(
    screen.getByRole("region", { name: "Tasks to get started" }),
  ).toBeInTheDocument();
});

test("Dismissing the hint keeps the draft and the account-menu entry", async () => {
  const user = userEvent.setup();
  await setupLinking();
  const editor = await findComposerEditor();
  await user.type(editor, "Keep this draft");
  const hint = await screen.findByTestId("subscription-linking-hint");
  click(within(hint).getByLabelText("Dismiss subscription hint"));
  await waitFor(() => {
    expect(
      screen.queryByTestId("subscription-linking-hint"),
    ).not.toBeInTheDocument();
  });
  expect(
    context.store.get(
      localStorageSignals("subscription-hint-dismissed:test-user-123").get$,
    ),
  ).toBe("1");
  expect(editor).toHaveTextContent("Keep this draft");
  const menu = await openAccountMenu();
  await waitFor(() => {
    return expect(
      action("Connect AI subscription", "menuitem", menu),
    ).toBeInTheDocument();
  });
  click(action("Connect AI subscription", "menuitem", menu));
  const chooser = await screen.findByRole("dialog", {
    name: "Connect your subscription",
  });
  click(within(chooser).getByLabelText("Close"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Connect your subscription" }),
    ).not.toBeInTheDocument();
  });
  expect(editor).toHaveTextContent("Keep this draft");
});

test("A saved dismissal is respected on the next page load", async () => {
  context.store.set(dismissed.set$, "1");
  await setupLinking();
  const menu = await openAccountMenu();
  await waitFor(() => {
    return expect(
      action("Connect AI subscription", "menuitem", menu),
    ).toBeInTheDocument();
  });
  expect(
    screen.queryByTestId("subscription-linking-hint"),
  ).not.toBeInTheDocument();
});

test("Another user's dismissal does not hide the current user's hint", async () => {
  context.store.set(otherDismissed.set$, "1");
  await setupLinking();
  await expect(
    screen.findByTestId("subscription-linking-hint"),
  ).resolves.toBeInTheDocument();
});

test("The feature switch removes every new entry and preserves task chips", async () => {
  await setupLinking({ enabled: false });
  await screen.findByRole("region", { name: "Tasks to get started" });
  const menu = await openAccountMenu();
  expect(
    screen.queryByTestId("subscription-linking-hint"),
  ).not.toBeInTheDocument();
  expect(menu).not.toHaveTextContent("AI subscription");
});

test("Codex authorization only retires the hint after backend confirmation", async () => {
  const approval = context.mocks.deferred<void>();
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "linking-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      expiresIn: 60,
      interval: 1,
    });
  });
  context.mocks.api(
    codexDeviceAuthContract.complete,
    async ({ respond, withSignal }) => {
      await withSignal(approval.promise);
      context.mocks.data.personalModelProviders([connectedCodex()]);
      return respond(200, {
        status: "complete",
        provider: connectedCodex(),
        created: true,
      });
    },
  );
  await setupLinking();
  const chooser = await openHintChooser();
  click(action("ChatGPT (Codex)", "button", chooser));
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  expect(dialog).toHaveTextContent("ABCD-EFGH");
  expect(screen.getByTestId("subscription-linking-hint")).toBeInTheDocument();
  expect(screen.getAllByRole("dialog", { name: "Connect Codex" })).toHaveLength(
    1,
  );
  approval.resolve();
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Connect Codex" }),
    ).not.toBeInTheDocument();
  });
  const menu = await openAccountMenu();
  await waitFor(() => {
    return expect(
      action("Manage AI subscriptions", "menuitem", menu),
    ).toBeInTheDocument();
  });
  expect(
    screen.queryByTestId("subscription-linking-hint"),
  ).not.toBeInTheDocument();
  expect(
    context.store.get(
      localStorageSignals("subscription-hint-dismissed:test-user-123").get$,
    ),
  ).toBeNull();
});

test("Claude uses the existing authorization dialog and cancelling keeps the hint", async () => {
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "linking-claude-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });
  await setupLinking();
  const chooser = await openHintChooser();
  click(action("Claude", "button", chooser));
  const code = await screen.findByTestId("claude-code-device-auth-code");
  const dialog = code.closest<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  if (!dialog) {
    throw new Error("Expected Claude authorization dialog");
  }
  expect(
    within(dialog).getByTestId("claude-code-device-auth-open"),
  ).toHaveAttribute("href", "https://claude.ai/oauth/authorize");
  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    return expect(
      screen.queryByTestId("claude-code-device-auth-code"),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByTestId("subscription-linking-hint")).toBeInTheDocument();
});

test.each([false, true])(
  "Connected accounts stay manageable with exhausted usage (needsReconnect=%s)",
  async (needsReconnect) => {
    await setupLinking({ accounts: [connectedCodex(needsReconnect)] });
    const menu = await openAccountMenu();
    await waitFor(() => {
      return expect(
        action("Manage AI subscriptions", "menuitem", menu),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("subscription-linking-hint"),
    ).not.toBeInTheDocument();
    click(action("Manage AI subscriptions", "menuitem", menu));
    await screen.findByTestId(`oauth-account-${connectedCodex().id}`);
    expect(window.location.search).toContain("settings=model");
  },
);

test("An unresolved subscription lookup keeps the hint out", async () => {
  const pending = context.mocks.deferred<void>();
  context.mocks.api(
    personalModelProvidersMainContract.list,
    async ({ respond, withSignal }) => {
      await withSignal(pending.promise);
      return respond(200, { modelProviders: [] });
    },
  );
  await setupLinking();
  await findComposerEditor();
  const menu = await openAccountMenu();
  expect(action("AI subscriptions", "menuitem", menu)).toBeInTheDocument();
  expect(
    screen.queryByTestId("subscription-linking-hint"),
  ).not.toBeInTheDocument();
  click(action("AI subscriptions", "menuitem", menu));
  const chooser = await screen.findByRole("dialog", {
    name: "Connect your subscription",
  });
  expect(action("ChatGPT (Codex)", "button", chooser)).toBeDisabled();
  pending.resolve();
  await waitFor(() => {
    return expect(action("ChatGPT (Codex)", "button", chooser)).toBeEnabled();
  });
});

test("The mobile Me page opens subscription linking", async () => {
  await setupLinking({ mobile: true, path: "/me" });
  await screen.findByRole("heading", { name: "Me" });
  await waitFor(() => {
    expect(action("Connect AI subscription")).toBeInTheDocument();
  });
  click(action("Connect AI subscription"));
  await expect(
    screen.findByRole("dialog", { name: "Connect your subscription" }),
  ).resolves.toBeInTheDocument();
});

test("The shared switch also removes the mobile Me entry", async () => {
  await setupLinking({ enabled: false, mobile: true, path: "/me" });
  await screen.findByRole("heading", { name: "Me" });
  expect(screen.queryByText("Connect AI subscription")).not.toBeInTheDocument();
});

test("A failed lookup keeps the hint hidden and can be retried from the account menu", async () => {
  let fail = true;
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    if (fail) {
      return respond(500, {
        error: {
          message: "Subscription lookup unavailable",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    }
    return respond(200, { modelProviders: [] });
  });
  await setupLinking();
  await findComposerEditor();
  const menu = await openAccountMenu();
  click(action("AI subscriptions", "menuitem", menu));
  const chooser = await screen.findByRole("dialog", {
    name: "Connect your subscription",
  });
  await within(chooser).findByRole("alert");
  expect(
    screen.queryByTestId("subscription-linking-hint"),
  ).not.toBeInTheDocument();
  fail = false;
  click(action("Try again", "button", chooser));
  await waitFor(() => {
    return expect(action("ChatGPT (Codex)", "button", chooser)).toBeEnabled();
  });
});
