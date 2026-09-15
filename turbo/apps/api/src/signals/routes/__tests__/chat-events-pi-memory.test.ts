import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Header } from "tar";
import { storageTextFile } from "./helpers/api-bdd-storage-files";
import {
  type TriggerSource,
  triggerSourceSchema,
} from "@okouai/api-contracts/contracts/logs";
import {
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  DEFAULT_PROFILE,
  PI_AGENT_DIR,
  PI_MEMORY_ROOT,
  piApiFirstTurnManifestSchema,
} from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { env } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  readSessionHistoryBlobRefCountFixture,
  setRunLaunchSnapshotFixture,
  setRunPiMemoryAdmissionInputsFixture,
} from "../../../test-fixtures/agent-runs";
import {
  commitPiMemoryStage1CandidateFixture,
  deletePiMemoryStorageFixture,
  leasePiMemoryStage1CandidateFixture,
  piMemoryStage1AdmissionPrerequisiteSkipReasonFixture,
  readmitPiMemoryStage1CandidateFixture,
  readPiConversationIdentityFixture,
  readPiMemoryStage1CandidateFixture,
  readPiMemoryStage1DayFixture,
  setSyntheticPiMemoryStage1SelectionFixture,
} from "../../../test-fixtures/pi-memory-stage1-candidates";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { readAgentRunState$ } from "./helpers/agent-run-callback";
import type { ApiTestUser } from "./helpers/api-bdd";
import { expectCanonicalStorageManifest } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  commitMemoryVersion,
  seedReadyMemorySummaryProjection,
} from "./helpers/memory";
import { readRunLaunchSnapshotFixture } from "./helpers/runtime-state";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import {
  createChatEventsFixture,
  type PromptMessage,
  requireOrgId,
  createGptUsagePricingResolution,
  okouTokenFromClaim,
  type ChatRunCompletionOptions,
  userMessages,
  occurrences,
  piResponsesDeveloperPrompt,
} from "./helpers/chat-events-fixture";
import { piResponsesTextSse, piResponsesToolSse } from "./helpers/pi-responses";

const context = testContext();
const {
  bdd,
  api,
  chat,
  webhooks,
  runStateStore,
  entitledChatActor,
  configureBuiltInPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  requestSendEventWithBearer,
  mockPiCheckpointObjectStore,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

function frameworkMatchingCompletionOptions(
  threadId: string,
  cliAgentType: "claude-code" | "codex" | "pi",
  userNote?: string,
): ChatRunCompletionOptions {
  if (cliAgentType !== "pi") {
    return { cliAgentType };
  }
  const session = MemoryPiSession.create({
    cwd: "/home/user/workspace",
    id: threadId,
  });
  if (userNote !== undefined) {
    session.appendMessage({ role: "user", content: userNote, timestamp: 1 });
  }
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "BDD Pi completion checkpoint" }],
    api: "openai-responses",
    provider: "openai",
    model: "bdd-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: userNote === undefined ? 1 : 2,
  });
  return {
    cliAgentType,
    cliAgentSessionId: threadId,
    sessionHistory: session.toJsonl(),
  };
}

async function expectAgentTokenThreadOwnershipBoundaries(args: {
  readonly agentId: string;
  readonly orgId: string;
  readonly sourceToken: string;
}): Promise<void> {
  const crossUser = bdd.user({ orgId: args.orgId });
  const crossUserThread = await chat.createThread(crossUser, {
    agentId: args.agentId,
  });
  const crossUserSend = await requestSendEventWithBearer(
    args.sourceToken,
    {
      agentId: args.agentId,
      threadId: crossUserThread.id,
      prompt: "reject cross-user delegated memory admission",
    },
    [404],
  );
  expect(crossUserSend.status).toBe(404);

  const crossOrg = await entitledChatActor();
  const crossOrgThread = await chat.createThread(crossOrg.actor, {
    agentId: crossOrg.agentId,
  });
  const crossOrgSend = await requestSendEventWithBearer(
    args.sourceToken,
    {
      agentId: crossOrg.agentId,
      threadId: crossOrgThread.id,
      prompt: "reject cross-org delegated memory admission",
    },
    [404],
  );
  expect(crossOrgSend.status).toBe(404);

  const unownedThreadSend = await requestSendEventWithBearer(
    args.sourceToken,
    {
      agentId: args.agentId,
      threadId: randomUUID(),
      prompt: "reject unowned-thread delegated memory admission",
    },
    [404],
  );
  expect(unownedThreadSend.status).toBe(404);
}

async function expectAgentChatProvenance(args: {
  readonly actor: ApiTestUser;
  readonly agentId: string;
  readonly delegatedEventId: string;
  readonly delegatedRunId: string;
  readonly orgId: string;
  readonly source: { readonly runId: string; readonly threadId: string };
  readonly targetThreadId: string;
}): Promise<void> {
  const delegatedState = await runStateStore.set(
    readAgentRunState$,
    {
      orgId: args.orgId,
      userId: args.actor.userId,
      runId: args.delegatedRunId,
    },
    context.signal,
  );
  expect(delegatedState.agent_run).toMatchObject({ triggerSource: "agent" });
  const delegatedMessages = await waitForThreadMessages(
    args.actor,
    args.targetThreadId,
    (events) => {
      return userMessages(events).some((event) => {
        return event.id === args.delegatedEventId;
      });
    },
  );
  const delegatedInput = userMessages(delegatedMessages.events).find(
    (event): event is PromptMessage => {
      return (
        event.eventType === "input.prompt" && event.id === args.delegatedEventId
      );
    },
  );
  expect(delegatedInput?.userMessage.parts).toContainEqual({
    type: "source",
    kind: "agent",
    runId: args.source.runId,
    threadId: args.source.threadId,
    agentId: args.agentId,
    titleSnapshot: "New thread",
    href: `/chats/${args.source.threadId}#run-${args.source.runId}`,
  });
}

