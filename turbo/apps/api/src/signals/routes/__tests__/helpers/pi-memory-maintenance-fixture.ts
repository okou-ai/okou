import { createHash, randomUUID } from "node:crypto";
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
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env, mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { mockNow, now, nowDate } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import { flushWaitUntilForTest } from "../../../context/wait-until";
import { cronConsolidatePiMemoryPhase2Routes } from "../../cron-consolidate-pi-memory-phase2";
import { cronExtractPiMemoryStage1Routes } from "../../cron-extract-pi-memory-stage1";
import {
  createChatEventsFixture,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
} from "./chat-events-fixture";
import { createRunsApi, expectCanonicalStorageManifest } from "./api-bdd-runs";
import { createWebhookCallbackApi } from "./api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { memoryArchive } from "./public-runner-memory";

export function createPiMemoryMaintenanceFixture(
  context: TestContext,
  onboarding: "paid" | "limited-free" = "paid",
) {
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

  async function createChatActor(
    runnerGroup: string,
    orgId?: string,
    model: "gpt-6-luna" | "claude-fable-5-1" = "gpt-6-luna",
    userId?: string,
  ) {
    const identity = chat.bdd.user({ orgId, userId });
    if (!identity.orgId) {
      throw new Error("Expected the Pi actor's organization");
    }
    const actor = { ...identity, orgId: identity.orgId };
    const paidBootstrap = !orgId && onboarding === "paid";
    const registered = paidBootstrap
      ? await runs.grantProEntitlement(actor)
      : await chat.bdd.readOnboardingStatus(actor);
    if (!registered.defaultAgentId) {
      throw new Error("Expected onboarding to create a default agent");
    }
    // The paid helper already completed this organization's onboarding.
    if (!paidBootstrap) {
      const completed = await chat.bdd.completeOnboarding(actor);
      expect(completed.status).toBe(200);
    }
    if (model === "gpt-6-luna") {
      // Ordinary Runs name GPT explicitly; maintenance uses its built-in route.
      await chat.connectSubscriptionPiModel(actor);
    } else {
      await runs.ensurePersonalSubscriptionModel(actor);
    }
    return { actor, agentId: registered.defaultAgentId, runnerGroup };
  }

  async function prepareSources(
    options: {
      independentOwner?: true;
      peerScope?: "same-org" | "same-user-other-org" | "foreign";
      sourceEvidence?: { readonly prompt: string; readonly answer: string };
      peerEvidence?: { readonly prompt: string; readonly answer: string };
    } = {},
  ) {
    mockNow(now());
    mockEnv("PI_MEMORY_BACKGROUND_WORKERS_ENABLED", "true");
    // These production operators select work across owners, not just this actor.
    const isolated = await setupApp({
      context,
      routes: cronExtractPiMemoryStage1Routes,
      isolatePg: true,
    });
    const stage1 = isolated(cronExtractPiMemoryStage1Contract);
    const stage2 = setupApp({
      context,
      routes: cronConsolidatePiMemoryPhase2Routes,
    })(cronConsolidatePiMemoryPhase2Contract);

    chat.chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    chat.chatCallbacks.disableVapid();
    const runnerGroup = runs.configureRunnerGroup();
    const actor = await createChatActor(runnerGroup);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor.actor, orgId: actor.actor.orgId },
      {
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    const peerActor = options.independentOwner
      ? await createChatActor(
          runnerGroup,
          !options.peerScope || options.peerScope === "same-org"
            ? actor.actor.orgId
            : undefined,
          "gpt-6-luna",
          options.peerScope === "same-user-other-org"
            ? actor.actor.userId
            : undefined,
        )
      : undefined;
    if (peerActor) {
      await updateFeatureSwitchesForUser(context, peerActor.actor, {
        [FeatureSwitchKey.PiMemory]: true,
      });
    }
    const runnerIdentity = { runnerId: randomUUID(), heartbeatGeneration: 1 };
    let snapshotSequence = 0;
    async function heartbeatRunner(runningCount = 0) {
      await runs.requestHeartbeatRunner(true, [200], {
        group: actor.runnerGroup,
        runnerId: runnerIdentity.runnerId,
        snapshotSequence: ++snapshotSequence,
        maxConcurrent: 2,
        runningCount,
        allocatedVcpu: runningCount * 2,
        allocatedMemoryMb: runningCount * 2048,
      });
    }
    async function claimOrdinaryRun(runId: string, runningCount = 0) {
      await heartbeatRunner(runningCount);
      const claim = await runs.claimRunnerJob(runId, { runnerIdentity });
      return {
        claim,
        sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
      };
    }
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
        const bytes = objects.get(
          `${command.input.Bucket}/${command.input.Key}`,
        );
        if (bytes) {
          return Promise.resolve({ ContentLength: bytes.length });
        }
      }
      return transport(command);
    });
    async function createSource(
      owner: typeof actor,
      evidence: { readonly prompt: string; readonly answer: string },
    ) {
      const source = await chat.sendChatRun(owner.actor, {
        agentId: owner.agentId,
        prompt: evidence.prompt,
        model: "gpt-6-luna",
      });
      const sourceClaim = await claimOrdinaryRun(source.runId);
      await chat.completeSandboxFirstPiRun({
        actor: owner.actor,
        run: source,
        claim: sourceClaim,
        historyObjects: objects,
        ...evidence,
      });
      return { source, sourceClaim };
    }
    const defaultEvidence = {
      prompt: "Remember that this user prefers focused public API tests.",
      answer: "I will use focused public API tests.",
    };
    const { source, sourceClaim } = await createSource(
      actor,
      options.sourceEvidence ?? defaultEvidence,
    );

    const peer = peerActor
      ? await createSource(peerActor, options.peerEvidence ?? defaultEvidence)
      : undefined;
    const peerSource = peer?.source;
    const peerSourceClaim = peer?.sourceClaim;

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
    // A later ordinary Thread requests the next UTC day's selection. The genuine
    // source has now been idle for more than six hours; no rows are backdated.
    mockNow(now() + 24 * 60 * 60 * 1000);
    const trigger = await chat.sendChatRun(actor.actor, {
      agentId: actor.agentId,
      prompt: "Start another Thread after the source has become idle.",
      model: "gpt-6-luna",
    });
    await runs.requestCancelRun(actor.actor, trigger.runId, [200]);
    await flushWaitUntilForTest();
    if (peerActor) {
      if (peerActor.actor.userId === actor.actor.userId) {
        // Stage 1 owns one day per USER, not per org. Extract the first org's
        // genuine selection before a later UTC day can select the other org.
        // Both succeeded candidates must still reach distinct maintenance jobs.
        const firstDay = await accept(
          stage1.extract({ headers: cronHeaders() }),
          [200],
        );
        expect(firstDay.body).toMatchObject({
          success: true,
          succeeded: 1,
          terminalFailure: 0,
          retryableFailure: 0,
        });
        mockNow(now() + 24 * 60 * 60 * 1000);
      }
      const peerTrigger = await chat.sendChatRun(peerActor.actor, {
        agentId: peerActor.agentId,
        prompt: "Request the next day's selection",
        model: "gpt-6-luna",
      });
      await runs.requestCancelRun(peerActor.actor, peerTrigger.runId, [200]);
      await flushWaitUntilForTest();
    }

    async function claimMaintenance(runningCount = 0) {
      await heartbeatRunner(runningCount);
      const polled = await runs.pollRunner(actor.runnerGroup);
      const job = polled.body.job;
      if (!job) {
        throw new Error(
          "Expected the maintenance job discovered through Runner poll",
        );
      }
      const claim = await runs.claimRunnerJob(job.runId, { runnerIdentity });
      const { maintenance, memory } = maintenanceInput(claim);
      const isPeer =
        peerSource &&
        maintenance.selected.some((selected) => {
          return selected.sourceRunId === peerSource.runId;
        });
      const selectedActor = isPeer && peerActor ? peerActor : actor;
      const selectedSource = isPeer && peerSource ? peerSource : source;
      const selectedClaim =
        isPeer && peerSourceClaim ? peerSourceClaim : sourceClaim;
      expect(maintenance.selected).toContainEqual(
        expect.objectContaining({
          sourceRunId: selectedSource.runId,
          piSessionId: selectedClaim.claim.piSessionId,
          rawMemory: "This user prefers focused public API tests.",
        }),
      );
      const sourceMemory = expectCanonicalStorageManifest(
        selectedClaim.claim.storageManifest,
      )?.storageMounts.find((mount) => {
        return mount.name === "memory";
      });
      expect(memory.storageId).toBe(sourceMemory?.storageId);
      expect(claim.piSessionId).toBe(job.runId);
      return {
        ...selectedActor,
        runId: job.runId,
        claim,
        headers: { authorization: `Bearer ${claim.sandboxToken}` },
        maintenance,
        memory,
      };
    }
    return {
      ...actor,
      sourceActor: actor,
      runnerIdentity,
      peerActor,
      source,
      sourceClaim,
      peerSource,
      stage1,
      stage2,
      claimMaintenance,
      claimOrdinaryRun,
      heartbeatRunner,
      createSource,
    };
  }

  async function prepareMaintenance(
    options: Parameters<typeof prepareSources>[0] = {},
  ) {
    const sources = await prepareSources(options);
    const extracted = await accept(
      sources.stage1.extract({ headers: cronHeaders() }),
      [200],
    );
    expect(extracted.body).toMatchObject({
      success: true,
      // A shared user's first org was already extracted on the preceding day.
      succeeded:
        sources.peerActor &&
        sources.peerActor.actor.userId !== sources.sourceActor.actor.userId
          ? 2
          : 1,
      terminalFailure: 0,
      retryableFailure: 0,
    });
    const dispatched = await accept(
      sources.stage2.consolidate({ headers: cronHeaders() }),
      [200],
    );
    expect(dispatched.body).toMatchObject({
      success: true,
      claimed: 1,
      failed: 0,
      stale: 0,
    });
    return { ...sources, ...(await sources.claimMaintenance()) };
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

  async function preparePublication(
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
    if (content !== undefined && body.versionId !== body.parentVersionId) {
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
    return body;
  }

  async function publish(
    run: Pick<Maintenance, "runId" | "maintenance" | "headers">,
    content?: string,
  ) {
    const body = await preparePublication(run, content);
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

  function maintenanceCompletion(
    run: Pick<Maintenance, "runId" | "memory">,
    versionId: string,
    exitCode = 0,
  ) {
    return {
      runId: run.runId,
      exitCode,
      completion: {
        cliAgentType: "pi" as const,
        cliAgentSessionId: run.runId,
        cliAgentSessionHistoryDisposition: "native_only" as const,
        artifactSnapshots: [
          {
            name: run.memory.name,
            mountPath: run.memory.mountPath,
            version: versionId,
          },
        ],
      },
    };
  }

  async function completeMaintenance(
    run: Pick<Maintenance, "runId" | "headers" | "memory">,
    versionId: string,
    concurrent = false,
    exitCode = 0,
  ) {
    const body = maintenanceCompletion(run, versionId, exitCode);
    const [completed, repeated] = concurrent
      ? await Promise.all([
          webhooks.requestAgentComplete(body, run.headers, [200]),
          webhooks.requestAgentComplete(body, run.headers, [200]),
        ])
      : ([
          await webhooks.requestAgentComplete(body, run.headers, [200]),
        ] as const);
    expect(completed.body).toMatchObject({ success: true });
    if (repeated) {
      expect(repeated.body).toStrictEqual(completed.body);
    }
    await flushWaitUntilForTest();
    return { body, response: completed };
  }

  async function observeMemory(
    run: Pick<
      Maintenance,
      "actor" | "agentId" | "runnerGroup" | "claimOrdinaryRun"
    >,
    expectedContent?: string,
    runningCount = 0,
  ) {
    const ordinary = await chat.sendChatRun(run.actor, {
      agentId: run.agentId,
      prompt: "Observe the current memory",
      model: "gpt-6-luna",
    });
    const claimed = await run.claimOrdinaryRun(ordinary.runId, runningCount);
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
    run: Pick<
      Maintenance,
      "actor" | "agentId" | "runnerGroup" | "claimOrdinaryRun"
    >,
    content: string,
    runningCount = 0,
  ) {
    const ordinary = await chat.sendChatRun(run.actor, {
      agentId: run.agentId,
      prompt: "Publish a newer owned memory",
      model: "gpt-6-luna",
    });
    const claimed = await run.claimOrdinaryRun(ordinary.runId, runningCount);
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

  async function expectBlocked(
    run: Pick<Maintenance, "stage2" | "runnerGroup">,
  ) {
    const responses = await Promise.all([
      run.stage2.consolidate({ headers: cronHeaders() }),
      run.stage2.consolidate({ headers: cronHeaders() }),
    ]);
    for (const response of responses) {
      const admitted = await accept(Promise.resolve(response), [200]);
      expect(admitted.body).toMatchObject({ claimed: 0, noWork: 1 });
    }
    const pending = await runs.pollRunner(run.runnerGroup);
    expect(pending.body.job).toBeNull();
  }

  return {
    chat,
    runs,
    webhooks,
    cronHeaders,
    createChatActor,
    prepareSources,
    prepareMaintenance,
    publication,
    preparePublication,
    publish,
    completeMaintenance,
    maintenanceCompletion,
    observeMemory,
    publishOrdinaryMemory,
    expectBlocked,
  };
}
