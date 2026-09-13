import { voiceIoPolishContract } from "@okouai/api-contracts/contracts/voice-io-polish";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { stubTestVercelRuntimeToken } from "../../../__tests__/env-stub";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { voiceIoPolishRoutes } from "../voice-io-polish";
import { createBddApi } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import {
  GOOGLE_IMPERSONATION_URL,
  GOOGLE_STS_URL,
  GOOGLE_VOICE_PROVIDER,
  VERTEX_VOICE_URL,
  mockGoogleVoice,
  vertexVoiceResponse,
} from "./helpers/google-voice";

const context = testContext();
const mocks = createRouteMocks(context);
const scope = "https://www.googleapis.com/auth/cloud-platform";

function client() {
  return setupApp({
    context,
    routes: voiceIoPolishRoutes,
    rethrowErrors: true,
  })(voiceIoPolishContract);
}
function polish(signal?: AbortSignal) {
  return client().post({
    headers: { authorization: "Bearer clerk-session" },
    body: { text: "Synthetic dictation." },
    ...(signal && { fetchOptions: { signal } }),
  });
}
function stsToken() {
  return {
    access_token: "synthetic-sts-token",
    token_type: "Bearer",
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    expires_in: 3600,
  };
}

beforeEach(async () => {
  mockGoogleVoice();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Expected an organization");
  }
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId, orgRole: "org:admin" },
    {
      [FeatureSwitchKey.VoiceInputV2]: true,
      [FeatureSwitchKey.VoiceGoogleCloud]: true,
    },
  );
  server.use(
    http.post(VERTEX_VOICE_URL, () => {
      return vertexVoiceResponse("Synthetic dictation.");
    }),
  );
});
afterEach(() => {
  stubTestVercelRuntimeToken(undefined);
});

