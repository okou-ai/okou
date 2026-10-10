import { createHash, randomUUID } from "node:crypto";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { RESUME_SESSION_HISTORY_MAX_BYTES } from "@okouai/api-contracts/contracts/runners";
import { webhookSessionHistoryPrepareContract } from "@okouai/api-contracts/contracts/webhooks";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { webhooksAgentSessionHistoryRoutes } from "../webhooks-agent-session-history";
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

function historyStorage(hash: string) {
  const original = context.mocks.s3.send.getMockImplementation();
  if (!original) {
    throw new Error("Expected the external S3 adapter");
  }
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (
      (command instanceof HeadObjectCommand ||
        command instanceof GetObjectCommand) &&
      command.input.Key?.startsWith(`blobs/${hash}.blob`)
    ) {
      const bytes = objects.get(command.input.Key);
      if (!bytes) {
        return Promise.reject(
          Object.assign(new Error("NotFound"), {
            name: "NotFound",
            Code: "NoSuchKey",
            $metadata: { httpStatusCode: 404 },
          }),
        );
      }
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      });
    }
    return original(command);
  });
  return objects;
}

function output(body: { runId: string; hash: string }) {
  return {
    runId: body.runId,
    cliAgentType: "claude-code",
    cliAgentSessionId: `native-${body.runId}`,
    cliAgentSessionHistoryHash: body.hash,
  } as const;
}

