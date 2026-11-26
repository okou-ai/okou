import { randomUUID } from "node:crypto";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import {
  createCodexExpiryFixture,
  credentials,
  headers,
} from "./helpers/codex-reset-credit-expiry";
import {
  createAuthDeviceApiActions,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";

const context = testContext();
const codexOwner = createCodexExpiryFixture(context);

/** ChatGPT reports each account's live usage by the account id it is asked about. */
function liveUsage(byAccount: Record<string, Record<string, unknown>>) {
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
      const accountId = request.headers.get("chatgpt-account-id") ?? "";
      return HttpResponse.json(byAccount[accountId] ?? {});
    }),
    http.get(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      () => {
        return HttpResponse.json({ credits: [] });
      },
    ),
  );
}

/** An owner connects one Codex subscription, then adds a second account through device sign-in. */
async function twoCodexAccounts() {
  const first = credentials(randomUUID());
  const secondAccountId = `codex-${randomUUID()}`;
  const owner = await codexOwner({ auth: first });
  mockCodexDeviceAuthProvider({ accountId: secondAccountId });
  const device = createAuthDeviceApiActions(context);
  const actor = {
    userId: owner.userId,
    orgId: owner.orgId,
    orgRole: "org:admin" as const,
    email: "codex-owner@example.com",
  };
  const started = await device.requestCodexStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error("Expected Codex sign-in to start");
  }
  const completed = await device.requestCodexComplete(
    actor,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in completed.body) || completed.body.status !== "complete") {
    throw new Error("Expected the second Codex account to connect");
  }
  return {
    owner,
    firstAccountId: first.accountId,
    secondAccountId,
    firstId: owner.id,
    secondId: completed.body.provider.id,
  };
}

describe("personal subscription live credits", () => {
  it("subscription-credit-balances-003 keeps reset credits and quota for unlimited credit accounts", async () => {
    const { owner, firstAccountId, secondAccountId } = await twoCodexAccounts();
    const unlimited = {
      credits: { has_credits: true, unlimited: true },
      rate_limit_reset_credits: { available_count: 2 },
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000 },
      },
    };
    liveUsage({ [firstAccountId]: unlimited, [secondAccountId]: unlimited });

    const providers = await owner.list();

    const codex = providers.filter((provider) => {
      return provider.type === "codex-oauth-token";
    });
    expect(codex).toHaveLength(2);
    for (const provider of codex) {
      expect(provider.subscriptionCredits).toStrictEqual({
        balance: null,
        unlimited: true,
      });
      expect(provider.subscriptionResetCredits).toBe(2);
      expect(provider.subscriptionUsage?.fiveHour?.remainingPercent).toBe(75);
    }
  });

  it("subscription-credit-balances-001 lists each account's own live credits before and after activation", async () => {
    const { owner, firstAccountId, secondAccountId, firstId, secondId } =
      await twoCodexAccounts();
    liveUsage({
      [firstAccountId]: {
        credits: { has_credits: true, unlimited: false, balance: "1250.5" },
      },
      [secondAccountId]: {
        credits: { has_credits: false, unlimited: false, balance: "0" },
      },
    });
    const creditsById = (
      providers: Awaited<ReturnType<typeof owner.list>>,
    ): Record<string, unknown> => {
      return Object.fromEntries(
        providers.map((provider) => {
          return [provider.id, provider.subscriptionCredits];
        }),
      );
    };

    const before = await owner.list();
    expect(creditsById(before)).toMatchObject({
      [firstId]: { balance: 1250.5, unlimited: false },
      [secondId]: { balance: 0, unlimited: false },
    });

    owner.session();
    await accept(
      setupApp({ context, routes: meModelProviderAccountRoutes })(
        personalModelProviderAccountsByIdContract,
      ).activate({ headers, params: { id: secondId }, body: {} }),
      [200],
    );
    const after = await owner.list();

    expect(after[0]).toMatchObject({
      id: secondId,
      isActive: true,
      subscriptionCredits: { balance: 0, unlimited: false },
    });
    expect(creditsById(after)).toMatchObject({
      [firstId]: { balance: 1250.5, unlimited: false },
      [secondId]: { balance: 0, unlimited: false },
    });
  });
});
