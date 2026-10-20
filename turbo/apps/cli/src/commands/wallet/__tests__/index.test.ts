import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let tempDir: string;
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
  createdAt: "2026-10-12T07:30:00.000Z",
  approvalUrl:
    "https://app.link.com/activity/approve/lsrq_example?approval=keep-exact",
  expiresAt: "2026-10-12T08:00:00.000Z",
  autoContinue: false,
  nextAction: "wait_for_user",
  action: null,
};

beforeEach(async () => {
  vi.stubEnv("OKOU_API_BACKEND_URL", origin);
  vi.stubEnv("OKOU_TOKEN", "test-token");
  tempDir = await mkdtemp(join(tmpdir(), "okou-wallet-test-"));
  const reset = (command: Command) => {
    for (const option of [
      "json",
      "startDate",
      "endDate",
      "startingAfter",
      "limit",
      "status",
      "mode",
      "category",
      "origin",
    ]) {
      command.setOptionValue(option, undefined);
    }
    command.commands.forEach(reset);
  };
  reset(walletCommand);
  const credentials = walletCommand.commands
    .find((command) => {
      return command.name() === "spend";
    })
    ?.commands.find((command) => {
      return command.name() === "credentials";
    });
  credentials?.setOptionValue("json", false);
  credentials?.setOptionValue("outputFile", undefined);
});
afterEach(async () => {
  output.mockClear();
  errors.mockClear();
  exit.mockClear();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

async function run(args: readonly string[]) {
  await walletCommand.parseAsync(["node", "cli", ...args]);
}

function credentialDownload(value: unknown) {
  return new HttpResponse(JSON.stringify(value), {
    headers: { "content-type": "application/octet-stream" },
  });
}

describe("okou wallet", () => {
  it("prints the disconnected wallet status and missing grants", async () => {
    const status = {
      connected: false,
      nextAction: "connect",
      checkoutAvailable: false,
      authorization: {
        known: false,
        scopes: [],
        sourceActions: [],
        capabilities: {
          payments: false,
          spendHistory: false,
          paymentMethods: false,
          userInfo: false,
          transactions: false,
        },
        missingPermissions: [
          "payment_methods.agentic",
          "userinfo:read",
          "read_link_transactions",
        ],
      },
    };
    server.use(
      http.get(`${origin}/api/wallet/status`, () => {
        return HttpResponse.json(status);
      }),
    );
    await run(["status", "--json"]);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual(status);
  });
  it.each([true, false])(
    "reports read-only access while retaining the compatible status response (json=%s)",
    async (json) => {
      const status = {
        connected: true,
        nextAction: "connect",
        checkoutAvailable: false,
        authorization: {
          known: true,
          scopes: ["userinfo:read"],
          sourceActions: ["read_link_transactions"],
          capabilities: {
            payments: false,
            spendHistory: true,
            paymentMethods: false,
            userInfo: true,
            transactions: true,
          },
          missingPermissions: ["payment_methods.agentic"],
        },
      };
      server.use(
        http.get(`${origin}/api/wallet/status`, () => {
          return HttpResponse.json(status);
        }),
      );
      await run(json ? ["status", "--json"] : ["status"]);
      if (json) {
        expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual(
          status,
        );
      } else {
        expect(output).toHaveBeenCalledWith(
          "Link wallet: connected. Next: read_wallet. Checkout unavailable.",
        );
      }
    },
  );
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
  it("announces a bounded backend approval watch without polling from the CLI", async () => {
    let reads = 0;
    server.use(
      http.get(`${origin}/api/wallet/spend/${id}`, () => {
        reads++;
        return HttpResponse.json({ ...spend, autoContinue: true });
      }),
    );
    await run(["spend", "get", id]);
    expect(reads).toBe(1);
    expect(output).toHaveBeenCalledWith(
      `Okou will continue this chat after approval until ${spend.expiresAt}. You can also continue manually. Approved is not paid.`,
    );
  });
  it("does not describe an approved request as a paid purchase", async () => {
    server.use(
      http.get(`${origin}/api/wallet/spend/${id}`, () => {
        return HttpResponse.json({
          ...spend,
          status: "approved",
          approvalUrl: null,
          nextAction: "retrieve_credentials",
        });
      }),
    );
    await run(["spend", "get", id]);
    expect(output).toHaveBeenCalledWith(
      `Approved is not paid. Retrieve the one-time card with: okou wallet spend credentials ${id} --output-file <private-json-path>`,
    );
  });

  it.each([false, true])(
    "requests unified consent and preserves its exact URL (json=%s)",
    async (json) => {
      const url = new URL(
        "https://login.link.com/auth?client_id=fixture&state=keep%2Fexact&scope=payment_methods.agentic%20userinfo%3Aread",
      );
      url.searchParams.set(
        "authorization_details",
        JSON.stringify([
          { type: "source", actions: ["read_link_transactions"] },
        ]),
      );
      let body: unknown;
      server.use(
        http.post(`${origin}/api/wallet/connect`, async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            url: url.toString(),
            expiresAt: spend.expiresAt,
          });
        }),
      );
      await run(json ? ["connect", "--json"] : ["connect"]);
      expect(body).toStrictEqual({});
      if (json) {
        expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toStrictEqual({
          url: url.toString(),
          expiresAt: spend.expiresAt,
        });
      } else {
        expect(output).toHaveBeenCalledWith(url.toString());
        expect(output).toHaveBeenCalledWith(
          expect.stringContaining("end the turn"),
        );
      }
    },
  );

  it.each([
    "payment_methods.agentic",
    "userinfo:read",
    "read_link_transactions",
  ])("refuses an older server's consent URL missing %s", async (missing) => {
    const url = new URL("https://login.link.com/auth?state=fixture");
    url.searchParams.set(
      "scope",
      ["payment_methods.agentic", "userinfo:read"]
        .filter((scope) => {
          return scope !== missing;
        })
        .join(" "),
    );
    if (missing !== "read_link_transactions") {
      url.searchParams.set(
        "authorization_details",
        JSON.stringify([
          { type: "source", actions: ["read_link_transactions"] },
        ]),
      );
    }
    server.use(
      http.post(`${origin}/api/wallet/connect`, () => {
        return HttpResponse.json({
          url: url.toString(),
          expiresAt: spend.expiresAt,
        });
      }),
    );
    await expect(run(["connect"])).rejects.toThrow("process.exit called");
    expect(output).not.toHaveBeenCalledWith(url.toString());
    expect(JSON.stringify(errors.mock.calls)).toContain(
      "does not support unified",
    );
  });

  it("passes transaction filters and cursors and prints a single JSON result", async () => {
    let query: Record<string, string> = {};
    const page = {
      data: [
        {
          id: "txn_second",
          sourceId: null,
          amount: -3000,
          currency: "usd",
          date: "2026-10-14",
          description: "Example Books",
          origin: "link",
          category: "shopping",
          status: "posted",
        },
      ],
      hasMore: true,
      nextCursor: "txn_second",
    };
    server.use(
      http.get(`${origin}/api/wallet/transactions`, ({ request }) => {
        query = Object.fromEntries(new URL(request.url).searchParams);
        return HttpResponse.json(page);
      }),
    );
    await run([
      "transactions",
      "list",
      "--start-date",
      "2026-10-01",
      "--end-date",
      "2026-10-15",
      "--limit",
      "1",
      "--starting-after",
      "txn_first",
      "--category",
      "shopping",
      "--origin",
      "link",
      "--json",
    ]);
    expect(query).toStrictEqual({
      startDate: "2026-10-01",
      endDate: "2026-10-15",
      limit: "1",
      startingAfter: "txn_first",
      category: "shopping",
      origin: "link",
    });
    expect(output.mock.calls).toStrictEqual([[JSON.stringify(page)]]);
  });

  it.each([
    ["--origin", "external_connection"],
    ["--limit", "0"],
    ["--start-date", "2026-02-30"],
    ["--start-date", "2026-10-15", "--end-date", "2026-10-01"],
  ])(
    "rejects unsupported transaction query %j before making a request",
    async (...args) => {
      let requested = false;
      server.use(
        http.get(`${origin}/api/wallet/transactions`, () => {
          requested = true;
          return HttpResponse.json({
            data: [],
            hasMore: false,
            nextCursor: null,
          });
        }),
      );
      await expect(run(["transactions", "list", ...args])).rejects.toThrow(
        "process.exit called",
      );
      expect(requested).toBe(false);
    },
  );

  it("shows recorded spend pagination without treating approval budgets as settled spending", async () => {
    const page = {
      data: [
        {
          id,
          status: "approved",
          amount: 3500,
          currency: "usd",
          merchantName: "Example Books",
          test: true,
          createdAt: "2026-10-14T00:00:00.000Z",
          statusSource: "recorded",
          canRefresh: true,
        },
      ],
      hasMore: false,
      nextCursor: null,
    };
    let query: Record<string, string> = {};
    server.use(
      http.get(`${origin}/api/wallet/spend`, ({ request }) => {
        query = Object.fromEntries(new URL(request.url).searchParams);
        return HttpResponse.json(page);
      }),
    );
    await run(["spend", "list", "--mode", "test", "--status", "approved"]);
    expect(query).toStrictEqual({ mode: "test", status: "approved" });
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("not settled spending"),
    );
  });

  it("reads saved method metadata and filters unexpected credentials", async () => {
    const method = {
      id: "pm_fixture",
      type: "card",
      name: "Visa",
      isDefault: true,
      card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    };
    server.use(
      http.get(`${origin}/api/wallet/payment-methods/pm_fixture`, () => {
        return HttpResponse.json({
          ...method,
          card: { ...method.card, number: "private-pan", cvc: "private-cvc" },
          access_token: "private-token",
        });
      }),
    );
    await run(["payment-methods", "get", "pm_fixture", "--json"]);
    expect(output.mock.calls).toStrictEqual([[JSON.stringify(method)]]);
  });

  it("preserves verification URLs and nullable limits in user info", async () => {
    const actionUrl = "https://app.link.com/verify?session=keep%2Fexact";
    server.use(
      http.get(`${origin}/api/wallet/user-info`, () => {
        return HttpResponse.json({
          name: "Wallet User",
          spendLimits: {
            perTransaction: { limit: 5000 },
            daily: { limit: null, used: 3500, remaining: null },
            thirtyDay: { limit: null, used: 3500, remaining: null },
          },
          verification: { status: "identity_verification", actionUrl },
        });
      }),
    );
    await run(["user-info", "get"]);
    expect(output).toHaveBeenCalledWith(actionUrl);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("null means unlimited"),
    );
  });

  const credentials = {
    spend: {
      ...spend,
      status: "approved",
      approvalUrl: null,
      nextAction: "retrieve_credentials",
    },
    card: {
      brand: "visa",
      number: "4000009990001984",
      cvc: "123",
      expMonth: 12,
      expYear: 2030,
      billingAddress: {
        name: "Wallet Test",
        line1: "123 Test Street",
        country: "US",
      },
      validUntil: "2026-10-14T12:00:00Z",
    },
  };

  it("writes credentials to a new private file and prints only a redacted summary", async () => {
    const path = join(tempDir, "card.json");
    server.use(
      http.post(`${origin}/api/wallet/spend/${id}/credentials`, () => {
        return credentialDownload({
          ...credentials,
          access_token: "private-oauth-fixture",
          card: {
            ...credentials.card,
            private_metadata: "private-metadata-fixture",
          },
        });
      }),
    );
    await run(["spend", "credentials", id, "--output-file", path, "--json"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toStrictEqual(credentials);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(output).toHaveBeenCalledWith(
      JSON.stringify({
        spend: credentials.spend,
        credentialsFile: path,
        card: {
          brand: "visa",
          last4: "1984",
          expMonth: 12,
          expYear: 2030,
          validUntil: credentials.card.validUntil,
        },
      }),
    );
    expect(JSON.stringify([output.mock.calls, errors.mock.calls])).not.toMatch(
      /4000009990001984|"cvc"|123 Test Street|private-oauth-fixture|private-metadata-fixture/,
    );
  });

  it.each(["existing file", "symlink"] as const)(
    "does not overwrite an %s or retrieve credentials for it",
    async (kind) => {
      const original = join(tempDir, "original.json");
      const path = kind === "symlink" ? join(tempDir, "card.json") : original;
      await writeFile(original, "existing-private-data", { mode: 0o600 });
      if (kind === "symlink") {
        await symlink(original, path);
      }
      let requests = 0;
      server.use(
        http.post(`${origin}/api/wallet/spend/${id}/credentials`, () => {
          requests += 1;
          return credentialDownload(credentials);
        }),
      );
      await expect(
        run(["spend", "credentials", id, "--output-file", path]),
      ).rejects.toThrow("process.exit called");
      expect(await readFile(original, "utf8")).toBe("existing-private-data");
      expect(requests).toBe(0);
      expect(output).not.toHaveBeenCalled();
    },
  );

  it.each([
    "unapproved",
    "invalid card",
    "invalid JSON",
    "unexpected JSON response",
    "provider failure",
  ] as const)(
    "removes the incomplete file and redacts errors for %s",
    async (kind) => {
      const path = join(tempDir, "card.json");
      let requests = 0;
      server.use(
        http.post(`${origin}/api/wallet/spend/${id}/credentials`, () => {
          requests += 1;
          if (kind === "invalid JSON") {
            return new HttpResponse(
              `{"card":${credentials.card.number} invalid`,
              { headers: { "content-type": "application/octet-stream" } },
            );
          }
          if (kind === "unexpected JSON response") {
            return HttpResponse.json(credentials);
          }
          if (kind === "provider failure") {
            return HttpResponse.json(
              {
                error: {
                  code: "WALLET_SPEND_NOT_APPROVED",
                  message: "The request is pending approval",
                },
              },
              { status: 409 },
            );
          }
          return credentialDownload({
            ...credentials,
            ...(kind === "unapproved"
              ? { spend: { ...credentials.spend, status: "pending_approval" } }
              : {}),
            ...(kind === "invalid card"
              ? {
                  card: {
                    ...credentials.card,
                    expMonth: credentials.card.number,
                  },
                }
              : {}),
          });
        }),
      );
      await expect(
        run(["spend", "credentials", id, "--output-file", path, "--json"]),
      ).rejects.toThrow("process.exit called");
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(requests).toBe(1);
      expect(output).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalled();
      expect(JSON.stringify(errors.mock.calls)).not.toMatch(
        /4000009990001984|123 Test Street/,
      );
    },
  );
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
  it.each(["structured", "gateway", "empty", "null"] as const)(
    "preserves %s creation failure diagnostics without retrying",
    async (kind) => {
      const diagnosticId = randomUUID();
      const message = `Link rejected the request (operation: spend_create; HTTP 400; parameter: expires_at; detail: expires_at must be in the future; reference: ${diagnosticId})`;
      let requests = 0;
      server.use(
        http.post(`${origin}/api/wallet/spend`, () => {
          requests += 1;
          if (kind === "empty") {
            return new HttpResponse(null, { status: 502 });
          }
          if (kind === "null") {
            return HttpResponse.json(null, { status: 502 });
          }
          return kind === "structured"
            ? HttpResponse.json(
                { error: { code: "WALLET_PROVIDER_ERROR", message } },
                { status: 502 },
              )
            : new HttpResponse(
                "<html>gateway failed with private-upstream-fixture</html>",
                { status: 502, headers: { "content-type": "text/html" } },
              );
        }),
      );
      await expect(
        run([
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
        ]),
      ).rejects.toThrow("process.exit called");
      const displayed = JSON.stringify(errors.mock.calls);
      expect(displayed).toContain("operation: spend_create");
      expect(displayed).toContain(
        kind === "structured" ? diagnosticId : intentId,
      );
      expect(displayed).toContain(
        kind === "structured" ? "HTTP 400" : "backend diagnostic unavailable",
      );
      expect(displayed).not.toContain("private-upstream-fixture");
      expect(requests).toBe(1);
      expect(output).not.toHaveBeenCalled();
    },
  );
});
