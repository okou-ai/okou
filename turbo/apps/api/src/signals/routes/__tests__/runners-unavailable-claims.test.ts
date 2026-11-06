import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const api = createRunsApi(context);
const { connectors } = createChatEventsFixture(context);

describe.each([false, true])(
  "unavailable Runner claims (Chat accounts: %s)",
  (chatAccounts) => {
    it("keeps one authorized winner and usable permissions when claims compete", async () => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      await owned.run(async () => {
        await connectors.connectManualGrant(
          owned.actor,
          "figma",
          "api-token",
          { accessToken: "competing-claim-figma-token" },
          owned.agentId,
        );
        await connectors.updateFeatureSwitches(owned.actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        const run = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          prompt: "claim this Run once with current connector permissions",
          model: "claude-fable-5-1",
        });
        const runnerIds = [randomUUID(), randomUUID(), randomUUID()];
        const settled = await Promise.allSettled(
          runnerIds.map(async (runnerId, index) => {
            const response = await api.requestClaimRunnerJob(
              true,
              run.runId,
              [200, 404],
              {
                runnerIdentity: { runnerId, heartbeatGeneration: index + 1 },
                runnerHostname: `competing-claim-${index}`,
              },
            );
            if (response.status === 200) {
              owned.rememberClaim(run.runId, response.body.sandboxToken);
            }
            return response;
          }),
        );
        const responses = settled.map((result) => {
          if (result.status === "rejected") {
            throw result.reason;
          }
          return result.value;
        });
        expect(
          responses
            .map((response) => {
              return response.status;
            })
            .sort(),
        ).toStrictEqual([200, 404, 404]);
        const winningIndex = responses.findIndex((response) => {
          return response.status === 200;
        });
        const winner = responses[winningIndex];
        if (winner?.status !== 200) {
          throw new Error("Expected one successful claim");
        }
        for (const response of responses) {
          if (response.status === 404) {
            expect(response.body.error.code).toBe("NOT_FOUND");
            expect(["Job not found in queue", "Run not found"]).toContain(
              response.body.error.message,
            );
          }
        }
        expect(winner.body.networkPolicies?.figma).toStrictEqual({
          allow: ["file_content:read"],
          ask: [],
          deny: [],
          unknownPolicy: "allow",
        });
        const attribution = await api.requestRunRunner(
          owned.actor,
          run.runId,
          [200],
        );
        expect(attribution.body).toMatchObject({
          runnerId: runnerIds[winningIndex],
          runnerHeartbeatGeneration: winningIndex + 1,
          runnerHostname: `competing-claim-${winningIndex}`,
        });
        const retry = await api.requestClaimRunnerJob(true, run.runId, [404]);
        if (retry.status !== 404) {
          throw new Error("Expected the consumed Run to remain unavailable");
        }
        expect(retry.body.error.message).toBe("Job not found in queue");
        await completePublicClaudeRun(
          context,
          run,
          { authorization: `Bearer ${winner.body.sandboxToken}` },
          "the single winning Runner completed",
        );
        await expect(
          api.readRun(owned.actor, run.runId),
        ).resolves.toMatchObject({
          status: "completed",
        });
      });
    });

    it("settles competing cancellation and claim before allowing a later Run", async () => {
      const owned = await publicChatActor(context);
      owned.ownsFeatureSwitches();
      await owned.run(async () => {
        await connectors.connectManualGrant(
          owned.actor,
          "figma",
          "api-token",
          { accessToken: "cancelled-claim-figma-token" },
          owned.agentId,
        );
        await connectors.updateFeatureSwitches(owned.actor, {
          connectorChatAccountAccess: chatAccounts,
        });
        const cancelled = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          prompt: "cancel this candidate while a Runner claims it",
          model: "claude-fable-5-1",
        });
        const claimPromise = (async () => {
          const response = await api.requestClaimRunnerJob(
            true,
            cancelled.runId,
            [200, 404],
          );
          if (response.status === 200) {
            owned.rememberClaim(cancelled.runId, response.body.sandboxToken);
          }
          return response;
        })();
        const [claimResult, cancelResult] = await Promise.allSettled([
          claimPromise,
          api.requestCancelRun(owned.actor, cancelled.runId, [200]),
        ]);
        if (claimResult.status === "rejected") {
          throw claimResult.reason;
        }
        if (cancelResult.status === "rejected") {
          throw cancelResult.reason;
        }
        const racedClaim = claimResult.value;
        if (racedClaim.status === 200) {
          await completePublicClaudeRun(
            context,
            cancelled,
            { authorization: `Bearer ${racedClaim.body.sandboxToken}` },
            "finish the accepted claim after cancellation",
          );
        }
        await flushWaitUntilForTest();
        const unavailable = await api.requestClaimRunnerJob(
          true,
          cancelled.runId,
          [404],
        );
        if (unavailable.status !== 404) {
          throw new Error("Expected the cancelled Run to remain unavailable");
        }
        expect(unavailable.body.error).toMatchObject({
          code: "NOT_FOUND",
          message: "Job not found in queue",
        });
        await expect(
          api.readRun(owned.actor, cancelled.runId),
        ).resolves.toMatchObject({ status: "cancelled" });
        const next = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          threadId: cancelled.threadId,
          prompt: "a later Run is still claimable",
        });
        const claim = await owned.claimRunnerRun(next.runId);
        expect(claim.runId).toBe(next.runId);
        expect(claim.networkPolicies?.figma).toStrictEqual({
          allow: ["file_content:read"],
          ask: [],
          deny: [],
          unknownPolicy: "allow",
        });
        await expect(
          api.readRun(owned.actor, next.runId),
        ).resolves.toMatchObject({
          status: "running",
        });
      });
    });
  },
);
