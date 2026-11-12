import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, onTestFinished, test } from "vitest";
import { array, boolean, number, object, string } from "zod";
import { encodeHTML } from "entities";
import { webhookTelemetryContract } from "@okouai/api-contracts/contracts/webhooks";
import { cronBrowserReconcileContract } from "@okouai/api-contracts/contracts/cron";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";
import {
  userTemplatesContract,
  type PublishUserTemplateBody,
} from "@okouai/api-contracts/contracts/user-templates";
import { accept, testContext } from "../../__tests__/test-context";
import { createApp } from "../../app-factory";

import {
  mockAxiomSdkTelemetryFailure,
  withRealAxiomLoggingForTest,
} from "../../__tests__/mocks";
import { setupApp } from "../../__tests__/test-helpers";
import { server } from "../../mocks/server";
import {
  assistantEvent,
  createChatEventsFixture,
  userMessages,
  userMessageWithTemplate,
} from "../../signals/routes/__tests__/helpers/chat-events-fixture";
import { publicChatActor } from "../../signals/routes/__tests__/helpers/public-chat-actor";
import { createBddApi } from "../../signals/routes/__tests__/helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "../../signals/routes/__tests__/helpers/api-bdd-connectors";
import { createRouteMocks } from "../../signals/routes/__tests__/helpers/route-test";
import {
  installS3Fixture,
  tarGz,
  uploadTemplateFile,
} from "../../signals/routes/__tests__/helpers/template-publish-fixture";
import { userTemplatesRoutes } from "../../signals/routes/user-templates";
import { presentationTemplatesRoutes } from "../../signals/routes/presentation-templates";
import { useSecretKmsProbe } from "../../signals/routes/__tests__/helpers/secret-kms-probe";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../signals/routes/webhooks-agent-health-usage-telemetry";
import { createDeferredPromise } from "../../signals/utils";
import { flushWaitUntilForTest } from "../../signals/context/wait-until";
import { healthRoutes } from "../../signals/routes/health";
import { cronBrowserReconcileRoutes } from "../../signals/routes/cron-browser-reconcile";
import { createSharedBrowserFixtures } from "../../signals/routes/__tests__/helpers/browser-shared-fixture";
import { mockOptionalEnv } from "../env";
import { clearMockMonotonicNow, mockMonotonicNow, mockNow, now } from "../time";
import { withRequestRuntime } from "../request-runtime";
import { recordTemplateUsage } from "../template-usage-log";

const context = testContext();
const FAILURE_MESSAGE =
  "Fal built-in generation webhook reported failed generation";

