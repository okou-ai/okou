import { screen, waitFor, within } from "@testing-library/react";
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
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  context,
  mockTemplateChat,
} from "./chat-composer-template-gallery-test-helpers.ts";

function connectedCodex(): ModelProviderResponse {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "codex-oauth-token",
    framework: "codex",
    secretName: null,
    authMethod: "auth_json",
    secretNames: ["CODEX_AUTH_JSON"],
    isDefault: false,
    isActive: true,
    selectedModel: null,
    accountEmail: "member@example.com",
    workspaceName: "member@example.com",
    planType: "pro",
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

/** Serves the member's personal accounts; `replace` stands in for a connect. */
function installPersonalAccounts(initial: readonly ModelProviderResponse[]): {
  readonly replace: (next: readonly ModelProviderResponse[]) => void;
} {
  let accounts = [...initial];
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return respond(200, { modelProviders: accounts });
  });
  return {
    replace: (next) => {
      accounts = [...next];
    },
  };
}

async function setupStartCards(
  subscriptionPinned: boolean,
  accounts: readonly ModelProviderResponse[] = [],
): Promise<{
  readonly replaceAccounts: (next: readonly ModelProviderResponse[]) => void;
}> {
  mockTemplateChat();
  const personalAccounts = installPersonalAccounts(accounts);
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: false,
      [FeatureSwitchKey.StartCardModelSubscription]: subscriptionPinned,
    },
  });
  await findComposerEditor();
  return { replaceAccounts: personalAccounts.replace };
}

function subscriptionCard(): HTMLElement {
  return screen.getByTestId("start-card-subscription");
}

function subscriptionButton(label: string): HTMLElement {
  const button = queryAllByRoleFast("button", subscriptionCard()).find(
    (item) => {
      return item.textContent?.trim() === label;
    },
  );
  if (!button) {
    throw new Error(`Expected subscription button ${label}`);
  }
  return button;
}

test("The subscription card leads the start cards without growing the row", async () => {
  await setupStartCards(true);
  await screen.findByTestId("start-card-subscription");
  const row = screen.getByTestId("start-cards");
  expect(row.children).toHaveLength(3);
  expect(row.firstElementChild).toBe(subscriptionCard());
  expect(subscriptionCard()).toHaveTextContent("Run tasks for free");
});

test("The Codex button opens the Codex sign-in from the start card", async () => {
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "start-card-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      expiresIn: 60,
      interval: 1,
    });
  });
  await setupStartCards(true);
  await screen.findByTestId("start-card-subscription");

  click(subscriptionButton("Codex"));

  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  expect(dialog).toHaveTextContent("ABCD-EFGH");
});

test("The Claude button opens the Claude sign-in from the start card", async () => {
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "start-card-claude-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });
  await setupStartCards(true);
  await screen.findByTestId("start-card-subscription");

  click(subscriptionButton("Claude"));

  const inputs = await screen.findAllByTestId("claude-code-device-auth-code");
  expect(inputs).not.toHaveLength(0);
});

test("The start cards stay unchanged while the subscription card is off", async () => {
  await setupStartCards(false);
  expect(screen.getByTestId("start-cards").children).toHaveLength(3);
  expect(screen.queryByTestId("start-card-subscription")).toBeNull();
});

test("The subscription card never flashes in for a member who already has an account", async () => {
  const accountsListed = context.mocks.deferred<void>();
  mockTemplateChat();
  context.mocks.api(
    personalModelProvidersMainContract.list,
    async ({ respond, withSignal }) => {
      await withSignal(accountsListed.promise);
      return respond(200, { modelProviders: [connectedCodex()] });
    },
  );
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerTaskChips]: false,
      [FeatureSwitchKey.StartCardModelSubscription]: true,
    },
  });
  await findComposerEditor();

  // Still waiting on the account list: the row keeps its drawn kinds.
  expect(screen.getByTestId("start-cards").children).toHaveLength(3);
  expect(screen.queryByTestId("start-card-subscription")).toBeNull();

  accountsListed.resolve();
  await waitFor(() => {
    expect(screen.getByTestId("start-cards").children).toHaveLength(3);
  });
  expect(screen.queryByTestId("start-card-subscription")).toBeNull();
});

test("Connecting Codex from the card retires it for a regular start card", async () => {
  const approval = context.mocks.deferred<void>();
  context.mocks.browser.clipboardWriteText();
  context.mocks.browser.open(context.mocks.browser.authWindow());
  context.mocks.api(codexDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "start-card-codex-session",
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      expiresIn: 60,
      interval: 1,
    });
  });
  const { replaceAccounts } = await setupStartCards(true);
  context.mocks.api(
    codexDeviceAuthContract.complete,
    async ({ respond, withSignal }) => {
      await withSignal(approval.promise);
      replaceAccounts([connectedCodex()]);
      return respond(200, {
        status: "complete",
        provider: connectedCodex(),
        created: true,
      });
    },
  );
  await screen.findByTestId("start-card-subscription");

  click(subscriptionButton("Codex"));
  const dialog = await screen.findByRole("dialog", { name: "Connect Codex" });
  click(within(dialog).getByTestId("codex-device-auth-open"));
  approval.resolve();

  await waitFor(() => {
    expect(screen.queryByTestId("start-card-subscription")).toBeNull();
  });
  expect(screen.getByTestId("start-cards").children).toHaveLength(3);
});
