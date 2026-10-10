import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  cronConsolidatePiMemoryPhase2Contract,
  cronExtractPiMemoryStage1Contract,
} from "@okouai/api-contracts/contracts/cron";
import { computeContentHashFromHashes } from "@okouai/api-contracts/contracts/storage-content-hash";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronConsolidatePiMemoryPhase2Routes } from "../cron-consolidate-pi-memory-phase2";
import { cronExtractPiMemoryStage1Routes } from "../cron-extract-pi-memory-stage1";
import {
  createChatEventsFixture,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
} from "./helpers/chat-events-fixture";
import {
  createRunsApi,
  expectCanonicalStorageManifest,
} from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { memoryArchive } from "./helpers/public-runner-memory";

const context = testContext();
const chat = createChatEventsFixture(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
type Claim = Awaited<ReturnType<typeof runs.claimRunnerJob>>;

function cronHeaders() {
  return { authorization: `Bearer ${env("CRON_SECRET")}` };
}

function maintenanceInput(claim: Claim) {
  const maintenance = claim.piLaunchConfig?.maintenance;
  const memory = expectCanonicalStorageManifest(
    claim.storageManifest,
  )?.storageMounts;
  if (!maintenance || memory?.length !== 1 || !memory[0]) {
    throw new Error(
      "Expected the operator's genuine private maintenance launch",
    );
  }
  expect(memory[0]).toMatchObject({
    storageId: maintenance.memoryStorageId,
    versionId: maintenance.claimedBaseVersionId,
    mountPath: PI_MEMORY_ROOT,
    writeback: true,
  });
  return { maintenance, memory: memory[0] };
}

async function prepareMaintenance() {
  mockNow(now());
  mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "true");
  // These production operators are this case's explicitly scoped system boundary.
  const isolated = await setupApp({
    context,
    routes: cronExtractPiMemoryStage1Routes,
    isolatePg: true,
  });
  const stage1 = isolated(cronExtractPiMemoryStage1Contract);
  await accept(
    stage1.extract({ headers: { authorization: "Bearer wrong-secret" } }),
    [401],
  );
  const stage2 = setupApp({
    context,
    routes: cronConsolidatePiMemoryPhase2Routes,
  })(cronConsolidatePiMemoryPhase2Contract);
  await accept(
    stage2.consolidate({ headers: { authorization: "Bearer wrong-secret" } }),
    [401],
  );

  const actor = await chat.entitledChatActor();
  if (!actor.actor.orgId) {
    throw new Error("Expected the ordinary source Run's organization");
  }
  await chat.configureSubscriptionPiModel(actor.actor);
  await updateFeatureSwitchesForUser(
    context,
    { ...actor.actor, orgId: actor.actor.orgId },
    {
      [FeatureSwitchKey.PiMemory]: true,
    },
  );
  chat.mockPiResourceArchiveDownloads();
  const objects = chat.mockPiObjectStore();
  server.use(
    http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
      const key = new URL(request.url).searchParams.get("object");
      const bytes = key ? objects.get(key) : undefined;
      // System resources continue through the existing external archive mock.
      if (bytes) {
        return new HttpResponse(new Uint8Array(bytes));
      }
    }),
  );
  const transport = context.mocks.s3.send.getMockImplementation();
  if (!transport) {
    throw new Error("Expected the external object-store transport");
  }
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const bytes = objects.get(`${command.input.Bucket}/${command.input.Key}`);
      if (bytes) {
        return Promise.resolve({ ContentLength: bytes.length });
      }
    }
    return transport(command);
  });
  const prompt = "Remember that this user prefers focused public API tests.";
  const source = await chat.sendChatRun(actor.actor, {
    agentId: actor.agentId,
    prompt,
    model: "gpt-6-luna",
  });
  const sourceClaim = await chat.claimChatRun(actor.runnerGroup, source.runId);
  await chat.completeSandboxFirstPiRun({
    actor: actor.actor,
    run: source,
    claim: sourceClaim,
    historyObjects: objects,
    prompt,
    answer: "I will use focused public API tests.",
  });

  // A later ordinary Thread requests the next UTC day's selection. The genuine
  // source has now been idle for more than six hours; no rows are backdated.
  mockNow(now() + 24 * 60 * 60 * 1000);
  const trigger = await chat.sendChatRun(actor.actor, {
    agentId: actor.agentId,
    prompt: "Start another Thread after the source has become idle.",
    model: "gpt-6-luna",
  });
  const triggerClaim = await chat.claimChatRun(
    actor.runnerGroup,
    trigger.runId,
  );
  await webhooks.requestAgentComplete(
    {
      runId: trigger.runId,
      exitCode: 1,
      error: "No source history for this Thread",
    },
    triggerClaim.sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();

  server.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () => {
      const base = {
        id: `chatcmpl_${source.runId}`,
        object: "chat.completion.chunk",
        model: "@preset/memory",
      };
      const chunks = [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                content: JSON.stringify({
                  raw_memory: "This user prefers focused public API tests.",
                  rollout_summary:
                    "The user asked for focused public API coverage.",
                  rollout_slug: "public-api-tests",
                }),
              },
              finish_reason: null,
            },
          ],
        },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        },
      ];
      return new HttpResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const body = `${chunks
              .map((chunk) => {
                return `data: ${JSON.stringify(chunk)}\n\n`;
              })
              .join("")}data: [DONE]\n\n`;
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    }),
  );
  const extracted = await accept(
    stage1.extract({ headers: cronHeaders() }),
    [200],
  );
  expect(extracted.body).toMatchObject({
    success: true,
    succeeded: 1,
    terminalFailure: 0,
    retryableFailure: 0,
  });
  const dispatched = await accept(
    stage2.consolidate({ headers: cronHeaders() }),
    [200],
  );
  expect(dispatched.body).toMatchObject({
    success: true,
    claimed: 1,
    failed: 0,
    stale: 0,
  });
  async function claimMaintenance() {
    await runs.heartbeatRunner(actor.runnerGroup);
    const polled = await runs.pollRunner(actor.runnerGroup);
    const job = polled.body.job;
    if (!job) {
      throw new Error(
        "Expected the maintenance job discovered through Runner poll",
      );
    }
    const claim = await runs.claimRunnerJob(job.runId);
    const { maintenance, memory } = maintenanceInput(claim);
    expect(maintenance.selected).toContainEqual(
      expect.objectContaining({
        sourceRunId: source.runId,
        piSessionId: sourceClaim.claim.piSessionId,
        rawMemory: "This user prefers focused public API tests.",
      }),
    );
    const sourceMemory = expectCanonicalStorageManifest(
      sourceClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory";
    });
    expect(memory.storageId).toBe(sourceMemory?.storageId);
    expect(claim.piSessionId).toBe(job.runId);
    const readable = await runs.requestReadRun(actor.actor, job.runId, [200]);
    expect(readable.body).toMatchObject({
      runId: job.runId,
      status: "running",
      source: { model: "okou-memory" },
    });
    return {
      runId: job.runId,
      claim,
      headers: { authorization: `Bearer ${claim.sandboxToken}` },
      maintenance,
      memory,
    };
  }
  const maintenance = await claimMaintenance();
  return { ...actor, stage2, claimMaintenance, ...maintenance };
}

