import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createCodexExpiryFixture,
  credentials,
  expectExpiry,
  upstream,
} from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const codexOwner = createCodexExpiryFixture(context);

interface ConsumeRequest {
  readonly accountId: string | null;
  readonly body: unknown;
}

/** ChatGPT's consume endpoint drops the connection after receiving the request. */
function failingConsume(): ConsumeRequest[] {
  const requests: ConsumeRequest[] = [];
  server.use(
    http.post(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      async ({ request }) => {
        requests.push({
          accountId: request.headers.get("chatgpt-account-id"),
          body: await request.json(),
        });
        return HttpResponse.error();
      },
    ),
  );
  return requests;
}

/** Consumes after a cached read while upstream drops the consume connection. */
async function consumeWithAmbiguousFailure(accountRoute: boolean) {
  const control = upstream();
  const owner = await codexOwner({ accountRoute });
  expectExpiry(await owner.list(), control.expiry);
  const requests = failingConsume();

  const consumed = await owner.consume();
  control.expiry = new Date(now() + 7_200_000).toISOString();
  const providers = await owner.list();
  return { control, owner, requests, consumed, providers };
}

/** Reconnects after a cached read while upstream moves the expiry. */
async function reconnectAfterCachedRead(sameAccount: boolean) {
  const control = upstream();
  const owner = await codexOwner();
  expectExpiry(await owner.list(), control.expiry);
  control.expiry = new Date(now() + 7_200_000).toISOString();

  await owner.connect(
    sameAccount ? credentials(owner.auth.accountId) : credentials(),
  );
  const providers = await owner.list();
  return { control, providers };
}

describe("Codex expiry invalidation and identity isolation", () => {
  it("codex-reset-credit-expiry-invalidation-001 invalidates the expiry after an ambiguous consume failure on the provider-type route", async () => {
    const { control, owner, requests, consumed, providers } =
      await consumeWithAmbiguousFailure(false);

    expect(consumed.status).toBe(500);
    expect(requests).toStrictEqual([
      {
        accountId: owner.auth.accountId,
        body: { redeem_request_id: expect.any(String) },
      },
    ]);
    expectExpiry(providers, control.expiry);
    expect(control.detailsCalls).toBe(3);
  });

  it("codex-reset-credit-expiry-invalidation-002 invalidates the expiry after an ambiguous consume failure on the account route", async () => {
    const { control, owner, requests, consumed, providers } =
      await consumeWithAmbiguousFailure(true);

    expect(consumed.status).toBe(500);
    expect(requests).toStrictEqual([
      {
        accountId: owner.auth.accountId,
        body: { redeem_request_id: expect.any(String) },
      },
    ]);
    expectExpiry(providers, control.expiry);
    expect(control.detailsCalls).toBe(3);
  });

  it("codex-reset-credit-expiry-invalidation-011 does not reuse the expiry after the credential changes", async () => {
    const { control, providers } = await reconnectAfterCachedRead(true);

    expectExpiry(providers, control.expiry);
    expect(control.detailsCalls).toBe(4);
  });

  it("codex-reset-credit-expiry-invalidation-012 does not reuse the expiry after the account changes", async () => {
    const { control, providers } = await reconnectAfterCachedRead(false);

    expectExpiry(providers, control.expiry);
    expect(control.detailsCalls).toBe(4);
  });
});
