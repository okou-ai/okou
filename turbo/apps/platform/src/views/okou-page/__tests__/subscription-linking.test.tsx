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
import {
  buildRunModel,
  composerModelTrigger,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import { openModelPanel } from "./chat-model-panel-test-helpers.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

type ActionRole = "button" | "menuitem" | "menuitemradio";

function findAction(
  name: string,
  role: ActionRole = "button",
  container: ParentNode = document,
): HTMLElement | undefined {
  return queryAllByRoleFast(role, container).find((candidate) => {
    return (
      (
        candidate.getAttribute("aria-label") ?? candidate.textContent
      )?.trim() === name
    );
  });
}

function action(
  name: string,
  role: ActionRole = "button",
  container: ParentNode = document,
): HTMLElement {
  const element = findAction(name, role, container);
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

async function openComposerProviders(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(action("Use more models")).toBeInTheDocument();
  });
  click(action("Use more models"));
  return await screen.findByRole("menu", { name: "Use more models" });
}

function codexRunModels() {
  return [
    buildRunModel({ model: null }),
    buildRunModel({
      model: "gpt-6-astra",
      modelLabel: "GPT 6 Astra",
      providerType: "codex-oauth-token",
      modelProviderId: connectedCodex().id,
    }),
  ];
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
  readonly usagePanel?: boolean;
}) {
  mockTemplateChat({ tier: "limited-free-1" });
  const accounts = options?.accounts ?? [];
  context.mocks.data.personalModelProviders([...accounts]);
  context.mocks.data.availableRunModels(
    accounts.length > 0 ? codexRunModels() : [],
  );
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
      [FeatureSwitchKey.SidebarSubscriptionUsage]: options?.usagePanel ?? false,
      [FeatureSwitchKey.PwaNavigation]: options?.mobile ?? false,
    },
  });
}

test("An unlinked member finds the subscriptions in the composer's model slot", async () => {
  await setupLinking();
  await findComposerEditor();
  const menu = await openComposerProviders();
  expect(action("Auto", "menuitemradio", menu)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(action("Auto", "menuitemradio", menu)).toHaveAccessibleDescription(
    "Uses Okou credits",
  );
  expect(menu).toHaveTextContent("Run on your own plan");
  expect(
    action("ChatGPT (Codex)", "menuitem", menu),
  ).toHaveAccessibleDescription("Plus, Pro or Business");
  expect(action("Claude", "menuitem", menu)).toHaveAccessibleDescription(
    "Pro or Max",
  );
  expect(
    screen.getByRole("region", { name: "Tasks to get started" }),
  ).toBeInTheDocument();
});

test("Codex opens its authorization from the composer and the slot becomes the model picker after confirmation", async () => {
  const user = userEvent.setup();
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
      context.mocks.data.availableRunModels(codexRunModels());
      return respond(200, {
        status: "complete",
        provider: connectedCodex(),
        created: true,
      });
    },
  );
  await setupLinking();
  const editor = await findComposerEditor();
  await user.type(editor, "Keep this draft");
  const menu = await openComposerProviders();
  click(action("ChatGPT (Codex)", "menuitem", menu));
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  expect(dialog).toHaveTextContent("ABCD-EFGH");
  expect(screen.getAllByRole("dialog", { name: "Connect Codex" })).toHaveLength(
    1,
  );
  approval.resolve();
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Connect Codex" }),
    ).not.toBeInTheDocument();
  });
  await composerModelTrigger("Auto");
  expect(findAction("Use more models")).toBeUndefined();
  expect(editor).toHaveTextContent("Keep this draft");
  const accountMenu = await openAccountMenu();
  expect(accountMenu).not.toHaveTextContent("Use more models");
});

test("Linking one subscription keeps the other one connectable from the model panel", async () => {
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "panel-claude-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });
  await setupLinking({ accounts: [connectedCodex()] });
  await findComposerEditor();
  const panel = await openModelPanel("Auto");
  expect(panel).toHaveTextContent("Your ChatGPT plan");
  expect(panel).toHaveTextContent("5h · 0% left");
  expect(panel).toHaveTextContent("Your Claude plan");
  expect(action("Claude", "button", panel)).toHaveAccessibleDescription(
    "Pro or Max",
  );
  click(action("Claude", "button", panel));
  await screen.findByTestId("claude-code-device-auth-code");
});

