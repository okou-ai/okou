import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";

import { server } from "../../../mocks/server";
import { subscriptionCommand } from "../index";

const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
function account(
  id = A,
  overrides: Partial<ModelProviderResponse> = {},
): ModelProviderResponse {
  return {
    id,
    type: "codex-oauth-token",
    framework: "codex",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    isActive: id === A,
    accountEmail: `${id}@example.test`,
    planType: "pro",
    needsReconnect: false,
    lastRefreshErrorCode: null,
    subscriptionResetSupported: true,
    subscriptionResetCredits: 3,
    subscriptionResetCreditsNextExpiresAt: "2026-11-01T00:00:00.000Z",
    subscriptionUsage: {
      fiveHour: {
        usedPercent: 75,
        remainingPercent: 25,
        resetAt: "2026-10-05T22:00:00.000Z",
        windowSeconds: 18000,
      },
      weekly: {
        usedPercent: 40,
        remainingPercent: 60,
        resetAt: "2026-10-10T00:00:00.000Z",
        windowSeconds: 604800,
      },
    },
    ...overrides,
  };
}

const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
  vi.stubEnv("OKOU_TOKEN", "test-token");
  log.mockClear();
  error.mockClear();
  for (const command of subscriptionCommand.commands) {
    command.setOptionValue("json", false);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function output() {
  return log.mock.calls.flat().join("\n");
}

describe("okou subscription", () => {
  it("lists every account with provider counts, live windows, and remaining reset credits", async () => {
    server.use(
      http.get("http://localhost:3000/api/me/model-providers", () => {
        return HttpResponse.json({
          modelProviders: [
            account(),
            account(B),
            account("10000000-0000-4000-8000-000000000003", {
              type: "claude-code-oauth-token",
              framework: "claude-code",
              subscriptionResetSupported: false,
              subscriptionResetCredits: null,
            }),
          ],
        });
      }),
    );
    await subscriptionCommand.parseAsync(["node", "okou", "list", "--json"]);
    const result = JSON.parse(output());
    expect(result.counts).toEqual({ total: 3, claudeCode: 1, codex: 2 });
    expect(result.subscriptions).toHaveLength(3);
    expect(result.subscriptions[0]).toMatchObject({
      id: A,
      active: true,
      resetCredits: 3,
      resetCreditsNextExpiresAt: "2026-11-01T00:00:00.000Z",
      usage: { fiveHour: { remainingPercent: 25 } },
    });
    expect(result.subscriptions[2]).toMatchObject({
      resetSupported: false,
      resetCredits: null,
    });
  });

  it("prints useful human-readable detail and preserves unknown values", async () => {
    server.use(
      http.get(`http://localhost:3000/api/me/subscriptions/${A}`, () => {
        return HttpResponse.json(
          account(A, {
            subscriptionResetCredits: null,
            subscriptionUsage: {
              fiveHour: null,
              weekly: account().subscriptionUsage?.weekly ?? null,
            },
          }),
        );
      }),
    );
    await subscriptionCommand.parseAsync(["node", "okou", "show", A]);
    expect(output()).toContain(
      "5-hour: used unknown, remaining unknown; reset unknown",
    );
    expect(output()).toContain("Weekly: used 40%, remaining 60%");
    expect(output()).toContain("remaining reset credits: unknown");
  });

  it("creates an exact-account user-confirmed link without calling reset", async () => {
    let resetRequests = 0;
    server.use(
      http.get(`http://localhost:3000/api/me/subscriptions/${A}`, () => {
        return HttpResponse.json(account());
      }),
      http.post(
        "http://localhost:3000/api/me/model-provider-accounts/:id/subscription-reset",
        () => {
          resetRequests += 1;
          return HttpResponse.json({ outcome: "reset" });
        },
      ),
    );
    await subscriptionCommand.parseAsync([
      "node",
      "okou",
      "reset-link",
      A,
      "--json",
    ]);
    const result = JSON.parse(output());
    const url = new URL(result.url);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe(`/subscriptions/${A}/reset`);
    expect(url.searchParams.get("idempotencyKey")).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.requiresUserConfirmation).toBe(true);
    expect(resetRequests).toBe(0);
  });

  it("switches the exact account and explains that current runs and other providers are unchanged", async () => {
    server.use(
      http.post(
        `http://localhost:3000/api/me/model-provider-accounts/${B}/activate`,
        async ({ request }) => {
          expect(await request.json()).toEqual({});
          return HttpResponse.json(account(B, { isActive: true }));
        },
      ),
    );
    await subscriptionCommand.parseAsync([
      "node",
      "okou",
      "switch",
      B,
      "--json",
    ]);
    const result = JSON.parse(output());
    expect(result.subscription).toMatchObject({ id: B, active: true });
    expect(result.effect).toContain("subsequent runs");
    expect(result.effect).toContain(
      "running runs keep their captured subscription",
    );
    expect(result.effect).toContain("other providers are unchanged");
  });

  it("rejects unsupported Claude Code reset and surfaces the remediation", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process-exit");
    });
    server.use(
      http.get(`http://localhost:3000/api/me/subscriptions/${A}`, () => {
        return HttpResponse.json(
          account(A, {
            type: "claude-code-oauth-token",
            subscriptionResetSupported: false,
          }),
        );
      }),
    );
    try {
      await expect(
        subscriptionCommand.parseAsync(["node", "okou", "reset-link", A]),
      ).rejects.toThrow("process-exit");
      expect(error.mock.calls.flat().join("\n")).toContain(
        "Manual reset is unavailable",
      );
      expect(output()).toBe("");
    } finally {
      exit.mockRestore();
    }
  });

  it("guides an empty subscription list to Personal Models", async () => {
    server.use(
      http.get("http://localhost:3000/api/me/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );
    await subscriptionCommand.parseAsync(["node", "okou", "list"]);
    expect(output()).toContain("Subscriptions: 0");
    expect(output()).toContain(
      "Connect a subscription in Preferences / Personal Models",
    );
  });
});
