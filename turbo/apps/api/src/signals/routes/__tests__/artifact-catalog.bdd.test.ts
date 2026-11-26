import { randomUUID } from "node:crypto";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { sharedThreadRoutes } from "../shared-threads";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
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
    const { constructor } = command as {
      readonly constructor: { readonly name: string };
    };
    if (constructor.name === "HeadObjectCommand") {
      return Promise.resolve({
        ContentLength: file.size,
        ContentType: file.contentType,
      });
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
  it("artifact-catalog.bdd-030 deleting a shared conversation from artifacts revokes its shared link", async () => {
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
    await accept(publicApi.get({ params: { id: shared.body.id } }), [404]);
    await accept(publicApi.meta({ params: { id: shared.body.id } }), [404]);

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
