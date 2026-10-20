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
import { createDeferredPromise } from "../../utils";
import { atomSubscriptionGrantRoutes } from "../atom-subscription-grants";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";

const context = testContext();
const MACHINE_SECRET = "msk_existing_vm0_machine";
const M2M_TOKEN = "mt_atom_grant";
const ATOM_MACHINE = "mch_atom_api";
const routes = Object.freeze([
  ...atomSubscriptionGrantRoutes,
  ...meModelProvidersListRoutes,
  ...meModelProvidersDeleteRoutes,
  ...meModelProvidersUpsertRoutes,
]);
function client() {
  return setupApp({ context, routes });
}
function fixture(provider: "claude-code" | "codex" = "claude-code") {
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
    tokens:
      provider === "claude-code"
        ? {
            provider: "claude-code" as const,
            accessToken: "sk-ant-test-granted",
          }
        : {
            provider: "codex" as const,
            accessToken: jwt({ exp: Math.floor(now() / 1000) + 7200 }),
            refreshToken: "synthetic-grant-refresh-token",
            idToken: jwt({
              exp: Math.floor(now() / 1000) + 7200,
              email: "subscriber@example.com",
              "https://api.openai.com/auth": {
                chatgpt_account_id: randomUUID(),
                chatgpt_plan_type: "plus",
              },
            }),
          },
  };
}
function jwt(payload: Record<string, unknown>) {
  return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`;
}

function cancel(body: ReturnType<typeof fixture>) {
  return client()(atomSubscriptionGrantsContract).cancel({
    headers: { authorization: `Bearer ${M2M_TOKEN}` },
    params: { grantId: body.grantId },
    body: {
      orgId: body.orgId,
      userId: body.userId,
      provider: body.tokens.provider,
    },
  });
}

function deliver(body: ReturnType<typeof fixture>) {
  return client()(atomSubscriptionGrantsContract).deliver({
    headers: { authorization: `Bearer ${M2M_TOKEN}` },
    body,
  });
}

async function subscriptions() {
  const response = await accept(
    client()(personalModelProvidersMainContract).list({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  return response.body.modelProviders;
}

describe("Atom subscription grants", () => {
  beforeEach(() => {
    mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", MACHINE_SECRET);
    server.use(
      http.get("https://api.anthropic.com/api/oauth/profile", ({ request }) => {
        const token = request.headers.get("authorization");
        const accountId =
          token === "Bearer sk-ant-third-account"
            ? "claude-third-account"
            : token === "Bearer sk-ant-another-account"
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
      http.get("https://api.anthropic.com/api/oauth/usage", () => {
        return HttpResponse.json({
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 0, resets_at: null },
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

  it("disables ingestion when the existing M2M secret is not configured", async () => {
    const body = fixture();
    mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", undefined);
    await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: `Bearer ${M2M_TOKEN}` },
        body,
      }),
      [503],
    );
    expect(context.mocks.clerk.authenticateRequest).not.toHaveBeenCalled();
  });

  it("accepts another Clerk-authorized machine without a grant-specific allowlist", async () => {
    const body = fixture();
    const delivered = await accept(
      client()(atomSubscriptionGrantsContract).deliver({
        headers: { authorization: "Bearer mt_other_machine" },
        body,
      }),
      [200],
    );
    expect(delivered.body).toStrictEqual({
      grantId: body.grantId,
      status: "delivered",
    });
    const listed = await accept(
      client()(personalModelProvidersMainContract).list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listed.body.modelProviders).toHaveLength(1);
    expect(listed.body.modelProviders[0]).toMatchObject({
      type: "claude-code-oauth-token",
      isActive: true,
    });
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

  it.each(["claude-code", "codex"] as const)(
    "cancels a delivered %s grant idempotently without allowing redelivery",
    async (provider) => {
      const body = fixture(provider);
      await accept(deliver(body), [200]);
      const cancelled = await accept(cancel(body), [200]);
      expect(cancelled.body).toStrictEqual({
        grantId: body.grantId,
        status: "cancelled",
      });
      expect((await accept(cancel(body), [200])).body).toStrictEqual(
        cancelled.body,
      );
      await expect(subscriptions()).resolves.toHaveLength(0);
      await accept(deliver(body), [409]);
      await expect(subscriptions()).resolves.toHaveLength(0);
    },
  );

  it("cancels before delivery and prevents an in-flight delivery from binding the subscription", async () => {
    const body = fixture();
    const started = createDeferredPromise<void>(context.signal);
    const profile = createDeferredPromise<Response>(context.signal);
    server.use(
      http.get("https://api.anthropic.com/api/oauth/profile", async () => {
        started.resolve();
        return await profile.promise;
      }),
    );
    const delivery = deliver(body);
    await started.promise;
    await accept(cancel(body), [200]).finally(() => {
      profile.resolve(
        HttpResponse.json({
          account: {
            uuid: "claude-first-account",
            email: "subscriber@example.com",
            has_claude_pro: true,
          },
          organization: { uuid: "claude-workspace", name: "Personal" },
        }),
      );
    });
    await accept(delivery, [409]);
    await expect(subscriptions()).resolves.toHaveLength(0);
  });

  it("keeps a cancellation receipt when delivery has not arrived yet", async () => {
    const body = fixture();
    await accept(cancel(body), [200]);
    await accept(deliver(body), [409]);
    await expect(subscriptions()).resolves.toHaveLength(0);
  });

  it.each(["active", "inactive"])(
    "cancels only the granted %s account and leaves a usable default",
    async (selection) => {
      const first = fixture();
      const second = {
        ...first,
        grantId: randomUUID(),
        tokens: {
          provider: "claude-code" as const,
          accessToken: "sk-ant-another-account",
        },
      };
      await accept(deliver(first), [200]);
      await accept(deliver(second), [200]);
      const before = await subscriptions();
      const remaining = before.find((account) => {
        return account.isActive === (selection === "inactive");
      });
      await accept(cancel(selection === "active" ? first : second), [200]);
      await expect(subscriptions()).resolves.toMatchObject([
        { id: remaining?.id, isActive: true },
      ]);
    },
  );

  it("does not cancel a newer grant for the same upstream account", async () => {
    const first = fixture();
    await accept(deliver(first), [200]);
    const [account] = await subscriptions();
    const second = { ...first, grantId: randomUUID() };
    await accept(deliver(second), [200]);
    await accept(cancel(first), [200]);
    await accept(cancel(first), [200]);
    await expect(subscriptions()).resolves.toMatchObject([
      { id: account?.id, isActive: true },
    ]);
    await accept(cancel(second), [200]);
    await expect(subscriptions()).resolves.toHaveLength(0);
  });

  it("keeps a connected default when two grants are cancelled concurrently", async () => {
    const first = fixture();
    const second = {
      ...first,
      grantId: randomUUID(),
      tokens: {
        provider: "claude-code" as const,
        accessToken: "sk-ant-another-account",
      },
    };
    const third = {
      ...first,
      grantId: randomUUID(),
      tokens: {
        provider: "claude-code" as const,
        accessToken: "sk-ant-third-account",
      },
    };
    for (const body of [first, second, third]) {
      await accept(deliver(body), [200]);
    }
    const remaining = (await subscriptions()).find((account) => {
      return account.accountEmail === "claude-third-account@example.com";
    });
    await Promise.all([
      accept(cancel(first), [200]),
      accept(cancel(second), [200]),
    ]);
    await expect(subscriptions()).resolves.toMatchObject([
      { id: remaining?.id, isActive: true },
    ]);
  });

  it("preserves the account when the recipient has reconnected it themselves", async () => {
    const body = fixture();
    await accept(deliver(body), [200]);
    const [account] = await subscriptions();
    await accept(
      client()(personalModelProvidersMainContract).upsert({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          type: "claude-code-oauth-token",
          secret: "sk-ant-manually-reconnected",
        },
      }),
      [200],
    );
    await accept(cancel(body), [200]);
    await expect(subscriptions()).resolves.toMatchObject([
      { id: account?.id, isActive: true },
    ]);
  });

  it("rejects cancellation with another recipient, organization or provider", async () => {
    const body = fixture();
    await accept(deliver(body), [200]);
    for (const change of [
      { userId: "another-user" },
      { orgId: "another-org" },
      { provider: "codex" as const },
    ]) {
      await accept(
        client()(atomSubscriptionGrantsContract).cancel({
          headers: { authorization: `Bearer ${M2M_TOKEN}` },
          params: { grantId: body.grantId },
          body: {
            orgId: body.orgId,
            userId: body.userId,
            provider: body.tokens.provider,
            ...change,
          },
        }),
        [409],
      );
    }
    await expect(subscriptions()).resolves.toHaveLength(1);
  });

  it("requires verified M2M authentication to cancel and preserves the account on auth failures", async () => {
    const body = fixture();
    await accept(deliver(body), [200]);
    await accept(
      client()(atomSubscriptionGrantsContract).cancel({
        headers: { authorization: "Bearer clerk-session" },
        params: { grantId: body.grantId },
        body: {
          orgId: body.orgId,
          userId: body.userId,
          provider: body.tokens.provider,
        },
      }),
      [401],
    );
    mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", undefined);
    await accept(cancel(body), [503]);
    await expect(subscriptions()).resolves.toHaveLength(1);
  });

  it("can cancel after the recipient has left the organization", async () => {
    const body = fixture();
    await accept(deliver(body), [200]);
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    await accept(cancel(body), [200]);
    await expect(subscriptions()).resolves.toHaveLength(0);
  });
});
