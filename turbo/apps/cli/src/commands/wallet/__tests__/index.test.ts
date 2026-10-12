import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";

import { server } from "../../../mocks/server";
import { walletCommand } from "../index";

const output = vi.spyOn(console, "log").mockImplementation(() => {});
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
const exit = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit called");
}) as never);
const origin = "http://localhost:3000";
const id = randomUUID();
const intentId = randomUUID();
const context =
  "Preparing the explicitly requested paperback purchase from Example Books, including all shipping and taxes within the customer's approved budget.";
const spend = {
  id,
  intentId,
  status: "pending_approval",
  amount: 3500,
  currency: "usd",
  merchantName: "Example Books",
  merchantUrl: "https://books.example.test",
  context,
  test: true,
  approvalUrl:
    "https://app.link.com/activity/approve/lsrq_example?approval=keep-exact",
  expiresAt: "2026-10-12T08:00:00.000Z",
  nextAction: "wait_for_user",
  action: null,
};

beforeEach(() => {
  vi.stubEnv("OKOU_API_BACKEND_URL", origin);
  vi.stubEnv("OKOU_TOKEN", "test-token");
});
afterEach(() => {
  output.mockClear();
  errors.mockClear();
  exit.mockClear();
  vi.unstubAllEnvs();
});

async function run(args: readonly string[]) {
  await walletCommand.parseAsync(["node", "cli", ...args]);
}

describe("okou wallet", () => {
  it("prints wallet status and makes checkout limitations explicit", async () => {
    server.use(
      http.get(`${origin}/api/wallet/status`, () => {
        return HttpResponse.json({
          connected: false,
          nextAction: "connect",
          checkoutAvailable: false,
        });
      }),
    );
    await run(["status", "--json"]);
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        connected: false,
        nextAction: "connect",
        checkoutAvailable: false,
      }),
    );
  });
  it("preserves the full Link consent URL and ends the turn", async () => {
    const url =
      "https://login.link.com/auth?client_id=example&state=keep-me&code_challenge=keep-me-too";
    server.use(
      http.post(`${origin}/api/wallet/connect`, () => {
        return HttpResponse.json({ url, expiresAt: spend.expiresAt });
      }),
    );
    await run(["connect"]);
    expect(output).toHaveBeenCalledWith(url);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("end the turn"),
    );
  });
  it("uses integer cents, an explicit stable intent and test mode without exposing extra provider fields", async () => {
    let requestBody: unknown;
    server.use(
      http.post(`${origin}/api/wallet/spend`, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          ...spend,
          card: { number: "fixture-pan", cvc: "fixture-cvc" },
          access_token: "fixture-access-token",
        });
      }),
    );
    await run([
      "spend",
      "create",
      "--intent-id",
      intentId,
      "--amount",
      "3500",
      "--merchant-name",
      spend.merchantName,
      "--merchant-url",
      spend.merchantUrl,
      "--context",
      context,
      "--test",
      "--json",
    ]);
    expect(requestBody).toEqual({
      intentId,
      amount: 3500,
      currency: "usd",
      merchantName: spend.merchantName,
      merchantUrl: spend.merchantUrl,
      context,
      test: true,
    });
    expect(output).toHaveBeenCalledWith(JSON.stringify(spend));
    expect(JSON.stringify(output.mock.calls)).not.toMatch(
      /fixture-pan|fixture-cvc|fixture-access-token/,
    );
  });
  it("presents the exact per-purchase approval link without reporting payment", async () => {
    server.use(
      http.get(`${origin}/api/wallet/spend/${id}`, () => {
        return HttpResponse.json(spend);
      }),
    );
    await run(["spend", "get", id]);
    expect(output).toHaveBeenCalledWith(spend.approvalUrl);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("user must approve personally"),
    );
  });
  it("does not describe an approved request as a paid purchase", async () => {
    server.use(
      http.get(`${origin}/api/wallet/spend/${id}`, () => {
        return HttpResponse.json({
          ...spend,
          status: "approved",
          approvalUrl: null,
          nextAction: "secure_checkout_unavailable",
        });
      }),
    );
    await run(["spend", "get", id]);
    expect(output).toHaveBeenCalledWith(
      "Approved is not paid. Managed checkout and credential retrieval are not available.",
    );
  });
  it("cancels through the managed backend and prints the result", async () => {
    const result = {
      ...spend,
      status: "canceled",
      approvalUrl: null,
      nextAction: "stop",
    };
    server.use(
      http.post(`${origin}/api/wallet/spend/${id}/cancel`, () => {
        return HttpResponse.json(result);
      }),
    );
    await run(["spend", "cancel", id, "--json"]);
    expect(output).toHaveBeenCalledWith(JSON.stringify(result));
  });
  it("reports an unavailable backend instead of making up an authorization link", async () => {
    server.use(
      http.post(`${origin}/api/wallet/connect`, () => {
        return HttpResponse.json(
          {
            error: {
              code: "WALLET_DISABLED",
              message: "Link wallet is not enabled",
            },
          },
          { status: 403 },
        );
      }),
    );
    await expect(run(["connect", "--json"])).rejects.toThrow(
      "process.exit called",
    );
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("Link wallet is not enabled"),
    );
    expect(output).not.toHaveBeenCalled();
  });
  it("explains the consent/approval distinction and refuses alternate credential retrieval in its guide", async () => {
    await run(["guide"]);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("OAuth consent authorizes this user's wallet"),
    );
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining(
        "Never retrieve a card or token through an alternate tool",
      ),
    );
  });
});
