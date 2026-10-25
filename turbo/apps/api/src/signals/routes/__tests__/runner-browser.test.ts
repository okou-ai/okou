import { randomUUID } from "node:crypto";
import {
  runnerBrowserContract,
  type RunnerBrowserAction,
  type RunnerBrowserResponse,
} from "@okouai/api-contracts/contracts/runner-browser";
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import {
  mockNow,
  withMockNowForTest,
  withNowScopeForTest,
} from "../../../lib/time";
import { runnerBrowserRoutes } from "../runner-browser";
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

async function fixture(enabled = true) {
  const owned = await publicChatActor(context, { clockTime: START });
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
      async function request(action: RunnerBrowserAction) {
        const result = await accept(
          client().control({
            headers: officialHeaders(),
            params: { runId: sent.runId },
            body: { runnerIdentity, action },
          }),
          [200],
        );
        return result.body;
      }
      return { ...sent, runnerIdentity, claim, request };
    });
  }
  return { owned, start, featureActor };
}

type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;

async function allocate(chat: Chat) {
  const instance = accepted(
    await chat.request({ kind: "allocate", providerProfileId: randomUUID() }),
  );
  return accepted(
    await chat.request({
      kind: "publish",
      instanceId: instance.id,
      providerSessionId: randomUUID(),
      timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
    }),
  );
}

async function admit(chat: Chat, instanceId: string) {
  const instance = accepted(await chat.request({ kind: "admit", instanceId }));
  const entry = Object.entries(instance.windows).find(([, window]) => {
    return window.state === "creating";
  });
  if (!entry) {
    throw new Error("Expected a new server-generated window lifetime");
  }
  return { instanceId, windowSessionId: entry[0] };
}

async function activate(
  chat: Chat,
  window: { instanceId: string; windowSessionId: string },
  nativeWindowId: number,
) {
  return accepted(
    await chat.request({ kind: "activate", ...window, nativeWindowId }),
  );
}

