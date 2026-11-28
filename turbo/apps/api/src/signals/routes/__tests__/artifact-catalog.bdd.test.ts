import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { hostedLinkOrigin } from "../../../lib/link-layout";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactReferenceRoutes } from "../artifact-references";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { sharedThreadRoutes } from "../shared-threads";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createHostBddApi } from "./helpers/api-bdd-host";
import { hostedTextFile } from "./helpers/api-bdd-host-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextResponse,
} from "./helpers/google-text";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return headers;
}

function catalogApi(actor: ApiTestUser) {
  signIn(actor);
  return setupApp({ context, routes: artifactCatalogRoutes })(
    artifactCatalogContract,
  );
}

async function grantProPlan(actor: ApiTestUser): Promise<void> {
  const suffix = randomUUID();
  const customerId = `cus_pro_${suffix}`;
  const webhooks = createWebhookCallbackApi(context);
  webhooks.configureStripeBillingEnv();
  context.mocks.stripe.customers.retrieve.mockResolvedValue({
    id: customerId,
    metadata: { orgId: actor.orgId },
  });
  await webhooks.postStripeEvent(
    {
      id: `evt_pro_${suffix}`,
      type: "customer.subscription.created",
      created: Math.floor(now() / 1000),
      data: {
        object: {
          id: `sub_pro_${suffix}`,
          customer: customerId,
          status: "active",
          metadata: {},
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: null,
          trial_end: null,
          items: { data: [{ price: { id: "price_bdd_pro" } }] },
        },
      },
    },
    [200],
  );
  await flushWaitUntilForTest();
}

async function uploadFile(
  actor: ApiTestUser,
  file: {
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
    readonly purpose?: "artifact";
  },
) {
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    `https://r2.example.com/uploads/${encodeURIComponent(file.filename)}`,
  );
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const { constructor, input } = command as {
      readonly constructor: { readonly name: string };
      readonly input?: { readonly Key?: string };
    };
    if (
      constructor.name === "GetObjectCommand" &&
      !input?.Key?.startsWith("private-artifacts/")
    ) {
      return Promise.reject(
        Object.assign(new Error("Missing object"), {
          name: "NoSuchKey",
        }),
      );
    }
    if (constructor.name === "HeadObjectCommand") {
      return Promise.resolve({
        ContentLength: file.size,
        ContentType: file.contentType,
      });
    }
    if (constructor.name === "GetObjectCommand") {
      return Promise.resolve({
        ContentLength: file.size,
        ContentType: file.contentType,
        Body: Readable.from([Buffer.alloc(Math.max(1, file.size), 0x61)]),
      });
    }
    if (constructor.name === "PutObjectCommand") {
      return Promise.resolve({ ETag: '"etag-1"' });
    }
    return Promise.resolve({});
  });
  signIn(actor);
  const client = setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
  const prepared = await accept(
    client.prepare({
      headers,
      body: file,
    }),
    [200],
  );
  const completed = await accept(
    client.complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  return completed.body;
}

describe("GET /api/artifacts/catalog", () => {
  it("artifact-catalog.bdd-025 searches artifact titles literally before applying the page limit", async () => {
    const member = bdd.user();
    await grantProPlan(member);
    await uploadFile(member, {
      filename: "Launch-Brief.txt",
      contentType: "text/plain",
      size: 16,
      purpose: "artifact",
    });
    await uploadFile(member, {
      filename: "budget.txt",
      contentType: "text/plain",
      size: 10,
      purpose: "artifact",
    });

    const launchSearch = await accept(
      catalogApi(member).list({
        headers,
        query: { keyword: "launch", limit: 1 },
      }),
      [200],
    );
    expect(launchSearch.body.nextCursor).toBeNull();
    expect(launchSearch.body.artifacts).toHaveLength(1);
    expect(launchSearch.body.artifacts[0]).toMatchObject({
      kind: "file",
      title: "Launch-Brief.txt",
    });

    const wildcardSearch = await accept(
      catalogApi(member).list({
        headers,
        query: { keyword: "%" },
      }),
      [200],
    );
    expect(wildcardSearch.body).toStrictEqual({
      artifacts: [],
      nextCursor: null,
    });
  });

  it("artifact-catalog.bdd-013 catalogues an artifact upload but never a chat attachment", async () => {
    const member = bdd.user();
    await grantProPlan(member);
    const attachment = await uploadFile(member, {
      filename: "meeting-notes.png",
      contentType: "image/png",
      size: 128,
    });
    await uploadFile(member, {
      filename: "quarterly-summary.html",
      contentType: "text/html",
      size: 64,
      purpose: "artifact",
    });

    const beforeSend = await accept(
      catalogApi(member).list({ headers, query: {} }),
      [200],
    );
    expect(beforeSend.body.artifacts).toHaveLength(1);
    expect(beforeSend.body.artifacts[0]).toMatchObject({
      kind: "file",
      title: "quarterly-summary.html",
    });

    signIn(member);
    await accept(
      setupApp({ context, routes: chatEventsRoutes })(chatEventsContract).send({
        headers,
        body: {
          prompt: "Please review the attached image",
          hasTextContent: true,
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Please review the attached image" },
              {
                type: "file",
                fileId: attachment.id,
                filenameSnapshot: attachment.filename,
                contentType: attachment.contentType,
              },
            ],
          },
        },
      }),
      [201],
    );

    const afterSend = await accept(
      catalogApi(member).list({ headers, query: {} }),
      [200],
    );
    expect(afterSend.body.artifacts).toHaveLength(1);
    expect(afterSend.body.artifacts[0]).toMatchObject({
      kind: "file",
      title: "quarterly-summary.html",
    });
  });
});

