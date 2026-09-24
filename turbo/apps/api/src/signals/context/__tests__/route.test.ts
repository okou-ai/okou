import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { command, computed } from "ccstate";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { apiStartTime$ } from "../hono";

const context = testContext();
const c = initContract();

const routeTestContract = c.router({
  computed: {
    method: "GET",
    path: "/__test/computed",
    responses: {
      200: z.object({ ok: z.literal(true) }),
      400: z.object({ error: z.string() }),
    },
  },
  command: {
    method: "GET",
    path: "/__test/command",
    responses: {
      200: z.object({
        aborted: z.boolean(),
        apiStartTime: z.number().optional(),
        sameSignal: z.boolean(),
      }),
    },
  },
  responseLike: {
    method: "GET",
    path: "/__test/response-like",
    responses: {
      200: z.object({
        ok: z.literal(true),
      }),
    },
  },
  post: {
    method: "POST",
    path: "/__test/post",
    body: z.object({
      enabled: z.boolean(),
    }),
    responses: {
      200: z.object({
        ok: z.literal(true),
      }),
    },
  },
  structured: {
    method: "GET",
    path: "/__test/structured",
    responses: {
      200: z.object({
        content: z.string(),
        userMessage: z.unknown().optional(),
      }),
    },
  },
});

const userMessageFeedbackDocument = {
  version: 1,
  parts: [
    {
      type: "feedback",
      quote: "The button is hard to find",
      note: [{ type: "text", text: "Increase the contrast" }],
    },
  ],
} as const;

describe("honoSignalHandler", () => {
  it("reads computed handlers", async () => {
    const handler$ = computed(() => {
      return { status: 200 as const, body: { ok: true as const } };
    });
    const client = setupApp({
      context,
      routes: [{ route: routeTestContract.computed, handler: handler$ }],
    })(routeTestContract);

    const response = await accept(client.computed(), [200]);

    expect(response.body).toStrictEqual({ ok: true });
  });

  it("sets command handlers with the instance signal", async () => {
    const handler$ = command((_visitor, signal: AbortSignal) => {
      return {
        status: 200 as const,
        body: {
          aborted: signal.aborted,
          sameSignal: signal === context.signal,
        },
      };
    });
    const client = setupApp({
      context,
      routes: [{ route: routeTestContract.command, handler: handler$ }],
    })(routeTestContract);

    const response = await accept(client.command(), [200]);

    expect(response.body).toStrictEqual({ aborted: false, sameSignal: true });
  });

  it("captures the API start time before asynchronous handler work", async () => {
    mockNow(100);
    const handler$ = command(async ({ get }, signal: AbortSignal) => {
      await Promise.resolve();
      signal.throwIfAborted();
      mockNow(200);
      return {
        status: 200 as const,
        body: {
          aborted: signal.aborted,
          apiStartTime: get(apiStartTime$),
          sameSignal: signal === context.signal,
        },
      };
    });
    const client = setupApp({
      context,
      routes: [{ route: routeTestContract.command, handler: handler$ }],
    })(routeTestContract);

    const response = await accept(client.command(), [200]);

    expect(response.body.apiStartTime).toBe(100);
  });

  it("returns response-like objects without contract validation", async () => {
    const handler$ = computed(() => {
      const response = Response.json(
        { ok: true as const },
        { headers: { "x-test-response": "preserved" } },
      );
      return {
        arrayBuffer: response.arrayBuffer.bind(response),
        blob: response.blob.bind(response),
        body: response.body,
        clone: response.clone.bind(response),
        formData: response.formData.bind(response),
        headers: response.headers,
        json: response.json.bind(response),
        status: response.status,
        statusText: response.statusText,
        text: response.text.bind(response),
      };
    });
    const client = setupApp({
      context,
      routes: [{ route: routeTestContract.responseLike, handler: handler$ }],
    })(routeTestContract);

    const response = await accept(client.responseLike(), [200]);

    expect(response.body).toStrictEqual({ ok: true });
    expect(response.headers.get("x-test-response")).toBe("preserved");
  });

  it("registers non-GET handlers", async () => {
    const handler$ = computed(() => {
      return { status: 200 as const, body: { ok: true as const } };
    });
    const client = setupApp({
      context,
      routes: [{ route: routeTestContract.post, handler: handler$ }],
    })(routeTestContract);

    const response = await accept(
      client.post({ body: { enabled: true } }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
  });

  it("returns the complete userMessage document", async () => {
    const handler$ = computed(() => {
      return {
        status: 200 as const,
        body: {
          content: "The button is hard to find\nIncrease the contrast",
          userMessage: userMessageFeedbackDocument,
        },
      };
    });
    const client = setupApp({
      context,
      routes: [{ route: routeTestContract.structured, handler: handler$ }],
    })(routeTestContract);

    const response = await accept(client.structured(), [200]);
    expect(response.body).toStrictEqual({
      content: "The button is hard to find\nIncrease the contrast",
      userMessage: userMessageFeedbackDocument,
    });
  });

  it("keeps small and large JSON responses unchanged with an observer", async () => {
    for (const content of ["界", "界".repeat(50_000)]) {
      const handler$ = computed(() => {
        return { status: 200 as const, body: { content } };
      });
      const baseline = await accept(
        setupApp({
          context,
          routes: [{ route: routeTestContract.structured, handler: handler$ }],
        })(routeTestContract).structured(),
        [200],
      );
      const observed = await accept(
        setupApp({
          context,
          routes: [
            {
              route: routeTestContract.structured,
              handler: handler$,
              observeJsonResponse: () => {
                return undefined;
              },
            },
          ],
        })(routeTestContract).structured(),
        [200],
      );

      expect(observed.body).toStrictEqual(baseline.body);
      expect(observed.headers.get("content-type")).toBe(
        baseline.headers.get("content-type"),
      );
    }
  });

  it("keeps unsuccessful JSON responses on the existing path", async () => {
    const handler$ = computed(() => {
      return { status: 400 as const, body: { error: "Invalid request" } };
    });
    const baseline = await accept(
      setupApp({
        context,
        routes: [{ route: routeTestContract.computed, handler: handler$ }],
      })(routeTestContract).computed(),
      [400],
    );
    const observed = await accept(
      setupApp({
        context,
        routes: [
          {
            route: routeTestContract.computed,
            handler: handler$,
            observeJsonResponse: () => {
              return undefined;
            },
          },
        ],
      })(routeTestContract).computed(),
      [400],
    );
    expect(observed.body).toStrictEqual(baseline.body);
    expect(observed.headers.get("content-type")).toBe(
      baseline.headers.get("content-type"),
    );
  });

  it("keeps the JSON response when its observer fails", async () => {
    const handler$ = computed(() => {
      return { status: 200 as const, body: { ok: true as const } };
    });
    const response = await accept(
      setupApp({
        context,
        routes: [
          {
            route: routeTestContract.computed,
            handler: handler$,
            observeJsonResponse() {
              throw new Error("telemetry unavailable");
            },
          },
        ],
      })(routeTestContract).computed(),
      [200],
    );
    expect(response.body).toStrictEqual({ ok: true });
  });
});
