import { randomUUID } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { presentationFormatContract } from "@okouai/api-contracts/contracts/presentation-format";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { presentationFormatRoutes } from "../presentation-format";
import { userPreferencesRoutes } from "../user-preferences";
import { featureSwitchesRoutes } from "../feature-switches";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import type { ApiTestUser } from "./helpers/api-bdd";

const context = testContext();
const fixture = createChatEventsFixture(context);

describe("presentation format preflight and confirmation", () => {
  const owned: { actor: ApiTestUser; threadId: string }[] = [];
  const api = () => {
    return setupApp({ context, routes: presentationFormatRoutes })(
      presentationFormatContract,
    );
  };
  const preferences = () => {
    return setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    );
  };
  const switches = () => {
    return setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    );
  };
  function auth(actor: ApiTestUser) {
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          role: actor.orgRole ?? "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ],
    });
    return fixture.sessionHeaders(actor);
  }

  async function scenario(
    options: {
      readonly enabled?: boolean;
      readonly document?: UserMessageInputDocument;
      readonly documentFor?: (
        actor: ApiTestUser,
      ) => Promise<UserMessageInputDocument>;
      readonly finish?: boolean;
    } = {},
  ) {
    const { actor } = await fixture.entitledNativeChatActor({
      userId: "user_3EWY21Oe3f15kfs3yYmbGgDb3NV",
      orgId: `org_presentation_${randomUUID()}`,
      orgRole: "org:admin",
    });
    await accept(
      preferences().initialize({
        headers: auth(actor),
        body: { locale: "en-US", timezone: "UTC" },
      }),
      [200],
    );
    if (options.enabled === false) {
      await accept(
        switches().update({
          headers: auth(actor),
          body: {
            switches: { [FeatureSwitchKey.PresentationOutputFormat]: false },
          },
        }),
        [200],
      );
    }
    const document = options.documentFor
      ? await options.documentFor(actor)
      : options.document;
    const clientEventId = randomUUID();
    const run = await fixture.sendChatRun(actor, {
      clientEventId,
      prompt: "Create a ten-slide presentation in Chinese about our launch",
      model: "claude-fable-5-1",
      ...(document ? { userMessage: document } : {}),
    });
    owned.push({ actor, threadId: run.threadId });
    const { execution, sandboxHeaders } = await fixture.runExecution(run.runId);
    const token = execution.platformEnvironment.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected a real Agent credential");
    }
    if (options.finish !== false) {
      await fixture.failChatRun(
        run.runId,
        sandboxHeaders,
        "Waiting for presentation format selection",
      );
      await flushWaitUntilForTest();
    }
    auth(actor);
    return {
      ...run,
      actor,
      clientEventId,
      execution,
      token: { authorization: `Bearer ${token}` },
    };
  }

  afterEach(async () => {
    clearMockNow();
    await flushWaitUntilForTest();
    for (const { actor, threadId } of owned.splice(0)) {
      const { events } = await fixture.chat.listThreadEvents(actor, threadId);
      const runIds = new Set(
        events.flatMap((event) => {
          return event.runId ? [event.runId] : [];
        }),
      );
      for (const runId of runIds) {
        const current = await fixture.api.readRun(actor, runId);
        if (current.status === "pending" || current.status === "running") {
          await fixture.cancelAndCompleteChatRun(actor, runId);
        }
      }
    }
    await flushWaitUntilForTest();
  });

  it("requires a real Agent read capability and human confirmation, and hides another member's source", async () => {
    const s = await scenario();
    await accept(api().resolve({ headers: auth(s.actor), body: {} }), [403]);
    await accept(
      api().confirm({
        headers: s.token,
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [401, 403],
    );
    const stranger = { ...s.actor, userId: `user_other_${randomUUID()}` };
    await accept(
      api().confirm({
        headers: auth(stranger),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [404],
    );
    await accept(
      api().confirm({
        headers: auth({ ...s.actor, orgId: `org_other_${randomUUID()}` }),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [404],
    );
    auth(s.actor);
    const resolved = await accept(
      api().resolve({ headers: s.token, body: {} }),
      [200],
    );
    expect(resolved.body.status).toBe("selection_required");
    await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [200],
    );
    await accept(
      api().confirm({
        headers: auth(stranger),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [404],
    );
    await accept(
      api().confirm({
        headers: auth({ ...s.actor, orgId: `org_other_${randomUUID()}` }),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [404],
    );
  });

  it("does not issue the narrow read capability when the existing feature is disabled", async () => {
    const s = await scenario({ enabled: false });
    await accept(api().resolve({ headers: s.token, body: {} }), [401, 403]);
    const denied = await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [403],
    );
    expect(denied.body.error.code).toBe("FORBIDDEN");
  });

  it("returns one stable inline descriptor without saving an explicit first-time request", async () => {
    const s = await scenario();
    const initial = await accept(
      api().resolve({ headers: s.token, body: {} }),
      [200],
    );
    const requested = await accept(
      api().resolve({ headers: s.token, body: { requestedFormat: "pptx" } }),
      [200],
    );
    if (
      initial.body.status !== "selection_required" ||
      requested.body.status !== "selection_required"
    ) {
      throw new Error("Expected an uninitialized format selection");
    }
    expect(initial.body).toMatchObject({
      sourceRunId: s.runId,
      threadId: s.threadId,
      requestedFormat: null,
    });
    expect(requested.body).toMatchObject({
      continuationEventId: initial.body.continuationEventId,
      requestedFormat: "pptx",
      card: {
        type: "presentation_format_selection",
        formats: ["html", "pptx"],
        action: { method: "POST", path: "/api/presentation-format/confirm" },
      },
    });
    const saved = await accept(
      preferences().get({ headers: auth(s.actor) }),
      [200],
    );
    expect(saved.body.presentationFormat).toBeNull();
  });

  it("uses a saved default with a single-task override without changing Settings", async () => {
    const s = await scenario();
    await accept(
      preferences().update({
        headers: auth(s.actor),
        body: { presentationFormat: "html" },
      }),
      [200],
    );
    auth(s.actor);
    const saved = await accept(
      api().resolve({ headers: s.token, body: {} }),
      [200],
    );
    expect(saved.body).toStrictEqual({
      status: "ready",
      presentationFormat: "html",
    });
    const override = await accept(
      api().resolve({ headers: s.token, body: { requestedFormat: "pptx" } }),
      [200],
    );
    expect(override.body).toStrictEqual({
      status: "ready",
      presentationFormat: "pptx",
    });
    const retained = await accept(
      preferences().get({ headers: auth(s.actor) }),
      [200],
    );
    expect(retained.body.presentationFormat).toBe("html");
  });

  it("publishes the original structured input with the recorded native format, and recovers retries after Settings changes", async () => {
    const original: UserMessageInputDocument = {
      version: 1,
      parts: [
        {
          type: "additional_info",
          text: "Create a presentation.\n\n# Presentation Generation Defaults\n- Output format: HTML format\n- Slide count: 10",
        },
        { type: "text", text: "Create ten Chinese slides about the launch. " },
        {
          type: "template",
          titleSnapshot: "Schoolhouse",
          template: {
            type: "presentation",
            selection: {
              templateId: "template:html-ppt-schoolhouse",
              outputFormat: "html",
            },
          },
        },
        {
          type: "feedback",
          quote: "The launch should emphasize customers",
          note: [{ type: "text", text: "Keep this emphasis" }],
        },
      ],
    };
    const s = await scenario({
      documentFor: async (actor) => {
        const uploaded = await fixture.chat.prepareUpload(actor, {
          filename: "launch.png",
          contentType: "image/png",
          size: 42,
        });
        const annotated = await fixture.chat.prepareUpload(actor, {
          filename: "launch-marked.png",
          contentType: "image/png",
          size: 42,
        });
        fixture.chat.mockCompletedUploadObjects(actor, [
          { id: uploaded.id, filename: "launch.png", size: 42 },
          { id: annotated.id, filename: "launch-marked.png", size: 42 },
        ]);
        const originalSend = context.mocks.s3.send.getMockImplementation();
        context.mocks.s3.send.mockImplementation((request: unknown) => {
          if (
            request instanceof HeadObjectCommand &&
            [uploaded.id, annotated.id].some((id) => {
              return request.input.Key?.includes(id);
            })
          ) {
            return Promise.resolve({
              ContentLength: 42,
              ContentType: "image/png",
            });
          }
          return originalSend ? originalSend(request) : Promise.resolve({});
        });
        await fixture.chat.completeUpload(actor, {
          id: uploaded.id,
          contentType: "image/png",
        });
        await fixture.chat.completeUpload(actor, {
          id: annotated.id,
          contentType: "image/png",
        });
        const referencedThread = await fixture.chat.createThread(actor, {});
        original.parts.push(
          {
            type: "file",
            fileId: uploaded.id,
            annotatedFileId: annotated.id,
            filenameSnapshot: "launch.png",
            contentType: "image/png",
            annotations: {
              marks: [
                {
                  id: "launch-caption",
                  shape: "text",
                  at: { x: 0.2, y: 0.3 },
                  text: "Launch customers",
                  ink: "#224466",
                },
              ],
            },
          },
          {
            type: "chat_thread",
            threadId: referencedThread.id,
            titleSnapshot: "Launch research",
          },
        );
        return original;
      },
    });
    const first = await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [200],
    );
    expect(first.body).toMatchObject({
      status: "accepted",
      sourceRunId: s.runId,
      threadId: s.threadId,
      presentationFormat: "pptx",
      acceptedAt: expect.any(String),
    });
    await flushWaitUntilForTest();
    const saved = await accept(
      preferences().get({ headers: auth(s.actor) }),
      [200],
    );
    expect(saved.body).toMatchObject({
      presentationFormat: "pptx",
      timezone: "UTC",
      locale: "en-US",
    });
    const { events } = await fixture.chat.listThreadEvents(s.actor, s.threadId);
    const accepted = events.find((event) => {
      return event.id === first.body.continuationEventId;
    });
    if (!accepted || accepted.eventType !== "input.prompt") {
      throw new Error("Expected the accepted input");
    }
    expect(accepted.userMessage.parts).toStrictEqual(
      expect.arrayContaining([
        original.parts[1],
        original.parts[3],
        original.parts[4],
        original.parts[5],
        {
          type: "template",
          titleSnapshot: "Schoolhouse",
          template: {
            type: "presentation",
            selection: {
              templateId: "template:html-ppt-schoolhouse",
              outputFormat: "pptx",
            },
          },
        },
        {
          type: "presentation_format_selection",
          sourceRunId: s.runId,
          sourceInputEventIds: [s.clientEventId],
          presentationFormat: "pptx",
        },
      ]),
    );
    const replacement = events.find((event) => {
      return (
        event.revokesEventId === first.body.continuationEventId && event.runId
      );
    });
    if (!replacement?.runId) {
      throw new Error(
        "Expected continuation admission through the normal queue",
      );
    }
    const continued = await fixture.runExecution(replacement.runId);
    const nextToken = continued.execution.platformEnvironment.OKOU_TOKEN;
    if (!nextToken) {
      throw new Error("Expected the continuation credential");
    }
    await accept(
      preferences().update({
        headers: auth(s.actor),
        body: { presentationFormat: "html" },
      }),
      [200],
    );
    const retried = await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [200],
    );
    expect(retried.body).toStrictEqual(first.body);
    const conflict = await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "html" },
      }),
      [409],
    );
    expect(conflict.body.presentationFormat).toBe("pptx");
    auth(s.actor);
    const recorded = await accept(
      api().resolve({
        headers: { authorization: `Bearer ${nextToken}` },
        body: {},
      }),
      [200],
    );
    expect(recorded.body).toStrictEqual({
      status: "ready",
      presentationFormat: "pptx",
    });
    const override = await accept(
      api().resolve({
        headers: { authorization: `Bearer ${nextToken}` },
        body: { requestedFormat: "html" },
      }),
      [200],
    );
    expect(override.body).toStrictEqual({
      status: "ready",
      presentationFormat: "html",
    });
    const final = await accept(
      preferences().get({ headers: auth(s.actor) }),
      [200],
    );
    expect(final.body.presentationFormat).toBe("html");
  });

  it("returns the real winner for concurrent different choices and one receipt for same-choice retries", async () => {
    const s = await scenario();
    const headers = auth(s.actor);
    const choices = await Promise.all([
      api().confirm({
        headers,
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      api().confirm({
        headers,
        body: { sourceRunId: s.runId, presentationFormat: "html" },
      }),
    ]);
    expect(
      choices
        .map((choice) => {
          return choice.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const winner = choices.find((choice) => {
      return choice.status === 200;
    });
    const loser = choices.find((choice) => {
      return choice.status === 409;
    });
    if (!winner || winner.status !== 200 || !loser || loser.status !== 409) {
      throw new Error("Expected one accepted selection");
    }
    expect(loser.body.presentationFormat).toBe(winner.body.presentationFormat);
    const repeated = await Promise.all(
      [1, 2].map(() => {
        return api().confirm({
          headers,
          body: {
            sourceRunId: s.runId,
            presentationFormat: winner.body.presentationFormat,
          },
        });
      }),
    );
    for (const response of repeated) {
      const accepted = await accept(Promise.resolve(response), [200]);
      expect(accepted.body).toStrictEqual(winner.body);
    }
    const saved = await accept(
      preferences().get({ headers: auth(s.actor) }),
      [200],
    );
    expect(saved.body.presentationFormat).toBe(winner.body.presentationFormat);
  });

  it("atomically initializes one default across competing source threads without accepting the losing input", async () => {
    const s = await scenario();
    const other = await fixture.sendChatRun(s.actor, {
      clientEventId: randomUUID(),
      prompt: "Create a separate presentation about next quarter",
      model: "claude-fable-5-1",
    });
    owned.push({ actor: s.actor, threadId: other.threadId });
    const execution = await fixture.runExecution(other.runId);
    await fixture.failChatRun(
      other.runId,
      execution.sandboxHeaders,
      "Waiting for a format",
    );
    await flushWaitUntilForTest();
    const headers = auth(s.actor);
    const choices = await Promise.all([
      api().confirm({
        headers,
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      api().confirm({
        headers,
        body: { sourceRunId: other.runId, presentationFormat: "html" },
      }),
    ]);
    expect(
      choices
        .map((choice) => {
          return choice.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const winner = choices.find((choice) => {
      return choice.status === 200;
    });
    if (!winner || winner.status !== 200) {
      throw new Error("Expected one default initializer");
    }
    const saved = await accept(
      preferences().get({ headers: auth(s.actor) }),
      [200],
    );
    expect(saved.body.presentationFormat).toBe(winner.body.presentationFormat);
    await flushWaitUntilForTest();
    const threads = await Promise.all(
      [s.threadId, other.threadId].map((threadId) => {
        return fixture.chat.listThreadEvents(s.actor, threadId);
      }),
    );
    const receipts = threads.flatMap(({ events }) => {
      return events.filter((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.runId === undefined &&
          event.userMessage.parts.some((part) => {
            return part.type === "presentation_format_selection";
          })
        );
      });
    });
    expect(
      receipts.map((event) => {
        return event.id;
      }),
    ).toStrictEqual([winner.body.continuationEventId]);
  });

  it("accepts simultaneous first-time clicks for the same choice with one durable input", async () => {
    const s = await scenario();
    const headers = auth(s.actor);
    const clicks = await Promise.all(
      [1, 2].map(() => {
        return api().confirm({
          headers,
          body: { sourceRunId: s.runId, presentationFormat: "pptx" },
        });
      }),
    );
    const first = await accept(Promise.resolve(clicks[0]!), [200]);
    const second = await accept(Promise.resolve(clicks[1]!), [200]);
    expect(second.body).toStrictEqual(first.body);
    await flushWaitUntilForTest();
    const { events } = await fixture.chat.listThreadEvents(s.actor, s.threadId);
    expect(
      events.filter((event) => {
        return event.id === first.body.continuationEventId;
      }),
    ).toHaveLength(1);
  });

  it("does not overwrite a newer Settings default or accept a still-active source", async () => {
    const s = await scenario({ finish: false });
    const busy = await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [409],
    );
    expect(busy.body.presentationFormat).toBeNull();
    const { sandboxHeaders } = await fixture.runExecution(s.runId);
    await fixture.failChatRun(
      s.runId,
      sandboxHeaders,
      "Waiting for presentation selection",
    );
    await flushWaitUntilForTest();
    await accept(
      preferences().update({
        headers: auth(s.actor),
        body: { presentationFormat: "html" },
      }),
      [200],
    );
    const stale = await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [409],
    );
    expect(stale.body.presentationFormat).toBe("html");
    const saved = await accept(
      preferences().get({ headers: auth(s.actor) }),
      [200],
    );
    expect(saved.body.presentationFormat).toBe("html");
  });

  it("recovers accepted receipts while new selections are disabled and refuses expired unaccepted sources", async () => {
    const s = await scenario();
    const first = await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "html" },
      }),
      [200],
    );
    await accept(
      switches().update({
        headers: auth(s.actor),
        body: {
          switches: { [FeatureSwitchKey.PresentationOutputFormat]: false },
        },
      }),
      [200],
    );
    const recovered = await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "html" },
      }),
      [200],
    );
    expect(recovered.body).toStrictEqual(first.body);
    const expired = await scenario();
    mockNow(now() + 31 * 86_400_000);
    await accept(
      api().confirm({
        headers: auth(expired.actor),
        body: { sourceRunId: expired.runId, presentationFormat: "html" },
      }),
      [410],
    );
  });

  it("does not replace an occupied stable identity with a random continuation", async () => {
    const s = await scenario();
    const preflight = await accept(
      api().resolve({ headers: s.token, body: {} }),
      [200],
    );
    if (preflight.body.status !== "selection_required") {
      throw new Error("Expected a selection identity");
    }
    await fixture.chat.requestSendEvent(
      s.actor,
      {
        threadId: s.threadId,
        clientEventId: preflight.body.continuationEventId,
        prompt: "A different ordinary task",
      },
      [201],
    );
    const conflicted = await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "pptx" },
      }),
      [409],
    );
    expect(conflicted.body.presentationFormat).toBeNull();
    const saved = await accept(
      preferences().get({ headers: auth(s.actor) }),
      [200],
    );
    expect(saved.body.presentationFormat).toBeNull();
  });

  it("rejects ambiguous template context without saving a default or publishing a continuation", async () => {
    const s = await scenario({
      document: {
        version: 1,
        parts: [
          {
            type: "text",
            text: "Compare two presentation templates before choosing",
          },
          {
            type: "template",
            titleSnapshot: "Schoolhouse",
            template: {
              type: "presentation",
              selection: { templateId: "template:html-ppt-schoolhouse" },
            },
          },
          {
            type: "template",
            titleSnapshot: "Consulting",
            template: {
              type: "presentation",
              selection: { templateId: "template:html-ppt-taped-consulting" },
            },
          },
        ],
      },
    });
    const preflight = await accept(
      api().resolve({ headers: s.token, body: {} }),
      [200],
    );
    if (preflight.body.status !== "selection_required") {
      throw new Error("Expected a selection identity");
    }
    const continuationEventId = preflight.body.continuationEventId;
    await accept(
      api().confirm({
        headers: auth(s.actor),
        body: { sourceRunId: s.runId, presentationFormat: "html" },
      }),
      [409],
    );
    const saved = await accept(
      preferences().get({ headers: auth(s.actor) }),
      [200],
    );
    expect(saved.body.presentationFormat).toBeNull();
    const { events } = await fixture.chat.listThreadEvents(s.actor, s.threadId);
    expect(
      events.some((event) => {
        return event.id === continuationEventId;
      }),
    ).toBeFalsy();
  });

  it("rejects a forged selection part through ordinary chat send", async () => {
    const s = await scenario();
    const result = await fixture.chat.requestSendEvent(
      s.actor,
      {
        threadId: s.threadId,
        prompt: "Continue",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Continue" },
            {
              type: "presentation_format_selection",
              sourceRunId: s.runId,
              sourceInputEventIds: [s.clientEventId],
              presentationFormat: "pptx",
            },
          ],
        },
      },
      [400],
    );
    expect(result.status).toBe(400);
  });
});
