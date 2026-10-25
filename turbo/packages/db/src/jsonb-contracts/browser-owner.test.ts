import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseBrowserOwnerWindows } from "./browser-owner";

describe("persisted Browser window authority", () => {
  it("retains an old closing lifetime alongside its chat's replacement", () => {
    const chatThreadId = randomUUID();
    const previous = randomUUID();
    const current = randomUUID();
    const windows = {
      [previous]: {
        chatThreadId,
        state: "closing",
        expiresAt: 1000,
        primaryWindowId: 1,
        primaryTargetId: "old-page",
      },
      [current]: {
        chatThreadId,
        state: "active",
        expiresAt: 2000,
        primaryWindowId: 2,
        primaryTargetId: "new-page",
      },
    };
    expect(parseBrowserOwnerWindows(windows)).toStrictEqual(windows);
  });

  it("rejects ambiguous live lifetimes instead of choosing one", () => {
    const window = {
      chatThreadId: randomUUID(),
      state: "active",
      expiresAt: 1000,
      primaryWindowId: 1,
      primaryTargetId: "page",
    };
    expect(() => {
      return parseBrowserOwnerWindows({
        [randomUUID()]: window,
        [randomUUID()]: {
          ...window,
          primaryWindowId: 2,
          primaryTargetId: "other",
        },
      });
    }).toThrow("Ambiguous");
  });

  it("requires an actual active page identity and numeric expiry", () => {
    const window = {
      chatThreadId: randomUUID(),
      state: "active",
      expiresAt: 1000,
      primaryWindowId: 1,
      primaryTargetId: "page",
    };
    for (const invalid of [
      { ...window, primaryWindowId: null, primaryTargetId: null },
      { ...window, primaryTargetId: null },
      { ...window, expiresAt: "1000" },
      { ...window, state: "unknown" },
    ]) {
      expect(() => {
        return parseBrowserOwnerWindows({ [randomUUID()]: invalid });
      }).toThrow();
    }
    expect(() => {
      return parseBrowserOwnerWindows({ unknown: window });
    }).toThrow("generation");
  });
});
