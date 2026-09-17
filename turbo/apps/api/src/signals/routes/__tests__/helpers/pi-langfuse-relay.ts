import {
  PI_LANGFUSE_RELAY_MAX_BYTES,
  piLangfuseTracesContract,
} from "@okouai/api-contracts/contracts/pi-langfuse";
import { piApiFirstTurnManifestSchema } from "@okouai/api-contracts/contracts/runners";
import { http, HttpResponse } from "msw";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { env } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { webhooksAgentLangfuseRoutes } from "../../webhooks-agent-langfuse";

/** Exercise the relay through its HTTP contract and captured external OTLP. */
export async function assertPiLangfuseRelayContract(
  context: TestContext,
  args: {
    readonly runId: string;
    readonly sessionId: string;
    readonly token: string | undefined;
    readonly checkpointObjects: ReadonlyMap<string, Buffer>;
  },
) {
  expect(args.token).toBeDefined();
  const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${args.runId}/manifest.json`;
  const manifest = piApiFirstTurnManifestSchema.parse(
    JSON.parse(
      args.checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}",
    ),
  );
  if (
    manifest.schemaVersion !== 3 ||
    manifest.outcome !== "ownership-transfer" ||
    !manifest.langfuseParent
  ) {
    throw new Error("Expected an admitted sandbox-first trace parent");
  }
  expect(manifest).toMatchObject({
    mode: "sandbox-first",
    langfuseParent: {
      traceId: args.runId.replaceAll("-", ""),
      spanId: expect.stringMatching(/^[a-f0-9]{16}$/u),
      sessionId: args.sessionId,
      sandboxWaitStartedAt: expect.any(Number),
    },
  });
  const payload = JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: args.runId.replaceAll("-", ""),
                spanId: "a".repeat(16),
                parentSpanId: manifest.langfuseParent.spanId,
                name: "Sandbox Continuation",
              },
            ],
          },
        ],
      },
    ],
  });
  const exports: { headers: Headers; body: string }[] = [];
  server.use(
    http.post(
      "https://langfuse.example/api/public/otel/v1/traces",
      async ({ request }) => {
        exports.push({
          headers: request.headers,
          body: await request.text(),
        });
        return HttpResponse.json({});
      },
    ),
  );
  const relay = setupApp({ context, routes: webhooksAgentLangfuseRoutes })(
    piLangfuseTracesContract,
  );
  const request = {
    params: { runId: args.runId },
    headers: {
      authorization: `Bearer ${args.token}`,
    },
    extraHeaders: {
      "content-type": "application/json",
      "x-langfuse-ingestion-version": "3",
      "x-langfuse-public-key": "user-selected-dev-project",
      "x-untrusted-header": "must-not-be-forwarded",
    },
    body: payload,
  };
  await accept(relay.export(request), [200]);
  expect(exports).toHaveLength(1);
  expect(exports[0]?.body).toBe(payload);
  expect(exports[0]?.headers.get("authorization")).toBe(
    `Basic ${Buffer.from("pk-lf-bdd-trace-admission:sk-lf-bdd-trace-admission").toString("base64")}`,
  );
  expect(exports[0]?.headers.get("x-langfuse-ingestion-version")).toBe("4");
  expect(exports[0]?.headers.get("x-langfuse-public-key")).toBeNull();
  expect(exports[0]?.headers.get("x-untrusted-header")).toBeNull();
  await accept(
    relay.export({
      ...request,
      body: "x".repeat(PI_LANGFUSE_RELAY_MAX_BYTES + 1),
    }),
    [413],
  );
  await accept(
    relay.export({
      ...request,
      extraHeaders: { "content-type": "text/plain" },
    }),
    [415],
  );
  expect(exports).toHaveLength(1);
  server.use(
    http.post("https://langfuse.example/api/public/otel/v1/traces", () => {
      return new HttpResponse("private upstream diagnostic", { status: 429 });
    }),
  );
  const rejected = await accept(relay.export(request), [503]);
  expect(rejected.body.error.message).toBe("Trace export failed");

  return {
    async expectAdmissionDenied(
      runId: string,
      token: string | undefined,
    ): Promise<void> {
      expect(token).toBeDefined();
      await accept(
        relay.export({
          ...request,
          params: { runId },
          headers: { authorization: `Bearer ${token}` },
        }),
        [403],
      );
    },
  };
}
