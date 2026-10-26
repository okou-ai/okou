import { randomUUID } from "node:crypto";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  runnerBrowserContract,
  type RunnerBrowserAction,
  type RunnerBrowserResponse,
} from "@okouai/api-contracts/contracts/runner-browser";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { z } from "zod";
import { accept, testContext } from "../../../__tests__/test-context";
import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settle } from "../../utils";
import {
  mockNow,
  withMockNowForTest,
  withNowScopeForTest,
} from "../../../lib/time";
import { runnerBrowserRoutes } from "../runner-browser";
import { browserRoutes } from "../browser";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  okouTokenFromClaim,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const START = Date.parse("2026-10-25T14:00:00.000Z");
const MINUTE = 60_000;
const runs = createRunsApi(context);
const PROVIDER_URL = "https://api.browser-use.com/api/v3";

function profileProvider(beforeResponse?: () => Promise<void>) {
  const profiles = new Map<
    string,
    { readonly id: string; readonly name: string }
  >();
  const createdIds: string[] = [];
  function profile(id: string, name = "owned-provider-profile") {
    return {
      id,
      name,
      createdAt: new Date(START).toISOString(),
      updatedAt: new Date(START).toISOString(),
    };
  }
  const handlers = [
    http.post(`${PROVIDER_URL}/profiles`, async ({ request }) => {
      const { name } = z
        .strictObject({ name: z.string() })
        .parse(await request.json());
      const id = randomUUID();
      profiles.set(id, { id, name });
      createdIds.push(id);
      await beforeResponse?.();
      return HttpResponse.json(profile(id, name), { status: 201 });
    }),
    http.get(`${PROVIDER_URL}/profiles/:id`, ({ params }) => {
      const stored = profiles.get(String(params.id));
      return stored
        ? HttpResponse.json(profile(stored.id, stored.name))
        : HttpResponse.json({ detail: "Profile missing" }, { status: 404 });
    }),
    http.delete(`${PROVIDER_URL}/profiles/:id`, ({ params }) => {
      profiles.delete(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
  ];
  return { handlers, createdIds, profile };
}

function client() {
  return setupApp({ context, routes: runnerBrowserRoutes })(
    runnerBrowserContract,
  );
}

function officialHeaders() {
  return {
    authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function accepted(result: RunnerBrowserResponse) {
  expect(result.outcome).toBe("accepted");
  if (result.outcome !== "accepted") {
    throw new Error("Expected an accepted Browser lifecycle operation");
  }
  return result.instance;
}

async function fixture(enabled = true, provider = profileProvider()) {
  mockEnv("OKOU_BROWSER_USE_API_KEY", "owner-profile-test-key");
  server.use(...provider.handlers);
  const owned = await publicChatActor(context, {
    clockTime: START,
    optionalEnvironmentNames: ["OKOU_BROWSER_USE_API_KEY"],
  });
  const featureActor = { ...owned.actor, orgId: requireOrgId(owned.actor) };
  const chat = createChatFilesBddApi(context);
  if (enabled) {
    owned.ownsFeatureSwitches();
    await owned.run(() => {
      return updateFeatureSwitchesForUser(context, featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: true,
      });
    });
  }
  async function start(browserEnabled = true) {
    return await owned.run(async () => {
      const sent = await chat.sendAndLaunch(owned.actor, {
        agentId: owned.agentId,
        prompt: "Prepare my chat-owned Browser lifetime",
        cloudBrowserEnabled: browserEnabled,
      });
      const runnerIdentity = { runnerId: randomUUID(), heartbeatGeneration: 7 };
      await withNowScopeForTest(() => {
        return runs.requestHeartbeatRunner(true, [200], {
          group: owned.runnerGroup,
          runnerId: runnerIdentity.runnerId,
          snapshotGeneration: runnerIdentity.heartbeatGeneration,
        });
      });
      const claim = await owned.claimRunnerRun(sent.runId, { runnerIdentity });
      function control(action: RunnerBrowserAction) {
        return client().control({
          headers: officialHeaders(),
          params: { runId: sent.runId },
          body: { runnerIdentity, action },
        });
      }
      async function request(action: RunnerBrowserAction) {
        const result = await accept(control(action), [200]);
        return result.body;
      }
      return { ...sent, runnerIdentity, claim, request, control };
    });
  }
  return { owned, start, featureActor, provider };
}

type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;

async function allocate(chat: Chat) {
  const instance = accepted(await chat.request({ kind: "allocate" }));
  return accepted(
    await chat.request({
      kind: "publish",
      instanceId: instance.id,
      providerSessionId: randomUUID(),
      timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
    }),
  );
}

async function admit(chat: Chat, instanceId: string, primaryWindowId: number) {
  const instance = accepted(
    await chat.request({ kind: "admit", instanceId, primaryWindowId }),
  );
  expect(instance.window).toMatchObject({ primaryWindowId, state: "active" });
  return { instanceId, primaryWindowId };
}

function authorization(
  instance: ReturnType<typeof accepted>,
  primaryWindowId: number,
) {
  if (instance.providerSessionId === null) {
    throw new Error("Expected a published provider session");
  }
  return {
    kind: "authorize" as const,
    instanceId: instance.id,
    providerSessionId: instance.providerSessionId,
    primaryWindowId,
  };
}

describe("official Runner Browser authorization", () => {
  it("authorizes only the exact live chat window without renewing its lease", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      await expect(
        a.request({
          kind: "authorize",
          instanceId: randomUUID(),
          providerSessionId: randomUUID(),
          primaryWindowId: 0,
        }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      const instance = await allocate(a);
      const action = authorization(instance, 0);
      await expect(a.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await admit(a, instance.id, 0);
      const wb = await admit(b, instance.id, 102);
      const before = accepted(await a.request({ kind: "inspect" }));
      expect(accepted(await a.request(action))).toStrictEqual(before);
      expect(before.window).toMatchObject({
        primaryWindowId: 0,
        expiresAt: START + 10 * MINUTE,
      });
      for (const forged of [
        { ...action, instanceId: randomUUID() },
        { ...action, providerSessionId: randomUUID() },
        { ...action, primaryWindowId: wb.primaryWindowId },
      ]) {
        await expect(a.request(forged)).resolves.toStrictEqual({
          outcome: "unavailable",
        });
      }
      await expect(b.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      const siblingAction = authorization(instance, wb.primaryWindowId);
      expect(
        accepted(await b.request(siblingAction)).window?.chatThreadId,
      ).toBe(b.threadId);

      mockNow(START + 9 * MINUTE);
      expect(accepted(await a.request(action))).toStrictEqual(before);
      accepted(await b.request({ kind: "renew", ...wb }));
      mockNow(START + 10 * MINUTE);
      await expect(a.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect(accepted(await a.request({ kind: "inspect" }))).toStrictEqual(
        before,
      );
      expect(accepted(await b.request(siblingAction)).window?.state).toBe(
        "active",
      );
    });
  });

  it("retains cleanup identities while rejecting unpublished, closing, stopped and replaced windows", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      const creating = accepted(await chat.request({ kind: "allocate" }));
      const action = {
        kind: "authorize" as const,
        instanceId: creating.id,
        providerSessionId: randomUUID(),
        primaryWindowId: 0,
      };
      await expect(chat.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect(accepted(await chat.request({ kind: "inspect" })).status).toBe(
        "creating",
      );
      accepted(
        await chat.request({
          kind: "publish",
          instanceId: creating.id,
          providerSessionId: action.providerSessionId,
          timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
        }),
      );
      const original = await admit(chat, creating.id, 0);
      accepted(await chat.request(action));
      accepted(
        await chat.request({ kind: "retire", ...original, reason: "closed" }),
      );
      await expect(chat.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect(
        accepted(await chat.request({ kind: "inspect" })).window?.state,
      ).toBe("closing");
      accepted(
        await chat.request({ kind: "completeWindowClose", ...original }),
      );
      await expect(chat.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      const reopened = await admit(chat, creating.id, 1);
      await expect(chat.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      const currentAction = { ...action, primaryWindowId: 1 };
      accepted(await chat.request(currentAction));
      accepted(
        await chat.request({ kind: "retire", ...reopened, reason: "closed" }),
      );
      accepted(
        await chat.request({ kind: "beginStop", instanceId: creating.id }),
      );
      await expect(chat.request(currentAction)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect(accepted(await chat.request({ kind: "inspect" })).status).toBe(
        "stopping",
      );
      accepted(
        await chat.request({ kind: "completeStop", instanceId: creating.id }),
      );
      await expect(chat.request(currentAction)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect(accepted(await chat.request({ kind: "inspect" })).status).toBe(
        "stopped",
      );
      const replacement = await allocate(chat);
      await admit(chat, replacement.id, 1);
      await expect(chat.request(currentAction)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect(
        accepted(await chat.request(authorization(replacement, 1))).id,
      ).toBe(replacement.id);
    });
  });

  it("rejects authorization at the physical deadline without changing lifecycle metadata", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      const creating = accepted(await chat.request({ kind: "allocate" }));
      const instance = accepted(
        await chat.request({
          kind: "publish",
          instanceId: creating.id,
          providerSessionId: randomUUID(),
          timeoutAt: new Date(START + 5 * MINUTE).toISOString(),
        }),
      );
      await admit(chat, instance.id, 0);
      const action = authorization(instance, 0);
      const before = accepted(await chat.request({ kind: "inspect" }));
      mockNow(START + 4 * MINUTE);
      expect(accepted(await chat.request(action))).toStrictEqual(before);
      mockNow(START + 5 * MINUTE);
      await expect(chat.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect(accepted(await chat.request({ kind: "inspect" }))).toStrictEqual(
        before,
      );
    });
  });
});

describe("official Runner Browser lifecycle", () => {
  it("does not expose or mutate another owner's Browser generation", async () => {
    const first = await fixture();
    const other = await fixture();
    await first.owned.run(async () => {
      const a = await first.start();
      const instance = await allocate(a);
      await admit(a, instance.id, 0);
      await other.owned.run(async () => {
        const b = await other.start();
        await expect(
          b.request(authorization(instance, 0)),
        ).resolves.toStrictEqual({ outcome: "unavailable" });
        await expect(
          b.request({ kind: "inspect", instanceId: instance.id }),
        ).resolves.toStrictEqual({ outcome: "unavailable" });
        await expect(
          b.request({
            kind: "admit",
            instanceId: instance.id,
            primaryWindowId: 0,
          }),
        ).resolves.toStrictEqual({ outcome: "unavailable" });
        await expect(
          b.request({ kind: "beginStop", instanceId: instance.id }),
        ).resolves.toStrictEqual({ outcome: "unavailable" });
        const own = await allocate(b);
        expect(own.ownerProfileId).not.toBe(instance.ownerProfileId);
        expect(own.providerProfileId).not.toBe(instance.providerProfileId);
      });
      expect(accepted(await a.request({ kind: "inspect" })).status).toBe(
        "active",
      );
    });
  });

  it("requires the owner switch, current Runner assignment and Browser permission", async () => {
    const f = await fixture(false);
    await f.owned.run(async () => {
      const chat = await f.start();
      await expect(
        chat.request({
          kind: "allocate",
        }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      f.owned.ownsFeatureSwitches();
      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: true,
      });
      const forged = await accept(
        client().control({
          headers: officialHeaders(),
          params: { runId: chat.runId },
          body: {
            runnerIdentity: { ...chat.runnerIdentity, heartbeatGeneration: 8 },
            action: { kind: "inspect" },
          },
        }),
        [200],
      );
      expect(forged.body).toStrictEqual({ outcome: "unavailable" });
      for (const token of [
        okouTokenFromClaim(chat.claim),
        chat.claim.sandboxToken,
      ]) {
        await accept(
          client().control({
            headers: { authorization: `Bearer ${token}` },
            params: { runId: chat.runId },
            body: {
              runnerIdentity: chat.runnerIdentity,
              action: { kind: "inspect" },
            },
          }),
          [401],
        );
      }
      const pat = await createAuthOrgAgentsBddApi(context).createCliToken(
        f.owned.actor,
      );
      await accept(
        client().control({
          headers: { authorization: `Bearer ${pat.token}` },
          params: { runId: chat.runId },
          body: {
            runnerIdentity: chat.runnerIdentity,
            action: { kind: "inspect" },
          },
        }),
        [403],
      );
      const denied = await f.start(false);
      await expect(
        denied.request({
          kind: "allocate",
        }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });

      const instance = await allocate(chat);
      await admit(chat, instance.id, 0);
      const action = authorization(instance, 0);
      accepted(await chat.request(action));
      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: false,
      });
      await expect(chat.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect(
        accepted(await chat.request({ kind: "inspect" })).window
          ?.primaryWindowId,
      ).toBe(0);
      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: true,
      });
      expect(JSON.stringify(instance)).not.toMatch(
        /cdpUrl|liveUrl|secret|token/u,
      );
      const chatApi = createChatFilesBddApi(context);
      await chatApi.updateThreadComputerUseHost(
        f.owned.actor,
        chat.threadId,
        null,
        { cloudBrowserEnabled: false },
      );
      await expect(
        chat.request({ kind: "inspect", instanceId: instance.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      await expect(chat.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await chatApi.updateThreadComputerUseHost(
        f.owned.actor,
        chat.threadId,
        null,
        { cloudBrowserEnabled: true },
      );
      expect(accepted(await chat.request({ kind: "inspect" })).id).toBe(
        instance.id,
      );
      accepted(await chat.request(action));
      await withNowScopeForTest(() => {
        return runs.requestHeartbeatRunner(true, [200], {
          group: f.owned.runnerGroup,
          runnerId: chat.runnerIdentity.runnerId,
          snapshotGeneration: 8,
        });
      });
      await expect(
        chat.request({ kind: "inspect", instanceId: instance.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      await expect(chat.request(action)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      const terminal = await f.start();
      await admit(terminal, instance.id, 1);
      const terminalAction = authorization(instance, 1);
      accepted(await terminal.request(terminalAction));
      expect(accepted(await terminal.request({ kind: "inspect" })).id).toBe(
        instance.id,
      );
      await createWebhookCallbackApi(context).requestAgentComplete(
        {
          runId: terminal.runId,
          exitCode: 1,
          error: "Run terminated before further Browser control",
        },
        { authorization: `Bearer ${terminal.claim.sandboxToken}` },
        [200],
      );
      await expect(
        terminal.request({ kind: "inspect", instanceId: instance.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      await expect(terminal.request(terminalAction)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
    });
  });

  it("publishes one physical instance and admits one native candidate per chat", async () => {
    const both = createDeferredPromise<void>(context.signal);
    let arrivals = 0;
    const f = await fixture(
      true,
      profileProvider(async () => {
        if (++arrivals === 2) {
          both.resolve();
        }
        await both.promise;
      }),
    );
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      const allocations = await Promise.all(
        [a, b].map((chat) => {
          return chat.request({
            kind: "allocate",
          });
        }),
      );
      expect(
        allocations
          .map((r) => {
            return r.outcome;
          })
          .sort(),
      ).toStrictEqual(["accepted", "unavailable"]);
      const initial = accepted(await a.request({ kind: "inspect" }));
      expect(f.provider.createdIds).toHaveLength(2);
      for (const id of f.provider.createdIds) {
        expect((await fetch(`${PROVIDER_URL}/profiles/${id}`)).status).toBe(
          id === initial.providerProfileId ? 200 : 404,
        );
      }
      expect(accepted(await b.request({ kind: "inspect" })).id).toBe(
        initial.id,
      );
      accepted(
        await a.request({
          kind: "publish",
          instanceId: initial.id,
          providerSessionId: randomUUID(),
          timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
        }),
      );
      const candidates = await Promise.all(
        [0, 101].map((primaryWindowId) => {
          return a.request({
            kind: "admit",
            instanceId: initial.id,
            primaryWindowId,
          });
        }),
      );
      expect(
        candidates
          .map((r) => {
            return r.outcome;
          })
          .sort(),
      ).toStrictEqual(["accepted", "unavailable"]);
      const winner = accepted(await a.request({ kind: "inspect" })).window;
      if (!winner) {
        throw new Error("Missing registered chat window");
      }
      await expect(
        b.request({
          kind: "admit",
          instanceId: initial.id,
          primaryWindowId: winner.primaryWindowId,
        }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      const wb = await admit(b, initial.id, 102);
      const viewA = accepted(await a.request({ kind: "inspect" }));
      const viewB = accepted(await b.request({ kind: "inspect" }));
      expect(viewA.window).toStrictEqual(winner);
      expect(viewB.window).toMatchObject({
        primaryWindowId: 102,
        state: "active",
      });
      expect(viewB.window?.chatThreadId).not.toBe(winner.chatThreadId);
      await expect(a.request({ kind: "renew", ...wb })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await expect(
        a.request({ kind: "beginStop", instanceId: initial.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
    });
  });

  it("keeps native closure identity until acknowledgement and rejects old requests after reopen", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      const instance = await allocate(a);
      const wa = await admit(a, instance.id, 0),
        wb = await admit(b, instance.id, 102);
      mockNow(START + 9 * MINUTE);
      accepted(await b.request({ kind: "renew", ...wb }));
      mockNow(START + 10 * MINUTE);
      accepted(await a.request({ kind: "retire", ...wa, reason: "expired" }));
      await expect(
        a.request({
          kind: "admit",
          instanceId: instance.id,
          primaryWindowId: 1,
        }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      accepted(await a.request({ kind: "completeWindowClose", ...wa }));
      const replacement = await admit(a, instance.id, 1);
      await expect(a.request({ kind: "renew", ...wa })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await expect(
        a.request({ kind: "retire", ...wa, reason: "closed" }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      expect(
        accepted(await a.request({ kind: "inspect" })).window,
      ).toMatchObject({ primaryWindowId: 1, state: "active" });
      accepted(await b.request({ kind: "renew", ...wb }));
      await expect(
        a.request({ kind: "beginStop", instanceId: instance.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });

      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: false,
      });
      await expect(
        a.request({ kind: "renew", ...replacement }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      await expect(a.request({ kind: "allocate" })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      accepted(
        await a.request({ kind: "retire", ...replacement, reason: "closed" }),
      );
      await expect(
        a.request({ kind: "completeWindowClose", ...wa }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      accepted(await b.request({ kind: "retire", ...wb, reason: "closed" }));
      const stopping = accepted(
        await a.request({ kind: "beginStop", instanceId: instance.id }),
      );
      expect(stopping.status).toBe("stopping");
      expect(stopping.window).toMatchObject({
        primaryWindowId: 1,
        state: "closing",
      });
      expect(
        accepted(await a.request({ kind: "inspect", instanceId: instance.id }))
          .window,
      ).toStrictEqual(stopping.window);
      accepted(
        await a.request({ kind: "completeStop", instanceId: instance.id }),
      );
      expect(
        accepted(await a.request({ kind: "inspect", instanceId: instance.id }))
          .window,
      ).toBeNull();
      const later = await f.start();
      expect(accepted(await later.request({ kind: "inspect" }))).toMatchObject({
        id: instance.id,
        ownerProfileId: instance.ownerProfileId,
        providerProfileId: instance.providerProfileId,
        status: "stopped",
        window: null,
      });
    });
  });

  it("arbitrates lease and stop races and fences native ID reuse across physical replacement", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      const instance = await allocate(a),
        wa = await admit(a, instance.id, 101);
      mockNow(START + 9 * MINUTE);
      const beforeExpiry = await Promise.all([
        a.request({ kind: "renew", ...wa }),
        a.request({ kind: "retire", ...wa, reason: "expired" }),
      ]);
      expect(
        beforeExpiry.map((r) => {
          return r.outcome;
        }),
      ).toStrictEqual(["accepted", "unavailable"]);
      const atExpiry = await Promise.all([
        withMockNowForTest(START + 18 * MINUTE, () => {
          return a.request({ kind: "renew", ...wa });
        }),
        withMockNowForTest(START + 19 * MINUTE, () => {
          return a.request({ kind: "retire", ...wa, reason: "expired" });
        }),
      ]);
      expect(
        atExpiry
          .map((r) => {
            return r.outcome;
          })
          .sort(),
      ).toStrictEqual(["accepted", "unavailable"]);
      mockNow(START + 28 * MINUTE);
      if (atExpiry[0]?.outcome === "accepted") {
        accepted(await a.request({ kind: "retire", ...wa, reason: "expired" }));
      }
      await expect(a.request({ kind: "renew", ...wa })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      const wb = { instanceId: instance.id, primaryWindowId: 102 };
      const competing = await Promise.all([
        a.request({ kind: "beginStop", instanceId: instance.id }),
        b.request({ kind: "admit", ...wb }),
      ]);
      expect(
        competing
          .map((r) => {
            return r.outcome;
          })
          .sort(),
      ).toStrictEqual(["accepted", "unavailable"]);
      if (competing[1]?.outcome === "accepted") {
        await expect(
          a.request({ kind: "beginStop", instanceId: instance.id }),
        ).resolves.toStrictEqual({ outcome: "unavailable" });
        accepted(await b.request({ kind: "retire", ...wb, reason: "closed" }));
        accepted(
          await a.request({ kind: "beginStop", instanceId: instance.id }),
        );
      }
      expect(
        accepted(await a.request({ kind: "inspect", instanceId: instance.id }))
          .window,
      ).toMatchObject({ primaryWindowId: 101, state: "closing" });
      accepted(
        await a.request({ kind: "completeStop", instanceId: instance.id }),
      );
      const replacement = await allocate(a);
      expect(replacement.id).not.toBe(instance.id);
      expect(replacement.ownerProfileId).toBe(instance.ownerProfileId);
      expect(replacement.providerProfileId).toBe(instance.providerProfileId);
      expect(f.provider.createdIds).toHaveLength(1);
      expect(
        (await fetch(`${PROVIDER_URL}/profiles/${instance.providerProfileId}`))
          .status,
      ).toBe(200);
      const current = await admit(a, replacement.id, 101);
      await expect(
        a.request({ kind: "completeStop", instanceId: instance.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      for (const action of [
        { kind: "renew", ...wa },
        { kind: "retire", ...wa, reason: "closed" },
        { kind: "completeWindowClose", ...wa },
        { kind: "admit", ...wa },
      ] as const) {
        await expect(a.request(action)).resolves.toStrictEqual({
          outcome: "unavailable",
        });
      }
      expect(
        accepted(await a.request({ kind: "inspect" })).window,
      ).toMatchObject({ primaryWindowId: 101, state: "active" });
      accepted(
        await a.request({ kind: "retire", ...current, reason: "closed" }),
      );
      accepted(
        await a.request({ kind: "beginStop", instanceId: replacement.id }),
      );
      accepted(
        await a.request({ kind: "completeStop", instanceId: replacement.id }),
      );

      const abandoned = accepted(
        await b.request({
          kind: "allocate",
        }),
      );
      await expect(
        b.request({ kind: "beginStop", instanceId: abandoned.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      mockNow(START + 30 * MINUTE);
      await expect(
        b.request({
          kind: "publish",
          instanceId: abandoned.id,
          providerSessionId: randomUUID(),
          timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
        }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      accepted(
        await b.request({ kind: "beginStop", instanceId: abandoned.id }),
      );
      accepted(
        await b.request({ kind: "completeStop", instanceId: abandoned.id }),
      );
    });
  });
});

describe("owner provider profiles", () => {
  it("reports a cleanup deadline that expires before candidate reference reconciliation", async () => {
    const both = createDeferredPromise<void>(context.signal);
    const deadline = new AbortController();
    let arrivals = 0;
    const f = await fixture(
      true,
      profileProvider(async () => {
        if (++arrivals === 2) {
          deadline.abort(new DOMException("Cleanup deadline", "TimeoutError"));
          context.mocks.abortSignal.timeout.mockReturnValueOnce(
            deadline.signal,
          );
          both.resolve();
        }
        await both.promise;
      }),
    );
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      const results = await Promise.all([
        a.control({ kind: "allocate" }),
        b.control({ kind: "allocate" }),
      ]);
      context.mocks.abortSignal.timeout.mockReset();
      expect(
        results
          .map((result) => {
            return result.status;
          })
          .sort(),
      ).toStrictEqual([200, 502]);
      expect(
        results.find((result) => {
          return result.status === 502;
        }),
      ).toMatchObject({
        body: { error: { code: "BROWSER_USE_TIMEOUT" } },
      });
      const winner = accepted(await a.request({ kind: "inspect" }));
      expect(
        (await fetch(`${PROVIDER_URL}/profiles/${winner.providerProfileId}`))
          .status,
      ).toBe(200);
    });
  });

  it("reports a losing candidate's cleanup deadline without deleting the winner", async () => {
    const both = createDeferredPromise<void>(context.signal);
    const deleting = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const deadline = new AbortController();
    let arrivals = 0;
    const f = await fixture(
      true,
      profileProvider(async () => {
        if (++arrivals === 2) {
          context.mocks.abortSignal.timeout.mockReturnValueOnce(
            deadline.signal,
          );
          both.resolve();
        }
        await both.promise;
      }),
    );
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      server.use(
        http.delete(`${PROVIDER_URL}/profiles/:id`, async () => {
          deleting.resolve();
          await release.promise;
          return HttpResponse.error();
        }),
      );
      const allocations = Promise.all([
        a.control({ kind: "allocate" }),
        b.control({ kind: "allocate" }),
      ]);
      await deleting.promise;
      deadline.abort(new DOMException("Cleanup deadline", "TimeoutError"));
      release.resolve();
      const results = await allocations;
      context.mocks.abortSignal.timeout.mockReset();
      expect(
        results
          .map((result) => {
            return result.status;
          })
          .sort(),
      ).toStrictEqual([200, 502]);
      expect(
        results.find((result) => {
          return result.status === 502;
        }),
      ).toMatchObject({
        body: { error: { code: "BROWSER_USE_TIMEOUT" } },
      });
      const winner = accepted(await a.request({ kind: "inspect" }));
      expect(
        (await fetch(`${PROVIDER_URL}/profiles/${winner.providerProfileId}`))
          .status,
      ).toBe(200);
    });
  });

  it("rejects a late candidate after another request's retained profile disappears", async () => {
    const prepared = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let arrivals = 0;
    const f = await fixture(
      true,
      profileProvider(async () => {
        if (++arrivals === 1) {
          prepared.resolve();
          await release.promise;
        }
      }),
    );
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      const late = settle(a.request({ kind: "allocate" }));
      await prepared.promise;
      const winner = await allocate(b);
      accepted(await b.request({ kind: "beginStop", instanceId: winner.id }));
      accepted(
        await b.request({ kind: "completeStop", instanceId: winner.id }),
      );
      expect(
        (
          await fetch(`${PROVIDER_URL}/profiles/${winner.providerProfileId}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(204);
      release.resolve();
      const result = await late;
      if (!result.ok) {
        throw result.error;
      }
      expect(result.value).toStrictEqual({ outcome: "unavailable" });
      expect(accepted(await b.request({ kind: "inspect" }))).toMatchObject({
        id: winner.id,
        providerProfileId: winner.providerProfileId,
        status: "stopped",
      });
      expect(f.provider.createdIds).toHaveLength(2);
      for (const id of f.provider.createdIds) {
        expect((await fetch(`${PROVIDER_URL}/profiles/${id}`)).status).toBe(
          404,
        );
      }
      const recovered = accepted(await b.request({ kind: "allocate" }));
      expect(recovered.ownerProfileId).toBe(winner.ownerProfileId);
      expect(recovered.id).not.toBe(winner.id);
      expect(recovered.providerProfileId).not.toBe(winner.providerProfileId);
      expect(f.provider.createdIds).toHaveLength(3);
    });
  });

  it("replaces a missing stopped profile once and rejects a late recovery after its winner stops", async () => {
    const prepared = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let arrivals = 0;
    const f = await fixture(
      true,
      profileProvider(async () => {
        if (++arrivals === 2) {
          prepared.resolve();
          await release.promise;
        }
      }),
    );
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      const original = await allocate(a);
      accepted(await a.request({ kind: "beginStop", instanceId: original.id }));
      accepted(
        await a.request({ kind: "completeStop", instanceId: original.id }),
      );
      expect(
        (
          await fetch(
            `${PROVIDER_URL}/profiles/${original.providerProfileId}`,
            {
              method: "DELETE",
            },
          )
        ).status,
      ).toBe(204);

      const late = settle(a.request({ kind: "allocate" }));
      await prepared.promise;
      const winner = await allocate(b);
      accepted(await b.request({ kind: "beginStop", instanceId: winner.id }));
      accepted(
        await b.request({ kind: "completeStop", instanceId: winner.id }),
      );
      release.resolve();
      const result = await late;
      if (!result.ok) {
        throw result.error;
      }
      expect(result.value).toStrictEqual({ outcome: "unavailable" });
      expect(winner.ownerProfileId).toBe(original.ownerProfileId);
      expect(winner.providerProfileId).not.toBe(original.providerProfileId);
      expect(accepted(await b.request({ kind: "inspect" }))).toMatchObject({
        id: winner.id,
        providerProfileId: winner.providerProfileId,
        status: "stopped",
      });
      expect(f.provider.createdIds).toHaveLength(3);
      for (const id of f.provider.createdIds) {
        expect((await fetch(`${PROVIDER_URL}/profiles/${id}`)).status).toBe(
          id === winner.providerProfileId ? 200 : 404,
        );
      }
      const reused = await allocate(b);
      expect(reused.providerProfileId).toBe(winner.providerProfileId);
      expect(f.provider.createdIds).toHaveLength(3);
    });
  });

  it("preserves a legacy thread profile when the provider repeats its identity", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      mockEnv("APP_URL", "https://app.okou.ai");
      const providerSessionId = randomUUID();
      let status: "active" | "stopped" = "active";
      const webSocketUrl = `wss://${providerSessionId}.cdp.browser-use.com/devtools/browser/test`;
      function session() {
        return {
          id: providerSessionId,
          status,
          liveUrl:
            status === "active"
              ? "https://live.browser-use.com/?wss=legacy"
              : null,
          cdpUrl:
            status === "active"
              ? `https://${providerSessionId}.cdp.browser-use.com/`
              : null,
          startedAt: new Date(START).toISOString(),
          timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
          finishedAt:
            status === "active" ? null : new Date(START).toISOString(),
        };
      }
      server.use(
        http.post(`${PROVIDER_URL}/browsers`, () => {
          return HttpResponse.json(session(), { status: 201 });
        }),
        http.get(`${PROVIDER_URL}/browsers/:id`, () => {
          return HttpResponse.json(session());
        }),
        http.patch(`${PROVIDER_URL}/browsers/:id`, () => {
          status = "stopped";
          return HttpResponse.json(session());
        }),
        http.get(
          `https://${providerSessionId}.cdp.browser-use.com/json/version`,
          () => {
            return HttpResponse.json({ webSocketDebuggerUrl: webSocketUrl });
          },
        ),
        browserUseCdpHandler(webSocketUrl),
      );
      const legacy = setupApp({ context, routes: browserRoutes })(
        browserContract,
      );
      const headers = {
        authorization: `Bearer ${okouTokenFromClaim(chat.claim)}`,
      };
      const original = await accept(legacy.use({ headers, body: {} }), [200]);
      const id = f.provider.createdIds[0];
      if (!id) {
        throw new Error("Expected the provider's legacy profile");
      }
      server.use(
        http.post(`${PROVIDER_URL}/profiles`, () => {
          return HttpResponse.json(f.provider.profile(id), { status: 201 });
        }),
      );
      await expect(chat.request({ kind: "allocate" })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await expect(chat.request({ kind: "inspect" })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      expect((await fetch(`${PROVIDER_URL}/profiles/${id}`)).status).toBe(200);
      const retained = await accept(legacy.use({ headers, body: {} }), [200]);
      expect(retained.body.cdpUrl).toBe(original.body.cdpUrl);
    });
  });

  it("deletes only an unadopted candidate after the Run ends during provider preparation", async () => {
    const created = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const f = await fixture(
      true,
      profileProvider(async () => {
        created.resolve();
        await release.promise;
      }),
    );
    await f.owned.run(async () => {
      const chat = await f.start();
      const allocating = chat.request({ kind: "allocate" });
      await created.promise;
      const revoked = await settle(
        createWebhookCallbackApi(context).requestAgentComplete(
          {
            runId: chat.runId,
            exitCode: 1,
            error: "Run ended during preparation",
          },
          { authorization: `Bearer ${chat.claim.sandboxToken}` },
          [200],
        ),
      );
      release.resolve();
      const result = await allocating;
      if (!revoked.ok) {
        throw revoked.error;
      }
      expect(result).toStrictEqual({ outcome: "unavailable" });
      expect(f.provider.createdIds).toHaveLength(1);
      for (const id of f.provider.createdIds) {
        expect((await fetch(`${PROVIDER_URL}/profiles/${id}`)).status).toBe(
          404,
        );
      }
    });
  });

  it("keeps another owner's accepted profile when the provider repeats its identity", async () => {
    const provider = profileProvider();
    const first = await fixture(true, provider);
    const other = await fixture(true, provider);
    await first.owned.run(async () => {
      const a = await first.start();
      const acceptedProfile = await allocate(a);
      await other.owned.run(async () => {
        const b = await other.start();
        server.use(
          http.post(`${PROVIDER_URL}/profiles`, () => {
            return HttpResponse.json(
              provider.profile(acceptedProfile.providerProfileId),
              {
                status: 201,
              },
            );
          }),
        );
        await accept(b.control({ kind: "allocate" }), [500]);
        await expect(b.request({ kind: "inspect" })).resolves.toStrictEqual({
          outcome: "unavailable",
        });
        expect(
          (
            await fetch(
              `${PROVIDER_URL}/profiles/${acceptedProfile.providerProfileId}`,
            )
          ).status,
        ).toBe(200);
      });
      expect(
        accepted(await a.request({ kind: "inspect" })).providerProfileId,
      ).toBe(acceptedProfile.providerProfileId);
    });
  });

  it("keeps the profile on lookup failures and recovers only after confirmed deletion", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const chat = await f.start();
      const privateDetail = "provider-private-detail-do-not-echo";
      server.use(
        http.post(`${PROVIDER_URL}/profiles`, () => {
          return HttpResponse.json({ detail: privateDetail }, { status: 500 });
        }),
      );
      const failed = await accept(chat.control({ kind: "allocate" }), [502]);
      expect(failed.body.error.message).toBe(
        "Managed browser provider profile is unavailable",
      );
      expect(JSON.stringify(failed.body)).not.toContain(privateDetail);
      await expect(chat.request({ kind: "inspect" })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      server.use(
        http.post(`${PROVIDER_URL}/profiles`, () => {
          return HttpResponse.json({ id: "invalid-profile" }, { status: 201 });
        }),
      );
      const invalid = await accept(chat.control({ kind: "allocate" }), [502]);
      expect(invalid.body.error.code).toBe("BROWSER_USE_INVALID_RESPONSE");

      server.use(...f.provider.handlers);
      const instance = await allocate(chat);
      accepted(
        await chat.request({ kind: "beginStop", instanceId: instance.id }),
      );
      accepted(
        await chat.request({ kind: "completeStop", instanceId: instance.id }),
      );

      for (const [providerStatus, expected] of [
        [500, 502],
        [403, 503],
      ] as const) {
        server.use(
          http.get(`${PROVIDER_URL}/profiles/:id`, () => {
            return HttpResponse.json(
              { detail: privateDetail },
              { status: providerStatus },
            );
          }),
        );
        const lookup = await accept(chat.control({ kind: "allocate" }), [
          expected,
        ]);
        expect(JSON.stringify(lookup.body)).not.toContain(privateDetail);
        expect(accepted(await chat.request({ kind: "inspect" }))).toMatchObject(
          {
            id: instance.id,
            providerProfileId: instance.providerProfileId,
            status: "stopped",
          },
        );
        expect(f.provider.createdIds).toHaveLength(1);
      }
      server.use(
        http.get(`${PROVIDER_URL}/profiles/:id`, () => {
          return HttpResponse.json(f.provider.profile(randomUUID()));
        }),
      );
      const mismatched = await accept(
        chat.control({ kind: "allocate" }),
        [502],
      );
      expect(mismatched.body.error.code).toBe("BROWSER_USE_INVALID_RESPONSE");

      server.use(...f.provider.handlers);
      expect(
        (
          await fetch(
            `${PROVIDER_URL}/profiles/${instance.providerProfileId}`,
            {
              method: "DELETE",
            },
          )
        ).status,
      ).toBe(204);
      const recovered = accepted(await chat.request({ kind: "allocate" }));
      expect(recovered.ownerProfileId).toBe(instance.ownerProfileId);
      expect(recovered.id).not.toBe(instance.id);
      expect(recovered.providerProfileId).not.toBe(instance.providerProfileId);
      expect(accepted(await chat.request({ kind: "inspect" }))).toMatchObject({
        providerProfileId: recovered.providerProfileId,
        status: "creating",
      });
      expect(f.provider.createdIds).toHaveLength(2);
    });
  });
});
