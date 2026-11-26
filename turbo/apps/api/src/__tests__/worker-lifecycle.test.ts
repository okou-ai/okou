import { randomUUID } from "node:crypto";
import type {
  ExecutionContext,
  Hyperdrive,
  Socket,
  Span,
  Tracing,
} from "@cloudflare/workers-types";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { http, HttpResponse } from "msw";
import { expect, onTestFinished, test } from "vitest";
import { object, string } from "zod";

import { env, mockOptionalEnv } from "../lib/env";
import type { RequestRuntime } from "../lib/request-runtime";
import { now } from "../lib/time";
import { server } from "../mocks/server";
import { onboardingCompleteRoutes } from "../signals/routes/onboarding-complete";
import {
  GOOGLE_IMPERSONATION_URL,
  GOOGLE_VOICE_PROVIDER,
  VERTEX_VOICE_URL,
  vertexVoiceResponse,
} from "../signals/routes/__tests__/helpers/google-voice";
import { createRouteMocks } from "../signals/routes/__tests__/helpers/route-test";
import worker from "../worker";
import { stubTestVercelRuntimeToken } from "./env-stub";
import { accept, testContext } from "./test-context";
import { setupApp } from "./test-helpers";

const context = testContext();

/** A span of the Workers tracing SDK that records nothing. */
class UntracedSpan implements Span {
  get isTraced(): boolean {
    return false;
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  recordException(): void {}
  end(): void {}
}

/** The Workers tracing SDK of a host that traces nothing. */
const untraced: Readonly<Tracing> = {
  enterSpan(_name, callback, ...args) {
    return callback(new UntracedSpan(), ...args);
  },
  startActiveSpan(_name, callback, ...args) {
    return callback(new UntracedSpan(), ...args);
  },
  startSpan() {
    return new UntracedSpan();
  },
  getActiveSpan() {
    return undefined;
  },
  Span: UntracedSpan,
};

/** The Hyperdrive binding for the local database; the pg pool connects over TCP itself. */
function localHyperdrive(): Hyperdrive {
  const connectionString = env("DATABASE_URL");
  const url = new URL(connectionString);
  return {
    connectionString,
    host: url.hostname,
    ip: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connect(): Socket {
      throw new Error("Hyperdrive sockets are not used by the pg pool");
    },
  };
}

/** A Cloudflare Worker host whose registered background work is observed. */
function workerHost(options?: {
  readonly gcpMtls?: RequestRuntime["gcpMtls"];
}) {
  const background: Promise<unknown>[] = [];
  const executionContext: ExecutionContext = {
    waitUntil(work: Promise<unknown>) {
      background.push(work);
    },
    passThroughOnException() {},
    exports: {},
    props: {},
    tracing: untraced,
    abort() {},
  };
  const bindings = {
    HYPERDRIVE: localHyperdrive(),
    ...(options?.gcpMtls ? { GCP_MTLS: options.gcpMtls } : {}),
  };
  return {
    background,
    async request(path: string, init: RequestInit): Promise<Response> {
      return await worker.fetch(
        new Request(`http://api.test${path}`, init),
        bindings,
        executionContext,
      );
    },
  };
}

test("worker-lifecycle-001 serves DB-backed foreground writes through response EOF and a subsequent Worker request", async () => {
  const member = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  const headers = {
    authorization: "Bearer clerk-session",
    "content-type": "application/json",
  };
  const host = workerHost();

  const created = await host.request("/api/chat-threads", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Worker foreground", model: null }),
  });
  const createdBody: unknown = await created.json();
  if (
    typeof createdBody !== "object" ||
    createdBody === null ||
    !("id" in createdBody) ||
    typeof createdBody.id !== "string"
  ) {
    throw new Error("Expected the created thread");
  }
  const metadata = await host.request(
    `/api/chat-threads/${createdBody.id}/metadata`,
    { headers },
  );
  const metadataBody: unknown = await metadata.json();
  const settled = await Promise.allSettled(host.background);

  expect(created.status).toBe(201);
  expect(createdBody).toMatchObject({ title: "Worker foreground" });
  expect(metadata.status).toBe(200);
  expect(metadataBody).toMatchObject({
    id: createdBody.id,
    title: "Worker foreground",
  });
  expect(
    settled.filter((result) => {
      return result.status === "rejected";
    }),
  ).toStrictEqual([]);
});

