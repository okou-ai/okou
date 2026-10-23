import {
  purchaseToolCredits,
  claimPublicToolRun,
} from "./helpers/public-tool-actor";
import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { socialContract } from "@okouai/api-contracts/contracts/social";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { env, mockEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { socialRoutes } from "../social";
import {
  createBddApi,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
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

async function billingStatus(user: ReturnType<typeof actor>) {
  const response = await accept(
    setupAppWithRoutes({ context, routes: billingStatusRoutes })(
      billingStatusContract,
    ).get({ headers: authenticate(user) }),
    [200],
  );
  return response.body;
}

interface FundedDiscoveryActor {
  readonly actor: ReturnType<typeof actor>;
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly invoiceId: string;
}

async function configuredFixture(user: ReturnType<typeof actor>) {
  createBddApi(context).acceptAgentStorageWrites();
  const storageBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");
  const fundedOrgs = new Map<string, FundedDiscoveryActor>();
  const runCleanups: (() => Promise<void>)[] = [];
  const owner = createFixtureOperationOwner(async () => {
    for (const cleanup of runCleanups) {
      await cleanup();
    }
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", storageBucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
    context.mocks.s3.send.mockResolvedValue({
      Contents: [],
      IsTruncated: false,
    });
    context.mocks.ably.publish.mockResolvedValue(undefined);
    await flushWaitUntilForTest();

    const webhooks = createWebhookCallbackApi(context);
    webhooks.configureStripeBillingEnv();
    webhooks.configureClerkWebhookSecret();
    for (const [orgId, owned] of fundedOrgs) {
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: owned.subscriptionId,
        status: "active",
        metadata: {},
        items: { data: [{ price: { id: "price_bdd_pro" } }] },
      });
      context.mocks.stripe.subscriptions.update.mockResolvedValue({
        id: owned.subscriptionId,
      });
      context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
        id: owned.subscriptionId,
        status: "canceled",
      });
      context.mocks.stripe.invoices.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      webhooks.verifyNextClerkWebhook({
        type: "organization.deleted",
        data: { id: orgId },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
    }
  });

  async function fund(fundedActor: ReturnType<typeof actor>) {
    if (fundedOrgs.has(fundedActor.orgId)) {
      throw new Error("Discovery organization already funded");
    }
    const suffix = randomUUID();
    const owned: FundedDiscoveryActor = {
      actor: fundedActor,
      customerId: `cus_social_discovery_${suffix}`,
      subscriptionId: `sub_social_discovery_${suffix}`,
      invoiceId: `in_social_discovery_${suffix}`,
    };
    fundedOrgs.set(fundedActor.orgId, owned);

    await owner.run(async () => {
      await accept(
        createBddApi(context).completeOnboarding(fundedActor),
        [200],
      );
      expect((await billingStatus(fundedActor)).credits).toBe(0);
      const webhooks = createWebhookCallbackApi(context);
      webhooks.configureStripeBillingEnv();
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: owned.customerId,
        metadata: { orgId: fundedActor.orgId },
      });
      const subscription = {
        id: owned.subscriptionId,
        customer: owned.customerId,
        status: "active",
        metadata: {},
        cancel_at_period_end: false,
        cancel_at: null,
        schedule: null,
        trial_end: null,
        items: { data: [{ price: { id: "price_bdd_pro" } }] },
      };
      await webhooks.postStripeEvent(
        {
          id: `evt_social_discovery_created_${suffix}`,
          type: "customer.subscription.created",
          created: Math.floor(now() / 1000),
          data: { object: subscription },
        },
        [200],
      );
      await webhooks.postStripeEvent(
        {
          id: `evt_social_discovery_updated_${suffix}`,
          type: "customer.subscription.updated",
          created: Math.floor(now() / 1000),
          data: { object: subscription },
        },
        [200],
      );
      await expect(billingStatus(fundedActor)).resolves.toMatchObject({
        tier: "pro",
        status: "active",
        credits: 0,
      });
      await purchaseToolCredits(context, fundedActor, {
        credits: 10_000,
        customerId: owned.customerId,
        invoiceId: owned.invoiceId,
      });
      await expect(billingStatus(fundedActor)).resolves.toMatchObject({
        tier: "pro",
        status: "active",
        credits: 10_000,
      });
    });
  }

  await fund(user);
  mockEnv("OKOU_SOCIAL_SOCIALKIT_TOKEN", "test-socialkit-key");
  return {
    client: setupAppWithRoutes({
      context,
      routes: socialRoutes,
    })(socialContract),
    run: owner.run,
    fund,
    registerRunCleanup(cleanup: () => Promise<void>) {
      runCleanups.push(cleanup);
    },
  };
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

