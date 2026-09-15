import {
  context as otelContext,
  ProxyTracerProvider,
  trace,
  type TracerProvider,
} from "@opentelemetry/api";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockEnv } from "../lib/env";
import { server } from "../mocks/server";

import { testContext } from "./test-context";

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

  it("exports API traces to Axiom and errors to Sentry with the real SDKs", async () => {
    const Sentry =
      await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
    const otel =
      await vi.importActual<typeof import("@vercel/otel")>("@vercel/otel");
    context.mocks.sentry.init.mockImplementation(Sentry.init);
    context.mocks.sentry.httpIntegration.mockImplementation(
      Sentry.httpIntegration,
    );
    context.mocks.sentry.nativeNodeFetchIntegration.mockImplementation(
      Sentry.nativeNodeFetchIntegration,
    );
    context.mocks.otel.registerOTel.mockImplementation(otel.registerOTel);

    const traces: unknown[] = [];
    const errors: string[] = [];
    server.use(
      http.post("https://api.axiom.co/v1/traces", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer trace-token");
        expect(request.headers.get("x-axiom-dataset")).toBe("vm0-traces-dev");
        traces.push(await request.json());
        return HttpResponse.json({});
      }),
      http.post(
        "https://sentry.example/api/1/envelope/",
        async ({ request }) => {
          errors.push(await request.text());
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
    trace
      .getTracer("dependency-upgrade")
      .startActiveSpan("api-regression", (span) => {
        Sentry.captureException(new Error("API error regression"));
        span.end();
      });
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
    await delegate.forceFlush();
    await expect(Sentry.flush(2000)).resolves.toBeTruthy();

    expect(traces).toStrictEqual([
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
            scopeSpans: [
              expect.objectContaining({
                spans: [expect.objectContaining({ name: "api-regression" })],
              }),
            ],
          }),
        ],
      }),
    ]);
    expect(errors.join("\n")).toContain("API error regression");
    expect(errors.join("\n")).toContain('"app":"api"');
  });
});