test("worker-lifecycle-006 uses the certificate binding to call Vertex through the Worker HTTP entrypoint", async () => {
  const member = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  createRouteMocks(context).clerk.session(member.userId, member.orgId);
  context.mocks.s3.send.mockResolvedValue({ ETag: '"ok"' });
  const headers = {
    authorization: "Bearer clerk-session",
    "content-type": "application/json",
  };

  const project = "worker-mtls-test";
  const serviceAccount = `llm-worker@${project}.iam.gserviceaccount.com`;
  const certificateChain = ["Y2VydC1sZWFm", "Y2VydC1yb290"];
  mockOptionalEnv("GCP_LLM_PROJECT_ID", project);
  mockOptionalEnv("GCP_LLM_WORKLOAD_IDENTITY_PROVIDER", GOOGLE_VOICE_PROVIDER);
  mockOptionalEnv("GCP_LLM_SERVICE_ACCOUNT_EMAIL", serviceAccount);
  mockOptionalEnv(
    "GCP_MTLS_CERTIFICATE_CHAIN",
    JSON.stringify(certificateChain),
  );
  stubTestVercelRuntimeToken(undefined);
  onTestFinished(() => {
    stubTestVercelRuntimeToken(undefined);
  });

  const stsRequests: { readonly url: string; readonly body: unknown }[] = [];
  const impersonationAuthHeaders: (string | null)[] = [];
  const vertexAuthHeaders: (string | null)[] = [];

  const gcpMtls: RequestRuntime["gcpMtls"] = {
    fetch(url, init) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      stsRequests.push({
        url,
        body: bodyText ? (JSON.parse(bodyText) as unknown) : null,
      });
      return Promise.resolve(
        HttpResponse.json({
          access_token: "synthetic-mtls-sts-token",
          token_type: "Bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          expires_in: 3600,
        }),
      );
    },
  };

  server.use(
    http.post(GOOGLE_IMPERSONATION_URL, ({ request }) => {
      impersonationAuthHeaders.push(request.headers.get("authorization"));
      return HttpResponse.json({
        accessToken: "synthetic-worker-vertex-token",
        expireTime: new Date(now() + 3_599_000).toISOString(),
      });
    }),
    http.post(VERTEX_VOICE_URL, ({ request }) => {
      vertexAuthHeaders.push(request.headers.get("authorization"));
      return vertexVoiceResponse("Synthetic worker dictation.");
    }),
  );

  const onboardRes = await accept(
    setupApp({ context, routes: onboardingCompleteRoutes })(
      onboardingCompleteContract,
    ).complete({
      headers: { authorization: "Bearer clerk-session" },
      body: {},
    }),
    [200],
  );
  expect(onboardRes.body.onboardingComplete).toBeTruthy();

  const boundHost = workerHost({ gcpMtls });

  const payload = JSON.stringify({ segments: ["synthetic worker dictation"] });
  const first = await boundHost.request("/api/voice-io/polish/segments", {
    method: "POST",
    headers,
    body: payload,
  });
  const firstBody = object({ text: string() }).parse(await first.json());

  const second = await boundHost.request("/api/voice-io/polish/segments", {
    method: "POST",
    headers,
    body: payload,
  });
  const secondBody = object({ text: string() }).parse(await second.json());

  const unboundHost = workerHost();
  const third = await unboundHost.request("/api/voice-io/polish/segments", {
    method: "POST",
    headers,
    body: payload,
  });
  const thirdBody = object({
    error: object({ code: string() }),
  }).parse(await third.json());

  await Promise.allSettled([
    ...boundHost.background,
    ...unboundHost.background,
  ]);

  expect(first.status).toBe(200);
  expect(firstBody).toStrictEqual({ text: "Synthetic worker dictation." });
  expect(second.status).toBe(200);
  expect(secondBody).toStrictEqual({ text: "Synthetic worker dictation." });
  expect(third.status).toBe(503);
  expect(thirdBody.error.code).toBe("NOT_CONFIGURED");

  expect(stsRequests).toStrictEqual([
    {
      url: "https://sts.mtls.googleapis.com/v1/token",
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: `//iam.googleapis.com/${GOOGLE_VOICE_PROVIDER}`,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
        subject_token: JSON.stringify(certificateChain),
      },
    },
  ]);
  expect(impersonationAuthHeaders).toStrictEqual([
    "Bearer synthetic-mtls-sts-token",
  ]);
  expect(vertexAuthHeaders).toStrictEqual([
    "Bearer synthetic-worker-vertex-token",
    "Bearer synthetic-worker-vertex-token",
  ]);
});
