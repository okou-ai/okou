import { describe, expect, it } from "vitest";

import { browserSessionChangedPayloadSchema } from "./realtime";
import { browserContract } from "./browser";

const threadId = "22222222-2222-4222-8222-222222222222";

function browserResponse() {
  return {
    browser: {
      threadId,
      name: "browser",
      status: "active",
      viewerUrl: `https://app.okou.ai/browsers/${threadId}`,
      liveUrl: "https://live.browser.example",
      screenshotUrl: null,
      proxyCountryCode: null,
      timeoutMinutes: 240,
      idleExpiresAt: "2026-07-30T01:10:00.000Z",
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-07-30T01:00:00.000Z",
      updatedAt: "2026-07-30T01:00:00.000Z",
    },
    cdpUrl: "wss://cdp.browser.example",
  };
}

describe("managed browser contracts", () => {
  it("parses a thread-keyed browser response", () => {
    const parsed = browserContract.use.responses[200].parse(browserResponse());

    expect(parsed.browser).toMatchObject({
      threadId,
    });
  });

  it("parses a thread-keyed realtime payload", () => {
    expect(
      browserSessionChangedPayloadSchema.parse({ threadId }),
    ).toStrictEqual({
      threadId,
    });
  });
});
