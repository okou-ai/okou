import { DetachedBrowserContext } from "happy-dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import type { TelegramBotStatus } from "@okouai/api-contracts/contracts/integrations-telegram";
export const telegramPath = "/settings/telegram";
export const telegramBotUrl = "https://t.me/support_bot";
export const chatInstructions =
  "Send the bot a message in Telegram to start chatting.";
export const signedQuery =
  "?bot=official&context=phone&tgUser=99001&ts=1795000000&sig=" +
  "71".repeat(32) +
  "&context=inbox#message";
export function botState(context: TestContext, id?: string, configured = true) {
  const status: TelegramBotStatus = {
    id: "official",
    kind: "official",
    username: "support_bot",
    avatarUrl: null,

    isOwner: true,
    isConnected: !!id,
    connectedUser: id
      ? {
          telegramUserId: id,
          telegramUsername: "actual_name",
          telegramDisplayName: "Marin Ward",
        }
      : null,
    tokenStatus: "valid",
    official: {
      configured,

      linkedTelegramUserId: id ?? null,
    },
    domainConfigured: configured,
    environment: {
      requiredSecrets: [],
      missingSecrets: [],
      missingVars: [],
      requiredVars: [],
    },
  };
  context.mocks.data.telegramIntegration({
    statuses: [status],
    linkStatus: id ? { linked: true, telegramUserId: id } : { linked: false },
  });
  return status;
}
export function openTelegram(context: TestContext, path: string) {
  return setupPage({
    context,
    host: "app.okou.ai",
    path,
  });
}
export async function visitLink(
  context: TestContext,
  label: string,
  url: string,
) {
  context.mocks.http.get(url, () => {
    return new Response("<title>Test destination</title>", {
      headers: { "content-type": "text/html" },
    });
  });
  const pages = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
  await userEvent.click(await screen.findByText(label));
  await waitFor(() => {
    expect(
      pages.mock.results.map(({ value }) => {
        return value.url;
      }),
    ).toContain(url);
  });
  for (const { value } of pages.mock.results) {
    await value.close();
  }
  pages.mockRestore();
}
export function connectControl() {
  return waitFor(() => {
    const control = screen.getByTestId("telegram-connect-button");
    expect(control).toBeEnabled();
    return control;
  });
}
export async function authorize(
  context: TestContext,
  control: HTMLElement,
  callbackOrigin = "https://www.okou.ai",
) {
  const tab = context.mocks.browser.authWindow();
  context.mocks.http.get("https://oauth.telegram.org/auth", () => {
    return new Response("<title>Local Telegram login</title>", {
      headers: { "content-type": "text/html" },
    });
  });
  const pages = vi.spyOn(DetachedBrowserContext.prototype, "newPage");
  const nativeOpen = window.open.bind(window);
  const opened = vi.spyOn(window, "open").mockImplementation((...args) => {
    const popup = nativeOpen(...args);
    if (!popup) {
      return null;
    }
    // Keep the message peer stable across documents, as a browser WindowProxy does.
    Object.defineProperty(tab, "location", { value: popup.location });
    return tab;
  });
  const messages = vi.spyOn(tab, "postMessage");
  await userEvent.click(control);
  expect(opened).toHaveBeenCalledWith("about:blank", "_blank");
  const page = pages.mock.results.at(-1)?.value;
  if (!page) {
    throw new Error("Telegram login did not open a new page");
  }
  await waitFor(() => {
    expect(new URL(page.url).origin).toBe("https://oauth.telegram.org");
  });
  await waitFor(() => {
    expect(page.mainFrame.document.title).toBe("Local Telegram login");
  });
  const auth = new URL(page.url);
  expect(auth.pathname).toBe("/auth");
  const close = tab.close.bind(tab);
  vi.spyOn(tab, "close").mockImplementation(() => {
    close();
    page.mainFrame.window.close();
  });
  expect(auth.searchParams.get("request_access")).toBe("write");
  expect(auth.searchParams.get("bot_id")).toBe("123456789");
  const callback = new URL(auth.searchParams.get("return_to") ?? "");
  expect(callback.origin).toBe(callbackOrigin);
  expect(callback.pathname).toBe("/api/integrations/telegram/auth-callback");
  expect(callback.searchParams.get("targetOrigin")).toBe(location.origin);
  expect(callback.searchParams.get("callbackProtocol")).toBe("2");
  expect(callback.searchParams.get("bot")).toBe("official");
  const op = callback.searchParams.get("operationId");
  if (!op) {
    throw new Error("Missing authorization operation");
  }

  const send = (data: Record<string, unknown>) => {
    context.mocks.browser.message(
      { protocol: 2, operationId: op, bot: "official", ...data },
      { origin: callback.origin, source: tab },
    );
  };
  const ready = () => {
    return send({ type: "telegram-auth-bridge-ready" });
  };
  const result = (status: string) => {
    return expect(messages).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: op,
        type: "telegram-auth-result",
        status,
      }),
      callback.origin,
    );
  };
  return { tab, callback, op, messages, send, ready, result };
}
