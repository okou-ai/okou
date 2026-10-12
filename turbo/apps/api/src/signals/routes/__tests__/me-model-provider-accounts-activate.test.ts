import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { meModelProviderAccountRoutes } from "../me-model-provider-accounts";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  mockClaudeCodeTokenEndpoint,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const auth = createAuthDeviceApiActions(context);
const support = createAuthDeviceSupportApi(context);
const mocks = createRouteMocks(context);

function accountsClient(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return setupApp({ context, routes: meModelProviderAccountRoutes })(
    personalModelProviderAccountsByIdContract,
  );
}
function activate(
  actor: ApiTestUser,
  id: string,
  statuses: readonly (200 | 404 | 409)[] = [200],
) {
  return accept(
    accountsClient(actor).activate({
      headers: { authorization: "Bearer clerk-session" },
      params: { id },
      body: {},
    }),
    statuses,
  );
}
async function connectCodex(actor: ApiTestUser) {
  mockCodexDeviceAuthProvider({ accountId: randomUUID() });
  const started = await auth.requestCodexStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error("Expected Codex authorization to start");
  }
  const completed = await auth.requestCodexComplete(
    actor,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in completed.body) || completed.body.status !== "complete") {
    throw new Error("Expected a connected Codex account");
  }
  return completed.body.provider;
}
async function connectClaude(actor: ApiTestUser) {
  mockClaudeCodeTokenEndpoint({ accountEmail: `${randomUUID()}@example.com` });
  const started = await auth.requestClaudeCodeStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error("Expected Claude authorization to start");
  }
  const state = new URL(started.body.browserUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected an authorization state");
  }
  const completed = await auth.requestClaudeCodeComplete(
    actor,
    started.body.sessionToken,
    `claude_code_test#${state}`,
    [200],
  );
  if (completed.status !== 200) {
    throw new Error("Expected a connected Claude account");
  }
  return completed.body.provider;
}
async function list(actor: ApiTestUser) {
  const result = await support.listPersonalModelProviders(actor, [200]);
  if (!("modelProviders" in result.body)) {
    throw new Error("Expected the member's subscription accounts");
  }
  return result.body.modelProviders;
}

