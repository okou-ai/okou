import { voiceIoPolishSegmentsContract } from "@okouai/api-contracts/contracts/voice-io-polish";
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
import { createRouteMocks } from "./helpers/route-test";
import {
  GOOGLE_IMPERSONATION_URL,
  GOOGLE_STS_URL,
  VERTEX_VOICE_URL,
  mockGoogleVoice,
  vertexVoiceResponse,
} from "./helpers/google-voice";

const context = testContext();
const mocks = createRouteMocks(context);
const endpoints = [
  { stage: "sts", url: GOOGLE_STS_URL },
  { stage: "impersonation", url: GOOGLE_IMPERSONATION_URL },
] as const;

function polish(signal?: AbortSignal) {
  return setupApp({
    context,
    routes: voiceIoPolishRoutes,
    rethrowErrors: true,
  })(voiceIoPolishSegmentsContract).post({
    headers: { authorization: "Bearer clerk-session" },
    body: { segments: ["Synthetic dictation."] },
    ...(signal && { fetchOptions: { signal } }),
  });
}

function token(stage: "sts" | "impersonation") {
  return HttpResponse.json(
    stage === "sts"
      ? {
          access_token: "synthetic-sts-token",
          token_type: "Bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          expires_in: 3600,
        }
      : {
          accessToken: "synthetic-google-token",
          expireTime: new Date(now() + 3_599_000).toISOString(),
        },
  );
}

beforeEach(async () => {
  mockGoogleVoice();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  context.mocks.signalTimers.delay.mockResolvedValue(undefined);
  const actor = createBddApi(context).user();
  if (!actor.orgId) {
    throw new Error("Expected an organization");
  }
  await createBddApi(context).completeOnboarding(actor);
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  server.use(
    http.post(VERTEX_VOICE_URL, () => {
      return vertexVoiceResponse("Recovered dictation.");
    }),
  );
});

afterEach(() => {
  stubTestVercelRuntimeToken(undefined);
});

