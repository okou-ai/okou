import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  FAST_PATH_MODEL,
  OpenRouterRequestError,
  generateTextWithUsage,
} from "../openrouter";

const endpoint = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Provider payloads are untrusted: prompt history, credentials and unbounded
 * text can all appear in an OpenRouter error body. `OpenRouterRequestError`
 * carries only allowlisted, bounded fields, and this canary must never survive
 * into one. The error's own fields are the subject here, so the assertions read
 * the thrown value rather than any record written from it.
 */
const privateDetail = "private_prompt_history_authorization_canary";

const safeError = Object.freeze({
  code: "unsupported_value",
  param: "reasoning.effort",
});

const cases = Object.freeze([
  {
    name: "direct code and parameter",
    body: { error: { ...safeError, message: privateDetail } },
    expected: {
      errorCode: "unsupported_value",
      errorParam: "reasoning.effort",
    },
  },
  {
    name: "numeric gateway code",
    body: { error: { code: 400, message: privateDetail } },
    expected: { errorCode: 400, errorParam: undefined },
  },
  {
    name: "bounded provider JSON",
    body: {
      error: {
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: { ...safeError, message: privateDetail },
          }),
          prompt: privateDetail,
          headers: { authorization: privateDetail },
        },
      },
    },
    expected: {
      errorCode: "unsupported_value",
      errorParam: "reasoning.effort",
    },
  },
  {
    name: "google provider status",
    body: {
      error: {
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: privateDetail,
            },
          }),
        },
      },
    },
    expected: { errorCode: "INVALID_ARGUMENT", errorParam: undefined },
  },
  {
    name: "absent diagnostics",
    body: { error: { message: privateDetail } },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "unknown identifier-shaped sensitive fields",
    body: {
      error: {
        code: privateDetail,
        param: "messages",
        message: privateDetail,
        metadata: { error_type: privateDetail, history: privateDetail },
      },
    },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "malformed field types",
    body: {
      error: {
        code: { value: privateDetail },
        param: ["reasoning.effort"],
        metadata: [],
      },
    },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "oversized field values",
    body: { error: { code: "x".repeat(4097), param: "x".repeat(4097) } },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "malformed HTTP error JSON",
    body: `${privateDetail}: invalid JSON`,
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "malformed provider JSON",
    body: { error: { metadata: { raw: `{${privateDetail}` } } },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    // Past the 4 KiB envelope cap, so the wrapper is never parsed at all.
    name: "oversized provider JSON",
    body: {
      error: {
        metadata: {
          raw: JSON.stringify({ error: safeError, padding: "x".repeat(4097) }),
        },
      },
    },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    // Past the 64 KiB response cap, so the truncated body no longer parses.
    name: "oversized HTTP error body",
    body: { error: { ...safeError, message: "x".repeat(65_537) } },
    expected: { errorCode: undefined, errorParam: undefined },
  },
]);

async function rejectedGeneration() {
  return await generateTextWithUsage(FAST_PATH_MODEL, [
    { role: "user", content: "Summarize the launch plan" },
  ]).then(
    () => {
      throw new Error("Expected the rejected OpenRouter request to throw");
    },
    (error: unknown) => {
      return error;
    },
  );
}

describe("OpenRouter request error diagnostics", () => {
  it.each(cases)(
    "keeps only allowlisted, bounded fields for $name",
    async ({ body, expected }) => {
      mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter");
      server.use(
        http.post(endpoint, () => {
          return typeof body === "string"
            ? HttpResponse.text(body, { status: 400 })
            : HttpResponse.json(body, { status: 400 });
        }),
      );

      const error = await rejectedGeneration();

      expect(error).toBeInstanceOf(OpenRouterRequestError);
      if (!(error instanceof OpenRouterRequestError)) {
        throw new Error("Expected an OpenRouterRequestError");
      }
      expect({
        status: error.status,
        errorCode: error.errorCode,
        errorParam: error.errorParam,
        errorType: error.errorType,
      }).toStrictEqual({
        status: 400,
        ...expected,
        errorType: undefined,
      });
      // The message is fixed copy, and no provider-derived field survives.
      expect(
        JSON.stringify([
          error.message,
          error.status,
          error.errorCode,
          error.errorParam,
          error.errorType,
        ]),
      ).not.toContain(privateDetail);
    },
  );
});
