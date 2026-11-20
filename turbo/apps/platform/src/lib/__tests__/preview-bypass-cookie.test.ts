import { expect, test } from "vitest";

import {
  appendPreviewBypassToUrl,
  buildPreviewBypassCookie,
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

test("A preview credential reaches its matching API host", () => {
  const location = {
    hostname: "pr-22085-app.omby.ai",
    protocol: "https:",
    search: "",
  };
  const cookie = "x-vercel-protection-bypass=preview%20secret";
  const apiUrl = new URL("https://pr-22085-api.vm6.ai/api/chat/events");

  appendPreviewBypassToUrl(apiUrl, location, cookie);

  expect(apiUrl.searchParams.get("x-vercel-protection-bypass")).toBe(
    "preview secret",
  );
});

test("A preview credential does not reach a lookalike API host", () => {
  const location = {
    hostname: "pr-22085-app.omby.ai",
    protocol: "https:",
    search: "",
  };
  const cookie = "x-vercel-protection-bypass=preview%20secret";
  const lookalikeUrl = new URL(
    "https://pr-22085-api.vm6.ai.evil.example/api/chat/events",
  );

  appendPreviewBypassToUrl(lookalikeUrl, location, cookie);

  expect(
    lookalikeUrl.searchParams.has("x-vercel-protection-bypass"),
  ).toBeFalsy();
});

test("A preview credential does not reach another preview API host", () => {
  const location = {
    hostname: "pr-22085-app.omby.ai",
    protocol: "https:",
    search: "",
  };
  const cookie = "x-vercel-protection-bypass=preview%20secret";
  const otherPreviewUrl = new URL(
    "https://pr-22086-api.vm6.ai/api/chat/events",
  );

  appendPreviewBypassToUrl(otherPreviewUrl, location, cookie);

  expect(
    otherPreviewUrl.searchParams.has("x-vercel-protection-bypass"),
  ).toBeFalsy();
});

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
