import { createHash, randomUUID } from "node:crypto";

import { CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import {
  agentInstructionsContract,
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import {
  chatThreadEventsContract,
  chatThreadByIdContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import AdmZip from "adm-zip";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { agentsRoutes } from "../agents";
import { agentInstructionsRoutes } from "../agent-instructions";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { chatThreadPatchRoutes } from "../chat-threads-patch";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { userExportRoutes } from "../user-export";
import { workflowsRoutes } from "../workflows";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";
import {
  createPublicRunnerMemory,
  memoryArchive,
} from "./helpers/public-runner-memory";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const cronSecret = "user-export-publication-cron";
const cronHeaders = Object.freeze({ authorization: `Bearer ${cronSecret}` });
const routes = Object.freeze([
  ...agentsRoutes,
  ...agentInstructionsRoutes,
  ...chatThreadCreateRoutes,
  ...chatThreadPatchRoutes,
  ...workflowsRoutes,
  ...userExportRoutes,
  ...cronProcessBackgroundJobsRoutes,
]);

function actor(orgId = `org_${randomUUID()}`) {
  return { userId: `user_${randomUUID()}`, orgId };
}

function authenticate(user: ReturnType<typeof actor>) {
  createRouteMocks(context).clerk.session(user.userId, user.orgId);
}

function initialize(
  app: Awaited<ReturnType<typeof setupApp>>,
  users: readonly ReturnType<typeof actor>[],
  onComplete?: () => Promise<void>,
) {
  const profiles = users.map((user) => {
    return {
      id: user.userId,
      firstName: "Export",
      lastName: "Owner",
      primaryEmailAddressId: "email",
      emailAddresses: [
        { id: "email", emailAddress: `${user.userId}@example.com` },
      ],
      privateMetadata: {},
      publicMetadata: {},
    };
  });
  mockClerkUsers(context, profiles);
  context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
    (params: unknown) => {
      const { userId } = z.object({ userId: z.string() }).parse(params);
      const user = users.find((candidate) => {
        return candidate.userId === userId;
      });
      return Promise.resolve({
        data: user ? [{ organization: { id: user.orgId } }] : [],
        totalCount: user ? 1 : 0,
      });
    },
  );
  mockEnv("CRON_SECRET", cronSecret);
  const storage = installDurableUserExportStorage(context, {
    prefixes: [
      "exports/",
      ...users.map((user) => {
        return `${user.orgId}/`;
      }),
    ],
    afterWrite: async (command) => {
      if (command instanceof CompleteMultipartUploadCommand) {
        await onComplete?.();
      }
    },
  });
  return { app, storage, profiles };
}

type Fixture = ReturnType<typeof initialize>;

async function ownedAgent(fixture: Fixture, owner: ReturnType<typeof actor>) {
  authenticate(owner);
  const created = await accept(
    fixture.app(agentsMainContract).create({
      headers,
      body: { displayName: "Exported private agent", visibility: "private" },
    }),
    [201],
  );
  return created.body.agentId;
}

async function startExport(fixture: Fixture, owner: ReturnType<typeof actor>) {
  authenticate(owner);
  const started = await accept(
    fixture.app(userExportContract).post({ headers }),
    [202],
  );
  await flushWaitUntilForTest();
  return started.body.jobId;
}

async function process(fixture: Fixture) {
  await accept(
    fixture.app(cronProcessBackgroundJobsContract).process({
      headers: cronHeaders,
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

async function status(fixture: Fixture, owner: ReturnType<typeof actor>) {
  authenticate(owner);
  return (await accept(fixture.app(userExportContract).get({ headers }), [200]))
    .body;
}

function archive(fixture: Fixture, url: string | null | undefined) {
  if (!url) {
    throw new Error("Completed export must expose its download URL");
  }
  const zip = new AdmZip(fixture.storage.download(url));
  expect(zip.test()).toBeTruthy();
  expect(zip.getEntry("README.md")).not.toBeNull();
  expect(zip.getEntry("restore.py")).not.toBeNull();
  expect(zip.getEntry("export-manifest.json")).not.toBeNull();
  return zip;
}

test("exports PATCH-created drafts with owned thread timestamps and absent draft nulls", async () => {
  const owner = actor();
  const peer = actor(owner.orgId);
  const app = await setupApp({ context, routes, isolatePg: true });
  const fixture = initialize(app, [owner, peer]);
  const agentId = await ownedAgent(fixture, owner);
  const threads = [];
  for (const title of ["Saved draft", "No draft", "Cleared draft"]) {
    threads.push(
      await accept(
        fixture.app(chatThreadsContract).create({
          headers,
          body: { agentId, title },
        }),
        [201],
      ),
    );
  }
  const [saved, missing, cleared] = threads;
  if (!saved || !missing || !cleared) {
    throw new Error("Expected three owned threads");
  }
  const draftUserMessage = {
    version: 1 as const,
    parts: [{ type: "text" as const, text: "Keep this unsent draft: 你好" }],
  };
  for (const thread of [saved, cleared]) {
    await accept(
      fixture.app(chatThreadByIdContract).patch({
        headers,
        params: { id: thread.body.id },
        body: { draftUserMessage, draftAttachments: [] },
      }),
      [204],
    );
  }
  await accept(
    fixture.app(chatThreadByIdContract).patch({
      headers,
      params: { id: cleared.body.id },
      body: { draftUserMessage: null, draftAttachments: null },
    }),
    [204],
  );
  const peerAgentId = await ownedAgent(fixture, peer);
  const peerThread = await accept(
    fixture.app(chatThreadsContract).create({
      headers,
      body: { agentId: peerAgentId, title: "Peer draft" },
    }),
    [201],
  );
  await accept(
    fixture.app(chatThreadByIdContract).patch({
      headers,
      params: { id: peerThread.body.id },
      body: { draftUserMessage, draftAttachments: null },
    }),
    [204],
  );
  const jobId = await startExport(fixture, owner);
  await process(fixture);
  const ready = await status(fixture, owner);
  expect(ready.job).toMatchObject({
    id: jobId,
    status: "completed",
    error: null,
  });
  const zip = archive(fixture, ready.job?.downloadUrl);
  const exportedThreads = zip.getEntries().filter((entry) => {
    return entry.entryName.startsWith("chat-threads/");
  });
  expect(
    exportedThreads
      .map((entry) => {
        return entry.entryName;
      })
      .sort(),
  ).toStrictEqual(
    threads
      .map((thread) => {
        return `chat-threads/${thread.body.id}.json`;
      })
      .sort(),
  );
  for (const thread of threads) {
    const exported = JSON.parse(
      zip.readAsText(`chat-threads/${thread.body.id}.json`),
    );
    expect(Object.keys(exported)).toStrictEqual([
      "id",
      "userId",
      "title",
      "agentId",
      "orgId",
      "sourceScheduleRunId",
      "createdAt",
      "updatedAt",
      "lastMessageAt",
      "lastReadAt",
      "pinnedAt",
      "pinOrder",
      "archived",
      "renamedAt",
      "selectedModel",
      "modelSettings",
      "codexServiceTier",
      "draftUserMessage",
      "draftAttachments",
    ]);
    expect(exported).toMatchObject({
      id: thread.body.id,
      userId: owner.userId,
      title: thread.body.title,
      agentId,
      orgId: owner.orgId,
      createdAt: thread.body.createdAt,
      sourceScheduleRunId: null,
      pinnedAt: null,
      renamedAt: null,
      draftUserMessage: thread === saved ? draftUserMessage : null,
      draftAttachments: thread === saved ? [] : null,
    });
    for (const timestamp of [
      exported.updatedAt,
      exported.lastMessageAt,
      exported.lastReadAt,
    ]) {
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    }
  }
  expect(zip.getEntry(`chat-threads/${peerThread.body.id}.json`)).toBeNull();
  expect((await status(fixture, peer)).job).toBeNull();
});

test("publishes an owned ZIP while isolating peers and preserving replay", async () => {
  const owner = actor();
  const peer = actor(owner.orgId);
  const outsider = actor();
  const app = await setupApp({ context, routes, isolatePg: true });
  const fixture = initialize(app, [owner, peer, outsider]);
  const agentId = await ownedAgent(fixture, owner);
  const rawInstructions =
    "[AGENT_PROFILE]\nLegacy display metadata\n[/AGENT_PROFILE]\nExported current instructions";
  await accept(
    fixture.app(agentInstructionsContract).update({
      headers,
      params: { id: agentId },
      body: { content: rawInstructions },
    }),
    [200],
  );
  const workflow = await accept(
    fixture.app(workflowsCollectionContract).create({
      headers,
      body: {
        agentId,
        name: "exported-workflow",
        instruction: "Use the exported instruction",
        visibility: "private",
      },
    }),
    [201],
  );
  const thread = await accept(
    fixture.app(chatThreadsContract).create({
      headers,
      body: { agentId, title: "Exported conversation" },
    }),
    [201],
  );
  authenticate(owner);
  const starts = await Promise.all([
    fixture.app(userExportContract).post({ headers }),
    fixture.app(userExportContract).post({ headers }),
  ]);
  const accepted = starts.map((response) => {
    expect(response.status).toBe(202);
    if (response.status !== 202) {
      throw new Error("Expected accepted export");
    }
    return response.body.jobId;
  });
  expect(new Set(accepted).size).toBe(1);
  await flushWaitUntilForTest();
  await process(fixture);
  const ready = await status(fixture, owner);
  expect(ready.job).toMatchObject({
    id: accepted[0],
    status: "completed",
    error: null,
  });
  const zip = archive(fixture, ready.job?.downloadUrl);
  expect(JSON.parse(zip.readAsText(`agents/${agentId}.json`))).toMatchObject({
    id: agentId,
    visibility: "private",
    instructions: "Exported current instructions",
  });
  expect(
    JSON.parse(zip.readAsText(`workflows/${workflow.body.id}.json`)),
  ).toMatchObject({
    id: workflow.body.id,
    instruction: "Use the exported instruction",
  });
  expect(
    JSON.parse(zip.readAsText(`chat-threads/${thread.body.id}.json`)),
  ).toMatchObject({ id: thread.body.id, title: "Exported conversation" });
  for (const user of [peer, outsider]) {
    expect((await status(fixture, user)).job).toBeNull();
  }
  await process(fixture);
  const replay = await status(fixture, owner);
  expect(replay.job?.downloadUrl).toBe(ready.job?.downloadUrl);
  archive(fixture, replay.job?.downloadUrl);
  authenticate(owner);
  const limited = await accept(
    fixture.app(userExportContract).post({ headers }),
    [429],
  );
  expect(limited.body.error.code).toBe("RATE_LIMITED");
});

test("withholds publication after membership withdrawal and re-enters the completed multipart result", async () => {
  // Construct the whole lifecycle with the supported application clock. The
  // unchanged retry deadline is then eligible on the real database clock.
  mockNow(now() - 120_000);
  const owner = actor();
  let withdrew = false;
  let observedBlocked = false;
  const app = await setupApp({ context, routes, isolatePg: true });
  const fixture = initialize(app, [owner], () => {
    context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
      async () => {
        if (!withdrew) {
          withdrew = true;
          return { data: [], totalCount: 0 };
        }
        expect((await status(fixture, owner)).job).toMatchObject({
          status: "running",
          downloadUrl: null,
        });
        observedBlocked = true;
        return {
          data: [{ organization: { id: owner.orgId } }],
          totalCount: 1,
        };
      },
    );
    return Promise.resolve();
  });
  const agentId = await ownedAgent(fixture, owner);
  const jobId = await startExport(fixture, owner);
  await process(fixture);
  expect(observedBlocked).toBeTruthy();
  const ready = await status(fixture, owner);
  expect(ready.job).toMatchObject({ id: jobId, status: "completed" });
  expect(
    archive(fixture, ready.job?.downloadUrl).getEntry(`agents/${agentId}.json`),
  ).not.toBeNull();
});

test("rejects publication when the owner deletes an already collected agent", async () => {
  mockNow(now() - 700_000);
  const owner = actor();
  const app = await setupApp({ context, routes, isolatePg: true });
  const fixture = initialize(app, [owner], async () => {
    authenticate(owner);
    await accept(
      fixture
        .app(agentsByIdContract)
        .delete({ headers, params: { id: agentId } }),
      [204],
    );
  });
  const agentId = await ownedAgent(fixture, owner);
  const jobId = await startExport(fixture, owner);
  await process(fixture);
  const failed = await status(fixture, owner);
  expect(failed.job).toMatchObject({
    id: jobId,
    status: "failed",
    downloadUrl: null,
    error: "Data export could not be completed. Please try again.",
  });
  await accept(
    fixture.app(agentsByIdContract).get({ headers, params: { id: agentId } }),
    [404],
  );
});

test("keeps the completed ZIP downloadable while notification preparation recovers", async () => {
  mockNow(now() - 120_000);
  const owner = actor();
  const app = await setupApp({ context, routes, isolatePg: true });
  const fixture = initialize(app, [owner]);
  const jobId = await startExport(fixture, owner);
  let unavailable = true;
  let observedUrl: string | undefined;
  context.mocks.clerk.users.getUser.mockImplementation(async () => {
    const ready = await status(fixture, owner);
    expect(ready.job).toMatchObject({ id: jobId, status: "completed" });
    archive(fixture, ready.job?.downloadUrl);
    if (unavailable) {
      unavailable = false;
      observedUrl = ready.job?.downloadUrl ?? undefined;
      throw new Error("Clerk temporarily unavailable");
    }
    const profile = fixture.profiles[0];
    if (!profile) {
      throw new Error("Expected export owner's Clerk profile");
    }
    return profile;
  });
  await process(fixture);
  const ready = await status(fixture, owner);
  expect(ready.job).toMatchObject({ id: jobId, status: "completed" });
  const bytes = fixture.storage.download(ready.job?.downloadUrl ?? "missing");
  archive(fixture, ready.job?.downloadUrl);
  expect(ready.job?.downloadUrl).toBe(observedUrl);
  expect(context.mocks.clerk.users.getUser).toHaveBeenCalledTimes(2);
  await process(fixture);
  expect(context.mocks.clerk.users.getUser).toHaveBeenCalledTimes(2);
  const recovered = await status(fixture, owner);
  expect(recovered.job?.downloadUrl).toBe(ready.job?.downloadUrl);
  expect(
    fixture.storage.download(recovered.job?.downloadUrl ?? "missing"),
  ).toStrictEqual(bytes);
});

test("publishes the exact owned memory bytes committed by a genuine Runner claim", async () => {
  const owner = actor();
  const app = await setupApp({ context, routes, isolatePg: true });
  const fixture = initialize(app, [owner]);
  const carrier = createPublicRunnerMemory(context, owner);
  await carrier.run(async () => {
    const agentId = await carrier.initializeNative();
    const claimed = await carrier.claim(agentId, "Write my exported memory");
    const content = "Memory from an authenticated Runner";
    const files = [
      {
        path: "notes.md",
        hash: createHash("sha256").update(content).digest("hex"),
        size: Buffer.byteLength(content),
      },
    ];
    carrier.installObjects();
    const prepared = await carrier.webhooks.requestAgentStoragePrepare(
      {
        runId: claimed.run.runId,
        storageId: claimed.memory.storageId,
        files,
      },
      claimed.headers,
      [200],
    );
    if (prepared.status !== 200 || !prepared.body.uploads) {
      throw new Error("Expected the real memory upload targets");
    }
    const bytes = memoryArchive("notes.md", content);
    carrier.objects.set(prepared.body.uploads.archive.key, bytes);
    const manifest = Buffer.from(
      JSON.stringify({
        version: 1,
        files,
        createdAt: nowDate().toISOString(),
      }),
    );
    carrier.objects.set(prepared.body.uploads.manifest.key, manifest);
    await carrier.webhooks.requestAgentStorageCommit(
      {
        runId: claimed.run.runId,
        storageId: claimed.memory.storageId,
        versionId: prepared.body.versionId,
        files,
      },
      claimed.headers,
      [200],
    );
    // The existing helper owns the genuine Run's normal cancellation teardown.
    // Keep its external memory objects, and add the exporter provider boundary.
    const storage = installDurableUserExportStorage(context, {
      prefixes: ["exports/", `${owner.orgId}/`],
    });
    // The upload targets came from the genuine prepare response. The exporter
    // needs the provider's ETag/If-Match/range contract for these same bytes.
    storage.seedObject(prepared.body.uploads.archive.key, bytes);
    storage.seedObject(prepared.body.uploads.manifest.key, manifest);
    const exporting = { ...fixture, storage };
    const jobId = await startExport(exporting, owner);
    await process(exporting);
    const ready = await status(exporting, owner);
    expect(ready.job).toMatchObject({ id: jobId, status: "completed" });
    const zip = archive(exporting, ready.job?.downloadUrl);
    expect(
      zip.readFile(
        `memory/${owner.orgId}/${claimed.memory.storageId}/archive.tar.gz`,
      ),
    ).toStrictEqual(bytes);
  });
});

function assertExportPageBoundaries(
  pages: readonly (readonly ChatEventRow[])[],
  expected: readonly ChatEventRow[],
  count: number,
) {
  if (count === 104) {
    expect(pages[0]).toHaveLength(100);
  } else {
    const firstOutput = expected.find((row) => {
      return row.eventType === "output.message";
    });
    if (!firstOutput || !firstOutput.payload) {
      throw new Error("Expected the first publicly readable output row");
    }
    expect(Object.keys(firstOutput.payload)).toStrictEqual(["content"]);
    // For this one-field, unescaped text payload, PostgreSQL JSONB adds
    // one space after the colon. The native calibration records that
    // representation independently; compact JSON is not a general encoder.
    const compactBytes = Buffer.byteLength(JSON.stringify(firstOutput.payload));
    const payloadBytes = compactBytes + 1;
    expect(payloadBytes * 2 + 1024).toBeGreaterThan(2 * 1024 * 1024);
    expect(payloadBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(pages).toHaveLength(3);
    expect(
      pages[0]?.map((row) => {
        return row.eventType;
      }),
    ).toStrictEqual(["input.prompt", "input.prompt"]);
    // Pending and claimed input rows fill page one; the latter carries
    // the revocation identity instead of a separate control row.
    expect(pages[0]?.[1]?.revokesEventId).toBe(pages[0]?.[0]?.id);
    // Page two admits the large output as its first and only row.
    expect(pages[1]).toStrictEqual([firstOutput]);
    expect(
      pages[2]?.map((row) => {
        return row.eventType;
      }),
    ).toStrictEqual(["output.message", "output.message", "run.completed"]);
  }
}

test.each([
  {
    name: "100-row metadata pages",
    count: 104,
    size: 32,
    firstSize: 32,
    firstCharacter: "x",
  },
  {
    name: "soft-budget pages and a first large row",
    count: 3,
    size: 32,
    // UTF-8 bytes, rather than JavaScript character count, set the budget.
    firstSize: 349_667,
    firstCharacter: "语",
  },
])(
  "exports completed Runner history across $name with exact rows and replay",
  async ({ count, size, firstSize, firstCharacter }) => {
    const owner = actor();
    const peer = actor(owner.orgId);
    const app = await setupApp({ context, routes, isolatePg: true });
    const fixture = initialize(app, [owner, peer]);
    const carrier = createPublicRunnerMemory(context, owner);
    await carrier.run(async () => {
      const agentId = await carrier.initializeNative();
      const claimed = await carrier.claim(
        agentId,
        "Export my completed conversation: 你好",
      );
      const contents = Array.from({ length: count }, (_, index) => {
        return (
          `${String(index).padStart(3, "0")}:` +
          (index === 0 ? firstCharacter : "x").repeat(
            index === 0 ? firstSize : size,
          )
        );
      });
      // Each real request remains below the hosted API's 4.5 MB body ceiling.
      for (let offset = 0; offset < contents.length; offset += 3) {
        const eventBody = {
          runId: claimed.run.runId,
          events: contents.slice(offset, offset + 3).map((text, index) => {
            return {
              type: "assistant",
              sequenceNumber: offset + index,
              message: {
                id: `msg_export_${offset + index}`,
                content: [{ type: "text", text }],
              },
            };
          }),
        };
        expect(Buffer.byteLength(JSON.stringify(eventBody))).toBeLessThan(
          4_500_000,
        );
        await carrier.webhooks.requestAgentEvents(
          eventBody,
          claimed.headers,
          [200],
        );
      }
      await carrier.webhooks.requestAgentComplete(
        {
          runId: claimed.run.runId,
          exitCode: 0,
          lastEventSequence: count - 1,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: `export-${claimed.run.runId}`,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        claimed.headers,
        [200],
      );
      await flushWaitUntilForTest();
      await expect(
        carrier.api.readRun(carrier.actor, claimed.run.runId),
      ).resolves.toMatchObject({ status: "completed" });

      authenticate(owner);
      const reader = setupApp({ context, routes: chatThreadRoutes })(
        chatThreadEventsContract,
      );
      const expected = [];
      let cursor: { seqId: number; id: string } | undefined;
      for (;;) {
        const page = await accept(
          reader.rows({
            headers,
            params: { threadId: claimed.run.threadId },
            query: cursor
              ? { sinceSeqId: cursor.seqId, sinceEventId: cursor.id, limit: 50 }
              : { sinceSeqId: 0, limit: 50 },
          }),
          [200],
        );
        expected.push(...page.body.rows);
        if (!page.body.hasMore) {
          break;
        }
        const last = page.body.rows.at(-1);
        if (!last) {
          throw new Error("Expected a nonempty public event page");
        }
        cursor = { seqId: last.seqId, id: last.id };
      }
      expect(
        expected
          .filter((row) => {
            return row.eventType === "output.message";
          })
          .map((row) => {
            return row.payload?.content;
          }),
      ).toStrictEqual(contents);
      expect(expected).toContainEqual(
        expect.objectContaining({ eventType: "run.completed", payload: null }),
      );

      const peerAgentId = await ownedAgent(fixture, peer);
      const peerThread = await accept(
        fixture.app(chatThreadsContract).create({
          headers,
          body: { agentId: peerAgentId, title: "Peer's private conversation" },
        }),
        [201],
      );
      const storage = installDurableUserExportStorage(context, {
        prefixes: ["exports/", `${owner.orgId}/`],
      });
      const exporting = { ...fixture, storage };
      const jobId = await startExport(exporting, owner);
      authenticate(owner);
      expect(
        (
          await accept(
            exporting.app(userExportContract).post({ headers }),
            [202],
          )
        ).body.jobId,
      ).toBe(jobId);
      await flushWaitUntilForTest();
      await process(exporting);
      const ready = await status(exporting, owner);
      expect(ready.job).toMatchObject({
        id: jobId,
        status: "completed",
        error: null,
      });
      const zip = archive(exporting, ready.job?.downloadUrl);
      const tails = zip
        .getEntries()
        .filter((entry) => {
          return entry.entryName.startsWith(
            `chat-messages/${claimed.run.threadId}/tail/`,
          );
        })
        .sort((left, right) => {
          return left.entryName.localeCompare(right.entryName);
        });
      expect(tails.length).toBeGreaterThan(1);
      const pages = tails.map((entry) => {
        return zip
          .readAsText(entry)
          .trimEnd()
          .split("\n")
          .map((line) => {
            return chatEventRowSchema.parse(JSON.parse(line));
          });
      });
      const actual = pages.flat();
      expect(actual).toStrictEqual(expected);
      const sequenceIds = actual.map((row) => {
        return row.seqId;
      });
      expect(sequenceIds).toStrictEqual(
        [...sequenceIds].sort((left, right) => {
          return left - right;
        }),
      );
      assertExportPageBoundaries(pages, expected, count);
      expect(
        new Set(
          actual.map((row) => {
            return row.id;
          }),
        ).size,
      ).toBe(actual.length);
      expect(
        zip.getEntry(`chat-threads/${peerThread.body.id}.json`),
      ).toBeNull();
      expect((await status(exporting, peer)).job).toBeNull();
      const bytes = storage.download(ready.job?.downloadUrl ?? "missing");
      await process(exporting);
      const replay = await status(exporting, owner);
      expect(replay.job?.downloadUrl).toBe(ready.job?.downloadUrl);
      // Native Buffer equality compares every byte and length without
      // repeating a JavaScript assertion for each ZIP byte.
      expect(
        storage.download(replay.job?.downloadUrl ?? "missing").equals(bytes),
      ).toBeTruthy();
    });
  },
);
