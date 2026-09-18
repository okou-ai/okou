import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  PiApiModelRequestError,
  projectPiApiModelFailure,
} from "./api-failure";
import { projectPiApiAssistantMessage } from "./api-turn";
import providerFailures from "./test/fixtures/provider-failures.json";

describe("Pi API model failure diagnostics", () => {
  it.each(providerFailures)(
    "preserves the sandbox Pi/Codex/Claude reason for $message",
    ({ message, reason }) => {
      const requestError = new PiApiModelRequestError(
        new Error(message),
        "openai-codex",
      );
      const assistant = projectPiApiAssistantMessage({
        ...fauxAssistantMessage(""),
        provider: "openai-codex",
        stopReason: "error",
        errorMessage: message,
      });
      expect(requestError.failureReason).toBe(reason ?? undefined);
      expect(assistant.failureReason).toBe(reason ?? undefined);
      expect(assistant.stopReason).toBe("error");
    },
  );

  it.each([undefined, 200, 503])(
    "preserves queue expiry at the thrown request boundary with status %s",
    (status) => {
      const error = new PiApiModelRequestError(
        new Error(
          "We were unable to start processing your request within the 900-second timeout limit. Please try again later.",
        ),
        "deepseek",
        status,
      );
      expect(error.failureReason).toBe("provider_queue_timeout");
      expect(error.diagnostic.httpStatus).toBe(status);
      expect(error.message).toBe("Pi API model request failed");
    },
  );
  it("classifies a truncated final answer but never successful or aborted answer text", () => {
    const message = fauxAssistantMessage("Partial answer");
    expect(
      projectPiApiAssistantMessage({ ...message, stopReason: "length" })
        .failureReason,
    ).toBe("output_token_limit");
    for (const stopReason of ["stop", "aborted"] as const) {
      for (const errorMessage of [
        "Our servers are currently overloaded. Please try again later.",
        "This content was flagged for possible biological risk. If this seems wrong, try rephrasing your request. We are continuously refining our work in detecting biological risk, and you can read more about our approach in our blog post: https://example.invalid/policy",
        "Codex error: Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://example.invalid/policy",
      ]) {
        expect(
          projectPiApiAssistantMessage({
            ...message,
            stopReason,
            errorMessage,
          }).failureReason,
        ).toBeUndefined();
      }
    }
  });
  it.each([522, 525, 401, 403])(
    "retains observed HTTP %s without provider content",
    (status) => {
      const raw =
        "private-token https://private.example/?secret=sentinel " +
        "x".repeat(100_000);
      const projected = projectPiApiAssistantMessage(
        {
          ...fauxAssistantMessage("partial output"),
          stopReason: "error",
          errorMessage: raw,
        },
        status,
      );
      expect(projected.failureDiagnostic).toStrictEqual({
        category: "http_error",
        httpStatus: status,
      });
      expect(JSON.stringify(projected)).not.toContain("private-token");
      expect(projected).not.toHaveProperty("errorMessage");
      const thrown = new PiApiModelRequestError(
        new Error(raw),
        "openai",
        status,
      );
      expect(thrown.diagnostic).toStrictEqual(projected.failureDiagnostic);
      expect(thrown.message).toBe("Pi API model request failed");
      expect(thrown).not.toHaveProperty("cause");
    },
  );

  it.each([
    {
      error: new TypeError("terminated"),
      expected: { category: "stream_terminated", httpStatus: 200 },
    },
    {
      error: new Error("terminated private prompt"),
      expected: { category: "unknown", httpStatus: 200 },
    },
    {
      error: "OpenAI API error (525): forged status and secret",
      expected: { category: "unknown", httpStatus: 200 },
    },
    {
      error: { status: 525, code: "private", message: "secret" },
      expected: { category: "unknown", httpStatus: 200 },
    },
  ])("projects only allowlisted evidence for $error", ({ error, expected }) => {
    expect(projectPiApiModelFailure(error, 200)).toStrictEqual(expected);
  });

  it.each([undefined, NaN, Infinity, 99, 600, 522.5])(
    "rejects untrustworthy status %s",
    (status) => {
      expect(projectPiApiModelFailure("private 522", status)).toStrictEqual({
        category: "unknown",
      });
    },
  );

  it("keeps known product failures on the thrown request boundary", () => {
    const error = new PiApiModelRequestError(
      new Error(
        '{"error":{"code":"usage_limit_reached","message":"private sentinel"}}',
      ),
      "openai-codex",
      429,
    );
    expect(error.failureReason).toBe("usage_limit");
    expect(error.diagnostic).toStrictEqual({
      category: "http_error",
      httpStatus: 429,
    });
    expect(JSON.stringify(error)).not.toContain("sentinel");
  });
});
