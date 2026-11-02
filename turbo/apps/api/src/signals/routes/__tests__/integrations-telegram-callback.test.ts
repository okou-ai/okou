import { runInNewContext } from "node:vm";
import type { TelegramAuthCallbackMessage } from "@okouai/api-contracts/contracts/integrations-telegram";
import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-context";
import { integrationsTelegramRoutes } from "../integrations-telegram";

const context = testContext();
const PATH = "/api/integrations/telegram/auth-callback";
const ORIGIN = "https://app.okou.ai";
const OPERATION = "51326918-3b76-4fea-a42f-d8f58e426d9b";
const SETTINGS = `${ORIGIN}/settings/telegram?bot=official`;
const PROOF = Object.freeze({
  id: "123456",
  first_name: "Test",
  auth_date: "1700000000",
  hash: "a".repeat(64),
});
const CONTEXT = Object.freeze({
  targetOrigin: ORIGIN,
  callbackProtocol: "2",
  operationId: OPERATION,
  bot: "official",
});

function callbackUrl(query: Record<string, string> = CONTEXT) {
  return new URL(
    `${PATH}?${new URLSearchParams(query)}`,
    "https://www.okou.ai",
  );
}

// The browser is external to the API. Execute the actual HTTP response using
// browser adapters (as browser.test.ts does for browser-owned JS). These timers
// never replace API timer scheduling or control application-owned internals.
async function browser(
  url: URL,
  openerState: "open" | "closed" | "absent" = "open",
  scrubFails = false,
) {
  const app = createApp({
    signal: context.signal,
    routes: integrationsTelegramRoutes,
  });
  const response = await app.request(url.pathname + url.search);
  const html = await response.text();
  const script = /<script>([\s\S]*?)<\/script>/iu.exec(html)?.[1];
  if (!script) {
    throw new Error("Callback did not return an executable script");
  }
  const messages: { message: unknown; target: string }[] = [];
  const navigation: string[] = [];
  const history: { state: unknown; url: string }[] = [];
  const elements = new Map<string, { textContent: string; href?: string }>();
  for (const match of html.matchAll(
    /<(?:p|a) id="([^"]+)"[^>]*>([^<]*)<\/(?:p|a)>/gu,
  )) {
    if (match[1] && match[2]) {
      elements.set(match[1], { textContent: match[2] });
    }
  }
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const timers = new Map<
    number,
    { callback: () => void; milliseconds: number; repeat: boolean }
  >();
  let nextTimer = 0;
  let browserTime = 0;
  const schedule = (
    callback: () => void,
    milliseconds: number,
    repeat: boolean,
  ) => {
    const id = ++nextTimer;
    timers.set(id, { callback, milliseconds, repeat });
    return id;
  };
  const owner = {
    closed: openerState === "closed",
    postMessage(message: unknown, target: string) {
      messages.push({ message: structuredClone(message), target });
    },
  };
  const window = {
    opener: openerState === "absent" ? null : owner,
    location: {
      get search() {
        return url.search;
      },
      get hash() {
        return url.hash;
      },
      get pathname() {
        return url.pathname;
      },
      replace(destination: string) {
        navigation.push(destination);
      },
    },
    history: {
      replaceState(state: unknown, _title: string, destination: string) {
        if (scrubFails) {
          throw new Error("Browser refused history replacement");
        }
        history.push({ state, url: destination });
        url = new URL(destination, url);
      },
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(listener);
      listeners.set(type, handlers);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    setTimeout: (callback: () => void, milliseconds: number) => {
      return schedule(callback, milliseconds, false);
    },
    setInterval: (callback: () => void, milliseconds: number) => {
      return schedule(callback, milliseconds, true);
    },
    clearTimeout: (id: number) => {
      return timers.delete(id);
    },
    clearInterval: (id: number) => {
      return timers.delete(id);
    },
  };
  runInNewContext(script, {
    window,
    document: {
      getElementById: (id: string) => {
        return elements.get(id);
      },
    },
    URLSearchParams,
    Date: {
      now: () => {
        return browserTime;
      },
    },
  });
  return {
    response,
    messages,
    navigation,
    history,
    owner,
    timers,
    status: () => {
      return elements.get("status")?.textContent;
    },
    settings: () => {
      return elements.get("settings")?.href;
    },
    currentUrl: () => {
      return url.href;
    },
    receive(message: unknown, origin = ORIGIN, source: unknown = owner) {
      for (const listener of listeners.get("message") ?? []) {
        listener({ data: message, origin, source });
      }
    },
    pagehide() {
      for (const listener of listeners.get("pagehide") ?? []) {
        listener({});
      }
    },
    elapse(milliseconds: number) {
      browserTime += milliseconds;
    },
    tick(milliseconds: number) {
      browserTime += milliseconds;
      for (const [id, timer] of timers) {
        if (timer.milliseconds !== milliseconds || !timers.has(id)) {
          continue;
        }
        if (!timer.repeat) {
          timers.delete(id);
        }
        timer.callback();
      }
    },
    listenerCount: () => {
      return [...listeners.values()].reduce((sum, values) => {
        return sum + values.size;
      }, 0);
    },
  };
}

