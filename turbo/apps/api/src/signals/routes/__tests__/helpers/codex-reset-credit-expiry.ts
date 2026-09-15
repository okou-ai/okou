import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { http, HttpResponse } from "msw";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { meModelProvidersListRoutes } from "../../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../../me-model-providers-upsert";
import { meModelProvidersResetSubscriptionRoutes } from "../../me-model-providers-reset-subscription";
import { meModelProviderAccountRoutes } from "../../me-model-provider-accounts";
import { createRouteMocks } from "./route-test";
import { updateFeatureSwitchesForUser } from "./feature-switches";

export const headers = Object.freeze({ authorization: "Bearer clerk-session" });
export const routes = Object.freeze([
  ...meModelProvidersListRoutes,
  ...meModelProvidersUpsertRoutes,
]);
export const detailsUrl =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

export function jwt(payload: Record<string, unknown>): string {
  return `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

export function credentials(accountId = randomUUID(), accessToken?: string) {
  const token =
    accessToken ??
    jwt({ exp: Math.floor(now() / 1000) + 7200, jti: randomUUID() });
  return {
    accountId,
    accessToken: token,
    raw: JSON.stringify({
      tokens: {
        access_token: token,
        refresh_token: `refresh-${randomUUID()}`,
        account_id: accountId,
        id_token: jwt({
          email: "expiry@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: accountId,
            chatgpt_plan_type: "plus",
          },
        }),
      },
    }),
  };
}

export function expiryResponse(expiry: string | null) {
  return HttpResponse.json({
    credits: [{ status: "available", expires_at: expiry }],
  });
}

export function upstream() {
  const control = {
    usageCalls: 0,
    detailsCalls: 0,
    expiry: new Date(now() + 3_600_000).toISOString(),
    details: (_request: Request): Response | Promise<Response> => {
      return expiryResponse(control.expiry);
    },
    usage: (): Response | Promise<Response> => {
      return HttpResponse.json({
        rate_limit_reset_credits: { available_count: control.usageCalls },
      });
    },
  };
  server.use(
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      control.usageCalls += 1;
      return control.usage();
    }),
    http.get(detailsUrl, ({ request }) => {
      control.detailsCalls += 1;
      return control.details(request);
    }),
  );
  return control;
}

export function createCodexExpiryFixture(context: TestContext) {
  const mocks = createRouteMocks(context);
  return async function fixture(
    options: {
      accounts?: boolean;
      auth?: ReturnType<typeof credentials>;
      orgId?: string;
      userId?: string;
      priority?: boolean;
    } = {},
  ) {
    const owner = {
      orgId: options.orgId ?? `org_expiry_${randomUUID()}`,
      userId: options.userId ?? `user_expiry_${randomUUID()}`,
    };
    const auth = options.auth ?? credentials();
    const session = () => {
      return mocks.clerk.session(owner.userId, owner.orgId);
    };
    session();
    await updateFeatureSwitchesForUser(context, owner, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]:
        options.accounts ?? false,
      [FeatureSwitchKey.PersonalSubscriptionPriority]:
        options.priority ?? false,
    });
    const client = (signal?: AbortSignal) => {
      return setupApp({ context, routes, signal, rethrowErrors: true })(
        personalModelProvidersMainContract,
      );
    };
    const connect = async (next = auth) => {
      session();
      return await accept(
        client().upsert({
          headers,
          body: {
            type: "codex-oauth-token",
            authMethod: "auth_json",
            secrets: { CODEX_AUTH_JSON: next.raw },
          },
        }),
        [200, 201],
      );
    };
    const connected = await connect();
    return {
      ...owner,
      id: connected.body.provider.id,
      auth,
      connect,
      session,
      list: async (signal?: AbortSignal) => {
        session();
        const result = await accept(client(signal).list({ headers }), [200]);
        return result.body.modelProviders;
      },
      consume: async () => {
        session();
        const idempotencyKey = randomUUID();
        if (options.accounts) {
          return await setupApp({
            context,
            routes: meModelProviderAccountRoutes,
          })(personalModelProviderAccountsByIdContract).resetSubscriptionUsage({
            headers,
            params: { id: connected.body.provider.id },
            body: { idempotencyKey },
          });
        }
        return await setupApp({
          context,
          routes: meModelProvidersResetSubscriptionRoutes,
        })(personalModelProvidersByTypeContract).resetSubscriptionUsage({
          headers,
          params: { type: "codex-oauth-token" },
          body: { idempotencyKey },
        });
      },
    };
  };
}

export function expectExpiry(
  providers: readonly ModelProviderResponse[],
  expiry: string | null,
  count?: number,
) {
  expect(providers[0]).toMatchObject({
    subscriptionResetCreditsNextExpiresAt: expiry,
    ...(count === undefined ? {} : { subscriptionResetCredits: count }),
  });
}