test("keeps OAuth callback stages and exception classes without private details", async () => {
  const bdd = createBddApi(context);
  const connectors = createConnectorBddApi(context);
  const secret = "private-oauth-callback-detail";
  const scenarios = [
    { stage: "exchange_and_profile", exceptionClass: "SyntaxError" },
    { stage: "persist_connection", exceptionClass: "TypeError" },
  ] as const;
  for (const scenario of scenarios) {
    const actor = bdd.user();
    mockGitHubConnectorOAuth();
    if (scenario.stage === "exchange_and_profile") {
      server.use(
        http.post("https://github.com/login/oauth/access_token", () => {
          return new HttpResponse(secret, {
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
    }
    const start = await connectors.startOauth(actor, "github", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected GitHub OAuth state");
    }
    if (scenario.stage === "persist_connection") {
      useSecretKmsProbe(() => {
        const cause = new Error(secret);
        cause.name = secret;
        const error = new TypeError(secret, { cause });
        error.name = secret;
        return Promise.reject(error);
      });
    }
    const result = await connectors.completeOauthCallbackResult("github", {
      code: secret,
      state,
    });
    expect(result.body).toMatchObject({
      status: "error",
      message: "OAuth authorization failed. Please try again.",
    });
    const records = context.mocks.axiomLogging.error.mock.calls.filter(
      ([message, fields]) => {
        return (
          message === "OAuth callback failed" &&
          object({ oauthAttemptId: string() }).parse(fields).oauthAttemptId ===
            start.oauthAttemptId
        );
      },
    );
    expect(records).toHaveLength(1);
    const record = object({})
      .catchall(string().or(number()))
      .parse(records[0]?.[1]);
    expect(record).toStrictEqual({
      context: "connectors:oauth-callback",
      connectorSlug: "github",
      authMethodId: "oauth",
      oauthAttemptId: start.oauthAttemptId,
      callbackStage: scenario.stage,
      failureKind: "unexpected",
      exceptionClass: scenario.exceptionClass,
      ...(scenario.stage === "persist_connection"
        ? { causeClass: "Error" }
        : {}),
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(state);
    expect(serialized).not.toContain(start.authorizationUrl);
    const replay = await connectors.completeOauthCallbackResult("github", {
      code: secret,
      state,
    });
    expect(replay.body).toMatchObject({
      status: "error",
      message: "Invalid state - please try again",
    });
  }
});

// Logger-owned redaction contract: trigger failures at the external CDP boundary
// through the authenticated production cron, without observing private services.
test("keeps private provider details out of native window failure logs", async () => {
  const app = await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const cron = app(cronBrowserReconcileContract);
  const { fixture, open } = createSharedBrowserFixtures(context);
  const f = await fixture();
  await f.owned.run(async () => {
    const chat = await f.start();
    const first = await open(chat);
    const [providerSessionId] = f.provider.sessionIds;
    if (!providerSessionId) {
      throw new Error("Expected the external Browser provider session");
    }
    const privateDetail = "private-provider-window-detail";
    f.provider.native.windowBoundsError = {
      code: -32_602,
      message: privateDetail,
    };

    const result = await accept(
      cron.reconcile({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );
    expect(result.body).toMatchObject({ checked: 1, errors: 1, stopped: 0 });
    const warning = context.mocks.axiomLogging.warn.mock.calls
      .filter(([message]) => {
        return message === "Shared Browser window reconciliation failed";
      })
      .at(-1);
    const record = object({})
      .catchall(string().or(number()))
      .parse(warning?.[1]);
    expect(record).toStrictEqual({
      instanceId: first.window?.instanceId,
      primaryWindowId: first.window?.primaryWindowId,
      phase: "check-native-window",
      errorKind: "cdp",
      errorCode: -32_602,
      context: "SharedBrowserReconcile",
    });
    const serialized = JSON.stringify(warning);
    expect(serialized).not.toContain(privateDetail);
    expect(serialized).not.toContain("Private provider");
    expect(serialized).not.toContain(f.provider.native.url);
    expect(serialized).not.toContain(chat.threadId);
    expect(serialized).not.toContain(providerSessionId);
  });
});

// Logger-owned telemetry contract: exercise the production health route rather
// than constructing a handler or mounting a test-only route.
describe("request lifecycle Axiom transport", () => {
  const requestEvent = object({
    _time: string(),
    method: string(),
    status: number(),
    path_template: string(),
    request_time_ms: number(),
    type: string().optional(),
    x_client_request_id: string().optional(),
    lifecycle_time_ms: number().optional(),
    background_time_ms: number().optional(),
    wait_until_task_count: number().optional(),
    wait_until_failure_count: number().optional(),
    lifecycle_error: boolean().optional(),
  });

  function eventsIn(dataset: string) {
    return context.mocks.axiom.ingest.mock.calls.flatMap(
      ([ingestedDataset, events]) => {
        return ingestedDataset === dataset
          ? array(requestEvent).parse(events)
          : [];
      },
    );
  }

  function deliveryBarrier() {
    const deferred = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!deferred.settled()) {
        deferred.resolve();
      }
    });
    return deferred;
  }

  function setTime(wallTime: number, elapsed: number): void {
    mockNow(wallTime);
    mockMonotonicNow(elapsed);
  }

  it("exports Worker request and lifecycle RED once through native logs", async () => {
    const restoreConsole = context.mocks.console.capture();
    onTestFinished(restoreConsole);
    context.mocks.axiom.useRealTelemetry.mockReturnValue(true);
    const app = createApp({ signal: context.signal, routes: healthRoutes });

    await withRequestRuntime(
      {
        nativeTelemetry: true,
        database: () => {
          throw new Error("The health route does not access the database");
        },
        waitUntil: () => {},
        traceQuery: (_name, _sql, execute) => {
          return execute({ setAttributes: () => {} });
        },
        observeHttp: () => {},
      },
      async () => {
        const response = await app.request("/health", {
          headers: { "X-Client-Request-Id": "native-health-red" },
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ status: "ok" });
        await flushWaitUntilForTest();
      },
    );

    const records = context.mocks.console.log.mock.calls.map(([record]) => {
      return record;
    });
    expect(records).toStrictEqual([
      expect.objectContaining({
        axiom_dataset: "vm0-request-log-dev",
        okou_runtime: "cloudflare-workers",
        method: "GET",
        path_template: "/health",
        status: 200,
        request_time_ms: expect.any(Number),
        x_client_request_id: "native-health-red",
      }),
      expect.objectContaining({
        axiom_dataset: "vm0-web-logs-dev",
        type: "request_lifecycle",
        method: "GET",
        path_template: "/health",
        status: 200,
        request_time_ms: expect.any(Number),
        lifecycle_time_ms: expect.any(Number),
        background_time_ms: expect.any(Number),
        wait_until_failure_count: 0,
        lifecycle_error: false,
        x_client_request_id: "native-health-red",
      }),
    ]);
    expect(context.mocks.axiom.sdkIngest).not.toHaveBeenCalled();
    expect(context.mocks.axiomLogging.flush).not.toHaveBeenCalled();
  });

  it("returns health before request-log delivery and records lifecycle after delivery", async () => {
    const startedAt = Date.parse("2026-10-21T12:00:00.000Z");
    onTestFinished(clearMockMonotonicNow);
    setTime(startedAt, 0);
    const requestLogFlushed = deliveryBarrier();
    context.mocks.axiom.flush
      .mockResolvedValue(undefined)
      .mockImplementationOnce(() => {
        return requestLogFlushed.promise;
      });
    const app = createApp({ signal: context.signal, routes: healthRoutes });

    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ status: "ok" });
    expect(eventsIn("request-log")).toStrictEqual([
      expect.objectContaining({
        method: "GET",
        path_template: "/health",
        status: 200,
        request_time_ms: 0,
      }),
    ]);
    expect(context.mocks.axiom.flush).toHaveBeenCalledTimes(1);
    expect(eventsIn("web-logs")).toHaveLength(0);

    // A wall-clock correction must not inflate the new elapsed metrics.
    setTime(startedAt + 60_000, 750);
    requestLogFlushed.resolve();
    await flushWaitUntilForTest();

    expect(eventsIn("web-logs")).toStrictEqual([
      expect.objectContaining({
        _time: new Date(startedAt).toISOString(),
        type: "request_lifecycle",
        method: "GET",
        path_template: "/health",
        status: 200,
        request_time_ms: 0,
        lifecycle_time_ms: 750,
        background_time_ms: 750,
        wait_until_failure_count: 0,
        lifecycle_error: false,
      }),
    ]);
    expect(eventsIn("request-log")).toHaveLength(1);
    expect(context.mocks.axiom.flush).toHaveBeenCalledTimes(2);
  });

  it("completes another health lifecycle while the first request-log delivery is pending", async () => {
    const startedAt = Date.parse("2026-10-21T13:00:00.000Z");
    onTestFinished(clearMockMonotonicNow);
    setTime(startedAt, 0);
    const firstFlushed = deliveryBarrier();
    const secondFlushed = deliveryBarrier();
    const secondLifecycle = deliveryBarrier();
    context.mocks.axiom.flush
      .mockResolvedValue(undefined)
      .mockImplementationOnce(() => {
        return firstFlushed.promise;
      })
      .mockImplementationOnce(() => {
        return secondFlushed.promise;
      });
    context.mocks.axiom.ingest.mockImplementation((dataset, events) => {
      if (dataset === "web-logs") {
        for (const event of array(requestEvent).parse(events)) {
          if (
            event.type === "request_lifecycle" &&
            event.x_client_request_id === "health-second"
          ) {
            secondLifecycle.resolve();
          }
        }
      }
      return true;
    });
    const app = createApp({ signal: context.signal, routes: healthRoutes });

    const firstResponse = await app.request("/health", {
      headers: { "X-Client-Request-Id": "health-first" },
    });
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toStrictEqual({ status: "ok" });

    setTime(startedAt + 100, 100);
    const secondResponse = await app.request("/health", {
      headers: { "X-Client-Request-Id": "health-second" },
    });
    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toStrictEqual({
      status: "ok",
    });
    expect(eventsIn("web-logs")).toHaveLength(0);

    setTime(startedAt + 300, 300);
    secondFlushed.resolve();
    // Observe only B's external ingest; a global drain would also await A.
    await secondLifecycle.promise;
    expect(eventsIn("web-logs")).toStrictEqual([
      expect.objectContaining({
        type: "request_lifecycle",
        x_client_request_id: "health-second",
        _time: new Date(startedAt + 100).toISOString(),
        status: 200,
        request_time_ms: 0,
        lifecycle_time_ms: 200,
        background_time_ms: 200,
        wait_until_failure_count: 0,
        lifecycle_error: false,
      }),
    ]);

    setTime(startedAt + 900, 900);
    firstFlushed.resolve();
    await flushWaitUntilForTest();
    const lifecycleEvents = eventsIn("web-logs");
    expect(lifecycleEvents).toHaveLength(2);
    expect(lifecycleEvents).toContainEqual(
      expect.objectContaining({
        type: "request_lifecycle",
        x_client_request_id: "health-first",
        _time: new Date(startedAt).toISOString(),
        status: 200,
        request_time_ms: 0,
        lifecycle_time_ms: 900,
        background_time_ms: 900,
        wait_until_failure_count: 0,
        lifecycle_error: false,
      }),
    );
    expect(eventsIn("request-log")).toStrictEqual([
      expect.objectContaining({
        x_client_request_id: "health-first",
        request_time_ms: 0,
      }),
      expect.objectContaining({
        x_client_request_id: "health-second",
        request_time_ms: 0,
      }),
    ]);
  });
});

// Logger-owned template event contract, driven through normal chat and Runner
// endpoints. Preparation and replay must not create additional usage records.
describe("template usage Axiom transport", () => {
  beforeEach(() => {
    context.mocks.axiom.useRealTelemetry.mockReturnValue(true);
  });

  const templateEvent = object({
    _time: string(),
    type: string(),
    runId: string(),
    sourceEventId: string(),
    usageEventId: string(),
    templateUsageVersion: number(),
    orgId: string(),
    userId: string(),
    chatThreadId: string(),
    dispatchPath: string(),
    templateCategory: string(),
    templateId: string(),
    templateSlug: string(),
    templateSource: string(),
    templateRole: string(),
    templateIndex: number(),
    templateCount: number(),
    colorSystemId: string().optional(),
    workflowCategory: string().optional(),
  }).passthrough();

  function templateEvents(orgId: string | null) {
    return context.mocks.axiom.sdkIngest.mock.calls
      .flatMap(([dataset, events]) => {
        return dataset === "vm0-web-logs-dev"
          ? array(
              object({
                type: string().optional(),
                orgId: string().optional(),
              }).passthrough(),
            ).parse(events)
          : [];
      })
      .filter((event) => {
        return event.type === "template_used" && event.orgId === orgId;
      })
      .map((event) => {
        return templateEvent.parse(event);
      });
  }

  it("records each template once when an immediate queue-first run is created", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const committedAt = now();
      mockNow(committedAt);
      const sourceEventId = randomUUID();
      const body = {
        agentId: owned.agentId,
        prompt: "Prepare an invoice and an illustration",
        clientEventId: sourceEventId,
        userMessage: {
          version: 1 as const,
          parts: [
            { type: "text" as const, text: "Prepare an invoice " },
            {
              type: "template" as const,
              titleSnapshot: "Invoice",
              template: {
                type: "document" as const,
                selection: {
                  documentTemplateId: "document-template:simple-invoice",
                },
              },
            },
            {
              type: "template" as const,
              titleSnapshot: "Illustration",
              template: {
                type: "illustration" as const,
                selection: { illustrationStyleId: "image-style:emboss-deboss" },
              },
            },
          ],
        },
      };
      const run = await owned.sendChatRun(owned.actor, body);
      await owned.requestSendEvent(
        owned.actor,
        { ...body, threadId: run.threadId },
        [201],
      );
      await flushWaitUntilForTest();
      expect(templateEvents(owned.actor.orgId)).toStrictEqual([
        expect.objectContaining({
          _time: new Date(committedAt).toISOString(),
          runId: run.runId,
          sourceEventId,
          usageEventId: `template-used:v2:${sourceEventId}:0`,
          templateUsageVersion: 2,
          userId: owned.actor.userId,
          chatThreadId: run.threadId,
          dispatchPath: "queued-claim",
          templateCategory: "document",
          templateId: "document-template:simple-invoice",
          templateSlug: "simple-invoice",
          templateSource: "builtin",
          templateRole: "primary",
          templateIndex: 0,
          templateCount: 2,
        }),
        expect.objectContaining({
          runId: run.runId,
          sourceEventId,
          usageEventId: `template-used:v2:${sourceEventId}:1`,
          templateCategory: "illustration",
          templateId: "image-style:emboss-deboss",
          templateRole: "inline",
          templateIndex: 1,
          templateCount: 2,
        }),
      ]);
    });
  });

  it("preserves live categories, optional reporting fields, aliases and repeated marker order", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const sourceEventId = randomUUID();
      const templates: readonly GenerationTemplateRequest[] = [
        {
          type: "presentation",
          selection: {
            templateId: "template:html-ppt-meridian",
            colorSystemId: "color-system:ocean-deep",
          },
        },
        { type: "website", selection: { websiteTemplateId: "black-slabs" } },
        {
          type: "illustration",
          selection: { illustrationStyleId: "image-style:ink-mascot" },
        },
        {
          type: "workflow",
          selection: {
            workflowTemplateId: "workflow-template:daily-standup-report",
          },
        },
        {
          type: "document",
          selection: { documentTemplateId: "document-mutual-nda" },
        },
        {
          type: "presentation",
          selection: {
            templateId: "template:html-ppt-meridian",
            colorSystemId: "color-system:ocean-deep",
          },
        },
      ];
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        clientEventId: sourceEventId,
        prompt: "Use each selected template around its marker",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Use each selected template " },
            ...templates.map((template) => {
              return {
                type: "template" as const,
                titleSnapshot: "Selected template",
                template,
              };
            }),
          ],
        },
      });
      await flushWaitUntilForTest();
      const identities = [
        {
          templateCategory: "presentation",
          templateId: "template:html-ppt-meridian",
          templateSlug: "html-ppt-meridian",
          colorSystemId: "color-system:ocean-deep",
        },
        {
          templateCategory: "website",
          templateId: "black-slabs",
          templateSlug: "black-slabs",
        },
        {
          templateCategory: "illustration",
          templateId: "image-style:ink-mascot",
          templateSlug: "ink-mascot",
        },
        {
          templateCategory: "workflow",
          templateId: "workflow-template:daily-standup-report",
          templateSlug: "daily-standup-report",
          workflowCategory: "Engineering",
        },
        {
          templateCategory: "document",
          templateId: "document-mutual-nda",
          templateSlug: "document-mutual-nda",
        },
        {
          templateCategory: "presentation",
          templateId: "template:html-ppt-meridian",
          templateSlug: "html-ppt-meridian",
          colorSystemId: "color-system:ocean-deep",
        },
      ];
      expect(templateEvents(owned.actor.orgId)).toStrictEqual(
        identities.map((identity, index) => {
          return expect.objectContaining({
            ...identity,
            runId: run.runId,
            sourceEventId,
            usageEventId: `template-used:v2:${sourceEventId}:${index}`,
            templateSource: "builtin",
            templateRole: index === 0 ? "primary" : "inline",
            templateIndex: index,
            templateCount: identities.length,
          });
        }),
      );
    });
  });

  it.each(["presentation", "document", "illustration"] as const)(
    "reports a published imported %s by its authorized kind without private metadata or inheritance",
    async (kind) => {
      const owned = await publicChatActor(context);
      const chat = createChatEventsFixture(context);
      const storage = installS3Fixture(context);
      await owned.run(async () => {
        const title = `Private ${kind} source`;
        const sourceFileId = await uploadTemplateFile(
          context,
          owned.actor,
          storage,
          kind === "illustration"
            ? { filename: "private-source.png", contentType: "image/png" }
            : {
                filename: "private-source.pdf",
                contentType: "application/pdf",
              },
          Buffer.from("Private source bytes"),
        );
        const previewFileId = await uploadTemplateFile(
          context,
          owned.actor,
          storage,
          { filename: "private-preview.png", contentType: "image/png" },
          Buffer.from("Private preview bytes"),
        );
        const packageFileId = await uploadTemplateFile(
          context,
          owned.actor,
          storage,
          {
            filename: "private-package.tar.gz",
            contentType: "application/gzip",
          },
          tarGz([
            { path: "SKILL.md", content: "# Private template instructions\n" },
            { path: "design-system.md", content: "Private design details\n" },
          ]),
        );
        const inputs = { title, sourceFileId, packageFileId };
        const body: PublishUserTemplateBody =
          kind === "presentation"
            ? { ...inputs, kind, pageFileIds: [previewFileId] }
            : kind === "document"
              ? { ...inputs, kind, coverFileId: previewFileId }
              : { ...inputs, kind, exampleFileIds: [previewFileId] };
        createRouteMocks(context).clerk.session(
          owned.actor.userId,
          owned.actor.orgId,
        );
        const published = await accept(
          setupApp({ context, routes: userTemplatesRoutes })(
            userTemplatesContract,
          ).publish({
            headers: { authorization: "Bearer clerk-session" },
            body,
          }),
          [200],
        );
        expect(published.body).toMatchObject({ kind, visibility: "private" });
        const sourceEventId = randomUUID();
        const template = {
          type: "custom" as const,
          selection: { userTemplateId: published.body.id },
        };
        const run = await owned.sendChatRun(owned.actor, {
          agentId: owned.agentId,
          clientEventId: sourceEventId,
          prompt: "Use both imported template markers",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Use this template " },
              { type: "template", titleSnapshot: title, template },
              { type: "text", text: "and apply it again here " },
              { type: "template", titleSnapshot: title, template },
            ],
          },
        });
        await flushWaitUntilForTest();
        const events = templateEvents(owned.actor.orgId);
        expect(events).toStrictEqual(
          [0, 1].map((index) => {
            return expect.objectContaining({
              runId: run.runId,
              sourceEventId,
              usageEventId: `template-used:v2:${sourceEventId}:${index}`,
              templateCategory: kind,
              templateId: "user-template",
              templateSlug: "user-template",
              templateSource: "user-imported",
              templateRole: index === 0 ? "primary" : "inline",
              templateIndex: index,
              templateCount: 2,
            });
          }),
        );
        const serialized = JSON.stringify(events);
        for (const privateValue of [
          published.body.id,
          title,
          sourceFileId,
          previewFileId,
          packageFileId,
          "private-source",
          "private-preview",
          "private-package",
          "Private template instructions",
          "Private design details",
          "bundles/v1/",
        ]) {
          expect(serialized).not.toContain(privateValue);
        }
        expect(events[0]).not.toHaveProperty("colorSystemId");
        await chat.cancelChatRun(owned.actor, run.runId);
        await owned.sendChatRun(owned.actor, {
          agentId: owned.agentId,
          threadId: run.threadId,
          prompt: "Continue without selecting a template",
        });
        await flushWaitUntilForTest();
        expect(templateEvents(owned.actor.orgId)).toStrictEqual(events);
      });
    },
  );

  it("redacts a published private presentation selection and its preview metadata", async () => {
    const owned = await publicChatActor(context);
    const storage = installS3Fixture(context);
    await owned.run(async () => {
      const sourceFileId = await uploadTemplateFile(
        context,
        owned.actor,
        storage,
        { filename: "private-deck.pdf", contentType: "application/pdf" },
        Buffer.from("Private presentation source"),
      );
      const pageFileId = await uploadTemplateFile(
        context,
        owned.actor,
        storage,
        { filename: "private-page.png", contentType: "image/png" },
        Buffer.from("Private presentation preview"),
      );
      const packageFileId = await uploadTemplateFile(
        context,
        owned.actor,
        storage,
        { filename: "private-deck.tar.gz", contentType: "application/gzip" },
        tarGz([
          {
            path: "SKILL.md",
            content: "# Private presentation instructions\n",
          },
          { path: "design-system.md", content: "Private presentation style\n" },
        ]),
      );
      createRouteMocks(context).clerk.session(
        owned.actor.userId,
        owned.actor.orgId,
      );
      const published = await accept(
        setupApp({ context, routes: presentationTemplatesRoutes })(
          presentationTemplatesContract,
        ).publish({
          headers: { authorization: "Bearer clerk-session" },
          body: {
            title: "Confidential imported presentation",
            sourceFileId,
            pageFileIds: [pageFileId],
            packageFileId,
          },
        }),
        [200],
      );
      const privatePreviewUrl =
        "https://private.example.test/confidential-deck";
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Use the imported presentation",
        template: {
          type: "presentation",
          selection: {
            templateId: `user-template:${published.body.id}`,
            colorSystemId: "color-system:prism",
            previewUrl: privatePreviewUrl,
          },
        },
      });
      await flushWaitUntilForTest();
      const events = templateEvents(owned.actor.orgId);
      expect(events).toStrictEqual([
        expect.objectContaining({
          runId: run.runId,
          templateCategory: "presentation",
          templateId: "user-template",
          templateSlug: "user-template",
          templateSource: "user-imported",
        }),
      ]);
      expect(events[0]).not.toHaveProperty("colorSystemId");
      const serialized = JSON.stringify(events);
      for (const privateValue of [
        published.body.id,
        "Confidential imported presentation",
        privatePreviewUrl,
        "color-system:prism",
        sourceFileId,
        pageFileId,
        packageFileId,
        "private-deck",
        "private-page",
        "Private presentation",
        "bundles/v1/",
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
    });
  });

  it("waits until a queued template input creates its run", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    await owned.run(async () => {
      const anchor = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Keep the thread busy",
      });
      const claimed = await owned.claimChatRun(owned.runnerGroup, anchor.runId);
      const sourceEventId = randomUUID();
      await owned.requestSendEvent(
        owned.actor,
        {
          agentId: owned.agentId,
          threadId: anchor.threadId,
          clientEventId: sourceEventId,
          prompt: "Prepare an invoice",
          userMessage: userMessageWithTemplate("Prepare an invoice", {
            type: "document",
            selection: {
              documentTemplateId: "document-template:simple-invoice",
            },
          }),
        },
        [201],
      );
      await flushWaitUntilForTest();
      expect(templateEvents(owned.actor.orgId)).toStrictEqual([]);
      fixture.chatCallbacks.mockChatOutputEvents([]);
      await fixture.completeChatRunOk(anchor.runId, claimed.sandboxHeaders);
      await flushWaitUntilForTest();
      const messages = await fixture.waitForThreadMessages(
        owned.actor,
        anchor.threadId,
        (items) => {
          return userMessages(items).some((event) => {
            return (
              event.revokesEventId === sourceEventId && event.runId !== null
            );
          });
        },
      );
      const consumed = userMessages(messages.events).find((event) => {
        return event.revokesEventId === sourceEventId;
      });
      expect(templateEvents(owned.actor.orgId)).toStrictEqual([
        expect.objectContaining({
          sourceEventId,
          runId: consumed?.runId,
          dispatchPath: "queued-claim",
          templateCategory: "document",
          templateCount: 1,
        }),
      ]);
    });
  });

  it("records only the winning active-input declaration, not lookups or replay", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    await owned.run(async () => {
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Start without a template",
      });
      const { claim } = await owned.claimChatRun(owned.runnerGroup, run.runId);
      const sourceEventId = randomUUID();
      await owned.requestSendEvent(
        owned.actor,
        {
          agentId: owned.agentId,
          threadId: run.threadId,
          clientEventId: sourceEventId,
          prompt: "Prepare an invoice",
          userMessage: userMessageWithTemplate("Prepare an invoice", {
            type: "document",
            selection: {
              documentTemplateId: "document-template:simple-invoice",
            },
          }),
        },
        [201],
      );
      const next = await fixture.api.nextSteerableInput(
        claim.sandboxToken,
        run.runId,
      );
      expect(next.input?.eventId).toBe(sourceEventId);
      expect(next.input?.prompt).toContain("Selected document template:");
      await expect(
        fixture.api.nextSteerableInput(claim.sandboxToken, run.runId),
      ).resolves.toStrictEqual(next);
      await flushWaitUntilForTest();
      expect(templateEvents(owned.actor.orgId)).toStrictEqual([]);
      await Promise.all([
        fixture.api.declareSteeredInput(
          claim.sandboxToken,
          run.runId,
          sourceEventId,
        ),
        fixture.api.declareSteeredInput(
          claim.sandboxToken,
          run.runId,
          sourceEventId,
        ),
      ]);
      await fixture.api.declareSteeredInput(
        claim.sandboxToken,
        run.runId,
        sourceEventId,
      );
      await flushWaitUntilForTest();
      expect(templateEvents(owned.actor.orgId)).toStrictEqual([
        expect.objectContaining({
          runId: run.runId,
          sourceEventId,
          usageEventId: `template-used:v2:${sourceEventId}:0`,
          dispatchPath: "active-input",
          templateCategory: "document",
          templateSource: "builtin",
          templateCount: 1,
        }),
      ]);
    });
  });

  it("does not report a steered batch whose private template cannot be mounted", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    await owned.run(async () => {
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Start without template volumes",
      });
      const { claim } = await owned.claimChatRun(owned.runnerGroup, run.runId);
      const sourceEventId = randomUUID();
      await owned.requestSendEvent(
        owned.actor,
        {
          agentId: owned.agentId,
          threadId: run.threadId,
          clientEventId: sourceEventId,
          prompt: "Apply both templates",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Apply both templates" },
              {
                type: "template",
                titleSnapshot: "Invoice",
                template: {
                  type: "document",
                  selection: {
                    documentTemplateId: "document-template:simple-invoice",
                  },
                },
              },
              {
                type: "template",
                titleSnapshot: "Private template",
                template: {
                  type: "custom",
                  selection: { userTemplateId: randomUUID() },
                },
              },
            ],
          },
        },
        [201],
      );
      const next = await fixture.api.nextSteerableInput(
        claim.sandboxToken,
        run.runId,
      );
      expect(next.input?.eventId).toBe(sourceEventId);
      expect(next.input?.prompt).not.toContain("Selected document template:");
      await fixture.api.declareSteeredInput(
        claim.sandboxToken,
        run.runId,
        sourceEventId,
      );
      await flushWaitUntilForTest();
      expect(templateEvents(owned.actor.orgId)).toStrictEqual([]);
    });
  });

  // Logger-only Worker host contract. The public API cases above cover the
  // durable business transition; this case needs no database or Run fixture.
  it("exports a template usage record once through Worker native logs, not the SDK", async () => {
    const restoreConsole = context.mocks.console.capture();
    onTestFinished(restoreConsole);
    const sourceEventId = randomUUID();
    const runId = randomUUID();
    await withRequestRuntime(
      {
        nativeTelemetry: true,
        database: () => {
          throw new Error("Template telemetry does not access the database");
        },
        waitUntil: () => {},
        traceQuery: (_name, _sql, execute) => {
          return execute({ setAttributes: () => {} });
        },
        observeHttp: () => {},
      },
      async () => {
        recordTemplateUsage(
          {
            runId,
            sourceEventId,
            orgId: randomUUID(),
            userId: randomUUID(),
            chatThreadId: randomUUID(),
            dispatchPath: "queued-claim",
            usedAt: new Date(now()),
          },
          [
            {
              category: "document",
              templateId: "document-template:simple-invoice",
              templateSlug: "simple-invoice",
              source: "builtin",
            },
          ],
        );
        await flushWaitUntilForTest();
      },
    );
    const nativeEvents = array(
      object({ type: string().optional() }).passthrough(),
    )
      .parse(
        context.mocks.console.log.mock.calls.map(([record]) => {
          return record;
        }),
      )
      .filter((event) => {
        return event.type === "template_used";
      });
    expect(nativeEvents).toStrictEqual([
      expect.objectContaining({
        axiom_dataset: "vm0-web-logs-dev",
        okou_runtime: "cloudflare-workers",
        runId,
        sourceEventId,
        usageEventId: `template-used:v2:${sourceEventId}:0`,
        templateCategory: "document",
        templateCount: 1,
      }),
    ]);
    expect(templateEvent.parse(nativeEvents[0]).templateUsageVersion).toBe(2);
    expect(context.mocks.axiom.sdkIngest).not.toHaveBeenCalled();
  });

  it("keeps committed usage when Runner activation fails and the run is cancelled", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    await owned.run(async () => {
      let notificationFailed = false;
      context.mocks.ably.publish.mockImplementation((topic: unknown) => {
        if (topic === "job") {
          notificationFailed = true;
          return Promise.reject(new Error("Runner notification unavailable"));
        }
        return Promise.resolve(undefined);
      });
      const sourceEventId = randomUUID();
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        clientEventId: sourceEventId,
        prompt: "Prepare an invoice despite a notification outage",
        template: {
          type: "document",
          selection: { documentTemplateId: "document-template:simple-invoice" },
        },
      });
      await flushWaitUntilForTest();
      expect(notificationFailed).toBeTruthy();
      expect((await fixture.api.readRun(owned.actor, run.runId)).status).toBe(
        "pending",
      );
      const expected = [
        expect.objectContaining({
          runId: run.runId,
          sourceEventId,
          dispatchPath: "queued-claim",
          templateCategory: "document",
        }),
      ];
      expect(templateEvents(owned.actor.orgId)).toStrictEqual(expected);
      await fixture.cancelChatRun(owned.actor, run.runId);
      await flushWaitUntilForTest();
      expect((await fixture.api.readRun(owned.actor, run.runId)).status).toBe(
        "cancelled",
      );
      expect(templateEvents(owned.actor.orgId)).toStrictEqual(expected);
    });
  });

  it("preserves a created template run when Axiom ingestion fails", async () => {
    const owned = await publicChatActor(context);
    const fixture = createChatEventsFixture(context);
    await owned.run(async () => {
      mockAxiomSdkTelemetryFailure({
        mode: "ingest",
        datasets: ["vm0-web-logs-dev"],
        eventTypes: ["template_used"],
      });
      const run = await owned.sendChatRun(owned.actor, {
        agentId: owned.agentId,
        prompt: "Prepare an invoice",
        template: {
          type: "document",
          selection: { documentTemplateId: "document-template:simple-invoice" },
        },
      });
      await flushWaitUntilForTest();
      const persisted = await fixture.api.readRun(owned.actor, run.runId);
      expect(persisted.status).toBe("pending");
      expect(persisted.appendSystemPrompt).toContain(
        "Selected document template:",
      );
    });
  });
});

