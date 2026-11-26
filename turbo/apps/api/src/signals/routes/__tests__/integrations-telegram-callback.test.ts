import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { DomUtils, parseDocument } from "htmlparser2";
import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { setupRawAppRequest } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { integrationsTelegramRoutes } from "../integrations-telegram";

const context = testContext();
const request = setupRawAppRequest({
  context,
  routes: integrationsTelegramRoutes,
});

const CALLBACK_PATH = "/api/integrations/telegram/auth-callback";
const APP_ORIGIN = "https://app.okou.ai";

interface OpenerWindow {
  closed: boolean;
  readonly posts: { readonly message: unknown; readonly origin: string }[];
  postMessage(message: unknown, origin: string): void;
}

function openerWindow(closed = false): OpenerWindow {
  const posts: { readonly message: unknown; readonly origin: string }[] = [];
  return {
    closed,
    posts,
    postMessage(message, origin) {
      posts.push({ message, origin });
    },
  };
}

/** Telegram's login proof as the widget appends it to the callback URL. */
function telegramProof(): URLSearchParams {
  return new URLSearchParams({
    id: String(randomInt(1_000_000, 9_000_000)),
    first_name: "Ada",
    auth_date: String(Math.floor(now() / 1000)),
    hash: randomBytes(32).toString("hex"),
  });
}

function callbackQuery(targetOrigin = APP_ORIGIN): URLSearchParams {
  return new URLSearchParams({
    callbackProtocol: "2",
    targetOrigin,
    operationId: randomUUID(),
    bot: "official",
  });
}

/**
 * A minimal browser document that runs the callback page's inline script:
 * it records URL replacement, navigation, posted messages, listeners and
 * scheduled browser timers. Timers are only recorded, never run.
 */
function runCallbackPage(
  html: string,
  url: string,
  opener: OpenerWindow | null,
) {
  const parsed = parseDocument(html);
  const scriptElement = DomUtils.findOne(
    (element) => {
      return element.name.toLowerCase() === "script";
    },
    parsed.children,
    true,
  );
  const script = scriptElement ? DomUtils.textContent(scriptElement) : "";
  if (!script) {
    throw new Error("Expected the callback page to carry its script");
  }
  const location = new URL(url, "https://api.okou.ai");
  const replacedUrls: string[] = [];
  const navigations: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const timers = new Set<number>();
  let nextTimer = 1;
  const status = { textContent: "" };
  const settings = { href: "" };
  const schedule = (): number => {
    const id = nextTimer++;
    timers.add(id);
    return id;
  };
  const clear = (id: unknown): void => {
    if (typeof id === "number") {
      timers.delete(id);
    }
  };
  const window = {
    opener,
    location: {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
      replace(next: string) {
        navigations.push(next);
      },
    },
    history: {
      replaceState(_state: unknown, _title: string, next: string) {
        replacedUrls.push(next);
      },
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
      }
    },
    setInterval: schedule,
    setTimeout: schedule,
    clearInterval: clear,
    clearTimeout: clear,
  };
  const document = {
    getElementById(id: string) {
      return id === "status" ? status : settings;
    },
  };
  runInNewContext(script, { window, document, URLSearchParams });
  return {
    replacedUrls,
    navigations,
    listeners,
    timers,
    settings,
    dispatch(type: string, event: unknown = {}) {
      listeners.get(type)?.(event);
    },
  };
}

async function loadCallback(path: string) {
  const response = await request(path, { method: "GET" });
  if (typeof response.body !== "string") {
    throw new Error("Expected the callback page HTML");
  }
  return { status: response.status, html: response.body };
}

test('integrations-telegram-callback-019 fails closed for malformed explicit context {"targetOrigin":"https://evil.example"} and scrubs proof', async () => {
  const opener = openerWindow();
  const path = `${CALLBACK_PATH}?${callbackQuery("https://evil.example").toString()}&${telegramProof().toString()}`;

  const page = await loadCallback(path);
  const browser = runCallbackPage(page.html, path, opener);

  expect(page.status).toBe(422);
  expect(browser.replacedUrls).toStrictEqual([
    `${CALLBACK_PATH}?callbackProtocol=2`,
  ]);
  expect(opener.posts).toStrictEqual([]);
  expect(browser.navigations).toStrictEqual([]);
  expect(browser.listeners.size).toBe(0);
});

test("integrations-telegram-callback-023 discards proof with an absent opener and offers explicit settings", async () => {
  const path = `${CALLBACK_PATH}?${callbackQuery().toString()}&${telegramProof().toString()}`;

  const page = await loadCallback(path);
  const browser = runCallbackPage(page.html, path, null);

  expect(browser.settings.href).toBe(
    `${APP_ORIGIN}/settings/telegram?bot=official`,
  );
  expect(browser.navigations).toStrictEqual([]);
  expect(browser.timers.size).toBe(0);
  expect(browser.listeners.size).toBe(0);
});

test("integrations-telegram-callback-024 discards proof with an closed opener and offers explicit settings", async () => {
  const opener = openerWindow(true);
  const path = `${CALLBACK_PATH}?${callbackQuery().toString()}&${telegramProof().toString()}`;

  const page = await loadCallback(path);
  const browser = runCallbackPage(page.html, path, opener);

  expect(opener.posts).toStrictEqual([]);
  expect(browser.settings.href).toBe(
    `${APP_ORIGIN}/settings/telegram?bot=official`,
  );
  expect(browser.navigations).toStrictEqual([]);
  expect(browser.timers.size).toBe(0);
});

test("integrations-telegram-callback-026 reloading the scrubbed URL cannot recover proof or close as a legacy callback", async () => {
  const opener = openerWindow();
  const path = `${CALLBACK_PATH}?${callbackQuery().toString()}&${telegramProof().toString()}`;
  const first = runCallbackPage((await loadCallback(path)).html, path, opener);
  const [scrubbed] = first.replacedUrls;
  if (scrubbed !== `${CALLBACK_PATH}?callbackProtocol=2`) {
    throw new Error("Expected the first page to scrub its URL");
  }
  first.dispatch("pagehide");
  const postsBeforeReload = opener.posts.length;

  const reloaded = runCallbackPage(
    (await loadCallback(scrubbed)).html,
    scrubbed,
    opener,
  );

  expect(opener.posts.slice(postsBeforeReload)).toStrictEqual([]);
  expect(reloaded.settings.href).toBe(
    "http://localhost:3002/settings/telegram?bot=official",
  );
});
