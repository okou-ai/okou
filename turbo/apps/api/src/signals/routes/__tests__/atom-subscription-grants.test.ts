import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { atomSubscriptionGrantsContract } from "@okouai/api-contracts/contracts/atom-subscription-grants";
import {
  personalModelProvidersMainContract,
  personalModelProvidersByTypeContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { atomSubscriptionGrantRoutes } from "../atom-subscription-grants";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { createRouteMocks } from "./helpers/route-test";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";

const context = testContext();
const mocks = createRouteMocks(context);
const SECRET = "atom-test-grant-credential-32-characters";
const routes = Object.freeze([
  ...atomSubscriptionGrantRoutes,
  ...meModelProvidersListRoutes,
  ...meModelProvidersDeleteRoutes,
]);
function client() {
  return setupApp({ context, routes });
}
function fixture() {
  const actor = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mockClerkMembership(
    context,
    { ...actor, orgRole: "org:member", email: "recipient@example.com" },
    "org:member",
  );
  mocks.clerk.session(actor.userId, actor.orgId);
  return {
    ...actor,
    grantId: randomUUID(),
    tokens: {
      provider: "claude-code" as const,
      accessToken: "sk-ant-test-granted",
    },
  };
}
function jwt(payload: Record<string, unknown>) {
  return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
}

describe("Atom subscription grants", () => {
  beforeEach(() => {
    mockOptionalEnv("ATOM_SUBSCRIPTION_GRANT_SECRET", SECRET);
  });

  it("rejects ordinary user sessions and disables ingestion without a configured bridge credential", async () => {
    const body = fixture();
    const response = await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    mockOptionalEnv("ATOM_SUBSCRIPTION_GRANT_SECRET", undefined);
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      }),
      [503],
    );
  });

  it("rejects a recipient who does not belong to the supplied org", async () => {
    const body = fixture();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      }),
      [403],
    );
    const listed = await accept(
      client()(personalModelProvidersMainContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listed.body.modelProviders).toHaveLength(0);
  });

  it.each(["claude-code", "codex"] as const)(
    "delivers %s to the selected member once and rejects recipient changes",
    async (provider) => {
      const base = fixture();
      const expiry = Math.floor(now() / 1000) + 7200;
      const tokens =
        provider === "claude-code"
          ? base.tokens
          : {
              provider,
              accessToken: jwt({ exp: expiry }),
              refreshToken: "synthetic-grant-refresh-token",
              idToken: jwt({
                exp: expiry,
                email: "subscriber@example.com",
                "https://api.openai.com/auth": {
                  chatgpt_account_id: randomUUID(),
                  chatgpt_plan_type: "plus",
                },
              }),
            };
      const body = { ...base, tokens };
      const deliver = async () => {
        return await accept(
          client()(atomSubscriptionGrantsContract).deliver({
            headers: { authorization: `Bearer ${SECRET}` },
            body,
          }),
          [200],
        );
      };
      const delivered = await deliver();
      expect(delivered.body).toEqual({
        grantId: body.grantId,
        status: "delivered",
      });
      expect((await deliver()).body).toEqual(delivered.body);
      const listed = await accept(
        client()(personalModelProvidersMainContract).list({
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      expect(listed.body.modelProviders).toHaveLength(1);
      expect(listed.body.modelProviders[0]).toMatchObject({
        type:
          provider === "codex"
            ? "codex-oauth-token"
            : "claude-code-oauth-token",
        isActive: true,
      });
      expect(JSON.stringify(listed.body)).not.toContain(tokens.accessToken);
      await accept(
        client()(atomSubscriptionGrantsContract).deliver({
          headers: { authorization: `Bearer ${SECRET}` },
          body: { ...body, userId: `user_${randomUUID()}` },
        }),
        [409],
      );
    },
  );

  it("preserves the existing default when adding another subscription", async () => {
    const body = fixture();
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      }),
      [200],
    );
    const initial = await accept(
      client()(personalModelProvidersMainContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${SECRET}` },
        body: {
          ...body,
          grantId: randomUUID(),
          tokens: {
            provider: "claude-code",
            accessToken: "sk-ant-another-account",
          },
        },
      }),
      [200],
    );
    const listed = await accept(
      client()(personalModelProvidersMainContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(
      listed.body.modelProviders.find((account) => {
        return account.isActive;
      })?.id,
    ).toBe(initial.body.modelProviders[0]?.id);
  });

  it("does not restore credentials when a delivered grant is retried after the recipient disconnects", async () => {
    const body = fixture();
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      }),
      [200],
    );
    await accept(
      client()(personalModelProvidersByTypeContract).delete({
        headers: { authorization: "Bearer clerk-session" },
        params: { type: "claude-code-oauth-token" },
      }),
      [204],
    );
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${SECRET}` },
        body,
      }),
      [200],
    );
    const listed = await accept(
      client()(personalModelProvidersMainContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listed.body.modelProviders).toHaveLength(0);
  });
});