test("Manage plans in the model panel opens Models", async () => {
  await setupLinking({ accounts: [connectedCodex()] });
  await findComposerEditor();
  const panel = await openModelPanel("Auto");
  click(action("Manage plans", "button", panel));
  await waitFor(() => {
    expect(window.location.search).toContain("settings=model");
  });
});

test("Claude opens its authorization from the account menu and cancelling keeps both entries", async () => {
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
  await findComposerEditor();
  const menu = await openAccountMenu();
  await waitFor(() => {
    return expect(
      action("Use more models", "menuitem", menu),
    ).toBeInTheDocument();
  });
  click(action("Use more models", "menuitem", menu));
  await waitFor(() => {
    expect(action("Claude", "menuitem")).toBeInTheDocument();
  });
  click(action("Claude", "menuitem"));
  const code = await screen.findByTestId("claude-code-device-auth-code");
  const dialog = code.closest<HTMLElement>('[role="dialog"]');
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
  expect(action("Use more models")).toBeInTheDocument();
});

test.each([false, true])(
  "Linked members get the model picker and no linking entry (needsReconnect=%s)",
  async (needsReconnect) => {
    await setupLinking({
      accounts: [connectedCodex(needsReconnect)],
      usagePanel: true,
    });
    await findComposerEditor();
    await waitFor(() => {
      expect(action("Auto")).toBeInTheDocument();
    });
    expect(findAction("Use more models")).toBeUndefined();
    const menu = await openAccountMenu();
    await within(menu).findByRole("region", {
      name: "Your ChatGPT plan usage",
    });
    expect(menu).not.toHaveTextContent("Use more models");
  },
);

test("The feature switch removes every entry and preserves task chips", async () => {
  await setupLinking({ enabled: false });
  await screen.findByRole("region", { name: "Tasks to get started" });
  const menu = await openAccountMenu();
  expect(menu).not.toHaveTextContent("Use more models");
  expect(findAction("Use more models")).toBeUndefined();
});

test("The feature switch leaves a linked member's model panel ungrouped", async () => {
  await setupLinking({ enabled: false, accounts: [connectedCodex()] });
  await findComposerEditor();
  const panel = await openModelPanel("Auto");
  expect(panel).toHaveTextContent("GPT 6 Astra");
  expect(panel).not.toHaveTextContent("Your ChatGPT plan");
  expect(findAction("Manage plans", "button", panel)).toBeUndefined();
});

test("An unresolved subscription lookup offers no entry yet", async () => {
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
  expect(menu).not.toHaveTextContent("Use more models");
  expect(findAction("Use more models")).toBeUndefined();
  pending.resolve();
  await waitFor(() => {
    expect(action("Use more models")).toBeInTheDocument();
  });
});

test("The mobile Me page offers both subscriptions and opens the chosen sign-in", async () => {
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "me-claude-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });
  await setupLinking({ mobile: true, path: "/me" });
  await screen.findByRole("heading", { name: "Me" });
  await waitFor(() => {
    expect(action("Use more models")).toBeInTheDocument();
  });
  click(action("Use more models"));
  const menu = await screen.findByRole("menu");
  expect(
    queryAllByRoleFast("menuitem", menu).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual(["ChatGPT (Codex)", "Claude"]);
  click(action("Claude", "menuitem", menu));
  await expect(
    screen.findByTestId("claude-code-device-auth-code"),
  ).resolves.toBeInTheDocument();
});

test("The mobile Me entry leaves once a subscription is linked", async () => {
  await setupLinking({
    mobile: true,
    path: "/me",
    accounts: [connectedCodex()],
    usagePanel: true,
  });
  await screen.findByRole("region", { name: "Your ChatGPT plan usage" });
  expect(screen.queryByText("Use more models")).not.toBeInTheDocument();
});

test("The shared switch also removes the mobile Me entry", async () => {
  await setupLinking({ enabled: false, mobile: true, path: "/me" });
  await screen.findByRole("heading", { name: "Me" });
  expect(screen.queryByText("Use more models")).not.toBeInTheDocument();
});