async function uploadLaunchMemoryNote(
  runId: string,
  claimed: Awaited<ReturnType<typeof claimChatRun>>,
  mount: { readonly storageId: string; readonly versionId: string },
  objects: Map<string, Buffer>,
  content: string,
): Promise<string> {
  const path = "extensions/ad_hoc/notes/launch-overlap.md";
  const files = [storageTextFile(path, content)];
  const prepared = await webhooks.requestAgentStoragePrepare(
    {
      runId,
      storageId: mount.storageId,
      parentVersionId: mount.versionId,
      files,
    },
    claimed.sandboxHeaders,
    [200],
  );
  if (prepared.status !== 200 || !prepared.body.uploads) {
    throw new Error("Expected a new sandbox memory upload");
  }
  const bytes = Buffer.from(content);
  const header = Buffer.alloc(512);
  new Header({ path, size: bytes.length, type: "File", mode: 0o644 }).encode(
    header,
  );
  const archive = gzipSync(
    Buffer.concat([
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  objects.set(`${bucket}/${prepared.body.uploads.archive.key}`, archive);
  objects.set(
    `${bucket}/${prepared.body.uploads.manifest.key}`,
    Buffer.from(JSON.stringify({ files })),
  );
  await webhooks.requestAgentStorageCommit(
    {
      runId,
      storageId: mount.storageId,
      parentVersionId: mount.versionId,
      versionId: prepared.body.versionId,
      files,
    },
    claimed.sandboxHeaders,
    [200],
  );
  return prepared.body.versionId;
}

describe("CHAT-02: model-first provider policies", () => {
  it("pins recall-enabled Pi memory through API completion and Sandbox handoff", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const frozenSummary =
      "# Pi memory summary\n\nUse the exact pinned version for this session.";
    const initialMemory = await commitMemoryVersion(context, actor, [
      {
        path: "MEMORY.md",
        content: "Pi memory version pinned before the API-first completion.",
      },
      { path: "memory_summary.md", content: frozenSummary },
    ]);
    await seedReadyMemorySummaryProjection(
      context,
      actor,
      initialMemory,
      frozenSummary,
    );
    const usagePricingResolution = await createGptUsagePricingResolution();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    let modelCalls = 0;
    const modelRequestBodies: string[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        modelCalls += 1;
        modelRequestBodies.push(await request.text());
        return new HttpResponse(
          modelCalls === 1
            ? piResponsesTextSse("API-first memory checkpoint", modelCalls)
            : piResponsesToolSse({
                callId: "call_pi_memory_handoff",
                name: "read",
                arguments: { path: "/home/user/workspace/AGENTS.md" },
                sequence: modelCalls,
              }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const first = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "complete through the Pi API-first slot",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(modelCalls).toBe(1);
    await expect(
      readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      }),
    ).resolves.toBeNull();
    const firstDeveloperPrompt = piResponsesDeveloperPrompt(
      modelRequestBodies[0],
    );
    expect(occurrences(firstDeveloperPrompt, frozenSummary)).toBe(1);
    expect(firstDeveloperPrompt).toContain(
      `${PI_MEMORY_ROOT}/memory_summary.md`,
    );

    const newerMemory = await commitMemoryVersion(context, actor, [
      {
        path: "MEMORY.md",
        content: "A newer HEAD must not replace the session-pinned version.",
      },
    ]);
    expect(newerMemory.versionId).not.toBe(initialMemory.versionId);

    const second = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "handoff with the pinned Pi memory mount",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${second.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(manifestKey);
      })
      .toBe(true);
    expect(modelCalls).toBe(2);
    expect(
      occurrences(
        piResponsesDeveloperPrompt(modelRequestBodies[1]),
        frozenSummary,
      ),
    ).toBe(1);
    const manifestBytes = checkpointObjects.get(manifestKey);
    if (!manifestBytes) {
      throw new Error("Expected the Pi memory ownership-transfer manifest");
    }
    expect(
      piApiFirstTurnManifestSchema.parse(
        JSON.parse(manifestBytes.toString("utf8")),
      ),
    ).toMatchObject({
      outcome: "ownership-transfer",
      mode: "pending-tool-continuation",
    });
    const claimed = await claimChatRun(runnerGroup, second.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    expect(claimed.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "ready",
        memoryStorageId: initialMemory.storageId,
        storageVersionId: initialMemory.versionId,
        content: frozenSummary,
        sourceHash: createHash("sha256").update(frozenSummary).digest("hex"),
        sourceSize: Buffer.byteLength(frozenSummary),
      },
    });
    expect(claimed.claim.appendSystemPrompt).not.toMatch(/auto.?memory/iu);
    const storageManifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    if (!storageManifest) {
      throw new Error("Expected recall-enabled Pi Storage mounts");
    }
    const memorySlotMounts = storageManifest.storageMounts.filter((mount) => {
      return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
    });
    expect(memorySlotMounts).toHaveLength(1);
    expect(memorySlotMounts[0]).toMatchObject({
      name: "memory",
      versionId: initialMemory.versionId,
      mountPath: PI_MEMORY_ROOT,
      missingRootPolicy: "preserveParentVersion",
      writeback: true,
      archiveUrl: expect.any(String),
    });
    expect(memorySlotMounts[0]).not.toHaveProperty("generatedBy");
    expect(storageManifest.storageMounts).not.toContainEqual(
      expect.objectContaining({
        mountPath: CANONICAL_CODEX_MEMORY_MOUNT_PATH,
      }),
    );

    await cancelChatRun(actor, second.runId, claimed.sandboxHeaders);
  }, 90_000);

  it.each(["archive", "session"] as const)(
    "overlaps Pi launch signing and archive URLs while joining the held %s branch",
    async (heldBranch) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await configureBuiltInPiModel(actor, "gpt-5.6-terra");
      await updateFeatureSwitchesForUser(
        context,
        {
          ...actor,
          orgId: requireOrgId(actor),
        },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.PiMemory]: true,
        },
      );
      await bdd.updateAgentInstructions(
        actor,
        agentId,
        `Launch overlap ${randomUUID()}`,
      );
      mockPiResourceArchiveDownloads();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const usagePricingResolution = await createGptUsagePricingResolution();
      let providerCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          providerCalls += 1;
          return new HttpResponse(
            piResponsesToolSse({
              callId: "call_launch_overlap",
              name: "read",
              arguments: { path: "/home/user/workspace/AGENTS.md" },
              sequence: 1,
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      await api.heartbeatRunner(runnerGroup);
      const archiveEntered = createDeferredPromise<void>(context.signal);
      const manifestEntered = createDeferredPromise<string>(context.signal);
      const sessionEntered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      const signedArchiveUrls = new Set<string>();
      context.mocks.s3.getSignedUrl.mockImplementation(
        async (_client, command) => {
          if (command instanceof GetObjectCommand) {
            const key = command.input.Key ?? "";
            if (key.endsWith("/archive.tar.gz")) {
              signedArchiveUrls.add(apiTestS3PresignedUrl(command));
              if (!archiveEntered.settled()) {
                archiveEntered.resolve(undefined);
              }
              if (heldBranch === "archive") {
                await release.promise;
              }
            }
            const manifest =
              /^pi-api-first-turn\/([^/]+)\/manifest.json$/u.exec(key);
            if (manifest?.[1] && !manifestEntered.settled()) {
              manifestEntered.resolve(manifest[1]);
            }
            if (
              key.startsWith("pi-api-first-turn/") &&
              key.endsWith("/session.jsonl")
            ) {
              if (!sessionEntered.settled()) {
                sessionEntered.resolve(undefined);
              }
              if (heldBranch === "session") {
                await release.promise;
              }
            }
          }
          return apiTestS3PresignedUrl(command);
        },
      );
      const sending = sendChatRun(
        actor,
        {
          agentId,
          prompt: "prepare a complete Pi launch",
          model: "gpt-5.6-terra",
        },
        usagePricingResolution,
      );
      const [runId] = await Promise.all([
        manifestEntered.promise,
        archiveEntered.promise,
        sessionEntered.promise,
      ]);
      const capturedArchiveUrls = new Set(signedArchiveUrls);
      // The production read and Runner poll surfaces must expose no partial run.
      await api.requestReadRun(actor, runId, [404]);
      expect((await api.pollRunner(runnerGroup)).body.job).toBeNull();
      expect(providerCalls).toBe(0);
      // Publish a new instruction HEAD after capture. This attempt must still
      // launch the version whose archive signature is already in progress.
      if (heldBranch === "archive") {
        await bdd.updateAgentInstructions(
          actor,
          agentId,
          `Later HEAD ${randomUUID()}`,
        );
      }
      release.resolve(undefined);
      const run = await sending;
      expect(run.runId).toBe(runId);
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${runId}/manifest.json`;
      await expect
        .poll(() => {
          return checkpointObjects.has(manifestKey);
        })
        .toBe(true);
      expect(providerCalls).toBe(1);
      const claimed = await claimChatRun(runnerGroup, runId);
      const mounts = expectCanonicalStorageManifest(
        claimed.claim.storageManifest,
      )?.storageMounts;
      expect(mounts).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "memory",
            mountPath: PI_MEMORY_ROOT,
            writeback: true,
            empty: true,
          }),
          expect.objectContaining({
            mountPath: PI_AGENT_DIR,
            instructionsTargetFilename: "AGENTS.md",
            archiveUrl: expect.any(String),
          }),
        ]),
      );
      expect(
        mounts?.every((mount) => {
          return mount.empty === true || Boolean(mount.archiveUrl);
        }),
      ).toBeTruthy();
      expect(capturedArchiveUrls).toContain(
        mounts?.find((mount) => {
          return mount.instructionsTargetFilename === "AGENTS.md";
        })?.archiveUrl,
      );
      expect(claimed.claim.piLaunchConfig).toMatchObject({
        apiFirstTurn: {
          manifestUrl: expect.any(String),
          sessionUrl: expect.any(String),
          resourceSnapshotDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          baseSession: { sessionId: run.threadId, sha256: null },
        },
        memoryRecall: { status: "no-content" },
      });
      await cancelChatRun(actor, runId, claimed.sandboxHeaders);
    },
    90_000,
  );

  it.each(["error", "context", "storage", "abort"] as const)(
    "joins archive signing after an early Pi signing %s without publishing a launch",
    async (outcome) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await configureBuiltInPiModel(actor, "gpt-5.6-terra");
      await updateFeatureSwitchesForUser(
        context,
        {
          ...actor,
          orgId: requireOrgId(actor),
        },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      await bdd.updateAgentInstructions(
        actor,
        agentId,
        `Failed overlap ${randomUUID()}`,
      );
      const release = createDeferredPromise<void>(context.signal);
      const archiveEntered = createDeferredPromise<void>(context.signal);
      const piFailed = createDeferredPromise<string>(context.signal);
      if (outcome === "context" || outcome === "storage") {
        useSecretKmsProbe(async () => {
          await piFailed.promise;
          throw new Error("Context encryption failed");
        });
      }
      const controller = new AbortController();
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
        controller.abort();
      });
      context.mocks.s3.getSignedUrl.mockImplementation(
        async (_client, command) => {
          if (command instanceof GetObjectCommand) {
            const key = command.input.Key ?? "";
            if (key.endsWith("/archive.tar.gz")) {
              if (!archiveEntered.settled()) {
                archiveEntered.resolve(undefined);
              }
              await release.promise;
              if (outcome === "storage") {
                throw new Error("Archive signing failed");
              }
            }
            const manifest =
              /^pi-api-first-turn\/([^/]+)\/manifest.json$/u.exec(key);
            if (manifest?.[1]) {
              piFailed.resolve(manifest[1]);
              if (outcome === "abort") {
                controller.abort();
              }
              throw new Error("Pi manifest signing failed");
            }
          }
          return apiTestS3PresignedUrl(command);
        },
      );
      let returned = false;
      const sending = chat
        .requestSendEvent(
          actor,
          {
            agentId,
            prompt: "fail an owned launch preparation",
            model: "gpt-5.6-terra",
            clientEventId: randomUUID(),
          },
          [201],
          {},
          controller.signal,
        )
        .finally(() => {
          returned = true;
        });
      const completion = Promise.allSettled([sending]);
      const [runId] = await Promise.all([
        piFailed.promise,
        archiveEntered.promise,
      ]);
      await api.requestReadRun(actor, runId, [404]);
      expect((await api.pollRunner(runnerGroup)).body.job).toBeNull();
      expect(returned).toBeFalsy();
      release.resolve(undefined);
      const [result] = await completion;
      if (outcome === "abort") {
        expect(result).toMatchObject({
          status: "rejected",
          reason: new Error(
            "Unknown response status 500 for POST /api/chat/events",
          ),
        });
        await api.requestReadRun(actor, runId, [404]);
      } else {
        expect(result.status).toBe("fulfilled");
        await expect(api.readRun(actor, runId)).resolves.toMatchObject({
          status: "failed",
          error:
            outcome === "storage"
              ? "Archive signing failed"
              : outcome === "context"
                ? "Context encryption failed"
                : "Pi manifest signing failed",
        });
        await api.requestClaimRunnerJob(true, runId, [404]);
      }
      expect((await api.pollRunner(runnerGroup)).body.job).toBeNull();
    },
    90_000,
  );

  it("pins canonical session writeback before archive materialization when HEAD advances", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      {
        ...actor,
        orgId: requireOrgId(actor),
      },
      {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const objects = mockPiCheckpointObjectStore();
    const originalSend = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation((command) => {
      if (command instanceof HeadObjectCommand) {
        const bytes = objects.get(
          `${command.input.Bucket}/${command.input.Key}`,
        );
        if (bytes) {
          return Promise.resolve({ ContentLength: bytes.length });
        }
      }
      if (!originalSend) {
        throw new Error("Expected the external object store");
      }
      return originalSend(command);
    });
    const pricing = await createGptUsagePricingResolution();
    let providerCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        providerCalls += 1;
        return new HttpResponse(
          piResponsesToolSse({
            callId: `call_canonical_launch_${providerCalls}`,
            name: "read",
            arguments: { path: "/home/user/workspace/AGENTS.md" },
            sequence: providerCalls,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const seed = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "seed a nonempty memory version",
        model: "gpt-5.6-terra",
      },
      pricing,
    );
    await expect
      .poll(() => {
        return objects.has(
          `${bucket}/pi-api-first-turn/${seed.runId}/manifest.json`,
        );
      })
      .toBe(true);
    const seedClaim = await claimChatRun(runnerGroup, seed.runId);
    const seedMemory = expectCanonicalStorageManifest(
      seedClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory";
    });
    if (!seedMemory) {
      throw new Error("Expected seed memory");
    }
    const version = await uploadLaunchMemoryNote(
      seed.runId,
      seedClaim,
      seedMemory,
      objects,
      "pinned note",
    );
    await cancelChatRun(actor, seed.runId, seedClaim.sandboxHeaders);
    // Pi continuation pins the previous launch version, including when the
    // checkpoint publishes a different HEAD. Establish a nonempty launch first.
    const first = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "establish canonical Pi writeback",
        model: "gpt-5.6-terra",
      },
      pricing,
    );
    await expect
      .poll(() => {
        return objects.has(
          `${bucket}/pi-api-first-turn/${first.runId}/manifest.json`,
        );
      })
      .toBe(true);
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    const memory = expectCanonicalStorageManifest(
      firstClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory";
    });
    if (!memory) {
      throw new Error("Expected canonical Pi memory");
    }
    expect(memory.versionId).toBe(version);
    const completion = frameworkMatchingCompletionOptions(first.threadId, "pi");
    if (!completion.sessionHistory) {
      throw new Error("Expected native checkpoint history");
    }
    const history = completion.sessionHistory;
    const historyHash = createHash("sha256").update(history).digest("hex");
    await webhooks.requestAgentCheckpointPrepareHistory(
      {
        runId: first.runId,
        hash: historyHash,
        rawSize: Buffer.byteLength(history),
        encodedSize: Buffer.byteLength(history),
        encoding: "identity",
      },
      firstClaim.sandboxHeaders,
      [200],
    );
    objects.set(`${bucket}/blobs/${historyHash}.blob`, Buffer.from(history));
    await webhooks.requestAgentComplete(
      {
        runId: first.runId,
        exitCode: 0,
        checkpoint: {
          cliAgentType: "pi",
          cliAgentSessionId: first.threadId,
          cliAgentSessionHistoryHash: historyHash,
          artifactSnapshots: [
            {
              name: memory.name,
              version,
              mountPath: memory.mountPath,
              missingRootPolicy: memory.missingRootPolicy,
            },
          ],
        },
      },
      firstClaim.sandboxHeaders,
      [200],
      undefined,
      pricing,
    );
    await waitForRunStatus(actor, first.runId, "completed");

    // A separate active run can legitimately publish a newer memory HEAD.
    const writer = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "own a concurrent memory write",
        model: "gpt-5.6-terra",
      },
      pricing,
    );
    await expect
      .poll(() => {
        return objects.has(
          `${bucket}/pi-api-first-turn/${writer.runId}/manifest.json`,
        );
      })
      .toBe(true);
    const writerClaim = await claimChatRun(runnerGroup, writer.runId);
    const writerMemory = expectCanonicalStorageManifest(
      writerClaim.claim.storageManifest,
    )?.storageMounts.find((mount) => {
      return mount.name === "memory";
    });
    if (!writerMemory) {
      throw new Error("Expected the writer's memory mount");
    }
    expect(writerMemory.versionId).toBe(version);
    // Unique instructions force this attempt through the real signing boundary
    // even when shared skill and memory URL cache entries are already warm.
    await bdd.updateAgentInstructions(
      actor,
      agentId,
      `Canonical overlap ${randomUUID()}`,
    );
    const archiveEntered = createDeferredPromise<void>(context.signal);
    const piEntered = createDeferredPromise<string>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    context.mocks.s3.getSignedUrl.mockImplementation(
      async (_client, command) => {
        if (command instanceof GetObjectCommand) {
          const key = command.input.Key ?? "";
          if (key.endsWith("/archive.tar.gz")) {
            if (!archiveEntered.settled()) {
              archiveEntered.resolve(undefined);
            }
            await release.promise;
          }
          const manifest = /^pi-api-first-turn\/([^/]+)\/manifest.json$/u.exec(
            key,
          );
          if (manifest?.[1] && !piEntered.settled()) {
            piEntered.resolve(manifest[1]);
          }
        }
        return apiTestS3PresignedUrl(command);
      },
    );
    const callsBeforeResume = providerCalls;
    const sending = sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "resume the frozen canonical memory",
        model: "gpt-5.6-terra",
      },
      pricing,
    );
    const [runId] = await Promise.all([
      piEntered.promise,
      archiveEntered.promise,
    ]);
    await api.requestReadRun(actor, runId, [404]);
    expect(providerCalls).toBe(callsBeforeResume);
    const newerVersion = await uploadLaunchMemoryNote(
      writer.runId,
      writerClaim,
      writerMemory,
      objects,
      "later note",
    );
    expect(newerVersion).not.toBe(version);
    release.resolve(undefined);
    const resumed = await sending;
    expect(resumed.runId).toBe(runId);
    await expect
      .poll(() => {
        return objects.has(
          `${bucket}/pi-api-first-turn/${runId}/manifest.json`,
        );
      })
      .toBe(true);
    const claimed = await claimChatRun(runnerGroup, runId);
    const mounts = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    )?.storageMounts;
    expect(
      mounts?.filter((mount) => {
        return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        storageId: memory.storageId,
        versionId: version,
        name: "memory",
        mountPath: PI_MEMORY_ROOT,
        writeback: true,
        missingRootPolicy: "preserveParentVersion",
        archiveUrl: expect.any(String),
      }),
    ]);
    expect(claimed.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "no-content",
        memoryStorageId: memory.storageId,
        storageVersionId: version,
      },
      apiFirstTurn: {
        baseSession: { sessionId: first.threadId, sha256: historyHash },
      },
    });
    await cancelChatRun(actor, runId, claimed.sandboxHeaders);
    await cancelChatRun(actor, writer.runId, writerClaim.sandboxHeaders);
  }, 90_000);

  it("keeps an empty recall-enabled Pi memory mount valid", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const orgId = requireOrgId(actor);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads(true);
    mockPiCheckpointObjectStore();
    await api.heartbeatRunner(runnerGroup);

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "launch Pi with an absent memory Storage",
      model: "gpt-5.6-terra",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const storageManifest = expectCanonicalStorageManifest(
      claimed.claim.storageManifest,
    );
    if (!storageManifest) {
      throw new Error("Expected empty recall-enabled Pi Storage mounts");
    }
    const memorySlotMounts = storageManifest.storageMounts.filter((mount) => {
      return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
    });
    expect(memorySlotMounts).toHaveLength(1);
    expect(memorySlotMounts[0]).toMatchObject({
      name: "memory",
      versionId: expect.any(String),
      mountPath: PI_MEMORY_ROOT,
      missingRootPolicy: "preserveParentVersion",
      writeback: true,
      empty: true,
    });
    expect(claimed.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "no-content",
        memoryStorageId: memorySlotMounts[0]?.storageId,
        storageVersionId: memorySlotMounts[0]?.versionId,
      },
    });
    expect(memorySlotMounts[0]).not.toHaveProperty("archiveUrl");
    expect(memorySlotMounts[0]).not.toHaveProperty("generatedBy");

    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("keeps a frozen projection miss no-content after the projection becomes ready", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const summary =
      "# Delayed summary\n\nOnly a new Pi session may capture this.";
    const memory = await commitMemoryVersion(context, actor, [
      { path: "memory_summary.md", content: summary },
    ]);
    const usagePricingResolution = await createGptUsagePricingResolution();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const requestBodies: string[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requestBodies.push(await request.text());
        return new HttpResponse(
          piResponsesToolSse({
            callId: `call_projection_epoch_${requestBodies.length}`,
            name: "read",
            arguments: { path: "/home/user/workspace/AGENTS.md" },
            sequence: requestBodies.length,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const frozenMiss = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "freeze the projection miss",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    const frozenMissManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${frozenMiss.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(frozenMissManifestKey);
      })
      .toBe(true);
    expect(piResponsesDeveloperPrompt(requestBodies[0])).not.toContain(summary);

    await seedReadyMemorySummaryProjection(context, actor, memory, summary);
    const frozenMissClaim = await claimChatRun(runnerGroup, frozenMiss.runId);
    expect(frozenMissClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "no-content",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
      },
    });

    const newSession = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture the now-ready projection in a new session",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    const newSessionManifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${newSession.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.has(newSessionManifestKey);
      })
      .toBe(true);
    expect(
      occurrences(piResponsesDeveloperPrompt(requestBodies[1]), summary),
    ).toBe(1);
    const newSessionClaim = await claimChatRun(runnerGroup, newSession.runId);
    expect(newSessionClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "ready",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
        content: summary,
      },
    });

    await Promise.all([
      cancelChatRun(actor, frozenMiss.runId, frozenMissClaim.sandboxHeaders),
      cancelChatRun(actor, newSession.runId, newSessionClaim.sandboxHeaders),
    ]);
  }, 90_000);

  it("injects no memory recall into a Pi launch while the owner's PiMemory is off", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const summary =
      "# Gated summary\n\nOnly an owner with PiMemory on may see this.";
    const memory = await commitMemoryVersion(context, actor, [
      { path: "memory_summary.md", content: summary },
    ]);
    await seedReadyMemorySummaryProjection(context, actor, memory, summary);
    const usagePricingResolution = await createGptUsagePricingResolution();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const requestBodies: string[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requestBodies.push(await request.text());
        return new HttpResponse(
          piResponsesToolSse({
            callId: `call_pi_memory_gate_${requestBodies.length}`,
            name: "read",
            arguments: { path: "/home/user/workspace/AGENTS.md" },
            sequence: requestBodies.length,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    async function launchPiRun(prompt: string) {
      const run = await sendChatRun(
        actor,
        { agentId, prompt, model: "gpt-5.6-terra" },
        usagePricingResolution,
      );
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
      await expect
        .poll(() => {
          return checkpointObjects.has(manifestKey);
        })
        .toBe(true);
      return run;
    }

    // Off: the ready projection is never read, and the mount stays pinned.
    const gated = await launchPiRun("launch Pi with PiMemory off");
    expect(piResponsesDeveloperPrompt(requestBodies[0])).not.toContain(summary);
    const gatedClaim = await claimChatRun(runnerGroup, gated.runId);
    expect(gatedClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "no-content",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
      },
    });
    expect(
      expectCanonicalStorageManifest(
        gatedClaim.claim.storageManifest,
      )?.storageMounts.filter((mount) => {
        return mount.name === "memory" || mount.mountPath === PI_MEMORY_ROOT;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        name: "memory",
        storageId: memory.storageId,
        versionId: memory.versionId,
        mountPath: PI_MEMORY_ROOT,
        writeback: true,
        archiveUrl: expect.any(String),
      }),
    ]);

    // On for this owner only: the same projection is recalled as before.
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiMemory]: true },
    );
    const enabled = await launchPiRun("launch Pi with PiMemory on");
    expect(
      occurrences(piResponsesDeveloperPrompt(requestBodies[1]), summary),
    ).toBe(1);
    const enabledClaim = await claimChatRun(runnerGroup, enabled.runId);
    expect(enabledClaim.claim.piLaunchConfig).toMatchObject({
      memoryRecall: {
        status: "ready",
        memoryStorageId: memory.storageId,
        storageVersionId: memory.versionId,
        content: summary,
      },
    });

    await Promise.all([
      cancelChatRun(actor, gated.runId, gatedClaim.sandboxHeaders),
      cancelChatRun(actor, enabled.runId, enabledClaim.sandboxHeaders),
    ]);
  }, 90_000);

  it("keeps completion scheduling-free and decodes historical snapshots in canonical admission", async () => {
    const rejectedSnapshots = [
      ["historical null", null],
      [
        "V1 Pi",
        { schemaVersion: 1, framework: "pi", runnerProfile: DEFAULT_PROFILE },
      ],
      [
        "V2 Pi disabled with PiLoop enabled",
        {
          schemaVersion: 2,
          framework: "pi",
          runnerProfile: DEFAULT_PROFILE,
          piMemoryGenerationEnabled: false,
        },
      ],
      ...(["codex", "claude-code"] as const).flatMap((framework) => {
        return [true, false].map((piMemoryGenerationEnabled) => {
          return [
            `V2 ${framework} ${piMemoryGenerationEnabled ? "enabled" : "disabled"}`,
            {
              schemaVersion: 2 as const,
              framework,
              runnerProfile: DEFAULT_PROFILE,
              piMemoryGenerationEnabled,
            },
          ] as const;
        });
      }),
      ...(["codex", "claude-code"] as const).map((framework) => {
        return [
          `V3 ${framework}`,
          {
            schemaVersion: 3 as const,
            framework,
            runnerProfile: DEFAULT_PROFILE,
          },
        ] as const;
      }),
    ] as const;
    const admittedSnapshots = [
      [
        "V2 Pi enabled",
        {
          schemaVersion: 2,
          framework: "pi",
          runnerProfile: DEFAULT_PROFILE,
          piMemoryGenerationEnabled: true,
        },
      ],
      [
        "V3 Pi",
        { schemaVersion: 3, framework: "pi", runnerProfile: DEFAULT_PROFILE },
      ],
    ] as const;

    for (const [name, snapshot] of rejectedSnapshots) {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const run = await sendChatRun(actor, {
        agentId,
        prompt: `decode ${name} through the completion webhook`,
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      // Decode historical carriers with the current cohort enabled at completion.
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.PiMemory]: true,
        },
      );
      await setRunLaunchSnapshotFixture(run.runId, snapshot);
      const completionOptions = frameworkMatchingCompletionOptions(
        run.threadId,
        snapshot?.framework ?? "claude-code",
      );
      await completeChatRunOk(
        run.runId,
        claimed.sandboxHeaders,
        completionOptions,
      );
      await flushWaitUntilForTest();
      const candidate = await readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      });
      expect({ name, candidate }).toStrictEqual({ name, candidate: null });
    }

    for (const [name, snapshot] of admittedSnapshots) {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const run = await sendChatRun(actor, {
        agentId,
        prompt: `decode ${name} through the completion webhook`,
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      // Decode historical carriers with the current cohort enabled at completion.
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId },
        {
          [FeatureSwitchKey.PiLoop]: true,
          [FeatureSwitchKey.PiMemory]: true,
        },
      );
      await setRunLaunchSnapshotFixture(run.runId, snapshot);
      const completionOptions = frameworkMatchingCompletionOptions(
        run.threadId,
        snapshot.framework,
      );
      await completeChatRunOk(
        run.runId,
        claimed.sandboxHeaders,
        completionOptions,
      );
      await flushWaitUntilForTest();
      await expect(
        readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
      ).resolves.toBeNull();
      await readmitPiMemoryStage1CandidateFixture(run.runId);
      const candidate = await readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      });
      if (!candidate) {
        throw new Error(`Expected ${name} to create a Stage 1 candidate`);
      }
      const expectedHistoryHash = createHash("sha256")
        .update(
          completionOptions.sessionHistory ??
            `bdd chat session history ${run.runId}`,
        )
        .digest("hex");
      expect({
        name,
        sourceRunId: candidate.sourceRunId,
        sourceHistoryHash: candidate.sourceHistoryHash,
        eligibilityDelayMs:
          candidate.eligibleAt.getTime() -
          candidate.sourceCompletedAt.getTime(),
      }).toStrictEqual({
        name,
        sourceRunId: run.runId,
        sourceHistoryHash: expectedHistoryHash,
        eligibilityDelayMs: 0,
      });

      await completeChatRunOk(
        run.runId,
        claimed.sandboxHeaders,
        completionOptions,
      );
      await flushWaitUntilForTest();
      const repeatedCandidate = await readPiMemoryStage1CandidateFixture({
        orgId,
        userId: actor.userId,
      });
      expect({
        name,
        sourceRunId: repeatedCandidate?.sourceRunId,
        sourceHistoryHash: repeatedCandidate?.sourceHistoryHash,
      }).toStrictEqual({
        name,
        sourceRunId: run.runId,
        sourceHistoryHash: candidate.sourceHistoryHash,
      });
    }
  }, 90_000);

  it("keeps failed and synthetic completions out of shared Pi learning", async () => {
    const cases = [
      ["failed status", {}, true],
      ["synthetic run", { triggerSource: "test" as const }, false],
    ] as const;
    for (const [name, inputs, fails] of cases) {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const orgId = requireOrgId(actor);
      const run = await sendChatRun(actor, {
        agentId,
        prompt: `preserve ${name} completion exclusion`,
        model: "claude-sonnet-5",
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      await setRunLaunchSnapshotFixture(run.runId, {
        schemaVersion: 3,
        framework: "pi",
        runnerProfile: DEFAULT_PROFILE,
      });
      await setRunPiMemoryAdmissionInputsFixture(run.runId, inputs);
      if (fails) {
        await failChatRun(
          run.runId,
          claimed.sandboxHeaders,
          "expected failure",
        );
      } else {
        await completeChatRunOk(
          run.runId,
          claimed.sandboxHeaders,
          frameworkMatchingCompletionOptions(run.threadId, "pi"),
        );
      }
      await flushWaitUntilForTest();
      await expect(
        readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
      ).resolves.toBeNull();
    }
  }, 90_000);

  it("leaves completion scheduling-free while canonical admission honors PiMemory", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    const scope = { orgId, userId: actor.userId };
    async function completePiRun(threadId: string | undefined, note: string) {
      const run = await sendChatRun(actor, {
        agentId,
        ...(threadId === undefined ? {} : { threadId }),
        prompt: note,
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      await setRunLaunchSnapshotFixture(run.runId, {
        schemaVersion: 3,
        framework: "pi",
        runnerProfile: DEFAULT_PROFILE,
      });
      const completionOptions = frameworkMatchingCompletionOptions(
        run.threadId,
        "pi",
        note,
      );
      if (completionOptions.sessionHistory === undefined) {
        throw new Error("Expected a settled Pi session history");
      }
      await completeChatRunOk(
        run.runId,
        claimed.sandboxHeaders,
        completionOptions,
      );
      await flushWaitUntilForTest();
      return {
        ...run,
        sourceHistoryHash: createHash("sha256")
          .update(completionOptions.sessionHistory)
          .digest("hex"),
      };
    }

    // Off for everyone by default: no candidate is written, and readmitting
    // the same completed Run stays skipped before any write.
    const off = await completePiRun(undefined, "complete Pi with PiMemory off");
    await expect(readPiMemoryStage1CandidateFixture(scope)).resolves.toBeNull();
    await expect(
      readmitPiMemoryStage1CandidateFixture(off.runId),
    ).resolves.toStrictEqual({
      outcome: "skipped",
      reason: "pi_memory_disabled",
    });
    await expect(readPiMemoryStage1CandidateFixture(scope)).resolves.toBeNull();

    // Completion remains scheduling-free; explicitly exercise the canonical writer.
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiMemory]: true },
    );
    const on = await completePiRun(
      off.threadId,
      "complete Pi with PiMemory on",
    );
    await expect(readPiMemoryStage1CandidateFixture(scope)).resolves.toBeNull();
    await readmitPiMemoryStage1CandidateFixture(on.runId);
    const admitted = await readPiMemoryStage1CandidateFixture(scope);
    if (!admitted) {
      throw new Error("Expected the enabled owner's completion to be admitted");
    }
    expect(admitted).toMatchObject({
      memoryStorageName: "memory",
      piSessionId: off.threadId,
      sourceRunId: on.runId,
      sourceHistoryHash: on.sourceHistoryHash,
      status: "pending",
    });
    expect(
      admitted.eligibleAt.getTime() - admitted.sourceCompletedAt.getTime(),
    ).toBe(0);
    await expect(
      readmitPiMemoryStage1CandidateFixture(on.runId),
    ).resolves.toMatchObject({ outcome: "exact_retry" });

    // Turning the override off again replaces nothing, even for a newer
    // exact history of the same session.
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiMemory]: false },
    );
    const offAgain = await completePiRun(
      off.threadId,
      "complete Pi after PiMemory turned off again",
    );
    expect(offAgain.sourceHistoryHash).not.toBe(on.sourceHistoryHash);
    await expect(
      readmitPiMemoryStage1CandidateFixture(offAgain.runId),
    ).resolves.toStrictEqual({
      outcome: "skipped",
      reason: "pi_memory_disabled",
    });
    await expect(
      readPiMemoryStage1CandidateFixture(scope),
    ).resolves.toMatchObject({
      sourceRunId: on.runId,
      sourceHistoryHash: on.sourceHistoryHash,
      status: "pending",
      updatedAt: admitted.updatedAt,
    });
  }, 90_000);

  it("keeps an agent-authenticated same-owner Pi history out of memory", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await bdd.updateAgentMetadata(actor, agentId, { visibility: "public" });
    const source = await sendChatRun(actor, {
      agentId,
      prompt: "delegate a non-interactive Pi turn",
      model: "claude-sonnet-5",
    });
    const sourceClaim = await claimChatRun(runnerGroup, source.runId);
    const sourceToken = okouTokenFromClaim(sourceClaim.claim);
    const targetThread = await chat.createThread(actor, { agentId });

    const usagePricingResolution = await createGptUsagePricingResolution();

    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        return new HttpResponse(
          piResponsesTextSse("delegated memory admission answer", 0, {
            input_tokens: 10,
            output_tokens: 3,
            total_tokens: 13,
            input_tokens_details: {
              cached_tokens: 3,
              cache_write_tokens: 2,
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const delegatedEventId = randomUUID();
    const delegated = await requestSendEventWithBearer(
      sourceToken,
      {
        agentId,
        clientEventId: delegatedEventId,
        threadId: targetThread.id,
        prompt: "learn this stable preference from delegated work",
        model: "gpt-5.6-terra",
      },
      [201],
      usagePricingResolution,
    );
    expect(delegated.status).toBe(201);
    if (delegated.status !== 201 || delegated.body.runId === null) {
      throw new Error("Expected the delegated Pi prompt to launch a run");
    }
    const delegatedRunId = delegated.body.runId;
    await waitForRunStatus(actor, delegatedRunId, "completed", 10_000);
    await flushWaitUntilForTest();
    await expectAgentChatProvenance({
      actor,
      agentId,
      delegatedEventId,
      delegatedRunId,
      orgId,
      source,
      targetThreadId: targetThread.id,
    });
    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toBeNull();
    await expect(
      readmitPiMemoryStage1CandidateFixture(delegatedRunId),
    ).resolves.toStrictEqual({
      outcome: "skipped",
      reason: "non_interactive_source",
    });
    await expectAgentTokenThreadOwnershipBoundaries({
      agentId,
      orgId,
      sourceToken,
    });

    await cancelChatRun(actor, source.runId, sourceClaim.sandboxHeaders);
  }, 90_000);

  it("keeps Pi checkpoints intact without completion admission and fences canonical writes", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    expect(piMemoryStage1AdmissionPrerequisiteSkipReasonFixture()).toBeNull();
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        status: "failed",
      }),
    ).toBe("not_completed");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        framework: "codex",
      }),
    ).toBe("not_pi");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        generationEnabled: false,
      }),
    ).toBe("generation_disabled");
    // Every interactive source must still own a Chat Thread. The actual
    // threadless Phase 2 maintenance route is covered by the boundary test.
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        chatThreadId: null,
      }),
    ).toBe("missing_chat_thread");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: "web",
      }),
    ).toBeNull();
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: "web",
        chatThreadId: null,
      }),
    ).toBe("missing_chat_thread");
    // A non-interactive source is reported as such before the Chat Thread
    // check: the threadless Phase 2 maintenance run and a thread-bound
    // Automation run both skip for their real reason.
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: "agent",
        chatThreadId: null,
      }),
    ).toBe("non_interactive_source");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: "automation-schedule",
      }),
    ).toBe("non_interactive_source");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: null,
      }),
    ).toBe("invalid_source");
    expect(
      piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({
        triggerSource: "unknown",
      }),
    ).toBe("invalid_source");
    // Every trigger source is classified explicitly: only human-interactive
    // surfaces proceed to memory extraction (EPIC #33892 Decisions 2 and 3).
    const prerequisiteByTriggerSource = {
      web: null,
      slack: null,
      teams: null,
      feishu: null,
      email: null,
      telegram: null,
      agentphone: null,
      github: null,
      test: "synthetic_source",
      agent: "non_interactive_source",
      webhook: "non_interactive_source",
      "automation-schedule": "non_interactive_source",
      "automation-event": "non_interactive_source",
      goal: "non_interactive_source",
    } as const satisfies Record<
      TriggerSource,
      ReturnType<typeof piMemoryStage1AdmissionPrerequisiteSkipReasonFixture>
    >;
    for (const triggerSource of triggerSourceSchema.options) {
      expect(
        piMemoryStage1AdmissionPrerequisiteSkipReasonFixture({ triggerSource }),
      ).toBe(prerequisiteByTriggerSource[triggerSource]);
    }
    const usagePricingResolution = await createGptUsagePricingResolution();

    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
        [FeatureSwitchKey.PiMemory]: true,
      },
    );
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const answers = [
      "first memory admission answer",
      "replacement memory admission answer",
      "selection watermark replacement answer",
      "generation-disabled answer",
    ] as const;
    let modelCalls = 0;
    const firstProviderEntered = createDeferredPromise<void>(context.signal);
    const releaseFirstProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseFirstProvider.settled()) {
        releaseFirstProvider.resolve(undefined);
      }
    });
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        const answer = answers[modelCalls];
        if (!answer) {
          return HttpResponse.json(
            { error: "unexpected duplicate Pi memory model request" },
            { status: 500 },
          );
        }
        if (modelCalls === 0) {
          firstProviderEntered.resolve(undefined);
          await releaseFirstProvider.promise;
        }
        const response = new HttpResponse(
          piResponsesTextSse(answer, modelCalls, {
            input_tokens: 10,
            output_tokens: 3,
            total_tokens: 13,
            input_tokens_details: {
              cached_tokens: 3,
              cache_write_tokens: 2,
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
        modelCalls += 1;
        return response;
      }),
    );

    const first = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture memory generation at launch",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    await firstProviderEntered.promise;
    await expect(
      readPiMemoryStage1DayFixture(actor.userId),
    ).resolves.toMatchObject({
      triggerThreadId: first.threadId,
      day: nowDate().toISOString().slice(0, 10),
      consumedAt: null,
    });

    await expect(
      readRunLaunchSnapshotFixture(context, first.runId),
    ).resolves.toMatchObject({
      launch_snapshot: {
        schemaVersion: 3,
        framework: "pi",
      },
    });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
      },
    );
    releaseFirstProvider.resolve(undefined);
    await waitForRunStatus(actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    await expect(
      readRunLaunchSnapshotFixture(context, first.runId),
    ).resolves.toMatchObject({
      launch_snapshot: {
        schemaVersion: 3,
        framework: "pi",
      },
    });

    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toBeNull();
    await readmitPiMemoryStage1CandidateFixture(first.runId);
    const firstConversation = await readPiConversationIdentityFixture(
      first.runId,
    );
    const firstCandidate = await readPiMemoryStage1CandidateFixture({
      orgId,
      userId: actor.userId,
    });
    if (!firstCandidate) {
      throw new Error("Expected first Pi memory candidate");
    }
    expect(firstCandidate).toMatchObject({
      memoryStorageName: "memory",
      piSessionId: firstConversation.piSessionId,
      sourceRunId: first.runId,
      sourceHistoryHash: firstConversation.sourceHistoryHash,
      status: "pending",
      retryCount: 0,
      usageCount: 0,
    });
    expect(firstCandidate.memoryStorageS3Prefix).toBe(
      `${orgId}/${firstCandidate.memoryStorageId}`,
    );
    expect(
      firstCandidate.eligibleAt.getTime() -
        firstCandidate.sourceCompletedAt.getTime(),
    ).toBe(0);
    await expect(
      readSessionHistoryBlobRefCountFixture(firstCandidate.sourceHistoryHash),
    ).resolves.toBe(2);

    const staleLeaseToken = randomUUID();
    await leasePiMemoryStage1CandidateFixture({
      memoryStorageId: firstCandidate.memoryStorageId,
      piSessionId: firstCandidate.piSessionId,
      sourceHistoryHash: firstCandidate.sourceHistoryHash,
      leaseToken: staleLeaseToken,
      leaseExpiresAt: new Date(now() + 60_000),
    });
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      {
        [FeatureSwitchKey.PiLoop]: true,
      },
    );
    const second = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "replace the leased candidate with a newer exact history",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, second.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toMatchObject({ sourceRunId: first.runId });
    await readmitPiMemoryStage1CandidateFixture(second.runId);
    const secondConversation = await readPiConversationIdentityFixture(
      second.runId,
    );
    const replacedCandidate = await readPiMemoryStage1CandidateFixture({
      orgId,
      userId: actor.userId,
    });
    if (!replacedCandidate) {
      throw new Error("Expected replacement Pi memory candidate");
    }
    expect(replacedCandidate).toMatchObject({
      memoryStorageId: firstCandidate.memoryStorageId,
      piSessionId: firstCandidate.piSessionId,
      sourceRunId: second.runId,
      sourceHistoryHash: secondConversation.sourceHistoryHash,
      status: "pending",
      leaseToken: null,
      leaseExpiresAt: null,
      retryCount: 0,
      rawMemory: null,
      rolloutSummary: null,
      generatedAt: null,
      usageCount: 0,
    });
    expect(replacedCandidate.sourceHistoryHash).not.toBe(
      firstCandidate.sourceHistoryHash,
    );
    await expect(
      readSessionHistoryBlobRefCountFixture(firstCandidate.sourceHistoryHash),
    ).resolves.toBe(1);
    await expect(
      readSessionHistoryBlobRefCountFixture(
        replacedCandidate.sourceHistoryHash,
      ),
    ).resolves.toBe(2);

    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: firstCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: firstCandidate.piSessionId,
        sourceHistoryHash: firstCandidate.sourceHistoryHash,
        leaseToken: staleLeaseToken,
        committedAt: nowDate(),
        result: { kind: "succeeded_no_output" },
      }),
    ).resolves.toBeFalsy();
    await expect(
      readmitPiMemoryStage1CandidateFixture(second.runId),
    ).resolves.toMatchObject({ outcome: "exact_retry" });
    const afterExactRetry = await readPiMemoryStage1CandidateFixture({
      orgId,
      userId: actor.userId,
    });
    expect(afterExactRetry?.updatedAt).toStrictEqual(
      replacedCandidate.updatedAt,
    );

    const currentLeaseToken = randomUUID();
    const currentLeaseExpiresAt = new Date(now() + 60_000);
    await leasePiMemoryStage1CandidateFixture({
      memoryStorageId: replacedCandidate.memoryStorageId,
      piSessionId: replacedCandidate.piSessionId,
      sourceHistoryHash: replacedCandidate.sourceHistoryHash,
      leaseToken: currentLeaseToken,
      leaseExpiresAt: currentLeaseExpiresAt,
    });
    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: replacedCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: replacedCandidate.piSessionId,
        sourceHistoryHash: replacedCandidate.sourceHistoryHash,
        leaseToken: currentLeaseToken,
        committedAt: currentLeaseExpiresAt,
        result: { kind: "succeeded_no_output" },
      }),
    ).resolves.toBeFalsy();
    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: replacedCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: replacedCandidate.piSessionId,
        sourceHistoryHash: replacedCandidate.sourceHistoryHash,
        leaseToken: currentLeaseToken,
        committedAt: nowDate(),
        result: { kind: "succeeded_no_output" },
      }),
    ).resolves.toBeTruthy();
    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toMatchObject({
      status: "succeeded_no_output",
      rawMemory: null,
      rolloutSummary: null,
      lastSelectedSourceHistoryHash: null,
    });

    await setSyntheticPiMemoryStage1SelectionFixture({
      memoryStorageId: replacedCandidate.memoryStorageId,
      piSessionId: replacedCandidate.piSessionId,
      sourceHistoryHash: replacedCandidate.sourceHistoryHash,
    });
    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toMatchObject({
      lastSelectedSourceHistoryHash: replacedCandidate.sourceHistoryHash,
    });

    const third = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "replace the synthetic Phase 2 selection watermark",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, third.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toMatchObject({ sourceRunId: second.runId });
    await readmitPiMemoryStage1CandidateFixture(third.runId);
    const thirdConversation = await readPiConversationIdentityFixture(
      third.runId,
    );
    const thirdCandidate = await readPiMemoryStage1CandidateFixture({
      orgId,
      userId: actor.userId,
    });
    if (!thirdCandidate) {
      throw new Error("Expected third Pi memory candidate generation");
    }
    expect(thirdCandidate).toMatchObject({
      memoryStorageId: replacedCandidate.memoryStorageId,
      piSessionId: replacedCandidate.piSessionId,
      sourceRunId: third.runId,
      sourceHistoryHash: thirdConversation.sourceHistoryHash,
      status: "pending",
      rawMemory: null,
      rolloutSummary: null,
      generatedAt: null,
      lastSelectedSourceHistoryHash: null,
    });
    expect(thirdCandidate.sourceHistoryHash).not.toBe(
      replacedCandidate.sourceHistoryHash,
    );
    await expect(
      readSessionHistoryBlobRefCountFixture(
        replacedCandidate.sourceHistoryHash,
      ),
    ).resolves.toBe(1);
    await expect(
      readSessionHistoryBlobRefCountFixture(thirdCandidate.sourceHistoryHash),
    ).resolves.toBe(2);

    const thirdLeaseToken = randomUUID();
    await leasePiMemoryStage1CandidateFixture({
      memoryStorageId: thirdCandidate.memoryStorageId,
      piSessionId: thirdCandidate.piSessionId,
      sourceHistoryHash: thirdCandidate.sourceHistoryHash,
      leaseToken: thirdLeaseToken,
      leaseExpiresAt: new Date(now() + 60_000),
    });
    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: thirdCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: thirdCandidate.piSessionId,
        sourceHistoryHash: thirdCandidate.sourceHistoryHash,
        leaseToken: currentLeaseToken,
        committedAt: nowDate(),
        result: { kind: "succeeded_no_output" },
      }),
    ).resolves.toBeFalsy();
    await expect(
      commitPiMemoryStage1CandidateFixture({
        memoryStorageId: thirdCandidate.memoryStorageId,
        orgId,
        userId: actor.userId,
        piSessionId: thirdCandidate.piSessionId,
        sourceHistoryHash: thirdCandidate.sourceHistoryHash,
        leaseToken: thirdLeaseToken,
        committedAt: nowDate(),
        result: {
          kind: "succeeded",
          rawMemory: "bounded raw memory",
          rolloutSummary: "bounded rollout summary",
        },
      }),
    ).resolves.toBeTruthy();
    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toMatchObject({
      status: "succeeded",
      rawMemory: "bounded raw memory",
      rolloutSummary: "bounded rollout summary",
      lastSelectedSourceHistoryHash: null,
    });

    await deletePiMemoryStorageFixture(thirdCandidate.memoryStorageId);
    await expect(
      readPiMemoryStage1CandidateFixture({ orgId, userId: actor.userId }),
    ).resolves.toBeNull();
    await expect(
      readSessionHistoryBlobRefCountFixture(thirdCandidate.sourceHistoryHash),
    ).resolves.toBe(1);
  }, 90_000);
});
