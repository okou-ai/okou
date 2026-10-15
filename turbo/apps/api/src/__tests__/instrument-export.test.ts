import { randomBytes } from "node:crypto";
import { IncomingMessage, request } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import {
  context as otelContext,
  ProxyTracerProvider,
  trace,
  type TracerProvider,
} from "@opentelemetry/api";
import { http, HttpResponse, passthrough } from "msw";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { mockEnv } from "../lib/env";
import { server } from "../mocks/server";
import { createApp } from "../app-factory";
import { integrationsTelegramRoutes } from "../signals/routes/integrations-telegram";
import { healthRoutes } from "../signals/routes/health";

import { testContext } from "./test-context";

async function httpRequest(
  url: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const outgoing = request(url, { signal });
  const received = once(outgoing, "response", { signal });
  outgoing.end();
  const [response] = await received;
  if (!(response instanceof IncomingMessage)) {
    throw new Error("Expected an HTTP response");
  }
  const ended = once(response, "end", { signal });
  response.resume();
  await ended;
  return response.statusCode;
}

describe("API telemetry exports", () => {
  const context = testContext();
  let initializedTracerProvider: TracerProvider | undefined;

  afterEach(async () => {
    const Sentry =
      await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
    await Sentry.close();
    const provider = initializedTracerProvider;
    if (
      provider &&
      "shutdown" in provider &&
      typeof provider.shutdown === "function"
    ) {
      await provider.shutdown();
    }
    initializedTracerProvider = undefined;
    trace.disable();
    otelContext.disable();
  });

  it("exports ordinary API telemetry but excludes callback proof with the configured real SDKs", async () => {
    const Sentry =
      await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
    const otel =
      await vi.importActual<typeof import("@vercel/otel")>("@vercel/otel");
    context.mocks.sentry.init.mockImplementation(Sentry.init);
    context.mocks.sentry.captureException.mockImplementation((error) => {
      Sentry.captureException(error);
    });
    context.mocks.sentry.httpIntegration.mockImplementation(
      Sentry.httpIntegration,
    );
    context.mocks.sentry.nativeNodeFetchIntegration.mockImplementation(
      Sentry.nativeNodeFetchIntegration,
    );
    context.mocks.otel.registerOTel.mockImplementation(otel.registerOTel);

    const traces: unknown[] = [];
    const errors: string[] = [];
    const errorEvents: unknown[] = [];
    server.use(
      http.all(/^http:\/\/127\.0\.0\.1:\d+\//u, () => {
        return passthrough();
      }),
      http.post("https://api.axiom.co/v1/traces", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer trace-token");
        expect(request.headers.get("x-axiom-dataset")).toBe("vm0-traces-dev");
        traces.push(await request.json());
        return HttpResponse.json({});
      }),
      http.post(
        "https://sentry.example/api/1/envelope/",
        async ({ request }) => {
          const envelope = await request.text();
          errors.push(envelope);
          const lines = envelope.split("\n");
          for (let index = 1; index < lines.length - 1; index += 2) {
            const header = lines[index];
            const payload = lines[index + 1];
            if (header?.includes('"type":"event"') && payload) {
              errorEvents.push(JSON.parse(payload));
            }
          }
          return HttpResponse.json({});
        },
      ),
    );
    mockEnv("AXIOM_TOKEN_TELEMETRY", "trace-token");
    mockEnv("AXIOM_DATASET_SUFFIX", "dev");
    mockEnv("GIT_COMMIT_SHA", "dependency-upgrade");
    mockEnv("SENTRY_DSN", "https://public@sentry.example/1");
    mockEnv("ENV", "production");

    await import("../instrument");
    const provider = trace.getTracerProvider();
    if (!(provider instanceof ProxyTracerProvider)) {
      throw new Error("Expected the registered OpenTelemetry provider");
    }
    const delegate = provider.getDelegate();
    initializedTracerProvider = delegate;
    if (
      !("forceFlush" in delegate) ||
      typeof delegate.forceFlush !== "function" ||
      !("shutdown" in delegate) ||
      typeof delegate.shutdown !== "function"
    ) {
      throw new Error(
        "Expected an OpenTelemetry provider with export lifecycle methods",
      );
    }
    // A short-lived HTTP fixture exercises the configured automatic SDKs and
    // production Hono middleware/handlers, without replacing the request path.
    const app = createApp({
      signal: context.signal,
      routes: [...integrationsTelegramRoutes, ...healthRoutes],
    });
    const listener = serve({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      port: 0,
    });
    onTestFinished(async () => {
      await promisify(listener.close.bind(listener))();
    });
    if (!listener.listening) {
      await once(listener, "listening", { signal: context.signal });
    }
    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listener");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const proof = randomBytes(32).toString("hex");
    const identity = `telegram-person-${randomBytes(16).toString("hex")}`;
    const providerQuery = new URLSearchParams({
      id: "123456789",
      first_name: identity,
      username: identity,
      photo_url: `https://photos.example/${identity}`,
      auth_date: "1700000000",
      hash: proof,
      targetOrigin: "https://app.okou.ai",
    });
    const path = "/api/integrations/telegram/auth-callback";
    const cases = [
      [path, "", 200],
      [
        path,
        "&callbackProtocol=2&operationId=51326918-3b76-4fea-a42f-d8f58e426d9b&bot=official",
        200,
      ],
      [path, "&callbackProtocol=2&operationId=invalid&bot=official", 422],
      [path, "&callbackProtocol=9", 422],
      [path, "&callbackProtocol=2&callbackProtocol=2", 422],
      [`${path}/`, "&callbackProtocol=2", 404],
      ["/api/integrations/%74elegram/auth-callback", "", 200],
    ] as const;
    for (const [pathname, contextQuery, status] of cases) {
      const url = `${origin}${pathname}?${providerQuery}${contextQuery}`;
      await expect(httpRequest(url, context.signal)).resolves.toBe(status);
      // Exercise request/error payloads and retained breadcrumbs at the SDK
      // transport seam too, including relative and fragment URL forms.
      Sentry.addBreadcrumb({ category: "http", data: { url } });
      Sentry.captureEvent({
        message: `Callback failure ${proof}`,
        request: {
          url,
          query_string: providerQuery.toString(),
          data: { hash: proof, identity },
        },
        extra: { identity },
      });
    }
    Sentry.addBreadcrumb({
      category: "http",
      data: { url: `${path}#${providerQuery}` },
    });
    // Preserve the existing Discord exclusion and filters in the composition.
    const discordUrl = `${origin}/api/integrations/discord/oauth/callback?code=${proof}&state=${identity}`;
    await expect(httpRequest(discordUrl, context.signal)).resolves.toBe(404);
    Sentry.addBreadcrumb({ category: "http", data: { url: discordUrl } });
    Sentry.captureEvent({ message: proof, request: { url: discordUrl } });

    // An opaque URL is accepted by the environment schema but cannot resolve
    // relative destinations. Exercise the real HTTP error boundary without a
    // synthetic route or a mocked handler. The configured SDK may omit request
    // metadata locally, so the explicit SDK payloads above also cover that seam.
    mockEnv("APP_URL", "mailto:configuration@example.invalid");
    await expect(
      httpRequest(
        `${origin}${path}?${providerQuery}&callbackProtocol=invalid`,
        context.signal,
      ),
    ).resolves.toBe(500);
    await expect(
      httpRequest(`${origin}/sign-in`, context.signal),
    ).resolves.toBe(500);
    await expect(httpRequest(`${origin}/health`, context.signal)).resolves.toBe(
      200,
    );
    // Similar-looking paths are ordinary traffic, not callback exclusions.
    await expect(
      httpRequest(`${origin}${path}-other`, context.signal),
    ).resolves.toBe(404);
    Sentry.addBreadcrumb({
      category: "http",
      data: { url: `${origin}/health` },
    });
    Sentry.captureEvent({
      message: "Ordinary request metadata positive control",
      request: { url: `${origin}/health` },
    });
    trace
      .getTracer("dependency-upgrade")
      .startActiveSpan("api-regression", (span) => {
        Sentry.captureException(new Error("API error regression"));
        span.end();
      });
    await delegate.forceFlush();
    await expect(Sentry.flush(2000)).resolves.toBeTruthy();

    expect(traces).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceSpans: [
            expect.objectContaining({
              resource: expect.objectContaining({
                attributes: expect.arrayContaining([
                  { key: "service.name", value: { stringValue: "vm0-api" } },
                  {
                    key: "service.version",
                    value: { stringValue: "dependency-upgrade" },
                  },
                ]),
              }),
              scopeSpans: expect.arrayContaining([
                expect.objectContaining({
                  spans: expect.arrayContaining([
                    expect.objectContaining({ name: "api-regression" }),
                  ]),
                }),
              ]),
            }),
          ],
        }),
      ]),
    );
    expect(errors.join("\n")).toContain("API error regression");
    expect(errors.join("\n")).toContain('"app":"api"');
    expect(errorEvents).toContainEqual(
      expect.objectContaining({
        message: "Ordinary request metadata positive control",
        request: expect.objectContaining({ url: `${origin}/health` }),
      }),
    );
    expect(errorEvents).toContainEqual(
      expect.objectContaining({
        exception: expect.objectContaining({
          values: expect.arrayContaining([
            expect.objectContaining({ value: "Invalid URL" }),
          ]),
        }),
      }),
    );
    expect(errors.join("\n")).toContain(`${origin}/health`);
    const exportedTraces = JSON.stringify(traces);
    expect(exportedTraces).toContain("GET /health");
    expect(exportedTraces).toContain(`${path}-other`);
    for (const secret of [proof, identity, "123456789", "1700000000"]) {
      expect(exportedTraces).not.toContain(secret);
      expect(errors.join("\n")).not.toContain(secret);
    }
  });
});