type Maintenance = Awaited<ReturnType<typeof prepareMaintenance>>;

function publication(
  run: Pick<Maintenance, "runId" | "maintenance">,
  content?: string,
) {
  const files =
    content === undefined
      ? []
      : [
          {
            path: "MEMORY.md",
            size: Buffer.byteLength(content),
            hash: createHash("sha256").update(content).digest("hex"),
          },
        ];
  const versionId = computeContentHashFromHashes(
    run.maintenance.memoryStorageId,
    files,
  );
  return {
    runId: run.runId,
    storageId: run.maintenance.memoryStorageId,
    parentVersionId: run.maintenance.claimedBaseVersionId,
    versionId,
    files,
    maintenanceAttestation: {
      schemaVersion: 2 as const,
      leaseToken: run.maintenance.leaseToken,
      claimedRevision: run.maintenance.claimedRevision,
      claimedBaseVersionId: run.maintenance.claimedBaseVersionId,
      selectionDigest: run.maintenance.selectionDigest,
      validatedVersionId: versionId,
    },
  };
}

async function publish(
  run: Pick<Maintenance, "runId" | "maintenance" | "headers">,
  content?: string,
) {
  const body = publication(run, content);
  const prepared = await webhooks.requestAgentStoragePrepare(
    body,
    run.headers,
    [200],
  );
  if (prepared.status !== 200) {
    throw new Error("Expected maintenance upload preparation to succeed");
  }
  expect(prepared.body.versionId).toBe(body.versionId);
  if (content !== undefined) {
    const uploads = prepared.body.uploads;
    if (!uploads) {
      throw new Error("Expected the real maintenance upload authorization");
    }
    for (const [upload, bytes] of [
      [uploads.archive, memoryArchive("MEMORY.md", content)],
      [
        uploads.manifest,
        Buffer.from(
          JSON.stringify({
            version: 1,
            files: body.files,
            createdAt: nowDate().toISOString(),
          }),
        ),
      ],
    ] as const) {
      const response = await fetch(upload.presignedUrl, {
        method: "PUT",
        body: new Uint8Array(bytes),
      });
      expect(response.status).toBe(200);
    }
  } else {
    expect(prepared.body.existing).toBeTruthy();
    expect(body.versionId).toBe(body.parentVersionId);
  }
  const committed = await webhooks.requestAgentStorageCommit(
    body,
    run.headers,
    [200],
  );
  expect(committed.body).toMatchObject({
    success: true,
    versionId: body.versionId,
    fileCount: body.files.length,
  });
  return body;
}

