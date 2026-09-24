import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";
import { server } from "../../../mocks/server";
import { creditCommand } from "../credit";

function stubOrg(overrides: { readonly name?: string } = {}) {
  return http.get("http://localhost:3000/api/org", () => {
    return HttpResponse.json({
      id: "org-doctor",
      slug: "doctor-org",
      name: overrides.name ?? "Doctor Workspace",
      tier: "pro",
    });
  });
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
      autoRecharge: { enabled: true, threshold: 5000, amount: 20000 },
      creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
      creditBreakdown: [],
      creditGrants: [],
      concurrencyLimit: 1,
      concurrencySubscriptions: [],
    });
  });
}

describe("okou doctor credit command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_APP_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    server.use(stubOrg(), stubBillingStatus());
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  function output(): string {
    return mockConsoleLog.mock.calls.flat().join("\n");
  }

  async function runDoctorCredit(): Promise<void> {
    await creditCommand.parseAsync(["node", "cli"]);
  }

  it("reports workspace, tier, credits and plan purchase eligibility", async () => {
    await runDoctorCredit();

    expect(output()).toContain("Credit diagnostics:");
    expect(output()).toContain("Workspace: Doctor Workspace");
    expect(output()).toContain("Tier: pro");
    expect(output()).toContain("Available credits: 12,345");
    expect(output()).toContain("Plan can purchase credits: yes");
    expect(output()).not.toContain("Built-in video generation:");
    expect(output()).toContain("Auto-recharge: enabled");
    expect(output()).toContain("Threshold: 5,000");
    expect(output()).toContain("Amount: 20,000");
    expect(output()).toContain("`okou credit <credits>`");
  });

  it("does not request org members", async () => {
    let memberRequests = 0;
    server.use(
      http.get("http://localhost:3000/api/org/members", () => {
        memberRequests += 1;
        return HttpResponse.json(
          {
            error: {
              message: "This endpoint is not available for sandbox tokens",
              code: "FORBIDDEN",
            },
          },
          { status: 403 },
        );
      }),
    );

    await runDoctorCredit();

    expect(memberRequests).toBe(0);
    expect(output()).toContain("Credit diagnostics:");
  });

  it("routes plans that cannot buy credits to the upgrade link", async () => {
    server.use(
      stubBillingStatus({
        tier: "limited-free-1",
        canBuyCredits: false,
        videoGenerationAllowed: false,
      }),
    );

    await runDoctorCredit();

    expect(output()).toContain("Plan can purchase credits: no");
    expect(output()).not.toContain("Built-in video generation:");
    expect(output()).toContain("This workspace plan cannot buy credits");
    expect(output()).toContain(
      "http://localhost:3000/?settings=billing&billingView=plans",
    );
  });

  it("points free-tier workspaces at both upgrade and credit purchase", async () => {
    server.use(stubBillingStatus({ tier: "free" }));

    await runDoctorCredit();

    expect(output()).toContain("Tier: free");
    expect(output()).toContain("upgrade to Pro");
    expect(output()).toContain("`okou credit <credits>`");
  });
});
