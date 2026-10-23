import { expect, test, vi } from "vitest";

import {
  appendPreviewBypassToUrl,
  buildPreviewBypassCookie,
  writePreviewBypassCookie,
} from "../preview-bypass-cookie.ts";

test("A protected preview link creates a secure cookie on its preview host", () => {
  expect(
    buildPreviewBypassCookie({
      hostname: "pr-123-app.omby.ai",
      protocol: "https:",
      search: "?x-vercel-protection-bypass=preview-secret",
    }),
  ).toBe(
    "x-vercel-protection-bypass=preview-secret; Path=/; Max-Age=3600; SameSite=Lax; Secure",
  );
});

test("A preview credential is written for the current preview host", () => {
  const setCookie = vi.fn<(cookie: string) => void>();

  expect(
    writePreviewBypassCookie(
      {
        hostname: "staging-app.omby.ai",
        protocol: "https:",
        search: "?x-vercel-protection-bypass=preview%20secret",
      },
      setCookie,
    ),
  ).toBeTruthy();
  expect(setCookie).toHaveBeenCalledWith(
    "x-vercel-protection-bypass=preview%20secret; Path=/; Max-Age=3600; SameSite=Lax; Secure",
  );
});

test("A protected preview link works in local HTTP development", () => {
  expect(
    buildPreviewBypassCookie({
      hostname: "localhost",
      protocol: "http:",
      search: "?x-vercel-protection-bypass=preview-secret",
    }),
  ).toBe(
    "x-vercel-protection-bypass=preview-secret; Path=/; Max-Age=3600; SameSite=Lax",
  );
});

test.each([
  ["pr-22085-app.omby.ai", "pr-22085-api.vm6.ai"],
  [
    "pr-22085-app-okou-app-preview.vm0.workers.dev",
    "okou-api-preview-pr-22085.vm0.workers.dev",
  ],
])(
  "A preview credential from %s reaches its matching API host",
  (hostname, apiHostname) => {
    const location = {
      hostname,
      protocol: "https:",
      search: "",
    };
    const cookie = "x-vercel-protection-bypass=preview%20secret";
    const apiUrl = new URL(`https://${apiHostname}/api/chat/events`);

    appendPreviewBypassToUrl(apiUrl, location, cookie);

    expect(apiUrl.searchParams.get("x-vercel-protection-bypass")).toBe(
      "preview secret",
    );
  },
);

test.each([
  ["pr-22085-app.omby.ai", "pr-22085-api.vm6.ai.evil.example"],
  [
    "pr-22085-app-okou-app-preview.vm0.workers.dev",
    "okou-api-preview-pr-22085.vm0.workers.dev.evil.example",
  ],
])(
  "A preview credential from %s does not reach a lookalike API host",
  (hostname, apiHostname) => {
    const location = {
      hostname,
      protocol: "https:",
      search: "",
    };
    const cookie = "x-vercel-protection-bypass=preview%20secret";
    const lookalikeUrl = new URL(`https://${apiHostname}/api/chat/events`);

    appendPreviewBypassToUrl(lookalikeUrl, location, cookie);

    expect(
      lookalikeUrl.searchParams.has("x-vercel-protection-bypass"),
    ).toBeFalsy();
  },
);

test.each([
  ["pr-22085-app.omby.ai", "pr-22086-api.vm6.ai"],
  [
    "pr-22085-app-okou-app-preview.vm0.workers.dev",
    "okou-api-preview-pr-22086.vm0.workers.dev",
  ],
])(
  "A preview credential from %s does not reach another preview API host",
  (hostname, apiHostname) => {
    const location = {
      hostname,
      protocol: "https:",
      search: "",
    };
    const cookie = "x-vercel-protection-bypass=preview%20secret";
    const otherPreviewUrl = new URL(`https://${apiHostname}/api/chat/events`);

    appendPreviewBypassToUrl(otherPreviewUrl, location, cookie);

    expect(
      otherPreviewUrl.searchParams.has("x-vercel-protection-bypass"),
    ).toBeFalsy();
  },
);

test("A preview credential does not reach the matching WWW host", () => {
  const location = {
    hostname: "pr-22085-app.omby.ai",
    protocol: "https:",
    search: "",
  };
  const cookie = "x-vercel-protection-bypass=preview%20secret";
  const wwwUrl = new URL(
    "https://pr-22085-www.vm6.ai/connector/success?x-vercel-protection-bypass=stale",
  );

  appendPreviewBypassToUrl(wwwUrl, location, cookie);

  expect(wwwUrl.searchParams.has("x-vercel-protection-bypass")).toBeFalsy();
});