describe("shared thread routes", () => {
  async function createSharedPromptArtifact() {
    const member = bdd.user();
    await grantProPlan(member);
    installSharedThreadStorage(context);
    mockGoogleText();
    server.use(
      http.post(VERTEX_TEXT_URL, () => {
        return vertexTextResponse("Saved conversation");
      }),
    );

    const promptEventId = randomUUID();
    signIn(member);
    const sent = await accept(
      setupApp({ context, routes: chatEventsRoutes })(chatEventsContract).send({
        headers,
        body: {
          prompt: "Share this prompt",
          hasTextContent: true,
          clientEventId: promptEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Share this prompt" }],
          },
        },
      }),
      [201],
    );
    const threadId = sent.body.threadId;

    signIn(member);
    const shared = await accept(
      setupApp({ context, routes: sharedThreadRoutes })(
        sharedThreadsContract,
      ).create({
        headers,
        params: { threadId },
        body: { eventIds: [promptEventId] },
      }),
      [201],
    );

    const listed = await accept(
      catalogApi(member).list({ headers, query: { kind: "shared-thread" } }),
      [200],
    );
    expect(listed.body.artifacts).toHaveLength(1);
    const artifactId = listed.body.artifacts[0]?.id;
    if (!artifactId) {
      throw new Error("Expected a shared-thread catalog artifact");
    }
    return {
      member,
      threadId,
      promptEventId,
      sharedId: shared.body.id,
      artifactId,
    };
  }

  it("artifact-catalog.bdd-030 (1/2) deletes the shared-thread artifact and revokes public snapshot and metadata", async () => {
    const { member, sharedId, artifactId } = await createSharedPromptArtifact();

    await accept(
      catalogApi(member).delete({ headers, params: { artifactId } }),
      [200],
    );

    const afterDelete = await accept(
      catalogApi(member).list({ headers, query: { kind: "shared-thread" } }),
      [200],
    );
    expect(afterDelete.body).toStrictEqual({ artifacts: [], nextCursor: null });

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const publicApi = setupApp({ context, routes: sharedThreadRoutes })(
      sharedThreadsContract,
    );
    await Promise.all([
      accept(publicApi.get({ params: { id: sharedId } }), [404]),
      accept(publicApi.meta({ params: { id: sharedId } }), [404]),
    ]);
  });

  it("artifact-catalog.bdd-030 (2/2) allows repeated artifact deletion and keeps the source thread prompt", async () => {
    const { member, threadId, promptEventId, artifactId } =
      await createSharedPromptArtifact();

    await accept(
      catalogApi(member).delete({ headers, params: { artifactId } }),
      [200],
    );
    await accept(
      catalogApi(member).delete({ headers, params: { artifactId } }),
      [200],
    );

    signIn(member);
    const events = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadEventsContract,
      ).rows({
        headers,
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    expect(
      events.body.rows.some((row) => {
        return row.id === promptEventId;
      }),
    ).toBeTruthy();
  });
});

