/** Explicit native entry; selected only by scripts/native-competing-claims.mjs. */
import { OFFICIAL_RUNNER_TOKEN_PREFIX } from "@okouai/api-contracts/contracts/runner-primitives";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { z } from "zod";

import { testContext } from "../../../__tests__/test-context";
import { env, optionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { publicChatActor } from "./helpers/public-chat-actor";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import {
  startNativeClaimApi,
  type NativeClaimCase,
} from "./helpers/native-claim-api";

const context = testContext();
const api = createRunsApi(context);
const selectedInputs = z.object({
  root: z.string(),
  driver: z.string(),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  databaseUrl: z.url(),
  producerFile: z.string(),
});
const claimSchema = z.object({ runId: z.uuid(), sandboxToken: z.string() });

test("composes actual PostgreSQL claim arbitration with both native Guest owners", async () => {
  const raw: unknown = JSON.parse(
    await readFile(optionalEnv("OKOU_TEST_REAL_API_INPUTS") ?? "", "utf8"),
  );
  const inputs = selectedInputs.parse(raw);
  const producerBytes = await readFile(inputs.producerFile);
  const producerSha256 = createHash("sha256")
    .update(producerBytes)
    .digest("hex");
  const expectedDatabase = new URL(inputs.databaseUrl);
  const actualDatabase = new URL(env("DATABASE_URL"));
  if (
    expectedDatabase.hostname !== "127.0.0.1" ||
    actualDatabase.hostname !== expectedDatabase.hostname ||
    actualDatabase.port !== expectedDatabase.port ||
    actualDatabase.pathname !== expectedDatabase.pathname ||
    actualDatabase.username !== expectedDatabase.username
  ) {
    throw new Error(
      "Native API must use its invocation-owned loopback database",
    );
  }
  const owned = await publicChatActor(context);
  await owned.run(async () => {
    for (const first of ["a", "b", "both"] as const) {
      const directory = join(inputs.root, first);
      await mkdir(directory, { mode: 0o700 });
      const cases: NativeClaimCase[] = [];
      const prepared: {
        mode: "fresh" | "snapshot";
        run: { runId: string; threadId: string };
        seed: { runId: string };
        reuseKey: string;
        runnerIds: readonly [string, string];
        controlDirectory: string;
        predecessorContext: Awaited<ReturnType<typeof api.claimRunnerJob>>;
        completedAt: string;
      }[] = [];
      for (const mode of ["fresh", "snapshot"] as const) {
        const controlDirectory = join(directory, mode);
        await mkdir(controlDirectory, { mode: 0o700 });
        const seed = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          prompt: "synthetic predecessor for native arbitration",
          model: "claude-fable-5-1",
        });
        const seedClaim = await owned.claimRunnerRun(seed.runId);
        await completePublicClaudeRun(
          context,
          seed,
          { authorization: `Bearer ${seedClaim.sandboxToken}` },
          "synthetic predecessor complete",
        );
        const predecessor = await api.readRun(owned.actor, seed.runId);
        if (!predecessor.completedAt) {
          throw new Error("Public predecessor did not complete");
        }
        const run = await api.createThreadRun(owned.actor, {
          agentId: owned.agentId,
          threadId: seed.threadId,
          prompt: "complete exactly one synthetic native claim task",
          model: "claude-fable-5-1",
        });
        await api.heartbeatRunner(owned.runnerGroup);
        const poll = await api.requestPollRunner(
          true,
          {
            group: owned.runnerGroup,
            supportedProfiles: ["vm0/default"],
            excludedRunIds: prepared.map((entry) => {
              return entry.run.runId;
            }),
          },
          [200],
        );
        if (!("job" in poll.body)) {
          throw new Error("Public native poll did not return its job contract");
        }
        const job = poll.body.job;
        if (
          !job ||
          job.runId !== run.runId ||
          !job.reuseKey ||
          job.historyGenerationRunId !== seed.runId
        ) {
          throw new Error(
            "Public native candidate did not retain its predecessor",
          );
        }
        const runnerIds = [randomUUID(), randomUUID()] as const;
        cases.push({ runId: run.runId, controlDirectory, runnerIds, first });
        prepared.push({
          mode,
          run,
          seed,
          reuseKey: job.reuseKey,
          runnerIds,
          controlDirectory,
          predecessorContext: seedClaim,
          completedAt: predecessor.completedAt,
        });
      }
      const claimedPolls = new Map<
        string,
        { readonly status: number; readonly body: unknown }
      >();
      const fixture = await startNativeClaimApi(
        context,
        cases,
        async (runId) => {
          const running = await api.readRun(owned.actor, runId);
          expect(running.status).toBe("running");
          expect(running.startedAt).toBeDefined();
          const poll = await api.requestPollRunner(
            true,
            {
              group: owned.runnerGroup,
              supportedProfiles: ["vm0/default"],
              excludedRunIds: prepared
                .filter((entry) => {
                  return entry.run.runId !== runId;
                })
                .map((entry) => {
                  return entry.run.runId;
                }),
            },
            [200],
          );
          expect(poll.body).toMatchObject({ job: null });
          claimedPolls.set(runId, poll);
          return running;
        },
      );
      const manifest = join(directory, "api-inputs.json");
      const publicObservations: unknown[] = [];
      await writeFile(
        manifest,
        JSON.stringify({
          source_sha: inputs.sourceSha,
          api_url: fixture.url,
          token: `${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
          group: owned.runnerGroup,
          order: first,
          cases: Object.fromEntries(
            prepared.map((entry) => {
              return [
                entry.mode,
                {
                  original_run_id: entry.seed.runId,
                  claim_run_id: entry.run.runId,
                  reuse_key: entry.reuseKey,
                  runner_ids: entry.runnerIds,
                  control_directory: entry.controlDirectory,
                  predecessor_context: entry.predecessorContext,
                  original_completed_at: entry.completedAt,
                },
              ];
            }),
          ),
        }),
        { flag: "wx", mode: 0o600 },
      );
      const outcome = await settleIncludingAbort(async () => {
        await promisify(execFile)("python3", [inputs.driver, manifest], {
          maxBuffer: 1024 * 1024,
        });
        await flushWaitUntilForTest();
        for (const entry of prepared) {
          const receipts = fixture.receipts().filter((receipt) => {
            return receipt.runId === entry.run.runId;
          });
          expect(receipts).toHaveLength(2);
          expect(
            receipts
              .map((receipt) => {
                return receipt.status;
              })
              .sort(),
          ).toStrictEqual([200, 404]);
          const winning = receipts.find((receipt) => {
            return receipt.status === 200;
          });
          if (!winning) {
            throw new Error(
              "Native execution has no successful real API claim",
            );
          }
          const claim = claimSchema.parse(winning.response);
          owned.rememberClaim(entry.run.runId, claim.sandboxToken);
          const attribution = await api.requestRunRunner(
            owned.actor,
            entry.run.runId,
            [200],
          );
          expect(attribution.body).toMatchObject({
            runnerId: winning.runnerId,
          });
          const completed = await api.readRun(owned.actor, entry.run.runId);
          expect(completed.status).toBe("completed");
          const unavailable = await api.requestClaimRunnerJob(
            true,
            entry.run.runId,
            [404],
          );
          const laterPoll = await api.requestPollRunner(
            true,
            {
              group: owned.runnerGroup,
              supportedProfiles: ["vm0/default"],
            },
            [200],
          );
          expect(laterPoll.body).toMatchObject({ job: null });
          const claimedPoll = claimedPolls.get(entry.run.runId);
          if (!claimedPoll) {
            throw new Error("Native winner has no public running poll");
          }
          publicObservations.push({
            runId: entry.run.runId,
            runner: attribution.body,
            run: completed,
            laterClaimStatus: unavailable.status,
            laterClaimBody: unavailable.body,
            laterPollStatus: laterPoll.status,
            laterPollBody: laterPoll.body,
            claimedPollStatus: claimedPoll.status,
            claimedPollBody: claimedPoll.body,
          });
        }
      });
      const joined = await settleIncludingAbort(() => {
        return fixture.finish();
      });
      for (const receipt of fixture.receipts()) {
        if (receipt.status === 200) {
          const claim = claimSchema.parse(receipt.response);
          owned.rememberClaim(receipt.runId, claim.sandboxToken);
        }
      }
      await writeFile(
        join(directory, "api-receipts.json"),
        JSON.stringify({
          source_sha: inputs.sourceSha,
          claims: fixture.receipts(),
          publicObservations,
          apiJoined: joined.ok,
          producerSha256,
        }),
        { flag: "wx", mode: 0o600 },
      );
      if (!joined.ok) {
        throw joined.error;
      }
      if (!outcome.ok) {
        throw outcome.error;
      }
    }
  });
});