async function completeMaintenance(
  run: Pick<Maintenance, "runId" | "headers" | "memory">,
  versionId: string,
) {
  const body = {
    runId: run.runId,
    exitCode: 0,
    completion: {
      cliAgentType: "pi" as const,
      cliAgentSessionId: run.runId,
      cliAgentSessionHistoryDisposition: "unavailable" as const,
      artifactSnapshots: [
        {
          name: run.memory.name,
          mountPath: run.memory.mountPath,
          version: versionId,
        },
      ],
    },
  };
  const completed = await webhooks.requestAgentComplete(
    body,
    run.headers,
    [200],
  );
  expect(completed.body).toMatchObject({ success: true });
  await flushWaitUntilForTest();
  await webhooks.requestAgentComplete(body, run.headers, [200]);
  await flushWaitUntilForTest();
  return { body, response: completed };
}

async function observeMemory(
  run: Pick<Maintenance, "actor" | "agentId" | "runnerGroup">,
  expectedContent?: string,
) {
  const ordinary = await chat.sendChatRun(run.actor, {
    agentId: run.agentId,
    prompt: "Observe the current memory",
    model: "gpt-6-luna",
  });
  const claimed = await chat.claimChatRun(run.runnerGroup, ordinary.runId);
  const memory = expectCanonicalStorageManifest(
    claimed.claim.storageManifest,
  )?.storageMounts.find((mount) => {
    return mount.name === "memory";
  });
  if (!memory) {
    throw new Error("Expected the ordinary Run's memory mount");
  }
  if (expectedContent !== undefined) {
    if (!memory.archiveUrl) {
      throw new Error("Expected the ordinary Run's memory download URL");
    }
    const archive = await fetch(memory.archiveUrl);
    expect(archive.status).toBe(200);
    const tar = gunzipSync(Buffer.from(await archive.arrayBuffer()));
    expect(tar.subarray(0, 9).toString()).toBe("MEMORY.md");
    expect(
      tar.subarray(512, 512 + Buffer.byteLength(expectedContent)).toString(),
    ).toBe(expectedContent);
  }
  await webhooks.requestAgentComplete(
    {
      runId: ordinary.runId,
      exitCode: 1,
      error: "Memory observation complete",
    },
    claimed.sandboxHeaders,
    [200],
  );
  return { memory, ordinary, claimed };
}

