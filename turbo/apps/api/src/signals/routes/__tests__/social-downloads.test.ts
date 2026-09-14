import { randomUUID } from "node:crypto";

import { socialContract } from "@okouai/api-contracts/contracts/social";
import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createUsagePricingFixture,
  seedOrgMetadata,
} from "../../../test-fixtures/system-config-seeds";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { socialRoutes } from "../social";
import {
  createBddApi,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const providerBase = "https://api.socialkit.dev";
const requestBody = {
  platform: "youtube",
  url: "https://youtu.be/public-video",
  maxDuration: 60,
  quality: "720p",
  format: "mp4",
} as const;

function actor(options: ApiTestUserOptions = {}) {
  const user = createBddApi(context).user(options);
  if (!user.orgId) {
    throw new Error("Discovery fixture requires an organization");
  }
  return { ...user, orgId: user.orgId };
}

function authenticate(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}

async function configuredClient(user: ReturnType<typeof actor>) {
  await accept(createBddApi(context).completeOnboarding(user), [200]);
  await seedOrgMetadata({ orgId: user.orgId, tier: "pro", credits: 10_000 });
  mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", "test-socialkit-key");
  const pricing = await createUsagePricingFixture({
    configured: [
      {
        kind: "social",
        provider: "socialkit",
        category: "request",
        unitPrice: 3,
        unitSize: 1,
      },
    ],
  });
  onTestFinished(async () => {
    await pricing.cleanup();
  });
  return setupAppWithRoutes({
    context,
    routes: socialRoutes,
    usagePricingResolution: pricing.resolution,
  })(socialContract);
}

function basicClient() {
  return setupAppWithRoutes({ context, routes: socialRoutes })(socialContract);
}

function providerDownloads(status: "processing" | "failed") {
  let polls = 0;
  server.use(
    http.post(`${providerBase}/v2/youtube/download`, () => {
      return HttpResponse.json({ jobId: randomUUID(), status: "queued" });
    }),
    http.get(`${providerBase}/v2/downloads/:jobId`, ({ params }) => {
      polls += 1;
      return HttpResponse.json(
        status === "processing"
          ? { jobId: params.jobId, status }
          : {
              status,
              errorCode: "VIDEO_UNAVAILABLE",
              error: "SocialKit could not prepare the download",
              retryable: false,
            },
      );
    }),
  );
  return {
    polls: () => {
      return polls;
    },
  };
}

describe("social download discovery", () => {
  it("requires authentication, an organization, and the social capability", async () => {
    const client = basicClient();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    await accept(client.listDownloads({ headers: {}, query: {} }), [401]);
    const noOrg = createBddApi(context).user({ orgId: null });
    await accept(
      client.listDownloads({ headers: authenticate(noOrg), query: {} }),
      [401],
    );
    const owner = actor();
    await accept(createBddApi(context).completeOnboarding(owner), [200]);
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: owner.userId,
      orgId: owner.orgId,
      runId: randomUUID(),
      capabilities: [],
      iat: seconds,
      exp: seconds + 60,
    });
    const denied = await accept(
      client.listDownloads({
        headers: { authorization: `Bearer ${token}` },
        query: {},
      }),
      [403],
    );
    expect(denied.body.error.message).toBe(
      "Missing required capability: social:read",
    );
    const empty = await accept(
      client.listDownloads({ headers: authenticate(owner), query: {} }),
      [200],
    );
    expect(empty.body).toStrictEqual({ downloads: [], nextCursor: null });
  });

  it.each([
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=no",
    "cursor=invalid",
    "status=invalid",
  ])("rejects invalid page query %s", async (query) => {
    const owner = actor();
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: socialRoutes,
    });
    const response = await app.request(
      new Request(`http://api.test/api/social/downloads?${query}`, {
        headers: authenticate(owner),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("bounds default pages and continues after exact database anchors despite new insertions", async () => {
    const owner = actor();
    const client = await configuredClient(owner);
    providerDownloads("failed");
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const created = await accept(
        client.createDownload({
          headers: authenticate(owner),
          body: { ...requestBody, url: `https://youtu.be/video-${index}` },
        }),
        [202],
      );
      ids.push(created.body.downloadId);
      await flushWaitUntilForTest();
    }
    const first = await accept(
      client.listDownloads({ headers: authenticate(owner), query: {} }),
      [200],
    );
    expect(
      first.body.downloads.map((task) => {
        return task.downloadId;
      }),
    ).toStrictEqual(ids.slice(1).reverse());
    expect(first.body.nextCursor).toBe(ids[1]);
    expect(first.body.downloads[0]).toMatchObject({
      status: "provider_failed",
      request: { url: "https://youtu.be/video-20" },
      resumeCommand: null,
      error: { retryable: false, billed: false },
    });

    await accept(
      client.createDownload({
        headers: authenticate(owner),
        body: requestBody,
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const last = await accept(
      client.listDownloads({
        headers: authenticate(owner),
        query: {
          cursor: first.body.nextCursor ?? undefined,
          status: "provider_failed",
          limit: 1,
        },
      }),
      [200],
    );
    expect(
      last.body.downloads.map((task) => {
        return task.downloadId;
      }),
    ).toStrictEqual([ids[0]]);
    expect(last.body.nextCursor).toBeNull();
    const active = await accept(
      client.listDownloads({
        headers: authenticate(owner),
        query: { status: "active", limit: 100 },
      }),
      [200],
    );
    expect(active.body).toStrictEqual({ downloads: [], nextCursor: null });
  });

  it("recovers submitting and processing task identities without causing provider work", async () => {
    const owner = actor();
    const client = await configuredClient(owner);
    const provider = providerDownloads("processing");
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(`${providerBase}/v2/youtube/download`, async () => {
        started.resolve();
        await release.promise;
        return HttpResponse.json({ jobId: randomUUID(), status: "queued" });
      }),
    );
    const creating = client.createDownload({
      headers: authenticate(owner),
      body: requestBody,
    });
    await started.promise;
    const queued = await accept(
      client.listDownloads({
        headers: authenticate(owner),
        query: { status: "queued" },
      }),
      [200],
    );
    expect(queued.body.downloads).toHaveLength(1);
    const task = queued.body.downloads[0];
    expect(task).toMatchObject({ status: "queued", request: requestBody });
    const conflict = await accept(
      client.createDownload({
        headers: authenticate(owner),
        body: { ...requestBody, url: "https://youtu.be/different-target" },
      }),
      [409],
    );
    expect(conflict.body.error).toMatchObject({
      code: "DOWNLOAD_IN_PROGRESS",
      recovery: {
        downloadId: task?.downloadId,
        resumeCommand: task?.resumeCommand,
      },
    });
    release.resolve();
    const created = await accept(creating, [202]);
    await flushWaitUntilForTest();
    expect(created.body.downloadId).toBe(task?.downloadId);
    const pollsBefore = provider.polls();
    const processing = await accept(
      client.listDownloads({
        headers: authenticate(owner),
        query: { status: "active" },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(processing.body.downloads).toMatchObject([
      {
        downloadId: created.body.downloadId,
        status: "processing",
        resumeCommand: `okou social download --resume ${created.body.downloadId}`,
      },
    ]);
    expect(provider.polls()).toBe(pollsBefore);
    const processingConflict = await accept(
      client.createDownload({
        headers: authenticate(owner),
        body: requestBody,
      }),
      [409],
    );
    expect(processingConflict.body.error.recovery?.downloadId).toBe(
      created.body.downloadId,
    );
    const known = await accept(
      client.getDownload({
        headers: authenticate(owner),
        params: { downloadId: created.body.downloadId },
      }),
      [200],
    );
    expect(known.body.downloadId).toBe(created.body.downloadId);
    await flushWaitUntilForTest();
  });

  it("isolates listing, cursor anchors, reads, and active conflicts across users and organizations", async () => {
    const owner = actor();
    const client = await configuredClient(owner);
    providerDownloads("processing");
    const created = await accept(
      client.createDownload({
        headers: authenticate(owner),
        body: requestBody,
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const otherUser = actor({ orgId: owner.orgId });
    const otherOrg = actor({ userId: owner.userId });
    await accept(createBddApi(context).completeOnboarding(otherOrg), [200]);
    await seedOrgMetadata({
      orgId: otherOrg.orgId,
      tier: "pro",
      credits: 10_000,
    });
    for (const other of [otherUser, otherOrg]) {
      const empty = await accept(
        client.listDownloads({ headers: authenticate(other), query: {} }),
        [200],
      );
      expect(empty.body).toStrictEqual({ downloads: [], nextCursor: null });
      await accept(
        client.getDownload({
          headers: authenticate(other),
          params: { downloadId: created.body.downloadId },
        }),
        [404],
      );
      for (const cursor of [created.body.downloadId, randomUUID()]) {
        const page = await accept(
          client.listDownloads({
            headers: authenticate(other),
            query: { cursor },
          }),
          [200],
        );
        expect(page.body).toStrictEqual({ downloads: [], nextCursor: null });
      }
    }
    const conflict = await accept(
      client.createDownload({
        headers: authenticate(otherOrg),
        body: requestBody,
      }),
      [409],
    );
    expect(conflict.body.error).toStrictEqual({
      code: "DOWNLOAD_IN_PROGRESS",
      message: "Another social media download is already in progress",
    });

    // Another user in the same organization has an independent active slot.
    const independent = await accept(
      client.createDownload({
        headers: authenticate(otherUser),
        body: requestBody,
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const ownPage = await accept(
      client.listDownloads({ headers: authenticate(owner), query: {} }),
      [200],
    );
    expect(
      ownPage.body.downloads.map((task) => {
        return task.downloadId;
      }),
    ).toStrictEqual([created.body.downloadId]);
    const foreignCursor = await accept(
      client.listDownloads({
        headers: authenticate(owner),
        query: { cursor: independent.body.downloadId },
      }),
      [200],
    );
    expect(foreignCursor.body).toStrictEqual({
      downloads: [],
      nextCursor: null,
    });
  });

  it("redacts provider diagnostics in agent download lists while retaining requested social content", async () => {
    const owner = actor();
    const client = await configuredClient(owner);
    providerDownloads("failed");
    await accept(
      client.createDownload({
        headers: authenticate(owner),
        body: requestBody,
      }),
      [202],
    );
    await flushWaitUntilForTest();
    const seconds = Math.floor(now() / 1000);
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: owner.userId,
      orgId: owner.orgId,
      runId: randomUUID(),
      capabilities: ["social:read"],
      iat: seconds,
      exp: seconds + 60,
    });
    const page = await accept(
      client.listDownloads({
        headers: { authorization: `Bearer ${token}` },
        query: {},
      }),
      [200],
    );
    expect(page.body.downloads).toMatchObject([
      {
        request: requestBody,
        error: { message: "Okou Social could not prepare the download" },
      },
    ]);
    expect(JSON.stringify(page.body)).not.toMatch(
      /socialkit|providerJobId|downloadUrl/iu,
    );
  });
});
