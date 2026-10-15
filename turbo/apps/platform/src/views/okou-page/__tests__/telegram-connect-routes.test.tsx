import {
  integrationsTelegramContract,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const TELEGRAM_PATHS = ["/settings/telegram", "/telegram/connect"] as const;

function connectSearch(): string {
  return new URLSearchParams({
    bot: OFFICIAL_TELEGRAM_BOT_ID,
    tgUser: "99001",
    tgUserName: "alice",
    tgDisplayName: "Alice Tester",
    ts: "1700000000",
    sig: "b".repeat(64),
  }).toString();
}

test.each(TELEGRAM_PATHS)(
  "%s keeps the standalone connection page and complete URL context",
  async (path) => {
    context.mocks.api(
      integrationsTelegramContract.getLinkStatus,
      ({ respond }) => {
        return respond(200, {
          linked: true,
          telegramUserId: "99001",
          botUsername: "agent_bot",
        });
      },
    );
    const entry = `${path}?${connectSearch()}&settings=profile&context=one&context=two#return-context`;

    await setupPage({ context, path: entry, host: "app.okou.ai" });

    await expect(
      screen.findByRole("heading", { name: "Already connected to Telegram" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(/@agent_bot/u)).toBeInTheDocument();
    expect(window.location.href).toBe(`https://app.okou.ai${entry}`);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);

test.each(TELEGRAM_PATHS)(
  "%s requires sign-in with the full connection URL as its return destination",
  async (path) => {
    const entry = `${path}?${connectSearch()}&context=one&context=two#return-context`;

    await startPage({ context, path: entry, host: "app.okou.ai", auth: null });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/sign-in");
    });
    const authParams = new URLSearchParams(window.location.hash.split("?")[1]);
    expect(authParams.get("redirect_url")).toBe(`https://app.okou.ai${entry}`);
  },
);

test.each(TELEGRAM_PATHS)(
  "%s retains Telegram's onboarding gate and connection parameters",
  async (path) => {
    context.mocks.data.onboardingStatus({
      needsOnboarding: true,
      onboardingComplete: false,
    });
    const search = `${connectSearch()}&prompt=hello%20world&context=one&context=two`;

    await setupPage({ context, path: `${path}?${search}` });

    await expect(
      screen.findByRole("heading", { name: "Try this prompt" }),
    ).resolves.toBeInTheDocument();
    expect(window.location.pathname).toBe("/onboarding");
    expect([...new URLSearchParams(window.location.search)]).toStrictEqual([
      ...new URLSearchParams(search),
    ]);
    expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
      "hello world",
    );
  },
);