async function publishOrdinaryMemory(
  run: Pick<Maintenance, "actor" | "agentId" | "runnerGroup">,
  content: string,
) {
  const ordinary = await chat.sendChatRun(run.actor, {
    agentId: run.agentId,
    prompt: "Publish a newer owned memory",
    model: "gpt-6-luna",
  });
  const claimed = await chat.claimChatRun(run.runnerGroup, ordinary.runId);
  const memory = expectCanonicalStorageManifest(
    claimed.claim.storageManifest,
  )?.storageMounts.find((mount) => {
    return mount.name === "memory";
  });
  if (!memory) {
    throw new Error("Expected the ordinary publisher's memory mount");
  }
  const files = [
    {
      path: "MEMORY.md",
      size: Buffer.byteLength(content),
      hash: createHash("sha256").update(content).digest("hex"),
    },
  ];
  const newer = {
    runId: ordinary.runId,
    storageId: memory.storageId,
    parentVersionId: memory.versionId,
    files,
    versionId: computeContentHashFromHashes(memory.storageId, files),
  };
  const prepared = await webhooks.requestAgentStoragePrepare(
    newer,
    claimed.sandboxHeaders,
    [200],
  );
  if (prepared.status !== 200) {
    throw new Error("Expected ordinary upload preparation to succeed");
  }
  const uploads = prepared.body.uploads;
  if (!uploads) {
    throw new Error("Expected the ordinary publisher's upload authorization");
  }
  for (const [upload, bytes] of [
    [uploads.archive, memoryArchive("MEMORY.md", content)],
    [
      uploads.manifest,
      Buffer.from(
        JSON.stringify({
          version: 1,
          files,
          createdAt: nowDate().toISOString(),
        }),
      ),
    ],
  ] as const) {
    expect(
      (
        await fetch(upload.presignedUrl, {
          method: "PUT",
          body: new Uint8Array(bytes),
        })
      ).status,
    ).toBe(200);
  }
  const committed = await webhooks.requestAgentStorageCommit(
    newer,
    claimed.sandboxHeaders,
    [200],
  );
  if (committed.status !== 200) {
    throw new Error("Expected ordinary memory publication to succeed");
  }
  expect(committed.body.versionId).toBe(newer.versionId);
  await webhooks.requestAgentComplete(
    { runId: ordinary.runId, exitCode: 1, error: "Owned memory published" },
    claimed.sandboxHeaders,
    [200],
  );
  return newer;
}

