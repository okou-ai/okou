import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { atomSubscriptionGrantsContract } from "@okouai/api-contracts/contracts/atom-subscription-grants";
import {
  personalModelProvidersMainContract,
  personalModelProvidersByTypeContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { atomSubscriptionGrantRoutes } from "../atom-subscription-grants";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";

const context = testContext();
const MACHINE_SECRET = "msk_existing_vm0_machine";
const M2M_TOKEN = "mt_atom_grant";
const ATOM_MACHINE = "mch_atom_api";
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
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request, options) => {
      if (
        typeof options === "object" &&
        options !== null &&
        "acceptsToken" in options &&
        options.acceptsToken === "m2m_token"
      ) {
        expect(options).toMatchObject({ machineSecretKey: MACHINE_SECRET });
        const token =
          request instanceof Request
            ? request.headers.get("authorization")
            : null;
        if (
          token !== `Bearer ${M2M_TOKEN}` &&
          token !== "Bearer mt_other_machine"
        ) {
          return Promise.resolve({ isAuthenticated: false });
        }
        const machineId =
          token === "Bearer mt_other_machine" ? "mch_other" : ATOM_MACHINE;
        return Promise.resolve({
          isAuthenticated: true,
          toAuth: () => {
            return {
              tokenType: "m2m_token",
              id: "m2m_valid",
              machineId,
            };
          },
        });
      }
      return Promise.resolve({
        isAuthenticated: true,
        toAuth: () => {
          return { ...actor, orgRole: "org:member" };
        },
      });
    },
  );
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
    mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", MACHINE_SECRET);
    mockOptionalEnv(
      "ATOM_SUBSCRIPTION_GRANT_MACHINE_IDS",
      ` ${ATOM_MACHINE}, mch_other_allowed `,
    );
    server.use(
      http.get("https://api.anthropic.com/api/oauth/profile", ({ request }) => {
        const accountId =
          request.headers.get("authorization") ===
          "Bearer sk-ant-another-account"
            ? "claude-second-account"
            : "claude-first-account";
        return HttpResponse.json({
          account: {
            uuid: accountId,
            email: `${accountId}@example.com`,
            has_claude_pro: true,
          },
          organization: { uuid: "claude-workspace", name: "Personal" },
        });
      }),
    );
  });

  it.each([
    "clerk-session",
    "msk_existing_vm0_machine",
    "atom-test-grant-credential-32-characters",
    "mt_invalid",
  ])("rejects a non-M2M or unverified credential: %s", async (token) => {
    const body = fixture();
    const response = await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${token}` },
        body,
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it.each(["OKOU_MACHINE_SECRET_KEY", "ATOM_SUBSCRIPTION_GRANT_MACHINE_IDS"])(
    "disables ingestion when %s is not configured",
    async (key) => {
      const body = fixture();
      mockOptionalEnv(key, undefined);
      await accept(
        client()(atomSubscriptionGrantsContract).deliver({
          headers: { authorization: `Bearer ${M2M_TOKEN}` },
          body,
        }),
        [503],
      );
      expect(context.mocks.clerk.authenticateRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects a valid M2M token from a machine outside the allowlist", async () => {
    const body = fixture();
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: "Bearer mt_other_machine" },
        body,
      }),
      [403],
    );
    expect(
      context.mocks.clerk.organizations.getOrganizationMembershipList,
    ).not.toHaveBeenCalled();
  });

  it("does not expose Clerk failures and allows retry after verification recovers", async () => {
    const body = fixture();
    context.mocks.clerk.authenticateRequest.mockRejectedValueOnce(
      new Error(`private Clerk error ${MACHINE_SECRET}`),
    );
    const response = await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${M2M_TOKEN}` },
        body,
      }),
      [503],
    );
    expect(JSON.stringify(response.body)).not.toContain(MACHINE_SECRET);
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${M2M_TOKEN}` },
        body,
      }),
      [200],
    );
  });

  it("rejects a recipient who does not belong to the supplied org", async () => {
    const body = fixture();
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${M2M_TOKEN}` },
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
            headers: { authorization: `Bearer ${M2M_TOKEN}` },
            body,
          }),
          [200],
        );
      };
      const delivered = await deliver();
      expect(delivered.body).toStrictEqual({
        grantId: body.grantId,
        status: "delivered",
      });
      expect((await deliver()).body).toStrictEqual(delivered.body);
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
          headers: { authorization: `Bearer ${M2M_TOKEN}` },
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
        headers: { authorization: `Bearer ${M2M_TOKEN}` },
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
        headers: { authorization: `Bearer ${M2M_TOKEN}` },
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
    expect(listed.body.modelProviders).toHaveLength(2);
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
        headers: { authorization: `Bearer ${M2M_TOKEN}` },
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
        headers: { authorization: `Bearer ${M2M_TOKEN}` },
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
