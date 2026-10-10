import { randomUUID } from "node:crypto";

import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { Webhook } from "svix";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { cronProcessBackgroundJobsRoutes } from "../cron-process-background-jobs";
import { userExportRoutes } from "../user-export";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { installDurableUserExportStorage } from "./helpers/durable-user-export-storage";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const cronSecret = "clerk-export-cleanup-cron";
const signingSecret = `whsec_${Buffer.from("clerk-export-cleanup-signing-key").toString("base64")}`;
const routes = Object.freeze([
  ...userExportRoutes,
  ...webhooksClerkRoutes,
  ...cronProcessBackgroundJobsRoutes,
]);

function actor(orgId = `org_${randomUUID()}`) {
  return { userId: `user_${randomUUID()}`, orgId };
}

function authenticate(
  user: ReturnType<typeof actor>,
  orgId: string | null = user.orgId,
) {
  createRouteMocks(context).clerk.session(user.userId, orgId);
}

async function initialize(users: readonly ReturnType<typeof actor>[]) {
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
  mockEnv("CRON_SECRET", cronSecret);
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", signingSecret);
  context.mocks.clerk.verifyWebhook.mockImplementation(async (request) => {
    if (!(request instanceof Request)) {
      throw new Error("Expected a Clerk webhook request");
    }
    const payload = await request.text();
    new Webhook(signingSecret).verify(
      payload,
      Object.fromEntries(request.headers),
    );
    const event = z
      .object({
        type: z.enum(["user.deleted", "organization.deleted"]),
        data: z.object({ id: z.string() }),
      })
      .parse(JSON.parse(payload));
    if (event.type === "user.deleted") {
      mockClerkUsers(
        context,
        profiles.filter((profile) => {
          return profile.id !== event.data.id;
        }),
      );
    }
    return event;
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [],
    totalCount: 0,
  });
  const storage = installDurableUserExportStorage(context);
  const app = await setupApp({ context, routes, isolatePg: true });
  return { app, storage };
}

async function startExport(
  app: Awaited<ReturnType<typeof initialize>>["app"],
  user: ReturnType<typeof actor>,
) {
  authenticate(user);
  const started = await accept(
    app(userExportContract).post({ headers }),
    [202],
  );
  await flushWaitUntilForTest();
  const status = await accept(app(userExportContract).get({ headers }), [200]);
  expect(status.body.job).toMatchObject({ id: started.body.jobId });
  return started.body.jobId;
}

async function processBackgroundJobs(
  app: Awaited<ReturnType<typeof initialize>>["app"],
) {
  await accept(
    app(cronProcessBackgroundJobsContract).process({
      headers: { authorization: `Bearer ${cronSecret}` },
    }),
    [200],
  );
  await flushWaitUntilForTest();
}

async function readyExport(
  app: Awaited<ReturnType<typeof initialize>>["app"],
  user: ReturnType<typeof actor>,
) {
  const id = await startExport(app, user);
  // The normal exporter operator is explicitly in scope. Its real cron auth
  // and global request drive the ZIP lifecycle in this case-owned database.
  await processBackgroundJobs(app);
  authenticate(user);
  const status = await accept(app(userExportContract).get({ headers }), [200]);
  expect(status.body.job).toMatchObject({
    id,
    status: "completed",
    error: null,
  });
  const url = status.body.job?.downloadUrl;
  if (!url) {
    throw new Error("A completed export must expose its download URL");
  }
  return url;
}

function deletion(
  app: Awaited<ReturnType<typeof initialize>>["app"],
  kind: "user" | "organization",
  user: ReturnType<typeof actor>,
  valid = true,
) {
  const body = JSON.stringify({
    type: `${kind}.deleted`,
    data: { id: kind === "user" ? user.userId : user.orgId },
  });
  const id = `msg_${randomUUID()}`;
  const timestamp = nowDate();
  return app(webhookClerkContract).post({
    body,
    extraHeaders: {
      "svix-id": id,
      "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
      "svix-signature": new Webhook(signingSecret).sign(
        id,
        timestamp,
        valid ? body : "different payload",
      ),
    },
  });
}

