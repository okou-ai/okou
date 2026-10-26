import { randomUUID } from "node:crypto";
import { tracing } from "cloudflare:workers";
import { z } from "zod";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { ExecutionContext, Hyperdrive } from "@cloudflare/workers-types";
import { HttpResponse, http } from "msw";
import { onTestFinished } from "vitest";
import { env, mockOptionalEnv } from "../lib/env";
import { now } from "../lib/time";
import { server } from "../mocks/server";
import { createDeferredPromise } from "../signals/utils";
import { testContext } from "./test-context";
import { stubTestVercelRuntimeToken } from "./env-stub";
import { createRouteMocks } from "../signals/routes/__tests__/helpers/route-test";
import { installDurableUserExportStorage } from "../signals/routes/__tests__/helpers/durable-user-export-storage";
import { mockClerkUsers } from "../signals/routes/__tests__/helpers/clerk-users";
import {
  GOOGLE_IMPERSONATION_URL,
  VERTEX_VOICE_URL,
  mockGoogleVoice,
  vertexVoiceResponse,
} from "../signals/routes/__tests__/helpers/google-voice";
// Do not call setupApp/isolatePg here. The common case-database adapter has no
// selected database and delegates to original.db(), so Worker AsyncLocalStorage
// selects the request's real pg Pool, not a PGlite or test-owned DB handle.
import worker from "../worker";

const context = testContext();
const routeMocks = createRouteMocks(context);

function latch() {
  return createDeferredPromise<void>(context.signal);
}

function actor() {
  const userId = `user_worker_${randomUUID()}`;
  const orgId = `org_worker_${randomUUID()}`;
  routeMocks.clerk.session(userId, orgId);
  mockClerkUsers(context, [
    {
      id: userId,
      firstName: "Worker",
      lastName: "Owner",
      primaryEmailAddressId: "email",
      emailAddresses: [{ id: "email", emailAddress: `${userId}@example.test` }],
      privateMetadata: {},
      publicMetadata: {},
    },
  ]);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: orgId } }],
    totalCount: 1,
  });
}

function caller(gcpMtls?: {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const pending: Promise<unknown>[] = [];
  const failures: unknown[] = [];
  const execution = {
    waitUntil(work: Promise<unknown>) {
      pending.push(work);
      // A Workers host observes rejections immediately, including before EOF.
      work.catch((error: unknown) => {
        failures.push(error);
      });
    },
    passThroughOnException() {},
    props: {},
    exports: {},
    tracing,
    abort() {
      throw new Error("Unexpected Workers host abort");
    },
  } satisfies ExecutionContext;
  const databaseUrl = new URL(env("DATABASE_URL"));
  const binding = {
    connectionString: databaseUrl.toString(),
    host: databaseUrl.hostname,
    ip: databaseUrl.hostname,
    port: Number(databaseUrl.port || "5432"),
    user: databaseUrl.username,
    password: databaseUrl.password,
    database: databaseUrl.pathname.slice(1),
    connect(): never {
      throw new Error(
        "Direct Hyperdrive sockets are not supported by the local host",
      );
    },
  } satisfies Hyperdrive;
  async function settle() {
    let joined = 0;
    while (joined < pending.length) {
      const batch = pending.slice(joined);
      joined = pending.length;
      await Promise.allSettled(batch);
    }
    return failures;
  }
  onTestFinished(async () => {
    await settle();
  });
  return {
    settle,
    request(path: string, init: RequestInit = {}) {
      return worker.fetch(
        new Request(`http://worker.local${path}`, {
          ...init,
          signal: AbortSignal.any([
            context.signal,
            ...(init.signal ? [init.signal] : []),
          ]),
          headers: {
            authorization: "Bearer clerk-session",
            "content-type": "application/json",
            ...init.headers,
          },
        }),
        { HYPERDRIVE: binding, GCP_MTLS: gcpMtls },
        execution,
      );
    },
  };
}

async function createAgent(name: string) {
  const http = caller();
  const response = await http.request("/api/agents", {
    method: "POST",
    body: JSON.stringify({ displayName: name, visibility: "private" }),
  });
  expect(response.status).toBe(201);
  const body = z
    .object({ agentId: z.string(), displayName: z.string() })
    .parse(await response.json());
  expect(body).toMatchObject({ displayName: name });
  await expect(http.settle()).resolves.toStrictEqual([]);
  return body;
}

test("serves DB-backed foreground writes through response EOF and a subsequent Worker request", async () => {
  actor();
  const created = await createAgent("Worker foreground");
  const http = caller();
  const response = await http.request(`/api/agents/${created.agentId}`);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    agentId: created.agentId,
    displayName: "Worker foreground",
  });
  await expect(http.settle()).resolves.toStrictEqual([]);
});

