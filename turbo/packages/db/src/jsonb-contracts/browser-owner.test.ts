import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseBrowserOwnerWindows } from "./browser-owner";

describe("persisted Browser window authority", () => {
  it("retains an old closing session alongside its chat's replacement, including native window zero", () => {
    const chatThreadId = randomUUID();
    const windows = {
      [randomUUID()]: {
        chatThreadId,
        state: "closing",
        expiresAt: 1000,
        primaryWindowId: 0,
        auxiliaryWindowIds: [1],
      },
      [randomUUID()]: {
        chatThreadId,
        state: "active",
        expiresAt: 2000,
        primaryWindowId: 2,
        auxiliaryWindowIds: [3, 4],
      },
    };
    expect(parseBrowserOwnerWindows(windows)).toStrictEqual(windows);
  });

  it("rejects ambiguous live chat sessions instead of choosing one", () => {
    const window = {
      chatThreadId: randomUUID(),
      state: "active",
      expiresAt: 1000,
      primaryWindowId: 0,
      auxiliaryWindowIds: [],
    };
    expect(() => {
      return parseBrowserOwnerWindows({
        [randomUUID()]: window,
        [randomUUID()]: { ...window, primaryWindowId: 2 },
      });
    }).toThrow("Ambiguous");
  });

  it("requires valid native window bindings, session identity and numeric expiry", () => {
    const window = {
      chatThreadId: randomUUID(),
      state: "active",
      expiresAt: 1000,
      primaryWindowId: 0,
      auxiliaryWindowIds: [],
    };
    for (const invalid of [
      { ...window, primaryWindowId: null },
      { ...window, primaryWindowId: -1 },
      { ...window, primaryWindowId: 0.5 },
      { ...window, auxiliaryWindowIds: [Number.MAX_SAFE_INTEGER + 1] },
      { ...window, auxiliaryWindowIds: [0] },
      { ...window, auxiliaryWindowIds: [1, 1] },
      {
        ...window,
        state: "closing",
        primaryWindowId: null,
        auxiliaryWindowIds: [1],
      },
      { ...window, state: "creating", auxiliaryWindowIds: [1] },
      { ...window, expiresAt: "1000" },
      { ...window, state: "unknown" },
    ]) {
      expect(() => {
        return parseBrowserOwnerWindows({ [randomUUID()]: invalid });
      }).toThrow();
    }
    expect(() => {
      return parseBrowserOwnerWindows({ unknown: window });
    }).toThrow("session");
  });

  it("keeps primary and auxiliary windows exclusive even during unfinished cleanup", () => {
    const previous = {
      chatThreadId: randomUUID(),
      state: "closing",
      expiresAt: 1000,
      primaryWindowId: 0,
      auxiliaryWindowIds: [1],
    };
    for (const bindings of [
      { primaryWindowId: 0, auxiliaryWindowIds: [] },
      { primaryWindowId: 1, auxiliaryWindowIds: [] },
      { primaryWindowId: 2, auxiliaryWindowIds: [0] },
      { primaryWindowId: 2, auxiliaryWindowIds: [1] },
    ]) {
      expect(() => {
        return parseBrowserOwnerWindows({
          [randomUUID()]: previous,
          [randomUUID()]: { ...previous, ...bindings, state: "active" },
        });
      }).toThrow("Ambiguous Browser owner native window");
    }
  });
});
