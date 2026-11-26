import { randomUUID } from "node:crypto";
import { atomSubscriptionGrantsContract } from "@okouai/api-contracts/contracts/atom-subscription-grants";
import {
  personalModelProvidersByTypeContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { atomSubscriptionGrantRoutes } from "../atom-subscription-grants";
import { meModelProvidersDeleteRoutes } from "../me-model-providers-delete";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { now } from "../../../lib/time";

const context = testContext();

const ATOM_M2M_TOKEN = "atom-m2m-token";
const atomHeaders = Object.freeze({
  authorization: `Bearer ${ATOM_M2M_TOKEN}`,
});
const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

interface Recipient {
  readonly userId: string;
  readonly orgId: string;
}

function bearerOf(request: unknown): string | null {
  if (!(request instanceof Request)) {
    return null;
  }
  return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
}

function acceptsM2M(options: unknown): boolean {
  return (
    typeof options === "object" &&
    options !== null &&
    "acceptsToken" in options &&
    options.acceptsToken === "m2m_token"
  );
}

/**
 * Identity provider boundary: Atom holds a verified M2M token, the recipient
 * holds a Clerk session for the organization.
 */
function arrangeIdentity(recipient: Recipient, members: { current: boolean }) {
  context.mocks.clerk.authenticateRequest.mockImplementation(
    (request: unknown, options: unknown) => {
      const token = bearerOf(request);
      if (acceptsM2M(options)) {
        return Promise.resolve(
          token === ATOM_M2M_TOKEN
            ? {
                isAuthenticated: true,
                toAuth: () => {
                  return {
                    tokenType: "m2m_token",
                    machineId: "mch_atom",
                    id: "m2m_atom_token",
                  };
                },
              }
            : { isAuthenticated: false },
        );
      }
      if (token === "clerk-session") {
        return Promise.resolve({
          isAuthenticated: true,
          toAuth: () => {
            return {
              userId: recipient.userId,
              orgId: recipient.orgId,
              orgRole: "org:member",
            };
          },
        });
      }
      return Promise.resolve({ isAuthenticated: false });
    },
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (params: unknown) => {
      const query =
        typeof params === "object" && params !== null
          ? (params as { organizationId?: string; userId?: string[] })
          : {};
      const matches =
        members.current &&
        query.organizationId === recipient.orgId &&
        (query.userId ?? []).includes(recipient.userId);
      return Promise.resolve({
        data: matches
          ? [
              {
                role: "org:member",
                publicUserData: { userId: recipient.userId },
                organization: { id: recipient.orgId },
              },
            ]
          : [],
        totalCount: matches ? 1 : 0,
      });
    },
  );
}

/** Anthropic OAuth profile API: each access token belongs to one account. */
function arrangeClaudeAccounts(accounts: ReadonlyMap<string, string>) {
  server.use(
    http.get("https://api.anthropic.com/api/oauth/profile", ({ request }) => {
      const token = bearerOf(request) ?? "";
      const account = accounts.get(token) ?? "unknown";
      return HttpResponse.json({
        account: {
          uuid: `acct-${account}`,
          email: `${account}@example.com`,
          has_claude_max: false,
          has_claude_pro: true,
        },
        organization: {
          uuid: `org-${account}`,
          name: `${account} workspace`,
          organization_type: "claude_pro",
        },
      });
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", () => {
      return HttpResponse.json({});
    }),
  );
}

function setup() {
  const recipient: Recipient = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const members = { current: true };
  arrangeIdentity(recipient, members);
  const appFor = setupApp({
    context,
    routes: [
      ...atomSubscriptionGrantRoutes,
      ...meModelProvidersListRoutes,
      ...meModelProvidersDeleteRoutes,
      ...meModelProvidersUpsertRoutes,
    ],
  });
  const atom = appFor(atomSubscriptionGrantsContract);
  const providers = appFor(personalModelProvidersMainContract);
  const providersByType = appFor(personalModelProvidersByTypeContract);

  async function listProviders() {
    const response = await accept(
      providers.list({ headers: sessionHeaders }),
      [200],
    );
    return response.body.modelProviders;
  }

  function claudeGrant(grantId: string, accessToken: string) {
    return {
      grantId,
      orgId: recipient.orgId,
      userId: recipient.userId,
      tokens: { provider: "claude-code" as const, accessToken },
    };
  }

  return {
    recipient,
    members,
    atom,
    providers,
    providersByType,
    listProviders,
    claudeGrant,
  };
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  return `${base64Url({ alg: "none", typ: "JWT" })}.${base64Url(payload)}.signature`;
}

describe("Atom subscription grants", () => {
  it("atom-subscription-grants-001 rejects a signed-in user's session token as Atom", async () => {
    const { atom, claudeGrant } = setup();
    arrangeClaudeAccounts(new Map([["claude-token-a", "alpha"]]));

    const response = await accept(
      atom.deliver({
        headers: sessionHeaders,
        body: claudeGrant(randomUUID(), "claude-token-a"),
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("atom-subscription-grants-008 refuses to deliver to a user outside the organization", async () => {
    const { atom, members, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(new Map([["claude-token-a", "alpha"]]));
    members.current = false;

    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(randomUUID(), "claude-token-a"),
      }),
      [403],
    );

    members.current = true;
    await expect(listProviders()).resolves.toStrictEqual([]);
  });

  it("atom-subscription-grants-009 delivers a Claude Code grant once and rejects a recipient change", async () => {
    const { atom, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(new Map([["claude-secret-token", "alpha"]]));
    const grantId = randomUUID();
    const grant = claudeGrant(grantId, "claude-secret-token");

    const first = await accept(
      atom.deliver({ headers: atomHeaders, body: grant }),
      [200],
    );
    const second = await accept(
      atom.deliver({ headers: atomHeaders, body: grant }),
      [200],
    );

    expect(first.body).toStrictEqual({ grantId, status: "delivered" });
    expect(second.body).toStrictEqual({ grantId, status: "delivered" });
    const list = await listProviders();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      type: "claude-code-oauth-token",
      isActive: true,
    });
    expect(JSON.stringify(list)).not.toContain("claude-secret-token");

    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: { ...grant, userId: `user_${randomUUID()}` },
      }),
      [409],
    );
  });

  it("atom-subscription-grants-010 delivers a Codex grant once and rejects a recipient change", async () => {
    const { atom, recipient, listProviders } = setup();
    server.use(
      http.get("https://chatgpt.com/backend-api/*", () => {
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    const exp = Math.floor(now() / 1000) + 3600;
    const accessToken = unsignedJwt({ exp, sub: "codex-access" });
    const grantId = randomUUID();
    const grant = {
      grantId,
      orgId: recipient.orgId,
      userId: recipient.userId,
      tokens: {
        provider: "codex" as const,
        accessToken,
        refreshToken: "codex-refresh-token",
        idToken: unsignedJwt({
          exp,
          email: "codex.user@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: `chatgpt-${randomUUID()}`,
            chatgpt_plan_type: "plus",
          },
        }),
      },
    };

    const first = await accept(
      atom.deliver({ headers: atomHeaders, body: grant }),
      [200],
    );
    const second = await accept(
      atom.deliver({ headers: atomHeaders, body: grant }),
      [200],
    );

    expect(first.body).toStrictEqual({ grantId, status: "delivered" });
    expect(second.body).toStrictEqual({ grantId, status: "delivered" });
    const list = await listProviders();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      type: "codex-oauth-token",
      isActive: true,
    });
    expect(JSON.stringify(list)).not.toContain(accessToken);

    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: { ...grant, userId: `user_${randomUUID()}` },
      }),
      [409],
    );
  });

  it("atom-subscription-grants-011 keeps the existing default when a second subscription arrives", async () => {
    const { atom, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(
      new Map([
        ["claude-token-a", "alpha"],
        ["claude-token-b", "bravo"],
      ]),
    );
    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(randomUUID(), "claude-token-a"),
      }),
      [200],
    );
    const [firstAccount] = await listProviders();

    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(randomUUID(), "claude-token-b"),
      }),
      [200],
    );

    const list = await listProviders();
    expect(list).toHaveLength(2);
    const active = list.filter((provider) => {
      return provider.isActive;
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(firstAccount?.id);
  });

  it("atom-subscription-grants-012 does not restore a subscription the recipient disconnected", async () => {
    const { atom, providersByType, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(new Map([["claude-token-a", "alpha"]]));
    const grant = claudeGrant(randomUUID(), "claude-token-a");
    await accept(atom.deliver({ headers: atomHeaders, body: grant }), [200]);
    await accept(
      providersByType.delete({
        headers: sessionHeaders,
        params: { type: "claude-code-oauth-token" },
      }),
      [204],
    );

    await accept(atom.deliver({ headers: atomHeaders, body: grant }), [200]);

    await expect(listProviders()).resolves.toStrictEqual([]);
  });

  it("atom-subscription-grants-013 cancels a delivered grant idempotently and blocks redelivery", async () => {
    const { atom, recipient, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(new Map([["claude-token-a", "alpha"]]));
    const grantId = randomUUID();
    const grant = claudeGrant(grantId, "claude-token-a");
    await accept(atom.deliver({ headers: atomHeaders, body: grant }), [200]);
    const cancel = {
      headers: atomHeaders,
      params: { grantId },
      body: {
        orgId: recipient.orgId,
        userId: recipient.userId,
        provider: "claude-code" as const,
      },
    };

    const first = await accept(atom.cancel(cancel), [200]);
    const second = await accept(atom.cancel(cancel), [200]);

    expect(first.body).toStrictEqual({ grantId, status: "cancelled" });
    expect(second.body).toStrictEqual({ grantId, status: "cancelled" });
    await expect(listProviders()).resolves.toStrictEqual([]);
    await accept(atom.deliver({ headers: atomHeaders, body: grant }), [409]);
    await expect(listProviders()).resolves.toStrictEqual([]);
  });

  it("atom-subscription-grants-017 cancelling the active account leaves the other account active", async () => {
    const { atom, recipient, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(
      new Map([
        ["claude-token-a", "alpha"],
        ["claude-token-b", "bravo"],
      ]),
    );
    const firstGrantId = randomUUID();
    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(firstGrantId, "claude-token-a"),
      }),
      [200],
    );
    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(randomUUID(), "claude-token-b"),
      }),
      [200],
    );
    const before = await listProviders();
    const other = before.find((provider) => {
      return !provider.isActive;
    });

    await accept(
      atom.cancel({
        headers: atomHeaders,
        params: { grantId: firstGrantId },
        body: {
          orgId: recipient.orgId,
          userId: recipient.userId,
          provider: "claude-code",
        },
      }),
      [200],
    );

    const after = await listProviders();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: other?.id, isActive: true });
  });

  it("atom-subscription-grants-019 cancelling an older grant keeps a newer grant for the same account", async () => {
    const { atom, recipient, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(
      new Map([
        ["claude-token-old", "alpha"],
        ["claude-token-new", "alpha"],
      ]),
    );
    const olderGrantId = randomUUID();
    const newerGrantId = randomUUID();
    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(olderGrantId, "claude-token-old"),
      }),
      [200],
    );
    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(newerGrantId, "claude-token-new"),
      }),
      [200],
    );
    const cancelBody = {
      orgId: recipient.orgId,
      userId: recipient.userId,
      provider: "claude-code" as const,
    };

    await accept(
      atom.cancel({
        headers: atomHeaders,
        params: { grantId: olderGrantId },
        body: cancelBody,
      }),
      [200],
    );
    await accept(
      atom.cancel({
        headers: atomHeaders,
        params: { grantId: olderGrantId },
        body: cancelBody,
      }),
      [200],
    );

    const remaining = await listProviders();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.isActive).toBeTruthy();

    await accept(
      atom.cancel({
        headers: atomHeaders,
        params: { grantId: newerGrantId },
        body: cancelBody,
      }),
      [200],
    );
    await expect(listProviders()).resolves.toStrictEqual([]);
  });

  it("atom-subscription-grants-021 keeps an account the recipient reconnected themselves", async () => {
    const { atom, recipient, providers, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(
      new Map([
        ["claude-token-granted", "alpha"],
        ["claude-token-own", "alpha"],
      ]),
    );
    const grantId = randomUUID();
    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(grantId, "claude-token-granted"),
      }),
      [200],
    );
    await accept(
      providers.upsert({
        headers: sessionHeaders,
        body: { type: "claude-code-oauth-token", secret: "claude-token-own" },
      }),
      [200, 201],
    );
    const [reconnected] = await listProviders();

    await accept(
      atom.cancel({
        headers: atomHeaders,
        params: { grantId },
        body: {
          orgId: recipient.orgId,
          userId: recipient.userId,
          provider: "claude-code",
        },
      }),
      [200],
    );

    const after = await listProviders();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: reconnected?.id, isActive: true });
  });

  it("atom-subscription-grants-022 rejects cancellation for another recipient, organization or provider", async () => {
    const { atom, recipient, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(new Map([["claude-token-a", "alpha"]]));
    const grantId = randomUUID();
    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(grantId, "claude-token-a"),
      }),
      [200],
    );
    const body = {
      orgId: recipient.orgId,
      userId: recipient.userId,
      provider: "claude-code" as const,
    };

    for (const mismatch of [
      { ...body, userId: `user_${randomUUID()}` },
      { ...body, orgId: `org_${randomUUID()}` },
      { ...body, provider: "codex" as const },
    ]) {
      await accept(
        atom.cancel({
          headers: atomHeaders,
          params: { grantId },
          body: mismatch,
        }),
        [409],
      );
    }

    await expect(listProviders()).resolves.toHaveLength(1);
  });

  it("atom-subscription-grants-024 cancels a grant after the recipient left the organization", async () => {
    const { atom, recipient, members, listProviders, claudeGrant } = setup();
    arrangeClaudeAccounts(new Map([["claude-token-a", "alpha"]]));
    const grantId = randomUUID();
    await accept(
      atom.deliver({
        headers: atomHeaders,
        body: claudeGrant(grantId, "claude-token-a"),
      }),
      [200],
    );
    members.current = false;

    await accept(
      atom.cancel({
        headers: atomHeaders,
        params: { grantId },
        body: {
          orgId: recipient.orgId,
          userId: recipient.userId,
          provider: "claude-code",
        },
      }),
      [200],
    );

    await expect(listProviders()).resolves.toStrictEqual([]);
  });
});