describe("POST /api/me/model-provider-accounts/:id/activate", () => {
  it.each(["codex", "claude"] as const)(
    "switches %s accounts and preserves the other subscription type",
    async (type) => {
      const actor = bdd.user({ orgRole: "org:member" });
      const connect = type === "codex" ? connectCodex : connectClaude;
      const first = await connect(actor);
      const second = await connect(actor);
      const other = await (type === "codex" ? connectClaude : connectCodex)(
        actor,
      );
      expect(first.isActive).toBeTruthy();
      expect(second.isActive).toBeFalsy();
      const changedAt = new Date("2026-10-09T14:00:00Z");
      mockNow(changedAt);
      const switched = await activate(actor, second.id);
      expect(switched.body).toMatchObject({
        ...second,
        isActive: true,
        updatedAt: changedAt.toISOString(),
      });
      await expect(list(actor)).resolves.toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: first.id,
            isActive: false,
            updatedAt: changedAt.toISOString(),
          }),
          expect.objectContaining({ id: second.id, isActive: true }),
          expect.objectContaining({ id: other.id, isActive: true }),
        ]),
      );
      await activate(actor, first.id);
      expect(
        (await list(actor)).filter((account) => {
          return account.isActive;
        }),
      ).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id }),
          expect.objectContaining({ id: other.id }),
        ]),
      );
    },
  );

  it("activates the same sole account repeatedly with nullable metadata", async () => {
    const actor = bdd.user();
    server.use(
      http.get("https://api.anthropic.com/api/oauth/profile", () => {
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const connected = await createMiscRoutesApi(
      context,
    ).upsertPersonalModelProvider(
      actor,
      { type: "claude-code-oauth-token", secret: "sk-ant-oat-null-metadata" },
      [201],
    );
    if (connected.status !== 201) {
      throw new Error("Expected the subscription to be connected");
    }
    const initial = connected.body.provider;
    for (const time of ["2026-10-09T14:00:00Z", "2026-10-09T14:01:00Z"]) {
      mockNow(new Date(time));
      const response = await activate(actor, initial.id);
      expect(response.body).toMatchObject({
        id: initial.id,
        modelProviderId: initial.modelProviderId,
        createdAt: initial.createdAt,
        updatedAt: new Date(time).toISOString(),
        isActive: true,
        accountEmail: null,
        workspaceName: null,
        planType: null,
        subscriptionResetPeriod: null,
        subscriptionNextResetAt: null,
        lastRefreshErrorCode: null,
      });
    }
    await expect(list(actor)).resolves.toHaveLength(1);
  });

  it("rejects unknown, logical-provider, foreign-user and foreign-org IDs without switching", async () => {
    const owner = bdd.user();
    const first = await connectCodex(owner);
    const second = await connectCodex(owner);
    const providerId = first.modelProviderId;
    if (!providerId) {
      throw new Error("Expected the connected account logical provider ID");
    }
    const stranger = bdd.user({ orgId: owner.orgId });
    const otherOrg = bdd.user({ userId: owner.userId });
    for (const [actor, id] of [
      [owner, randomUUID()],
      [owner, providerId],
      [stranger, second.id],
      [otherOrg, second.id],
    ] as const) {
      const rejected = await activate(actor, id, [404]);
      expect(rejected.body).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(
        (await list(owner)).filter((account) => {
          return account.isActive;
        }),
      ).toStrictEqual([expect.objectContaining({ id: first.id })]);
    }
  });

  it("rejects a disconnected account without changing the active sibling", async () => {
    const actor = bdd.user();
    const first = await connectCodex(actor);
    const second = await connectCodex(actor);
    await support.deletePersonalModelProviderAccount(actor, second.id);
    await activate(actor, second.id, [404]);
    await expect(list(actor)).resolves.toStrictEqual([
      expect.objectContaining({ id: first.id, isActive: true }),
    ]);
  });

  it("keeps one active account after competing switches and permits a subsequent save", async () => {
    const actor = bdd.user();
    await connectCodex(actor);
    const second = await connectCodex(actor);
    const third = await connectCodex(actor);
    const responses = await Promise.all([
      activate(actor, second.id, [200, 409]),
      activate(actor, third.id, [200, 409]),
    ]);
    expect(
      responses.some((response) => {
        return response.status === 200;
      }),
    ).toBeTruthy();
    const active = (await list(actor)).filter((account) => {
      return account.isActive;
    });
    expect(active).toHaveLength(1);
    expect([second.id, third.id]).toContain(active[0]?.id);
    await activate(actor, second.id);
    expect(
      (await list(actor)).filter((account) => {
        return account.isActive;
      }),
    ).toStrictEqual([expect.objectContaining({ id: second.id })]);
  });

  it.each(["target", "sibling"] as const)(
    "does not resurrect a disconnected %s during a competing switch",
    async (selection) => {
      const actor = bdd.user();
      const first = await connectCodex(actor);
      const second = await connectCodex(actor);
      const removed = selection === "target" ? second : first;
      await Promise.all([
        activate(actor, second.id, [200, 404, 409]),
        accept(
          accountsClient(actor).delete({
            headers: { authorization: "Bearer clerk-session" },
            params: { id: removed.id },
          }),
          [204],
        ),
      ]);
      const remaining = await list(actor);
      expect(
        remaining.map((account) => {
          return account.id;
        }),
      ).not.toContain(removed.id);
      expect(
        remaining.filter((account) => {
          return account.isActive;
        }).length,
      ).toBeLessThanOrEqual(1);
      await activate(actor, removed.id, [404]);
      await activate(actor, selection === "target" ? first.id : second.id);
    },
  );

  it("preserves a concurrent new connection while switching existing accounts", async () => {
    const actor = bdd.user();
    await connectCodex(actor);
    const second = await connectCodex(actor);
    await Promise.all([
      activate(actor, second.id, [200, 409]),
      connectCodex(actor),
    ]);
    const accounts = await list(actor);
    expect(accounts).toHaveLength(3);
    expect(
      accounts.filter((account) => {
        return account.isActive;
      }),
    ).toHaveLength(1);
    await activate(actor, second.id);
  });
});
