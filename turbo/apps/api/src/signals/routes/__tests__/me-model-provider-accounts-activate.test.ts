import { setupApp } from "../../../__tests__/test-helpers";
import { randomUUID } from "node:crypto";
import { createRouteMocks } from "./helpers/route-test";
import { claudeCodeDeviceAuthContract } from "@okouai/api-contracts/contracts/claude-code-device-auth";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import {
  personalModelProviderAccountsByIdContract,
  personalModelProvidersMainContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext, accept } from "../../../__tests__/test-context";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { claudeCodeDeviceAuthRoutes } from "../claude-code-device-auth";
import { codexDeviceAuthRoutes } from "../codex-device-auth";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { meModelProvidersListRoutes } from "../me-model-providers-list";
import { jwt } from "./helpers/codex-reset-credit-expiry";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const CLOCK = "2026-10-09T14:00:00.000Z";

type Kind = "codex" | "claude";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

function owner(): Owner {
  return { userId: `user_${randomUUID()}`, orgId: `org_${randomUUID()}` };
}

function signIn(actor: Owner) {
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
}

/**
 * OpenAI and Anthropic approve each device authorization with a distinct
 * account, and answer the account reads that follow.
 */
function providers() {
  const claudeTokens = new Map<string, string>();
  server.use(
    http.post(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      () => {
        return HttpResponse.json({
          device_auth_id: `dev_${randomUUID()}`,
          user_code: "ABCD-EFGH",
          interval: 5,
        });
      },
    ),
    http.post("https://auth.openai.com/api/accounts/deviceauth/token", () => {
      return HttpResponse.json({
        authorization_code: `code_${randomUUID()}`,
        code_challenge: "challenge",
        code_verifier: "verifier",
      });
    }),
    http.post("https://auth.openai.com/oauth/token", () => {
      const accountId = randomUUID();
      return HttpResponse.json({
        access_token: jwt({ exp: 4_102_444_800, jti: randomUUID() }),
        refresh_token: `refresh-${randomUUID()}`,
        id_token: jwt({
          email: `${accountId}@example.test`,
          "https://api.openai.com/auth": {
            chatgpt_account_id: accountId,
            chatgpt_plan_type: "plus",
          },
        }),
      });
    }),
    http.get("https://chatgpt.com/backend-api/wham/usage", () => {
      return HttpResponse.json({ plan_type: "plus" });
    }),
    http.get(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      () => {
        return HttpResponse.json({ credits: [] });
      },
    ),
    http.post("https://platform.claude.com/v1/oauth/token", () => {
      const accessToken = `sk-ant-oat01-${randomUUID()}`;
      claudeTokens.set(accessToken, randomUUID());
      return HttpResponse.json({ access_token: accessToken });
    }),
    http.get("https://api.anthropic.com/api/oauth/profile", ({ request }) => {
      const token = (request.headers.get("authorization") ?? "").replace(
        /^Bearer /u,
        "",
      );
      const uuid = claudeTokens.get(token) ?? randomUUID();
      return HttpResponse.json({
        account: { uuid, email: `${uuid}@example.test` },
        organization: {
          uuid: `org-${uuid}`,
          name: "Claude Workspace",
          organization_type: "claude_max",
          rate_limit_tier: "default_claude_max_5x",
        },
      });
    }),
    http.get("https://api.anthropic.com/api/oauth/usage", () => {
      return HttpResponse.json({});
    }),
  );
}

function main() {
  return setupApp({ context, routes: meModelProvidersListRoutes })(
    personalModelProvidersMainContract,
  );
}

function accounts() {
  return setupApp({ context, routes: meModelProviderAccountRoutes })(
    personalModelProviderAccountsByIdContract,
  );
}

/** The member adds one subscription account through its device authorization. */
async function connect(actor: Owner, kind: Kind) {
  signIn(actor);
  if (kind === "codex") {
    const codex = setupApp({ context, routes: codexDeviceAuthRoutes })(
      codexDeviceAuthContract,
    );
    const started = await accept(
      codex.start({ headers, body: { scope: "personal", mode: "add" } }),
      [200],
    );
    const completed = await accept(
      codex.complete({
        headers,
        body: { sessionToken: started.body.sessionToken },
      }),
      [200],
    );
    if (!("provider" in completed.body)) {
      throw new Error("Codex device authorization did not complete");
    }
    return completed.body.provider;
  }
  const claude = setupApp({ context, routes: claudeCodeDeviceAuthRoutes })(
    claudeCodeDeviceAuthContract,
  );
  const started = await accept(
    claude.start({ headers, body: { scope: "personal", mode: "add" } }),
    [200],
  );
  const state = new URL(started.body.browserUrl).searchParams.get("state");
  const completed = await accept(
    claude.complete({
      headers,
      body: {
        sessionToken: started.body.sessionToken,
        authorizationCode: `code-${randomUUID()}#${state ?? ""}`,
      },
    }),
    [200],
  );
  return completed.body.provider;
}

async function list(actor: Owner) {
  signIn(actor);
  const response = await accept(main().list({ headers }), [200]);
  return response.body.modelProviders;
}