describe("Sandbox session history upload preparation", () => {
  it("validates input and rejects an actually issued token for another Run", async () => {
    await withClaimedRun(
      async ({ fixture, actor, agent, run, headers, body }) => {
        historyStorage(body.hash);
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
        expect((await prepareHistory(body, headers, [200])).body).toMatchObject(
          {
            existing: false,
            encoding: "identity",
            presignedUrl: expect.any(String),
          },
        );
      },
    );
  });

  it("deduplicates overlapping prepares and recovers while the object is missing", async () => {
    await withClaimedRun(async ({ body, headers, bytes }) => {
      const objects = historyStorage(body.hash);
      const responses = await Promise.all([
        prepareHistory(body, headers, [200]),
        prepareHistory(body, headers, [200]),
      ]);
      for (const response of responses) {
        expect(response.body).toMatchObject({
          existing: false,
          encoding: "identity",
          presignedUrl: expect.any(String),
        });
      }
      const mismatch = await prepareHistory(
        { ...body, rawSize: body.rawSize + 1, encodedSize: body.rawSize + 1 },
        headers,
        [400],
      );
      expect(mismatch.body.error.message).toBe(
        "Session history raw size does not match the existing blob",
      );
      expect((await prepareHistory(body, headers, [200])).body.existing).toBe(
        false,
      );
      objects.set(`blobs/${body.hash}.blob`, bytes);
      expect((await prepareHistory(body, headers, [200])).body).toStrictEqual({
        existing: true,
        encoding: "identity",
      });
    });
  });

  it.each(["gzip", "zstd"] as const)(
    "preserves %s repair restrictions and continuation metadata",
    async (encoding) => {
      await withClaimedRun(
        async ({ fixture, actor, agent, run, body, headers, bytes }) => {
          const objects = historyStorage(body.hash);
          const compressed =
            encoding === "gzip" ? gzipSync(bytes) : zstdCompressSync(bytes);
          const compressedBody = {
            ...body,
            encoding,
            encodedSize: compressed.length,
          };
          expect(
            (await prepareHistory(compressedBody, headers, [200])).body,
          ).toMatchObject({
            existing: false,
            encoding,
            presignedUrl: expect.any(String),
          });
          const wrongSize = await prepareHistory(
            { ...compressedBody, encodedSize: compressed.length + 1 },
            headers,
            [400],
          );
          expect(wrongSize.body.error.message).toBe(
            "Session history encoded size does not match the existing blob",
          );
          const wrongEncoding = await prepareHistory(
            {
              ...compressedBody,
              encoding: encoding === "gzip" ? "zstd" : "gzip",
            },
            headers,
            [400],
          );
          expect(wrongEncoding.body.error.message).toBe(
            "Compressed session history upload encoding must match the existing blob",
          );
          const identity = await prepareHistory(body, headers, [400]);
          expect(identity.body.error.message).toBe(
            "Identity session history upload cannot repair a compressed blob",
          );
          objects.set(
            `blobs/${body.hash}.blob.${encoding === "gzip" ? "gz" : "zst"}`,
            compressed,
          );
          expect(
            (
              await prepareHistory(
                { ...compressedBody, encodedSize: compressed.length + 1 },
                headers,
                [200],
              )
            ).body,
          ).toStrictEqual({ existing: true, encoding });
          await webhooks.requestAgentRunOutputs(output(body), headers, [200]);
          const continuation = await runs.createThreadRun(actor, {
            agentId: agent.agentId,
            threadId: run.threadId,
            prompt: "Continue the uploaded history",
          });
          fixture.registerRun(continuation.runId);
          const claim = await runs.claimRunnerJob(continuation.runId);
          fixture.registerClaim(continuation.runId, claim.sandboxToken);
          expect(claim.resumeSession).toMatchObject({
            sessionId: `native-${run.runId}`,
            historyRef: {
              hash: body.hash,
              rawSize: bytes.length,
              encodedSize: compressed.length,
              encoding,
            },
          });
        },
      );
    },
  );

  it("repairs zero-size metadata produced by the current completion callback", async () => {
    await withClaimedRun(
      async ({ fixture, actor, agent, run, body, headers, bytes }) => {
        const objects = historyStorage(body.hash);
        await webhooks.requestAgentRunOutputs(output(body), headers, [200]);
        await expect(runs.readRun(actor, run.runId)).resolves.toMatchObject({
          status: "completed",
        });
        const repaired = await Promise.all([
          prepareHistory(body, headers, [200]),
          prepareHistory(body, headers, [200]),
        ]);
        for (const response of repaired) {
          expect(response.body).toMatchObject({
            existing: false,
            encoding: "identity",
          });
        }
        objects.set(`blobs/${body.hash}.blob`, bytes);
        const continuation = await runs.createThreadRun(actor, {
          agentId: agent.agentId,
          threadId: run.threadId,
          prompt: "Resume repaired callback metadata",
        });
        fixture.registerRun(continuation.runId);
        const claim = await runs.claimRunnerJob(continuation.runId);
        fixture.registerClaim(continuation.runId, claim.sandboxToken);
        expect(claim.resumeSession).toMatchObject({
          historyRef: {
            hash: body.hash,
            rawSize: bytes.length,
            encodedSize: bytes.length,
            encoding: "identity",
          },
        });
      },
    );
  });

  it("admits a cancelled Run and hides a Run deleted through its Agent lifecycle", async () => {
    await withClaimedRun(
      async ({ fixture, actor, agent, run, body, headers }) => {
        historyStorage(body.hash);
        await runs.requestCancelRun(actor, run.runId, [200]);
        expect((await prepareHistory(body, headers, [200])).body).toMatchObject(
          { existing: false, encoding: "identity" },
        );
        await webhooks.requestAgentComplete(
          { runId: run.runId, exitCode: 1 },
          headers,
          [200],
        );
        fixture.registerRunDeletion(run.runId);
        await bdd.deleteAgent(actor, agent.agentId);
        expect(
          (await prepareHistory(body, headers, [404])).body.error.message,
        ).toBe("Agent run not found");
      },
    );
  });

  it("recovers after caller cancellation while checking the external object", async () => {
    await withClaimedRun(async ({ body, headers }) => {
      historyStorage(body.hash);
      await prepareHistory(body, headers, [200]);
      const controller = new AbortController();
      const original = context.mocks.s3.send.getMockImplementation();
      if (!original) {
        throw new Error("Expected the external S3 adapter");
      }
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        if (
          command instanceof HeadObjectCommand &&
          command.input.Key === `blobs/${body.hash}.blob`
        ) {
          controller.abort();
        }
        return original(command);
      });
      const client = setupAppWithRoutes({
        context,
        routes: webhooksAgentSessionHistoryRoutes,
        signal: controller.signal,
      })(webhookSessionHistoryPrepareContract);
      await expect(
        accept(client.prepare({ headers, body }), [500]),
      ).resolves.toMatchObject({ status: 500 });
      expect((await prepareHistory(body, headers, [200])).body).toMatchObject({
        existing: false,
        encoding: "identity",
        presignedUrl: expect.any(String),
      });
    });
  });
});