async function ownedTelemetryUpload() {
  const owned = await publicChatActor(context);
  const { runId } = await owned.sendChatRun(owned.actor, {
    agentId: owned.agentId,
    prompt: "Exercise Axiom error diagnostics",
  });
  const { claim } = await owned.claimChatRun(owned.runnerGroup, runId);
  const client = setupApp({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookTelemetryContract);
  return {
    owned,
    runId,
    send: () => {
      return client.send({
        headers: { authorization: `Bearer ${claim.sandboxToken}` },
        body: {
          runId,
          metrics: [
            {
              ts: "2026-10-21T15:53:23.000Z",
              cpu: 1,
              mem_used: 10,
              mem_total: 100,
            },
          ],
        },
      });
    },
  };
}

// Logger-owned redaction contract, driven through the normal chat/Runner API.
// The external presence provider fails while the other completion effects work.
describe("completed chat callback failure diagnostics", () => {
  it.each(["live", "deleted"] as const)(
    "retains the failed operation without private child errors for a %s thread",
    async (threadState) => {
      const owned = await publicChatActor(context);
      const fixture = createChatEventsFixture(context);
      const privateDetail = "private-presence-provider-detail";
      const followupsRequested = createDeferredPromise<void>(context.signal);
      const followupsResponse = createDeferredPromise<string>(context.signal);
      const suggestions = JSON.stringify([
        { prompt: "Continue the analysis", kind: "talk" },
      ]);
      onTestFinished(() => {
        if (!followupsResponse.settled()) {
          followupsResponse.resolve(suggestions);
        }
      });

      await owned.run(async () => {
        fixture.chatCallbacks.mockVertexCompletions(async (body) => {
          const system = body.messages[0]?.content ?? "";
          if (system.includes("recommended follow-up messages")) {
            followupsRequested.resolve();
            return await followupsResponse.promise;
          }
          return "Safe generated summary";
        });
        const run = await fixture.sendChatRun(owned.actor, {
          agentId: owned.agentId,
          prompt: "Keep the completed answer",
        });
        await fixture.chatCallbacks.registerPushSubscription(owned.actor);
        fixture.chatCallbacks.enableVapid();
        const { sandboxHeaders, claim } = await fixture.claimChatRun(
          owned.runnerGroup,
          run.runId,
        );
        owned.rememberClaim(run.runId, claim.sandboxToken);
        context.mocks.ably.presenceGet.mockRejectedValue(
          new TypeError(privateDetail, {
            cause: { code: "EPIPE", response: privateDetail },
          }),
        );
        fixture.chatCallbacks.mockChatOutputEvents([
          assistantEvent(0, "The main answer survives"),
        ]);
        await fixture.completeChatRunOk(run.runId, sandboxHeaders);
        await followupsRequested.promise;

        const completed = await fixture.api.readRun(owned.actor, run.runId);
        expect(completed.status).toBe("completed");
        const events = await fixture.chat.listThreadEvents(
          owned.actor,
          run.threadId,
        );
        expect(events.events).toContainEqual(
          expect.objectContaining({ content: "The main answer survives" }),
        );
        if (threadState === "deleted") {
          await fixture.chat.deleteThread(owned.actor, run.threadId);
        }
        followupsResponse.resolve(suggestions);
        await flushWaitUntilForTest();
        if (threadState === "live") {
          const after = await fixture.chat.listThreadEvents(
            owned.actor,
            run.threadId,
          );
          expect(after.events).toContainEqual(
            expect.objectContaining({ eventType: "output.followups" }),
          );
        } else {
          const after = await fixture.chat.requestReadThread(
            owned.actor,
            run.threadId,
            [404],
          );
          expect(after.status).toBe(404);
        }

        const warning = context.mocks.axiomLogging.warn.mock.calls.find(
          ([message]) => {
            return (
              message ===
              "Failed to process terminal chat callback side effects"
            );
          },
        );
        expect(warning).toStrictEqual([
          "Failed to process terminal chat callback side effects",
          expect.objectContaining({
            runId: run.runId,
            status: "completed",
            error: {
              name: "AggregateError",
              message: "Completed chat callback side effects failed",
              stack: expect.any(String),
              cause: {
                failures: [
                  {
                    operation: "push",
                    reason: "type_error",
                  },
                ],
              },
            },
          }),
        ]);
        expect(JSON.stringify(warning)).not.toContain(privateDetail);
      });
    },
  );
});

// Logger-owned transport exception: the real webhook/error boundary must retain
// useful sanitized provider details without exposing them to its Guest caller.
describe("Axiom ingest HTTP error diagnostics", () => {
  it.each(["json", "html"])(
    "logs bounded %s upstream details and permits a later successful upload",
    async (format) => {
      const upload = await ownedTelemetryUpload();
      await upload.owned.run(async () => {
        const token = "xaat-private-error-diagnostic-token";
        mockOptionalEnv("AXIOM_TOKEN_TELEMETRY", token);
        const privateEcho = "private-echoed-metric-payload";
        const message = `no healthy upstream; ${token}; Bearer another-private-token; password="private password"; https://provider.example/private;private-signed-url-path?token=secret; https://provider.example/O'Reilly-private-apostrophe-path?signature=private-url-signature; owner@example.test; ${"upstream context ".repeat(40)}`;
        let requestBytes = 0;
        server.use(
          http.post(
            "https://api.axiom.co/v1/datasets/sandbox-telemetry-metrics/ingest",
            async ({ request }) => {
              const sentBody = await request.text();
              requestBytes = Buffer.byteLength(sentBody, "utf8");
              const responseMessage = message.replace(
                "no healthy upstream",
                `no healthy upstream for payload=${sentBody}`,
              );
              const headers = {
                "x-request-id": "axiom-upstream-request-42186",
                "retry-after": "2",
              };
              return format === "json"
                ? HttpResponse.json(
                    {
                      error: { message: responseMessage },
                      echoedEvents: privateEcho,
                    },
                    { status: 503, headers },
                  )
                : new HttpResponse(
                    `<html><body>${encodeHTML(responseMessage).replace(encodeHTML("Bearer another-private-token"), "<span>Bearer&#32;another-private-token</span>")}</body></html>`,
                    {
                      status: 503,
                      headers: { ...headers, "content-type": "text/html" },
                    },
                  );
            },
          ),
        );

        const failed = await accept(upload.send(), [500]);
        expect(failed.body).toStrictEqual({ error: "Internal server error" });
        await flushWaitUntilForTest();
        expect(context.mocks.axiom.ingest).toHaveBeenCalledWith("web-logs", [
          expect.objectContaining({
            type: "request_lifecycle",
            method: "POST",
            status: 500,
            lifecycle_error: true,
          }),
        ]);
        expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
          "Unhandled request error: Axiom ingest failed with status 503",
          expect.objectContaining({
            error: expect.objectContaining({
              reason: "http_status",
              status: 503,
              dataset: "sandbox-telemetry-metrics",
              retryAfterMs: 2000,
              eventCount: 1,
              requestBytes,
              elapsedMs: expect.any(Number),
              upstreamRequestId: "axiom-upstream-request-42186",
              responseContentType:
                format === "json" ? "application/json" : "text/html",
              responseBodySummary: expect.stringContaining(
                "no healthy upstream",
              ),
            }),
          }),
        );
        const fields = object({
          error: object({ responseBodySummary: string().max(512) }),
        }).parse(
          context.mocks.axiomLogging.error.mock.calls.find(([logMessage]) => {
            return (
              logMessage ===
              "Unhandled request error: Axiom ingest failed with status 503"
            );
          })?.[1],
        );
        expect(fields.error.responseBodySummary).toContain(
          "[redacted authorization]",
        );
        expect(fields.error.responseBodySummary).toContain(
          "[redacted telemetry payload]",
        );
        expect(fields.error.responseBodySummary).not.toContain(upload.runId);
        expect(fields.error.responseBodySummary).toMatch(/\.\.\.$/u);
        const logged = JSON.stringify(
          context.mocks.axiomLogging.error.mock.calls,
        );
        for (const secret of [
          token,
          "another-private-token",
          "private password",
          "private-signed-url-path",
          "private-apostrophe-path",
          "private-url-signature",
          "owner@example.test",
          privateEcho,
        ]) {
          expect(logged).not.toContain(secret);
        }

        server.use(
          http.post(
            "https://api.axiom.co/v1/datasets/sandbox-telemetry-metrics/ingest",
            () => {
              return HttpResponse.json({
                ingested: 1,
                failed: 0,
                processedBytes: requestBytes,
              });
            },
          ),
        );
        const accepted = await accept(upload.send(), [200]);
        expect(accepted.body).toStrictEqual({
          success: true,
          id: upload.runId,
        });
      });
    },
  );

  it.each(["oversized", "interrupted"])(
    "preserves the known HTTP failure when the error body is %s",
    async (mode) => {
      const upload = await ownedTelemetryUpload();
      await upload.owned.run(async () => {
        const diagnosticStarted = createDeferredPromise<void>(context.signal);
        let bodyController:
          ReadableStreamDefaultController<Uint8Array> | undefined;
        let bodyFinished = false;
        onTestFinished(() => {
          if (!bodyFinished) {
            bodyFinished = true;
            bodyController?.close();
          }
        });
        server.use(
          http.post(
            "https://api.axiom.co/v1/datasets/sandbox-telemetry-metrics/ingest",
            () => {
              if (mode === "oversized") {
                return HttpResponse.json(
                  { message: "x".repeat(5000) },
                  { status: 503 },
                );
              }
              return new HttpResponse(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    bodyController = controller;
                    diagnosticStarted.resolve();
                  },
                  cancel() {
                    bodyFinished = true;
                  },
                }),
                { status: 503 },
              );
            },
          ),
        );

        const pending = upload.send();
        if (mode === "interrupted") {
          await diagnosticStarted.promise;
          bodyFinished = true;
          bodyController?.error(
            new Error("private provider body read failure"),
          );
        }
        const failed = await accept(pending, [500]);
        expect(failed.body).toStrictEqual({ error: "Internal server error" });
        expect(context.mocks.axiomLogging.error).toHaveBeenCalledWith(
          "Unhandled request error: Axiom ingest failed with status 503",
          expect.objectContaining({
            error: expect.objectContaining({
              reason: "http_status",
              status: 503,
              responseBodySummary: undefined,
              ...(mode === "oversized" ? { responseBodyTruncated: true } : {}),
            }),
          }),
        );
      });
    },
  );
});