describe("Google token recovery through the public voice API", () => {
  it.each(
    endpoints.flatMap((endpoint) => {
      return [429, 500, 502, 503, 504].map((status) => {
        return { ...endpoint, status };
      });
    }),
  )(
    "recovers $stage HTTP $status before inference",
    async ({ stage, url, status }) => {
      let attempts = 0;
      let generations = 0;
      server.use(
        http.post(url, () => {
          attempts += 1;
          return attempts === 1
            ? new HttpResponse("private-provider-detail", { status })
            : token(stage);
        }),
        http.post(VERTEX_VOICE_URL, () => {
          generations += 1;
          return vertexVoiceResponse("Recovered dictation.");
        }),
      );
      const response = await accept(polish(), [200]);
      expect(response.body).toStrictEqual({ text: "Recovered dictation." });
      expect(attempts).toBe(2);
      expect(generations).toBe(1);
    },
  );

  it.each(
    endpoints.flatMap((endpoint) => {
      return [false, true].map((bodyFailure) => {
        return { ...endpoint, bodyFailure };
      });
    }),
  )(
    "recovers $stage transport failure (body=$bodyFailure)",
    async ({ stage, url, bodyFailure }) => {
      let attempts = 0;
      server.use(
        http.post(url, () => {
          attempts += 1;
          if (attempts > 1) {
            return token(stage);
          }
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
      const response = await accept(polish(), [200]);
      expect(response.body).toStrictEqual({ text: "Recovered dictation." });
      expect(attempts).toBe(2);
    },
  );

  it("retains the successful STS exchange while recovering impersonation", async () => {
    let exchanges = 0;
    let impersonations = 0;
    let generations = 0;
    server.use(
      http.post(GOOGLE_STS_URL, () => {
        exchanges += 1;
        return token("sts");
      }),
      http.post(GOOGLE_IMPERSONATION_URL, async ({ request }) => {
        impersonations += 1;
        expect(request.headers.get("authorization")).toBe(
          "Bearer synthetic-sts-token",
        );
        await expect(request.json()).resolves.toStrictEqual({
          scope: ["https://www.googleapis.com/auth/cloud-platform"],
          lifetime: "3600s",
        });
        return impersonations < 3
          ? new HttpResponse(null, { status: 503 })
          : token("impersonation");
      }),
      http.post(VERTEX_VOICE_URL, () => {
        generations += 1;
        return vertexVoiceResponse("Recovered dictation.");
      }),
    );
    await accept(polish(), [200]);
    expect({ exchanges, impersonations, generations }).toStrictEqual({
      exchanges: 1,
      impersonations: 3,
      generations: 1,
    });
  });

  it.each(endpoints)(
    "bounds $stage attempts and allows a later request to recover",
    async ({ stage, url }) => {
      let attempts = 0;
      let generations = 0;
      server.use(
        http.post(url, () => {
          attempts += 1;
          return attempts <= 3
            ? new HttpResponse("private-provider-detail", { status: 503 })
            : token(stage);
        }),
        http.post(VERTEX_VOICE_URL, () => {
          generations += 1;
          return vertexVoiceResponse("Recovered dictation.");
        }),
      );
      const failed = await accept(polish(), [503]);
      expect(failed.body.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(JSON.stringify(failed.body)).not.toContain(
        "private-provider-detail",
      );
      expect(attempts).toBe(3);
      expect(generations).toBe(0);
      await accept(polish(), [200]);
      expect(attempts).toBe(4);
      expect(generations).toBe(1);
    },
  );

  it.each(
    endpoints.flatMap((endpoint) => {
      return [400, 401, 403, 404, 501].map((status) => {
        return { ...endpoint, status };
      });
    }),
  )("does not retry $stage HTTP $status", async ({ url, status }) => {
    let attempts = 0;
    server.use(
      http.post(url, () => {
        attempts += 1;
        return new HttpResponse("private-provider-detail", { status });
      }),
    );
    const failed = await accept(polish(), [status >= 500 ? 503 : 502]);
    expect(JSON.stringify(failed.body)).not.toContain(
      "private-provider-detail",
    );
    expect(attempts).toBe(1);
  });

  it.each(endpoints)(
    "does not retry malformed successful $stage output",
    async ({ url }) => {
      let attempts = 0;
      server.use(
        http.post(url, () => {
          attempts += 1;
          return new HttpResponse("not-json");
        }),
      );
      const failed = await accept(polish(), [502]);
      expect(failed.body.error.code).toBe("VOICE_POLISH_FAILED");
      expect(attempts).toBe(1);
    },
  );

  it("backs off successive token requests with independent jitter", async () => {
    mockNow(new Date("2026-10-10T00:00:00Z"));
    const requestTimes: number[] = [];
    context.mocks.signalTimers.delay.mockImplementation((milliseconds) => {
      mockNow(now() + milliseconds);
      return Promise.resolve();
    });
    server.use(
      http.post(GOOGLE_IMPERSONATION_URL, () => {
        requestTimes.push(now());
        return requestTimes.length < 3
          ? new HttpResponse(null, { status: 503 })
          : token("impersonation");
      }),
    );
    await accept(polish(), [200]);
    expect(requestTimes).toHaveLength(3);
    const firstWait = requestTimes[1]! - requestTimes[0]!;
    const secondWait = requestTimes[2]! - requestTimes[1]!;
    expect(firstWait).toBeGreaterThanOrEqual(1000);
    expect(firstWait).toBeLessThan(2000);
    expect(secondWait).toBeGreaterThanOrEqual(2000);
    expect(secondWait).toBeLessThan(3000);
  });

  it.each(["seconds", "http-date"])(
    "honors a Retry-After %s minimum before retrying",
    async (kind) => {
      mockNow(new Date("2026-10-10T00:00:00Z"));
      const retryAfter =
        kind === "seconds" ? "4" : new Date(now() + 4000).toUTCString();
      const requestTimes: number[] = [];
      context.mocks.signalTimers.delay.mockImplementation((milliseconds) => {
        mockNow(now() + milliseconds);
        return Promise.resolve();
      });
      server.use(
        http.post(GOOGLE_IMPERSONATION_URL, () => {
          requestTimes.push(now());
          return requestTimes.length === 1
            ? new HttpResponse(null, {
                status: 429,
                headers: { "Retry-After": retryAfter },
              })
            : token("impersonation");
        }),
      );
      await accept(polish(), [200]);
      expect(requestTimes).toHaveLength(2);
      expect(requestTimes[1]! - requestTimes[0]!).toBe(4000);
    },
  );

  it.each(["seconds", "http-date"])(
    "does not bypass a Retry-After %s outside the refresh budget",
    async (kind) => {
      mockNow(new Date("2026-10-10T00:00:00Z"));
      const retryAfter =
        kind === "seconds" ? "60" : new Date(now() + 60_000).toUTCString();
      let attempts = 0;
      server.use(
        http.post(GOOGLE_IMPERSONATION_URL, () => {
          attempts += 1;
          return new HttpResponse(null, {
            status: 429,
            headers: { "Retry-After": retryAfter },
          });
        }),
      );
      const failed = await accept(polish(), [503]);
      expect(failed.body.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(attempts).toBe(1);
    },
  );

  it("does not start another attempt after the original budget elapses during backoff", async () => {
    mockNow(new Date("2026-10-10T00:00:00Z"));
    let attempts = 0;
    context.mocks.signalTimers.delay.mockImplementation(() => {
      mockNow(now() + 10_000);
      return Promise.resolve();
    });
    server.use(
      http.post(GOOGLE_IMPERSONATION_URL, () => {
        attempts += 1;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const failed = await accept(polish(), [503]);
    expect(failed.body.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(attempts).toBe(1);
  });

  it("shares the original auth deadline with an in-flight retry and permits a later refresh", async () => {
    const deadline = new AbortController();
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 10_000 ? deadline.signal : undefined;
    });
    const entered = createDeferredPromise<void>(context.signal);
    const aborted = createDeferredPromise<void>(context.signal);
    let attempts = 0;
    server.use(
      http.post(GOOGLE_IMPERSONATION_URL, async ({ request }) => {
        attempts += 1;
        if (attempts === 1) {
          return new HttpResponse(null, { status: 503 });
        }
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await aborted.promise;
        return token("impersonation");
      }),
    );
    const pending = polish();
    await entered.promise;
    deadline.abort(new DOMException("Auth deadline", "TimeoutError"));
    const failed = await accept(pending, [503]);
    expect(failed.body.error.code).toBe("PROVIDER_UNAVAILABLE");
    await aborted.promise;
    expect(attempts).toBe(2);
    context.mocks.abortSignal.timeout.mockReset();
    server.use(
      http.post(GOOGLE_IMPERSONATION_URL, () => {
        return token("impersonation");
      }),
    );
    await accept(polish(), [200]);
  });

  it("shares one retrying token refresh across concurrent public requests", async () => {
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let exchanges = 0;
    let impersonations = 0;
    let generations = 0;
    context.mocks.signalTimers.delay.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    server.use(
      http.post(GOOGLE_STS_URL, () => {
        exchanges += 1;
        return token("sts");
      }),
      http.post(GOOGLE_IMPERSONATION_URL, () => {
        impersonations += 1;
        return impersonations === 1
          ? new HttpResponse(null, { status: 503 })
          : token("impersonation");
      }),
      http.post(VERTEX_VOICE_URL, () => {
        generations += 1;
        return vertexVoiceResponse("Recovered dictation.");
      }),
    );
    const first = polish();
    const second = polish();
    await entered.promise;
    release.resolve();
    await Promise.all([accept(first, [200]), accept(second, [200])]);
    expect({ exchanges, impersonations, generations }).toStrictEqual({
      exchanges: 1,
      impersonations: 2,
      generations: 2,
    });
  });

  it("allows a concurrent caller to recover when another caller cancels", async () => {
    const controller = new AbortController();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let impersonations = 0;
    context.mocks.signalTimers.delay.mockImplementation(
      async (_milliseconds, options) => {
        const signal = options?.signal;
        if (!signal) {
          throw new Error("Expected owned token backoff");
        }
        entered.resolve();
        await release.promise;
        signal.throwIfAborted();
      },
    );
    server.use(
      http.post(GOOGLE_IMPERSONATION_URL, () => {
        impersonations += 1;
        return impersonations === 1
          ? new HttpResponse(null, { status: 503 })
          : token("impersonation");
      }),
    );
    const first = polish(controller.signal);
    const second = polish();
    await entered.promise;
    controller.abort();
    release.resolve();
    await Promise.all([
      expect(first).rejects.toMatchObject({ name: "AbortError" }),
      accept(second, [200]),
    ]);
    expect(impersonations).toBe(2);
  });

  it("cancels the last caller's backoff without another token attempt and permits replacement", async () => {
    const controller = new AbortController();
    const entered = createDeferredPromise<void>(context.signal);
    const stopped = createDeferredPromise<void>(context.signal);
    let attempts = 0;
    context.mocks.signalTimers.delay.mockImplementation(
      (_milliseconds, options) => {
        const signal = options?.signal;
        if (!signal) {
          throw new Error("Expected owned token backoff");
        }
        signal.throwIfAborted();
        const wait = createDeferredPromise<void>(signal);
        signal.addEventListener(
          "abort",
          () => {
            stopped.resolve();
          },
          { once: true },
        );
        entered.resolve();
        return wait.promise;
      },
    );
    server.use(
      http.post(GOOGLE_IMPERSONATION_URL, () => {
        attempts += 1;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const pending = polish(controller.signal);
    await entered.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await stopped.promise;
    expect(attempts).toBe(1);
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    server.use(
      http.post(GOOGLE_IMPERSONATION_URL, () => {
        return token("impersonation");
      }),
    );
    await accept(polish(), [200]);
  });
});