describe("official Runner Browser lifecycle", () => {
  it("does not expose or mutate another owner's Browser generation", async () => {
    const first = await fixture();
    const other = await fixture();
    await first.owned.run(async () => {
      const a = await first.start();
      const instance = await allocate(a);
      await other.owned.run(async () => {
        const b = await other.start();
        await expect(
          b.request({ kind: "inspect", instanceId: instance.id }),
        ).resolves.toStrictEqual({ outcome: "unavailable" });
        await expect(
          b.request({ kind: "admit", instanceId: instance.id }),
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
          providerProfileId: randomUUID(),
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
          providerProfileId: randomUUID(),
        }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });

      const instance = await allocate(chat);
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
      await chatApi.updateThreadComputerUseHost(
        f.owned.actor,
        chat.threadId,
        null,
        { cloudBrowserEnabled: true },
      );
      expect(accepted(await chat.request({ kind: "inspect" })).id).toBe(
        instance.id,
      );
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
      const terminal = await f.start();
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
    });
  });

  it("publishes one physical generation with independent chat rows and exclusive primary windows", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      const allocations = await Promise.all(
        [a, b].map((chat) => {
          return chat.request({
            kind: "allocate",
            providerProfileId: randomUUID(),
          });
        }),
      );
      expect(
        allocations
          .map((result) => {
            return result.outcome;
          })
          .sort(),
      ).toStrictEqual(["accepted", "unavailable"]);
      const initial = accepted(await a.request({ kind: "inspect" }));
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
      const [wa, wb] = await Promise.all([
        admit(a, initial.id),
        admit(b, initial.id),
      ]);
      await expect(
        a.request({ kind: "admit", instanceId: initial.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      const activations = await Promise.all([
        a.request({ kind: "activate", ...wa, nativeWindowId: 0 }),
        b.request({ kind: "activate", ...wb, nativeWindowId: 0 }),
      ]);
      expect(
        activations
          .map((result) => {
            return result.outcome;
          })
          .sort(),
      ).toStrictEqual(["accepted", "unavailable"]);
      if (activations[0]?.outcome === "unavailable") {
        await activate(a, wa, 102);
      } else {
        await activate(b, wb, 102);
      }
      const viewA = accepted(await a.request({ kind: "inspect" }));
      const viewB = accepted(await b.request({ kind: "inspect" }));
      expect(Object.keys(viewA.windows)).toStrictEqual([wa.windowSessionId]);
      expect(Object.keys(viewB.windows)).toStrictEqual([wb.windowSessionId]);
      expect(
        new Set([
          viewA.windows[wa.windowSessionId]?.primaryWindowId,
          viewB.windows[wb.windowSessionId]?.primaryWindowId,
        ]),
      ).toStrictEqual(new Set([0, 102]));
      await expect(b.request({ kind: "renew", ...wa })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
      await expect(
        a.request({ kind: "beginStop", instanceId: initial.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
    });
  });

  it("acknowledges old window closure before readmission and rejects delayed cleanup of its replacement", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      const instance = await allocate(a);
      const wa = await admit(a, instance.id),
        wb = await admit(b, instance.id);
      await activate(a, wa, 0);
      await activate(b, wb, 102);
      mockNow(START + 9 * MINUTE);
      accepted(await b.request({ kind: "renew", ...wb }));
      mockNow(START + 10 * MINUTE);
      accepted(await a.request({ kind: "retire", ...wa, reason: "expired" }));
      await expect(
        a.request({ kind: "admit", instanceId: instance.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      accepted(await a.request({ kind: "completeWindowClose", ...wa }));
      const replacement = await admit(a, instance.id);
      expect(replacement.windowSessionId).not.toBe(wa.windowSessionId);
      await activate(a, replacement, 0);
      await expect(
        a.request({ kind: "completeWindowClose", ...wa }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      const current = accepted(await a.request({ kind: "inspect" }));
      expect(Object.keys(current.windows)).toStrictEqual([
        replacement.windowSessionId,
      ]);
      expect(
        current.windows[replacement.windowSessionId]?.primaryWindowId,
      ).toBe(0);
      await expect(a.request({ kind: "renew", ...wa })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
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
      await expect(
        a.request({ kind: "allocate", providerProfileId: randomUUID() }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      accepted(
        await a.request({ kind: "retire", ...replacement, reason: "closed" }),
      );
      accepted(await b.request({ kind: "retire", ...wb, reason: "closed" }));
      const stopping = accepted(
        await a.request({ kind: "beginStop", instanceId: instance.id }),
      );
      expect(stopping.status).toBe("stopping");
      expect(stopping.windows[replacement.windowSessionId]?.state).toBe(
        "closing",
      );
      expect(
        accepted(await a.request({ kind: "inspect", instanceId: instance.id }))
          .windows,
      ).toStrictEqual(stopping.windows);
      accepted(
        await a.request({ kind: "completeStop", instanceId: instance.id }),
      );
      expect(
        accepted(await a.request({ kind: "inspect", instanceId: instance.id }))
          .windows,
      ).toStrictEqual({});
      await expect(a.request({ kind: "inspect" })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
    });
  });

  it("arbitrates renewal versus expiry and final stop versus new admission on native PostgreSQL", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start(),
        b = await f.start();
      const instance = await allocate(a),
        wa = await admit(a, instance.id);
      await activate(a, wa, 101);
      mockNow(START + 9 * MINUTE);
      const beforeExpiry = await Promise.all([
        a.request({ kind: "renew", ...wa }),
        a.request({ kind: "retire", ...wa, reason: "expired" }),
      ]);
      expect(
        beforeExpiry.map((result) => {
          return result.outcome;
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
          .map((result) => {
            return result.outcome;
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
      const competing = await Promise.all([
        a.request({ kind: "beginStop", instanceId: instance.id }),
        b.request({ kind: "admit", instanceId: instance.id }),
      ]);
      expect(
        competing
          .map((result) => {
            return result.outcome;
          })
          .sort(),
      ).toStrictEqual(["accepted", "unavailable"]);
      if (competing[1]?.outcome === "accepted") {
        const entry = Object.keys(competing[1].instance.windows)[0];
        if (!entry) {
          throw new Error("Missing admitted window lifetime");
        }
        const pending = { instanceId: instance.id, windowSessionId: entry };
        await expect(
          a.request({ kind: "beginStop", instanceId: instance.id }),
        ).resolves.toStrictEqual({ outcome: "unavailable" });
        mockNow(START + 29 * MINUTE);
        accepted(
          await b.request({ kind: "retire", ...pending, reason: "expired" }),
        );
        accepted(
          await a.request({ kind: "beginStop", instanceId: instance.id }),
        );
      }
      expect(
        accepted(await a.request({ kind: "inspect", instanceId: instance.id }))
          .windows[wa.windowSessionId]?.state,
      ).toBe("closing");
      accepted(
        await a.request({ kind: "completeStop", instanceId: instance.id }),
      );
      const replacement = accepted(
        await b.request({ kind: "allocate", providerProfileId: randomUUID() }),
      );
      expect(replacement.id).not.toBe(instance.id);
      expect(replacement.ownerProfileId).toBe(instance.ownerProfileId);
      expect(replacement.providerProfileId).toBe(instance.providerProfileId);
      await expect(
        a.request({ kind: "completeStop", instanceId: instance.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      await expect(
        a.request({ kind: "completeWindowClose", ...wa }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      expect(accepted(await b.request({ kind: "inspect" })).id).toBe(
        replacement.id,
      );
      await expect(
        b.request({ kind: "beginStop", instanceId: replacement.id }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      mockNow(START + 30 * MINUTE);
      await expect(
        b.request({
          kind: "publish",
          instanceId: replacement.id,
          providerSessionId: randomUUID(),
          timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
        }),
      ).resolves.toStrictEqual({ outcome: "unavailable" });
      accepted(
        await b.request({ kind: "beginStop", instanceId: replacement.id }),
      );
      accepted(
        await b.request({ kind: "completeStop", instanceId: replacement.id }),
      );
    });
  });
});
