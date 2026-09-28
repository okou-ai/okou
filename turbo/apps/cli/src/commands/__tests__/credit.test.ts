import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../mocks/server";
import { creditCommand } from "../credit";

function buildOkouToken(capabilities: readonly string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      userId: "user-credit",
      runId: "run-credit",
      orgId: "org-credit",
      scope: "okou",
      capabilities,
      iat: 1000,
      exp: 2000,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

function stubBillingStatus(
  overrides: {
    readonly tier?: string;
    readonly canBuyCredits?: boolean;
    readonly videoGenerationAllowed?: boolean;
  } = {},
) {
  return http.get("http://localhost:3000/api/billing/status", () => {
    return HttpResponse.json({
      showUsagePack: false,
      tier: overrides.tier ?? "pro",
      canBuyCredits: overrides.canBuyCredits ?? true,
      videoGenerationAllowed: overrides.videoGenerationAllowed ?? true,
      credits: 12345,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-02-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: {
        enabled: true,
        threshold: 5000,
        amount: 20000,
      },
      creditExpiry: {
        expiringNextCycle: 0,
        nextExpiryDate: null,
      },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 1,
      concurrencySubscriptions: [],
    });
  });
}

describe("okou credit command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    server.use(stubBillingStatus());
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  it("shows current credit status without creating checkout", async () => {
    server.use(stubBillingStatus());

    await creditCommand.parseAsync(["node", "cli"]);

    expect(output()).toContain("Credit status:");
    expect(output()).toContain("Tier: pro");
    expect(output()).toContain("Available credits: 12,345");
    expect(output()).toContain("Auto-recharge: enabled");
    expect(output()).toContain("Threshold: 5,000");
    expect(output()).toContain("Amount: 20,000");
    expect(output()).toContain("Can purchase credits: yes");
    expect(output()).not.toContain("Built-in video generation:");
  });

  it("surfaces the admin-only checkout rejection for non-admins", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    server.use(
      http.post("http://localhost:3000/api/billing/credit-checkout", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Only org admins can buy credits",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    try {
      await creditCommand.parseAsync(["node", "cli", "20000"]);

      const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorOutput).toContain("Only org admins can buy credits");
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("creates a credit checkout link for admins", async () => {
    let capturedBody: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/billing/credit-checkout",
        async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({
            url: "https://checkout.stripe.com/session/credit",
          });
        },
      ),
    );

    await creditCommand.parseAsync([
      "node",
      "cli",
      "20000",
      "--auto-recharge",
      "--auto-recharge-threshold",
      "5000",
      "--auto-recharge-amount",
      "20000",
    ]);

    expect(capturedBody).toMatchObject({
      credits: 20_000,
      autoRecharge: {
        enabled: true,
        threshold: 5000,
        amount: 20_000,
      },
    });
    expect(output()).toContain("https://checkout.stripe.com/session/credit");
  });

  it("routes plans that cannot buy credits to the upgrade link", async () => {
    let checkoutRequests = 0;
    server.use(
      stubBillingStatus({
        tier: "limited-free-1",
        canBuyCredits: false,
        videoGenerationAllowed: false,
      }),
      http.post("http://localhost:3000/api/billing/credit-checkout", () => {
        checkoutRequests += 1;
        return HttpResponse.json({
          url: "https://checkout.stripe.com/should-not-open",
        });
      }),
    );

    await creditCommand.parseAsync(["node", "cli", "20000"]);

    expect(output()).toContain(
      "Credit purchases are not available for this workspace plan.",
    );
    expect(output()).toContain(
      "http://localhost:3000/?settings=billing&billingView=plans",
    );
    expect(checkoutRequests).toBe(0);
  });

  it("rejects auto-recharge threshold without the auto-recharge flag", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      await creditCommand.parseAsync([
        "node",
        "cli",
        "20000",
        "--auto-recharge-threshold",
        "5000",
        "--auto-recharge-amount",
        "20000",
      ]);

      const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorOutput).toContain(
        "--auto-recharge-threshold and --auto-recharge-amount require --auto-recharge",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("rejects okou-token credit status without billing:read", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.stubEnv("OKOU_TOKEN", buildOkouToken(["billing:write"]));

    try {
      await creditCommand.parseAsync(["node", "cli"]);

      const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorOutput).toContain(
        "checking credit status requires billing:read capability",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("rejects okou-token credit checkout without billing:write", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.stubEnv("OKOU_TOKEN", buildOkouToken(["billing:read"]));

    try {
      await creditCommand.parseAsync(["node", "cli", "20000"]);

      const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
      expect(errorOutput).toContain(
        "buying credits requires billing:write capability",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });
});