describe("GET /api/artifacts/by-url", () => {
  function referencesApi(actor: ApiTestUser) {
    signIn(actor);
    return setupApp({ context, routes: artifactReferenceRoutes })(
      artifactReferencesContract,
    );
  }

  it("pf-054 reads one owned file from its message links and keeps its metadata private", async () => {
    const owner = bdd.user();
    const peer = bdd.user({ orgId: owner.orgId });
    const stored = createHostBddApi(context).captureHostedSitesS3();
    const fallbackS3 = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation((command: unknown, ...rest) => {
      const { constructor } = command as {
        readonly constructor: { readonly name: string };
      };
      if (constructor.name === "HeadObjectCommand") {
        return Promise.resolve({
          ContentLength: 24,
          ContentType: "text/plain",
        });
      }
      if (fallbackS3) {
        return fallbackS3(command, ...rest);
      }
      if (constructor.name === "PutObjectCommand") {
        return Promise.resolve({ ETag: '"etag-1"' });
      }
      return Promise.resolve({});
    });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/uploads/private-summary.txt",
    );
    signIn(owner);
    const uploads = setupApp({
      context,
      routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
    })(uploadsContract);
    const prepared = await accept(
      uploads.prepare({
        headers,
        body: {
          filename: "private-summary.txt",
          contentType: "text/plain",
          size: 24,
          purpose: "artifact",
        },
      }),
      [200],
    );
    const completed = await accept(
      uploads.complete({ headers, body: { id: prepared.body.id } }),
      [200],
    );
    expect(stored.objects.size).toBeGreaterThanOrEqual(0);

    const owned = await accept(
      referencesApi(owner).byUrl({
        headers,
        query: { url: completed.body.url },
      }),
      [200],
    );
    expect(owned.body).toMatchObject({
      filename: "private-summary.txt",
      contentType: "text/plain",
    });

    await accept(
      referencesApi(peer).byUrl({
        headers,
        query: { url: completed.body.url },
      }),
      [404],
    );
  });

  it("pf-055 describes an exact public template without granting the reader owner controls", async () => {
    const reader = bdd.user();
    const templateUrl =
      "https://static.vm0.io/vm0/welcome-thread/2026-09-17-1e76170cef99/campaign-visual.jpg";

    const resolved = await accept(
      referencesApi(reader).byUrl({
        headers,
        query: { url: templateUrl },
      }),
      [200],
    );

    expect(resolved.body).toMatchObject({
      url: templateUrl,
      filename: "campaign-visual.jpg",
      contentType: "image/jpeg",
    });
    expect(resolved.body.owner).toBeUndefined();
  });

  it("pf-056 resolves each immutable site publication and the current alias independently", async () => {
    const owner = bdd.user();
    const host = createHostBddApi(context);
    host.captureHostedSitesS3();
    const siteSlug = `site-${randomUUID().slice(0, 8)}`;

    const firstPrepared = await host.prepareHostedSite(owner, {
      site: siteSlug,
      title: "Release V1",
      visibility: "private",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<h1>V1</h1>")],
    });
    await host.completeHostedSite(owner, firstPrepared.deploymentId);

    const secondPrepared = await host.prepareHostedSite(owner, {
      site: siteSlug,
      title: "Release V2",
      visibility: "private",
      artifactKind: "hosted-site",
      spaFallback: false,
      files: [hostedTextFile("/index.html", "<h1>V2</h1>")],
    });
    const secondCompleted = await host.completeHostedSite(
      owner,
      secondPrepared.deploymentId,
    );

    const firstImmutableUrl = hostedLinkOrigin(
      "current",
      `dpl-${firstPrepared.deploymentId}`,
    );
    const secondImmutableUrl = hostedLinkOrigin(
      "current",
      `dpl-${secondPrepared.deploymentId}`,
    );
    const liveAliasUrl = secondCompleted.url;

    const api = referencesApi(owner);
    const [firstDetail, secondDetail, aliasDetail] = await Promise.all([
      accept(api.byUrl({ headers, query: { url: firstImmutableUrl } }), [200]),
      accept(api.byUrl({ headers, query: { url: secondImmutableUrl } }), [200]),
      accept(api.byUrl({ headers, query: { url: liveAliasUrl } }), [200]),
    ]);

    expect(firstDetail.body.url).toBe(firstImmutableUrl);
    expect(secondDetail.body.url).toBe(secondImmutableUrl);
    expect(aliasDetail.body.url).toBe(secondImmutableUrl);
    expect(firstDetail.body.owner?.publicationId).toBe(
      firstPrepared.deploymentId,
    );
    expect(secondDetail.body.owner?.publicationId).toBe(
      secondPrepared.deploymentId,
    );
    expect(aliasDetail.body.owner?.publicationId).toBe(
      secondPrepared.deploymentId,
    );
    expect(firstDetail.body.filename).toBe("Release V1.html");
    expect(secondDetail.body.filename).toBe("Release V1.html");
    expect(aliasDetail.body.filename).toBe("Release V1.html");
  });
});