describe("Genuine Pi maintenance publication results", () => {
  it("publishes and replays a maintenance result before and after private completion", async () => {
    const run = await prepareMaintenance();
    const body = await publish(run, "Prefer focused public API tests.\n");
    const replay = await webhooks.requestAgentStorageCommit(
      body,
      run.headers,
      [200],
    );
    expect(replay.body).toMatchObject({
      versionId: body.versionId,
      deduplicated: true,
    });
    await completeMaintenance(run, body.versionId);
    await webhooks.requestAgentStorageCommit(body, run.headers, [200]);
    expect(
      (await observeMemory(run, "Prefer focused public API tests.\n")).memory,
    ).toMatchObject({
      storageId: body.storageId,
      versionId: body.versionId,
      archiveUrl: expect.any(String),
    });
    const settled = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(settled.body).toMatchObject({ claimed: 0, noWork: 1 });
  });

  it("replays a completed maintenance Run after a later maintenance replaces the latest Job result", async () => {
    const run = await prepareMaintenance();
    const first = await publish(run, "First maintenance memory.\n");
    const completed = await completeMaintenance(run, first.versionId);
    const firstResult = await runs.readRun(run.actor, run.runId);
    expect(firstResult).toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: first.versionId }] },
    });
    const recoveryReplay = {
      ...completed.body,
      completion: {
        ...completed.body.completion,
        artifactSnapshots: [
          {
            name: run.memory.name,
            mountPath: run.memory.mountPath,
            version: run.maintenance.claimedBaseVersionId,
          },
        ],
      },
    };
    await webhooks.requestAgentComplete(recoveryReplay, run.headers, [200]);

    // An ordinary owned HEAD change queues reconciliation immediately, within
    // the first claim's real three-hour credential lifetime and without waiting
    // for the six-hour successful-maintenance cooldown.
    const ordinary = await publishOrdinaryMemory(
      run,
      "Ordinary changed memory.\n",
    );
    const dispatched = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(dispatched.body).toMatchObject({ claimed: 1, failed: 0, stale: 0 });
    const next = await run.claimMaintenance();
    expect(next.runId).not.toBe(run.runId);
    expect(next.maintenance.claimedRevision).toBeGreaterThan(
      run.maintenance.claimedRevision,
    );
    expect(next.maintenance.claimedBaseVersionId).toBe(ordinary.versionId);
    const latest = await publish(next, "Later maintenance memory.\n");
    await completeMaintenance(next, latest.versionId);
    const latestResult = await runs.readRun(run.actor, next.runId);
    expect(latestResult).toMatchObject({
      status: "completed",
      result: { storageOutputs: [{ version: latest.versionId }] },
    });

    const replay = await webhooks.requestAgentComplete(
      completed.body,
      run.headers,
      [200],
    );
    expect(replay.body).toStrictEqual(completed.response.body);
    const recovered = await webhooks.requestAgentComplete(
      recoveryReplay,
      run.headers,
      [200],
    );
    expect(recovered.body).toStrictEqual(completed.response.body);
    await flushWaitUntilForTest();
    for (const completion of [
      { ...completed.body.completion, cliAgentSessionId: next.runId },
      { ...completed.body.completion, cliAgentType: "claude-code" },
      {
        ...completed.body.completion,
        cliAgentSessionHistoryDisposition: "discarded_oversized" as const,
      },
      {
        ...completed.body.completion,
        artifactSnapshots: [
          {
            name: run.memory.name,
            mountPath: run.memory.mountPath,
            version: latest.versionId,
          },
        ],
      },
      { ...completed.body.completion, artifactSnapshots: [] },
      {
        ...completed.body.completion,
        artifactSnapshots: [
          ...completed.body.completion.artifactSnapshots,
          ...completed.body.completion.artifactSnapshots,
        ],
      },
    ]) {
      await webhooks.requestAgentComplete(
        { ...completed.body, completion },
        run.headers,
        [400],
      );
    }
    await webhooks.requestAgentComplete(completed.body, next.headers, [401]);
    const peer = await chat.entitledChatActor({ orgId: run.actor.orgId });
    const foreign = await chat.sendChatRun(peer.actor, {
      agentId: peer.agentId,
      prompt: "Own a foreign Run",
      model: "claude-fable-5-1",
    });
    const foreignClaim = await chat.claimChatRun(
      peer.runnerGroup,
      foreign.runId,
    );
    await webhooks.requestAgentComplete(
      completed.body,
      foreignClaim.sandboxHeaders,
      [401],
    );
    await runs.requestReadRun(peer.actor, run.runId, [404]);
    await webhooks.requestAgentComplete(
      {
        runId: foreign.runId,
        exitCode: 1,
        error: "Foreign replay check complete",
      },
      foreignClaim.sandboxHeaders,
      [200],
    );
    await expect(runs.readRun(run.actor, run.runId)).resolves.toStrictEqual(
      firstResult,
    );
    await expect(runs.readRun(run.actor, next.runId)).resolves.toStrictEqual(
      latestResult,
    );
    expect(
      (await observeMemory(run, "Later maintenance memory.\n")).memory
        .versionId,
    ).toBe(latest.versionId);
    const settled = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(settled.body).toMatchObject({ claimed: 0, noWork: 1 });
    // Advancing the same case clock expires the original genuine credential.
    mockNow(now() + 3 * 60 * 60 * 1000 + 1000);
    await webhooks.requestAgentComplete(completed.body, run.headers, [401]);
  });

  it("replays a no-diff result without restoring an older memory head", async () => {
    const run = await prepareMaintenance();
    const body = await publish(run);
    await webhooks.requestAgentStorageCommit(body, run.headers, [200]);
    await completeMaintenance(run, body.versionId);
    expect((await observeMemory(run)).memory.versionId).toBe(body.versionId);
    const newer = await publishOrdinaryMemory(run, "Newer ordinary memory.\n");
    const replay = await webhooks.requestAgentStorageCommit(
      body,
      run.headers,
      [200],
    );
    expect(replay.body).toMatchObject({
      versionId: body.versionId,
      deduplicated: true,
    });
    expect(newer.versionId).not.toBe(body.versionId);
    expect(
      (await observeMemory(run, "Newer ordinary memory.\n")).memory.versionId,
    ).toBe(newer.versionId);
  });

  it("retries a still-owned nonzero maintenance completion through the operator", async () => {
    const run = await prepareMaintenance();
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "Provider failed before publication",
      },
      run.headers,
      [200],
    );
    await flushWaitUntilForTest();
    const waiting = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(waiting.body).toMatchObject({ claimed: 0, noWork: 1 });
    mockNow(now() + 61 * 60 * 1000);
    const retry = await accept(
      run.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(retry.body).toMatchObject({ claimed: 1, failed: 0 });
    const next = await run.claimMaintenance();
    expect(next.runId).not.toBe(run.runId);
    expect(next.maintenance.claimedBaseVersionId).toBe(
      run.maintenance.claimedBaseVersionId,
    );
    await webhooks.requestAgentStoragePrepare(
      publication(run),
      run.headers,
      [404],
    );
    const published = await publish(
      next,
      "Memory recovered after a genuine failed attempt.\n",
    );
    await completeMaintenance(next, published.versionId);
    expect(
      (
        await observeMemory(
          run,
          "Memory recovered after a genuine failed attempt.\n",
        )
      ).memory.versionId,
    ).toBe(published.versionId);
  });

  it.each(["the same organization", "another organization"])(
    "rejects foreign claims, foreign memory and altered launch evidence from %s",
    async (scope) => {
      const run = await prepareMaintenance();
      const peer = await chat.entitledChatActor(
        scope === "the same organization" ? { orgId: run.actor.orgId } : {},
      );
      const ordinary = await chat.sendChatRun(peer.actor, {
        agentId: peer.agentId,
        prompt: "Own another user's memory",
        model: "claude-fable-5-1",
      });
      const claimed = await chat.claimChatRun(peer.runnerGroup, ordinary.runId);
      const foreignMemory = expectCanonicalStorageManifest(
        claimed.claim.storageManifest,
      )?.storageMounts.find((mount) => {
        return mount.name === "memory";
      });
      if (!foreignMemory) {
        throw new Error("Expected the peer's actual memory mount");
      }
      expect(foreignMemory.storageId).not.toBe(run.memory.storageId);
      await runs.requestReadRun(peer.actor, run.runId, [404]);
      const body = publication(run);
      for (const request of [
        webhooks.requestAgentStoragePrepare,
        webhooks.requestAgentStorageCommit,
      ]) {
        await request(body, claimed.sandboxHeaders, [401]);
        await request(
          { ...body, storageId: foreignMemory.storageId },
          run.headers,
          [404],
        );
        await request(
          {
            ...body,
            maintenanceAttestation: {
              ...body.maintenanceAttestation,
              claimedRevision: body.maintenanceAttestation.claimedRevision + 1,
            },
          },
          run.headers,
          [404],
        );
        await request(
          {
            ...body,
            maintenanceAttestation: {
              ...body.maintenanceAttestation,
              selectionDigest: createHash("sha256")
                .update("foreign selection")
                .digest("hex"),
            },
          },
          run.headers,
          [404],
        );
      }
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 1 },
        claimed.sandboxHeaders,
        [401],
      );
      const published = await publish(run);
      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "pi",
            cliAgentSessionId: ordinary.runId,
            cliAgentSessionHistoryDisposition: "unavailable",
            artifactSnapshots: [
              {
                name: run.memory.name,
                mountPath: run.memory.mountPath,
                version: published.versionId,
              },
            ],
          },
        },
        run.headers,
        [400],
      );
      await completeMaintenance(run, published.versionId);
      await webhooks.requestAgentComplete(
        {
          runId: ordinary.runId,
          exitCode: 1,
          error: "Peer ownership check complete",
        },
        claimed.sandboxHeaders,
        [200],
      );
      expect((await observeMemory(run)).memory.versionId).toBe(
        published.versionId,
      );
    },
  );
});
