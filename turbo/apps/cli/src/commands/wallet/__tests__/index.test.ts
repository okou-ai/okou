import { randomUUID } from "node:crypto";
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
  approvalUrl:
    "https://app.link.com/activity/approve/lsrq_example?approval=keep-exact",
  expiresAt: "2026-10-12T08:00:00.000Z",
  nextAction: "wait_for_user",
  action: null,
};

beforeEach(async () => {
  vi.stubEnv("OKOU_API_BACKEND_URL", origin);
  vi.stubEnv("OKOU_TOKEN", "test-token");
  tempDir = await mkdtemp(join(tmpdir(), "okou-wallet-test-"));
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
          nextAction: "retrieve_credentials",
        });
      }),
    );
    await run(["spend", "get", id]);
    expect(output).toHaveBeenCalledWith(
      `Approved is not paid. Retrieve the one-time card with: okou wallet spend credentials ${id} --output-file <private-json-path>`,
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
