import { createHash, randomUUID } from "node:crypto";
import { RESUME_SESSION_HISTORY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createPublicFirewallFixture } from "./helpers/public-firewall-fixture";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);

function prepareHistory<TStatus extends 200 | 400 | 401 | 404 | 500>(
  body: Parameters<typeof webhooks.requestAgentSessionHistoryPrepare>[0],
  headers: { readonly authorization?: string },
  statuses: readonly TStatus[],
) {
  return accept(
    webhooks.requestAgentSessionHistoryPrepare(body, headers, statuses),
    statuses,
  );
}

async function withClaimedRun(
  scenario: (run: Awaited<ReturnType<typeof startRun>>) => Promise<void>,
) {
  const fixture = createPublicFirewallFixture(context);
  await fixture.run(async () => {
    await scenario(await startRun(fixture));
  });
}

async function startRun(
  fixture: ReturnType<typeof createPublicFirewallFixture>,
) {
  const actor = fixture.actor;
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await fixture.fund();
  await runs.ensurePersonalSubscriptionModel(actor, {
    model: "claude-fable-5-1",
  });
  const agent = await bdd.createAgent(actor, {
    displayName: "Session history upload Agent",
    visibility: "private",
  });
  fixture.registerAgent(agent.agentId);
  const run = await runs.createThreadRun(actor, {
    agentId: agent.agentId,
    prompt: "Prepare native session history",
  });
  fixture.registerRun(run.runId);
  const claim = await runs.claimRunnerJob(run.runId);
  fixture.registerClaim(run.runId, claim.sandboxToken);
  const headers = { authorization: `Bearer ${claim.sandboxToken}` };
  const bytes = Buffer.from(`native session history ${randomUUID()}\n`);
  const body = {
    runId: run.runId,
    hash: createHash("sha256").update(bytes).digest("hex"),
    rawSize: bytes.length,
    encodedSize: bytes.length,
  };
  return { fixture, actor, agent, run, headers, bytes, body };
}

describe("Sandbox session history upload preparation", () => {
  it("validates input and rejects an actually issued token for another Run", async () => {
    await withClaimedRun(
      async ({ fixture, actor, agent, run, headers, body }) => {
        expect((await prepareHistory(body, {}, [401])).body.error.code).toBe(
          "UNAUTHORIZED",
        );
        for (const invalid of [
          { ...body, rawSize: 0, encodedSize: 0 },
          { ...body, rawSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1 },
          { ...body, hash: body.hash.toUpperCase() },
          { ...body, encoding: "brotli" },
          { ...body, encodedSize: body.rawSize + 1 },
        ]) {
          expect(
            (
              await webhooks.requestAgentSessionHistoryPrepareUnchecked(
                invalid,
                headers,
                [400],
              )
            ).body.error.code,
          ).toBe("BAD_REQUEST");
        }
        await webhooks.requestAgentComplete(
          { runId: run.runId, exitCode: 1 },
          headers,
          [200],
        );
        const peer = await runs.createThreadRun(actor, {
          agentId: agent.agentId,
          prompt: "Obtain another genuine sandbox token",
        });
        fixture.registerRun(peer.runId);
        const claim = await runs.claimRunnerJob(peer.runId);
        fixture.registerClaim(peer.runId, claim.sandboxToken);
        const mismatch = await prepareHistory(
          body,
          { authorization: `Bearer ${claim.sandboxToken}` },
          [401],
        );
        expect(mismatch.body.error.message).toBe(
          "Not authenticated or runId mismatch",
        );
        expect(
          (await prepareHistory(body, headers, [400])).body.error.message,
        ).toBe("Native-only Runs do not publish history archives");
      },
    );
  });

  it("does not prepare an archive after cancellation and hides a deleted Run", async () => {
    await withClaimedRun(
      async ({ fixture, actor, agent, run, body, headers }) => {
        expect(
          (await prepareHistory(body, headers, [400])).body.error.message,
        ).toBe("Native-only Runs do not publish history archives");
        await runs.requestCancelRun(actor, run.runId, [200]);
        expect(
          (await prepareHistory(body, headers, [400])).body.error.message,
        ).toBe("Native-only Runs do not publish history archives");
        await webhooks.requestAgentComplete(
          { runId: run.runId, exitCode: 1 },
          headers,
          [200],
        );
        await flushWaitUntilForTest();
        fixture.registerRunDeletion(run.runId);
        await bdd.deleteAgent(actor, agent.agentId);
        expect(
          (await prepareHistory(body, headers, [404])).body.error.message,
        ).toBe("Agent run not found");
      },
    );
  });
});