test("erases a deleted user's ready ZIP and preserves a peer's downloadable export on replay", async () => {
  const owner = actor();
  const peer = actor(owner.orgId);
  const { app, storage } = await initialize([owner, peer]);
  const ownerUrl = await readyExport(app, owner);
  const peerUrl = await readyExport(app, peer);
  const peerBytes = storage.download(peerUrl);
  expect(storage.download(ownerUrl).subarray(0, 2).toString()).toBe("PK");
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [{ publicUserData: { userId: peer.userId } }],
      totalCount: 1,
    },
  );
  await accept(deletion(app, "user", owner), [200]);
  await flushWaitUntilForTest();
  expect(() => {
    return storage.download(ownerUrl);
  }).toThrow("no stored object");
  await accept(deletion(app, "user", owner), [200]);
  await flushWaitUntilForTest();
  authenticate(peer);
  const status = await accept(app(userExportContract).get({ headers }), [200]);
  expect(status.body.job?.downloadUrl).toBe(peerUrl);
  expect(storage.download(peerUrl)).toStrictEqual(peerBytes);
});

test("removes ready and null-key organization exports during concurrent signed deletion and preserves another organization", async () => {
  const owner = actor();
  const pending = actor(owner.orgId);
  const survivor = actor();
  const { app, storage } = await initialize([owner, pending, survivor]);
  const ownerUrl = await readyExport(app, owner);
  const survivorUrl = await readyExport(app, survivor);
  const pendingId = await startExport(app, pending);
  authenticate(pending);
  const running = await accept(app(userExportContract).get({ headers }), [200]);
  expect(running.body.job).toMatchObject({
    id: pendingId,
    status: "running",
    downloadUrl: null,
  });
  const responses = await Promise.all([
    deletion(app, "organization", owner),
    deletion(app, "organization", owner),
  ]);
  expect(
    responses.map((response) => {
      return response.status;
    }),
  ).toStrictEqual([200, 200]);
  await flushWaitUntilForTest();
  expect(() => {
    return storage.download(ownerUrl);
  }).toThrow("no stored object");
  // Organization deletion preserves the user. The surviving no-org session
  // can observe reference removal without resurrecting a deleted identity.
  for (const user of [owner, pending]) {
    authenticate(user, null);
    const status = await accept(
      app(userExportContract).get({ headers }),
      [200],
    );
    expect(status.body.job).toBeNull();
  }
  authenticate(survivor);
  const status = await accept(app(userExportContract).get({ headers }), [200]);
  expect(status.body.job?.downloadUrl).toBe(survivorUrl);
  expect(storage.download(survivorUrl).subarray(0, 2).toString()).toBe("PK");
});

test("recovers a ready export's failed object deletion through the authenticated cleanup operator", async () => {
  // Construct the entire lifecycle with the supported application clock. The
  // unchanged retry writer uses it, while queue eligibility uses database time.
  // This keeps its retry eligible without sleeping or editing business rows.
  mockNow(now() - 120_000);
  const owner = actor();
  const { app, storage } = await initialize([owner]);
  const url = await readyExport(app, owner);
  const bytes = storage.download(url);
  const send = context.mocks.s3.send.getMockImplementation();
  if (!send) {
    throw new Error("Expected the installed R2 boundary");
  }
  let unavailable = true;
  context.mocks.s3.send.mockImplementation(async (request: unknown) => {
    if (unavailable && request instanceof DeleteObjectsCommand) {
      throw new Error("R2 temporarily unavailable");
    }
    return await send(request);
  });
  await accept(deletion(app, "user", owner), [200]);
  await flushWaitUntilForTest();
  expect(storage.download(url)).toStrictEqual(bytes);
  unavailable = false;
  await processBackgroundJobs(app);
  expect(() => {
    return storage.download(url);
  }).toThrow("no stored object");
});

test("rejects an invalid deletion signature and keeps the owner's completed export available", async () => {
  const owner = actor();
  const { app, storage } = await initialize([owner]);
  const url = await readyExport(app, owner);
  const bytes = storage.download(url);
  await accept(deletion(app, "user", owner, false), [401]);
  authenticate(owner);
  const status = await accept(app(userExportContract).get({ headers }), [200]);
  expect(status.body.job?.downloadUrl).toBe(url);
  expect(storage.download(url)).toStrictEqual(bytes);
});