test.each(["eof", "cancel", "abort"] as const)(
  "continues admitted export DB work after response %s while a concurrent request finishes",
  async (completion) => {
    actor();
    await createAgent(`Export via ${completion}`);
    const entered = latch();
    const release = latch();
    context.signal.addEventListener(
      "abort",
      () => {
        if (!release.settled()) {
          release.resolve();
        }
      },
      { once: true },
    );
    let blocked = false;
    const documents: string[] = [];
    installDurableUserExportStorage(context, {
      afterWrite: async (command) => {
        if (command instanceof PutObjectCommand) {
          const body = command.input.Body;
          if (typeof body === "string") {
            documents.push(body);
          } else if (body instanceof Uint8Array) {
            documents.push(Buffer.from(body).toString());
          }
          if (!blocked) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
        }
      },
    });
    const owner = caller();
    const controller = new AbortController();
    onTestFinished(() => {
      controller.abort();
    });
    const response = await owner.request("/api/user/export", {
      method: "POST",
      signal: controller.signal,
    });
    expect(response.status).toBe(202);
    await entered.promise;
    if (completion === "eof") {
      await expect(response.json()).resolves.toMatchObject({
        jobId: expect.any(String),
        status: expect.stringMatching(/pending|running/),
      });
    } else if (completion === "cancel") {
      await response.body!.cancel("caller stopped reading");
    } else {
      controller.abort(new DOMException("Caller disconnected", "AbortError"));
      await response.body!.cancel();
    }
    // Finishing an independent request must not dispose the blocked owner's DB.
    await createAgent("Concurrent foreground");
    release.resolve();
    await expect(owner.settle()).resolves.toStrictEqual([]);
    const observer = caller();
    const status = await observer.request("/api/user/export");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      job: { status: expect.stringMatching(/running|completed/) },
    });
    await expect(observer.settle()).resolves.toStrictEqual([]);
    expect(documents.join("\n")).toContain(`Export via ${completion}`);
  },
);

test("joins cancelled foreground upload work through the provider's multipart cleanup", async () => {
  actor();
  const entered = latch();
  const release = latch();
  context.signal.addEventListener(
    "abort",
    () => {
      if (!release.settled()) {
        release.resolve();
      }
    },
    { once: true },
  );
  const receipts: string[] = [];
  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    if (command instanceof PutObjectCommand) {
      return {};
    }
    if (command instanceof CreateMultipartUploadCommand) {
      entered.resolve();
      await release.promise;
      return { UploadId: "owned-worker-upload" };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      receipts.push(String(command.input.UploadId));
      return {};
    }
    throw new Error("Unexpected external S3 operation");
  });
  const http = caller();
  const controller = new AbortController();
  onTestFinished(() => {
    controller.abort();
  });
  const response = http.request("/api/uploads/prepare", {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({
      filename: "foreground.txt",
      contentType: "text/plain",
      size: 6 * 1024 * 1024,
      multipart: true,
    }),
  });
  await entered.promise;
  controller.abort(new DOMException("Caller disconnected", "AbortError"));
  await createAgent("Surviving foreground");
  release.resolve();
  const cancelled = await response;
  expect(cancelled.status).toBe(500);
  await cancelled.body?.cancel();
  await expect(http.settle()).resolves.toStrictEqual([]);
  expect(receipts).toStrictEqual(["owned-worker-upload"]);
});

test("retains the publicly accepted export job after a background provider receipt fails", async () => {
  actor();
  await createAgent("Export with uncertain provider receipt");
  const entered = latch();
  const release = latch();
  context.signal.addEventListener(
    "abort",
    () => {
      if (!release.settled()) {
        release.resolve();
      }
    },
    { once: true },
  );
  installDurableUserExportStorage(context, {
    afterWrite: async () => {
      entered.resolve();
      await release.promise;
      throw new Error("S3 receipt unavailable");
    },
  });
  const owner = caller();
  const response = await owner.request("/api/user/export", { method: "POST" });
  expect(response.status).toBe(202);
  const accepted = z.object({ jobId: z.string() }).parse(await response.json());
  await entered.promise;
  release.resolve();
  // Export handles provider failure by persisting a durable retry, not rejecting
  // its waitUntil. This does not pretend to cover raw host waitUntil rejection.
  await expect(owner.settle()).resolves.toStrictEqual([]);
  const observer = caller();
  const status = await observer.request("/api/user/export");
  expect(status.status).toBe(200);
  await expect(status.json()).resolves.toMatchObject({
    job: { id: accepted.jobId, status: "pending" },
    canExport: false,
  });
  const repeated = await observer.request("/api/user/export", {
    method: "POST",
  });
  expect(repeated.status).toBe(202);
  await expect(repeated.json()).resolves.toMatchObject({
    jobId: accepted.jobId,
    status: "pending",
  });
  await expect(observer.settle()).resolves.toStrictEqual([]);
});