describe("Google voice workload identity through the public API", () => {
  it.each([
    { url: GOOGLE_STS_URL, stage: "sts", bodyFailure: false },
    {
      url: GOOGLE_IMPERSONATION_URL,
      stage: "impersonation",
      bodyFailure: false,
    },
    { url: GOOGLE_STS_URL, stage: "sts", bodyFailure: true },
    {
      url: GOOGLE_IMPERSONATION_URL,
      stage: "impersonation",
      bodyFailure: true,
    },
  ])(
    "reports temporary $stage I/O failure (body=$bodyFailure) without replay",
    async ({ url, bodyFailure }) => {
      let calls = 0;
      server.use(
        http.post(url, () => {
          calls += 1;
          return bodyFailure
            ? new HttpResponse(
                new ReadableStream({
                  start(controller) {
                    controller.error(
                      new Error("private credential response", {
                        cause: { code: "UND_ERR_BODY_TIMEOUT" },
                      }),
                    );
                  },
                }),
              )
            : HttpResponse.error();
        }),
      );
      const response = await accept(polish(), [503]);
      expect(response.body.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(calls).toBe(1);
    },
  );

  it.each([GOOGLE_STS_URL, GOOGLE_IMPERSONATION_URL])(
    "preserves denied auth even when its body fails at %s",
    async (url) => {
      server.use(
        http.post(url, () => {
          return new HttpResponse(
            new ReadableStream({
              start(controller) {
                controller.error(
                  new Error("private denied response", {
                    cause: { code: "ECONNRESET" },
                  }),
                );
              },
            }),
            { status: 403 },
          );
        }),
      );
      const response = await accept(polish(), [502]);
      expect(response.body.error.code).toBe("VOICE_POLISH_FAILED");
    },
  );

  it("bounds an in-flight auth request by its own deadline and permits a later refresh", async () => {
    const deadline = new AbortController();
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 10_000 ? deadline.signal : undefined;
    });
    const entered = createDeferredPromise<void>(context.signal);
    const aborted = createDeferredPromise<void>(context.signal);
    server.use(
      http.post(GOOGLE_STS_URL, async ({ request }) => {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await aborted.promise;
        return HttpResponse.json(stsToken());
      }),
    );
    const pending = polish();
    await entered.promise;
    deadline.abort(new DOMException("Auth deadline", "TimeoutError"));
    await accept(pending, [503]);
    await aborted.promise;
    context.mocks.abortSignal.timeout.mockReset();
    server.use(
      http.post(GOOGLE_STS_URL, () => {
        return HttpResponse.json(stsToken());
      }),
    );
    const recovered = await accept(polish(), [200]);
    expect(recovered.body).toStrictEqual({ text: "Synthetic dictation." });
  });

  it("exchanges the current Vercel identity in Oregon, impersonates the exact account, and reuses short-lived credentials", async () => {
    const google = mockGoogleVoice();
    let exchanges = 0;
    let impersonations = 0;
    let generations = 0;
    server.use(
      http.post(GOOGLE_STS_URL, async ({ request }) => {
        exchanges += 1;
        expect(request.headers.has("authorization")).toBeFalsy();
        expect(
          Object.fromEntries(new URLSearchParams(await request.text())),
        ).toStrictEqual({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          audience: `//iam.googleapis.com/${GOOGLE_VOICE_PROVIDER}`,
          scope,
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
          subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
          subject_token: "synthetic-vercel-runtime-token",
        });
        return HttpResponse.json(stsToken());
      }),
      http.post(GOOGLE_IMPERSONATION_URL, async ({ request }) => {
        impersonations += 1;
        expect(request.url).toBe(
          `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${google.serviceAccount}:generateAccessToken`,
        );
        expect(request.headers.get("authorization")).toBe(
          "Bearer synthetic-sts-token",
        );
        await expect(request.json()).resolves.toStrictEqual({
          scope: [scope],
          lifetime: "3600s",
        });
        return HttpResponse.json({
          accessToken: "impersonated-token",
          expireTime: new Date(now() + 3_599_000).toISOString(),
        });
      }),
      http.post(VERTEX_VOICE_URL, ({ request }) => {
        generations += 1;
        expect(request.headers.get("authorization")).toBe(
          "Bearer impersonated-token",
        );
        return vertexVoiceResponse("Synthetic dictation.");
      }),
    );
    await accept(polish(), [200]);
    await accept(polish(), [200]);
    expect({ exchanges, impersonations, generations }).toStrictEqual({
      exchanges: 1,
      impersonations: 1,
      generations: 2,
    });
  });

  it("accepts Google's clock skew without extending credential reuse", async () => {
    mockNow(new Date("2026-09-11T08:00:00Z"));
    let impersonations = 0;
    server.use(
      http.post(GOOGLE_IMPERSONATION_URL, () => {
        impersonations += 1;
        // Google grants the requested hour using its own clock, one minute
        // ahead of the API host. Its absolute expiry is still legitimate.
        return HttpResponse.json({
          accessToken: "clock-skew-token",
          expireTime: new Date(now() + 3_660_000).toISOString(),
        });
      }),
      http.post(VERTEX_VOICE_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer clock-skew-token",
        );
        return vertexVoiceResponse("Synthetic dictation.");
      }),
    );
    const response = await accept(polish(), [200]);
    expect(response.body).toStrictEqual({ text: "Synthetic dictation." });
    mockNow(new Date("2026-09-11T08:54:59Z"));
    await accept(polish(), [200]);
    expect(impersonations).toBe(1);
    // Preserve the local five-minute refresh margin even though the absolute
    // provider timestamp is later than the requested lifetime on this host.
    mockNow(new Date("2026-09-11T08:55:00Z"));
    await accept(polish(), [200]);
    expect(impersonations).toBe(2);
  });

  it.each([
    ["GCP_LLM_PROJECT_ID", undefined],
    ["GCP_LLM_WORKLOAD_IDENTITY_PROVIDER", undefined],
    ["GCP_LLM_SERVICE_ACCOUNT_EMAIL", undefined],
    ["GCP_LLM_PROJECT_ID", "../other"],
    ["GCP_LLM_WORKLOAD_IDENTITY_PROVIDER", "https://attacker.example/token"],
    ["GCP_LLM_SERVICE_ACCOUNT_EMAIL", "llm-dev@example.com/path"],
  ])(
    "rejects missing or invalid %s before external work",
    async (key, value) => {
      mockOptionalEnv(key, value);
      let externalCalls = 0;
      server.use(
        http.post(/googleapis\.com/u, () => {
          externalCalls += 1;
          return HttpResponse.json({});
        }),
      );
      const response = await accept(polish(), [503]);
      expect(response.body.error.code).toBe("NOT_CONFIGURED");
      expect(externalCalls).toBe(0);
    },
  );

  it("rejects a missing runtime identity without using user OAuth or OpenRouter", async () => {
    stubTestVercelRuntimeToken(undefined);
    let exchanges = 0;
    server.use(
      http.post(GOOGLE_STS_URL, () => {
        exchanges += 1;
        return HttpResponse.json(stsToken());
      }),
    );
    await accept(polish(), [502]);
    expect(exchanges).toBe(0);
  });

  it.each([
    { access_token: "" },
    { token_type: "MAC" },
    { issued_token_type: "urn:ietf:params:oauth:token-type:jwt" },
    { expires_in: -1 },
    { expires_in: "3600" },
    { expires_in: 7200 },
  ])(
    "rejects malformed STS credentials %j without impersonation",
    async (invalid) => {
      let impersonations = 0;
      server.use(
        http.post(GOOGLE_STS_URL, () => {
          return HttpResponse.json({ ...stsToken(), ...invalid });
        }),
        http.post(GOOGLE_IMPERSONATION_URL, () => {
          impersonations += 1;
          return HttpResponse.json({});
        }),
      );
      const failed = await accept(polish(), [502]);
      expect(failed.body.error.code).toBe("VOICE_POLISH_FAILED");
      expect(impersonations).toBe(0);
    },
  );

  it.each([
    { accessToken: "" },
    { expireTime: "not-a-date" },
    { expireTime: "2020-01-01T00:00:00Z" },
    { expireTime: "2999-01-01T00:00:00Z" },
  ])(
    "rejects unusable service-account credentials %j without inference",
    async (invalid) => {
      let generations = 0;
      server.use(
        http.post(GOOGLE_IMPERSONATION_URL, () => {
          return HttpResponse.json({
            accessToken: "synthetic-google-token",
            expireTime: new Date(now() + 3_599_000).toISOString(),
            ...invalid,
          });
        }),
        http.post(VERTEX_VOICE_URL, () => {
          generations += 1;
          return vertexVoiceResponse("Unexpected.");
        }),
      );
      await accept(polish(), [502]);
      expect(generations).toBe(0);
    },
  );

  it.each([GOOGLE_STS_URL, GOOGLE_IMPERSONATION_URL])(
    "bounds credential response bodies at %s",
    async (url) => {
      server.use(
        http.post(url, () => {
          return new HttpResponse("x".repeat(64 * 1024 + 1));
        }),
      );
      const failed = await accept(polish(), [502]);
      expect(failed.body.error.code).toBe("VOICE_POLISH_FAILED");
    },
  );

  it.each([403, 503])(
    "does not retry auth HTTP %i and permits a later request to recover",
    async (status) => {
      let attempts = 0;
      server.use(
        http.post(GOOGLE_IMPERSONATION_URL, () => {
          attempts += 1;
          return attempts === 1
            ? HttpResponse.json(
                { error: { message: "private-provider-detail" } },
                { status },
              )
            : HttpResponse.json({
                accessToken: "synthetic-google-token",
                expireTime: new Date(now() + 3_599_000).toISOString(),
              });
        }),
      );
      const failed = await polish();
      expect(failed.status).toBe(status === 403 ? 502 : 503);
      expect(JSON.stringify(failed.body)).not.toContain(
        "private-provider-detail",
      );
      expect(attempts).toBe(1);
      await accept(polish(), [200]);
      expect(attempts).toBe(2);
      expect(context.mocks.signalTimers.delay).not.toHaveBeenCalled();
    },
  );

  it("refreshes within the five-minute expiry margin and isolates the production account", async () => {
    const google = mockGoogleVoice();
    const start = now();
    mockNow(start);
    const accounts: string[] = [];
    server.use(
      http.post(GOOGLE_IMPERSONATION_URL, ({ request }) => {
        accounts.push(request.url);
        return HttpResponse.json({
          accessToken: `token-${accounts.length}`,
          expireTime: new Date(now() + 3_600_000).toISOString(),
        });
      }),
    );
    await accept(polish(), [200]);
    mockNow(start + 3_200_000);
    await accept(polish(), [200]);
    expect(accounts).toHaveLength(1);
    mockNow(start + 3_301_000);
    await accept(polish(), [200]);
    expect(accounts).toHaveLength(2);
    const productionAccount = `llm-prod@${google.project}.iam.gserviceaccount.com`;
    mockOptionalEnv("GCP_LLM_SERVICE_ACCOUNT_EMAIL", productionAccount);
    await accept(polish(), [200]);
    expect(accounts).toHaveLength(3);
    expect(accounts[2]).toContain(productionAccount);
  });

  it("shares one in-flight refresh across concurrent public requests", async () => {
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let exchanges = 0;
    server.use(
      http.post(GOOGLE_STS_URL, async () => {
        exchanges += 1;
        if (exchanges === 1) {
          entered.resolve();
        }
        await release.promise;
        return HttpResponse.json(stsToken());
      }),
    );
    const first = polish();
    const second = polish();
    await entered.promise;
    release.resolve();
    await Promise.all([accept(first, [200]), accept(second, [200])]);
    expect(exchanges).toBe(1);
  });

  it.each([GOOGLE_STS_URL, GOOGLE_IMPERSONATION_URL])(
    "cancels an abandoned exchange at %s and allows a replacement request",
    async (url) => {
      const controller = new AbortController();
      const entered = createDeferredPromise<void>(context.signal);
      const aborted = createDeferredPromise<void>(context.signal);
      let calls = 0;
      server.use(
        http.post(url, async ({ request }) => {
          calls += 1;
          if (calls === 1) {
            request.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
              },
              { once: true },
            );
            entered.resolve();
            await aborted.promise;
          }
          return HttpResponse.json(
            typeof url === "string"
              ? stsToken()
              : {
                  accessToken: "synthetic-google-token",
                  expireTime: new Date(now() + 3_599_000).toISOString(),
                },
          );
        }),
      );
      const first = polish(controller.signal);
      const cancelAfterExchangeStarts = async () => {
        await entered.promise;
        controller.abort();
      };
      await Promise.all([
        expect(first).rejects.toMatchObject({ name: "AbortError" }),
        cancelAfterExchangeStarts(),
      ]);
      await aborted.promise;
      await accept(polish(), [200]);
      expect(calls).toBe(2);
    },
  );
});
