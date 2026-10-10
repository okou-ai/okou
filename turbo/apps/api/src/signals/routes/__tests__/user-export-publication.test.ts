import { createHash, randomUUID } from "node:crypto";

import { CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import AdmZip from "adm-zip";
import { Webhook } from "svix";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { agentsRoutes } from "../agents";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { userExportRoutes } from "../user-export";
import { workflowsRoutes } from "../workflows";
import { webhooksClerkRoutes } from "../webhooks-clerk";
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
  ...chatThreadCreateRoutes,
  ...workflowsRoutes,
  ...webhooksClerkRoutes,
  ...userExportRoutes,
  ...cronProcessBackgroundJobsRoutes,
]);

function actor(orgId = `org_${randomUUID()}`) {
  return { userId: `user_${randomUUID()}`, orgId };
}

function authenticate(user: ReturnType<typeof actor>) {
  createRouteMocks(context).clerk.session(user.userId, user.orgId);
}

async function initialize(
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
  const app = await setupApp({ context, routes, isolatePg: true });
  return { app, storage, profiles };
}

type Fixture = Awaited<ReturnType<typeof initialize>>;

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

test("publishes an owned ZIP while isolating peers and preserving replay", async () => {
  const owner = actor();
  const peer = actor(owner.orgId);
  const outsider = actor();
  const fixture = await initialize([owner, peer, outsider]);
  const agentId = await ownedAgent(fixture, owner);
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
    instructions: "",
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
});

test("withholds publication after membership withdrawal and re-enters the completed multipart result", async () => {
  // Construct the whole lifecycle with the supported application clock. The
  // unchanged retry deadline is then eligible on the real database clock.
  mockNow(now() - 120_000);
  const owner = actor();
  let withdrew = false;
  let observedBlocked = false;
  const fixture = await initialize([owner], () => {
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
  const fixture = await initialize([owner], async () => {
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
  const fixture = await initialize([owner]);
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
  const fixture = await initialize([owner]);
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

test("does not publish an export removed by signed organization deletion during multipart completion", async () => {
  const owner = actor();
  const secret = `whsec_${Buffer.from("export-publication-deletion-key").toString("base64")}`;
  let removed = false;
  const fixture = await initialize([owner], async () => {
    const body = JSON.stringify({
      type: "organization.deleted",
      data: { id: owner.orgId },
    });
    const id = `msg_${randomUUID()}`;
    const timestamp = nowDate();
    await accept(
      fixture.app(webhookClerkContract).post({
        body,
        extraHeaders: {
          "svix-id": id,
          "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
          "svix-signature": new Webhook(secret).sign(id, timestamp, body),
        },
      }),
      [200],
    );
    removed = true;
  });
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", secret);
  context.mocks.clerk.verifyWebhook.mockImplementation(async (request) => {
    if (!(request instanceof Request)) {
      throw new Error("Expected the real Clerk webhook request");
    }
    const body = await request.text();
    new Webhook(secret).verify(body, Object.fromEntries(request.headers));
    return z
      .object({
        type: z.literal("organization.deleted"),
        data: z.object({ id: z.string() }),
      })
      .parse(JSON.parse(body));
  });
  await startExport(fixture, owner);
  await process(fixture);
  expect(removed).toBeTruthy();
  // Organization deletion preserves this user. Observe with their surviving
  // no-org session, rather than resurrecting a deleted account credential.
  createRouteMocks(context).clerk.session(owner.userId, null);
  const missing = await accept(
    fixture.app(userExportContract).get({ headers }),
    [200],
  );
  expect(missing.body.job).toBeNull();
  await process(fixture);
  const replay = await accept(
    fixture.app(userExportContract).get({ headers }),
    [200],
  );
  expect(replay.body.job).toBeNull();
});
