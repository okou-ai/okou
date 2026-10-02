import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { modelPoliciesMainContract } from "@okouai/api-contracts/contracts/model-policies";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function button(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      (
        candidate.getAttribute("aria-label") ??
        candidate.textContent ??
        ""
      ).trim() === name
    );
  });
  if (!element) {
    throw new Error(`Button not found: ${name}`);
  }
  return element;
}

function account(
  type:
    | "claude-code-oauth-token"
    | "codex-oauth-token" = "claude-code-oauth-token",
  needsReconnect = false,
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000302",
    type,
    framework: type === "claude-code-oauth-token" ? "claude-code" : "codex",
    secretName: null,
    authMethod: null,
    secretNames: null,
    isDefault: false,
    isActive: true,
    selectedModel: null,
    accountEmail: "account@example.com",
    workspaceName: "account@example.com",
    planType: "pro",
    needsReconnect,
    lastRefreshErrorCode: needsReconnect ? "refresh_token_expired" : null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-20T00:00:00Z",
  };
}

function mockAutoMode(): void {
  context.mocks.api(claudeCodeDeviceAuthContract.start, ({ respond }) => {
    return respond(200, {
      sessionToken: "mock-personal-claude-code-session",
      type: "claude-code",
      status: "pending",
      scope: "personal",
      browserUrl: "https://claude.ai/oauth/authorize",
      expiresIn: 30,
    });
  });
  context.mocks.api(modelPoliciesMainContract.list, ({ respond }) => {
    return respond(200, {
      modelMode: "auto",
      revision: "revision-auto",
      writePreconditionRequired: false,
      modelsAvailableToAdd: [],
      policies: [
        {
          id: "e7000000-0000-4000-a000-000000000001",
          model: "okou-1.0",
          modelLabel: "Auto",
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
          routeStatus: "valid",
          routeStatusReason: null,
          createdAt: "2026-09-15T00:00:00.000Z",
          updatedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
    });
  });
}

async function openSettings(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: "/agents?settings=model",
    featureSwitches: {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: false,
    },
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await within(settings).findByRole("heading", { name: "Use more models" });
  return settings;
}

test("Offer a single connection entry point in Auto mode and keep it after cancelling authorization", async () => {
  mockAutoMode();
  context.mocks.data.personalModelProviders([]);
  const settings = await openSettings();
  await waitFor(() => {
    return expect(button("Connect account", settings)).toBeEnabled();
  });
  expect(
    within(settings).getAllByRole("heading", { name: "Use more models" }),
  ).toHaveLength(1);
  expect(
    within(settings).queryByRole("heading", { name: "Models" }),
  ).not.toBeInTheDocument();
  expect(
    within(settings).queryByText("No accounts connected."),
  ).not.toBeInTheDocument();
  click(button("Connect account", settings));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("ChatGPT (Codex)")).toBeInTheDocument();
  click(within(menu).getByText("Claude"));
  const input = await screen.findByTestId("claude-code-device-auth-code");
  const authorization = input.closest('[role="dialog"]');
  if (!(authorization instanceof HTMLElement)) {
    throw new Error("Authorization dialog not found");
  }
  click(within(authorization).getByLabelText("Close"));
  await waitFor(() => {
    return expect(
      screen.queryByTestId("claude-code-device-auth-code"),
    ).not.toBeInTheDocument();
  });
  expect(button("Connect account", settings)).toBeEnabled();
});

test("Switch to account management only after successful authorization is confirmed by the account list", async () => {
  mockAutoMode();
  context.mocks.data.personalModelProviders([]);
  const connected = account();
  const refreshStarted = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let completed = false;
  context.mocks.api(
    personalModelProvidersMainContract.list,
    async ({ respond }) => {
      if (completed) {
        refreshStarted.resolve();
        await release.promise;
      }
      return respond(200, { modelProviders: completed ? [connected] : [] });
    },
  );
  context.mocks.api(claudeCodeDeviceAuthContract.complete, ({ respond }) => {
    completed = true;
    return respond(200, {
      status: "complete",
      provider: connected,
      created: true,
    });
  });
  const settings = await openSettings();
  await waitFor(() => {
    return expect(button("Connect account", settings)).toBeEnabled();
  });
  click(button("Connect account", settings));
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Claude"));
  const input = await screen.findByTestId("claude-code-device-auth-code");
  await fill(input, "claude-auth-code");
  const authorization = input.closest('[role="dialog"]');
  if (!(authorization instanceof HTMLElement)) {
    throw new Error("Authorization dialog not found");
  }
  click(within(authorization).getByTestId("claude-code-device-auth-submit"));
  await refreshStarted.promise;
  expect(button("Connect account", settings)).toBeInTheDocument();
  expect(
    within(settings).queryByText("account@example.com"),
  ).not.toBeInTheDocument();
  release.resolve();
  const row = await within(settings).findByTestId(
    `oauth-account-${connected.id}`,
  );
  expect(within(row).getByText("account@example.com")).toBeInTheDocument();
  expect(within(row).getByText("Connected")).toBeInTheDocument();
  expect(button("Add account", settings)).toBeEnabled();
  expect(
    queryAllByRoleFast("button", settings).some((element) => {
      return element.textContent?.trim() === "Connect account";
    }),
  ).toBeFalsy();
  expect(
    within(settings).getByText("No accounts connected."),
  ).toBeInTheDocument();
});

test("Return to the connection empty state after disconnecting the final saved account", async () => {
  mockAutoMode();
  const connected = account("codex-oauth-token");
  context.mocks.data.personalModelProviders([connected]);
  const settings = await openSettings();
  const row = await within(settings).findByTestId(
    `oauth-account-${connected.id}`,
  );
  click(within(row).getByLabelText("More options"));
  click(await screen.findByText("Disconnect account"));
  const confirmation = await screen.findByRole("dialog", {
    name: "Disconnect account@example.com?",
  });
  click(button("Disconnect account", confirmation));
  await waitFor(() => {
    return expect(button("Connect account", settings)).toBeEnabled();
  });
  expect(
    within(settings).queryByTestId(`oauth-account-${connected.id}`),
  ).not.toBeInTheDocument();
  expect(
    within(settings).queryByText("No accounts connected."),
  ).not.toBeInTheDocument();
});

test("Keep expired accounts in management and expose their existing reconnect flow", async () => {
  mockAutoMode();
  const expired = account("claude-code-oauth-token", true);
  context.mocks.data.personalModelProviders([expired]);
  const settings = await openSettings();
  const row = await within(settings).findByTestId(
    `oauth-account-${expired.id}`,
  );
  expect(within(row).getByText("Attention")).toBeInTheDocument();
  expect(button("Add account", settings)).toBeEnabled();
  click(button("Reconnect", row));
  await expect(
    screen.findByTestId("claude-code-device-auth-code"),
  ).resolves.toBeInTheDocument();
});

test("Show loading rather than a connect prompt before the first account read completes", async () => {
  mockAutoMode();
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    personalModelProvidersMainContract.list,
    async ({ respond }) => {
      started.resolve();
      await release.promise;
      return respond(200, { modelProviders: [] });
    },
  );
  const page = await startPage({ context, path: "/agents?settings=model" });
  await page.content;
  await started.promise;
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await within(settings).findByRole("status", { name: "Loading accounts…" });
  expect(
    queryAllByRoleFast("button", settings).some((element) => {
      return element.textContent?.trim() === "Connect account";
    }),
  ).toBeFalsy();
  release.resolve();
  await waitFor(() => {
    return expect(button("Connect account", settings)).toBeEnabled();
  });
  await page.ready;
});

test("Show a retryable account read error instead of claiming there are no connected accounts", async () => {
  mockAutoMode();
  let failed = true;
  context.mocks.api(personalModelProvidersMainContract.list, ({ respond }) => {
    return failed
      ? respond(500, {
          error: {
            message: "Upstream unavailable",
            code: "INTERNAL_SERVER_ERROR",
          },
        })
      : respond(200, { modelProviders: [] });
  });
  const settings = await openSettings();
  await within(settings).findByText("Couldn’t load your accounts.");
  expect(
    queryAllByRoleFast("button", settings).some((element) => {
      return element.textContent?.trim() === "Connect account";
    }),
  ).toBeFalsy();
  failed = false;
  click(button("Try again", settings));
  await waitFor(() => {
    return expect(button("Connect account", settings)).toBeEnabled();
  });
});