// Logger-owned transport exception: verify the selected-eager operation payload
// at the existing external SDK ingest boundary, using real connect/send/claim
// endpoints. Ordinary API route tests must not inspect incidental diagnostics.
describe("selected eager Axiom operation payload", () => {
  it.each([0, 1, 2])(
    "reports %i selected decrypts with both completed intervals",
    async (expectedCount) => {
      const fixture = createChatEventsFixture(context);
      const { actor, agentId, runnerGroup } = await fixture.entitledChatActor();
      await fixture.api.updateUserModelPreference(actor, "claude-fable-5-1");
      await fixture.connectors.connectManualGrant(
        actor,
        "figma",
        "api-token",
        {
          accessToken: "deferred-transport-token",
        },
        agentId,
      );
      if (expectedCount) {
        await fixture.connectors.connectManualGrant(
          actor,
          "openai",
          "api-token",
          {
            apiKey: "eager-transport-token",
          },
          agentId,
        );
      }
      if (expectedCount === 2) {
        await fixture.connectors.connectManualGrant(
          actor,
          "parallel",
          "api-token",
          { apiKey: "parallel-transport-token" },
          agentId,
        );
      }
      context.mocks.axiom.useRealTelemetry.mockReturnValue(true);
      const kms = useSecretKmsProbe();
      const run = await fixture.sendChatRun(actor, {
        agentId,
        model: "claude-fable-5-1",
        prompt: "Verify selected eager observations",
      });
      const claimed = await fixture.claimChatRun(runnerGroup, run.runId);
      const actualDecrypts = kms.decryptCalls;
      expect(claimed.claim.environment).toMatchObject({
        FIGMA_TOKEN: "fixture-figma-token",
        ...(expectedCount ? { OPENAI_TOKEN: "eager-transport-token" } : {}),
        ...(expectedCount === 2
          ? { PARALLEL_API_KEY: "parallel-transport-token" }
          : {}),
      });
      expect(actualDecrypts).toBe(expectedCount);
      const eventSchema = object({
        run_id: string().optional(),
        op_type: string().optional(),
        connector_context_schema: string().optional(),
        connector_context_builtin_decrypt_count: number().optional(),
        connector_context_builtin_decrypt_count_bucket: string().optional(),
        preparation_phase: string().optional(),
        duration_ms: number().optional(),
        _time: string().optional(),
      });
      const events = context.mocks.axiom.sdkIngest.mock.calls
        .flatMap(([, payload]) => {
          return array(eventSchema).parse(payload);
        })
        .filter((event) => {
          return event.run_id === run.runId;
        });
      const selected = events.filter((event) => {
        return event.connector_context_schema === "selected_eager_v1";
      });
      expect(selected).toHaveLength(2);
      for (const suffix of ["builtin_resolve", "builtin_decrypt"]) {
        const matches = selected.filter((event) => {
          return (
            event.op_type ===
            `api_dispatch_prepare_context_connector_context_${suffix}`
          );
        });
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({
          connector_context_builtin_decrypt_count: actualDecrypts,
          preparation_phase: "claim",
          connector_context_builtin_decrypt_count_bucket:
            expectedCount === 2 ? "2_4" : String(expectedCount),
          duration_ms: expect.any(Number),
          _time: expect.any(String),
        });
        expect(matches[0]!.duration_ms).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(Date.parse(matches[0]!._time!))).toBeTruthy();
      }
      const shared = events.filter((event) => {
        return event.connector_context_schema === "shared_v2";
      });
      expect(shared.length).toBeGreaterThan(0);
      expect(
        shared.every((event) => {
          return (
            event.connector_context_builtin_decrypt_count === undefined &&
            event.connector_context_builtin_decrypt_count_bucket === undefined
          );
        }),
      ).toBeTruthy();
      await fixture.cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    },
  );
});