describe("Google authentication through the Worker HTTP entrypoint", () => {
  const stsUrl = "https://sts.mtls.googleapis.com/v1/token";
  const provider =
    "projects/123456789/locations/global/workloadIdentityPools/worker-preview/providers/x509";
  const certificateChain = ["cHJldmlldy1sZWFm", "cHJldmlldy1jYQ=="];
  const scope = "https://www.googleapis.com/auth/cloud-platform";

  function stsToken() {
    return HttpResponse.json({
      access_token: "worker-sts-token",
      token_type: "Bearer",
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      expires_in: 3600,
    });
  }

  function polish(client: ReturnType<typeof caller>, signal?: AbortSignal) {
    return client.request("/api/voice-io/polish/segments", {
      method: "POST",
      body: JSON.stringify({ segments: ["Synthetic worker dictation."] }),
      signal,
    });
  }

  async function prepareVoice() {
    actor();
    const setup = caller();
    const response = await setup.request("/api/onboarding/complete", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      onboardingComplete: true,
    });
    await expect(setup.settle()).resolves.toStrictEqual([]);

    mockGoogleVoice();
    mockOptionalEnv("GCP_LLM_WORKLOAD_IDENTITY_PROVIDER", provider);
    mockOptionalEnv(
      "GCP_MTLS_CERTIFICATE_CHAIN",
      JSON.stringify(certificateChain),
    );
    server.use(
      http.post(stsUrl, stsToken),
      http.post(VERTEX_VOICE_URL, () => {
        return vertexVoiceResponse("Synthetic worker dictation.");
      }),
    );
  }

  afterEach(() => {
    stubTestVercelRuntimeToken(undefined);
  });

  it("uses the certificate binding for Vertex and reuses credentials only in a configured Worker", async () => {
    await prepareVoice();
    stubTestVercelRuntimeToken(undefined);
    let certificateExchanges = 0;
    const binding = {
      fetch(url: string, init?: RequestInit) {
        certificateExchanges += 1;
        return fetch(url, init);
      },
    };
    server.use(
      http.post(stsUrl, async ({ request }) => {
        expect(request.headers.get("content-type")).toBe("application/json");
        await expect(request.json()).resolves.toStrictEqual({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          audience: `//iam.googleapis.com/${provider}`,
          scope,
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
          subject_token: JSON.stringify(certificateChain),
        });
        return stsToken();
      }),
      http.post(GOOGLE_IMPERSONATION_URL, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer worker-sts-token",
        );
        await expect(request.json()).resolves.toStrictEqual({
          scope: [scope],
          lifetime: "3600s",
        });
        return HttpResponse.json({
          accessToken: "worker-impersonated-token",
          expireTime: new Date(now() + 3_599_000).toISOString(),
        });
      }),
      http.post(VERTEX_VOICE_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer worker-impersonated-token",
        );
        return vertexVoiceResponse("Synthetic worker dictation.");
      }),
    );

    for (let request = 0; request < 2; request += 1) {
      const client = caller(binding);
      const response = await polish(client);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        text: "Synthetic worker dictation.",
      });
      await expect(client.settle()).resolves.toStrictEqual([]);
    }
    expect(certificateExchanges).toBe(1);

    // A warm credential must not let a Worker without its identity binding
    // authenticate, even if a Vercel identity is available in the host.
    stubTestVercelRuntimeToken("synthetic-vercel-runtime-token");
    const unconfigured = caller();
    const rejected = await polish(unconfigured);
    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "NOT_CONFIGURED" },
    });
    await expect(unconfigured.settle()).resolves.toStrictEqual([]);
  });

  it.each([403, 302])(
    "rejects certificate exchange HTTP %i without falling back to Vercel identity",
    async (status) => {
      await prepareVoice();
      server.use(
        http.post(stsUrl, () => {
          return HttpResponse.json(
            { error: "Certificate identity was not accepted" },
            {
              status,
              headers: { Location: "https://unexpected.example/token" },
            },
          );
        }),
      );
      const client = caller({
        fetch(url, init) {
          return fetch(url, init);
        },
      });
      const response = await polish(client);
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VOICE_POLISH_FAILED" },
      });
      await expect(client.settle()).resolves.toStrictEqual([]);
    },
  );

  it("finishes an independent certificate exchange after another caller disconnects", async () => {
    await prepareVoice();
    const firstEntered = latch();
    const firstAborted = latch();
    const secondEntered = latch();
    const releaseSecond = latch();
    let exchanges = 0;
    server.use(
      http.post(stsUrl, async ({ request }) => {
        exchanges += 1;
        if (exchanges === 1) {
          request.signal.addEventListener(
            "abort",
            () => {
              firstAborted.resolve();
            },
            { once: true },
          );
          firstEntered.resolve();
          await firstAborted.promise;
        } else {
          secondEntered.resolve();
          await releaseSecond.promise;
        }
        return stsToken();
      }),
    );
    const binding = {
      fetch(url: string, init?: RequestInit) {
        return fetch(url, init);
      },
    };
    const disconnected = caller(binding);
    const surviving = caller(binding);
    const controller = new AbortController();
    onTestFinished(() => {
      controller.abort();
    });
    const first = polish(disconnected, controller.signal);
    await firstEntered.promise;
    const second = polish(surviving);
    await secondEntered.promise;
    controller.abort(new DOMException("Caller disconnected", "AbortError"));
    await firstAborted.promise;
    releaseSecond.resolve();

    const cancelled = await first;
    expect(cancelled.status).toBe(500);
    await cancelled.body?.cancel();
    await expect(disconnected.settle()).resolves.toStrictEqual([]);
    const completed = await second;
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toStrictEqual({
      text: "Synthetic worker dictation.",
    });
    await expect(surviving.settle()).resolves.toStrictEqual([]);
  });
});
