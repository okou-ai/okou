import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { test } from "node:test";

import {
  completeRunnerOnboarding,
  createRunnerCheckout,
  readRunnerPaidEntitlement,
} from "./runner-onboarding";

test("runner setup completes free onboarding and creates checkout through public authenticated APIs", async () => {
  const paths: string[] = [];
  await withApi(
    async (request, response) => {
      paths.push(request.method + " " + request.url);
      assert.equal(request.headers.authorization, "Bearer session-token");
      assert.equal(
        request.headers["x-vercel-protection-bypass"],
        "preview-bypass",
      );
      assert.match(
        String(request.headers["x-client-request-id"]),
        /^[0-9a-f-]{36}$/,
      );
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === "/api/onboarding/complete") {
        assert.deepEqual(body, {});
        send(response, { onboardingComplete: true, needsOnboarding: false });
      } else {
        assert.deepEqual(body, {
          tier: "pro",
          memberUsagePacks: [{ memberId: "user_runner", usagePackUsd: 20 }],
          successUrl:
            "https://app.example.test/?billing=pro&billing_session_id={CHECKOUT_SESSION_ID}",
          cancelUrl: "https://app.example.test/",
        });
        send(response, { url: "https://checkout.stripe.com/c/pay/session" });
      }
    },
    async (apiUrl) => {
      const options = {
        apiUrl,
        clerkSessionToken: "session-token",
        vercelAutomationBypassSecret: "preview-bypass",
      };
      await completeRunnerOnboarding(options);
      const checkout = await createRunnerCheckout({
        ...options,
        appUrl: "https://app.example.test",
        memberId: "user_runner",
      });
      assert.equal(checkout, "https://checkout.stripe.com/c/pay/session");
      assert.deepEqual(paths, [
        "POST /api/onboarding/complete",
        "POST /api/billing/usage-pack-checkout",
      ]);
    },
  );
});

for (const code of [
  "BILLING_CHECKOUT_DIRECTORY_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
]) {
  test(`checkout failure preserves ${code} without replaying the purchase or exposing its body`, async () => {
    let requests = 0;
    let requestId: string | undefined;
    await withApi(
      (request, response) => {
        requests += 1;
        requestId = String(request.headers["x-client-request-id"]);
        response.setHeader("retry-after", "10");
        send(
          response,
          {
            error: { code, message: "secret-session-token" },
            url: "https://checkout.stripe.com/secret-checkout",
          },
          503,
        );
      },
      async (apiUrl) => {
        await assert.rejects(
          createRunnerCheckout({
            apiUrl,
            appUrl: "https://app.example.test",
            memberId: "user_runner",
            clerkSessionToken: "session-token",
          }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /HTTP 503/);
            assert.ok(requestId && error.message.includes(requestId));
            assert.match(error.message, /retry_after=10/);
            assert.ok(error.message.includes("error_code=" + code));
            assert.doesNotMatch(
              error.message,
              /secret-session-token|secret-checkout/,
            );
            return true;
          },
        );
        assert.equal(requests, 1);
      },
    );
  });
}

for (const [name, body, contentType] of [
  ["HTML", "<html>secret-body</html>", "text/html"],
  ["malformed JSON", '{"error":secret-body', "application/json"],
  ["missing code", '{"error":{"message":"secret-body"}}', "application/json"],
  ["unknown code", '{"error":{"code":"SECRET_BODY"}}', "application/json"],
  ["wrong shape", '{"error":["secret-body"]}', "application/json"],
  [
    "oversized body",
    JSON.stringify({
      error: { code: "BILLING_CHECKOUT_DIRECTORY_RATE_LIMITED" },
      message: "secret-body".repeat(500),
    }),
    "application/json",
  ],
]) {
  test(`checkout retains the HTTP failure for ${name} diagnostics without replay`, async () => {
    let requests = 0;
    await withApi(
      (_request, response) => {
        requests += 1;
        response.writeHead(503, { "content-type": contentType });
        response.end(body);
      },
      async (apiUrl) => {
        await assert.rejects(
          createRunnerCheckout({
            apiUrl,
            appUrl: "https://app.example.test",
            memberId: "user_runner",
            clerkSessionToken: "session-token",
          }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /HTTP 503/);
            assert.match(error.message, /error_code=unavailable/);
            assert.doesNotMatch(error.message, /secret-body|SECRET_BODY/);
            return true;
          },
        );
        assert.equal(requests, 1);
      },
    );
  });
}

test(
  "checkout stops reading an unfinished error body and retains the HTTP failure",
  { timeout: 5000 },
  async () => {
    let requests = 0;
    await withApi(
      (_request, response) => {
        requests += 1;
        response.writeHead(503, { "content-type": "application/json" });
        response.write('{"error":');
      },
      async (apiUrl) => {
        await assert.rejects(
          createRunnerCheckout({
            apiUrl,
            appUrl: "https://app.example.test",
            memberId: "user_runner",
            clerkSessionToken: "session-token",
          }),
          /HTTP 503; .*error_code=unavailable/,
        );
        assert.equal(requests, 1);
      },
    );
  },
);

test("runner entitlement requires settled Pro, BYOK and unrestricted models", async () => {
  let state = {
    tier: "limited-free-1",
    onboardingPaymentPending: false,
    supportByok: false,
    restrictedBuiltInModels: true,
  };
  await withApi(
    (request, response) => {
      assert.equal(request.method, "GET");
      assert.equal(request.url, "/api/billing/status");
      send(response, state);
    },
    async (apiUrl) => {
      const options = { apiUrl, clerkSessionToken: "session-token" };
      assert.equal(await readRunnerPaidEntitlement(options), false);
      state = {
        tier: "pro",
        onboardingPaymentPending: true,
        supportByok: true,
        restrictedBuiltInModels: false,
      };
      assert.equal(await readRunnerPaidEntitlement(options), false);
      state.onboardingPaymentPending = false;
      assert.equal(await readRunnerPaidEntitlement(options), true);
    },
  );
});

test("runner setup rejects unsuccessful completion and non-Stripe checkout destinations", async () => {
  await withApi(
    (request, response) => {
      send(
        response,
        request.url === "/api/onboarding/complete"
          ? { onboardingComplete: false, needsOnboarding: true }
          : { url: "https://unexpected.example.test/" },
      );
    },
    async (apiUrl) => {
      const options = { apiUrl, clerkSessionToken: "session-token" };
      await assert.rejects(
        completeRunnerOnboarding(options),
        /did not return completed onboarding/,
      );
      await assert.rejects(
        createRunnerCheckout({
          ...options,
          appUrl: "https://app.example.test",
          memberId: "user_runner",
        }),
        /hosted Stripe Checkout/,
      );
    },
  );
});

async function withApi(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
  run: (apiUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run("http://127.0.0.1:" + address.port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function send(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