describe("Axiom logging transport", () => {
  it("retains failed request details and resumes logging after a transport failure", async () => {
    const restoreConsole = context.mocks.console.capture();
    onTestFinished(restoreConsole);
    let unavailable = true;
    let failedRequestBytes = 0;
    let firstFailedRequestAt: number | undefined;
    let failedRequestSpanMs = 0;
    let failedRequestCount = 0;
    const delivered: unknown[] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/vm0-web-logs-dev/ingest",
        async ({ request }) => {
          const bytes = Buffer.from(await request.arrayBuffer());
          if (unavailable) {
            const failedAt = performance.now();
            firstFailedRequestAt ??= failedAt;
            failedRequestSpanMs = failedAt - firstFailedRequestAt;
            failedRequestCount += 1;
            failedRequestBytes = bytes.byteLength;
            return HttpResponse.error();
          }
          const body = gunzipSync(bytes).toString("utf8");
          const events = body.split("\n").map((line): unknown => {
            return JSON.parse(line);
          });
          delivered.push(...events);
          return HttpResponse.json({
            ingested: events.length,
            failed: 0,
            processedBytes: body.length,
          });
        },
      ),
    );

    await withRealAxiomLoggingForTest(async () => {
      const {
        logger,
        flushLogs,
        __resetForTest: resetLogs,
      } = await import("../log");
      const { mockEnv, clearMockedEnv } = await import("../env");
      mockEnv("AXIOM_TOKEN_TELEMETRY", "xaat-private-transport-test-token");
      mockEnv("AXIOM_DATASET_SUFFIX", "dev");
      mockEnv("GIT_COMMIT_SHA", "c".repeat(40));
      resetLogs();
      await Promise.resolve()
        .then(async () => {
          const log = logger("AxiomTransportTest");
          log.info("private-failed-log-payload");
          await expect(flushLogs()).resolves.toBeUndefined();

          expect(context.mocks.console.error).toHaveBeenCalledWith(
            "Axiom application log delivery failed",
            expect.objectContaining({
              client: "telemetry",
              dataset: "vm0-web-logs-dev",
              failureKind: "transport_error",
              api_commit_sha: "c".repeat(40),
              error: expect.objectContaining({
                name: "TypeError",
                message: "Failed to fetch",
                stack: expect.any(String),
                cause: expect.objectContaining({
                  name: "TypeError",
                  message: "Failed to fetch",
                }),
                request: {
                  origin: "https://api.axiom.co",
                  endpoint: "/v1/datasets/vm0-web-logs-dev/ingest",
                  method: "POST",
                  elapsedMs: expect.any(Number),
                  attemptElapsedMs: expect.any(Number),
                  attempt: failedRequestCount,
                  requestBytes: failedRequestBytes,
                  aborted: false,
                },
              }),
            }),
          );
          const diagnostics = JSON.stringify(
            context.mocks.console.error.mock.calls,
          );
          expect(diagnostics).not.toContain(
            "xaat-private-transport-test-token",
          );
          expect(diagnostics).not.toContain("private-failed-log-payload");
          const failure = object({
            error: object({
              request: object({ elapsedMs: number() }),
            }),
          }).parse(
            context.mocks.console.error.mock.calls.find(([message]) => {
              return message === "Axiom application log delivery failed";
            })?.[1],
          );
          expect(failedRequestCount).toBe(2);
          expect(failure.error.request.elapsedMs).toBeGreaterThanOrEqual(
            failedRequestSpanMs,
          );

          unavailable = false;
          log.info("logging resumed");
          await flushLogs();
          expect(delivered).toContainEqual(
            expect.objectContaining({
              message: "logging resumed",
              level: "info",
            }),
          );
        })
        .finally(() => {
          resetLogs();
          clearMockedEnv();
        });
    });
  });

  it("sends Fal info/warn diagnostics with the default SDK transport and restores mocks", async () => {
    const sentEvents: unknown[] = [];
    server.use(
      http.post(
        "https://api.axiom.co/v1/datasets/vm0-web-logs-dev/ingest",
        async ({ request }) => {
          expect(request.headers.get("content-type")).toBe(
            "application/x-ndjson",
          );
          const body = gunzipSync(
            Buffer.from(await request.arrayBuffer()),
          ).toString("utf8");
          const events = body.split("\n").map((line): unknown => {
            return JSON.parse(line);
          });
          sentEvents.push(...events);
          return HttpResponse.json({
            ingested: events.length,
            failed: 0,
            failures: [],
            processedBytes: body.length,
            blocksCreated: 1,
            walLength: 0,
          });
        },
      ),
    );

    await withRealAxiomLoggingForTest(async () => {
      // These imports must follow the SDK switch to avoid reusing the logger's
      // singleton or environment overrides from the centralized mock setup.
      const {
        logger,
        flushLogs,
        __resetForTest: resetLogs,
      } = await import("../log");
      const { mockEnv, clearMockedEnv } = await import("../env");
      mockEnv("AXIOM_TOKEN_TELEMETRY", "xaat-fal-logging-test");
      mockEnv("AXIOM_DATASET_SUFFIX", "dev");
      mockEnv("OKOU_DEBUG", "");
      resetLogs();

      const fields = {
        provider: "fal",
        generationId: "test-generation",
        type: "image",
        providerStatus: "ERROR",
        providerHttpStatus: 422,
        providerErrorType: "content_policy_violation",
        failureKind: "output_safety_blocked",
        failureStage: "output",
        classificationSource: "normalized_message_exact",
        publicErrorCode: "GENERATION_OUTPUT_SAFETY_BLOCKED",
        retryPolicy: "manual_once",
        billingDisposition: "not_charged",
        artifactRecorded: false,
        usageRecorded: false,
        admissionStatus: "failed",
        expected: true,
      };
      const unknownFields = {
        ...fields,
        providerHttpStatus: undefined,
        providerErrorType: "unknown",
        failureKind: "unknown",
        failureStage: "unknown",
        classificationSource: "fallback",
        publicErrorCode: "GENERATION_FAILED",
        retryPolicy: "retry_once",
        expected: false,
      };

      const cleanupLogs = async (): Promise<void> => {
        await flushLogs();
        resetLogs();
        clearMockedEnv();
      };
      await Promise.resolve()
        .then(() => {
          const log = logger("BuiltInGenerationWebhooks");
          log.debug(FAILURE_MESSAGE, fields);
          log.info(FAILURE_MESSAGE, fields);
          log.warn(FAILURE_MESSAGE, unknownFields);
        })
        .then(cleanupLogs, async (error: unknown) => {
          await cleanupLogs();
          throw error;
        });

      expect(sentEvents).toStrictEqual([
        expect.objectContaining({
          level: "info",
          message: FAILURE_MESSAGE,
          source: "api",
          fields: { ...fields, context: "BuiltInGenerationWebhooks" },
        }),
        expect.objectContaining({
          level: "warn",
          message: FAILURE_MESSAGE,
          source: "api",
          fields: {
            provider: "fal",
            generationId: "test-generation",
            type: "image",
            providerStatus: "ERROR",
            providerErrorType: "unknown",
            failureKind: "unknown",
            failureStage: "unknown",
            classificationSource: "fallback",
            publicErrorCode: "GENERATION_FAILED",
            retryPolicy: "retry_once",
            billingDisposition: "not_charged",
            artifactRecorded: false,
            usageRecorded: false,
            admissionStatus: "failed",
            expected: false,
            context: "BuiltInGenerationWebhooks",
          },
        }),
      ]);
    });

    const { logger, __resetForTest: resetLogs } = await import("../log");
    onTestFinished(resetLogs);
    logger("RestoredAxiomMock").info("restored logging mock");
    expect(context.mocks.axiomLogging.info).toHaveBeenCalledWith(
      "restored logging mock",
      expect.objectContaining({ context: "RestoredAxiomMock" }),
    );
    expect(sentEvents).toHaveLength(2);
  });
});
