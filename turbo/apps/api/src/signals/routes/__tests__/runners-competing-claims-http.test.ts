import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import { publicChatActor } from "./helpers/public-chat-actor";
import { startNativeClaimApi } from "./helpers/native-claim-api";
import { settleIncludingAbort } from "../../utils";

const context = testContext();
const api = createRunsApi(context);
const successfulClaim = z.object({ runId: z.uuid(), sandboxToken: z.string() });

test.each([
  { first: "a", readyAtStart: false },
  { first: "b", readyAtStart: false },
  { first: "both", readyAtStart: false },
  { first: "both", readyAtStart: true },
] as const)(
  "forwards $first-first Runner claims with initial readiness $readyAtStart",
  async ({ first, readyAtStart }) => {
    const owned = await publicChatActor(context);
    const root = await mkdtemp(join(tmpdir(), "okou-native-claim-http-"));
    await owned.run(async () => {
      const run = await api.createThreadRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "synthetic native claim arbitration",
        model: "claude-fable-5-1",
      });
      const runnerIds = [randomUUID(), randomUUID()] as const;
      if (readyAtStart) {
        await writeFile(join(root, "a.ready"), "", { flag: "wx" });
        await writeFile(join(root, "b.ready"), "", { flag: "wx" });
      }
      const fixture = await startNativeClaimApi(
        context,
        [{ runId: run.runId, runnerIds, controlDirectory: root, first }],
        (runId) => {
          return api.readRun(owned.actor, runId);
        },
      );
      const headers = {
        authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        "content-type": "application/json",
        "X-Client-Version": "1.0.0",
      };
      const pending = runnerIds.map((runnerId, index) => {
        return fetch(`${fixture.url}/api/runners/jobs/${run.runId}/claim`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            runnerIdentity: { runnerId, heartbeatGeneration: index + 1 },
            runnerHostname: `native-claim-${index}`,
            capabilities: { piModelConfigGenerations: [2, 3, 5] },
            nativeContinuationSupported: true,
          }),
        });
      });
      const outcome = await settleIncludingAbort(async () => {
        await fixture.waitForClaims(run.runId);
        if (!readyAtStart) {
          await expect(
            api.readRun(owned.actor, run.runId),
          ).resolves.toMatchObject({
            status: "pending",
          });
          await writeFile(join(root, "a.ready"), "", { flag: "wx" });
          await writeFile(join(root, "b.ready"), "", { flag: "wx" });
        }
        const responses = await Promise.all(pending);
        expect(
          responses
            .map((response) => {
              return response.status;
            })
            .sort(),
        ).toStrictEqual([200, 404]);
        const winningIndex = responses.findIndex((response) => {
          return response.status === 200;
        });
        const winner = responses[winningIndex];
        if (!winner) {
          throw new Error("Expected the winning claim response");
        }
        const claim = successfulClaim.parse(await winner.json());
        owned.rememberClaim(run.runId, claim.sandboxToken);
        expect(claim.runId).toBe(run.runId);
        if (first !== "both") {
          expect(winningIndex).toBe(first === "a" ? 0 : 1);
        }
        const runner = await api.requestRunRunner(
          owned.actor,
          run.runId,
          [200],
        );
        expect(runner.body).toMatchObject({
          runnerId: runnerIds[winningIndex],
          runnerHeartbeatGeneration: winningIndex + 1,
          runnerHostname: `native-claim-${winningIndex}`,
          runnerVersion: "1.0.0",
        });
        const retry = await fetch(
          `${fixture.url}/api/runners/jobs/${run.runId}/claim`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        expect(retry.status).toBe(401);
        await completePublicClaudeRun(
          context,
          run,
          { authorization: `Bearer ${claim.sandboxToken}` },
          "synthetic native claim completed",
        );
        await expect(
          api.readRun(owned.actor, run.runId),
        ).resolves.toMatchObject({
          status: "completed",
        });
        expect(fixture.receipts()).toHaveLength(2);
        for (const receipt of fixture.receipts()) {
          expect(receipt.authorization).toBe(headers.authorization);
          expect(receipt.path).toBe(`/api/runners/jobs/${run.runId}/claim`);
          expect(receipt.status).toBeDefined();
          if (receipt.status === 200) {
            expect(receipt.running).toMatchObject({ status: "running" });
          }
        }
      });
      const joined = await settleIncludingAbort(fixture.finish());
      await Promise.allSettled(pending);
      for (const receipt of fixture.receipts()) {
        if (receipt.status === 200) {
          const claim = successfulClaim.parse(receipt.response);
          owned.rememberClaim(receipt.runId, claim.sandboxToken);
        }
      }
      await rm(root, { recursive: true });
      if (!outcome.ok) {
        throw outcome.error;
      }
      if (!joined.ok) {
        throw joined.error;
      }
    });
  },
);