const signedDownloadUrl =
  "https://socialkit-downloads.s3.amazonaws.com/file.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=test&X-Amz-Expires=3600";

function readyProviderDownload(downloadUrl: () => string) {
  const providerJobId = randomUUID();
  let starts = 0;
  server.use(
    http.post(`${providerBase}/v2/youtube/download`, () => {
      starts += 1;
      return HttpResponse.json({ jobId: providerJobId, status: "queued" });
    }),
    http.get(`${providerBase}/v2/downloads/${providerJobId}`, () => {
      return HttpResponse.json({
        jobId: providerJobId,
        status: "ready",
        platform: "youtube",
        downloadUrl: downloadUrl(),
        expiresIn: 3600,
        durationSeconds: 60,
        fileSizeMB: 1,
        creditsCost: 4,
        billed: true,
        quality: "480p",
        format: "mp4",
        title: "Public clip",
      });
    }),
  );
  return {
    starts: () => {
      return starts;
    },
  };
}

describe("social download link delivery", () => {
  it("completes on an authorized read and refreshes an expired link without charging twice", async () => {
    const owner = actor();
    const fixture = await configuredFixture(owner);
    await fixture.run(async () => {
      const startedAt = now();
      mockNow(startedAt);
      let providerUrl = signedDownloadUrl;
      readyProviderDownload(() => {
        return providerUrl;
      });
      const beforeCredits = (await billingStatus(owner)).credits;
      const created = await accept(
        fixture.client.createDownload({
          headers: authenticate(owner),
          body: requestBody,
        }),
        [202],
      );
      expect(created.body).toMatchObject({
        status: "processing",
        download: null,
        billing: null,
      });
      const pending = await accept(
        fixture.client.listDownloads({
          headers: authenticate(owner),
          query: {},
        }),
        [200],
      );
      expect(pending.body.downloads).toMatchObject([
        {
          downloadId: created.body.downloadId,
          status: "processing",
          request: requestBody,
        },
      ]);
      expect((await billingStatus(owner)).credits).toBe(beforeCredits);

      const params = { downloadId: created.body.downloadId };
      const otherUser = actor({ orgId: owner.orgId });
      await accept(
        fixture.client.getDownload({
          headers: authenticate(otherUser),
          params,
        }),
        [404],
      );
      expect((await billingStatus(owner)).credits).toBe(beforeCredits);
      const completed = await accept(
        fixture.client.getDownload({ headers: authenticate(owner), params }),
        [200],
      );
      expect(completed.body).toMatchObject({
        downloadId: created.body.downloadId,
        status: "completed",
        requested: { quality: "720p", format: "mp4" },
        delivered: { quality: "480p", format: "mp4" },
        download: {
          url: signedDownloadUrl,
          expiresAt: new Date(startedAt + 3_600_000).toISOString(),
        },
        billing: { quantity: 4 },
        error: null,
      });
      expect(completed.headers.get("Cache-Control")).toBe("private, no-store");
      expect(completed.body.billing?.creditsCharged).toBeGreaterThan(0);
      const chargedCredits = completed.body.billing?.creditsCharged;
      expect((await billingStatus(owner)).credits).toBe(
        beforeCredits - (chargedCredits ?? 0),
      );
      const repeated = await accept(
        fixture.client.getDownload({ headers: authenticate(owner), params }),
        [200],
      );
      expect(repeated.body).toMatchObject({
        status: "completed",
        download: completed.body.download,
        billing: completed.body.billing,
      });

      mockNow(startedAt + 3_601_000);
      providerUrl = signedDownloadUrl.replace(
        "X-Amz-Signature=test",
        "X-Amz-Signature=test-fresh",
      );
      const refreshed = await accept(
        fixture.client.getDownload({ headers: authenticate(owner), params }),
        [200],
      );
      expect(refreshed.body).toMatchObject({
        downloadId: created.body.downloadId,
        status: "completed",
        delivered: { quality: "480p", format: "mp4" },
        download: {
          url: providerUrl,
          expiresAt: new Date(startedAt + 7_201_000).toISOString(),
        },
        billing: completed.body.billing,
        error: null,
      });
      expect((await billingStatus(owner)).credits).toBe(
        beforeCredits - (chargedCredits ?? 0),
      );
      const listed = await accept(
        fixture.client.listDownloads({
          headers: authenticate(owner),
          query: {},
        }),
        [200],
      );
      expect(listed.body.downloads).toMatchObject([
        { downloadId: created.body.downloadId, status: "completed" },
      ]);
      expect(listed.body.downloads[0]?.download).toBeNull();
      expect(JSON.stringify(listed.body)).not.toContain(signedDownloadUrl);
      expect(JSON.stringify(listed.body)).not.toContain(providerUrl);

      server.use(
        http.get(`${providerBase}/v2/downloads/:jobId`, () => {
          return HttpResponse.json({ error: "unavailable" }, { status: 503 });
        }),
      );
      const unavailable = await accept(
        fixture.client.getDownload({ headers: authenticate(owner), params }),
        [200],
      );
      expect(unavailable.body).toMatchObject({
        status: "completed",
        download: null,
        billing: completed.body.billing,
        error: { retryable: true, billed: true },
      });
      expect((await billingStatus(owner)).credits).toBe(
        beforeCredits - (chargedCredits ?? 0),
      );
    });
  });

  it("recovers an unavailable link on the same paid download without charging twice", async () => {
    const owner = actor();
    const fixture = await configuredFixture(owner);
    await fixture.run(async () => {
      let providerUrl = "https://attacker.example/private.mp4";
      const provider = readyProviderDownload(() => {
        return providerUrl;
      });
      const beforeCredits = (await billingStatus(owner)).credits;
      const created = await accept(
        fixture.client.createDownload({
          headers: authenticate(owner),
          body: requestBody,
        }),
        [202],
      );
      const params = { downloadId: created.body.downloadId };
      const failed = await accept(
        fixture.client.getDownload({ headers: authenticate(owner), params }),
        [200],
      );
      expect(failed.body).toMatchObject({
        status: "link_failed",
        download: null,
        billing: { quantity: 4 },
        error: { billed: true, retryable: true },
      });
      expect(failed.body.billing?.creditsCharged).toBeGreaterThan(0);
      const afterFailure = (await billingStatus(owner)).credits;
      expect(afterFailure).toBe(
        beforeCredits - (failed.body.billing?.creditsCharged ?? 0),
      );
      providerUrl = signedDownloadUrl;
      mockNow(now() + 61_000);
      const recovered = await accept(
        fixture.client.getDownload({ headers: authenticate(owner), params }),
        [200],
      );
      expect(recovered.body).toMatchObject({
        downloadId: created.body.downloadId,
        status: "completed",
        download: { url: signedDownloadUrl },
        billing: failed.body.billing,
        error: null,
      });
      expect((await billingStatus(owner)).credits).toBe(afterFailure);
      expect(provider.starts()).toBe(1);
    });
  });

  it("preserves the exact signed provider URL for an authorized agent", async () => {
    const owner = actor();
    const fixture = await configuredFixture(owner);
    await fixture.run(async () => {
      readyProviderDownload(() => {
        return signedDownloadUrl;
      });
      const { token } = await claimPublicToolRun(
        context,
        owner,
        fixture.registerRunCleanup,
      );
      const headers = { authorization: `Bearer ${token}` };
      const created = await accept(
        fixture.client.createDownload({
          headers,
          body: requestBody,
        }),
        [202],
      );
      expect(created.body.status).toBe("processing");
      const completed = await accept(
        fixture.client.getDownload({
          headers,
          params: { downloadId: created.body.downloadId },
        }),
        [200],
      );
      expect(completed.body).toMatchObject({
        status: "completed",
        delivered: { quality: "480p", format: "mp4" },
        download: { url: signedDownloadUrl },
        error: null,
      });
      expect(completed.body.download?.url).toBe(signedDownloadUrl);
    });
  });

  it.each([
    {
      name: "the configured provider key",
      url: `${signedDownloadUrl}&token=test-socialkit-key`,
    },
    {
      name: "an access_key query parameter",
      url: `${signedDownloadUrl}&access_key=synthetic-other-provider-key`,
    },
    {
      name: "an untrusted host",
      url: "https://attacker.example/file.mp4?X-Amz-Signature=test",
    },
    {
      name: "a bucket-host suffix attack",
      url: "https://socialkit-downloads.s3.amazonaws.com.attacker.example/file.mp4?X-Amz-Signature=test",
    },
    {
      name: "an insecure transport",
      url: signedDownloadUrl.replace("https:", "http:"),
    },
    {
      name: "URL credentials",
      url: signedDownloadUrl.replace("https://", "https://user:password@"),
    },
  ])(
    "rejects a provider link containing $name without exposing credentials",
    async ({ url }) => {
      const owner = actor();
      const fixture = await configuredFixture(owner);
      await fixture.run(async () => {
        readyProviderDownload(() => {
          return url;
        });
        const created = await accept(
          fixture.client.createDownload({
            headers: authenticate(owner),
            body: requestBody,
          }),
          [202],
        );
        const failed = await accept(
          fixture.client.getDownload({
            headers: authenticate(owner),
            params: { downloadId: created.body.downloadId },
          }),
          [200],
        );
        expect(failed.body).toMatchObject({
          error: {
            code: expect.any(String),
            message: expect.any(String),
          },
        });
        expect(failed.body.status).not.toBe("completed");
        expect(failed.body.download).toBeNull();
        const serialized = JSON.stringify(failed.body);
        expect(serialized).not.toContain("test-socialkit-key");
        expect(serialized).not.toContain("synthetic-other-provider-key");
        expect(serialized).not.toContain("access_key");
      });
    },
  );
});