async function activeIds(actor: Owner) {
  return (await list(actor))
    .filter((provider) => {
      return provider.isActive === true;
    })
    .map((provider) => {
      return provider.id;
    });
}

async function activate(actor: Owner, id: string) {
  signIn(actor);
  const response = await accept(
    accounts().activate({ headers, params: { id }, body: {} }),
    [200],
  );
  return response.body;
}

async function rejectActivation(actor: Owner, id: string) {
  signIn(actor);
  const response = await accept(
    accounts().activate({ headers, params: { id }, body: {} }),
    [404],
  );
  return response.body;
}

async function disconnect(actor: Owner, id: string) {
  signIn(actor);
  await accept(accounts().delete({ headers, params: { id } }), [204]);
}

async function switchesWithinType(kind: Kind, other: Kind) {
  providers();
  const member = owner();
  const first = await connect(member, kind);
  const second = await connect(member, kind);
  const sibling = await connect(member, other);
  mockNow(new Date(CLOCK));

  const activated = await activate(member, second.id);
  expect(activated).toMatchObject({
    id: second.id,
    isActive: true,
    updatedAt: CLOCK,
  });
  const listed = await list(member);
  expect(
    listed.map((provider) => {
      return { id: provider.id, isActive: provider.isActive };
    }),
  ).toStrictEqual(
    expect.arrayContaining([
      { id: first.id, isActive: false },
      { id: second.id, isActive: true },
      { id: sibling.id, isActive: true },
    ]),
  );
  expect(
    listed.find((provider) => {
      return provider.id === first.id;
    })?.updatedAt,
  ).toBe(CLOCK);

  await activate(member, first.id);
  return {
    active: new Set(await activeIds(member)),
    expected: new Set([first.id, sibling.id]),
  };
}

async function promotesOldestSibling(kind: Kind) {
  providers();
  const member = owner();
  const first = await connect(member, kind);
  const second = await connect(member, kind);
  const third = await connect(member, kind);
  const states = async () => {
    return (await list(member)).map((provider) => {
      return { id: provider.id, isActive: provider.isActive };
    });
  };

  await disconnect(member, first.id);
  await expect(states()).resolves.toStrictEqual(
    expect.arrayContaining([
      { id: second.id, isActive: true },
      { id: third.id, isActive: false },
    ]),
  );
  await expect(states()).resolves.toHaveLength(2);
  await rejectActivation(member, first.id);
  await disconnect(member, third.id);
  await expect(states()).resolves.toStrictEqual([
    { id: second.id, isActive: true },
  ]);
  await disconnect(member, second.id);
  await expect(states()).resolves.toStrictEqual([]);

  const replacement = await connect(member, kind);
  return { first, replacement };
}

describe("POST /api/me/model-provider-accounts/:id/activate", () => {
  it("me-model-provider-accounts-activate-005 rejects a disconnected account without changing the active sibling", async () => {
    providers();
    const member = owner();
    const first = await connect(member, "codex");
    const second = await connect(member, "codex");
    await disconnect(member, second.id);

    await rejectActivation(member, second.id);

    const listed = await list(member);
    expect(
      listed.map((provider) => {
        return { id: provider.id, isActive: provider.isActive };
      }),
    ).toStrictEqual([{ id: first.id, isActive: true }]);
  });

  it("me-model-provider-accounts-activate-004 rejects logical-provider, foreign-user and foreign-org IDs without switching", async () => {
    providers();
    const member = owner();
    const first = await connect(member, "codex");
    const second = await connect(member, "codex");
    const logicalId = first.modelProviderId;
    if (!logicalId) {
      throw new Error("Expected a logical provider ID on the account");
    }
    const peer = { userId: `user_${randomUUID()}`, orgId: member.orgId };
    const elsewhere = { userId: member.userId, orgId: `org_${randomUUID()}` };

    for (const [actor, id] of [
      [member, logicalId],
      [peer, second.id],
      [elsewhere, second.id],
    ] as const) {
      await expect(rejectActivation(actor, id)).resolves.toMatchObject({
        error: { code: "NOT_FOUND" },
      });
      await expect(activeIds(member)).resolves.toStrictEqual([first.id]);
    }
  });

  it("me-model-provider-accounts-activate-002 switches claude accounts and preserves the other subscription type", async () => {
    const { active, expected } = await switchesWithinType("claude", "codex");
    expect(active).toStrictEqual(expected);
  });

  it("me-model-provider-accounts-activate-007 promotes the oldest connected claude sibling when the active account is disconnected", async () => {
    const { first, replacement } = await promotesOldestSibling("claude");
    expect(replacement.isActive).toBeTruthy();
    expect(replacement.modelProviderId).not.toBe(first.modelProviderId);
  });

  it("me-model-provider-accounts-activate-001 switches codex accounts and preserves the other subscription type", async () => {
    const { active, expected } = await switchesWithinType("codex", "claude");
    expect(active).toStrictEqual(expected);
  });

  it("me-model-provider-accounts-activate-006 promotes the oldest connected codex sibling when the active account is disconnected", async () => {
    const { first, replacement } = await promotesOldestSibling("codex");
    expect(replacement.isActive).toBeTruthy();
    expect(replacement.modelProviderId).not.toBe(first.modelProviderId);
  });
});