function message(fields: Partial<TelegramAuthCallbackMessage> = {}) {
  return {
    protocol: 2,
    operationId: OPERATION,
    bot: "official",
    type: "telegram-auth-ready",
    ...fields,
  };
}

function authorizedUrl(fragment = false) {
  const url = callbackUrl();
  if (fragment) {
    url.hash = new URLSearchParams(PROOF).toString();
  } else {
    for (const [key, value] of Object.entries(PROOF)) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

describe("Telegram callback HTTP/browser protocol", () => {
  it.each([false, true])(
    "fails closed without explicit callback context (fragment=%s)",
    async (fragment) => {
      const url = authorizedUrl(fragment);
      for (const key of ["callbackProtocol", "operationId", "bot"]) {
        url.searchParams.delete(key);
      }
      const page = await browser(url);
      expect(page.response.status).toBe(422);
      expect(page.messages).toStrictEqual([]);
      expect(page.navigation).toStrictEqual([]);
    },
  );

  it.each([false, true])(
    "scrubs proof and waits for a binding outcome (fragment=%s)",
    async (fragment) => {
      const page = await browser(authorizedUrl(fragment));
      expect(page.response.status).toBe(200);
      expect(page.response.headers.get("cache-control")).toBe("no-store");
      expect(page.response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.currentUrl()).toBe(
        `https://www.okou.ai${PATH}?callbackProtocol=2`,
      );
      expect(page.history).toStrictEqual([
        { state: null, url: `${PATH}?callbackProtocol=2` },
      ]);
      expect(page.messages).toStrictEqual([
        {
          message: message({ type: "telegram-auth-bridge-ready" }),
          target: ORIGIN,
        },
      ]);
      page.receive(message());
      expect(page.messages.at(-1)).toStrictEqual({
        message: message({ type: "telegram-auth", data: PROOF }),
        target: ORIGIN,
      });
      page.receive(message({ type: "telegram-auth-ack", stage: "identity" }));
      expect(page.navigation).toStrictEqual([]);
      page.receive(message({ type: "telegram-auth-result", status: "linked" }));
      expect(page.messages.at(-1)?.message).toStrictEqual(
        message({ type: "telegram-auth-ack", stage: "result" }),
      );
      page.tick(250);
      expect(page.navigation).toStrictEqual([SETTINGS]);
      expect(page.timers.size).toBe(0);
      expect(page.listenerCount()).toBe(0);
    },
  );

  it("retries readiness and unacknowledged identity within the document deadline", async () => {
    const page = await browser(authorizedUrl());
    page.tick(500);
    expect(page.messages).toHaveLength(2);
    page.receive(message());
    const first = page.messages.at(-1);
    page.tick(500);
    expect(page.messages.at(-1)).toStrictEqual(first);
    page.receive(message({ type: "telegram-auth-ack", stage: "identity" }));
    page.receive(message());
    expect(page.messages.at(-1)?.message).toStrictEqual(
      message({ type: "telegram-auth-bridge-ready" }),
    );
    page.pagehide();
    expect(page.timers.size).toBe(0);
    expect(page.listenerCount()).toBe(0);
  });

  it("rejects wrong source, origin, operation, protocol and bot, including ready and ack", async () => {
    const page = await browser(authorizedUrl());
    page.receive(message(), ORIGIN, {});
    page.receive(message(), "https://evil.example");
    page.receive({ ...message(), operationId: "another-operation" });
    page.receive({ ...message(), protocol: 1 });
    page.receive({ ...message(), bot: "other" });
    expect(page.messages).toHaveLength(1);
    page.receive(message());
    for (const input of [
      {
        value: message({ type: "telegram-auth-result", status: "linked" }),
        source: {},
      },
      {
        value: message({ type: "telegram-auth-result", status: "linked" }),
        origin: "https://evil.example",
      },
      {
        value: {
          ...message({ type: "telegram-auth-result", status: "linked" }),
          operationId: "stale",
        },
      },
      {
        value: {
          ...message({ type: "telegram-auth-result", status: "linked" }),
          protocol: "2",
        },
      },
      {
        value: {
          ...message({ type: "telegram-auth-result", status: "linked" }),
          bot: "other",
        },
      },
      {
        value: {
          ...message({ type: "telegram-auth-result" }),
          status: "success",
        },
      },
      {
        value: message({ type: "telegram-auth-ack", stage: "identity" }),
        source: {},
      },
    ]) {
      page.receive(
        input.value,
        input.origin ?? ORIGIN,
        input.source ?? page.owner,
      );
    }
    page.tick(500);
    expect(page.messages.at(-1)?.message).toStrictEqual(
      message({ type: "telegram-auth", data: PROOF }),
    );
    expect(page.navigation).toStrictEqual([]);
    page.pagehide();
  });

  it("accepts an early native-channel binding result and acknowledges duplicates without replay", async () => {
    const page = await browser(authorizedUrl());
    const result = message({ type: "telegram-auth-result", status: "linked" });
    page.receive({
      ...result,
      returnUrl: "https://evil.example",
      hash: "must-not-propagate",
    });
    page.receive(result);
    page.receive(message());
    page.receive(message({ type: "telegram-auth-result", status: "failed" }));
    expect(page.messages).toStrictEqual([
      {
        message: message({ type: "telegram-auth-bridge-ready" }),
        target: ORIGIN,
      },
      {
        message: message({ type: "telegram-auth-ack", stage: "result" }),
        target: ORIGIN,
      },
      {
        message: message({ type: "telegram-auth-ack", stage: "result" }),
        target: ORIGIN,
      },
    ]);
    page.tick(250);
    page.receive(result);
    expect(page.navigation).toStrictEqual([SETTINGS]);
  });

  it.each([
    "cancelled",
    "failed",
    "conflict",
    "expired",
    "interrupted",
    "prerequisite",
  ] as const)(
    "shows sanitized %s guidance without success navigation",
    async (status) => {
      const page = await browser(authorizedUrl());
      page.receive({
        ...message({ type: "telegram-auth-result", status }),
        error: "secret https://evil.example/?hash=payload",
      });
      page.tick(250);
      expect(page.navigation).toStrictEqual([]);
      expect(page.status()).not.toContain("secret");
      expect(page.settings()).toBe(SETTINGS);
      expect(page.listenerCount()).toBe(0);
      expect(page.timers.size).toBe(0);
    },
  );

  it.each([
    { callbackProtocol: "3" },
    { callbackProtocol: "" },
    { operationId: "" },
    { bot: "other" },
    { bot: "" },
    { targetOrigin: "https://evil.example" },
    { targetOrigin: `${ORIGIN}/path` },
    { targetOrigin: "" },
  ])(
    "fails closed for malformed explicit context %j and scrubs proof",
    async (invalid) => {
      const page = await browser(
        callbackUrl({ ...CONTEXT, ...PROOF, ...invalid }),
      );
      expect(page.response.status).toBe(422);
      expect(page.currentUrl()).toBe(
        `https://www.okou.ai${PATH}?callbackProtocol=2`,
      );
      expect(page.messages).toStrictEqual([]);
      expect(page.navigation).toStrictEqual([]);
      expect(page.listenerCount()).toBe(0);
    },
  );

  it("rejects duplicate context and duplicate provider proof", async () => {
    const duplicateContext = authorizedUrl();
    duplicateContext.searchParams.append("callbackProtocol", "2");
    const rejected = await browser(duplicateContext);
    expect(rejected.response.status).toBe(422);
    expect(rejected.messages).toStrictEqual([]);
    const duplicateProof = authorizedUrl();
    duplicateProof.searchParams.append("hash", "b".repeat(64));
    const interrupted = await browser(duplicateProof);
    expect(interrupted.messages).toStrictEqual([]);
  });

  it.each(["absent", "closed"] as const)(
    "discards proof with an %s opener and offers explicit settings",
    async (state) => {
      const page = await browser(authorizedUrl(), state);
      expect(page.messages).toStrictEqual([]);
      expect(page.settings()).toBe(SETTINGS);
      expect(page.navigation).toStrictEqual([]);
      expect(page.timers.size).toBe(0);
    },
  );

  it("interrupts on opener closure and ignores late results after timeout", async () => {
    const closed = await browser(authorizedUrl());
    closed.owner.closed = true;
    closed.tick(500);
    expect(closed.timers.size).toBe(0);
    const timedOut = await browser(authorizedUrl());
    timedOut.receive(message());
    timedOut.tick(120_000);
    timedOut.receive(
      message({ type: "telegram-auth-result", status: "linked" }),
    );
    timedOut.tick(500);
    expect(timedOut.navigation).toStrictEqual([]);
    expect(timedOut.timers.size).toBe(0);
    expect(timedOut.listenerCount()).toBe(0);
  });

  it("reloading the scrubbed URL cannot recover proof or close as a legacy callback", async () => {
    const first = await browser(authorizedUrl());
    first.pagehide();
    const reload = await browser(new URL(first.currentUrl()));
    expect(reload.messages).toStrictEqual([]);
    expect(reload.settings()).toBe(
      "http://localhost:3002/settings/telegram?bot=official",
    );
  });

  it("rejects a late result even when the browser has throttled its timers", async () => {
    const page = await browser(authorizedUrl());
    page.elapse(120_001);
    page.receive(message({ type: "telegram-auth-result", status: "linked" }));
    expect(page.navigation).toStrictEqual([]);
    expect(page.timers.size).toBe(0);
  });

  it("does not deliver identity if history scrubbing is unavailable", async () => {
    const page = await browser(authorizedUrl(), "open", true);
    expect(page.messages).toStrictEqual([]);
    expect(page.timers.size).toBe(0);
  });
});