describe("social download discovery", () => {
  it("requires authentication and an organization before listing downloads", async () => {
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
    const empty = await accept(
      client.listDownloads({ headers: authenticate(owner), query: {} }),
      [200],
    );
    expect(empty.body).toStrictEqual({ downloads: [], nextCursor: null });
  });

  it("bounds default pages and continues after exact database anchors despite new insertions", async () => {
    const owner = actor();
    const fixture = await configuredFixture(owner);
    const client = fixture.client;
    await fixture.run(async () => {
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
        await accept(
          client.getDownload({
            headers: authenticate(owner),
            params: { downloadId: created.body.downloadId },
          }),
          [200],
        );
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
        requested: { quality: "720p", format: "mp4" },
        delivered: { quality: null, format: null },
        resumeCommand: null,
        error: { retryable: false, billed: false },
      });

      const inserted = await accept(
        client.createDownload({
          headers: authenticate(owner),
          body: requestBody,
        }),
        [202],
      );
      await accept(
        client.getDownload({
          headers: authenticate(owner),
          params: { downloadId: inserted.body.downloadId },
        }),
        [200],
      );
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
  });

  it("recovers submitting and processing task identities without causing provider work", async () => {
    const owner = actor();
    const fixture = await configuredFixture(owner);
    const client = fixture.client;
    await fixture.run(async () => {
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
      const creating = fixture.run(() => {
        return client.createDownload({
          headers: authenticate(owner),
          body: requestBody,
        });
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
      expect(created.body.downloadId).toBe(task?.downloadId);
      const pollsBefore = provider.polls();
      const processing = await accept(
        client.listDownloads({
          headers: authenticate(owner),
          query: { status: "active" },
        }),
        [200],
      );
      expect(processing.body.downloads).toMatchObject([
        {
          downloadId: created.body.downloadId,
          status: "processing",
          resumeCommand: `okou data social download --resume ${created.body.downloadId}`,
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
    });
  });

  it("isolates listing, cursor anchors, reads, and active conflicts across users and organizations", async () => {
    const owner = actor();
    const fixture = await configuredFixture(owner);
    const client = fixture.client;
    await fixture.run(async () => {
      providerDownloads("processing");
      const created = await accept(
        client.createDownload({
          headers: authenticate(owner),
          body: requestBody,
        }),
        [202],
      );
      const otherUser = actor({ orgId: owner.orgId });

      const otherOrg = actor({ userId: owner.userId });
      await fixture.fund(otherOrg);
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
  });

  it("redacts provider diagnostics in agent download lists while retaining requested social content", async () => {
    const owner = actor();
    const fixture = await configuredFixture(owner);
    const client = fixture.client;
    await fixture.run(async () => {
      providerDownloads("failed");
      const created = await accept(
        client.createDownload({
          headers: authenticate(owner),
          body: requestBody,
        }),
        [202],
      );
      await accept(
        client.getDownload({
          headers: authenticate(owner),
          params: { downloadId: created.body.downloadId },
        }),
        [200],
      );
      const { token } = await claimPublicToolRun(
        context,
        owner,
        fixture.registerRunCleanup,
      );
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
});
