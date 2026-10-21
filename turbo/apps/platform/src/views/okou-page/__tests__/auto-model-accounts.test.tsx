import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { mockAutoRunModel } from "../../../mocks/handlers/api-run-models.ts";
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
    "claude-code-oauth-token" | "codex-oauth-token" = "claude-code-oauth-token",
  needsReconnect = false,
): ModelProviderResponse {
  return {
    id: "00000000-0000-4000-a000-000000000302",
    type,
    framework: type === "claude-code-oauth-token" ? "claude-code" : "codex",
    isActive: true,
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
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    return respond(200, {
      models: [mockAutoRunModel()],
    });
  });
}

async function openSettings(): Promise<HTMLElement> {
  await setupPage({
    context,
    path: "/agents?settings=model",
  });
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  await within(settings).findByRole("heading", { name: "Use more models" });
  return settings;
}

function providerSection(settings: HTMLElement, name = "Claude"): HTMLElement {
  const heading = within(settings).getByRole("heading", { name });
  const section = heading.closest("section");
  if (!section) {
    throw new Error(`Provider section not found: ${name}`);
  }
  return section;
}

test("Offer direct provider connections and allow a fresh attempt after closing during startup", async () => {
  mockAutoMode();
  context.mocks.data.personalModelProviders([]);
  const initialStart = context.mocks.deferred<void>();
  let firstAttempt = true;
  context.mocks.api(
    claudeCodeDeviceAuthContract.start,
    async ({ respond, withSignal }) => {
      if (firstAttempt) {
        await withSignal(initialStart.promise);
      }
      return respond(200, {
        sessionToken: "fresh-claude-session",
        type: "claude-code",
        status: "pending",
        scope: "personal",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 60,
      });
    },
  );
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
  expect(within(settings).getAllByText("No accounts connected.")).toHaveLength(
    2,
  );
  expect(
    button("Connect account", providerSection(settings, "ChatGPT (Codex)")),
  ).toBeEnabled();
  expect(
    queryAllByRoleFast("button", settings).filter((element) => {
      return element.textContent?.trim() === "Connect account";
    }),
  ).toHaveLength(2);
  click(button("Connect account", providerSection(settings)));
  const preparing = await screen.findByTestId(
    "claude-code-device-auth-loading",
  );
  const startupDialog = preparing.closest<HTMLElement>('[role="dialog"]');
  if (!startupDialog) {
    throw new Error("Authorization dialog not found");
  }
  click(within(startupDialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByTestId("claude-code-device-auth-loading"),
    ).not.toBeInTheDocument();
  });
  firstAttempt = false;
  click(button("Connect account", providerSection(settings)));
  const input = await screen.findByTestId("claude-code-device-auth-code");
  initialStart.resolve();
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

test("Show a connected account in its provider section only after authorization is confirmed by the account list", async () => {
  mockAutoMode();
  context.mocks.data.personalModelProviders([]);
  const connected = account();
  const refreshStarted = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  let completed = false;
  context.mocks.api(
    thirdPartySubscriptionsMainContract.list,
    async ({ respond }) => {
      if (completed) {
        refreshStarted.resolve();
        await release.promise;
      }
      return respond(200, { subscriptions: completed ? [connected] : [] });
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
  click(button("Connect account", providerSection(settings)));
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
  expect(button("Connect account", providerSection(settings))).toBeEnabled();
  expect(
    button("Connect account", providerSection(settings, "ChatGPT (Codex)")),
  ).toBeEnabled();
  expect(
    within(settings).getByText("No accounts connected."),
  ).toBeInTheDocument();
});

test("Keep both provider sections after disconnecting the final saved account", async () => {
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
  expect(within(settings).getAllByText("No accounts connected.")).toHaveLength(
    2,
  );
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
  expect(button("Connect account", providerSection(settings))).toBeEnabled();
  click(button("Reconnect", row));
  await expect(
    screen.findByTestId("claude-code-device-auth-code"),
  ).resolves.toBeInTheDocument();
});

test("Connect ChatGPT directly and keep its code visible while approval is pending", async () => {
  mockAutoMode();
  context.mocks.data.personalModelProviders([]);
  const start = context.mocks.deferred<void>();
  const approval = context.mocks.deferred<void>();
  context.mocks.api(
    codexDeviceAuthContract.complete,
    async ({ respond, withSignal }) => {
      await withSignal(approval.promise);
      return respond(200, { status: "pending", errorMessage: null });
    },
  );
  context.mocks.api(
    codexDeviceAuthContract.start,
    async ({ respond, withSignal }) => {
      await withSignal(start.promise);
      return respond(200, {
        sessionToken: "mock-personal-codex-session",
        type: "codex",
        status: "pending",
        scope: "personal",
        browserUrl: "https://auth.openai.com/codex/device",
        verificationCode: "TEST-CODE",
        expiresIn: 900,
        interval: 5,
      });
    },
  );
  const settings = await openSettings();
  click(
    button("Connect account", providerSection(settings, "ChatGPT (Codex)")),
  );
  const authorization = await screen.findByRole("dialog", {
    name: "Connect Codex",
  });
  await within(authorization).findByTestId("codex-device-auth-loading");
  start.resolve();
  await expect(
    within(authorization).findByText("TEST-CODE"),
  ).resolves.toBeInTheDocument();
  expect(
    within(authorization).getByTestId("codex-device-auth-open"),
  ).toHaveAttribute("href", "https://auth.openai.com/codex/device");
  click(within(authorization).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Connect Codex" }),
    ).not.toBeInTheDocument();
  });
  expect(
    button("Connect account", providerSection(settings, "ChatGPT (Codex)")),
  ).toBeEnabled();
});

test.each([
  ["Claude", "claude-code-device-auth"],
  ["ChatGPT (Codex)", "codex-device-auth"],
] as const)(
  "%s shows startup and retry progress from the same authorization operation",
  async (provider, testId) => {
    mockAutoMode();
    context.mocks.data.personalModelProviders([]);
    const initialStart = context.mocks.deferred<void>();
    const retryStart = context.mocks.deferred<void>();
    const approval = context.mocks.deferred<void>();
    let failStart = true;
    context.mocks.api(
      claudeCodeDeviceAuthContract.start,
      async ({ respond, withSignal }) => {
        await withSignal((failStart ? initialStart : retryStart).promise);
        if (failStart) {
          return respond(503, {
            error: {
              code: "UNAVAILABLE",
              message: "Authorization unavailable",
            },
          });
        }
        return respond(200, {
          sessionToken: "retry-claude-session",
          type: "claude-code",
          status: "pending",
          scope: "personal",
          browserUrl: "https://claude.ai/oauth/authorize",
          expiresIn: 60,
        });
      },
    );
    context.mocks.api(
      codexDeviceAuthContract.start,
      async ({ respond, withSignal }) => {
        await withSignal((failStart ? initialStart : retryStart).promise);
        if (failStart) {
          return respond(503, {
            error: {
              code: "UNAVAILABLE",
              message: "Authorization unavailable",
            },
          });
        }
        return respond(200, {
          sessionToken: "retry-codex-session",
          type: "codex",
          status: "pending",
          scope: "personal",
          browserUrl: "https://auth.openai.com/codex/device",
          verificationCode: "RETRY-CODE",
          expiresIn: 60,
          interval: 1,
        });
      },
    );
    context.mocks.api(
      codexDeviceAuthContract.complete,
      async ({ respond, withSignal }) => {
        await withSignal(approval.promise);
        return respond(200, { status: "pending", errorMessage: null });
      },
    );
    const settings = await openSettings();
    click(button("Connect account", providerSection(settings, provider)));
    const preparing = await screen.findByTestId(`${testId}-loading`);
    const authorization = preparing.closest<HTMLElement>('[role="dialog"]');
    if (!authorization) {
      throw new Error("Authorization dialog not found");
    }
    initialStart.resolve();
    const retry = await within(authorization).findByTestId(`${testId}-start`);
    expect(retry).toBeEnabled();
    failStart = false;
    click(retry);
    await within(authorization).findByTestId(`${testId}-loading`);
    retryStart.resolve();
    await expect(
      within(authorization).findByTestId(`${testId}-code`),
    ).resolves.toBeInTheDocument();
    expect(within(authorization).getByTestId(`${testId}-open`)).toHaveAttribute(
      "href",
      provider === "Claude"
        ? "https://claude.ai/oauth/authorize"
        : "https://auth.openai.com/codex/device",
    );
    click(within(authorization).getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByTestId(`${testId}-code`)).not.toBeInTheDocument();
    });
    expect(
      button("Connect account", providerSection(settings, provider)),
    ).toBeEnabled();
  },
);

test("Disable only the provider that has reached the ten-account limit", async () => {
  mockAutoMode();
  context.mocks.data.personalModelProviders(
    Array.from({ length: 10 }, (_, index) => {
      return {
        ...account(),
        id: `00000000-0000-4000-a000-${String(index + 400).padStart(12, "0")}`,
        accountEmail: `claude-${index}@example.com`,
        workspaceName: `claude-${index}@example.com`,
        isActive: index === 0,
      };
    }),
  );
  const settings = await openSettings();
  expect(button("Connect account", providerSection(settings))).toBeDisabled();
  expect(
    button("Connect account", providerSection(settings, "ChatGPT (Codex)")),
  ).toBeEnabled();
});

test("Show loading rather than a connect prompt before the first account read completes", async () => {
  mockAutoMode();
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    thirdPartySubscriptionsMainContract.list,
    async ({ respond }) => {
      started.resolve();
      await release.promise;
      return respond(200, { subscriptions: [] });
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
  context.mocks.api(thirdPartySubscriptionsMainContract.list, ({ respond }) => {
    return failed
      ? respond(500, {
          error: {
            message: "Upstream unavailable",
            code: "INTERNAL_SERVER_ERROR",
          },
        })
      : respond(200, { subscriptions: [] });
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
