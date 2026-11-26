import { randomUUID } from "node:crypto";
import {
  walletCallbackContract,
  walletUserContract,
} from "@okouai/api-contracts/contracts/wallet";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { walletRoutes } from "../wallet";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("Link wallet settings", () => {
  it("wallet-014 reports the permissions returned by a credential refresh", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    createRouteMocks(context).clerk.session(userId, orgId);
    mockEnv("LINK_OAUTH_CLIENT_ID", "link-client-id");
    mockEnv("LINK_OAUTH_CLIENT_SECRET", "link-client-secret");
    mockEnv("LINK_STRIPE_PUBLISHABLE_KEY", "pk_test_link");

    server.use(
      http.post("https://login.link.com/auth/token", async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        if (form.get("grant_type") === "refresh_token") {
          return HttpResponse.json({
            access_token: "link-refreshed-access",
            refresh_token: "link-refreshed-refresh",
            expires_in: 3600,
            scope: "userinfo:read",
            token_type: "Bearer",
          });
        }
        return HttpResponse.json({
          access_token: "link-initial-access",
          refresh_token: "link-initial-refresh",
          expires_in: 30,
          scope: "payment_methods.agentic userinfo:read",
          authorization_details: [
            { type: "source", actions: ["read_link_transactions"] },
          ],
          token_type: "Bearer",
        });
      }),
    );

    const app = setupApp({ context, routes: walletRoutes });
    const started = await accept(
      app(walletUserContract).connect({ headers, body: {} }),
      [200],
    );
    const state = new URL(started.body.url).searchParams.get("state");
    if (!state) {
      throw new Error("Expected state parameter in Link authorization URL");
    }

    await accept(
      app(walletCallbackContract).callback({
        headers,
        query: { state, code: "link-auth-code" },
      }),
      [200],
    );

    const status = await accept(
      app(walletUserContract).status({ headers }),
      [200],
    );
    expect(status.body.connected).toBeTruthy();
    expect(status.body.authorization.sourceActions).toStrictEqual([]);
    expect(status.body.authorization.capabilities).toMatchObject({
      payments: false,
      paymentMethods: false,
      transactions: false,
    });

    await accept(
      app(walletUserContract).activity({ headers, query: {} }),
      [403],
    );
  });
});
