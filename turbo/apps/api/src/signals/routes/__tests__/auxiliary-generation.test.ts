import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { delay } from "signal-timers";
import { describe, expect, it, onTestFinished, beforeEach } from "vitest";
import { testRuntimeStateContract } from "@okouai/api-contracts/contracts/test-runtime-state";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { testRuntimeStateRoutes } from "../test-runtime-state";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";

const context = testContext();
beforeEach(() => {
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
});
const endpoint = "https://openrouter.ai/api/v1/chat/completions";
// Never part of a request an external caller makes, so anything carrying it
// into a thread came from the provider response.
const secret = "private-provider-payload";
const prompt = "Prepare the launch checklist";

function completion(content = "A usable summary") {
  return HttpResponse.json({
    choices: [{ finish_reason: "stop", message: { content } }],
  });
}

function saveRunSummaryRequest(signal: AbortSignal) {
  // Infrastructure-only exception: a public callback acknowledges before its
  // background work finishes and cannot inject an independently owned task
  // AbortSignal. The existing runtime harness lets cancellation reach the
  // summary boundary. Every other case below uses the production chat API.
  return setupApp({
    context,
    routes: testRuntimeStateRoutes,
    signal,
    rethrowErrors: true,
  })(testRuntimeStateContract).action({
    body: {
      action: "save-run-summary",
      run_id: randomUUID(),
      trigger_source: "web",
      prompt: secret,
      result_text: secret,
    },
  });
}

async function prepareChatTitle() {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, { displayName: "Outcome title" });
  let threadId: string | undefined;
  const events = async () => {
    const listed = await accept(
      chat.requestThreadEvents(actor, {}, [200]),
      [200],
    );
    return listed.body.events.filter((event) => {
      return event.chatThreadId === threadId;
    });
  };
  return {
    create: async () => {
      const sent = await accept(
        chat.requestSendEvent(
          actor,
          { agentId: agent.agentId, prompt, model: "claude-sonnet-5" },
          [201],
        ),
        [201],
      );
      threadId = sent.body.threadId;
    },
    events,
    titles: async () => {
      return (await events()).flatMap((event) => {
        return event.kind === "renamed" ? [event.title] : [];
      });
    },
  };
}

type TitleCompletion =
  | Response
  | { readonly content: string; readonly finishReason: "length" };

function mockTitleCompletion(response: () => TitleCompletion) {
  createChatCallbacksApi(context).mockOpenRouterCompletions((body) => {
    return body.messages[0]?.content.includes(
      "Generate a short, descriptive title",
    )
      ? response()
      : "Thinking";
  });
}

// One shape per externally distinguishable outcome. Reasons the provider
// classification separates further — which gateway code, which transport
// fault — reach the thread identically, so they are not enumerated again.
const untitledCases = Object.freeze([
  {
    name: "an unavailable provider",
    response: () => {
      return new HttpResponse(secret, { status: 503 });
    },
  },
  {
    name: "rejected credentials",
    response: () => {
      return new HttpResponse(secret, { status: 401 });
    },
  },
  {
    name: "a response that breaks its contract",
    response: () => {
      return new HttpResponse(secret);
    },
  },
  {
    name: "a transport failure",
    response: () => {
      return HttpResponse.error();
    },
  },
  {
    name: "an exhausted token budget",
    response: () => {
      return { content: secret, finishReason: "length" as const };
    },
  },
  {
    name: "generated text that interprets to nothing",
    response: () => {
      return completion("---");
    },
  },
]);

describe("auxiliary generation outcomes", () => {
  it("titles the thread from a usable completion", async () => {
    const title = await prepareChatTitle();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    mockTitleCompletion(() => {
      return completion();
    });
    await title.create();
    await flushWaitUntilForTest();
    await expect(title.titles()).resolves.toStrictEqual(["A usable summary"]);
  });

  it.each(untitledCases)(
    "leaves the thread untitled after $name",
    async ({ response }) => {
      const title = await prepareChatTitle();
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
      mockTitleCompletion(response);
      await title.create();
      await flushWaitUntilForTest();
      await expect(title.titles()).resolves.toStrictEqual([]);
      // The thread itself survives a failed optional generation, and nothing
      // the provider sent reaches its metadata.
      const events = await title.events();
      expect(
        events.some((event) => {
          return event.kind === "created";
        }),
      ).toBeTruthy();
      expect(JSON.stringify(events)).not.toContain(secret);
    },
  );

  it("leaves the thread untitled and calls no provider when configuration is missing", async () => {
    const title = await prepareChatTitle();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    let requests = 0;
    server.use(
      http.post(endpoint, () => {
        requests += 1;
        return completion();
      }),
    );
    await title.create();
    await flushWaitUntilForTest();
    await expect(title.titles()).resolves.toStrictEqual([]);
    expect(requests).toBe(0);
  });

  it.each([
    new DOMException("Caller cancelled", "AbortError"),
    new DOMException("Caller deadline", "TimeoutError"),
  ])("propagates caller cancellation to the caller ($name)", async (reason) => {
    const controller = new AbortController();
    onTestFinished(() => {
      return controller.abort();
    });
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    server.use(
      http.post(endpoint, async () => {
        entered.resolve(undefined);
        await release.promise;
        return completion();
      }),
    );
    const request = saveRunSummaryRequest(controller.signal);
    // The caller's own reason reaches it unchanged: the boundary neither
    // swallows the cancellation nor substitutes a failure of its own.
    const outcome = (async () => {
      await expect(request).rejects.toBe(reason);
    })();
    await entered.promise;
    controller.abort(reason);
    release.resolve(undefined);
    await outcome;
    await flushWaitUntilForTest();
  });

  it("finishes a background title that outlives the response within the request lifetime", async () => {
    const title = await prepareChatTitle();
    const titleEntered = createDeferredPromise<void>(context.signal);
    const releaseTitle = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseTitle.settled()) {
        releaseTitle.resolve(undefined);
      }
    });
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
    createChatCallbacksApi(context).mockOpenRouterCompletions(async (body) => {
      if (
        body.messages[0]?.content.includes(
          "Generate a short, descriptive title",
        )
      ) {
        titleEntered.resolve(undefined);
        await releaseTitle.promise;
        return "Late generated title";
      }
      return "Thinking";
    });
    await title.create();
    await titleEntered.promise;
    // The response is already delivered while the generation is still running.
    await expect(title.titles()).resolves.toStrictEqual([]);

    let drained = false;
    const drain = (async () => {
      await flushWaitUntilForTest();
      drained = true;
    })();
    // A lifetime that had stopped tracking the background work would settle
    // here instead of waiting for the generation still in flight.
    await delay(30, { signal: context.signal });
    expect(drained).toBeFalsy();
    releaseTitle.resolve(undefined);
    await drain;
    expect(drained).toBeTruthy();
    await expect(title.titles()).resolves.toStrictEqual([
      "Late generated title",
    ]);
  });
});
